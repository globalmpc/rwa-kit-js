import { describeProviderValue, RpcError, sanitizeProviderText, WalkerError } from "./errors.js";
import { assertBlockNumber, isAddress, isTopic, rpcQuantity, toQuantity, type Hex } from "./hex.js";
import type { Rpc } from "./rpc.js";

export type BlockTag = "latest" | "finalized" | "safe";

/** One position of an `eth_getLogs` topic filter: any value, one value, or one of several. */
export type TopicFilter = (Hex | Hex[] | null)[];

/** A decoded log. Quantities are numbers, so `(transactionHash, logIndex)` is usable as a key. */
export interface Log {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
}

/** The logs of one `eth_getLogs` call, covering `fromBlock..toBlock` inclusive. */
export interface LogBatch {
  fromBlock: number;
  toBlock: number;
  logs: Log[];
}

/** Everything needed to continue a walk later: pass `nextBlock` as the next `fromBlock`. */
export interface Checkpoint {
  nextBlock: number;
  toBlock: number;
}

export interface WalkOptions {
  rpc: Rpc;
  /** Contract address or addresses. Omit to read logs from every address. */
  address?: Hex | Hex[];
  /** Topic filter in `eth_getLogs` form. `topics[0]` is the event signature hash. */
  topics?: TopicFilter;
  /** First block, inclusive. To resume, pass a checkpoint's `nextBlock`. */
  fromBlock: number;
  /** Last block, inclusive, or a tag resolved once at the start. Default `"finalized"`. */
  toBlock?: number | BlockTag;
  /** Largest block span per call. The walker shrinks it when the endpoint refuses. Default 5 000. */
  chunkSize?: number;
  /** Smallest span the walker will try before giving up. Default 1. */
  minChunkSize?: number;
  /** Called after each batch has been handed to the consumer. Store it to resume later. */
  onCheckpoint?: (checkpoint: Checkpoint) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface WalkSummary {
  fromBlock: number;
  toBlock: number;
  batches: number;
  logs: number;
  /** `eth_getLogs` calls made, including refused ones. */
  calls: number;
  /** Calls the endpoint refused because of its range or result limits. */
  rejectedCalls: number;
  /** The chunk size in use when the walk ended. */
  finalChunkSize: number;
}

interface RawLog {
  address: unknown;
  topics: unknown;
  data: unknown;
  blockNumber: unknown;
  blockHash: unknown;
  transactionHash: unknown;
  transactionIndex: unknown;
  logIndex: unknown;
  removed?: unknown;
}

/** Consecutive accepted calls at a reduced size before the walker tries a larger one again. */
const GROW_AFTER = 5;

/** Resolves a block tag to a number through the endpoint. A number is validated and returned. */
export async function resolveBlock(rpc: Rpc, block: number | BlockTag): Promise<number> {
  if (typeof block === "number") {
    assertBlockNumber(block, "block");
    return block;
  }
  const header = await rpc.call<{ number?: unknown } | null>("eth_getBlockByNumber", [block, false]);
  if (!header) {
    throw new WalkerError("E_RPC", `eth_getBlockByNumber returned no block for tag "${block}"`);
  }
  return rpcQuantity(header.number, "eth_getBlockByNumber");
}

/**
 * Reads logs from `fromBlock` to `toBlock` in chunks and yields each chunk as it arrives.
 *
 * When the endpoint refuses a call because of its block-range or result-count limit, the
 * walker halves the chunk and retries the same range. After `GROW_AFTER` accepted calls at a
 * reduced size it doubles the chunk again, up to `chunkSize`. Any other error is thrown as is.
 *
 * The generator's return value is a `WalkSummary`. `collectLogs` returns it together with all
 * logs when the whole range fits in memory.
 */
export async function* walkLogs(options: WalkOptions): AsyncGenerator<LogBatch, WalkSummary, undefined> {
  const { rpc } = options;
  const maxChunk = options.chunkSize ?? 5_000;
  const minChunk = options.minChunkSize ?? 1;
  assertBlockNumber(options.fromBlock, "fromBlock");
  if (!Number.isInteger(maxChunk) || maxChunk < 1) {
    throw new WalkerError("E_INVALID_ARGUMENT", `chunkSize must be a positive integer, got ${String(maxChunk)}`);
  }
  if (!Number.isInteger(minChunk) || minChunk < 1 || minChunk > maxChunk) {
    throw new WalkerError("E_INVALID_ARGUMENT", `minChunkSize must be between 1 and chunkSize, got ${String(minChunk)}`);
  }
  const filter = buildFilter(options.address, options.topics);
  const toBlock = await resolveBlock(rpc, options.toBlock ?? "finalized");

  const summary: WalkSummary = {
    fromBlock: options.fromBlock,
    toBlock,
    batches: 0,
    logs: 0,
    calls: 0,
    rejectedCalls: 0,
    finalChunkSize: maxChunk,
  };
  let chunk = maxChunk;
  let from = options.fromBlock;
  let accepted = 0;

  while (from <= toBlock) {
    options.signal?.throwIfAborted();
    const to = Math.min(from + chunk - 1, toBlock);
    let raw: unknown;
    summary.calls++;
    try {
      raw = await rpc.call("eth_getLogs", [
        { ...filter, fromBlock: toQuantity(from), toBlock: toQuantity(to) },
      ]);
    } catch (error) {
      if (!isRangeLimitError(error)) {
        throw error;
      }
      summary.rejectedCalls++;
      if (chunk <= minChunk) {
        throw new WalkerError(
          "E_LOGS_UNAVAILABLE",
          `${error.url} refused eth_getLogs for ${to - from + 1} block(s) (${from}..${to}), answering "${error.detail}". ` +
            "It does not serve log history for this filter; use an endpoint that does, for example a keyed one.",
          { cause: error },
        );
      }
      chunk = Math.max(minChunk, Math.floor(chunk / 2));
      accepted = 0;
      continue;
    }
    if (!Array.isArray(raw)) {
      throw new WalkerError("E_RPC", "eth_getLogs returned something other than an array");
    }
    const logs = raw.map(decodeLog);
    summary.batches++;
    summary.logs += logs.length;
    summary.finalChunkSize = chunk;
    yield { fromBlock: from, toBlock: to, logs };
    from = to + 1;
    if (options.onCheckpoint) {
      await options.onCheckpoint({ nextBlock: from, toBlock });
    }
    if (chunk < maxChunk && ++accepted >= GROW_AFTER) {
      chunk = Math.min(maxChunk, chunk * 2);
      accepted = 0;
    }
  }
  return summary;
}

/** Runs `walkLogs` to the end and returns every log with the summary. */
export async function collectLogs(options: WalkOptions): Promise<{ logs: Log[]; summary: WalkSummary }> {
  const logs: Log[] = [];
  const walk = walkLogs(options);
  for (;;) {
    const step = await walk.next();
    if (step.done) {
      return { logs, summary: step.value };
    }
    logs.push(...step.value.logs);
  }
}

const RANGE_LIMIT_PATTERN =
  /block range|max results|limit exceeded|too many|exceed|response size|query returned more|range too large|too large/i;

/** A rate limit is about the caller's pace, not the span: asking for less would not help, and each retry counts. */
const RATE_LIMIT_PATTERN = /rate.?limit|request rate|rate exceeded|too many requests|request count|requests per|quota/i;

/** A key problem is about the caller too, unless the wording also names the span (a range reserved for key holders). */
const KEY_PROBLEM_PATTERN = /unauthori[sz]ed|invalid (api )?key|api key/i;

/**
 * True when an `eth_getLogs` error means "ask for less": the wordings public BNB Chain and opBNB
 * endpoints use today, JSON-RPC code -32005, or an HTTP 413 or 403 refusal, which some endpoints
 * send for spans they reserve for paying users. Only the endpoint's own words (`detail`) are
 * matched, never the message, which also names the endpoint. In order:
 *
 * 1. A rate limit is never one, whatever its code or status.
 * 2. Wording about the span is one, even when it also mentions a key.
 * 3. A key problem with no word about the span is not one.
 * 4. Otherwise the code or status decides.
 *
 * A differently worded refusal is treated as fatal, and the message names the endpoint.
 */
export function isRangeLimitError(error: unknown): error is RpcError {
  if (!(error instanceof RpcError) || RATE_LIMIT_PATTERN.test(error.detail)) {
    return false;
  }
  if (RANGE_LIMIT_PATTERN.test(error.detail)) {
    return true;
  }
  if (KEY_PROBLEM_PATTERN.test(error.detail)) {
    return false;
  }
  return error.rpcCode === -32005 || error.httpStatus === 413 || error.httpStatus === 403;
}

/**
 * The `eth_getLogs` filter for an address and topic set, validated before anything is sent, so a
 * malformed value fails as `E_INVALID_ARGUMENT` instead of as an endpoint refusal.
 */
export function buildFilter(address: Hex | Hex[] | undefined, topics: TopicFilter | undefined): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (address !== undefined) {
    for (const item of Array.isArray(address) ? address : [address]) {
      if (!isAddress(item)) {
        throw new WalkerError("E_INVALID_ARGUMENT", `address ${String(item)} is not a 20-byte hex address`);
      }
    }
    filter["address"] = address;
  }
  if (topics !== undefined) {
    for (const position of topics) {
      const values = position === null ? [] : Array.isArray(position) ? position : [position];
      for (const value of values) {
        if (!isTopic(value)) {
          throw new WalkerError("E_INVALID_ARGUMENT", `topic ${String(value)} is not a 32-byte hex value`);
        }
      }
    }
    filter["topics"] = topics;
  }
  return filter;
}

function decodeLog(element: unknown): Log {
  const raw = (typeof element === "object" && element !== null ? element : {}) as RawLog;
  // Block and transaction hashes are 32-byte values, the same shape as a topic.
  if (
    !isAddress(raw.address) ||
    !Array.isArray(raw.topics) ||
    typeof raw.data !== "string" ||
    !isTopic(raw.blockHash) ||
    !isTopic(raw.transactionHash)
  ) {
    throw new WalkerError("E_RPC", `eth_getLogs returned a malformed log: ${describeProviderValue(element)}`);
  }
  return {
    address: raw.address,
    topics: raw.topics.map((topic) => {
      if (!isTopic(topic)) {
        throw new WalkerError("E_RPC", `eth_getLogs returned a malformed topic: ${sanitizeProviderText(String(topic))}`);
      }
      return topic;
    }),
    data: raw.data as Hex,
    blockNumber: rpcQuantity(raw.blockNumber, "eth_getLogs"),
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    transactionIndex: rpcQuantity(raw.transactionIndex, "eth_getLogs"),
    logIndex: rpcQuantity(raw.logIndex, "eth_getLogs"),
    removed: raw.removed === true,
  };
}
