/**
 * An in-memory ERC-20 behind a `fetch` replacement. It answers the JSON-RPC methods this package
 * and `evm-log-walker` call: `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getLogs`
 * and `eth_call` for `balanceOf`, `totalSupply` and `decimals`. Balances and supply at a block are
 * computed from the same transfers the logs report, so a well-behaved token verifies; the
 * `balanceOverrides` and `supplyOverride` options model one whose balances do not follow its
 * events.
 *
 * Every address below is synthetic.
 */
import { TRANSFER_TOPIC } from "../src/transfers.js";
import { ZERO_ADDRESS, type Address, type Hex } from "../src/hex.js";

export const TOKEN = "0x4444444444444444444444444444444444444444" as Address;
export const TREASURY = "0x7777777777777777777777777777777777777777" as Address;
export const POOL = "0x8888888888888888888888888888888888888888" as Address;
export const holder = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

export interface FakeTransfer {
  blockNumber: number;
  from: Address;
  to: Address;
  value: bigint;
}

export interface FakeChainOptions {
  chainId?: number;
  head?: number;
  /** The token has code from this block on. Default 10. */
  creationBlock?: number;
  decimals?: number | null;
  transfers?: readonly FakeTransfer[];
  /** Other addresses with code: a liquidity pool, a vault. */
  contracts?: readonly Address[];
  /** `balanceOf` answers these instead of the replayed value. */
  balanceOverrides?: Readonly<Record<Address, bigint>>;
  supplyOverride?: bigint;
  /** Largest span `eth_getLogs` answers before refusing, so the walker's chunking is exercised. */
  maxLogSpan?: number;
  /**
   * Whether the creation block holds a direct deployment whose receipt names the token, which is
   * how `findCreationBlock` confirms it. Default true. False models a factory deployment, or an
   * endpoint whose pruned history made the search land after the real deployment.
   */
  confirmCreation?: boolean;
  /** `eth_chainId` per endpoint URL, to model a fallback endpoint on another chain. */
  chainIdByUrl?: Readonly<Record<string, number>>;
}

const DEPLOY_TX = `0x${"de".repeat(32)}`;

const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const topic = (address: Address): Hex => `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

export function fakeChain(options: FakeChainOptions = {}): { fetch: typeof globalThis.fetch; calls: { method: string; params: unknown[] }[] } {
  const head = options.head ?? 1_000;
  const creation = options.creationBlock ?? 10;
  const transfers = options.transfers ?? [];
  const contracts = new Set((options.contracts ?? []).map((address) => address.toLowerCase()));
  const calls: { method: string; params: unknown[] }[] = [];

  const at = (block: unknown): number => (typeof block === "string" && block.startsWith("0x") ? Number(block) : head);
  const balanceAt = (address: string, block: number): bigint => {
    let balance = 0n;
    for (const t of transfers) {
      if (t.blockNumber > block) continue;
      if (t.to.toLowerCase() === address) balance += t.value;
      if (t.from.toLowerCase() === address) balance -= t.value;
    }
    return balance;
  };
  const supplyAt = (block: number): bigint =>
    transfers.reduce((sum, t) => {
      if (t.blockNumber > block) return sum;
      if (t.from === ZERO_ADDRESS) return sum + t.value;
      if (t.to === ZERO_ADDRESS) return sum - t.value;
      return sum;
    }, 0n);

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    const fail = (code: number, message: string) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code, message } }), { status: 200, headers: { "content-type": "application/json" } });

    switch (body.method) {
      case "eth_chainId":
        return ok(`0x${(options.chainIdByUrl?.[String(url)] ?? options.chainId ?? 56).toString(16)}`);
      case "eth_getBlockByNumber": {
        const n = at(body.params[0]);
        const deployed = n === creation && options.confirmCreation !== false;
        return ok({
          number: `0x${n.toString(16)}`,
          timestamp: `0x${(1_700_000_000 + n * 3).toString(16)}`,
          transactions: deployed ? [{ hash: DEPLOY_TX, to: null }] : [],
        });
      }
      case "eth_getTransactionReceipt":
        return ok(body.params[0] === DEPLOY_TX ? { contractAddress: TOKEN } : null);
      case "eth_getCode": {
        const address = String(body.params[0]).toLowerCase();
        const n = at(body.params[1]);
        if (address === TOKEN.toLowerCase()) return ok(n >= creation ? "0x6080" : "0x");
        return ok(contracts.has(address) ? "0x6080" : "0x");
      }
      case "eth_getLogs": {
        const filter = (body.params[0] ?? {}) as Record<string, unknown>;
        const from = Number(filter["fromBlock"]);
        const to = Number(filter["toBlock"]);
        if (options.maxLogSpan !== undefined && to - from + 1 > options.maxLogSpan) return fail(-32005, "exceed maximum block range");
        const logs = transfers
          .map((t, index) => ({ t, index }))
          .filter(({ t }) => t.blockNumber >= from && t.blockNumber <= to)
          .map(({ t, index }) => ({
            address: TOKEN,
            topics: [TRANSFER_TOPIC, topic(t.from), topic(t.to)],
            data: word(t.value),
            blockNumber: `0x${t.blockNumber.toString(16)}`,
            blockHash: `0x${"cd".repeat(32)}`,
            transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
            transactionIndex: "0x0",
            logIndex: `0x${index.toString(16)}`,
          }));
        return ok(logs);
      }
      case "eth_call": {
        const call = body.params[0] as { to: string; data: string };
        const n = at(body.params[1]);
        if (call.to.toLowerCase() !== TOKEN.toLowerCase()) return ok("0x");
        const selector = call.data.slice(0, 10);
        if (selector === "0x18160ddd") return ok(word(options.supplyOverride ?? supplyAt(n)));
        if (selector === "0x313ce567") return options.decimals === null ? ok("0x") : ok(word(BigInt(options.decimals ?? 18)));
        if (selector === "0x70a08231") {
          const address = `0x${call.data.slice(-40)}`.toLowerCase() as Address;
          const override = Object.entries(options.balanceOverrides ?? {}).find(([key]) => key.toLowerCase() === address);
          return ok(word(override !== undefined ? override[1] : balanceAt(address, n)));
        }
        return ok("0x");
      }
      default:
        return fail(-32601, `method ${body.method} is not supported by this fake chain`);
    }
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

/** A mint of `value` to `to` in `block`. */
export const mint = (to: Address, value: bigint, blockNumber: number): FakeTransfer => ({ blockNumber, from: ZERO_ADDRESS, to, value });
