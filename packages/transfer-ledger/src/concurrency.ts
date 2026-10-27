/**
 * Runs `task` over `items` with at most `limit` in flight. After one task fails, no further item
 * is started: the failure is what the caller gets, and the endpoint is not sent the rest of the
 * list for a result nobody will read.
 */
export async function forEachConcurrently<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
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
