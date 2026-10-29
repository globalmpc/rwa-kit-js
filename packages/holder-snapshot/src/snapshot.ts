import { findCreationBlock, fromQuantity, resolveBlock, type BlockTag, type Rpc } from "@globalmpc/evm-log-walker";
import { assertDecimals } from "./amount.js";
import { sumBalances, type Holder } from "./balances.js";
import { assertSingleChain, findContracts, readDecimals, replayFromChain, verifyBalances, type Verification } from "./chain.js";
import { SnapshotError } from "./errors.js";
import { blockQuantity, checkedAddress, isAddress, normalizeAddress, type Address } from "./hex.js";

export const PACKAGE_NAME = "@globalmpc/holder-snapshot";

/** Version of the saved snapshot file's shape. Raised when a field changes meaning. */
export const SNAPSHOT_FORMAT = 1;

export interface SnapshotHolder extends Holder {
  /** Whether the address held contract code at the snapshot block. Absent when not classified. */
  contract?: boolean;
}

/** Where a snapshot came from, so anyone can re-run it and expect the same list. */
export interface SnapshotSource {
  /** The configured endpoints, by position (`endpoint-1`): a URL, or even its host, can carry a key. */
  endpoints: string[];
  /** First block of `Transfer` history replayed. */
  fromBlock: number;
  /**
   * How `fromBlock` was established:
   * - `"creation"`: found by `findCreationBlock` and confirmed by the deployment receipt.
   * - `"creation-unconfirmed"`: found by `findCreationBlock` but not confirmed. A deployment by
   *   another contract leaves no receipt to confirm, and an endpoint that has pruned old state can
   *   answer "no code" for blocks after the real deployment, making the search land too late. The
   *   snapshot is not verified; take it again with a `fromBlock` established independently.
   * - `"given"`: supplied by the caller, who vouches for it.
   */
  fromBlockOrigin: FromBlockOrigin;
}

export type FromBlockOrigin = "creation" | "creation-unconfirmed" | "given";

export interface Snapshot {
  package: typeof PACKAGE_NAME;
  format: typeof SNAPSHOT_FORMAT;
  chainId: number;
  token: Address;
  /** The token's `decimals()`, or the value the caller supplied for a token without one. */
  decimals: number;
  /** The snapshot block: balances are as of the end of it. */
  block: number;
  /** The block's timestamp, in seconds since epoch. */
  blockTimestamp: number;
  /** Every address with a positive balance, largest first. */
  holders: SnapshotHolder[];
  /** True when every holder carries `contract`. */
  classified: boolean;
  transfers: number;
  verification: Verification;
  source: SnapshotSource;
}

export interface SnapshotOptions {
  token: Address;
  /** The snapshot block, or a tag. Default `"finalized"`, which cannot be reorganised away. */
  block?: number | BlockTag;
  /** First block to replay. Default: the token's creation block, found by `findCreationBlock`. */
  fromBlock?: number;
  /** For a token without `decimals()`. Read from the token when absent. */
  decimals?: number;
  /**
   * Holders checked against `balanceOf`; see `verifyBalances`. Default `"all"`, which a payout
   * needs. A number gives a quicker, sampled look that `buildDistribution` will not pay from.
   */
  sample?: number | "all";
  /** Also mark each holder as contract or wallet, with one `eth_getCode` each. Default false. */
  classify?: boolean;
  /** How an endpoint is named in `source`. Default its position, `endpoint-1`. */
  endpointLabel?: (url: string, index: number) => string;
  onProgress?: (progress: { toBlock: number; transfers: number }) => void;
}

/**
 * Who held `token` at the end of a block, and how much each.
 *
 * Replays every `Transfer` from the token's creation, then checks the result against the token's
 * own `totalSupply()` and every holder's `balanceOf` at that block. The check's outcome is in
 * `verification`; a snapshot that fails it is still returned, so the mismatches can be inspected,
 * but `buildDistribution` refuses to pay from it. A creation block that could not be confirmed
 * fails verification too: holders whose transfers fell before a late start may be missing.
 *
 * History is replayed as it is read, so memory grows with the number of holders, not transfers.
 *
 * Every endpoint behind `rpc` must serve the same chain, because the client fails over between
 * them call by call: a client with more than one endpoint must come from `connectSameChain`.
 */
