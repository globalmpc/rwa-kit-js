/**
 * The `payouts` command: judging every row of a payout file against the owner's history and
 * the rest of the batch, with linear cost and bounded, honest evidence.
 */
import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { toChecksum } from "../src/checksum.js";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import type { Address } from "../src/hex.js";
import { parsePayoutCsv } from "../src/payouts.js";
import { GENUINE, IMITATOR, OWNER, TOKEN } from "./fake-chain.js";
import { mockSource, poisonedHistory } from "./fixtures.js";

function io(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: {},
    source: () => mockSource(poisonedHistory),
    ...over,
  };
}

describe("a payout row must never trust itself", () => {
  /**
   * `intended` is lower-cased; `row.recipient` keeps the file's casing. Comparing them directly
   * left a checksummed row's own address in its `known` set, where it matched itself exactly and
   * won the trusted verdict over the look-alike evidence. A single-row batch exited 0.
   */
  it("flags a checksummed look-alike row instead of self-trusting it", async () => {
    const context = io({ readFile: async () => `${toChecksum(IMITATOR)},5\n` });
    const code = await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    expect(code).toBe(EXIT.LOOKALIKE);
    expect(context.out.join("\n")).toContain("LOOKALIKE");
  });

  it("flags it in lower case too, so the fix is not casing-specific", async () => {
    const context = io({ readFile: async () => `${IMITATOR},5\n` });
    expect(await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.LOOKALIKE,
    );
  });

  it("still trusts a genuine recipient written in checksummed form", async () => {
    const context = io({ readFile: async () => `${toChecksum(GENUINE)},5\n` });
    expect(await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.TRUSTED,
    );
  });

  it("still catches a row imitating another row when neither is in the history", async () => {
    const pair = "0x7777000000000000000000000000000000007777" as Address;
    const copy = "0x7777111111111111111111111111111111117777" as Address;
    const context = io({ readFile: async () => `${toChecksum(pair)}\n${toChecksum(copy)}\n` });
    expect(await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.LOOKALIKE,
    );
  });
});

describe("payouts scale linearly and keep the same verdicts", () => {
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

describe("a header is an exact field name", () => {
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

describe("one crowded bucket produces bounded evidence", () => {
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

describe("a crowded bucket is not rescanned per row", () => {
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

describe("a batch peer is not described as a recipient the owner paid", () => {
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

describe("truncation is measured against the evidence reported", () => {
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
