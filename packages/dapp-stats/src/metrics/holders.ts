import type { Hex } from "@globalmpc/evm-log-walker";
import { ZERO_ADDRESS } from "../hex.js";
import type { Transfer } from "../transfers.js";

/**
 * Replays every `Transfer` in ascending order, from the contract's creation, into a running
 * balance per address, and returns the count of non-zero balances as of the end of each day in
 * `orderedDates`. `transfersByDay` must hold every transfer since creation, not just the report's
 * lookback window: a holder count is cumulative, and starting the replay partway through history
 * would double-count balances the walk never saw arrive.
 *
 * A balance going negative means the walk is missing earlier transfers (it didn't start at the
 * contract's creation block) rather than that a wallet spent tokens it never had. From the first
 * day this happens, that day and every day after it get `null` instead of a count: a wrong number
 * would be worse than an honest "not available", and it would be wrong for the rest of the replay
 * too, not just that one transfer. Days before that point keep their real, correct count.
 *
 * That check is a backstop, not proof of completeness: a replay that starts late but only sees
 * incoming transfers never goes negative and still undercounts. Only call this with a history
 * known to start at the creation block — `computeReport` does not call it otherwise.
 */
export function computeHolderCounts(
  transfersByDay: ReadonlyMap<string, readonly Transfer[]>,
  orderedDates: readonly string[],
): Map<string, number | null> {
  const balances = new Map<Hex, bigint>();
  const holdersByDay = new Map<string, number | null>();
  let incomplete = false;
  for (const date of orderedDates) {
    if (!incomplete) {
      for (const transfer of transfersByDay.get(date) ?? []) {
        if (transfer.from !== ZERO_ADDRESS) {
          const current = balances.get(transfer.from) ?? 0n;
          const next = current - transfer.value;
          if (next < 0n) {
            incomplete = true;
            break;
          }
          if (next === 0n) balances.delete(transfer.from);
          else balances.set(transfer.from, next);
        }
        if (transfer.to !== ZERO_ADDRESS) {
          balances.set(transfer.to, (balances.get(transfer.to) ?? 0n) + transfer.value);
        }
      }
    }
    holdersByDay.set(date, incomplete ? null : balances.size);
  }
  return holdersByDay;
}
