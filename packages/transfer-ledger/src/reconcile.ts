import type { Intent } from "./intent.js";
import { normalizeAddress, type Hex } from "./hex.js";
import { uniqueTransfers, type Transfer } from "./transfers.js";

/**
 * What can be wrong with one recipient's payments:
 * - `missing`: an intended payment with no transfer for it.
 * - `duplicate`: a transfer repeating an amount the recipient was already paid in full.
 * - `overpaid` / `underpaid`: a transfer that pays an intended line, but a different amount.
 * - `extra`: a transfer to a listed recipient that matches none of their lines.
 * - `unexpected`: a transfer to an address the payout list does not name at all.
 */
export type FindingKind = "missing" | "duplicate" | "overpaid" | "underpaid" | "extra" | "unexpected";

export interface PaidTransfer {
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  blockNumber: number;
  amount: bigint;
}

export interface Finding {
  kind: FindingKind;
  recipient: Hex;
  /** The intended amount involved, for every kind except `extra` and `unexpected`. */
  intended?: bigint;
  /** The intent file line, for every kind except `extra` and `unexpected`. */
  line?: number;
  /** The transfer involved, for every kind except `missing`. */
  transfer?: PaidTransfer;
  /** For `duplicate`: the transfer that had already paid this amount. */
  firstPaidBy?: PaidTransfer;
}

export interface RecipientResult {
  recipient: Hex;
  intendedTotal: bigint;
  paidTotal: bigint;
  intended: { amount: bigint; line: number }[];
  paid: PaidTransfer[];
  findings: Finding[];
}

export interface Reconciliation {
  clean: boolean;
  intendedCount: number;
  intendedTotal: bigint;
  paidCount: number;
  paidTotal: bigint;
  /** Copies of the same transfer (same hash and log index) that the inputs held more than once. Not payments. */
  repeatedInputs: number;
  /** Listed recipients first, in intent order, then unexpected ones in chain order. */
  recipients: RecipientResult[];
  /** Every finding, in the order of `recipients`. */
  findings: Finding[];
  counts: Record<FindingKind, number>;
}

/**
 * Compares what was meant to be paid with what the chain shows was paid, one recipient at a time.
 * Pure and offline: no endpoint, no clock.
 *
 * Transfers are first made unique by transaction hash plus log index, so reading the same
 * transaction twice cannot create a duplicate, while two transfers in one multisend transaction
 * stay two payments. Then, per recipient:
 * 1. each intended line is matched with a transfer of exactly its amount, earliest first;
 * 2. a leftover transfer of an amount the recipient was meant to receive is a `duplicate`;
 * 3. remaining lines and transfers are paired by the smallest difference in amount first, and the
 *    pair is `overpaid` or `underpaid`;
 * 4. a line left over is `missing`; a transfer left over is `extra`, or `unexpected` when the
 *    recipient is not on the list at all.
 */
export function reconcile(intents: readonly Intent[], transfers: readonly Transfer[]): Reconciliation {
  const { transfers: unique, dropped } = uniqueTransfers(transfers);
  const intendedBy = new Map<Hex, { amount: bigint; line: number }[]>();
  for (const intent of intents) {
    const recipient = normalizeAddress(intent.recipient);
    const lines = intendedBy.get(recipient) ?? [];
    lines.push({ amount: intent.amount, line: intent.line });
    intendedBy.set(recipient, lines);
  }
  const paidBy = new Map<Hex, PaidTransfer[]>();
  for (const transfer of unique) {
    const list = paidBy.get(normalizeAddress(transfer.to)) ?? [];
    const recipient = normalizeAddress(transfer.to);
    list.push({
      transactionHash: transfer.transactionHash,
      transactionIndex: transfer.transactionIndex,
      logIndex: transfer.logIndex,
      blockNumber: transfer.blockNumber,
      amount: transfer.amount,
    });
    paidBy.set(recipient, list);
  }

  const order = [...intendedBy.keys(), ...[...paidBy.keys()].filter((recipient) => !intendedBy.has(recipient))];
  const recipients = order.map((recipient) => reconcileRecipient(recipient, intendedBy.get(recipient) ?? [], paidBy.get(recipient) ?? []));
  const findings = recipients.flatMap((result) => result.findings);
  const counts: Record<FindingKind, number> = { missing: 0, duplicate: 0, overpaid: 0, underpaid: 0, extra: 0, unexpected: 0 };
  for (const finding of findings) counts[finding.kind]++;
  return {
    clean: findings.length === 0,
    intendedCount: intents.length,
    intendedTotal: sum(intents.map((intent) => intent.amount)),
    paidCount: unique.length,
    paidTotal: sum(unique.map((transfer) => transfer.amount)),
    repeatedInputs: dropped,
    recipients,
    findings,
    counts,
  };
}

