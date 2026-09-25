/**
 * An in-memory chain behind a `fetch` replacement. It answers the JSON-RPC methods the package
 * uses and refuses requests the way public BNB Chain and opBNB endpoints did on 2026-09-23:
 * a block-span cap ("exceed maximum block range"), a result cap ("query exceeds max results"),
 * an endpoint that never serves logs ("limit exceeded"), and no past state ("missing trie node").
 */
import type { Hex } from "../src/hex.js";

export const DEFAULT_ADDRESS: Hex = "0x1111111111111111111111111111111111111111";
export const OTHER_ADDRESS: Hex = "0x2222222222222222222222222222222222222222";
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const OTHER_TOPIC: Hex = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

export interface FakeLog {
  blockNumber: number;
  address?: Hex;
  topics?: Hex[];
  data?: Hex;
  logIndex?: number;
  transactionIndex?: number;
}

export interface FakeChainOptions {
  head?: number;
  chainId?: number;
  /** Blocks between head and finalized. Default 15. */
  finalizedLag?: number;
  /** Seconds per block. Default 3. */
  blockTime?: number;
  /** Timestamp of block 0. Default 1 700 000 000. */
  genesisTimestamp?: number;
  logs?: FakeLog[];
  /** Largest span `eth_getLogs` answers. `null` refuses every call. Default 5 000. */
  maxLogSpan?: number | null;
  /** Largest number of logs one `eth_getLogs` call returns. Default unlimited. */
  maxLogResults?: number;
  /** Forces every `eth_getLogs` call to fail with this error. */
  logsFailure?: { code: number; message: string };
  /** Whether `eth_getCode` answers at past blocks. Default true. */
  archive?: boolean;
  /** The refusal wording when `archive` is false. Default "missing trie node". */
  archiveError?: string;
  /** Answer past-state queries with empty results instead of refusing them, as some endpoints do. */
  pruneSilently?: boolean;
  /** Direct deployments: the block's creation transaction and its receipt name the address. */
  deployments?: Record<string, { blockNumber: number; txHash: Hex }>;
  /** Creation block per address. Unlisted addresses never hold code. */
  codeFrom?: Record<string, number>;
  /** Whether the `finalized` tag is understood. Default true. */
  finalizedTag?: boolean;
  /** Per URL, how many requests fail at the transport level before it answers. */
  transportFailures?: Record<string, number>;
  /** Per URL, how many requests get an HTTP 429 before it answers, and the Retry-After to send. */
  rateLimits?: Record<string, { times: number; retryAfter?: string }>;
  /** Answer `eth_getLogs` spans above this size with a bare HTTP status instead of a JSON-RPC error. */
  httpRefusal?: { aboveSpan: number; status: number; body?: string };
  /** Per method, answer every call with a bare HTTP status, as a gateway refusing a key does. */
  httpRefusals?: Record<string, { status: number; body?: string }>;
}

export interface RpcCall {
  url: string;
  method: string;
  params: unknown[];
  headers: Record<string, string>;
  /** The `redirect` mode the client asked `fetch` for. */
  redirect: RequestInit["redirect"];
}

class JsonRpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const RECENT_STATE_WINDOW = 128;

