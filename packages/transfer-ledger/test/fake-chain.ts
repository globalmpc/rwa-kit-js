/**
 * A well-behaved in-memory chain that answers what this package asks for: `eth_chainId`,
 * `eth_getTransactionReceipt` (with each transaction's logs), `eth_getBlockByNumber` and
 * `eth_getLogs` with an address and topic filter. Endpoint resilience is `evm-log-walker`'s job and
 * is tested there.
 */
import type { Hex } from "@globalmpc/evm-log-walker";
import { TRANSFER_TOPIC } from "../src/transfers.js";

export const TOKEN: Hex = "0x00000000000000000000000000000000000000aa";
export const OTHER_TOKEN: Hex = "0x00000000000000000000000000000000000000bb";
export const PAYER: Hex = "0x000000000000000000000000000000000000c0de";

export const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}` as Hex;
export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export interface FakeLog {
  token?: Hex;
  from?: Hex;
  to: Hex;
  amount: bigint;
  /** Overrides the topics, to model a log that is not an ERC-20 Transfer. */
  topics?: Hex[];
  removed?: boolean;
}

export interface FakeTx {
  hash: Hex;
  blockNumber: number;
  /** Position in the block. Default 0. */
  transactionIndex?: number;
  succeeded?: boolean;
  logs: FakeLog[];
}

export interface RecordedCall {
  url: string;
  method: string;
  params: unknown[];
}

const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const topicOf = (a: Hex): Hex => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const quantity = (n: number): Hex => `0x${n.toString(16)}` as Hex;

export function createFakeChain(transactions: readonly FakeTx[], options: { chainId?: number; head?: number } = {}) {
  const calls: RecordedCall[] = [];
  const head = options.head ?? Math.max(1, ...transactions.map((tx) => tx.blockNumber));

  function rpcLogs(tx: FakeTx) {
    let index = 0;
    return tx.logs.map((log) => ({
      address: log.token ?? TOKEN,
      topics: log.topics ?? [TRANSFER_TOPIC, topicOf(log.from ?? PAYER), topicOf(log.to)],
      data: word(log.amount),
      blockNumber: quantity(tx.blockNumber),
      blockHash: hash(tx.blockNumber + 1_000_000),
      transactionHash: tx.hash,
      transactionIndex: quantity(tx.transactionIndex ?? 0),
      logIndex: quantity(index++),
      removed: log.removed ?? false,
    }));
  }

  function handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return quantity(options.chainId ?? 56);
      case "eth_getTransactionReceipt": {
        const tx = transactions.find((candidate) => candidate.hash === String(params[0]).toLowerCase());
        if (!tx) return null;
        return {
          transactionHash: tx.hash,
          blockNumber: quantity(tx.blockNumber),
          transactionIndex: quantity(tx.transactionIndex ?? 0),
          status: tx.succeeded === false ? "0x0" : "0x1",
          logs: tx.succeeded === false ? [] : rpcLogs(tx),
        };
      }
      case "eth_getBlockByNumber": {
        const tag = params[0];
        const number = tag === "latest" || tag === "finalized" || tag === "safe" ? head : Number.parseInt(String(tag), 16);
        return { number: quantity(number), timestamp: quantity(1_700_000_000 + number * 3), hash: hash(number + 1_000_000) };
      }
      case "eth_getLogs": {
        // A topic position is null (any), one value, or a list of values (any of them), as on a real node.
        const filter = params[0] as { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        return transactions
          .filter((tx) => tx.succeeded !== false && tx.blockNumber >= from && tx.blockNumber <= to)
          .flatMap(rpcLogs)
          .filter((log) => filter.address === undefined || log.address.toLowerCase() === filter.address.toLowerCase())
          .filter((log) =>
            (filter.topics ?? []).every((topic, i) => {
              if (topic === null) return true;
              const wanted = (Array.isArray(topic) ? topic : [topic]).map((value) => value.toLowerCase());
              return wanted.includes(log.topics[i]?.toLowerCase() ?? "");
            }),
          );
      }
      default:
        throw new Error(`fake chain: unexpected method ${method}`);
    }
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ url: String(input), method: body.method, params: body.params });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: handle(body.method, body.params) }), {
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}
