import type { Hex } from "@globalmpc/evm-log-walker";
import type { TxSummary } from "../tx.js";

/**
 * The set of wallets (transaction signers, not token-transfer participants) active among the
 * given transaction hashes on one day. Returned as a `Set`, not a count, because retention needs
 * the membership itself to check which wallets recur on later days.
 */
export function activeWalletSet(transactionHashes: readonly Hex[], txSummaries: ReadonlyMap<Hex, TxSummary>): Set<Hex> {
  const wallets = new Set<Hex>();
  for (const hash of new Set(transactionHashes)) {
    const tx = txSummaries.get(hash);
    if (tx) wallets.add(tx.from);
  }
  return wallets;
}
