/**
 * Findings from the fifth review round on MPC-280. R5-F1 is the deepest of any round: signing a
 * transaction is not the same as choosing a recipient.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import { GuardError } from "../src/errors.js";
import type { Address } from "../src/hex.js";
import type { History, HistorySource } from "../src/history.js";
import { secretsFromEndpoints } from "../src/redact.js";
import { indexerThenRpc, rpcLogSource } from "../src/sources.js";
import { deriveTrustedRecipients, ownerNamedRecipient } from "../src/trusted.js";
import { fakeChain, GENUINE, IMITATOR, OWNER, SPENDER, TOKEN } from "./fake-chain.js";
import { approvedSpenderSend, genuineSend, mockSource, poisonedHistory } from "./fixtures.js";

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

describe("R5-F1 signing a transaction is not choosing a recipient", () => {
  /**
   * The attack. An owner who has approved a spender -- and approvals are everywhere -- signs a
   * call to that spender, which calls transferFrom(owner, lookalike, value) on a token this
   * package trusts. The movement is real, the token is named, the value is non-zero and the
   * signer is the owner. Every condition of the previous rule held while the owner never saw
   * the recipient, and the look-alike became trusted: a one-time drain turned into persistent
   * mis-trust, so a later manual payment to the look-alike was waved through.
   */
  it("does not trust a recipient the owner's calldata never named", () => {
    expect(deriveTrustedRecipients([approvedSpenderSend(IMITATOR)])).toEqual([]);
  });

  it("still trusts a direct transfer the owner signed", () => {
    expect(deriveTrustedRecipients([genuineSend(GENUINE)])).toEqual([GENUINE]);
  });

  it("keeps the look-alike catchable when both events are present", () => {
    const trusted = deriveTrustedRecipients([genuineSend(GENUINE), approvedSpenderSend(IMITATOR)]);
    expect(trusted).toEqual([GENUINE]);
    expect(assessRecipient(IMITATOR, { trusted }).verdict).toBe("lookalike");
  });

  describe("ownerNamedRecipient", () => {
    const direct = genuineSend(GENUINE);

    it("requires the transaction to have called the token itself", () => {
      expect(ownerNamedRecipient(direct)).toBe(true);
      expect(ownerNamedRecipient({ ...direct, txTo: SPENDER })).toBe(false);
    });

    it("requires the signed recipient to be the one the log reports", () => {
      expect(ownerNamedRecipient({ ...direct, txTransferTo: IMITATOR })).toBe(false);
    });

    it("refuses when any of the three fields is missing", () => {
      for (const missing of ["token", "txTo", "txTransferTo"] as const) {
        const event = { ...direct };
        delete event[missing];
        expect(ownerNamedRecipient(event)).toBe(false);
      }
    });

    it("compares case-insensitively", () => {
      const upper = `0x${GENUINE.slice(2).toUpperCase()}` as Address;
      expect(ownerNamedRecipient({ ...direct, txTransferTo: upper })).toBe(true);
    });
  });

  describe("read end to end", () => {
    it("decodes a plain transfer and trusts its recipient", async () => {
      const chain = fakeChain({
        head: 200,
        transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n }],
      });
      const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
      const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
      expect(events[0]).toMatchObject({ txTo: TOKEN, txTransferTo: GENUINE });
      expect(deriveTrustedRecipients(events)).toEqual([GENUINE]);
    });

    it("does not trust a transfer routed through an approved spender", async () => {
      const chain = fakeChain({
        head: 200,
        transfers: [
          // The owner signed a call to the spender; the token moved to the imitator.
          { blockNumber: 10, from: OWNER, to: IMITATOR, valueRaw: 1_000n, txFrom: OWNER, txTo: SPENDER, txTransferTo: null },
        ],
      });
      const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
      const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
      expect(events[0]?.txTo).toBe(SPENDER);
      expect(events[0]?.txTransferTo).toBeUndefined();
      expect(deriveTrustedRecipients(events)).toEqual([]);
    });

    it("does not decode calldata that is not a plain transfer", async () => {
      const chain = fakeChain({
        head: 200,
        transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n, txTransferTo: null }],
      });
      const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
      const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
      expect(events[0]?.txTransferTo).toBeUndefined();
      expect(deriveTrustedRecipients(events)).toEqual([]);
    });
  });
});

