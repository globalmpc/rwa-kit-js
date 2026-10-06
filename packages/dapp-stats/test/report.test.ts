import { createRpc, utcDay } from "@globalmpc/evm-log-walker";
import type { Hex } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { ZERO_ADDRESS } from "../src/hex.js";
import { computeReport } from "../src/report.js";
import { createFakeChain, DEFAULT_ADDRESS, type FakeTransfer } from "./fake-chain.js";

const W1: Hex = "0x1111111111111111111111111111111111111111";
const W2: Hex = "0x2222222222222222222222222222222222222222";
const W3: Hex = "0x3333333333333333333333333333333333333333";
const H1: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111".slice(0, 66) as Hex;
const H2: Hex = "0x2222222222222222222222222222222222222222222222222222222222222222".slice(0, 66) as Hex;
const H3: Hex = "0x3333333333333333333333333333333333333333333333333333333333333333".slice(0, 66) as Hex;
const H4: Hex = "0x4444444444444444444444444444444444444444444444444444444444444444".slice(0, 66) as Hex;

const BLOCK_TIME = 3;
const GENESIS = 0;
const timestampOf = (block: number) => GENESIS + block * BLOCK_TIME;
const BLOCKS_PER_DAY = 86_400 / BLOCK_TIME;

// Day 0: block 100, mint 100 to W1.
// Day 1: block 28_900, W1 -> W2, 40. Sponsored (gasPrice 0).
// Day 2: no activity.
// Day 3: block 86_500, mint 50 to W3; block 86_600, W1 -> W2, 10. Two different senders that day.
const TRANSFERS: FakeTransfer[] = [
  { blockNumber: 100, transactionHash: H1, logIndex: 0, from: ZERO_ADDRESS, to: W1, value: 100n },
  { blockNumber: 28_900, transactionHash: H2, logIndex: 0, from: W1, to: W2, value: 40n },
  { blockNumber: 86_500, transactionHash: H3, logIndex: 0, from: ZERO_ADDRESS, to: W3, value: 50n },
  { blockNumber: 86_600, transactionHash: H4, logIndex: 0, from: W1, to: W2, value: 10n },
];

const TRANSACTIONS = new Map([
  [H1, { from: W1, blockNumber: 100, gasPrice: 1n }],
  [H2, { from: W1, blockNumber: 28_900, gasPrice: 0n }],
  [H3, { from: W3, blockNumber: 86_500, gasPrice: 5n }],
  [H4, { from: W1, blockNumber: 86_600, gasPrice: 2n }],
]);

function makeRpc() {
  const chain = createFakeChain({ head: 86_600, genesisTimestamp: GENESIS, blockTime: BLOCK_TIME, transfers: TRANSFERS, transactions: TRANSACTIONS });
  return createRpc({ urls: "http://a", fetch: chain.fetch });
}

// 100 seconds into day 3, so day 3 is today (provisional) and days 0-2 are final.
const NOW_MS = (timestampOf(86_400) + 100) * 1000;

