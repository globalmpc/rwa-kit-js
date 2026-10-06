import type { Hex } from "@globalmpc/evm-log-walker";
import type { GasSplit } from "../schema.js";
import type { TxSummary } from "../tx.js";

/**
 * How many of a day's transactions were sponsored (`gasPrice === 0`) versus paid by the sender.
 * Every transaction counts once, by hash, even if it appears through several logs.
 */
export function splitGas(transactionHashes: readonly Hex[], txSummaries: ReadonlyMap<Hex, TxSummary>): GasSplit {
  let sponsored = 0;
  let userPaid = 0;
  for (const hash of new Set(transactionHashes)) {
    const tx = txSummaries.get(hash);
    if (!tx) continue;
    if (tx.sponsored) sponsored++;
    else userPaid++;
  }
  return { sponsored, userPaid };
}
