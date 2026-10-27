import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { fetchTransfersByRange, fetchTransfersByTransaction } from "../src/fetch.js";
import { TRANSFER_TOPIC } from "../src/transfers.js";
import { address, createFakeChain, hash, OTHER_TOKEN, PAYER, TOKEN } from "./fake-chain.js";

const OTHER_SENDER = address(0xdead);

function chain() {
  return createFakeChain([
    {
      hash: hash(1),
      blockNumber: 100,
      logs: [
        { to: address(1), amount: 10n },
        { to: address(2), amount: 20n },
        { token: OTHER_TOKEN, to: address(3), amount: 99n }, // a different token in the same transaction
        { from: OTHER_SENDER, to: PAYER, amount: 30n }, // a transfer into the payer, not a payout
        { to: address(4), amount: 5n, topics: [TRANSFER_TOPIC, hash(5), hash(6), hash(7)] }, // ERC-721 shape
      ],
    },
    { hash: hash(2), blockNumber: 105, succeeded: false, logs: [{ to: address(5), amount: 50n }] },
    { hash: hash(3), blockNumber: 110, logs: [{ to: address(6), amount: 60n }] },
  ]);
}

describe("fetchTransfersByTransaction", () => {
  it("keeps only the token's ERC-20 transfers, from the payer when one is given, keyed by log index", async () => {
    const { fetch } = chain();
    const rpc = createRpc({ urls: "http://a", fetch });
    const result = await fetchTransfersByTransaction(rpc, { token: TOKEN, payers: [PAYER], transactionHashes: [hash(1), hash(3)] });
    expect(result.transfers.map((t) => [t.to, t.amount, t.logIndex])).toEqual([
      [address(1), 10n, 0],
      [address(2), 20n, 1],
      [address(6), 60n, 0],
    ]);
  });

  it("without a payer, counts every transfer of the token in the transactions", async () => {
    const { fetch } = chain();
    const result = await fetchTransfersByTransaction(createRpc({ urls: "http://a", fetch }), { token: TOKEN, transactionHashes: [hash(1)] });
    expect(result.transfers.map((t) => t.to)).toEqual([address(1), address(2), PAYER]);
  });

  it("reports a reverted transaction, which moved nothing", async () => {
    const { fetch } = chain();
    const result = await fetchTransfersByTransaction(createRpc({ urls: "http://a", fetch }), { token: TOKEN, transactionHashes: [hash(2)] });
    expect(result.transactions).toEqual([{ hash: hash(2), succeeded: false, blockNumber: 105 }]);
    expect(result.transfers).toEqual([]);
  });

  it("reads each transaction once even when it is listed twice", async () => {
    const { fetch, calls } = chain();
    await fetchTransfersByTransaction(createRpc({ urls: "http://a", fetch }), { token: TOKEN, transactionHashes: [hash(1), hash(1).toUpperCase().replace("0X", "0x") as never] });
    expect(calls.filter((c) => c.method === "eth_getTransactionReceipt")).toHaveLength(1);
  });

  it("names a transaction the endpoint does not know, and rejects malformed arguments before any call", async () => {
    const { fetch, calls } = chain();
    const rpc = createRpc({ urls: "http://a", fetch });
    await expect(fetchTransfersByTransaction(rpc, { token: TOKEN, transactionHashes: [hash(77)] })).rejects.toThrow(/no receipt/);
    const before = calls.length;
    await expect(fetchTransfersByTransaction(rpc, { token: TOKEN, transactionHashes: ["0x12" as never] })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(fetchTransfersByTransaction(rpc, { token: "0x1" as never, transactionHashes: [hash(1)] })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(fetchTransfersByTransaction(rpc, { token: TOKEN, transactionHashes: [] })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    expect(calls.length).toBe(before);
  });
});

describe("a multisend contract that pulls the total in first", () => {
  const CONTRACT = address(0x5e5e);
  const pulled = () =>
    createFakeChain([
      {
        hash: hash(8),
        blockNumber: 120,
        logs: [
          { from: PAYER, to: CONTRACT, amount: 30n }, // the pull
          { from: CONTRACT, to: address(1), amount: 10n },
          { from: CONTRACT, to: address(2), amount: 20n },
        ],
      },
    ]);

  it("counts the contract's payouts and leaves out the move between the two payers", async () => {
    const { fetch } = pulled();
    const result = await fetchTransfersByTransaction(createRpc({ urls: "http://a", fetch }), { token: TOKEN, payers: [PAYER, CONTRACT], transactionHashes: [hash(8)] });
    expect(result.transfers.map((t) => [t.from, t.to])).toEqual([
      [CONTRACT, address(1)],
      [CONTRACT, address(2)],
    ]);
  });

  it("over a block range, ignores the shared contract's payouts for other senders", async () => {
    const { fetch } = createFakeChain([
      {
        hash: hash(8),
        blockNumber: 120,
        logs: [
          { from: PAYER, to: CONTRACT, amount: 30n },
          { from: CONTRACT, to: address(1), amount: 10n },
          { from: CONTRACT, to: address(2), amount: 20n },
        ],
      },
      {
        // Someone else's round through the same contract: their wallet pulls, the contract pays.
        hash: hash(9),
        blockNumber: 121,
        logs: [
          { from: address(0xbeef), to: CONTRACT, amount: 7n },
          { from: CONTRACT, to: address(77), amount: 7n },
        ],
      },
    ]);
    const result = await fetchTransfersByRange(createRpc({ urls: "http://a", fetch }), { token: TOKEN, payers: [PAYER, CONTRACT], fromBlock: 0, toBlock: 200 });
    expect(result.transfers.map((t) => t.to)).toEqual([address(1), address(2)]);
  });

  it("does the same over a block range", async () => {
    const { fetch } = pulled();
    const result = await fetchTransfersByRange(createRpc({ urls: "http://a", fetch }), { token: TOKEN, payers: [PAYER, CONTRACT], fromBlock: 0, toBlock: 200 });
    expect(result.transfers.map((t) => t.to)).toEqual([address(1), address(2)]);
  });
});

describe("a receipt with a malformed field", () => {
  it("is E_MALFORMED_TX, the receipt code, so a caller can switch endpoints on it", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { blockNumber: null, transactionIndex: "0x0", status: "0x1", logs: [] } }));
    };
    await expect(fetchTransfersByTransaction(createRpc({ urls: "http://a", fetch }), { token: TOKEN, transactionHashes: [hash(1)] })).rejects.toMatchObject({
      code: "E_MALFORMED_TX",
    });
  });
});

describe("fetchTransfersByRange", () => {
  it("asks eth_getLogs for the token's transfers from the payer only, and skips reverted transactions", async () => {
    const { fetch, calls } = chain();
    const result = await fetchTransfersByRange(createRpc({ urls: "http://a", fetch }), { token: TOKEN, payers: [PAYER], fromBlock: 0, toBlock: 200 });
    expect(result.transfers.map((t) => t.to)).toEqual([address(1), address(2), address(6)]);
    const filter = calls.find((c) => c.method === "eth_getLogs")?.params[0] as { topics: string[][] };
    expect(filter.topics[1]).toEqual([`0x${PAYER.slice(2).padStart(64, "0")}`]);
  });
});
