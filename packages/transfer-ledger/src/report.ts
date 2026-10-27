import { formatUnits } from "./amount.js";
import { LedgerError } from "./errors.js";
import { isAddress, isTransactionHash, normalizeAddress, type Hex } from "./hex.js";
import type { TransactionStatus } from "./fetch.js";
import type { Finding, PaidTransfer, Reconciliation } from "./reconcile.js";
import type { Transfer } from "./transfers.js";

// Bumped by hand alongside package.json's "version" at release time; recorded on every report so
// a reader knows which rules produced it.
const PACKAGE_VERSION = "0.1.0";

/** An amount in a report: exact base units, plus the same value in token units for people. */
export interface ReportAmount {
  /** Base units as a decimal string. JSON numbers cannot hold every token amount exactly. */
  raw: string;
  /** Token units, using the report's `decimals`. */
  units: string;
}

export interface ReportTransfer {
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  blockNumber: number;
  amount: ReportAmount;
}

export interface ReportFinding {
  kind: Finding["kind"];
  recipient: Hex;
  intended?: ReportAmount;
  line?: number;
  transfer?: ReportTransfer;
  firstPaidBy?: ReportTransfer;
}

export interface Report {
  package: "@globalmpc/transfer-ledger";
  version: string;
  generatedAt: string;
  token: Hex;
  decimals: number;
  round?: string;
  /** Where the transfers came from: endpoint origins (never a key), or a saved transfers file. */
  source: string;
  chainId?: number;
  /** The transactions read, with their status, when transfers were read by transaction hash. */
  transactions?: TransactionStatus[];
  clean: boolean;
  summary: {
    /** Recipients on the payout list. */
    recipients: number;
    /** Addresses paid that are not on the list. */
    unlistedRecipients: number;
    intendedCount: number;
    intendedTotal: ReportAmount;
    paidCount: number;
    paidTotal: ReportAmount;
    repeatedInputs: number;
    counts: Reconciliation["counts"];
  };
  findings: ReportFinding[];
}

export interface BuildReportOptions {
  token: Hex;
  decimals: number;
  source: string;
  round?: string;
  chainId?: number;
  transactions?: TransactionStatus[];
  /** Overrides the clock, in milliseconds since epoch. For tests only. */
  now?: () => number;
}

/** Turns a `Reconciliation` into the JSON-safe report the CLI prints and saves. */
export function buildReport(reconciliation: Reconciliation, options: BuildReportOptions): Report {
  const amount = (value: bigint): ReportAmount => ({ raw: value.toString(), units: formatUnits(value, options.decimals) });
  const transfer = (paid: PaidTransfer): ReportTransfer => ({
    transactionHash: paid.transactionHash,
    transactionIndex: paid.transactionIndex,
    logIndex: paid.logIndex,
    blockNumber: paid.blockNumber,
    amount: amount(paid.amount),
  });
  const report: Report = {
    package: "@globalmpc/transfer-ledger",
    version: PACKAGE_VERSION,
    generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    token: normalizeAddress(options.token),
    decimals: options.decimals,
    source: options.source,
    clean: reconciliation.clean,
    summary: {
      recipients: reconciliation.recipients.filter((result) => result.intended.length > 0).length,
      unlistedRecipients: reconciliation.recipients.filter((result) => result.intended.length === 0).length,
      intendedCount: reconciliation.intendedCount,
      intendedTotal: amount(reconciliation.intendedTotal),
      paidCount: reconciliation.paidCount,
      paidTotal: amount(reconciliation.paidTotal),
      repeatedInputs: reconciliation.repeatedInputs,
      counts: reconciliation.counts,
    },
    findings: reconciliation.findings.map((finding) => {
      const out: ReportFinding = { kind: finding.kind, recipient: finding.recipient };
      if (finding.intended !== undefined) out.intended = amount(finding.intended);
      if (finding.line !== undefined) out.line = finding.line;
      if (finding.transfer !== undefined) out.transfer = transfer(finding.transfer);
      if (finding.firstPaidBy !== undefined) out.firstPaidBy = transfer(finding.firstPaidBy);
      return out;
    }),
  };
  if (options.round !== undefined) report.round = options.round;
  if (options.chainId !== undefined) report.chainId = options.chainId;
  if (options.transactions !== undefined) report.transactions = options.transactions;
  return report;
}

