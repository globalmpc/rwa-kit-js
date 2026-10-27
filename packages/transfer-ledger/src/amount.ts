import { LedgerError } from "./errors.js";

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/** Token decimals as ERC-20 contracts define them: a whole number from 0 to 255. */
export function assertDecimals(decimals: unknown): asserts decimals is number {
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new LedgerError("E_INVALID_ARGUMENT", `decimals must be a whole number from 0 to 255, got ${String(decimals)}`);
  }
}

/**
 * Converts a decimal amount in token units ("12.5") to base units, exactly. Rejects anything that
 * cannot be represented without rounding (more fraction digits than `decimals`), signs, exponents
 * and separators, so a payout list never silently changes value on the way in.
 */
export function parseUnits(text: string, decimals: number): bigint {
  assertDecimals(decimals);
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (!match) {
    throw new LedgerError("E_INTENT_FORMAT", `amount ${JSON.stringify(text)} is not a plain decimal number such as 12 or 12.5`);
  }
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new LedgerError("E_INTENT_FORMAT", `amount ${text.trim()} has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Base units back to a decimal string in token units, exactly, without trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
