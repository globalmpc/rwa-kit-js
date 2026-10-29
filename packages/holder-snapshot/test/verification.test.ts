import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { connectSameChain, sampleHolders, verifyBalances } from "../src/chain.js";
import { buildDistribution } from "../src/distribute.js";
import { EXIT, runHolderSnapshot } from "../src/cli/holder-snapshot.js";
import { parseSnapshot, recheckSnapshot, serializeSnapshot, takeSnapshot } from "../src/snapshot.js";
import { fakeChain, holder, mint, POOL, TOKEN, TREASURY, type FakeTransfer } from "./fake-chain.js";
import { memoryIo } from "./io.js";

const E18 = 10n ** 18n;
const HISTORY: FakeTransfer[] = [
  mint(TREASURY, 1_000n * E18, 10),
  { blockNumber: 20, from: TREASURY, to: holder(1), value: 300n * E18 },
  { blockNumber: 22, from: TREASURY, to: POOL, value: 200n * E18 },
];

const rpcFor = (options: Parameters<typeof fakeChain>[0] = {}) =>
  createRpc({ urls: "https://r.example", fetch: fakeChain({ transfers: HISTORY, ...options }).fetch, retries: 0 });

describe("an unconfirmed creation block", () => {
  it("leaves the snapshot unverified and says how to fix it", async () => {
    const run = memoryIo(fakeChain({ transfers: HISTORY, confirmCreation: false }).fetch);
    expect(await runHolderSnapshot(["snapshot", "--token", TOKEN, "--block", "500", "--rpc", "https://r.example"], run.io)).toBe(EXIT.UNVERIFIED);
    expect(run.out.join("\n")).toContain("could not be confirmed");
  });

  it("is accepted once the caller vouches for the start block", async () => {
    const run = memoryIo(fakeChain({ transfers: HISTORY, confirmCreation: false }).fetch);
    const argv = ["snapshot", "--token", TOKEN, "--block", "500", "--from-block", "10", "--rpc", "https://r.example"];
    expect(await runHolderSnapshot(argv, run.io)).toBe(EXIT.OK);
  });

  it("cannot be marked verified in a saved file", async () => {
    const file = JSON.parse(serializeSnapshot(await takeSnapshot(rpcFor({ confirmCreation: false }), { token: TOKEN, block: 500 })));
    file.verification.verified = true;
    expect(() => parseSnapshot(JSON.stringify(file))).toThrow(/creation block is unconfirmed/);
  });
});

describe("the balanceOf sample", () => {
  it("must be at least one in the library", async () => {
    await expect(verifyBalances(rpcFor(), { token: TOKEN, block: 500, holders: [], sample: 0 })).rejects.toThrow(/positive integer/);
  });

  it("must be at least one on the command line", async () => {
    const run = memoryIo(fakeChain({ transfers: HISTORY }).fetch);
    expect(await runHolderSnapshot(["snapshot", "--token", TOKEN, "--sample", "0", "--rpc", "https://r.example"], run.io)).toBe(EXIT.USAGE);
  });
});

describe("token decimals", () => {
  it("are refused above 36 when read from the token", async () => {
    await expect(takeSnapshot(rpcFor({ decimals: 37 }), { token: TOKEN, block: 500 })).rejects.toMatchObject({ code: "E_MALFORMED_RESPONSE" });
  });

  it("can be supplied instead", async () => {
    expect((await takeSnapshot(rpcFor({ decimals: 37 }), { token: TOKEN, block: 500, decimals: 18 })).decimals).toBe(18);
  });
});

