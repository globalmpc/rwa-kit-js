import { SnapshotError } from "./errors.js";

/** ERC-20 `decimals()` is a `uint8`, and no real token uses more than 36. */
export const MAX_DECIMALS = 36;

/** Throws `E_INVALID_ARGUMENT` unless `decimals` is an integer from 0 to 36. */
export function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new SnapshotError("E_INVALID_ARGUMENT", `decimals must be an integer from 0 to ${MAX_DECIMALS}, got ${String(decimals)}`);
  }
}

/**
 * Converts a decimal amount in token units (`"1.5"`) into base units (`1500000n` for 6 decimals),
 * exactly. More fractional digits than the token has is an error, never a silent rounding: a
 * payout of `0.0000001` of a 6-decimal token cannot be made, and saying so is the honest answer.
 */
export function parseUnits(text: string, decimals: number): bigint {
  assertDecimals(decimals);
  const value = text.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) {
    throw new SnapshotError("E_INVALID_AMOUNT", `"${text}" is not a non-negative decimal amount`);
  }
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new SnapshotError("E_INVALID_AMOUNT", `"${text}" has more than ${decimals} decimal place(s)`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** Formats base units as a decimal in token units, with trailing zeros removed (`1500000n` → `"1.5"`). */
export function formatUnits(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}