/** The file `--save-transfers` writes and `--transfers` reads, so a round can be re-checked offline. */
export interface SavedTransfers {
  format: "transfer-ledger/transfers@1";
  token: Hex;
  chainId?: number;
  source: string;
  /** The `--payer` addresses the round was read with, wallet first, applied again on a re-check. */
  payers?: Hex[];
  transfers: { from: Hex; to: Hex; amount: string; blockNumber: number; transactionHash: Hex; transactionIndex: number; logIndex: number }[];
}

/**
 * Writes the saved-transfers file. Pass everything that was read (`FetchedTransfers.read`), not the
 * selected payouts: the payer rule needs the wallet's own transfers, including its move into a
 * multisend contract, to decide again on a re-check.
 */
export function serializeTransfers(token: Hex, transfers: readonly Transfer[], source: string, chainId?: number, payers?: readonly Hex[]): string {
  const saved: SavedTransfers = {
    format: "transfer-ledger/transfers@1",
    token: normalizeAddress(token),
    source,
    transfers: transfers.map((transfer) => ({
      from: transfer.from,
      to: transfer.to,
      amount: transfer.amount.toString(),
      blockNumber: transfer.blockNumber,
      transactionHash: transfer.transactionHash,
      transactionIndex: transfer.transactionIndex,
      logIndex: transfer.logIndex,
    })),
  };
  if (chainId !== undefined) saved.chainId = chainId;
  if (payers !== undefined) saved.payers = payers.map(normalizeAddress);
  return JSON.stringify(saved, null, 2);
}

/** Reads a saved transfers file and checks every field; throws `E_INTENT_FORMAT` naming the entry. */
export function parseSavedTransfers(text: string): { token: Hex; chainId?: number; source: string; payers?: Hex[]; transfers: Transfer[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new LedgerError("E_INTENT_FORMAT", "the transfers file is not valid JSON", { cause });
  }
  const file = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (file["format"] !== "transfer-ledger/transfers@1" || !isAddress(file["token"]) || !Array.isArray(file["transfers"])) {
    throw new LedgerError("E_INTENT_FORMAT", 'the transfers file must be one written by --save-transfers (format "transfer-ledger/transfers@1")');
  }
  const token = normalizeAddress(file["token"]);
  const transfers = (file["transfers"] as unknown[]).map((item, index): Transfer => {
    const entry = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const { from, to, amount, blockNumber, transactionHash, transactionIndex, logIndex } = entry;
    if (
      !isAddress(from) ||
      !isAddress(to) ||
      typeof amount !== "string" ||
      !/^\d+$/.test(amount) ||
      !Number.isSafeInteger(blockNumber) ||
      !isTransactionHash(transactionHash) ||
      !Number.isSafeInteger(transactionIndex) ||
      !Number.isSafeInteger(logIndex)
    ) {
      throw new LedgerError("E_INTENT_FORMAT", `transfers file entry ${index + 1} is malformed`);
    }
    return {
      token,
      from: normalizeAddress(from),
      to: normalizeAddress(to),
      amount: BigInt(amount),
      blockNumber: blockNumber as number,
      transactionHash: transactionHash.toLowerCase() as Hex,
      transactionIndex: transactionIndex as number,
      logIndex: logIndex as number,
    };
  });
  const payers = file["payers"];
  if (payers !== undefined && (!Array.isArray(payers) || payers.length === 0 || !payers.every(isAddress))) {
    throw new LedgerError("E_INTENT_FORMAT", "the transfers file's payers must be a non-empty list of addresses");
  }
  const result: { token: Hex; chainId?: number; source: string; payers?: Hex[]; transfers: Transfer[] } = {
    token,
    source: typeof file["source"] === "string" ? file["source"] : "a saved transfers file",
    transfers,
  };
  if (typeof file["chainId"] === "number") result.chainId = file["chainId"];
  if (payers !== undefined) result.payers = (payers as Hex[]).map(normalizeAddress);
  return result;
}
