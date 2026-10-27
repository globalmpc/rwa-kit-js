/**
 * Findings from the fourth review round on MPC-280. R4-F2 is the most serious of any round: it
 * defeats the trust rule using evidence the rule itself accepts.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import { forEachConcurrently } from "../src/concurrency.js";
import { GuardError } from "../src/errors.js";
import type { Address } from "../src/hex.js";
import type { History, HistorySource } from "../src/history.js";
import { parsePayoutCsv } from "../src/payouts.js";
import { redactSecrets } from "../src/redact.js";
import { indexerThenRpc, rpcLogSource } from "../src/sources.js";
import { deriveTrustedRecipients } from "../src/trusted.js";
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

describe("R4-F1 an unbounded range cannot establish coverage", () => {
  const covering = (toBlock: number): HistorySource => ({
    fetch: async (_owner, range): Promise<History> => ({
      events: [genuineSend()],
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        fromBlock: range?.fromBlock ?? 0,
        toBlock: range?.toBlock ?? 0,
        coverage: { fromBlock: 0, toBlock },
      },
    }),
  });
  const rpcSource: HistorySource = {
    fetch: async (): Promise<History> => ({
      events: [genuineSend(), { ...genuineSend(GENUINE), blockNumber: 150n }],
      source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 200 },
    }),
  };

  /**
   * The previous round required a range but only checked the upper bound when toBlock was given.
   * An index covering 0-100 therefore satisfied { fromBlock: 0 }, hiding a genuine send at 150.
   */
  it("refuses an indexer when the range has no end block", async () => {
    const { source } = await indexerThenRpc(covering(100), rpcSource).fetch(OWNER, { fromBlock: 0 });
    expect(source.kind).toBe("rpc");
  });

  it("still refuses when the end block exceeds what the index covers", async () => {
    const { source } = await indexerThenRpc(covering(100), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("rpc");
  });

  it("accepts it once both bounds are covered", async () => {
    const { source } = await indexerThenRpc(covering(200), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("indexer");
  });
});

describe("R4-F2 a fabricated Transfer log cannot create trust", () => {
  /**
   * The attack the token filter closes. Any contract may emit a three-topic
   * Transfer(owner, anyone, value) without moving a token. If the owner signs one transaction to
   * an attacker's contract -- a fake airdrop claim, the most ordinary phishing step there is --
   * every condition of the trust rule holds: direction out, a log so the transaction succeeded,
   * a non-zero value, and txFrom genuinely the owner. The look-alike becomes trusted and `check`
   * would exit 0 on it.
   */
  const EVIL = "0xdead00000000000000000000000000000000dead" as Address;

  it("refuses to read without a named token, so the log can never be collected", () => {
    const rpc = createRpc({ urls: "https://r.example", fetch: fakeChain({ head: 100, transfers: [] }).fetch });
    expect(() => rpcLogSource(rpc, { tokens: [] })).toThrow(/tokens is required/);
  });

  it("shows the bypass is real when an unnamed contract's log is believed", () => {
    // What an unfiltered read would have produced: the attacker's contract naming the owner.
    const fabricated = {
      ...genuineSend(IMITATOR),
      token: EVIL,
      valueRaw: 1_000n,
      txFrom: OWNER, // the owner really signed the transaction
      // ...and the calldata named this recipient, so every condition but the token holds. The
      // attacker's contract is both the token that emitted the log and what was called.
      txTo: EVIL,
      txTransferTo: IMITATOR,
    };
    // Every condition of the rule is met, so the look-alike would be trusted.
    expect(deriveTrustedRecipients([fabricated])).toEqual([IMITATOR]);
  });

  it("excludes it once only named tokens are read", async () => {
    const chain = fakeChain({
      head: 100,
      transfers: [
        { blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n, token: TOKEN },
        // The attacker's contract emits the same shape from a different address.
        { blockNumber: 20, from: OWNER, to: IMITATOR, valueRaw: 1_000n, token: EVIL, txFrom: OWNER },
      ],
    });
    const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(deriveTrustedRecipients(events)).toEqual([GENUINE]);
  });

  it("requires --token on every command that reads history", async () => {
    for (const argv of [
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example"],
      ["scan", OWNER, "--rpc", "https://r.example"],
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example"],
    ]) {
      const context = io({ readFile: async () => `${GENUINE}\n` });
      expect(await runAddressGuard(argv, context)).toBe(EXIT.USAGE);
      expect(context.err.join(" ")).toContain("--token is required");
    }
  });

  it("leaves checksum working without one, since it reads no history", async () => {
    expect(await runAddressGuard(["checksum", GENUINE], io())).toBe(EXIT.TRUSTED);
  });
});

