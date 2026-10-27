import { describe, expect, it } from "vitest";
import type { Hex } from "@globalmpc/evm-log-walker";
import type { Intent } from "../src/intent.js";
import { reconcile } from "../src/reconcile.js";
import type { Transfer } from "../src/transfers.js";
import { address, hash, PAYER, TOKEN } from "./fake-chain.js";

const intent = (recipient: Hex, amount: bigint, line: number): Intent => ({ recipient, amount, line });
let nextLog = 0;
const paid = (to: Hex, amount: bigint, tx = hash(1), logIndex = nextLog++): Transfer => ({
  token: TOKEN,
  from: PAYER,
  to,
  amount,
  blockNumber: 100,
  transactionHash: tx,
  transactionIndex: 0,
  logIndex,
});

describe("reconcile", () => {
  it("is clean when every line is paid once at its amount and nothing else is paid", () => {
    const result = reconcile([intent(address(1), 10n, 2), intent(address(2), 20n, 3)], [paid(address(1), 10n), paid(address(2), 20n)]);
    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.intendedTotal).toBe(30n);
    expect(result.paidTotal).toBe(30n);
  });

  it("reads a real multisend shape: one hash, many transfers, one duplicate and one missing recipient", () => {
    const recipients = Array.from({ length: 50 }, (_, i) => address(100 + i));
    const intents = recipients.map((recipient, i) => intent(recipient, 1_000n + BigInt(i), i + 2));
    const multisend = hash(42);
    // Everyone is paid in one transaction, except recipient 7, who is skipped, and recipient 3,
    // who is paid twice: the same amount under the same hash at a later log index.
    const transfers = recipients.flatMap((recipient, i) => (i === 7 ? [] : [paid(recipient, 1_000n + BigInt(i), multisend, i)]));
    transfers.push(paid(recipients[3]!, 1_003n, multisend, 60));

    const result = reconcile(intents, transfers);

    expect(result.clean).toBe(false);
    expect(result.paidCount).toBe(50);
    expect(result.counts).toEqual({ missing: 1, duplicate: 1, overpaid: 0, underpaid: 0, extra: 0, unexpected: 0 });
    expect(result.findings).toEqual([
      { kind: "duplicate", recipient: recipients[3], intended: 1_003n, line: 5, transfer: expect.objectContaining({ transactionHash: multisend, logIndex: 60 }), firstPaidBy: expect.objectContaining({ logIndex: 3 }) },
      { kind: "missing", recipient: recipients[7], intended: 1_007n, line: 9 },
    ]);
  });

  it("does not turn the same transaction read twice into a duplicate", () => {
    const transfer = paid(address(1), 10n, hash(9), 0);
    const result = reconcile([intent(address(1), 10n, 2)], [transfer, { ...transfer }]);
    expect(result.clean).toBe(true);
    expect(result.repeatedInputs).toBe(1);
  });

  it("reports an overpayment and an underpayment against the line they paid", () => {
    const result = reconcile([intent(address(1), 10n, 2), intent(address(2), 20n, 3)], [paid(address(1), 15n), paid(address(2), 5n)]);
    expect(result.findings.map((f) => [f.kind, f.recipient, f.intended, f.transfer?.amount, f.line])).toEqual([
      ["overpaid", address(1), 10n, 15n, 2],
      ["underpaid", address(2), 20n, 5n, 3],
    ]);
  });

  it("separates a stray payment to a listed recipient (extra) from one to an address not on the list (unexpected)", () => {
    const result = reconcile([intent(address(1), 10n, 2)], [paid(address(1), 10n), paid(address(1), 3n), paid(address(9), 7n)]);
    expect(result.findings.map((f) => [f.kind, f.recipient])).toEqual([
      ["extra", address(1)],
      ["unexpected", address(9)],
    ]);
    expect(result.recipients.map((r) => r.recipient)).toEqual([address(1), address(9)]);
  });

  it("pays two lines for the same recipient with two transfers, in any order", () => {
    const result = reconcile([intent(address(1), 10n, 2), intent(address(1), 30n, 3)], [paid(address(1), 30n), paid(address(1), 10n)]);
    expect(result.clean).toBe(true);
  });

  it("treats a checksummed and a lower-case address as the same recipient, on either side", () => {
    const upper = `0x${address(0xabc).slice(2).toUpperCase()}` as Hex;
    expect(reconcile([intent(upper, 10n, 2)], [paid(address(0xabc), 10n)]).clean).toBe(true);
    expect(reconcile([intent(address(0xabc), 10n, 2)], [paid(upper, 10n)]).clean).toBe(true);
  });

  it("pairs a wrong amount with the line it is closest to, not by sort position", () => {
    const result = reconcile([intent(address(1), 10n, 2), intent(address(1), 1000n, 3)], [paid(address(1), 999n)]);
    expect(result.findings.map((f) => [f.kind, f.line, f.transfer?.amount])).toEqual([
      ["missing", 2, undefined],
      ["underpaid", 3, 999n],
    ]);
  });

  it("reports every line missing when nothing was paid", () => {
    const result = reconcile([intent(address(1), 10n, 2), intent(address(2), 20n, 3)], []);
    expect(result.counts.missing).toBe(2);
    expect(result.paidTotal).toBe(0n);
  });
});
