import { createRpc, fromQuantity, walkLogs, type Endpoint, type Rpc, type RpcOptions } from "@globalmpc/evm-log-walker";
import { MAX_DECIMALS } from "./amount.js";
import { BalanceReplay, sortHolders, sumBalances, type Holder } from "./balances.js";
import { forEachConcurrently } from "./concurrency.js";
import { SnapshotError } from "./errors.js";
import { addressWord, blockQuantity, hexToBigInt, type Address } from "./hex.js";
import { decodeTransfer, isErc20Transfer, TRANSFER_TOPIC, type Transfer } from "./transfers.js";

/** `eth_call`s and `eth_getCode`s in flight at once. Enough to be quick, few enough for a public endpoint. */
const CONCURRENCY = 8;


const SELECTOR = {
  balanceOf: "0x70a08231",
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
} as const;

export interface FetchTransfersOptions {
  token: Address;
  /** First block to read. For a complete snapshot, the token's creation block. */
  fromBlock: number;
  /** Last block to read, inclusive. */
  toBlock: number;
  /** Called after each batch of blocks, for progress output. */
  onProgress?: (progress: { toBlock: number; transfers: number }) => void;
}

/**
 * Yields the token's ERC-20 `Transfer`s one walker batch at a time, in chain order, through
 * `evm-log-walker`'s adaptive `eth_getLogs` walk. Reorged logs (`removed: true`) are dropped, and
 * so are four-topic ERC-721 `Transfer`s, which share the event signature.
 */
export async function* streamTransfers(rpc: Rpc, options: FetchTransfersOptions): AsyncGenerator<Transfer[], void, undefined> {
  let read = 0;
  const walk = walkLogs({
    rpc,
    address: options.token,
    topics: [TRANSFER_TOPIC],
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
  });
  for await (const batch of walk) {
    const transfers = batch.logs.filter((log) => !log.removed && isErc20Transfer(log)).map(decodeTransfer);
    read += transfers.length;
    yield transfers;
    options.onProgress?.({ toBlock: batch.toBlock, transfers: read });
  }
}

/**
 * Every transfer in the range, collected into one array. Convenient for a short range; for a whole
 * token history use `replayFromChain`, which holds only balances.
 */
export async function fetchTransfers(rpc: Rpc, options: FetchTransfersOptions): Promise<Transfer[]> {
  const transfers: Transfer[] = [];
  // One push per transfer: spreading a large batch into `push` can exceed the engine's argument limit.
  for await (const batch of streamTransfers(rpc, options)) for (const transfer of batch) transfers.push(transfer);
  return transfers;
}

/**
 * Replays the token's history into balances at `toBlock` as it is read: each batch is applied and
 * dropped, so memory grows with the number of holders, not the number of transfers.
 */
export async function replayFromChain(rpc: Rpc, options: FetchTransfersOptions): Promise<{ holders: Holder[]; transfers: number }> {
  const replay = new BalanceReplay({ atBlock: options.toBlock });
  for await (const batch of streamTransfers(rpc, options)) replay.apply(batch);
  return { holders: replay.holders(), transfers: replay.applied };
}

/** Calls a view function that returns one `uint256` and decodes it. */
async function callUint(rpc: Rpc, token: Address, data: string, block: number, what: string): Promise<bigint> {
  const result = await rpc.call<unknown>("eth_call", [{ to: token, data }, blockQuantity(block)]);
  if (typeof result !== "string" || result.length < 66) {
    throw new SnapshotError(
      "E_MALFORMED_RESPONSE",
      `${what} on ${token} at block ${block} returned ${JSON.stringify(result)}: the address is not an ERC-20 token at that block`,
    );
  }
  return hexToBigInt(`0x${result.slice(2, 66)}`, what);
}

export function readTotalSupply(rpc: Rpc, token: Address, block: number): Promise<bigint> {
  return callUint(rpc, token, SELECTOR.totalSupply, block, "totalSupply()");
}

