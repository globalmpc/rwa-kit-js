import type { Hex } from "@globalmpc/evm-log-walker";

/** Distinct transaction count among logs that all belong to one UTC day. */
export function countTransactions(transactionHashes: readonly Hex[]): number {
  return new Set(transactionHashes).size;
}