describe("computeReport", () => {
  it("computes transactions, active wallets, holders and gas split per day against known data", async () => {
    const report = await computeReport({
      rpc: makeRpc(),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      label: "Test Token",
      fromBlock: 0,
      fromBlockIsCreation: true,
      now: () => NOW_MS,
    });

    expect(report.chain.chainId).toBe(56);
    expect(report.contract).toEqual({ address: DEFAULT_ADDRESS, label: "Test Token" });
    expect(report.days).toHaveLength(4);

    const [d0, d1, d2, d3] = report.days;

    expect(d0).toMatchObject({
      stage: "final",
      blockRange: { fromBlock: 100, toBlock: 100 },
      transactions: 1,
      activeWallets: 1,
      holders: 1,
      holdersAsOfBlock: 100,
      gas: { sponsored: 0, userPaid: 1 },
      return7d: null,
      return30d: null,
    });
    expect(d0!.source).toEqual({ rpc: "fake.example", methods: expect.arrayContaining(["eth_getLogs"]) });

    expect(d1).toMatchObject({
      stage: "final",
      blockRange: { fromBlock: 28_900, toBlock: 28_900 },
      transactions: 1,
      activeWallets: 1,
      holders: 2,
      holdersAsOfBlock: 28_900,
      gas: { sponsored: 1, userPaid: 0 },
    });

    expect(d2).toMatchObject({
      stage: "final",
      blockRange: null,
      transactions: 0,
      activeWallets: 0,
      holders: 2,
      holdersAsOfBlock: 28_900, // carried over: nothing happened this day
      gas: { sponsored: 0, userPaid: 0 },
    });

    expect(d3).toMatchObject({
      stage: "provisional",
      blockRange: { fromBlock: 86_500, toBlock: 86_600 },
      transactions: 2,
      activeWallets: 2, // W1 and W3
      holders: 3,
      holdersAsOfBlock: 86_600,
      gas: { sponsored: 0, userPaid: 2 },
    });

    expect(d3!.date).toBe(utcDay(timestampOf(86_500)));
  });

  it("trims to the most recent `days` without changing the underlying holder replay", async () => {
    const full = await computeReport({
      rpc: makeRpc(),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      fromBlock: 0,
      fromBlockIsCreation: true,
      now: () => NOW_MS,
    });
    const trimmed = await computeReport({
      rpc: makeRpc(),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      fromBlock: 0,
      fromBlockIsCreation: true,
      days: 2,
      now: () => NOW_MS,
    });

    expect(trimmed.days).toHaveLength(2);
    expect(trimmed.days).toEqual(full.days.slice(-2));
    // The second-to-last published day's holder count still reflects everything since creation,
    // not just what happened inside the trimmed window.
    expect(trimmed.days[0]!.holders).toBe(full.days.at(-2)!.holders);
  });

  it("degrades holders to null instead of throwing when the walk doesn't start at the true creation block, without losing the other metrics", async () => {
    // Starting at block 28_900 skips day 0's mint, so W1's day-1 send has no recorded balance.
    // Even a caller who wrongly claims it is the creation block gets null, not a wrong count.
    const report = await computeReport({
      rpc: makeRpc(),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      fromBlock: 28_900,
      fromBlockIsCreation: true,
      now: () => NOW_MS,
    });

    expect(report.days.every((day) => day.holders === null && day.holdersAsOfBlock === null)).toBe(true);
    // Everything else stays fully correct: only holders is unknowable, not the whole report.
    const last = report.days.at(-1)!;
    expect(last.transactions).toBe(2);
    expect(last.activeWallets).toBe(2);
    expect(last.gas).toEqual({ sponsored: 0, userPaid: 2 });
  });

  it("withholds holders for an explicit fromBlock not marked as the creation block, even when nothing goes negative", async () => {
    // From block 86_500 to 86_550 the window holds only W3's mint: an incoming-only replay that
    // would report 1 holder for a token that really has 3.
    const report = await computeReport({
      rpc: makeRpc(),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      fromBlock: 86_500,
      toBlock: 86_550,
      now: () => NOW_MS,
    });

    expect(report.days).toHaveLength(1);
    expect(report.days[0]).toMatchObject({ transactions: 1, holders: null, holdersAsOfBlock: null });
  });

  it("publishes quiet days up to toBlock's UTC day instead of ending at the last day with logs", async () => {
    // Activity on days 0 and 1 only; the head sits on day 10.
    const head = 10 * BLOCKS_PER_DAY + 100;
    const chain = createFakeChain({ head, genesisTimestamp: GENESIS, blockTime: BLOCK_TIME, transfers: TRANSFERS.slice(0, 2), transactions: TRANSACTIONS });
    const report = await computeReport({
      rpc: createRpc({ urls: "http://a", fetch: chain.fetch }),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      fromBlock: 0,
      fromBlockIsCreation: true,
      days: 3,
      now: () => (timestampOf(head) + 10) * 1000,
    });

    expect(report.days.map((day) => day.date)).toEqual([8, 9, 10].map((day) => utcDay(timestampOf(day * BLOCKS_PER_DAY))));
    expect(report.days.at(-1)).toMatchObject({
      stage: "provisional",
      blockRange: null,
      transactions: 0,
      holders: 2,
      holdersAsOfBlock: 28_900, // the last block with a transfer, carried forward
    });
    expect(report.days[0]!.stage).toBe("final");
  });

  it("fetches receipts only for the published days and the 30 days retention looks back over", async () => {
    // One transaction on day 0, one on day 40: with days: 1 only day 40's is ever needed.
    const head = 40 * BLOCKS_PER_DAY + 100;
    const chain = createFakeChain({
      head,
      genesisTimestamp: GENESIS,
      blockTime: BLOCK_TIME,
      transfers: [TRANSFERS[0]!, { ...TRANSFERS[2]!, blockNumber: head }],
      transactions: new Map([
        [H1, TRANSACTIONS.get(H1)!],
        [H3, { ...TRANSACTIONS.get(H3)!, blockNumber: head }],
      ]),
    });
    const report = await computeReport({
      rpc: createRpc({ urls: "http://a", fetch: chain.fetch }),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      fromBlock: 0,
      fromBlockIsCreation: true,
      days: 1,
      now: () => (timestampOf(head) + 10) * 1000,
    });

    const receiptHashes = chain.calls.filter((call) => call.method === "eth_getTransactionReceipt").map((call) => call.params[0]);
    expect(receiptHashes).toEqual([H3]);
    // Holders still replay the full history, including day 0's mint that had no receipt fetched.
    expect(report.days[0]).toMatchObject({ transactions: 1, activeWallets: 1, holders: 2 });
  });

  it("never reports a negative holdersAsOfBlock when the walk starts at block 0 and sees no transfers", async () => {
    const chain = createFakeChain({ head: 50, genesisTimestamp: GENESIS, blockTime: BLOCK_TIME, transfers: [], transactions: new Map() });
    const report = await computeReport({
      rpc: createRpc({ urls: "http://a", fetch: chain.fetch }),
      address: DEFAULT_ADDRESS,
      sourceLabel: "fake.example",
      fromBlock: 0,
      fromBlockIsCreation: true,
      now: () => (timestampOf(50) + 10) * 1000,
    });

    expect(report.days).toHaveLength(1);
    expect(report.days[0]).toMatchObject({ holders: 0, holdersAsOfBlock: 0 });
  });

  it("cuts a URL sourceLabel to its origin so a keyed endpoint never reaches the report, and keeps a plain name", async () => {
    const keyed = await computeReport({
      rpc: makeRpc(),
      address: DEFAULT_ADDRESS,
      sourceLabel: "https://LOGIN-NAME:LOGIN-PASS@rpc.example:8545/v1/SECRET-KEY?apikey=ALSO-SECRET",
      fromBlock: 0,
      now: () => NOW_MS,
    });
    const serialized = JSON.stringify(keyed);
    for (const secret of ["SECRET-KEY", "ALSO-SECRET", "LOGIN-NAME", "LOGIN-PASS"]) expect(serialized).not.toContain(secret);
    expect(keyed.days[0]!.source.rpc).toBe("https://rpc.example:8545");

    const several = await computeReport({
      rpc: makeRpc(),
      address: DEFAULT_ADDRESS,
      sourceLabel: "https://a.example/KEY-ONE, https://b.example/v2?key=KEY-TWO",
      fromBlock: 0,
      now: () => NOW_MS,
    });
    expect(several.days[0]!.source.rpc).toBe("https://a.example, https://b.example");

    const named = await computeReport({ rpc: makeRpc(), address: DEFAULT_ADDRESS, sourceLabel: "my node", fromBlock: 0, now: () => NOW_MS });
    expect(named.days[0]!.source.rpc).toBe("my node");
  });
});
