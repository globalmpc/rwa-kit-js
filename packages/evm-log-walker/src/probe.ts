import { RpcError, WalkerError } from "./errors.js";
import { rpcQuantity, toQuantity, type Hex } from "./hex.js";
import type { Rpc } from "./rpc.js";
import { buildFilter, type TopicFilter } from "./walk.js";

export interface ProbeOptions {
  /** The filter the walk will use. Result-count limits depend on it, so probe with the real one. */
  address?: Hex | Hex[];
  topics?: TopicFilter;
  /** Block spans to try, in any order; the largest is tried first. Default `[50000, 10000, 5000, 1000, 100, 1]`. */
  spans?: readonly number[];
}

export interface RpcCapabilities {
  chainId: number;
  /** Latest block at probe time. */
  head: number;
  /** Whether `eth_getBlockByNumber("finalized")` is answered. */
  finalizedTag: boolean;
  /**
   * The largest probed span for which `eth_getLogs` was answered at the head, or `null` when
   * none was, which means the endpoint does not serve log history for this filter.
   */
  maxLogSpan: number | null;
  /** Whether `eth_getCode` at block 1 is answered. Without it, creation blocks cannot be found. */
  archiveState: boolean;
}

const DEFAULT_SPANS = [50_000, 10_000, 5_000, 1_000, 100, 1] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Asks an endpoint what it will answer, so a walk can start with a chunk size that works instead
 * of discovering the limit one refused call at a time. Each probe is one call; nothing is retried
 * across endpoints beyond the client's own failover.
 *
 * The result is a measurement at the head, not a guarantee: endpoints that cap results rather
 * than block spans can still refuse a denser range further back, and the walker adapts to that.
 */
export async function probeRpc(rpc: Rpc, options: ProbeOptions = {}): Promise<RpcCapabilities> {
  const filter = buildFilter(options.address, options.topics);
  const spans = [...(options.spans ?? DEFAULT_SPANS)];
  for (const span of spans) {
    if (!Number.isInteger(span) || span < 1) {
      throw new WalkerError("E_INVALID_ARGUMENT", `spans must be positive integers, got ${String(span)}`);
    }
  }
  spans.sort((a, b) => b - a);
  const chainId = rpcQuantity(await rpc.call("eth_chainId", []), "eth_chainId");
  const head = rpcQuantity(await rpc.call("eth_blockNumber", []), "eth_blockNumber");
  const finalizedTag = await answers(() => rpc.call("eth_getBlockByNumber", ["finalized", false]));

  let maxLogSpan: number | null = null;
  let lastFrom: number | undefined;
  for (const span of spans) {
    const from = Math.max(0, head - span + 1);
    // Spans wider than the chain all start at block 0; one refused call answers for all of them.
    if (from === lastFrom) continue;
    lastFrom = from;
    const answered = await answers(() =>
      rpc.call("eth_getLogs", [{ ...filter, fromBlock: toQuantity(from), toBlock: toQuantity(head) }]),
    );
    if (answered) {
      maxLogSpan = head - from + 1;
      break;
    }
  }

  const probeAddress = Array.isArray(options.address) ? options.address[0] : options.address;
  const archiveState = await answers(() => rpc.call("eth_getCode", [probeAddress ?? ZERO_ADDRESS, "0x1"]));

  return { chainId, head, finalizedTag, maxLogSpan, archiveState };
}

/**
 * A refusal (a JSON-RPC error, or an HTTP 4xx) means "not served". A transport failure on every
 * endpoint says nothing about capabilities, so it is surfaced instead.
 */
async function answers(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (error) {
    if (error instanceof RpcError && error.refused) {
      return false;
    }
    throw error;
  }
}
