import type { Hex } from "@globalmpc/evm-log-walker";
import { floorTo } from "../format.js";

export interface DayWallets {
  date: string;
  wallets: ReadonlySet<Hex>;
}

/**
 * For each day, the fraction of that day's wallets also seen in the preceding `windowDays` days.
 * `null` when there are fewer than `windowDays` prior days in `days` (the report does not reach
 * back far enough to answer yet — this is most days near a contract's creation) or when the day
 * itself had no active wallets to measure a return rate for.
 *
 * `days` must be contiguous ascending UTC calendar days, including empty days, so that "the
 * preceding `windowDays` days" lines up with real calendar time rather than skipping gaps.
 */
export function computeReturnRate(days: readonly DayWallets[], windowDays: number): (number | null)[] {
  return days.map((_, index) => {
    if (index < windowDays) return null;
    const today = days[index]!.wallets;
    if (today.size === 0) return null;
    const priorWallets = new Set<Hex>();
    for (let i = index - windowDays; i < index; i++) {
      for (const wallet of days[i]!.wallets) priorWallets.add(wallet);
    }
    let returning = 0;
    for (const wallet of today) {
      if (priorWallets.has(wallet)) returning++;
    }
    return floorTo(returning / today.size, 3);
  });
}