export function createFakeChain(options: FakeChainOptions = {}) {
  const head = options.head ?? 1_000;
  const chainId = options.chainId ?? 56;
  const finalized = Math.max(0, head - (options.finalizedLag ?? 15));
  const blockTime = options.blockTime ?? 3;
  const genesis = options.genesisTimestamp ?? 1_700_000_000;
  const maxLogSpan = options.maxLogSpan === undefined ? 5_000 : options.maxLogSpan;
  const maxLogResults = options.maxLogResults ?? Number.POSITIVE_INFINITY;
  const archive = options.archive ?? true;
  const finalizedTag = options.finalizedTag ?? true;
  const codeFrom = new Map(Object.entries(options.codeFrom ?? {}).map(([address, block]) => [address.toLowerCase(), block]));
  const deployments = Object.entries(options.deployments ?? {}).map(([address, deployment]) => ({
    address: address.toLowerCase(),
    ...deployment,
  }));
  const transportFailures = new Map(Object.entries(options.transportFailures ?? {}));
  const rateLimits = new Map(Object.entries(options.rateLimits ?? {}).map(([url, limit]) => [url, { ...limit }]));
  const logs = (options.logs ?? []).map((log, index) => ({
    address: (log.address ?? DEFAULT_ADDRESS).toLowerCase() as Hex,
    topics: log.topics ?? [TRANSFER_TOPIC],
    data: log.data ?? ("0x" as Hex),
    blockNumber: log.blockNumber,
    logIndex: log.logIndex ?? index,
    transactionIndex: log.transactionIndex ?? 0,
  }));
  const calls: RpcCall[] = [];

  const quantity = (value: number): Hex => `0x${value.toString(16)}`;
  const blockHash = (block: number): Hex => `0x${block.toString(16).padStart(64, "0")}`;
  const txHash = (block: number, index: number): Hex => `0x1${(block * 1_000 + index).toString(16).padStart(63, "0")}`;

  function resolveTag(tag: unknown): number {
    if (tag === "latest" || tag === "pending") return head;
    if (tag === "earliest") return 0;
    if (tag === "finalized" || tag === "safe") {
      if (!finalizedTag) throw new JsonRpcFailure(-32602, "invalid argument 0: hex string without 0x prefix");
      return finalized;
    }
    if (typeof tag === "string" && /^0x[0-9a-f]+$/i.test(tag)) return Number.parseInt(tag, 16);
    throw new JsonRpcFailure(-32602, `invalid block tag ${String(tag)}`);
  }

  function matchesTopics(logTopics: Hex[], filter: unknown): boolean {
    if (!Array.isArray(filter)) return true;
    return filter.every((position: unknown, index) => {
      if (position === null || position === undefined) return true;
      const actual = logTopics[index];
      if (actual === undefined) return false;
      const wanted = Array.isArray(position) ? position : [position];
      return wanted.some((value) => String(value).toLowerCase() === actual.toLowerCase());
    });
  }

  function getLogs(filter: Record<string, unknown>): unknown[] {
    if (options.logsFailure) throw new JsonRpcFailure(options.logsFailure.code, options.logsFailure.message);
    if (maxLogSpan === null) throw new JsonRpcFailure(-32005, "limit exceeded");
    const from = resolveTag(filter["fromBlock"] ?? "latest");
    const to = resolveTag(filter["toBlock"] ?? "latest");
    if (to - from + 1 > maxLogSpan) throw new JsonRpcFailure(-32000, `exceed maximum block range: ${maxLogSpan}`);
    const addresses =
      filter["address"] === undefined
        ? null
        : (Array.isArray(filter["address"]) ? filter["address"] : [filter["address"]]).map((a) => String(a).toLowerCase());
    const matched = logs.filter(
      (log) =>
        log.blockNumber >= from &&
        log.blockNumber <= to &&
        (addresses === null || addresses.includes(log.address)) &&
        matchesTopics(log.topics, filter["topics"]),
    );
    if (matched.length > maxLogResults) {
      throw new JsonRpcFailure(-32602, `query exceeds max results ${maxLogResults}, retry with the range ${from}-${from}`);
    }
    return matched.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: quantity(log.blockNumber),
      blockHash: blockHash(log.blockNumber),
      transactionHash: txHash(log.blockNumber, log.transactionIndex),
      transactionIndex: quantity(log.transactionIndex),
      logIndex: quantity(log.logIndex),
      removed: false,
    }));
  }

  function getCode(address: unknown, tag: unknown): Hex {
    const block = resolveTag(tag);
    if (!archive && block < head - RECENT_STATE_WINDOW) {
      if (options.pruneSilently) return "0x";
      throw new JsonRpcFailure(-32000, options.archiveError ?? "missing trie node");
    }
    const creation = codeFrom.get(String(address).toLowerCase());
    return creation !== undefined && block >= creation ? "0x6080604052" : "0x";
  }

  function handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return quantity(chainId);
      case "eth_blockNumber":
        return quantity(head);
      case "eth_getBlockByNumber": {
        const block = resolveTag(params[0]);
        if (block > head) return null;
        const transactions = deployments
          .filter((deployment) => deployment.blockNumber === block)
          .map((deployment) => (params[1] === true ? { hash: deployment.txHash, to: null } : deployment.txHash));
        return { number: quantity(block), hash: blockHash(block), timestamp: quantity(genesis + block * blockTime), transactions };
      }
      case "eth_getTransactionReceipt": {
        const deployment = deployments.find((candidate) => candidate.txHash === params[0]);
        return deployment ? { transactionHash: deployment.txHash, contractAddress: deployment.address } : null;
      }
      case "eth_getLogs":
        return getLogs((params[0] ?? {}) as Record<string, unknown>);
      case "eth_getCode":
        return getCode(params[0], params[1]);
      default:
        throw new JsonRpcFailure(-32601, `the method ${method} does not exist/is not available`);
    }
  }

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({
      url,
      method: body.method,
      params: body.params,
      headers: { ...(init?.headers as Record<string, string>) },
      redirect: init?.redirect,
    });
    const remaining = transportFailures.get(url) ?? 0;
    if (remaining > 0) {
      transportFailures.set(url, remaining - 1);
      throw new TypeError("fetch failed");
    }
    const limit = rateLimits.get(url);
    if (limit && limit.times > 0) {
      limit.times--;
      return new Response("", { status: 429, headers: limit.retryAfter === undefined ? {} : { "retry-after": limit.retryAfter } });
    }
    const refusal = options.httpRefusals?.[body.method];
    if (refusal) {
      return new Response(refusal.body ?? "", { status: refusal.status });
    }
    if (body.method === "eth_getLogs" && options.httpRefusal) {
      const filter = (body.params[0] ?? {}) as Record<string, unknown>;
      const span = resolveTag(filter["toBlock"] ?? "latest") - resolveTag(filter["fromBlock"] ?? "latest") + 1;
      if (span > options.httpRefusal.aboveSpan) {
        return new Response(options.httpRefusal.body ?? "", { status: options.httpRefusal.status });
      }
    }
    let payload: Record<string, unknown>;
    try {
      payload = { jsonrpc: "2.0", id: body.id, result: handle(body.method, body.params) };
    } catch (error) {
      if (!(error instanceof JsonRpcFailure)) throw error;
      payload = { jsonrpc: "2.0", id: body.id, error: { code: error.code, message: error.message } };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    fetch: fetchImpl,
    calls,
    callsFor: (method: string) => calls.filter((call) => call.method === method),
    head,
    finalized,
  };
}
