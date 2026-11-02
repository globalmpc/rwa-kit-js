/**
 * In-memory chains behind `fetch` replacements, one per endpoint, answering the five JSON-RPC methods
 * the watcher calls. Each endpoint can be made to disagree, lag, fail or answer malformed data.
 *
 * Every address below is synthetic.
 */
import { createRpc, type Rpc } from "@globalmpc/evm-log-walker";
import type { Address, Hex } from "../src/hex.js";

export const HOT: Address = "0x1111111111111111111111111111111111111111";
export const COLD: Address = "0x2222222222222222222222222222222222222222";
export const TOKEN: Address = "0x3333333333333333333333333333333333333333";
export const SWEEPER: Address = "0x6666666666666666666666666666666666666666";
export const DELEGATE: Address = "0x5555555555555555555555555555555555555555";

export const delegationCode = (delegate: Address): Hex => `0xef0100${delegate.slice(2)}`;

export interface FakeAccount {
  code?: Hex;
  nonce?: bigint;
  balance?: bigint;
  tokens?: Record<string, bigint>;
}

export class FakeEndpoint {
  head = 1_000;
  chainId = 56;
  accounts = new Map<string, FakeAccount>();
  /** Methods that fail (HTTP 500) or answer the given malformed value. */
  broken = new Map<string, "fail" | unknown>();
  /** Every block tag the watcher asked about. */
  blocksAsked = new Set<string>();
  calls = 0;

  set(address: Address, account: FakeAccount): this {
    this.accounts.set(address.toLowerCase(), { ...this.accounts.get(address.toLowerCase()), ...account });
    return this;
  }

  rpc(name = "endpoint"): Rpc {
    return createRpc({ urls: `https://${name}.example`, fetch: this.fetch, retries: 0, backoffMs: 1 });
  }

  readonly fetch: typeof globalThis.fetch = async (_input, init) => {
    this.calls++;
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const broken = this.broken.get(request.method);
    if (broken === "fail") return new Response("down", { status: 500 });
    const result = broken !== undefined ? broken : this.answer(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
  };

  private answer(method: string, params: unknown[]): unknown {
    if (method === "eth_blockNumber") return `0x${this.head.toString(16)}`;
    if (method === "eth_chainId") return `0x${this.chainId.toString(16)}`;
    const tag = String(params[1]);
    this.blocksAsked.add(tag);
    if (method === "eth_call") {
      const call = params[0] as { to: string; data: string };
      const holder = `0x${call.data.slice(-40)}`;
      const balance = this.accounts.get(holder)?.tokens?.[call.to.toLowerCase()] ?? 0n;
      return `0x${balance.toString(16).padStart(64, "0")}`;
    }
    const account = this.accounts.get(String(params[0]).toLowerCase()) ?? {};
    if (method === "eth_getCode") return account.code ?? "0x";
    if (method === "eth_getTransactionCount") return `0x${(account.nonce ?? 0n).toString(16)}`;
    if (method === "eth_getBalance") return `0x${(account.balance ?? 0n).toString(16)}`;
    throw new Error(`fake chain does not answer ${method}`);
  }
}
