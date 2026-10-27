/**
 * One test per finding from the second review round on MPC-280. Each asserts the corrected
 * behaviour and fails if the original defect returns.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import { toChecksum } from "../src/checksum.js";
import type { Address } from "../src/hex.js";
import type { History, HistorySource } from "../src/history.js";
import { redactSecrets, secretsFromEndpoints } from "../src/redact.js";
import { indexerThenRpc, rpcLogSource } from "../src/sources.js";
import { fakeChain, GENUINE, IMITATOR, OWNER, TOKEN } from "./fake-chain.js";
import { genuineSend, mockSource, poisonedHistory } from "./fixtures.js";

function io(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: {},
    source: () => mockSource(poisonedHistory),
    ...over,
  };
}

/** An indexer that claims a range and returns whatever it is given. */
/**
 * An indexer that states the range it has actually indexed. Only a source that can do this is
 * ever preferred over RPC; `coverage` is what `indexerThenRpc` checks, never the echoed query.
 */
function indexer(fromBlock: number, toBlock: number, events: History["events"]): HistorySource {
  return {
    fetch: async (_owner, range): Promise<History> => ({
      events,
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        // The query range is echoed, as any source does...
        fromBlock: range?.fromBlock ?? 0,
        toBlock: range?.toBlock ?? 0,
        // ...while coverage is the independent claim about what has been indexed.
        coverage: { fromBlock, toBlock },
      },
    }),
  };
}

/** An indexer that answers but states no coverage: never preferred, however many events it has. */
function indexerWithoutCoverage(events: History["events"]): HistorySource {
  return {
    fetch: async (_owner, range): Promise<History> => ({
      events,
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        fromBlock: range?.fromBlock ?? 0,
        toBlock: range?.toBlock ?? 0,
      },
    }),
  };
}

const rpcSource: HistorySource = {
  fetch: async (): Promise<History> => ({
    events: [genuineSend()],
    source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 1_000 },
  }),
};

describe("R2-F1 an unverifiable indexer answer is refused, which is the CLI default path", () => {
  /**
   * The previous round's coverage check only ran when a range was passed, and the CLI passed none
   * unless --from-block was given. A lagging index holding one recent dust transfer was therefore
   * accepted by default, leaving the trusted set empty and reporting the look-alike as "new".
   */
  it("refuses an indexer answer when no range can be measured", async () => {
    const { source } = await indexerThenRpc(indexer(0, 1_000, [genuineSend()]), rpcSource).fetch(OWNER);
    expect(source.kind).toBe("rpc");
  });

  it("refuses an index that claims the range but returns nothing", async () => {
    const { source } = await indexerThenRpc(indexer(0, 100, []), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 100 });
    expect(source.kind).toBe("rpc");
  });

  /**
   * The defect this round found: rpcLogSource filled fromBlock/toBlock from the query, so
   * comparing them against the query always passed. Coverage must be stated independently.
   */
  it("refuses an answer that states no coverage, however many events it carries", async () => {
    const { source } = await indexerThenRpc(indexerWithoutCoverage([genuineSend()]), rpcSource).fetch(OWNER, {
      fromBlock: 0,
      toBlock: 100,
    });
    expect(source.kind).toBe("rpc");
  });

  it("accepts an index that covers the range and has events", async () => {
    const { source } = await indexerThenRpc(indexer(0, 100, [genuineSend()]), rpcSource).fetch(OWNER, {
      fromBlock: 0,
      toBlock: 100,
    });
    expect(source.kind).toBe("indexer");
  });
});

describe("R2-F2 both requested bounds reach the coverage check", () => {
  /**
   * --to-block went into each source's configuration but not the fetch range, so an index
   * stopping before the requested end block could not be detected.
   */
  it("falls back when the index stops before --to-block", async () => {
    const { source } = await indexerThenRpc(indexer(0, 60, [genuineSend()]), rpcSource).fetch(OWNER, {
      fromBlock: 0,
      toBlock: 100,
    });
    expect(source.kind).toBe("rpc");
  });

  it("rejects --indexer outright, since no JSON-RPC endpoint can prove coverage", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", IMITATOR, "--owner", OWNER, "--rpc", "https://rpc.example", "--token", TOKEN, "--indexer", "https://indexer.example",
       "--from-block", "0", "--to-block", "500"],
      context,
    );
    expect(code).toBe(EXIT.USAGE);
  });
});