describe("endpoints on different chains", () => {
  const chainIdByUrl = { "https://a.example": 56, "https://b.example": 97 };

  it("are refused by snapshot before anything else is read", async () => {
    const chain = fakeChain({ transfers: HISTORY, chainIdByUrl });
    const run = memoryIo(chain.fetch);
    const code = await runHolderSnapshot(["snapshot", "--token", TOKEN, "--block", "500", "--rpc", "https://a.example", "--rpc", "https://b.example"], run.io);
    expect(code).toBe(EXIT.USAGE);
    expect(run.err.join("\n")).toContain("endpoint-1: 56, endpoint-2: 97");
    expect(chain.calls.every((call) => call.method === "eth_chainId")).toBe(true);
  });

  it("are refused by distribute before the recheck", async () => {
    const run = memoryIo(fakeChain({ transfers: HISTORY, chainIdByUrl }).fetch);
    run.files.set("snap.json", serializeSnapshot(await takeSnapshot(rpcFor(), { token: TOKEN, block: 500 })));
    const argv = ["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "1", "--decimals", "6", "--rpc", "https://a.example", "--rpc", "https://b.example"];
    expect(await runHolderSnapshot(argv, run.io)).toBe(EXIT.USAGE);
  });
});

describe("a sampled check", () => {
  /** Twenty small holders, then a balance moved between two of them with no event: the supply is unchanged. */
  const MANY: FakeTransfer[] = [
    mint(TREASURY, 1_000n * E18, 10),
    ...Array.from({ length: 20 }, (_, i) => ({ blockNumber: 20 + i, from: TREASURY, to: holder(i + 1), value: BigInt(i + 1) * E18 })),
  ];
  const silentMove = { [holder(3)]: 1n * E18, [holder(4)]: 6n * E18 };

  it("can pass while unsampled balances are wrong, so it is never payable", async () => {
    const rpc = rpcFor({ transfers: MANY, balanceOverrides: silentMove });
    const sampled = await takeSnapshot(rpc, { token: TOKEN, block: 500, sample: 1 });
    expect(sampled.verification.verified).toBe(true);
    expect(() => buildDistribution(sampled, { pool: 1_000n })).toThrow(/only 2 of 21 balances were checked/);
  });

  it("is not the default: every balance is checked, and the silent move is caught", async () => {
    const snapshot = await takeSnapshot(rpcFor({ transfers: MANY, balanceOverrides: silentMove }), { token: TOKEN, block: 500 });
    expect(snapshot.verification.checked).toBe(21);
    expect(snapshot.verification.verified).toBe(false);
    expect(snapshot.verification.mismatches.map((m) => m.address)).toEqual([holder(3), holder(4)]);
  });

  it("samples from the middle of each interval, so a sample of one reaches the small holders", () => {
    const ranked = Array.from({ length: 100 }, (_, i) => i);
    expect(sampleHolders(ranked, 1)).toEqual([0, 50]);
  });
});

describe("a client with fallback endpoints", () => {
  const chainIdByUrl = { "https://a.example": 56, "https://b.example": 97 };

  it("is refused by takeSnapshot unless connectSameChain built it", async () => {
    const fetch = fakeChain({ transfers: HISTORY }).fetch;
    const plain = createRpc({ urls: ["https://a.example", "https://b.example"], fetch, retries: 0 });
    await expect(takeSnapshot(plain, { token: TOKEN, block: 500 })).rejects.toThrow(/connectSameChain/);
    const { rpc, chainId } = await connectSameChain({ urls: ["https://a.example", "https://b.example"], fetch, retries: 0 });
    expect(chainId).toBe(56);
    expect((await takeSnapshot(rpc, { token: TOKEN, block: 500 })).verification.verified).toBe(true);
  });

  it("is refused by recheckSnapshot unless connectSameChain built it", async () => {
    const fetch = fakeChain({ transfers: HISTORY }).fetch;
    const snapshot = await takeSnapshot(rpcFor(), { token: TOKEN, block: 500 });
    const plain = createRpc({ urls: ["https://a.example", "https://b.example"], fetch, retries: 0 });
    await expect(recheckSnapshot(plain, snapshot, { token: TOKEN })).rejects.toThrow(/connectSameChain/);
  });

  it("cannot be built over endpoints on different chains", async () => {
    const fetch = fakeChain({ transfers: HISTORY, chainIdByUrl }).fetch;
    await expect(connectSameChain({ urls: ["https://a.example", "https://b.example"], fetch, retries: 0 })).rejects.toThrow(/different chains/);
  });
});
