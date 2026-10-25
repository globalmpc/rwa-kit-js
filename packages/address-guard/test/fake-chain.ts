/**
 * An in-memory chain behind a `fetch` replacement, answering only the three JSON-RPC methods
 * `rpcLogSource` calls: `eth_getBlockByNumber` (to resolve a tag), `eth_getLogs` and
 * `eth_getTransactionByHash`.
 *
 * Smaller than `evm-log-walker`'s own fake chain, which is not importable here: tests are not
 * published, and packages in this workspace depend on each other through the registry.
 *
 * Every address below is synthetic.
 */
import { TRANSFER_TOPIC } from "../src/transfer-log.js";
import type { Address, Hex } from "../src/hex.js";

export const OWNER = "0x1111111111111111111111111111111111111111" as Address;
export const TOKEN = "0x4444444444444444444444444444444444444444" as Address;
/** A genuine counterparty the owner has really paid. */
export const GENUINE = "0xabcd00000000000000000000000000000000abcd" as Address;
/** Imitates GENUINE: same first and last four characters, different middle. */
export const IMITATOR = "0xabcd11111111111111111111111111111111abcd" as Address;
export const STRANGER = "0x9999000000000000000000000000000000009999" as Address;
/** A contract holding an approval: it can move the owner's tokens to an address of its choosing. */
export const SPENDER = "0x5555000000000000000000000000000000005555" as Address;

export interface FakeTransfer {
  blockNumber: number;
  from: Address;
  to: Address;
  valueRaw: bigint;
  /** The transaction's own sender. Defaults to `from`, which is the honest case. */
  txFrom?: Address;
  /**
   * What the transaction called. Defaults to the token, which with the default calldata is the
   * honest "owner sent directly" shape. Set it to a contract address to model a transfer the
   * owner signed but whose recipient they never named -- a spender holding an approval.
   */
  txTo?: Address;
  /**
   * The recipient named in the transaction's calldata. Defaults to `to`. Set it to `null` to
   * model calldata that is not a plain transfer at all, such as a multisend.
   */
  txTransferTo?: Address | null;
  token?: Address;
  logIndex?: number;
  /** An ERC-721 Transfer: same signature, four topics. Filtered out by the topic count. */
  erc721?: boolean;
  /** A reorged log. `eth_getLogs` output carries `removed: true` and it must be ignored. */
  removed?: boolean;
}

export interface FakeChainOptions {
  head?: number;
  transfers?: readonly FakeTransfer[];
  /** Largest span `eth_getLogs` answers before refusing, so the walker's chunking is exercised. */
  maxLogSpan?: number;
  /** Hashes `eth_getTransactionByHash` answers with null, as a pruned endpoint would. */
  missingTransactions?: readonly Hex[];
  /** Answer `eth_getTransactionByHash` with an object that has no usable `from`. */
  malformedTransactions?: boolean;
}

function hashFor(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}` as Hex;
}

function topicFor(address: Address): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

function matchesTopics(logTopics: Hex[], filter: unknown): boolean {
  if (!Array.isArray(filter)) return true;
  return filter.every((position, index) => {
    if (position === null || position === undefined) return true;
    const want = Array.isArray(position) ? position : [position];
    const have = logTopics[index];
    return have !== undefined && want.some((value) => String(value).toLowerCase() === have.toLowerCase());
  });
}

/** Builds a `fetch` replacement plus the request log, for asserting what was actually asked. */
export function fakeChain(options: FakeChainOptions = {}): {
  fetch: typeof globalThis.fetch;
  calls: { method: string; params: readonly unknown[] }[];
} {
  const head = options.head ?? 1_000;
  const transfers = options.transfers ?? [];
  const missing = new Set((options.missingTransactions ?? []).map((hash) => hash.toLowerCase()));
  const calls: { method: string; params: readonly unknown[] }[] = [];

  // One transaction per transfer, so a hash maps to exactly one sender.
  const rows = transfers.map((transfer, index) => {
    const token = transfer.token ?? TOKEN;
    return {
      ...transfer,
      hash: hashFor(index + 1),
      txFrom: transfer.txFrom ?? transfer.from,
      token,
      txTo: transfer.txTo ?? token,
      txTransferTo: transfer.txTransferTo === undefined ? transfer.to : transfer.txTransferTo,
      logIndex: transfer.logIndex ?? index,
    };
  });

  /** A plain `transfer(address,uint256)` calldata, the shape a wallet shows as "send X to Y". */
  const transferCalldata = (to: Address, value: bigint): string =>
    `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${value.toString(16).padStart(64, "0")}`;

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id: number;
      method: string;
      params: readonly unknown[];
    };
    calls.push({ method: body.method, params: body.params });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const rpcError = (code: number, message: string) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code, message } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    switch (body.method) {
      case "eth_getBlockByNumber":
        return ok({ number: `0x${head.toString(16)}` });

      case "eth_getLogs": {
        const filter = (body.params[0] ?? {}) as Record<string, unknown>;
        const from = Number(filter["fromBlock"]);
        const to = Number(filter["toBlock"]);
        if (options.maxLogSpan !== undefined && to - from + 1 > options.maxLogSpan) {
          return rpcError(-32005, "exceed maximum block range");
        }
        const wanted = filter["address"];
        const addresses =
          wanted === undefined
            ? undefined
            : new Set((Array.isArray(wanted) ? wanted : [wanted]).map((a) => String(a).toLowerCase()));
        const logs = rows
          .filter((row) => row.blockNumber >= from && row.blockNumber <= to)
          .filter((row) => addresses === undefined || addresses.has(row.token.toLowerCase()))
          .map((row) => ({
            address: row.token,
            topics: row.erc721
              ? [TRANSFER_TOPIC, topicFor(row.from), topicFor(row.to), `0x${"0".repeat(64)}`]
              : [TRANSFER_TOPIC, topicFor(row.from), topicFor(row.to)],
            data: `0x${row.valueRaw.toString(16)}`,
            blockNumber: `0x${row.blockNumber.toString(16)}`,
            blockHash: `0x${"cd".repeat(32)}`,
            transactionHash: row.hash,
            transactionIndex: "0x0",
            logIndex: `0x${row.logIndex.toString(16)}`,
            ...(row.removed === true ? { removed: true } : {}),
          }))
          .filter((log) => matchesTopics(log.topics as Hex[], filter["topics"]));
        return ok(logs);
      }

      case "eth_getTransactionByHash": {
        const hash = String(body.params[0] ?? "").toLowerCase();
        if (missing.has(hash)) return ok(null);
        const row = rows.find((entry) => entry.hash.toLowerCase() === hash);
        if (row === undefined) return ok(null);
        if (options.malformedTransactions === true) return ok({ hash: row.hash, to: row.token });
        return ok({
          hash: row.hash,
          from: row.txFrom,
          to: row.txTo,
          // Null txTransferTo means calldata that is not a plain transfer, so nothing to decode.
          input: row.txTransferTo === null ? "0xdeadbeef" : transferCalldata(row.txTransferTo, row.valueRaw),
        });
      }

      default:
        return rpcError(-32601, `method ${body.method} is not supported by this fake chain`);
    }
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}
