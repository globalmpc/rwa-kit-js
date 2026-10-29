import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { EXIT, runHolderSnapshot } from "../src/cli/holder-snapshot.js";
import { parseSnapshot, recheckSnapshot, serializeSnapshot, takeSnapshot } from "../src/snapshot.js";
import { fakeChain, holder, mint, POOL, TOKEN, TREASURY, type FakeTransfer } from "./fake-chain.js";
import { memoryIo } from "./io.js";

const E18 = 10n ** 18n;
const HISTORY: FakeTransfer[] = [
  mint(TREASURY, 1_000n * E18, 10),
  { blockNumber: 20, from: TREASURY, to: holder(1), value: 300n * E18 },
  { blockNumber: 21, from: TREASURY, to: holder(2), value: 300n * E18 },
  { blockNumber: 22, from: TREASURY, to: POOL, value: 200n * E18 },
];

const rpcFor = (options: Parameters<typeof fakeChain>[0] = {}) =>
  createRpc({ urls: "https://r.example", fetch: fakeChain({ transfers: HISTORY, contracts: [POOL], ...options }).fetch, retries: 0 });

async function saved(options: { classify?: boolean } = {}): Promise<string> {
  return serializeSnapshot(await takeSnapshot(rpcFor(), { token: TOKEN, block: 500, ...options }));
}

/** Swaps holder(2) for an address that never held the token, at the same balance, so every sum still matches. */
async function swapped(): Promise<string> {
  const file = JSON.parse(await saved());
  file.holders.find((h: { address: string }) => h.address === holder(2)).address = holder(99);
  return JSON.stringify(file);
}

describe("parseSnapshot", () => {
  it("refuses a balance edited while verified stays true", async () => {
    const file = JSON.parse(await saved());
    file.holders[0].balance = "1";
    expect(() => parseSnapshot(JSON.stringify(file))).toThrow(/do not add up/);
  });

  it("refuses a non-empty verified file that checked nothing", async () => {
    const file = JSON.parse(await saved());
    file.verification.checked = 0;
    expect(() => parseSnapshot(JSON.stringify(file))).toThrow(/no balance was checked/);
  });

  it("reads back the verified snapshot of a token with no holders", async () => {
    const snapshot = await takeSnapshot(rpcFor({ transfers: [] }), { token: TOKEN, block: 500 });
    expect(snapshot.verification).toMatchObject({ verified: true, checked: 0, totalSupply: 0n });
    expect(parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot);
  });
});

describe("recheckSnapshot", () => {
  it("finds a holder swapped for another address", async () => {
    const result = await recheckSnapshot(rpcFor(), parseSnapshot(await swapped()), { token: TOKEN });
    expect(result.verified).toBe(false);
    expect(result.mismatches.map((m) => m.address)).toEqual([holder(99)]);
  });
});

describe("distribute rechecks the file against the chain", () => {
  it("refuses an edited file and writes nothing", async () => {
    const run = memoryIo(fakeChain({ transfers: HISTORY }).fetch);
    run.files.set("snap.json", await swapped());
    const code = await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "100", "--decimals", "6", "--rpc", "https://r.example", "--out", "p.csv"], run.io);
    expect(code).toBe(EXIT.UNVERIFIED);
    expect(run.files.has("p.csv")).toBe(false);
    expect(run.err.join("\n")).toContain("does not match the chain");
  });

  it("refuses a classified file that relabels a liquidity pool as a wallet", async () => {
    const file = JSON.parse(await saved({ classify: true }));
    file.holders.find((h: { address: string }) => h.address === POOL).contract = false;
    const run = memoryIo(fakeChain({ transfers: HISTORY, contracts: [POOL] }).fetch);
    run.files.set("snap.json", JSON.stringify(file));
    const argv = ["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "100", "--decimals", "6", "--exclude-contracts", "--rpc", "https://r.example", "--out", "p.csv"];
    expect(await runHolderSnapshot(argv, run.io)).toBe(EXIT.UNVERIFIED);
    expect(run.files.has("p.csv")).toBe(false);
    expect(run.err.join("\n")).toContain(`${POOL}: contract flag differs from eth_getCode`);
  });

  it("passes an untouched file", async () => {
    const run = memoryIo(fakeChain({ transfers: HISTORY }).fetch);
    run.files.set("snap.json", await saved());
    const code = await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "100", "--decimals", "6", "--rpc", "https://r.example"], run.io);
    expect(code).toBe(EXIT.OK);
    expect(run.err).toContain("rechecked    yes: all 4 balance(s) and totalSupply match the chain");
  });

  it("needs an endpoint unless --offline is said explicitly", async () => {
    const run = memoryIo(undefined);
    run.files.set("snap.json", await saved());
    expect(await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "100", "--decimals", "6"], run.io)).toBe(EXIT.USAGE);
    expect(run.err.join("\n")).toContain("--offline");
  });
});

describe("the token a payout is for", () => {
  const OTHER = `0x${"55".repeat(20)}`;

  it("must be given to distribute", async () => {
    const run = memoryIo(undefined);
    run.files.set("snap.json", await saved());
    expect(await runHolderSnapshot(["distribute", "--snapshot", "snap.json", "--pool", "1", "--decimals", "6", "--offline"], run.io)).toBe(EXIT.USAGE);
    expect(run.err.join("\n")).toContain("--token is required");
  });

  it("must match the file's, even offline", async () => {
    const run = memoryIo(undefined);
    run.files.set("snap.json", await saved());
    const code = await runHolderSnapshot(["distribute", "--token", OTHER, "--snapshot", "snap.json", "--pool", "1", "--decimals", "6", "--offline", "--out", "p.csv"], run.io);
    expect(code).toBe(EXIT.UNVERIFIED);
    expect(run.files.has("p.csv")).toBe(false);
  });

  it("is supplied to recheckSnapshot, not read from the file", async () => {
    const snapshot = parseSnapshot(await saved());
    await expect(recheckSnapshot(rpcFor(), snapshot, { token: OTHER as `0x${string}` })).rejects.toThrow(/not 0x5555/);
  });
});
