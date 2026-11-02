import { describe, expect, it } from "vitest";
import { ENDPOINT_VARIABLE, EXIT, runHotWalletWatch } from "../src/cli/hot-wallet-watch.js";
import { configFromJson, WatchError } from "../src/index.js";
import { delegationCode, FakeEndpoint, HOT, SWEEPER, TOKEN } from "./fake-chain.js";

/** One fake endpoint per host, so `--rpc https://a.example --rpc https://b.example` reach different chains. */
function network(endpoints: Record<string, FakeEndpoint>): typeof globalThis.fetch {
  return async (input, init) => {
    const host = new URL(String(input)).hostname.split(".")[0] ?? "";
    const endpoint = endpoints[host];
    if (endpoint === undefined) throw new TypeError("fetch failed");
    return endpoint.fetch(input, init);
  };
}

async function run(argv: string[], options: { endpoints?: Record<string, FakeEndpoint>; files?: Record<string, string>; env?: Record<string, string>; signal?: AbortSignal } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHotWalletWatch(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: options.env ?? {},
    fetch: network(options.endpoints ?? {}),
    readFile: async (path) => {
      const text = options.files?.[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    ...(options.signal === undefined ? {} : { watchSignal: () => options.signal as AbortSignal }),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const clean = () => ({ a: new FakeEndpoint().set(HOT, { balance: 5n }), b: new FakeEndpoint().set(HOT, { balance: 5n }) });

describe("hot-wallet-watch check", () => {
  it("exits 0 with a summary when nothing is wrong", async () => {
    const result = await run(["check", "--rpc", "https://a.example", "--rpc", "https://b.example", "--wallet", `${HOT}=relayer=bsc`], { endpoints: clean() });
    expect(result.code).toBe(EXIT.CLEAN);
    expect(result.out.split("\n")).toEqual(["block 1000, read from endpoint-1, endpoint-2", "relayer=bsc: no code, nonce 0, balance 5 wei", "no alerts"]);
  });

  it("exits 20 on a hostile delegation and 0 when the delegate is allowed", async () => {
    const endpoints = clean();
    endpoints.a.set(HOT, { code: delegationCode(SWEEPER) });
    endpoints.b.set(HOT, { code: delegationCode(SWEEPER) });
    const args = ["check", "--rpc", "https://a.example", "--rpc", "https://b.example", "--wallet", HOT];
    const hostile = await run(args, { endpoints });
    expect(hostile.code).toBe(EXIT.CRITICAL);
    expect(hostile.out).toContain("CRITICAL delegated");
    expect((await run([...args, "--allow-delegate", SWEEPER], { endpoints })).code).toBe(EXIT.CLEAN);
  });

  it("exits 10 on warnings only, and 2 when no endpoint answers", async () => {
    const endpoints = clean();
    expect((await run(["check", "--rpc", "https://a.example", "--rpc", "https://down.example", "--wallet", HOT], { endpoints })).code).toBe(EXIT.WARNING);
    expect((await run(["check", "--rpc", "https://down.example", "--wallet", HOT], { endpoints })).code).toBe(EXIT.UNREACHABLE);
  });

  it("leaves out an endpoint on another chain than --chain-id", async () => {
    const endpoints = clean();
    const result = await run(["check", "--rpc", "https://a.example", "--wallet", HOT, "--chain-id", "97"], { endpoints });
    expect(result.code).toBe(EXIT.UNREACHABLE);
    expect(result.out).toContain("is on chain 56, not 97");
  });

  it("reads endpoints from the environment and never prints them", async () => {
    const result = await run(["check", "--wallet", HOT, "--json"], { endpoints: clean(), env: { [ENDPOINT_VARIABLE]: "https://a.example/v1/SECRETKEY https://b.example" } });
    expect(result.code).toBe(EXIT.CLEAN);
    expect(result.out).not.toContain("SECRETKEY");
    expect(result.out).not.toContain("a.example");
    expect(JSON.parse(result.out)).toMatchObject({ block: 1_000, alerts: [] });
  });

  it("never echoes a stray argument, which is often a keyed URL", async () => {
    const result = await run(["check", "--rpc", "https://a.example", "--wallet", HOT, "https://b.example/v1/SECRETKEY"], { endpoints: clean() });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.err).not.toContain("SECRETKEY");
  });

  it.each([
    [["check"], "check needs at least one --wallet"],
    [["check", "--wallet", HOT], "give at least one endpoint"],
    [["check", "--rpc", "ftp://a.example", "--wallet", HOT], "endpoint-1 is not an http(s) URL"],
    [["check", "--rpc", "https://a.example", "--wallet", "0x12"], "--wallet needs a 0x-prefixed"],
    [["check", "--rpc", "https://a.example", "--wallet", HOT, "--allow-delegate", "nope"], "--allow-delegate needs"],
    [["check", "--config", "c.json"], "--config is for watch"],
    [["watch"], "watch needs --config"],
    [["watch", "--config", "c.json", "--wallet", HOT], "watch reads its wallets from --config"],
    [["scan"], 'unknown command "scan"'],
    [["https://a.example/v1/SECRETKEY", "check"], "unknown command; expected check or watch"],
    [["check", "--rpc", "https://a.example", "--wallet", HOT, "--chain-id", "0"], "--chain-id must be a positive whole number"],
    [[], "missing command"],
    [["check", "https://a.example/v1/SECRETKEY"], "unexpected extra argument"],
    [["check", "--rpc", "https://", "--wallet", HOT], "endpoint-1 is not a valid URL"],
  ])("usage error: %j", async (argv, message) => {
    const result = await run(argv, { endpoints: clean() });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.err).toContain(message);
  });

  it("prints usage on --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(EXIT.CLEAN);
    expect(result.out).toContain("Usage: hot-wallet-watch");
  });
});

describe("hot-wallet-watch watch", () => {
  it("prints each new alert as one JSON line until stopped", async () => {
    const endpoints = clean();
    endpoints.a.set(HOT, { code: delegationCode(SWEEPER) });
    const config = JSON.stringify({ rpc: ["https://a.example"], wallets: [{ address: HOT, label: "relayer" }], intervalMs: 1 });
    const stop = new AbortController();
    const pending = run(["watch", "--config", "c.json"], { endpoints, files: { "c.json": config }, signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    const result = await pending;
    expect(result.code).toBe(EXIT.CLEAN);
    const lines = result.out.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ kind: "delegated", wallet: { label: "relayer" }, detail: { delegate: SWEEPER } });
  });

  it("takes endpoints from the variable over the config file", async () => {
    const endpoints = { a: new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) }), b: new FakeEndpoint() };
    const config = JSON.stringify({ rpc: ["https://b.example"], wallets: [{ address: HOT }], intervalMs: 1 });
    const stop = new AbortController();
    const pending = run(["watch", "--config", "c.json"], { endpoints, files: { "c.json": config }, env: { [ENDPOINT_VARIABLE]: "https://a.example" }, signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    const result = await pending;
    expect(result.out).toContain('"delegated"');
    expect(endpoints.b.calls).toBe(0);
  });

  it("exits 1 on an invalid or missing config, without echoing its text", async () => {
    const leaky = await run(["watch", "--config", "c.json"], { files: { "c.json": '{"rpc":["https://a.example/v1/SECRETKEY123456",]}' } });
    expect(leaky.code).toBe(EXIT.USAGE);
    expect(leaky.err).not.toContain("SECRET");
    const missing = await run(["watch", "--config", "https://a.example/v1/SECRETKEY"]);
    expect(missing.code).toBe(EXIT.USAGE);
    expect(missing.err).not.toContain("SECRETKEY");
  });
});

describe("configFromJson", () => {
  it("reads outflow caps as decimal strings", () => {
    const config = configFromJson(
      JSON.stringify({ rpc: ["https://a.example"], wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: "1000" }, tokens: [{ token: TOKEN, outflow: { durationMs: 60_000, max: "5" } }] }] }),
    );
    expect(config.wallets[0]?.outflow?.max).toBe(1_000n);
    expect(config.wallets[0]?.tokens?.[0]?.outflow.max).toBe(5n);
  });

  it.each([
    [{ wallets: [{ address: HOT, outflow: { durationMs: 1, max: 5 } }] }, "decimal string"],
    [{ wallets: [{ address: HOT, expectedNonce: 3 }] }, "cannot be set from JSON"],
    [{ wallets: "x" }, "config.wallets must be a list"],
    [{ wallets: [], rpc: [1] }, "config.rpc must be a list of URLs"],
    [{ wallets: [], intervalMs: "1" }, "config.intervalMs must be a number"],
    [{ wallets: [], extra: 1 }, 'unknown key "extra"'],
  ])("refuses %j", (config, message) => {
    expect(() => configFromJson(JSON.stringify(config))).toThrow(WatchError);
    expect(() => configFromJson(JSON.stringify(config))).toThrow(message);
  });
});
