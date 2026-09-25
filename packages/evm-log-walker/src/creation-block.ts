import { RpcError, WalkerError } from "./errors.js";
import { assertBlockNumber, isAddress, toQuantity, type Hex } from "./hex.js";
import type { Rpc } from "./rpc.js";
import { resolveBlock, type BlockTag } from "./walk.js";

export interface CreationBlockOptions {
  /** A block known to be before the deployment. Default 0. Narrowing it saves probes. */
  fromBlock?: number;
  /** A block at which the contract exists. Default `"latest"`. */
  toBlock?: number | BlockTag;
  /** Observes each `eth_getCode` probe, for progress output. */
  onProbe?: (blockNumber: number, hasCode: boolean) => void;
}

/**
 * `confirmed`: a transaction in the found block has a receipt whose `contractAddress` is the
 * address, so the block is the deployment block beyond doubt.
 *
 * `unconfirmed`: no such receipt. Either the contract was created by another contract (a factory
 * or a proxy deployer), which leaves no `contractAddress` on any receipt, or the endpoint answers
 * past-state queries with empty results instead of refusing them, and the bisection landed on the
 * edge of its state window rather than on the deployment. Cross-check on an archive endpoint
 * before relying on an unconfirmed block.
 */
export type CreationVerification = "confirmed" | "unconfirmed";

export interface CreationBlockResult {
  address: Hex;
  /** The first block at which the address holds code, as far as the endpoint reports. */
  blockNumber: number;
  verification: CreationVerification;
  /** `eth_getCode` calls made. Verification adds one block fetch plus one receipt per creation transaction. */
  probes: number;
}

/**
 * How endpoints without past state word their refusal. `header not found` is what a pruned geth
 * says. Matched against the endpoint's own words only, never the message, which also names the
 * endpoint: an origin such as `archive.example` must not turn a key problem into this.
 */
const NO_ARCHIVE_PATTERN = /missing trie node|header not found|archive|historical|state (is )?not available|pruned|ancient|old block/i;

/**
 * Finds the block a contract was deployed in with `eth_getCode`: steps back from `toBlock` in
 * doubling strides (1, 2, 4, ... blocks) until a block without code is found, then bisects that
 * last stride, and verifies the answer against the deployment receipt. About `2 * log2(age)`
 * probes, where age is the number of blocks since the deployment: around 40 for a contract that
 * is a million blocks old, and a handful for one deployed yesterday. Block 0 is only probed when
 * the contract is older than everything else, which matters because many endpoints keep past
 * state without keeping genesis state.
 *
 * Needs an endpoint that serves `eth_getCode` at past blocks. Public BNB Chain and opBNB
 * endpoints refuse those calls, and the error says so. Endpoints that answer them with empty
 * results instead produce an `unconfirmed` result; see `CreationVerification`.
 *
 * Assumes code, once present, stays. An address that was self-destructed and deployed again
 * yields the first block of whichever deployment the search lands on.
 */
export async function findCreationBlock(
  rpc: Rpc,
  address: Hex,
  options: CreationBlockOptions = {},
): Promise<CreationBlockResult> {
  if (!isAddress(address)) {
    throw new WalkerError("E_INVALID_ARGUMENT", `address ${String(address)} is not a 20-byte hex address`);
  }
  const fromBlock = options.fromBlock ?? 0;
  assertBlockNumber(fromBlock, "fromBlock");
  const toBlock = await resolveBlock(rpc, options.toBlock ?? "latest");
  if (fromBlock > toBlock) {
    throw new WalkerError("E_INVALID_ARGUMENT", `fromBlock ${fromBlock} is after toBlock ${toBlock}`);
  }
  let probes = 0;

  async function hasCode(blockNumber: number): Promise<boolean> {
    probes++;
    let code: unknown;
    try {
      code = await rpc.call("eth_getCode", [address, toQuantity(blockNumber)]);
    } catch (error) {
      if (error instanceof RpcError && error.refused && NO_ARCHIVE_PATTERN.test(error.detail)) {
        throw new WalkerError(
          "E_NO_ARCHIVE_STATE",
          `${error.url} has no state for block ${blockNumber} (it answered "${error.detail}"). ` +
            "Finding a creation block needs an archive endpoint; public BNB Chain and opBNB endpoints do not keep past state.",
          { cause: error },
        );
      }
      throw error;
    }
    const present = typeof code === "string" && code !== "0x" && code !== "";
    options.onProbe?.(blockNumber, present);
    return present;
  }

  if (!(await hasCode(toBlock))) {
    throw new WalkerError("E_NO_CODE", `no contract code at ${address} at block ${toBlock}`);
  }

  // Gallop back from toBlock until a block without code is found, or the floor is reached.
  let withCode = toBlock;
  let without: number | undefined;
  for (let stride = 1; toBlock - stride > fromBlock; stride *= 2) {
    const candidate = toBlock - stride;
    if (await hasCode(candidate)) {
      withCode = candidate;
    } else {
      without = candidate;
      break;
    }
  }
  let lower: number;
  if (without === undefined) {
    if (await hasCode(fromBlock)) {
      if (fromBlock === 0) {
        return { address, blockNumber: 0, verification: "unconfirmed", probes };
      }
      throw new WalkerError(
        "E_INVALID_ARGUMENT",
        `code is already present at fromBlock ${fromBlock}; pass a fromBlock before the deployment`,
      );
    }
    lower = fromBlock;
  } else {
    lower = without;
  }

  // Bisect the last stride: lower has no code, withCode has it.
  let upper = withCode;
  while (upper - lower > 1) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (await hasCode(middle)) {
      upper = middle;
    } else {
      lower = middle;
    }
  }
  const verification = await verifyDeployment(rpc, address, upper);
  return { address, blockNumber: upper, verification, probes };
}

async function verifyDeployment(rpc: Rpc, address: Hex, blockNumber: number): Promise<CreationVerification> {
  const block = await rpc.call<{ transactions?: unknown } | null>("eth_getBlockByNumber", [toQuantity(blockNumber), true]);
  const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
  for (const transaction of transactions) {
    if (typeof transaction !== "object" || transaction === null) continue;
    const { to, hash } = transaction as { to?: unknown; hash?: unknown };
    // Only a direct deployment has no recipient. Creations by other contracts leave no receipt trace.
    if (to !== null && to !== undefined) continue;
    if (typeof hash !== "string") continue;
    const receipt = await rpc.call<{ contractAddress?: unknown } | null>("eth_getTransactionReceipt", [hash]);
    if (typeof receipt?.contractAddress === "string" && receipt.contractAddress.toLowerCase() === address.toLowerCase()) {
      return "confirmed";
    }
  }
  return "unconfirmed";
}
