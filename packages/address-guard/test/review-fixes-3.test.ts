/**
 * Findings from the third review round on MPC-280. The first is the same vulnerability class as
 * rounds one and two, reached through the fact that a source cannot vouch for its own coverage by
 * echoing the range it was queried for.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import { toChecksum } from "../src/checksum.js";
import type { Address } from "../src/hex.js";
import type { History, HistorySource } from "../src/history.js";
import { secretsFromEndpoints } from "../src/redact.js";
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

describe("R3-F1 coverage must be stated independently, not echoed from the query", () => {
  /**
   * rpcLogSource fills SourceInfo.fromBlock/toBlock from the requested bounds. Comparing those
   * against the request is a tautology, so labelling such a source "indexer" made the round-two
   * completeness check pass unconditionally on the CLI's own path.
   */
  it("rpcLogSource never claims coverage", async () => {
    const chain = fakeChain({ head: 200, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }] });
    const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("rpc");
    expect(source.coverage).toBeUndefined();
    // The echoed query range is still reported, for provenance -- it is just not a coverage claim.
    expect(source).toMatchObject({ fromBlock: 0, toBlock: 200 });
  });

  it("refuses an rpcLogSource standing in as the indexer, even with events", async () => {
    const indexerChain = fakeChain({
      head: 200,
      // Has the recent dust, missing the older genuine send: exactly the dangerous index.
      transfers: [{ blockNumber: 100, from: IMITATOR, to: OWNER, valueRaw: 1n, txFrom: IMITATOR }],
    });
    const rpcChain = fakeChain({
      head: 200,
      transfers: [
        { blockNumber: 50, from: OWNER, to: GENUINE, valueRaw: 1_000n },
        { blockNumber: 100, from: IMITATOR, to: OWNER, valueRaw: 1n, txFrom: IMITATOR },
      ],
    });
    const asIndexer = rpcLogSource(createRpc({ urls: "https://i.example", fetch: indexerChain.fetch }), {
      tokens: [TOKEN],
    });
    const asRpc = rpcLogSource(createRpc({ urls: "https://r.example", fetch: rpcChain.fetch }), { tokens: [TOKEN] });

    const { events, source } = await indexerThenRpc(asIndexer, asRpc).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    // Falls through to RPC, so the genuine send is present and the imitator is catchable.
    expect(source.kind).toBe("rpc");
    expect(events.some((e) => e.direction === "out" && e.counterparty === GENUINE)).toBe(true);
  });

  it("the CLI has no --indexer flag to wire such a source through", async () => {
    const context = io();
    expect(
      await runAddressGuard(
        ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--indexer", "https://i.example"],
        context,
      ),
    ).toBe(EXIT.USAGE);
  });

  it("still prefers a source that does state sufficient coverage", async () => {
    const withCoverage: HistorySource = {
      fetch: async (_owner, range): Promise<History> => ({
        events: [genuineSend()],
        source: {
          kind: "indexer",
          endpoint: "https://i.example",
          endpoints: ["https://i.example"],
          fromBlock: range?.fromBlock ?? 0,
          toBlock: range?.toBlock ?? 0,
          coverage: { fromBlock: 0, toBlock: 200 },
        },
      }),
    };
    const rpcOnly: HistorySource = {
      fetch: async (): Promise<History> => ({
        events: [],
        source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 200 },
      }),
    };
    const { source } = await indexerThenRpc(withCoverage, rpcOnly).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("indexer");
  });
});

describe("R3-F2 a percent-encoded credential is masked in both spellings", () => {
  it("collects the decoded form as well as the encoded one", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/key%2Fpart123"]);
    expect(secrets).toContain("key%2Fpart123");
    expect(secrets).toContain("key/part123");
  });

  it("collects the encoded form when the URL carries the decoded one", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/?token=abc+def-ghi"]);
    expect(secrets.some((entry) => entry.includes("abc"))).toBe(true);
  });

  /** A provider echoing the decoded key must not put it in a log. */
  it("does not print a decoded credential the provider echoed back", async () => {
    const encoded = "key%2Fpart123456";
    const decoded = "key/part123456";
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `invalid key: ${decoded}` } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky });
    delete (context as { source?: unknown }).source;
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", `https://rpc.example/${encoded}`, "--token", TOKEN],
      context,
    );
    expect(code).toBe(EXIT.FAILED);
    const written = [...context.out, ...context.err].join("\n");
    expect(written).not.toContain(decoded);
    expect(written).toContain("[redacted]");
  });

  it("survives a malformed percent sequence instead of throwing", () => {
    expect(() => secretsFromEndpoints(["https://rpc.example/bad%ZZsequence"])).not.toThrow();
    expect(secretsFromEndpoints(["https://rpc.example/bad%ZZsequence"])).toContain("bad%ZZsequence");
  });
});

