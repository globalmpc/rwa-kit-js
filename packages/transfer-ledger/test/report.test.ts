import { describe, expect, it } from "vitest";
import { reconcile } from "../src/reconcile.js";
import { buildReport, parseSavedTransfers, serializeTransfers } from "../src/report.js";
import type { Transfer } from "../src/transfers.js";
import { address, hash, PAYER, TOKEN } from "./fake-chain.js";

const transfer: Transfer = {
  token: TOKEN,
  from: PAYER,
  to: address(1),
  amount: 12_500_000_000_000_000_000n,
  blockNumber: 7,
  transactionHash: hash(1),
  transactionIndex: 3,
  logIndex: 2,
};

describe("buildReport", () => {
  it("writes every amount as exact base units plus token units, so JSON never rounds", () => {
    const result = reconcile([{ recipient: address(1), amount: 10_000_000_000_000_000_000n, line: 2 }], [transfer]);
    const report = buildReport(result, { token: TOKEN, decimals: 18, source: "https://rpc.example", round: "Q3", chainId: 56, now: () => 0 });
    expect(report.summary.paidTotal).toEqual({ raw: "12500000000000000000", units: "12.5" });
    expect(report.findings[0]).toEqual({
      kind: "overpaid",
      recipient: address(1),
      intended: { raw: "10000000000000000000", units: "10" },
      line: 2,
      transfer: { transactionHash: hash(1), transactionIndex: 3, logIndex: 2, blockNumber: 7, amount: { raw: "12500000000000000000", units: "12.5" } },
    });
    expect(report).toMatchObject({ clean: false, round: "Q3", chainId: 56, generatedAt: "1970-01-01T00:00:00.000Z" });
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it("counts listed and unlisted recipients separately", () => {
    const result = reconcile([{ recipient: address(1), amount: 1n, line: 2 }], [{ ...transfer, amount: 1n }, { ...transfer, to: address(9), logIndex: 3 }, { ...transfer, to: address(9), logIndex: 4 }]);
    const report = buildReport(result, { token: TOKEN, decimals: 0, source: "x" });
    expect(report.summary).toMatchObject({ recipients: 1, unlistedRecipients: 1 });
  });
});

describe("saved transfers", () => {
  it("round-trips through serializeTransfers and parseSavedTransfers", () => {
    const saved = parseSavedTransfers(serializeTransfers(TOKEN, [transfer], "https://rpc.example", 56, [PAYER]));
    expect(saved).toEqual({ token: TOKEN, chainId: 56, source: "https://rpc.example", payers: [PAYER], transfers: [transfer] });
  });

  it("rejects a file it did not write, naming the bad entry", () => {
    expect(() => parseSavedTransfers("[]")).toThrow(/--save-transfers/);
    const bad = JSON.parse(serializeTransfers(TOKEN, [transfer], "x"));
    bad.transfers[0].amount = "1.5";
    expect(() => parseSavedTransfers(JSON.stringify(bad))).toThrow(/entry 1 is malformed/);
  });
});
