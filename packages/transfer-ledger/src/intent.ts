import { parseUnits } from "./amount.js";
import { LedgerError } from "./errors.js";
import { isAddress, normalizeAddress, type Hex } from "./hex.js";

/** One line of the payout list: who was meant to receive how much, in base units. */
export interface Intent {
  recipient: Hex;
  amount: bigint;
  /** The round the line belongs to, when the file names one. */
  round?: string;
  /** 1-based line in the source file, so a finding can point back at it. */
  line: number;
}

export interface ParseIntentOptions {
  /** The token's decimals. Amounts in the file are in token units ("12.5"), converted exactly. */
  decimals: number;
  /** Keep only lines of this round. Required when the file holds more than one round. */
  round?: string;
}

/**
 * Parses a payout list in CSV: a header row naming `recipient` and `amount`, and optionally
 * `round`, in any order and any letter case; one payment per row; blank lines and lines starting
 * with `#` ignored. Values may be wrapped in double quotes. A recipient may appear on several
 * lines: each line is one intended payment.
 *
 * Every problem names the line it is on, and nothing is guessed: an address of the wrong shape,
 * an amount with more decimals than the token has, a zero amount or a missing column all throw
 * `E_INTENT_FORMAT`.
 */
export function parseIntentCsv(text: string, options: ParseIntentOptions): Intent[] {
  const rows: { line: number; cells: string[] }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    rows.push({ line: index + 1, cells: trimmed.split(",").map(unquote) });
  });
  const header = rows.shift();
  if (!header) {
    throw new LedgerError("E_INTENT_FORMAT", "the intent file is empty; it needs a header row naming recipient and amount");
  }
  const columns = header.cells.map((cell) => cell.toLowerCase());
  const recipientColumn = columns.indexOf("recipient");
  const amountColumn = columns.indexOf("amount");
  const roundColumn = columns.indexOf("round");
  if (recipientColumn === -1 || amountColumn === -1) {
    throw new LedgerError("E_INTENT_FORMAT", `line ${header.line}: the header must name recipient and amount columns, got ${header.cells.join(",")}`);
  }
  const entries = rows.map(({ line, cells }) => {
    if (cells.length !== columns.length) {
      throw new LedgerError("E_INTENT_FORMAT", `line ${line}: expected ${columns.length} values, got ${cells.length}`);
    }
    const entry: { recipient: string; amount: string; round?: string; line: number } = {
      recipient: cells[recipientColumn] as string,
      amount: cells[amountColumn] as string,
      line,
    };
    if (roundColumn !== -1) entry.round = cells[roundColumn] as string;
    return entry;
  });
  return toIntents(entries, options);
}

/**
 * Parses a payout list in JSON: an array of `{ "recipient": "0x…", "amount": "12.5", "round": "…" }`,
 * `round` optional. Amounts are strings in token units, for the same reason as in CSV: a JSON
 * number cannot hold every token amount exactly.
 */
export function parseIntentJson(text: string, options: ParseIntentOptions): Intent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new LedgerError("E_INTENT_FORMAT", "the intent file is not valid JSON", { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new LedgerError("E_INTENT_FORMAT", "the intent JSON must be an array of { recipient, amount, round? } objects");
  }
  const entries = parsed.map((item: unknown, index) => {
    const record = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const { recipient, amount, round } = record;
    if (typeof recipient !== "string" || typeof amount !== "string" || (round !== undefined && typeof round !== "string")) {
      throw new LedgerError("E_INTENT_FORMAT", `entry ${index + 1}: recipient and amount must be strings, round a string if given`);
    }
    const entry: { recipient: string; amount: string; round?: string; line: number } = { recipient, amount, line: index + 1 };
    if (round !== undefined) entry.round = round;
    return entry;
  });
  return toIntents(entries, options);
}

function toIntents(entries: { recipient: string; amount: string; round?: string; line: number }[], options: ParseIntentOptions): Intent[] {
  const rounds = new Set(entries.map((entry) => entry.round ?? ""));
  if (options.round === undefined && rounds.size > 1) {
    throw new LedgerError("E_INTENT_FORMAT", `the intent file holds ${rounds.size} rounds (${[...rounds].join(", ")}); choose one`);
  }
  const selected = options.round === undefined ? entries : entries.filter((entry) => entry.round === options.round);
  if (selected.length === 0) {
    throw new LedgerError(
      "E_INTENT_FORMAT",
      options.round === undefined ? "the intent file lists no payments" : `the intent file lists no payments for round ${options.round}`,
    );
  }
  return selected.map((entry) => {
    if (!isAddress(entry.recipient)) {
      throw new LedgerError("E_INTENT_FORMAT", `line ${entry.line}: recipient ${JSON.stringify(entry.recipient)} is not a 20-byte hex address`);
    }
    let amount: bigint;
    try {
      amount = parseUnits(entry.amount, options.decimals);
    } catch (error) {
      if (error instanceof LedgerError) throw new LedgerError(error.code, `line ${entry.line}: ${error.message}`);
      throw error;
    }
    if (amount === 0n) {
      throw new LedgerError("E_INTENT_FORMAT", `line ${entry.line}: amount is zero; a zero payment cannot be checked against the chain`);
    }
    const intent: Intent = { recipient: normalizeAddress(entry.recipient), amount, line: entry.line };
    if (entry.round !== undefined) intent.round = entry.round;
    return intent;
  });
}

function unquote(cell: string): string {
  const trimmed = cell.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
}
