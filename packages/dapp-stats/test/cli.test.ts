import type { Hex } from "@globalmpc/evm-log-walker";
import { describe, expect, it, vi } from "vitest";
import { ENDPOINT_VARIABLE, NETWORKS, runDappStats, USAGE } from "../src/cli/dapp-stats.js";
import { ZERO_ADDRESS } from "../src/hex.js";
import { createFakeChain, DEFAULT_ADDRESS } from "./fake-chain.js";

const W1: Hex = "0x1111111111111111111111111111111111111111";
const HASH: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111".slice(0, 66) as Hex;

function scenario() {
  return createFakeChain({
    head: 10,
    transfers: [{ blockNumber: 10, transactionHash: HASH, logIndex: 0, from: ZERO_ADDRESS, to: W1, value: 100n }],
    transactions: new Map([[HASH, { from: W1, blockNumber: 10, gasPrice: 1n }]]),
  });
}

function io(fetchImpl: typeof globalThis.fetch, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const mkdir = vi.fn(async (path: unknown) => {
    dirs.push(String(path));
    return undefined;
  }) as unknown as typeof import("node:fs/promises").mkdir;
  const writeFile = vi.fn(async (path: unknown, data: unknown) => {
    files.set(String(path), String(data));
  }) as unknown as typeof import("node:fs/promises").writeFile;
  const open = vi.fn(async (_path: string) => undefined);
  return {
    out,
    err,
    files,
    dirs,
    open,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      fetch: fetchImpl,
      env,
      mkdir,
      writeFile,
      open,
      now: () => Date.parse("2026-09-26T00:00:00Z"),
    },
  };
}