export async function takeSnapshot(rpc: Rpc, options: SnapshotOptions): Promise<Snapshot> {
  assertSingleChain(rpc);
  const token = checkedAddress(options.token, "token");
  if (options.decimals !== undefined) assertDecimals(options.decimals);
  const block = await resolveBlock(rpc, options.block ?? "finalized");
  const chainId = fromQuantity(await rpc.call<unknown>("eth_chainId", []));
  const header = await rpc.call<{ timestamp?: unknown } | null>("eth_getBlockByNumber", [blockQuantity(block), false]);
  if (header === null || typeof header !== "object") {
    throw new SnapshotError("E_MALFORMED_RESPONSE", `eth_getBlockByNumber returned no block ${block}`);
  }
  const blockTimestamp = fromQuantity(header.timestamp);

  let fromBlock: number;
  let origin: FromBlockOrigin;
  if (options.fromBlock !== undefined) {
    fromBlock = options.fromBlock;
    origin = "given";
  } else {
    const creation = await findCreationBlock(rpc, token, { toBlock: block });
    fromBlock = creation.blockNumber;
    origin = creation.verification === "confirmed" ? "creation" : "creation-unconfirmed";
  }
  if (fromBlock > block) {
    throw new SnapshotError("E_INVALID_ARGUMENT", `fromBlock ${fromBlock} is after the snapshot block ${block}`);
  }
  const decimals = options.decimals ?? (await readDecimals(rpc, token, block));

  const { holders: replayed, transfers } = await replayFromChain(rpc, {
    token,
    fromBlock,
    toBlock: block,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  });
  const checked = await verifyBalances(rpc, {
    token,
    block,
    holders: replayed,
    ...(options.sample !== undefined ? { sample: options.sample } : {}),
  });
  const verification: Verification = { ...checked, verified: checked.verified && origin !== "creation-unconfirmed" };

  let holders: SnapshotHolder[] = replayed;
  if (options.classify === true) {
    const contracts = new Set(await findContracts(rpc, replayed.map((holder) => holder.address), block));
    holders = replayed.map((holder) => ({ ...holder, contract: contracts.has(holder.address) }));
  }

  const chainIdAfter = fromQuantity(await rpc.call<unknown>("eth_chainId", []));
  if (chainIdAfter !== chainId) {
    throw new SnapshotError(
      "E_UNVERIFIED",
      `the endpoint answered chain ${chainId} at the start and chain ${chainIdAfter} at the end: a fallback endpoint is on another chain`,
    );
  }

  const label = options.endpointLabel ?? ((_url: string, index: number) => `endpoint-${index + 1}`);
  return {
    package: PACKAGE_NAME,
    format: SNAPSHOT_FORMAT,
    chainId,
    token,
    decimals,
    block,
    blockTimestamp,
    holders,
    classified: options.classify === true,
    transfers,
    verification,
    source: { endpoints: rpc.urls.map((url, index) => label(url, index)), fromBlock, fromBlockOrigin: origin },
  };
}

/** The snapshot as JSON, every `bigint` written as a base-10 string. */
export function serializeSnapshot(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
}

/** Reads a file written by `serializeSnapshot`. Throws `E_SNAPSHOT_FORMAT` on anything else. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SnapshotError("E_SNAPSHOT_FORMAT", "the snapshot file is not valid JSON", { cause: error });
  }
  const file = record(raw, "the snapshot file");
  if (file["package"] !== PACKAGE_NAME) {
    throw new SnapshotError("E_SNAPSHOT_FORMAT", `the file was not written by ${PACKAGE_NAME}`);
  }
  if (file["format"] !== SNAPSHOT_FORMAT) {
    throw new SnapshotError("E_SNAPSHOT_FORMAT", `snapshot format ${String(file["format"])} is not supported; this version reads format ${SNAPSHOT_FORMAT}`);
  }
  const token = address(file["token"], "token");
  const decimals = integer(file["decimals"], "decimals");
  assertDecimals(decimals);
  const classified = file["classified"] === true;
  const holders = list(file["holders"], "holders").map((entry, index) => {
    const holder = record(entry, `holders[${index}]`);
    const parsed: SnapshotHolder = { address: address(holder["address"], `holders[${index}].address`), balance: amount(holder["balance"], `holders[${index}].balance`) };
    if (typeof holder["contract"] === "boolean") parsed.contract = holder["contract"];
    else if (classified) throw new SnapshotError("E_SNAPSHOT_FORMAT", `holders[${index}].contract is missing in a classified snapshot`);
    return parsed;
  });
  const verification = record(file["verification"], "verification");
  const source = record(file["source"], "source");
  const origin = source["fromBlockOrigin"];
  if (origin !== "creation" && origin !== "creation-unconfirmed" && origin !== "given") {
    throw new SnapshotError("E_SNAPSHOT_FORMAT", `source.fromBlockOrigin must be "creation", "creation-unconfirmed" or "given"`);
  }
  const snapshot: Snapshot = {
    package: PACKAGE_NAME,
    format: SNAPSHOT_FORMAT,
    chainId: integer(file["chainId"], "chainId"),
    token,
    decimals,
    block: integer(file["block"], "block"),
    blockTimestamp: integer(file["blockTimestamp"], "blockTimestamp"),
    holders,
    classified,
    transfers: integer(file["transfers"], "transfers"),
    verification: {
      verified: verification["verified"] === true,
      totalSupply: amount(verification["totalSupply"], "verification.totalSupply"),
      replayedSupply: amount(verification["replayedSupply"], "verification.replayedSupply"),
      checked: integer(verification["checked"], "verification.checked"),
      mismatches: list(verification["mismatches"], "verification.mismatches").map((entry, index) => {
        const mismatch = record(entry, `verification.mismatches[${index}]`);
        return {
          address: address(mismatch["address"], `verification.mismatches[${index}].address`),
          replayed: amount(mismatch["replayed"], `verification.mismatches[${index}].replayed`),
          onChain: amount(mismatch["onChain"], `verification.mismatches[${index}].onChain`),
        };
      }),
    },
    source: {
      endpoints: list(source["endpoints"], "source.endpoints").map(String),
      fromBlock: integer(source["fromBlock"], "source.fromBlock"),
      fromBlockOrigin: origin,
    },
  };
  assertConsistent(snapshot);
  return snapshot;
}

/**
 * Refuses a file whose parts contradict each other. This catches a hand edit that adds, removes
 * or resizes a holder while leaving `verified: true`, because the holders must still sum to the
 * supply the chain reported. It cannot catch an edit that swaps one address for another at the
 * same balance: a file on disk carries no proof of where it came from. `recheckSnapshot` closes
 * that gap by reading every balance from the chain again.
 */
