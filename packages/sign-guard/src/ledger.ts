import type { Spend } from "./decision.js";

/**
 * Where window spends are recorded. The default keeps them in memory, which is exact for one
 * signing process. Several processes signing with the same key need one shared ledger (a database
 * row with a lock, a Redis script), or each process enforces the window on its own share only.
 *
 * Every spend for one key carries the same `durationMs`. A ledger should refuse (throw) when a key
 * arrives with a different one: pruning by one length would erase what a longer window still counts.
 * The guard turns a throw into a `ledger.failed` refusal.
 */
export interface SpendLedger {
  /**
   * Records `spend` at time `at` when the window still has room, and reports whether it did. Must
   * be atomic: two reservations racing for the last room in a window cannot both succeed. Anything
   * but exactly `true` or `false` is refused as `ledger.failed`.
   */
  reserve(spend: Spend, at: number): Promise<boolean> | boolean;
  /** Takes back a reservation made at `at`, after the signature it was made for was not produced. */
  release(spend: Spend, at: number): Promise<void> | void;
}

interface Entry {
  at: number;
  amount: bigint;
}

/**
 * A ledger in this process's memory. Restarting the process empties it. While a key has entries still
 * counting, it is bound to their window length, and a spend for it with another length throws; so
 * guards that share a ledger and scope must give a shared key the same window.
 */
export function createMemoryLedger(): SpendLedger {
  const entries = new Map<string, Entry[]>();
  const lengths = new Map<string, number>();
  return {
    reserve(spend, at) {
      // Expire under the length the key is bound to; a key with nothing left counting is free again.
      const bound = lengths.get(spend.key) ?? spend.durationMs;
      const kept = (entries.get(spend.key) ?? []).filter((entry) => entry.at > at - bound);
      if (kept.length > 0 && bound !== spend.durationMs) {
        throw new Error(`ledger key ${spend.key} is used with windows of ${bound} ms and ${spend.durationMs} ms; give it one length`);
      }
      const used = kept.reduce((sum, entry) => sum + entry.amount, 0n);
      if (used + spend.amount > spend.max) {
        entries.set(spend.key, kept);
        if (kept.length === 0) lengths.delete(spend.key);
        return false;
      }
      kept.push({ at, amount: spend.amount });
      entries.set(spend.key, kept);
      lengths.set(spend.key, spend.durationMs);
      return true;
    },
    release(spend, at) {
      const list = entries.get(spend.key);
      if (list === undefined) return;
      const index = list.findIndex((entry) => entry.at === at && entry.amount === spend.amount);
      if (index !== -1) list.splice(index, 1);
    },
  };
}
