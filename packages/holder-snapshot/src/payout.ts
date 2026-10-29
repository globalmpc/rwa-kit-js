import type { Allocation } from "./allocate.js";
import { formatUnits } from "./amount.js";
import { SnapshotError } from "./errors.js";

/**
 * The payout list as CSV: a `recipient,amount` header, then one row per allocation with the amount
 * in token units. This is the format `@globalmpc/address-guard payouts` and
 * `@globalmpc/transfer-ledger` read, so the same file is checked before the payment and reconciled
 * after it.
 *
 * An empty list is refused rather than written as a header-only file: there is nothing to pay,
 * and the tools downstream reject such a file anyway.
 */
export function toPayoutCsv(allocations: readonly Allocation[], decimals: number): string {
  if (allocations.length === 0) {
    throw new SnapshotError("E_NOTHING_TO_PAY", "no holder receives a non-zero amount, so there is no payout list to write");
  }
  const rows = allocations.map((allocation) => `${allocation.address},${formatUnits(allocation.amount, decimals)}`);
  return `${["recipient,amount", ...rows].join("\n")}\n`;
}
