import { WalkerError } from "./errors.js";
import { rpcQuantity, toQuantity } from "./hex.js";
import type { Rpc } from "./rpc.js";
import type { Log } from "./walk.js";

/** Timestamp lookups in flight at once when a batch straddles a day boundary. */
const LOOKUPS_IN_FLIGHT = 8;

/** Fetches block timestamps once each and remembers them for the life of the cache. */
export interface BlockTimestampCache {
  /** Unix time in seconds of the block. */
  timestamp(blockNumber: number): Promise<number>;
  readonly size: number;
}

export function createBlockTimestampCache(rpc: Rpc): BlockTimestampCache {
  const known = new Map<number, Promise<number>>();
  return {
    get size() {
      return known.size;
    },
    timestamp(blockNumber) {
      let pending = known.get(blockNumber);
      if (!pending) {
        pending = rpc
          .call<{ timestamp?: unknown } | null>("eth_getBlockByNumber", [toQuantity(blockNumber), false])
          .then((header) => {
            if (!header) {
              throw new WalkerError("E_RPC", `eth_getBlockByNumber returned no block for ${blockNumber}`);
            }
            return rpcQuantity(header.timestamp, "eth_getBlockByNumber");
          });
        known.set(blockNumber, pending);
        pending.catch(() => known.delete(blockNumber));
      }
      return pending;
    },
  };
}

/** The UTC calendar day of a Unix timestamp in seconds, as `YYYY-MM-DD`. */
export function utcDay(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Groups logs by the UTC day of their block, keys sorted ascending.
 *
 * Only two timestamps are fetched when the earliest and latest block fall on the same day, which
 * is the common case for one chunk. Otherwise each distinct block is resolved once through the
 * cache, several lookups at a time.
 */
export async function groupByUtcDay(logs: readonly Log[], cache: BlockTimestampCache): Promise<Map<string, Log[]>> {
  const grouped = new Map<string, Log[]>();
  if (logs.length === 0) {
    return grouped;
  }
  let lowest = logs[0]!.blockNumber;
  let highest = lowest;
  for (const log of logs) {
    if (log.blockNumber < lowest) lowest = log.blockNumber;
    if (log.blockNumber > highest) highest = log.blockNumber;
  }
  const firstDay = utcDay(await cache.timestamp(lowest));
  const lastDay = lowest === highest ? firstDay : utcDay(await cache.timestamp(highest));

  if (firstDay === lastDay) {
    grouped.set(firstDay, [...logs]);
    return grouped;
  }
  const dayOfBlock = new Map<number, string>();
  await forEachConcurrently([...new Set(logs.map((log) => log.blockNumber))], LOOKUPS_IN_FLIGHT, async (blockNumber) => {
    dayOfBlock.set(blockNumber, utcDay(await cache.timestamp(blockNumber)));
  });
  for (const log of logs) {
    const day = dayOfBlock.get(log.blockNumber) as string;
    const bucket = grouped.get(day);
    if (bucket) {
      bucket.push(log);
    } else {
      grouped.set(day, [log]);
    }
  }
  return new Map([...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Runs `task` over `items` with at most `limit` in flight, in order of issue. After one task
 * fails, no further item is started: the failure is what the caller gets, and the endpoint is not
 * sent the rest of the list for a result nobody will read.
 */
async function forEachConcurrently<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      try {
        await task(items[next++] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
}
