import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { sampleHolders } from "../src/chain.js";
import { buildDistribution } from "../src/distribute.js";
import { parseSnapshot, serializeSnapshot, takeSnapshot } from "../src/snapshot.js";
import { fakeChain, holder, mint, POOL, TOKEN, TREASURY, type FakeTransfer } from "./fake-chain.js";

const E18 = 10n ** 18n;

/** A treasury mint at creation, then distributions to holders and a pool, and one later sale. */
const HISTORY: FakeTransfer[] = [
  mint(TREASURY, 1_000n * E18, 10),
  { blockNumber: 20, from: TREASURY, to: holder(1), value: 300n * E18 },
  { blockNumber: 21, from: TREASURY, to: holder(2), value: 100n * E18 },
  { blockNumber: 22, from: TREASURY, to: POOL, value: 200n * E18 },
  { blockNumber: 30, from: holder(1), to: holder(3), value: 50n * E18 },
  // After the snapshot block used below: must not count.
  { blockNumber: 600, from: holder(2), to: holder(4), value: 100n * E18 },
];

function rpcFor(options: Parameters<typeof fakeChain>[0] = {}) {
  const chain = fakeChain({ transfers: HISTORY, contracts: [POOL], ...options });
  return { rpc: createRpc({ urls: "https://rpc.example/secret-key", fetch: chain.fetch, retries: 0 }), calls: chain.calls };
}

describe("takeSnapshot", () => {
  it("replays from the creation block, found automatically, and verifies against the token", async () => {
    const { rpc } = rpcFor();
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500 });
    expect(snapshot.source).toEqual({ endpoints: ["endpoint-1"], fromBlock: 10, fromBlockOrigin: "creation" });
    expect(snapshot.chainId).toBe(56);
    expect(snapshot.decimals).toBe(18);
    expect(snapshot.holders).toEqual([
      { address: TREASURY, balance: 400n * E18 },
      { address: holder(1), balance: 250n * E18 },
      { address: POOL, balance: 200n * E18 },
      { address: holder(2), balance: 100n * E18 },
      { address: holder(3), balance: 50n * E18 },
    ]);
    expect(snapshot.verification).toMatchObject({ verified: true, totalSupply: 1_000n * E18, replayedSupply: 1_000n * E18, checked: 5, mismatches: [] });
    expect(JSON.stringify(serializeSnapshot(snapshot))).not.toContain("secret-key");
  });

  it("walks a long history in chunks when the endpoint caps eth_getLogs, replaying each as it arrives", async () => {
    const { rpc, calls } = rpcFor({ maxLogSpan: 50 });
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500, fromBlock: 10 });
    expect(snapshot.verification.verified).toBe(true);
    expect(snapshot.transfers).toBe(5);
    expect(calls.filter((call) => call.method === "eth_getLogs").length).toBeGreaterThan(5);
  });

  it("fails verification when balanceOf disagrees with the events", async () => {
    const { rpc } = rpcFor({ balanceOverrides: { [holder(1)]: 1n } });
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500 });
    expect(snapshot.verification.verified).toBe(false);
    expect(snapshot.verification.mismatches).toEqual([{ address: holder(1), replayed: 250n * E18, onChain: 1n }]);
  });

  it("fails verification when totalSupply disagrees, as a rebasing token's would", async () => {
    const { rpc } = rpcFor({ supplyOverride: 1_010n * E18 });
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500 });
    expect(snapshot.verification.verified).toBe(false);
    expect(snapshot.verification.mismatches).toEqual([]);
  });

  it("refuses a history started after creation", async () => {
    const { rpc } = rpcFor();
    await expect(takeSnapshot(rpc, { token: TOKEN, block: 500, fromBlock: 25 })).rejects.toMatchObject({ code: "E_INCOMPLETE_HISTORY" });
  });

  it("classifies holders as contracts or wallets on request", async () => {
    const { rpc } = rpcFor();
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500, classify: true });
    expect(snapshot.classified).toBe(true);
    expect(snapshot.holders.filter((h) => h.contract).map((h) => h.address)).toEqual([POOL]);
  });

  it("uses the decimals given for a token without decimals()", async () => {
    const { rpc } = rpcFor({ decimals: null });
    await expect(takeSnapshot(rpc, { token: TOKEN, block: 500 })).rejects.toMatchObject({ code: "E_MALFORMED_RESPONSE" });
    expect((await takeSnapshot(rpc, { token: TOKEN, block: 500, decimals: 6 })).decimals).toBe(6);
  });
});

describe("snapshot file", () => {
  it("round-trips through serializeSnapshot and parseSnapshot", async () => {
    const { rpc } = rpcFor();
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500, classify: true });
    expect(parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot);
  });

  it("refuses a file it did not write", () => {
    expect(() => parseSnapshot("{}")).toThrow(/not written by/);
    expect(() => parseSnapshot("not json")).toThrow(/not valid JSON/);
  });
});

describe("buildDistribution", () => {
  it("excludes the treasury and contracts, then splits pro-rata", async () => {
    const { rpc } = rpcFor();
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500, classify: true });
    const distribution = buildDistribution(snapshot, { pool: 4_000_000n, exclude: [TREASURY], excludeContracts: true });
    expect(distribution.excluded.map((x) => [x.address, x.reason])).toEqual([
      [TREASURY, "listed"],
      [POOL, "contract"],
    ]);
    // 250 / 100 / 50 of 400 eligible
    expect(distribution.allocations.map((x) => [x.address, x.amount])).toEqual([
      [holder(1), 2_500_000n],
      [holder(2), 1_000_000n],
      [holder(3), 500_000n],
    ]);
    expect(distribution.remainder).toBe(0n);
  });

  it("refuses to pay from an unverified snapshot", async () => {
    const { rpc } = rpcFor({ supplyOverride: 1n });
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500 });
    expect(() => buildDistribution(snapshot, { pool: 1n })).toThrow(/failed verification/);
  });

  it("refuses to exclude contracts when the snapshot was not classified", async () => {
    const { rpc } = rpcFor();
    const snapshot = await takeSnapshot(rpc, { token: TOKEN, block: 500 });
    expect(() => buildDistribution(snapshot, { pool: 1n, excludeContracts: true })).toThrow(/classify/);
  });
});

describe("sampleHolders", () => {
  it("takes the largest and then an even spread of the rest", () => {
    const list = Array.from({ length: 100 }, (_, i) => i);
    expect(sampleHolders(list, 3)).toEqual([0, 1, 2, 19, 51, 83]);
    expect(sampleHolders([1, 2], 3)).toEqual([1, 2]);
  });
});