describe("R5-F2 the answer's own range must span the request", () => {
  /**
   * Coverage says what a source has indexed; fromBlock/toBlock say what this answer read. A
   * source may have indexed 0-200 and still clamp one fetch to 101-200, returning a recent
   * poison transfer while omitting a genuine send at block 50.
   */
  const clamping = (fetchedFrom: number): HistorySource => ({
    fetch: async (_owner, range): Promise<History> => ({
      events: [genuineSend()],
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        fromBlock: fetchedFrom,
        toBlock: range?.toBlock ?? 200,
        coverage: { fromBlock: 0, toBlock: 200 },
      },
    }),
  });
  const rpcSource: HistorySource = {
    fetch: async (): Promise<History> => ({
      events: [genuineSend()],
      source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 200 },
    }),
  };

  it("falls back when the answer was clamped, despite full coverage", async () => {
    const { source } = await indexerThenRpc(clamping(101), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("rpc");
  });

  it("accepts it when the answer spans the request", async () => {
    const { source } = await indexerThenRpc(clamping(0), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("indexer");
  });
});

describe("R5-F3 a short credential is still a credential", () => {
  it("keeps a five-character query value", () => {
    expect(secretsFromEndpoints(["https://rpc.example/?apikey=ab12c"])).toContain("ab12c");
  });

  it("keeps short userinfo", () => {
    expect(secretsFromEndpoints(["https://user1:pw123@rpc.example/"])).toContain("pw123");
  });

  it("still ignores a short path fragment, which is usually routing", () => {
    expect(secretsFromEndpoints(["https://rpc.example/v2/eth"])).not.toContain("v2");
    expect(secretsFromEndpoints(["https://rpc.example/v2/eth"])).not.toContain("eth");
  });

  it("masks a short key a provider echoes back", async () => {
    const key = "ab12c";
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `bad key ${key}` } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky });
    delete (context as { source?: unknown }).source;
    await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", `https://rpc.example/?apikey=${key}`, "--token", TOKEN],
      context,
    );
    const written = [...context.out, ...context.err].join("\n");
    expect(written).toContain("[redacted]");
    expect(written).not.toMatch(/bad key ab12c/);
  });
});

describe("R5-F4 a crowded bucket is not rescanned per row", () => {
  it("still caps evidence and reports the true total", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `0xabcd${i.toString(16).padStart(32, "0")}abcd`);
    const context = io({ readFile: async () => rows.join("\n") });
    const code = await runAddressGuard(
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"],
      context,
    );
    expect(code).toBe(EXIT.LOOKALIKE);
    const payload = JSON.parse(context.out.join("\n")) as {
      results: { evidence: unknown[]; imitatesTotal?: number }[];
    };
    expect(payload.results[0]?.evidence.length).toBeLessThanOrEqual(10);
    expect(payload.results[0]?.imitatesTotal).toBe(39);
  });

  it("stays fast with many rows in one bucket", async () => {
    const rows = Array.from({ length: 3_000 }, (_, i) => `0xabcd${i.toString(16).padStart(32, "0")}abcd`);
    const context = io({ readFile: async () => rows.join("\n") });
    const started = Date.now();
    expect(
      await runAddressGuard(
        ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN],
        context,
      ),
    ).toBe(EXIT.LOOKALIKE);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("R5-F5 an unusable maxEvents is refused", () => {
  const rpc = () => createRpc({ urls: "https://r.example", fetch: fakeChain({ head: 100, transfers: [] }).fetch });

  it("rejects Infinity and NaN, which would disable the cap", async () => {
    for (const maxEvents of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1.5]) {
      await expect(rpcLogSource(rpc(), { tokens: [TOKEN], maxEvents }).fetch(OWNER)).rejects.toThrow(GuardError);
    }
  });

  it("accepts a positive safe integer", async () => {
    await expect(rpcLogSource(rpc(), { tokens: [TOKEN], maxEvents: 10 }).fetch(OWNER)).resolves.toBeDefined();
  });
});

describe("R5-F6 every documented command runs as written", () => {
  it("the README payout example includes --token", async () => {
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const payoutLines = readme.split("\n").filter((line) => line.startsWith("address-guard payouts"));
    expect(payoutLines.length).toBeGreaterThan(0);
    for (const line of payoutLines) expect(line).toContain("--token");
  });

  it("every documented history command includes --token", async () => {
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    for (const line of readme.split("\n")) {
      if (!/^address-guard (check|scan|payouts)\b/.test(line)) continue;
      expect(line, line).toContain("--token");
    }
  });
});