export function readBalance(rpc: Rpc, token: Address, holder: Address, block: number): Promise<bigint> {
  return callUint(rpc, token, `${SELECTOR.balanceOf}${addressWord(holder)}`, block, `balanceOf(${holder})`);
}

/**
 * The token's `decimals()`. Optional in ERC-20, so a token without it throws `E_MALFORMED_RESPONSE`,
 * and so does one answering more than 36: amounts could not be formatted, and a snapshot written
 * with it would be refused when read back.
 */
export async function readDecimals(rpc: Rpc, token: Address, block: number): Promise<number> {
  const value = await callUint(rpc, token, SELECTOR.decimals, block, "decimals()");
  if (value > BigInt(MAX_DECIMALS)) {
    throw new SnapshotError(
      "E_MALFORMED_RESPONSE",
      `decimals() on ${token} returned ${value}, above the ${MAX_DECIMALS} this package supports; pass the decimals explicitly if the token's are wrong`,
    );
  }
  return Number(value);
}

export interface BalanceMismatch {
  address: Address;
  /** What the replay of `Transfer` events produced. */
  replayed: bigint;
  /** What the token's own `balanceOf` returned at the snapshot block. */
  onChain: bigint;
}

export interface Verification {
  /** True only when the supply matches and every sampled balance matches. */
  verified: boolean;
  /** `totalSupply()` at the snapshot block. */
  totalSupply: bigint;
  /** The sum of the replayed balances. */
  replayedSupply: bigint;
  /** Holders whose balance was checked against `balanceOf`. */
  checked: number;
  mismatches: BalanceMismatch[];
}

export interface VerifyOptions {
  token: Address;
  block: number;
  /** The replayed holders, largest first (as `replayBalances` returns them). */
  holders: readonly Holder[];
  /**
   * `"all"` (the default) checks every holder's `balanceOf`, which is what a payout needs. A number
   * checks that many of the largest holders and as many again spread across the rest — a quicker
   * look, at least 1, but `buildDistribution` will not pay from it: a balance moved between two
   * unsampled wallets without an event leaves `totalSupply` unchanged.
   */
  sample?: number | "all";
}

/**
 * Checks a replay against the token itself, at the snapshot block: `totalSupply()` must equal the
 * sum of the replayed balances, and `balanceOf` must agree for every holder, or for a sample. A
 * sample is the largest holders, who receive most of a pro-rata pool, plus holders from the middle
 * of even intervals through the rest, so small balances are represented even at a sample of one.
 * The choice is deterministic: the same snapshot checks the same holders on every run.
 *
 * A token whose balances do not follow from its `Transfer` events — rebasing, fee-on-transfer
 * without a matching event, or a non-standard mint — fails here, which is the point: its holder
 * list cannot be rebuilt from logs, and paying from one would be wrong.
 *
 * Reading a balance at a past block needs an endpoint that keeps historical state (an archive
 * node). Without one, the endpoint's error reaches the caller unchanged.
 */
export async function verifyBalances(rpc: Rpc, options: VerifyOptions): Promise<Verification> {
  const sample = options.sample ?? "all";
  if (sample !== "all" && (!Number.isSafeInteger(sample) || sample < 1)) {
    throw new SnapshotError(
      "E_INVALID_ARGUMENT",
      `sample must be a positive integer or "all", got ${String(sample)}: totalSupply alone cannot see balances moved without an event`,
    );
  }
  const holders = sortHolders([...options.holders]);
  const chosen = sample === "all" ? holders : sampleHolders(holders, sample);
  const totalSupply = await readTotalSupply(rpc, options.token, options.block);
  const replayedSupply = sumBalances(holders);

  const mismatches: BalanceMismatch[] = [];
  await forEachConcurrently(chosen, CONCURRENCY, async (holder) => {
    const onChain = await readBalance(rpc, options.token, holder.address, options.block);
    if (onChain !== holder.balance) mismatches.push({ address: holder.address, replayed: holder.balance, onChain });
  });
  mismatches.sort((a, b) => (a.address < b.address ? -1 : 1));
  return {
    verified: totalSupply === replayedSupply && mismatches.length === 0,
    totalSupply,
    replayedSupply,
    checked: chosen.length,
    mismatches,
  };
}

