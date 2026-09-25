import { describe, expect, it } from "vitest";
import { ENDPOINT_VARIABLE, runCreationBlock, USAGE } from "../src/cli/creation-block.js";
import { createFakeChain, DEFAULT_ADDRESS } from "./fake-chain.js";

function io(fetchImpl: typeof globalThis.fetch, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line), fetch: fetchImpl, env } };
}

describe("creation-block CLI", () => {
  it("prints the result as text", async () => {
    const chain = createFakeChain({ head: 1_000_000, codeFrom: { [DEFAULT_ADDRESS]: 777_777 } });
    const { out, err, io: streams } = io(chain.fetch);

    const code = await runCreationBlock([DEFAULT_ADDRESS, "--rpc", "http://a"], streams);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`address   ${DEFAULT_ADDRESS}`);
    expect(out[1]).toBe("creation  777777");
    expect(out[2]).toBe("verified  no (no deployment receipt in that block; see README)");
    expect(out[3]).toMatch(/^probes {4}\d+$/);
  });

  it("prints JSON with --json and honours --from and --to", async () => {
    const chain = createFakeChain({ head: 1_000_000, codeFrom: { [DEFAULT_ADDRESS]: 777_777 } });
    const { out, io: streams } = io(chain.fetch);

    const code = await runCreationBlock([DEFAULT_ADDRESS, "--rpc", "http://a", "--from", "777000", "--to", "778000", "--json"], streams);

    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ address: DEFAULT_ADDRESS, blockNumber: 777_777, verification: "unconfirmed" });
  });

  it("exits 1 with usage on a missing endpoint, a bad address or an unknown flag", async () => {
    const chain = createFakeChain();
    for (const argv of [[DEFAULT_ADDRESS], ["0x1234", "--rpc", "http://a"], [DEFAULT_ADDRESS, "--rpc", "http://a", "--nope"]]) {
      const { err, io: streams } = io(chain.fetch);
      expect(await runCreationBlock(argv, streams)).toBe(1);
      expect(err.at(-1)).toBe(USAGE);
    }
    expect(chain.calls).toHaveLength(0);
  });

  it("exits 1 with usage on an endpoint that is not a URL, without echoing it", async () => {
    const chain = createFakeChain();
    const { err, io: streams } = io(chain.fetch);

    expect(await runCreationBlock([DEFAULT_ADDRESS, "--rpc", "archive.example/v1/topsecret"], streams)).toBe(1);

    expect(err[0]).toBe("endpoint 1 of 1 is not an http(s) URL (include the scheme, for example https://)");
    expect(err.join("\n")).not.toContain("topsecret");
    expect(err.at(-1)).toBe(USAGE);
    expect(chain.calls).toHaveLength(0);
  });

  it(`reads endpoints from ${ENDPOINT_VARIABLE} when --rpc is absent, and validates them the same way`, async () => {
    // Retry-After: 0 keeps the failover free of backoff sleeps.
    const chain = createFakeChain({ head: 1_000_000, codeFrom: { [DEFAULT_ADDRESS]: 777_777 }, rateLimits: { "http://keyed?chains=bsc,opbnb": { times: 99, retryAfter: "0" } } });
    const { out, io: streams } = io(chain.fetch, { [ENDPOINT_VARIABLE]: "http://keyed?chains=bsc,opbnb   http://a" });

    expect(await runCreationBlock([DEFAULT_ADDRESS, "--json"], streams)).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ blockNumber: 777_777 });
    expect(new Set(chain.calls.map((call) => call.url))).toEqual(new Set(["http://keyed?chains=bsc,opbnb", "http://a"]));

    const bad = io(chain.fetch, { [ENDPOINT_VARIABLE]: "http://a nope" });
    expect(await runCreationBlock([DEFAULT_ADDRESS], bad.io)).toBe(1);
    expect(bad.err[0]).toBe("endpoint 2 of 2 is not an http(s) URL (include the scheme, for example https://)");
    expect(bad.err.at(-1)).toBe(USAGE);

    const none = io(chain.fetch, { [ENDPOINT_VARIABLE]: "   " });
    expect(await runCreationBlock([DEFAULT_ADDRESS], none.io)).toBe(1);
    expect(none.err[0]).toBe(`missing --rpc <url> (or ${ENDPOINT_VARIABLE})`);
  });

  it("prefers --rpc over the variable when both are given", async () => {
    const chain = createFakeChain({ head: 1_000_000, codeFrom: { [DEFAULT_ADDRESS]: 777_777 } });
    const { io: streams } = io(chain.fetch, { [ENDPOINT_VARIABLE]: "http://from-env" });

    expect(await runCreationBlock([DEFAULT_ADDRESS, "--rpc", "http://a"], streams)).toBe(0);
    expect(chain.calls.every((call) => call.url === "http://a")).toBe(true);
  });

  it("prints usage and exits 0 with --help", async () => {
    const { out, io: streams } = io(createFakeChain().fetch);

    expect(await runCreationBlock(["--help"], streams)).toBe(0);
    expect(out).toEqual([USAGE]);
  });

  it("exits 2 with the error code when the lookup fails", async () => {
    const chain = createFakeChain({ head: 1_000_000, archive: false, codeFrom: { [DEFAULT_ADDRESS]: 777_777 } });
    const { err, io: streams } = io(chain.fetch);

    expect(await runCreationBlock([DEFAULT_ADDRESS, "--rpc", "http://a"], streams)).toBe(2);
    expect(err[0]).toMatch(/^E_NO_ARCHIVE_STATE: /);
  });
});
