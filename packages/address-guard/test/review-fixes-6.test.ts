/** Findings from the sixth review round on MPC-280. */
import { createRpc, redactEndpoint } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import type { Address } from "../src/hex.js";
import { secretsFromEndpoints } from "../src/redact.js";
import { defaultEndpointLabel, rpcLogSource } from "../src/sources.js";
import { fakeChain, GENUINE, IMITATOR, OWNER, TOKEN } from "./fake-chain.js";
import { mockSource, poisonedHistory } from "./fixtures.js";

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

describe("R6-F1 provenance does not echo a keyed host", () => {
  /**
   * `redactEndpoint` strips the path but keeps the host, and some providers issue keyed
   * subdomains, so `https://<key>.rpc.example` put the key into `source.endpoint` of every
   * successful --json result.
   */
  const keyed = "https://secret-key-value.rpc.example/";

  it("names endpoints by position, not by host", async () => {
    const rpc = createRpc({ urls: keyed, fetch: fakeChain({ head: 50, transfers: [] }).fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(source.endpoint).toBe("endpoint-1");
    expect(JSON.stringify(source)).not.toContain("secret-key-value");
  });

  it("keeps a keyed subdomain out of a successful JSON payload", async () => {
    const chain = fakeChain({ head: 200, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n }] });
    const context = io({ fetch: chain.fetch });
    delete (context as { source?: unknown }).source;
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", keyed, "--token", TOKEN, "--json"],
      context,
    );
    expect(code).toBe(EXIT.TRUSTED);
    expect(context.out.join("\n")).not.toContain("secret-key-value");
  });

  it("still lets a caller opt into origins", async () => {
    const rpc = createRpc({ urls: "https://rpc.example/k", fetch: fakeChain({ head: 50, transfers: [] }).fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN], endpointLabel: redactEndpoint }).fetch(OWNER);
    expect(source.endpoint).toBe("https://rpc.example");
  });

  it("exposes the default labeller", () => {
    expect(defaultEndpointLabel("https://anything.example/key", 0)).toBe("endpoint-1");
    expect(defaultEndpointLabel("https://anything.example/key", 2)).toBe("endpoint-3");
  });
});

describe("R6-F2 a short path credential is collected", () => {
  it("keeps a five-character path segment", () => {
    expect(secretsFromEndpoints(["https://rpc.example/abcde"])).toContain("abcde");
  });

  it("keeps a four-character one", () => {
    expect(secretsFromEndpoints(["https://rpc.example/ab12"])).toContain("ab12");
  });

  it("still leaves common short routing segments alone", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/v2/eth/ws"]);
    for (const routing of ["v2", "eth", "ws"]) expect(secrets).not.toContain(routing);
  });

  it("masks a short path key a provider echoes back", async () => {
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "invalid key abcde" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky });
    delete (context as { source?: unknown }).source;
    await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://rpc.example/abcde", "--token", TOKEN],
      context,
    );
    const written = [...context.out, ...context.err].join("\n");
    expect(written).not.toMatch(/invalid key abcde/);
    expect(written).toContain("[redacted]");
  });
});

describe("R6-F3 a batch peer is not described as a recipient the owner paid", () => {
  const pair = "0x7777000000000000000000000000000000007777" as Address;
  const copy = "0x7777111111111111111111111111111111117777" as Address;

  it("says the match came from the batch, not from history", () => {
    const result = assessRecipient(copy, { trusted: [], peers: [pair] });
    expect(result.verdict).toBe("lookalike");
    expect(result.evidence[0]?.knownFrom).toBe("batch");
    expect(result.reasons.join(" ")).toContain("other recipient(s) in this batch");
    expect(result.reasons.join(" ")).not.toContain("really paid");
  });

  it("says the match came from history when it did", () => {
    const result = assessRecipient(copy, { trusted: [pair] });
    expect(result.evidence[0]?.knownFrom).toBe("history");
    expect(result.reasons.join(" ")).toContain("really paid");
  });

  it("never promotes a peer match to trusted", () => {
    expect(assessRecipient(pair, { trusted: [], peers: [pair, copy] }).verdict).not.toBe("trusted");
  });

  it("does not claim a payment when trustedCount is zero", async () => {
    const context = io({
      source: () => mockSource([]),
      readFile: async () => `${pair}\n${copy}\n`,
    });
    const code = await runAddressGuard(
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"],
      context,
    );
    expect(code).toBe(EXIT.LOOKALIKE);
    const payload = JSON.parse(context.out.join("\n")) as {
      trustedCount: number;
      results: { verdict: string; reasons: string[]; evidence: { knownFrom: string }[] }[];
    };
    expect(payload.trustedCount).toBe(0);
    for (const result of payload.results) {
      expect(result.verdict).toBe("lookalike");
      expect(result.evidence[0]?.knownFrom).toBe("batch");
      // The old wording asserted a payment the history never showed.
      expect(result.reasons.join(" ")).not.toContain("really paid");
    }
  });

  it("reports both provenances when a row matches each", async () => {
    const context = io({ readFile: async () => `${IMITATOR}\n${GENUINE}\n` });
    await runAddressGuard(
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"],
      context,
    );
    const payload = JSON.parse(context.out.join("\n")) as {
      results: { evidence: { knownFrom: string }[] }[];
    };
    // IMITATOR imitates GENUINE, which is both in the history and in the file.
    expect(payload.results[0]?.evidence.some((e) => e.knownFrom === "history")).toBe(true);
  });
});

describe("R6-F4 truncation is measured against the evidence reported", () => {
  /**
   * The input list also held the row's own address when it was historically trusted, while the
   * peer count excluded it, so a trusted row with exactly one peer over the cap reported neither
   * imitatesTotal nor evidenceTruncated.
   */
  it("reports truncation for a trusted row whose bucket overflows", async () => {
    const window = (i: number) => `0xabcd${i.toString(16).padStart(32, "0")}abcd` as Address;
    const trustedRow = window(0);
    const rows = Array.from({ length: 12 }, (_, i) => window(i));
    const context = io({
      // The first row is a recipient the owner really paid.
      source: () => mockSource(poisonedHistory.map((e) => (e.direction === "out" && e.valueRaw > 0n ? { ...e, counterparty: trustedRow, txTransferTo: trustedRow } : e))),
      readFile: async () => rows.join("\n"),
    });
    await runAddressGuard(
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"],
      context,
    );
    const payload = JSON.parse(context.out.join("\n")) as {
      results: { verdict: string; evidence: unknown[]; imitatesTotal?: number; evidenceTruncated?: boolean }[];
    };
    const first = payload.results[0];
    expect(first?.verdict).toBe("trusted");
    expect(first?.evidenceTruncated).toBe(true);
    expect(first?.imitatesTotal).toBe(11);
  });
});

describe("R6-F5 indexerThenRpc takes no dead option", () => {
  it("accepts exactly two arguments", async () => {
    const { indexerThenRpc } = await import("../src/sources.js");
    expect(indexerThenRpc.length).toBe(2);
  });

  it("no longer exports the discarded options type", async () => {
    const module = (await import("../src/index.js")) as Record<string, unknown>;
    expect("IndexerThenRpcOptions" in module).toBe(false);
  });
});