describe("dapp-stats CLI", () => {
  it("writes a dated JSON report and an index.html into --out, and prints a summary", async () => {
    const chain = scenario();
    const { out, err, files, io: streams } = io(chain.fetch);

    const code = await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0"], streams);

    expect(err).toEqual([]);
    expect(code).toBe(0);
    const jsonPath = [...files.keys()].find((path) => path.endsWith(".json"));
    expect(jsonPath).toBeDefined();
    const written = JSON.parse(files.get(jsonPath as string) as string);
    expect(written.contract.address).toBe(DEFAULT_ADDRESS);
    expect(written.days.at(-1).transactions).toBe(1);
    const htmlPath = [...files.keys()].find((path) => path.endsWith("index.html"));
    expect(files.get(htmlPath as string)).toContain("<!doctype html>");
    expect(out.some((line) => line.startsWith("address"))).toBe(true);
  });

  it("publishes holders for an explicit --from only with --from-is-creation", async () => {
    const withFlag = io(scenario().fetch);
    await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0", "--from-is-creation", "--json"], withFlag.io);
    expect(JSON.parse(withFlag.out[0] ?? "").days.at(-1).holders).toBe(1);

    const withoutFlag = io(scenario().fetch);
    await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0", "--json"], withoutFlag.io);
    expect(JSON.parse(withoutFlag.out[0] ?? "").days.at(-1).holders).toBeNull();
  });

  it("names every configured endpoint as the source, by origin only, since any of them may have answered", async () => {
    const { out, io: streams } = io(scenario().fetch);
    const code = await runDappStats(
      [DEFAULT_ADDRESS, "--rpc", "https://a.example/KEY-ONE", "--rpc", "https://b.example/KEY-TWO", "--out", "/tmp/out", "--from", "0", "--json"],
      streams,
    );
    expect(code).toBe(0);
    expect(out[0]).not.toMatch(/KEY-ONE|KEY-TWO/);
    expect(JSON.parse(out[0] ?? "").days[0].source.rpc).toBe("https://a.example, https://b.example");
  });

  it("exits 1 when --from-is-creation is given without --from", async () => {
    const { err, io: streams } = io(scenario().fetch);
    const code = await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from-is-creation"], streams);
    expect(code).toBe(1);
    expect(err[0]).toContain("--from-is-creation needs --from");
  });

  it("prints the report as JSON with --json", async () => {
    const chain = scenario();
    const { out, io: streams } = io(chain.fetch);

    const code = await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0", "--json"], streams);

    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ package: "@globalmpc/dapp-stats" });
  });

  it("exits 1 with usage on a missing --out or a bad address", async () => {
    const chain = scenario();
    for (const argv of [[DEFAULT_ADDRESS, "--rpc", "http://a"], ["0x1234", "--rpc", "http://a", "--out", "/tmp/out"]]) {
      const { err, io: streams } = io(chain.fetch);
      expect(await runDappStats(argv, streams)).toBe(1);
      expect(err.at(-1)).toBe(USAGE);
    }
  });

  it(`reads endpoints from ${ENDPOINT_VARIABLE} when --rpc is absent`, async () => {
    const chain = scenario();
    const { out, io: streams } = io(chain.fetch, { [ENDPOINT_VARIABLE]: "http://a" });

    const code = await runDappStats([DEFAULT_ADDRESS, "--out", "/tmp/out", "--from", "0", "--json"], streams);

    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ package: "@globalmpc/dapp-stats" });
  });

  it("falls back to the default network's public endpoints and warns about it when neither --rpc nor the variable is given", async () => {
    const chain = scenario();
    const { out, err, io: streams } = io(chain.fetch);

    const code = await runDappStats([DEFAULT_ADDRESS, "--out", "/tmp/out", "--from", "0", "--json"], streams);

    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ package: "@globalmpc/dapp-stats" });
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('public "bsc" endpoint(s)');
    for (const url of NETWORKS["bsc"]?.mainnet ?? []) expect(err[0]).toContain(url);
  });

  it("switches network and mainnet/testnet with --network and --testnet", async () => {
    const chain = scenario();
    const { err, io: streams } = io(chain.fetch);

    const code = await runDappStats([DEFAULT_ADDRESS, "--network", "polygon", "--testnet", "--out", "/tmp/out", "--from", "0", "--json"], streams);

    expect(code).toBe(0);
    expect(err[0]).toContain('public "polygon testnet" endpoint(s)');
    for (const url of NETWORKS["polygon"]?.testnet ?? []) expect(err[0]).toContain(url);
  });

  it("rejects an unknown --network with usage", async () => {
    const { err, io: streams } = io(scenario().fetch);

    expect(await runDappStats([DEFAULT_ADDRESS, "--network", "nope", "--out", "/tmp/out"], streams)).toBe(1);
    expect(err[0]).toMatch(/--network must be one of:/);
    expect(err.at(-1)).toBe(USAGE);
  });

  it("prefers --rpc, then the variable, over --network's default", async () => {
    const chain = scenario();
    const withFlag = io(chain.fetch, { [ENDPOINT_VARIABLE]: "http://from-env" });
    expect(await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0"], withFlag.io)).toBe(0);
    expect(withFlag.err).toEqual([]);

    const withEnv = io(chain.fetch, { [ENDPOINT_VARIABLE]: "http://a" });
    expect(await runDappStats([DEFAULT_ADDRESS, "--out", "/tmp/out", "--from", "0"], withEnv.io)).toBe(0);
    expect(withEnv.err).toEqual([]);
  });

  it("opens the written index.html when --open is given, and not otherwise", async () => {
    const chain = scenario();
    const { open, io: streams } = io(chain.fetch);
    await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0"], streams);
    expect(open).not.toHaveBeenCalled();

    const withOpen = io(chain.fetch);
    const code = await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0", "--open"], withOpen.io);
    expect(code).toBe(0);
    expect(withOpen.open).toHaveBeenCalledTimes(1);
    expect(withOpen.open.mock.calls[0]?.[0]).toMatch(/index\.html$/);
  });

  it("does not fail the command when --open can't actually open a browser", async () => {
    const chain = scenario();
    const { err, io: streams } = io(chain.fetch);
    streams.open = vi.fn(async () => {
      throw new Error("no display");
    });

    const code = await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0", "--open"], streams);

    expect(code).toBe(0);
    expect(err[0]).toMatch(/could not open a browser automatically \(no display\)/);
  });

  it("switches page theme with --theme, and rejects an unknown one", async () => {
    const chain = scenario();
    const { files, io: streams } = io(chain.fetch);
    expect(await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--from", "0", "--theme", "dark"], streams)).toBe(0);
    const html = [...files.entries()].find(([path]) => path.endsWith("index.html"))?.[1];
    expect(html).toContain("--bg: #04070f;");

    const { err, io: bad } = io(chain.fetch);
    expect(await runDappStats([DEFAULT_ADDRESS, "--rpc", "http://a", "--out", "/tmp/out", "--theme", "neon"], bad)).toBe(1);
    expect(err[0]).toMatch(/--theme must be one of:/);
  });

  it("prints usage and exits 0 with --help", async () => {
    const { out, io: streams } = io(scenario().fetch);

    expect(await runDappStats(["--help"], streams)).toBe(0);
    expect(out).toEqual([USAGE]);
  });
});
