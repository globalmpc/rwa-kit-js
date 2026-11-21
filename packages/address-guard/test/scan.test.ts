/**
 * The `scan` command: reporting look-alikes that sent transfers into the owner's history, by the
 * address each log claims and the account that actually signed it.
 */
import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { toChecksum } from "../src/checksum.js";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import type { Address } from "../src/hex.js";
import { IMITATOR, OWNER, TOKEN } from "./fake-chain.js";
import { genuineSend, mockSource, poisonedHistory } from "./fixtures.js";

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

describe("scan reports every inbound transfer from a look-alike sender", () => {
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

describe("scan names the log's claim, not a sender", () => {
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

describe("scan holds a pair of trusted addresses for review", () => {
  /**
   * Two genuine recipients can share both ends by chance, or one may be a look-alike the owner paid
   * before the guard existed. check says REVIEW for either, so scan must agree instead of saying
   * the history is clean. It is not called a look-alike: neither half is known to be the fake.
   */
  const twinA = "0xaaaa000000000000000000000000000000001111" as Address;
  const twinB = "0xaaaa999999999999999999999999999999991111" as Address;
  const pairHistory = [
    genuineSend(twinA),
    genuineSend(twinB),
    { ...genuineSend(twinA), direction: "in" as const, valueRaw: 1n, txFrom: twinA, blockNumber: 30n },
  ];

  it("exits 15 for an inbound transfer from a paid address that has a paid partner", async () => {
    const context = io({ source: () => mockSource(pairHistory) });
    const code = await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    expect(code).toBe(EXIT.REVIEW);
    const text = context.out.join("\n");
    expect(text).toContain(toChecksum(twinA));
    expect(text).toContain(`shares both ends with ${toChecksum(twinB)}`);
    expect(text).not.toContain("imitates");
  });

  it("agrees with check on the same history", async () => {
    const checkCode = await runAddressGuard(["check", twinA, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], io({ source: () => mockSource(pairHistory) }));
    expect(checkCode).toBe(EXIT.REVIEW);
  });

  it("reports the review verdict in JSON", async () => {
    const context = io({ source: () => mockSource(pairHistory) });
    await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"], context);
    const { findings } = JSON.parse(context.out.join("\n"));
    expect(findings[0].verdict).toBe("review");
  });

  it("exits 20 when a look-alike is found as well", async () => {
    const faker = "0xaaaa555555555555555555555555555555551111" as Address;
    const events = [...pairHistory, { ...genuineSend(faker), direction: "in" as const, valueRaw: 0n, txFrom: faker, blockNumber: 40n }];
    const context = io({ source: () => mockSource(events) });
    expect(await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(EXIT.LOOKALIKE);
  });

  it("stays clean for a paid address with no partner", async () => {
    const events = [genuineSend(twinA), { ...genuineSend(twinA), direction: "in" as const, valueRaw: 1n, txFrom: twinA, blockNumber: 30n }];
    const context = io({ source: () => mockSource(events) });
    expect(await runAddressGuard(["scan", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(EXIT.TRUSTED);
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