function reconcileRecipient(recipient: Hex, intended: { amount: bigint; line: number }[], paid: PaidTransfer[]): RecipientResult {
  const findings: Finding[] = [];
  let lines = [...intended];
  let transfers = [...paid];
  const firstPayment = new Map<bigint, PaidTransfer>();

  // 1. Exact matches, earliest transfer first.
  lines = lines.filter((line) => {
    const index = transfers.findIndex((transfer) => transfer.amount === line.amount);
    if (index === -1) return true;
    const [match] = transfers.splice(index, 1) as [PaidTransfer];
    if (!firstPayment.has(line.amount)) firstPayment.set(line.amount, match);
    return false;
  });

  // 2. A further transfer of an amount already paid in full is a duplicate, as long as no line of
  //    that amount is still waiting (it would have been matched in step 1).
  transfers = transfers.filter((transfer) => {
    const first = firstPayment.get(transfer.amount);
    if (first === undefined) return true;
    findings.push({ kind: "duplicate", recipient, intended: transfer.amount, line: lineOf(intended, transfer.amount), transfer, firstPaidBy: first });
    return false;
  });

  // 3. Pair what is left by the smallest difference first, so a payment lands on the line it most
  //    plausibly paid. Ties go to the earlier line and the earlier transfer.
  const candidates: { line: number; transfer: number; difference: bigint }[] = [];
  lines.forEach((line, lineIndex) => {
    transfers.forEach((transfer, transferIndex) => {
      const difference = transfer.amount > line.amount ? transfer.amount - line.amount : line.amount - transfer.amount;
      candidates.push({ line: lineIndex, transfer: transferIndex, difference });
    });
  });
  candidates.sort((a, b) => (a.difference < b.difference ? -1 : a.difference > b.difference ? 1 : a.line - b.line || a.transfer - b.transfer));
  const usedLines = new Set<number>();
  const usedTransfers = new Set<number>();
  for (const candidate of candidates) {
    if (usedLines.has(candidate.line) || usedTransfers.has(candidate.transfer)) continue;
    usedLines.add(candidate.line);
    usedTransfers.add(candidate.transfer);
    const line = lines[candidate.line] as { amount: bigint; line: number };
    const transfer = transfers[candidate.transfer] as PaidTransfer;
    findings.push({ kind: transfer.amount > line.amount ? "overpaid" : "underpaid", recipient, intended: line.amount, line: line.line, transfer });
  }

  // 4. Leftovers.
  lines.forEach((line, index) => {
    if (!usedLines.has(index)) findings.push({ kind: "missing", recipient, intended: line.amount, line: line.line });
  });
  transfers.forEach((transfer, index) => {
    if (!usedTransfers.has(index)) findings.push({ kind: intended.length === 0 ? "unexpected" : "extra", recipient, transfer });
  });

  return {
    recipient,
    intendedTotal: sum(intended.map((line) => line.amount)),
    paidTotal: sum(paid.map((transfer) => transfer.amount)),
    intended,
    paid,
    findings: findings.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)),
  };
}

function lineOf(intended: { amount: bigint; line: number }[], amount: bigint): number {
  return (intended.find((line) => line.amount === amount) as { line: number }).line;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
