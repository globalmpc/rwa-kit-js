import { describe, expect, it } from "vitest";
import { ENDPOINT_VARIABLE, EXIT, runHolderSnapshot, USAGE } from "../src/cli/holder-snapshot.js";
import { fakeChain, holder, mint, POOL, TOKEN, TREASURY, type FakeTransfer } from "./fake-chain.js";

const E18 = 10n ** 18n;
const HISTORY: FakeTransfer[] = [
  mint(TREASURY, 1_000n * E18, 10),
  { blockNumber: 20, from: TREASURY, to: holder(1), value: 300n * E18 },
  { blockNumber: 21, from: TREASURY, to: holder(2), value: 100n * E18 },
  { blockNumber: 22, from: TREASURY, to: POOL, value: 200n * E18 },
  { blockNumber: 23, from: TREASURY, to: holder(3), value: 1n },
];

function io(fetchImpl?: typeof globalThis.fetch, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  return {
    out,
    err,
    files,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      env,
      ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
      readFile: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      writeFile: async (path: string, data: string) => {
        files.set(path, data);
      },
    },
  };
}

const SNAPSHOT = ["snapshot", "--token", TOKEN, "--block", "500", "--classify", "--out", "snap.json", "--rpc", "https://rpc.example"];

describe("holder-snapshot CLI", () => {
  it("takes a snapshot, then distributes it offline into a payout CSV", async () => {
    const online = io(fakeChain({ transfers: HISTORY, contracts: [POOL] }).fetch);
    expect(await runHolderSnapshot(SNAPSHOT, online.io)).toBe(EXIT.OK);
    expect(online.out).toContain("verified     yes: totalSupply matches and 5 balance(s) match balanceOf");
    expect(online.out).toContain("source       endpoint-1");

    // No fetch at all: distribute must not touch the network.
    const offline = io(undefined);
    offline.files.set("snap.json", online.files.get("snap.json") as string);
    const code = await runHolderSnapshot(
      ["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "4000", "--decimals", "6", "--exclude", TREASURY, "--exclude-contracts", "--min-balance", "1", "--out", "payouts.csv", "--offline"],
      offline.io,
    );
    expect(code).toBe(EXIT.OK);
    expect(offline.files.get("payouts.csv")).toBe(`recipient,amount\n${holder(1)},3000\n${holder(2)},1000\n`);
    expect(offline.out).toContain("eligible     2; excluded 3 (listed 1, contract 1, below-minimum 1)");
    expect(offline.out).toContain("remainder    0");
  });

  it("prints the CSV on stdout and the summary on stderr when there is no --out", async () => {
    const online = io(fakeChain({ transfers: HISTORY, contracts: [POOL] }).fetch);
    await runHolderSnapshot(SNAPSHOT, online.io);
    const run = io(undefined);
    run.files.set("snap.json", online.files.get("snap.json") as string);
    expect(await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "10", "--decimals", "0", "--mode", "equal", "--offline"], run.io)).toBe(EXIT.OK);
    expect(run.out[0]?.split("\n")[0]).toBe("recipient,amount");
    expect(run.out[0]?.split("\n")).toHaveLength(6);
    expect(run.err.some((line) => line.startsWith("pool         10 (equal)"))).toBe(true);
  });

  it("exits 3 when the snapshot does not match the token, and distribute refuses the file", async () => {
    const online = io(fakeChain({ transfers: HISTORY, supplyOverride: 7n }).fetch);
    expect(await runHolderSnapshot(SNAPSHOT, online.io)).toBe(EXIT.UNVERIFIED);
    expect(online.out.some((line) => line.startsWith("verified     NO"))).toBe(true);

    const run = io(undefined);
    run.files.set("snap.json", online.files.get("snap.json") as string);
    expect(await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "1", "--decimals", "6", "--offline"], run.io)).toBe(EXIT.UNVERIFIED);
    expect(run.err.join("\n")).toContain("failed verification");
  });

  it("exits 3 on a history that does not start at creation", async () => {
    const run = io(fakeChain({ transfers: HISTORY }).fetch);
    expect(await runHolderSnapshot([...SNAPSHOT, "--from-block", "21"], run.io)).toBe(EXIT.UNVERIFIED);
    expect(run.err.join("\n")).toContain("E_INCOMPLETE_HISTORY");
  });

  it(`reads endpoints from ${ENDPOINT_VARIABLE} when --rpc is absent`, async () => {
    const run = io(fakeChain({ transfers: HISTORY }).fetch, { [ENDPOINT_VARIABLE]: "https://a.example https://b.example" });
    expect(await runHolderSnapshot(["snapshot", "--token", TOKEN, "--block", "500", "--json"], run.io)).toBe(EXIT.OK);
    expect(JSON.parse(run.out[0] ?? "").source.endpoints).toEqual(["endpoint-1", "endpoint-2"]);
  });

  it("never prints a key, whether in the host, the path, or echoed back by the provider", async () => {
    const keyed = io(fakeChain({ transfers: HISTORY }).fetch);
    await runHolderSnapshot(["snapshot", "--token", TOKEN, "--block", "500", "--json", "--rpc", "https://k3yed5ub.rpc.example/p4thkey"], keyed.io);
    expect(keyed.out.join("\n")).not.toMatch(/k3yed5ub|p4thkey/);

    for (const echoed of ["key%2Fpart123", "key/part123", "KEY/PART123"]) {
      const leaky = (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `invalid API key: ${echoed}` } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch;
      const run = io(leaky);
      expect(await runHolderSnapshot(["snapshot", "--token", TOKEN, "--block", "500", "--rpc", "https://rpc.example/key%2Fpart123"], run.io)).toBe(EXIT.FAILED);
      const printed = [...run.out, ...run.err].join("\n");
      expect(printed).not.toContain(echoed);
      expect(printed).toContain("[redacted]");
    }
  });

  it("exits 1 with usage on bad or missing options", async () => {
    for (const argv of [
      [],
      ["snapshot"],
      ["snapshot", "--token", "0x123", "--rpc", "https://r.example"],
      ["snapshot", "--token", TOKEN],
      ["snapshot", "--token", TOKEN, "--block", "9007199254740993", "--rpc", "https://r.example"],
      ["distribute", "--token", TOKEN, "--snapshot", "s.json", "--pool", "1"],
      ["distribute", "--token", TOKEN, "--snapshot", "s.json", "--pool", "1", "--decimals", "6", "--mode", "random"],
      ["snapshot", "extra", "--token", TOKEN],
      ["unknown"],
    ]) {
      const run = io(undefined);
      expect(await runHolderSnapshot(argv, run.io), argv.join(" ")).toBe(EXIT.USAGE);
    }
  });

  it("exits 1 and writes nothing when the pool is zero or everyone is excluded", async () => {
    const online = io(fakeChain({ transfers: HISTORY }).fetch);
    await runHolderSnapshot(SNAPSHOT, online.io);
    for (const extra of [["--pool", "0"], ["--pool", "10", "--min-balance", "100000"]]) {
      const run = io(undefined);
      run.files.set("snap.json", online.files.get("snap.json") as string);
      const code = await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--decimals", "6", "--offline", "--out", "p.csv", ...extra], run.io);
      expect(code).toBe(EXIT.USAGE);
      expect(run.files.has("p.csv")).toBe(false);
    }
  });

  it("exits 1 for a pool with more decimals than the payout token has", async () => {
    const online = io(fakeChain({ transfers: HISTORY }).fetch);
    await runHolderSnapshot(SNAPSHOT, online.io);
    const run = io(undefined);
    run.files.set("snap.json", online.files.get("snap.json") as string);
    expect(await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "snap.json", "--pool", "1.5", "--decimals", "0", "--offline"], run.io)).toBe(EXIT.USAGE);
  });

  it("exits 2 when the snapshot file cannot be read", async () => {
    const run = io(undefined);
    expect(await runHolderSnapshot(["distribute", "--token", TOKEN, "--snapshot", "missing.json", "--pool", "1", "--decimals", "6", "--offline"], run.io)).toBe(EXIT.FAILED);
  });

  it("prints usage and exits 0 with --help", async () => {
    const run = io(undefined);
    expect(await runHolderSnapshot(["--help"], run.io)).toBe(EXIT.OK);
    expect(run.out).toEqual([USAGE]);
  });
});
