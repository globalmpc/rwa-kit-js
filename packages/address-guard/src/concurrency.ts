import { GuardError } from "./errors.js";

/**
 * Runs `task` over `items` with at most `limit` in flight. After one task fails, no further item
 * is started: the failure is what the caller gets, and the endpoint is not sent the rest of the
 * list for a result nobody will read.
 *
 * Copied from `@globalmpc/transfer-ledger`, which uses the same shape for receipt fetches. It is
 * eleven lines; depending on a payout reconciler to get them would be the larger cost.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  // A limit of zero or less would build no workers at all, and the function would resolve as
  // though every item had been handled. For an exported helper whose callers decide the limit,
  // silently doing nothing is the worst available outcome.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new GuardError("E_INVALID_ARGUMENT", `concurrency limit must be a positive integer, got ${String(limit)}`);
  }
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
}