function assertConsistent(snapshot: Snapshot): void {
  const inconsistent = (why: string) => new SnapshotError("E_SNAPSHOT_FORMAT", `the snapshot file is inconsistent: ${why}`);
  const seen = new Set<Address>();
  for (const holder of snapshot.holders) {
    if (holder.balance === 0n) throw inconsistent(`${holder.address} is listed with a zero balance`);
    if (seen.has(holder.address)) throw inconsistent(`${holder.address} is listed more than once`);
    seen.add(holder.address);
  }
  const { verification } = snapshot;
  if (sumBalances(snapshot.holders) !== verification.replayedSupply) {
    throw inconsistent("the holders' balances do not add up to the replayed supply");
  }
  if (verification.verified) {
    if (verification.totalSupply !== verification.replayedSupply) throw inconsistent("it is marked verified but the supplies differ");
    if (verification.mismatches.length > 0) throw inconsistent("it is marked verified but lists balance mismatches");
    // A token with no holders has nothing to check; any other verified snapshot checked something.
    const empty = snapshot.holders.length === 0 && verification.totalSupply === 0n;
    if (verification.checked === 0 && !empty) throw inconsistent("it is marked verified but no balance was checked");
    if (snapshot.source.fromBlockOrigin === "creation-unconfirmed") throw inconsistent("it is marked verified but its creation block is unconfirmed");
  }
}

export interface Recheck extends Verification {
  /** Holders whose saved `contract` flag disagrees with `eth_getCode` at the snapshot block. */
  contractMismatches: Address[];
}

/**
 * Reads a saved snapshot's facts back from the chain: the chain id, `totalSupply()`, every
 * holder's `balanceOf` at the snapshot block and, for a classified snapshot, every holder's
 * contract status. One or two calls per holder. A file edited after it was written — a holder
 * swapped, added, removed or resized, or a liquidity pool relabelled as a wallet so that
 * excluding contracts would pay it — fails here, so a payout built after a recheck pays what the
 * chain says, not what the file says.
 *
 * The token is supplied by the caller, not read from the file: a file that names a different real
 * token, with that token's balances, would otherwise recheck cleanly. The client follows the same
 * rule as `takeSnapshot`: more than one endpoint only through `connectSameChain`.
 */
export async function recheckSnapshot(rpc: Rpc, snapshot: Snapshot, expected: { token: Address }): Promise<Recheck> {
  assertSingleChain(rpc);
  const token = checkedAddress(expected.token, "token");
  if (token !== snapshot.token) {
    throw new SnapshotError("E_UNVERIFIED", `the snapshot is of token ${snapshot.token}, not ${token}`);
  }
  const chainId = fromQuantity(await rpc.call<unknown>("eth_chainId", []));
  if (chainId !== snapshot.chainId) {
    throw new SnapshotError("E_UNVERIFIED", `the snapshot is for chain ${snapshot.chainId}, but the endpoint is on chain ${chainId}`);
  }
  const balances = await verifyBalances(rpc, { token: snapshot.token, block: snapshot.block, holders: snapshot.holders, sample: "all" });
  const contractMismatches: Address[] = [];
  if (snapshot.classified) {
    const contracts = new Set(await findContracts(rpc, snapshot.holders.map((holder) => holder.address), snapshot.block));
    for (const holder of snapshot.holders) {
      if ((holder.contract === true) !== contracts.has(holder.address)) contractMismatches.push(holder.address);
    }
  }
  return { ...balances, verified: balances.verified && contractMismatches.length === 0, contractMismatches };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SnapshotError("E_SNAPSHOT_FORMAT", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new SnapshotError("E_SNAPSHOT_FORMAT", `${name} must be an array`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SnapshotError("E_SNAPSHOT_FORMAT", `${name} must be a non-negative integer`);
  }
  return value;
}

function amount(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new SnapshotError("E_SNAPSHOT_FORMAT", `${name} must be a base-10 integer string`);
  }
  return BigInt(value);
}

function address(value: unknown, name: string): Address {
  if (!isAddress(value)) throw new SnapshotError("E_SNAPSHOT_FORMAT", `${name} must be a 20-byte hex address`);
  return normalizeAddress(value);
}
