import { createRpc } from "@globalmpc/evm-log-walker";
import type { Hex } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { fetchTransactionSummaries } from "../src/tx.js";
import { createFakeChain } from "./fake-chain.js";

const W1: Hex = "0x1111111111111111111111111111111111111111";
const W2: Hex = "0x2222222222222222222222222222222222222222";
const HASH_A: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: Hex = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("fetchTransactionSummaries", () => {
  it("reads from and effectiveGasPrice from the receipt", async () => {
    const chain = createFakeChain({
      head: 100,
      transfers: [],
      transactions: new Map([[HASH_A, { from: W1, blockNumber: 10, gasPrice: 5n }]]),
    });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const result = await fetchTransactionSummaries(rpc, [HASH_A]);

    expect(result.get(HASH_A)).toEqual({ hash: HASH_A, from: W1, blockNumber: 10, gasPrice: 5n, sponsored: false });
  });

  it("marks a zero gasPrice as sponsored", async () => {
    const chain = createFakeChain({
      head: 100,
      transfers: [],
      transactions: new Map([[HASH_A, { from: W1, blockNumber: 10, gasPrice: 0n }]]),
    });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const result = await fetchTransactionSummaries(rpc, [HASH_A]);

    expect(result.get(HASH_A)?.sponsored).toBe(true);
  });

  it("falls back to eth_getTransactionByHash when the receipt omits effectiveGasPrice", async () => {
    const chain = createFakeChain({
      head: 100,
      transfers: [],
      transactions: new Map([[HASH_A, { from: W1, blockNumber: 10, gasPrice: 7n, legacy: true }]]),
    });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const result = await fetchTransactionSummaries(rpc, [HASH_A]);

    expect(result.get(HASH_A)?.gasPrice).toBe(7n);
    expect(chain.calls.some((call) => call.method === "eth_getTransactionByHash")).toBe(true);
  });

  it("fetches each unique hash once even when given duplicates", async () => {
    const chain = createFakeChain({
      head: 100,
      transfers: [],
      transactions: new Map([
        [HASH_A, { from: W1, blockNumber: 10, gasPrice: 1n }],
        [HASH_B, { from: W2, blockNumber: 11, gasPrice: 1n }],
      ]),
    });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const result = await fetchTransactionSummaries(rpc, [HASH_A, HASH_A, HASH_B, HASH_A]);

    expect(result.size).toBe(2);
    expect(chain.calls.filter((call) => call.method === "eth_getTransactionReceipt")).toHaveLength(2);
  });
});