describe("R4-F3 redaction is case-insensitive as documented", () => {
  it("masks an upper-cased echo of a lower-case key", () => {
    expect(redactSecrets("invalid key: ABC123SECRET", ["abc123secret"])).toBe("invalid key: [redacted]");
  });

  it("masks mixed casing in both directions", () => {
    expect(redactSecrets("Abc123Secret and abc123secret", ["ABC123SECRET"])).toBe("[redacted] and [redacted]");
  });

  it("treats a secret containing regex operators literally", () => {
    expect(redactSecrets("key a.b*c+d", ["a.b*c+d"])).toBe("key [redacted]");
    // The pattern must not match a different string that the unescaped regex would.
    expect(redactSecrets("key axbxcxd", ["a.b*c+d"])).toBe("key axbxcxd");
  });
});

describe("R4-F4 a header is an exact field name", () => {
  it("does not mistake a malformed first row for a header", () => {
    const rows = parsePayoutCsv(`to review\n${GENUINE}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.raw).toBe("to review");
    expect(rows[0]?.recipient).toBeUndefined();
  });

  it("reports that row as invalid rather than dropping it", async () => {
    const context = io({ readFile: async () => `to review\n${GENUINE}\n` });
    const code = await runAddressGuard(
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN],
      context,
    );
    expect(code).toBe(EXIT.INVALID);
  });

  it("still drops a real header", () => {
    for (const header of ["recipient", "Address", "TO"]) {
      expect(parsePayoutCsv(`${header}\n${GENUINE}\n`)).toHaveLength(1);
    }
  });
});

describe("R4-F5 surplus positionals are refused", () => {
  it("does not silently check only the first file", async () => {
    const context = io({ readFile: async () => `${GENUINE}\n` });
    const code = await runAddressGuard(
      ["payouts", "safe.csv", "unchecked.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN],
      context,
    );
    expect(code).toBe(EXIT.USAGE);
    expect(context.err.join(" ")).toContain("unchecked.csv");
  });

  it("accepts exactly one argument", async () => {
    const context = io({ readFile: async () => `${GENUINE}\n` });
    expect(
      await runAddressGuard(
        ["payouts", "safe.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN],
        context,
      ),
    ).toBe(EXIT.TRUSTED);
  });
});

describe("R4-F6 a non-positive concurrency limit is refused", () => {
  it("does not resolve without running the task", async () => {
    let ran = 0;
    for (const limit of [0, -1, 1.5]) {
      await expect(forEachConcurrently([1], limit, async () => void ran++)).rejects.toThrow(GuardError);
    }
    expect(ran).toBe(0);
  });

  it("still runs with a valid limit", async () => {
    let ran = 0;
    await forEachConcurrently([1, 2, 3], 2, async () => void ran++);
    expect(ran).toBe(3);
  });
});

describe("R4-F7 one crowded bucket produces bounded evidence", () => {
  it("caps the matches reported and states the true total", async () => {
    // 60 addresses sharing the compared window, so every row matches every other.
    const rows = Array.from(
      { length: 60 },
      (_, i) => `0xabcd${i.toString(16).padStart(32, "0")}abcd`,
    );
    const context = io({ readFile: async () => rows.join("\n") });
    const code = await runAddressGuard(
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"],
      context,
    );
    expect(code).toBe(EXIT.LOOKALIKE);
    const payload = JSON.parse(context.out.join("\n")) as {
      results: { evidence: unknown[]; imitatesTotal?: number; evidenceTruncated?: boolean }[];
    };
    const first = payload.results[0];
    expect(first?.evidence.length).toBeLessThanOrEqual(10);
    // Nothing is hidden: the real count travels with the result.
    expect(first?.imitatesTotal).toBe(59);
    expect(first?.evidenceTruncated).toBe(true);
  });

  it("does not mark a small bucket as truncated", async () => {
    const context = io({ readFile: async () => `${GENUINE}\n${IMITATOR}\n` });
    await runAddressGuard(
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"],
      context,
    );
    const payload = JSON.parse(context.out.join("\n")) as { results: { evidenceTruncated?: boolean }[] };
    expect(payload.results.every((r) => r.evidenceTruncated === undefined)).toBe(true);
  });
});