/** The first `n` holders, then the middle one of each of `n` even intervals through the remainder. */
export function sampleHolders<T>(holders: readonly T[], n: number): T[] {
  if (holders.length <= n * 2) return [...holders];
  const chosen = holders.slice(0, n);
  const rest = holders.slice(n);
  for (let i = 0; i < n; i += 1) {
    // The middle of each interval, not its start: at n = 1 the start would be the next-largest
    // holder, leaving every small balance unrepresented.
    chosen.push(rest[Math.floor(((i + 0.5) * rest.length) / n)] as T);
  }
  return chosen;
}

/**
 * The addresses among `addresses` that held contract code at `block`, by `eth_getCode`. One call
 * per address. Returned in the order given.
 */
export async function findContracts(rpc: Rpc, addresses: readonly Address[], block: number): Promise<Address[]> {
  const isContract = new Map<Address, boolean>();
  await forEachConcurrently(addresses, CONCURRENCY, async (address) => {
    const code = await rpc.call<unknown>("eth_getCode", [address, blockQuantity(block)]);
    if (typeof code !== "string" || !code.startsWith("0x")) {
      throw new SnapshotError("E_MALFORMED_RESPONSE", `eth_getCode for ${address} returned ${JSON.stringify(code)}`);
    }
    isContract.set(address, code !== "0x");
  });
  return addresses.filter((address) => isContract.get(address) === true);
}

/** `Rpc`s built by `connectSameChain`, whose endpoints are known to serve one chain. */
const sameChain = new WeakSet<Rpc>();

/**
 * Builds an `Rpc` like `createRpc`, after asking every endpoint, one at a time, which chain it
 * serves; throws `E_INVALID_ARGUMENT` unless they all agree. Returns the client and the shared
 * chain id.
 *
 * An `Rpc` built from several endpoints fails over between them call by call and does not say which
 * one answered, so a fallback on another chain could mix its logs and balances into a snapshot
 * labelled with the first one's chain id — and could hand back to the first before any later check.
 * `takeSnapshot` and `recheckSnapshot` therefore accept a client with more than one endpoint only
 * when it was built here. Every endpoint must answer: one that is down now could come back mid-run
 * and serve reads that were never checked.
 */
export async function connectSameChain(options: RpcOptions): Promise<{ rpc: Rpc; chainId: number }> {
  const endpoints = (Array.isArray(options.urls) ? options.urls : [options.urls]) as readonly (string | Endpoint)[];
  if (endpoints.length === 0) throw new SnapshotError("E_INVALID_ARGUMENT", "at least one endpoint is required");
  const ids: number[] = [];
  for (const endpoint of endpoints) {
    const single = createRpc({ ...options, urls: [endpoint] });
    ids.push(fromQuantity(await single.call<unknown>("eth_chainId", [])));
  }
  if (new Set(ids).size > 1) {
    throw new SnapshotError(
      "E_INVALID_ARGUMENT",
      `the endpoints are on different chains (${ids.map((id, index) => `endpoint-${index + 1}: ${id}`).join(", ")}); ` +
        "every endpoint given for one snapshot must serve the same chain",
    );
  }
  const rpc = createRpc(options);
  sameChain.add(rpc);
  return { rpc, chainId: ids[0] as number };
}

/**
 * Throws `E_INVALID_ARGUMENT` for a client with fallback endpoints that `connectSameChain` did not
 * check. A single endpoint is one chain by construction.
 */
export function assertSingleChain(rpc: Rpc): void {
  if (rpc.urls.length > 1 && !sameChain.has(rpc)) {
    throw new SnapshotError(
      "E_INVALID_ARGUMENT",
      "an Rpc with fallback endpoints must be built with connectSameChain, which checks that every endpoint serves the same chain",
    );
  }
}