describe("R2-F3 a provider's error text cannot carry a credential to stderr", () => {
  it("extracts the secret-bearing parts of an endpoint URL, never the origin", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/v2/super-secret-key?apikey=another-secret"]);
    expect(secrets).toContain("super-secret-key");
    expect(secrets).toContain("another-secret");
    expect(secrets).not.toContain("rpc.example");
    // Short path fragments are ignored, or every message would be scrubbed to noise.
    expect(secrets).not.toContain("v2");
  });

  it("masks every occurrence, whatever the casing", () => {
    const text = redactSecrets("invalid API key: Super-Secret-Key (Super-Secret-Key)", ["Super-Secret-Key"]);
    expect(text).toBe("invalid API key: [redacted] ([redacted])");
  });

  /**
   * The walker's sanitizeProviderText strips control characters and caps length; it does not
   * remove secrets. A provider echoing the key back would otherwise put it in a CI log.
   */
  it("does not print a key the provider echoed back", async () => {
    const key = "super-secret-key-value";
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `invalid API key: ${key}` } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky, source: undefined as never });
    delete (context as { source?: unknown }).source;
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", `https://rpc.example/${key}`, "--token", TOKEN],
      context,
    );
    expect(code).toBe(EXIT.FAILED);
    const written = [...context.out, ...context.err].join("\n");
    expect(written).not.toContain(key);
    expect(written).toContain("[redacted]");
    // The origin is still named, so the message remains diagnosable.
    expect(written).toContain("rpc.example");
  });
});

describe("R2-F4 block bounds beyond the safe integer range are refused", () => {
  it("rejects a value Number() would round", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--from-block", "9007199254740993"],
      context,
    );
    expect(code).toBe(EXIT.USAGE);
    expect(context.err.join(" ")).toContain("MAX_SAFE_INTEGER");
  });

  it("still accepts the largest safe value", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--from-block", String(Number.MAX_SAFE_INTEGER)],
      context,
    );
    expect(code).not.toBe(EXIT.USAGE);
  });
});

describe("R2-F5 scan reports every inbound transfer from a look-alike sender", () => {
  it("names the dust as well as the earlier ordinary transfer", async () => {
    const events = [
      genuineSend(),
      { ...genuineSend(IMITATOR), direction: "in" as const, valueRaw: 100n, txFrom: IMITATOR, blockNumber: 10n },
      { ...genuineSend(IMITATOR), direction: "in" as const, valueRaw: 0n, txFrom: IMITATOR, blockNumber: 20n },
    ];
    const context = io({ source: () => mockSource(events) });
    const code = await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"], context);
    expect(code).toBe(EXIT.LOOKALIKE);
    const payload = JSON.parse(context.out.join("\n")) as {
      findings: { transfers: { valueRaw: string; blockNumber: string }[] }[];
    };
    expect(payload.findings[0]?.transfers).toHaveLength(2);
    // Smallest first, so the dust leads.
    expect(payload.findings[0]?.transfers[0]?.valueRaw).toBe("0");
    expect(payload.findings[0]?.transfers.map((t) => t.blockNumber)).toEqual(["20", "10"]);
  });
});

describe("R2-F6 a history larger than the cap fails with a message, not an OOM", () => {
  it("names the fix when too many transfers match", async () => {
    const transfers = Array.from({ length: 30 }, (_, i) => ({
      blockNumber: i + 1,
      from: OWNER,
      to: GENUINE,
      valueRaw: 1n,
    }));
    const rpc = createRpc({ urls: "https://r.example", fetch: fakeChain({ head: 100, transfers }).fetch });
    await expect(rpcLogSource(rpc, { tokens: [TOKEN], maxEvents: 10 }).fetch(OWNER)).rejects.toMatchObject({
      code: "E_TOO_MANY_EVENTS",
    });
  });

  it("stays within the cap for an ordinary history", async () => {
    const rpc = createRpc({
      urls: "https://r.example",
      fetch: fakeChain({ head: 100, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }] }).fetch,
    });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN], maxEvents: 10 }).fetch(OWNER);
    expect(events).toHaveLength(1);
  });
});

describe("R2-F7 payouts scale linearly and keep the same verdicts", () => {
  /** Bucketing is exact, not an approximation: the verdicts must be identical to before. */
  it("gives the same verdicts as an unbucketed comparison would", async () => {
    const pair = "0x7777000000000000000000000000000000007777" as Address;
    const copy = "0x7777111111111111111111111111111111117777" as Address;
    const context = io({
      readFile: async () => [toChecksum(GENUINE), toChecksum(IMITATOR), pair, copy, "nonsense"].join("\n"),
    });
    const code = await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"], context);
    expect(code).toBe(EXIT.INVALID);
    const payload = JSON.parse(context.out.join("\n")) as { results: { line: number; verdict: string }[] };
    expect(payload.results.map((r) => r.verdict)).toEqual([
      "trusted",   // GENUINE is in the history
      "lookalike", // imitates GENUINE
      "lookalike", // imitates copy, its own row excluded
      "lookalike", // imitates pair
      "invalid",
    ]);
  });

  it("handles a large file without quadratic blow-up", async () => {
    // 4 000 distinct recipients in distinct buckets, plus one imitator of row 0.
    const rows: string[] = [];
    for (let i = 0; i < 4_000; i++) {
      rows.push(`0x${i.toString(16).padStart(4, "0")}${"0".repeat(32)}${i.toString(16).padStart(4, "0")}`);
    }
    rows.push(`0x${(0).toString(16).padStart(4, "0")}${"1".repeat(32)}${(0).toString(16).padStart(4, "0")}`);
    const context = io({ readFile: async () => rows.join("\n") });
    const started = Date.now();
    const code = await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    expect(code).toBe(EXIT.LOOKALIKE);
    // Generous: the point is that it is not quadratic, not a precise budget.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