describe("R3-F3 scan names the log's claim, not a sender", () => {
  /**
   * For an inbound transfer, `counterparty` is the log's `from` topic -- forgeable, which is the
   * package's premise. Calling it the sender contradicted the trust rule's own reasoning.
   */
  it("reports claimedBy and the signing address separately", async () => {
    const events = [
      genuineSend(),
      // A forged inbound: the log names the imitator, the attacker signed it.
      { ...genuineSend(IMITATOR), direction: "in" as const, valueRaw: 0n, txFrom: OWNER, blockNumber: 20n },
    ];
    const context = io({ source: () => mockSource(events) });
    const code = await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"], context);
    expect(code).toBe(EXIT.LOOKALIKE);
    const payload = JSON.parse(context.out.join("\n")) as {
      findings: { claimedBy: string; transfers: { txFrom: string }[] }[];
    };
    expect(payload.findings[0]?.claimedBy).toBe(IMITATOR);
    expect(payload.findings[0]?.transfers[0]?.txFrom).toBe(OWNER);
    expect("sender" in (payload.findings[0] ?? {})).toBe(false);
  });

  it("says so in the text output too", async () => {
    const context = io();
    await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    const text = context.out.join("\n");
    expect(text).toContain("named by the transfer log");
    expect(text).toContain("transaction signed by");
    expect(text).not.toContain("sent 1 at block");
  });
});

describe("R3-F4 scan does not report a trusted address as a poisoner", () => {
  /**
   * Two genuine recipients can share both ends by chance. scan called findLookalikes directly,
   * bypassing assessRecipient's precedence, so an inbound transfer from either was reported as a
   * look-alike of the other and the command exited 20.
   */
  it("ignores an inbound transfer from an address the owner really pays", async () => {
    const twinA = "0xaaaa000000000000000000000000000000001111" as Address;
    const twinB = "0xaaaa999999999999999999999999999999991111" as Address;
    const events = [
      genuineSend(twinA),
      genuineSend(twinB),
      { ...genuineSend(twinA), direction: "in" as const, valueRaw: 1n, txFrom: twinA, blockNumber: 30n },
    ];
    const context = io({ source: () => mockSource(events) });
    const code = await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    expect(code).toBe(EXIT.TRUSTED);
    expect(context.out.join("\n")).toContain("No look-alike addresses");
  });

  it("still flags an untrusted imitator of one of them", async () => {
    const twinA = "0xaaaa000000000000000000000000000000001111" as Address;
    const faker = "0xaaaa555555555555555555555555555555551111" as Address;
    const events = [
      genuineSend(twinA),
      { ...genuineSend(faker), direction: "in" as const, valueRaw: 0n, txFrom: faker, blockNumber: 30n },
    ];
    const context = io({ source: () => mockSource(events) });
    expect(await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(EXIT.LOOKALIKE);
    expect(context.out.join("\n")).toContain(toChecksum(faker));
  });
});

describe("R3-F5 a checkpoint says which walk it belongs to", () => {
  it("labels the outgoing and incoming phases", async () => {
    const seen: { phase: string; nextBlock: number }[] = [];
    const chain = fakeChain({ head: 300, transfers: [] });
    const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
    await rpcLogSource(rpc, {
      tokens: [TOKEN],
      chunkSize: 100,
      onCheckpoint: (checkpoint) => void seen.push({ phase: checkpoint.phase, nextBlock: checkpoint.nextBlock }),
    }).fetch(OWNER, { fromBlock: 0 });
    expect(new Set(seen.map((entry) => entry.phase))).toEqual(new Set(["outgoing", "incoming"]));
    // Each phase restarts from the same first block, which is why an unlabelled counter was
    // impossible to interpret.
    expect(seen.filter((e) => e.phase === "outgoing").length).toBeGreaterThan(1);
    expect(seen.filter((e) => e.phase === "incoming").length).toBeGreaterThan(1);
  });
});
