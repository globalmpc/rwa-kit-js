import { GuardError } from "./errors.js";
import { isAddress, type Address } from "./hex.js";

/** One row of a payout file. `raw` keeps the recipient exactly as written, casing included. */
export interface PayoutRow {
  /** 1-based line number in the file, for a message that points at the problem. */
  line: number;
  /** The recipient as written, so a checksum complaint can quote it. */
  raw: string;
  /** Present only when `raw` is a well-formed address. */
  recipient?: Address;
  /** Everything after the first comma, untouched. Amounts are not parsed: this tool never sends. */
  rest?: string;
}

// Anchored at both ends: `\b` also matched a first row of "to review", dropping a malformed
// recipient as though it were a header and letting the file pass without it being assessed.
const HEADER = /^(recipient|address|to)$/i;

/**
 * Reads a payout file: one recipient per line, optionally followed by a comma and anything else.
 *
 * Blank lines and `#` comments are skipped, and a leading header row naming `recipient`, `address`
 * or `to` is dropped. Amounts are deliberately not parsed — this tool decides where not to send,
 * never how much, so a malformed amount is not its business.
 *
 * A row whose recipient is not an address is kept with `recipient` unset rather than rejected, so
 * one bad line still gets reported as `invalid` alongside the rest instead of failing the file.
 */
export function parsePayoutCsv(text: string): PayoutRow[] {
  const rows: PayoutRow[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const comma = trimmed.indexOf(",");
    const first = (comma === -1 ? trimmed : trimmed.slice(0, comma)).trim();
    const rest = comma === -1 ? undefined : trimmed.slice(comma + 1).trim();
    if (rows.length === 0 && !isAddress(first) && HEADER.test(first)) continue;
    rows.push({
      line: index + 1,
      raw: first,
      ...(isAddress(first) ? { recipient: first } : {}),
      ...(rest !== undefined && rest !== "" ? { rest } : {}),
    });
  }
  if (rows.length === 0) {
    throw new GuardError("E_PAYOUT_FORMAT", "the payout file holds no rows (blank lines and # comments are skipped)");
  }
  return rows;
}
