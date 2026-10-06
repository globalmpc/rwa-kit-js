import {
  collectLogs,
  createBlockTimestampCache,
  findCreationBlock,
  fromQuantity,
  groupByUtcDay,
  redactEndpoint,
  resolveBlock,
  utcDay,
  type BlockTag,
  type Hex,
  type Rpc,
} from "@globalmpc/evm-log-walker";
import { utcDateRange } from "./format.js";
import { computeHolderCounts } from "./metrics/holders.js";
import { splitGas } from "./metrics/gas.js";
import { computeReturnRate, type DayWallets } from "./metrics/retention.js";
import { countTransactions } from "./metrics/transactions.js";
import { activeWalletSet } from "./metrics/wallets.js";
import type { DayRecord, Report } from "./schema.js";
import { decodeTransfer, TRANSFER_TOPIC, type Transfer } from "./transfers.js";
import { fetchTransactionSummaries, type TxSummary } from "./tx.js";

// Bumped by hand alongside package.json's "version" at release time; recorded on every report so
// a reader knows which computation rules produced it.
const PACKAGE_VERSION = "0.1.0";

// The longest lookback retention uses (`return30d`), so the earliest day it needs before the first
// published day.
const RETENTION_LOOKBACK_DAYS = 30;

// Anything shaped like `scheme://...` inside a label, up to whitespace or a comma.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s,]+/gi;

export interface ReportOptions {
  rpc: Rpc;
  address: Hex;
  /**
   * How the endpoint (or endpoints) are named in the report. Every URL inside it is cut to its
   * origin before it is written, so a keyed URL never reaches the output, including one of several
   * listed together; plain text such as `"my node"` is kept as given.
   */
  sourceLabel: string;
  /** First block of the walk. Defaults to the contract's creation block, which needs an archive endpoint. */
  fromBlock?: number;
  /**
   * Set when an explicit `fromBlock` is the contract's creation block. Holders are only computed
   * when the walk is known to start there: `fromBlock` omitted (found by `findCreationBlock`) or
   * this flag set. Otherwise `holders` and `holdersAsOfBlock` are `null` for every day.
   *
   * The flag is trusted, not checked: verifying it would need the same archive-state lookup that
   * passing a stored creation block exists to avoid. A wrong claim is caught only if a balance
   * later goes negative, so pass it only for a block that came from `findCreationBlock`.
   */
  fromBlockIsCreation?: boolean;
  /** Last block, inclusive, or a tag resolved once at the start. Default `"finalized"`. */
  toBlock?: number | BlockTag;
  /** How many of the most recent UTC days to publish. Default 30. The walk always starts at `fromBlock`. */
  days?: number;
  /** Largest block span per `eth_getLogs` call, passed through to `evm-log-walker`. */
  chunkSize?: number;
  label?: string;
  /** Overrides the clock, in milliseconds since epoch. For tests only. */
  now?: () => number;
}

/**
 * Reads every `Transfer` log for `address` from `fromBlock` to `toBlock` and turns it into a
 * `Report`: daily transactions, active wallets, cumulative holders, 7-day and 30-day wallet
 * return, and the sponsored-vs-user-paid gas split, one entry per UTC day.
 *
 * Holders are replayed from `fromBlock` regardless of `days`, because a holder count is cumulative
 * since the contract's creation, not a per-day figure — see `metrics/holders.ts`. `days` only
 * trims how much of that computed history is included in the returned report. Holders are only
 * computed when the walk is known to start at the creation block (`fromBlock` omitted, or
 * `fromBlockIsCreation: true`): a replay that starts late can miss balances without any transfer
 * ever going negative, and would publish a plausible but too-low count. Otherwise
 * `holders`/`holdersAsOfBlock` are `null` for every day — every other figure (transactions, active
 * wallets, return rate, gas split) is unaffected.
 *
 * Days run from the first day with a `Transfer` log to the UTC day of `toBlock`, so quiet recent
 * days are published as empty days rather than dropped.
 */
export async function computeReport(options: ReportOptions): Promise<Report> {
  const { rpc } = options;
  const toBlock = await resolveBlock(rpc, options.toBlock ?? "finalized");
  const fromBlock = options.fromBlock ?? (await findCreationBlock(rpc, options.address)).blockNumber;
  const startsAtCreation = options.fromBlock === undefined || options.fromBlockIsCreation === true;
  const sourceLabel = options.sourceLabel.replace(URL_IN_TEXT, (url) => redactEndpoint(url));
  const chainId = fromQuantity(await rpc.call<unknown>("eth_chainId", []));

  const { logs } = await collectLogs({
    rpc,
    address: options.address,
    topics: [TRANSFER_TOPIC],
    fromBlock,
    toBlock,
    ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
  });

  const nowMs = (options.now ?? Date.now)();
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10);

  const cache = createBlockTimestampCache(rpc);
  const logsByDay = await groupByUtcDay(logs, cache);
  const lastDate = utcDay(await cache.timestamp(toBlock));
  const firstDate = logsByDay.keys().next().value ?? lastDate;
  const allDates = utcDateRange(firstDate, lastDate);

  const transfersByDay = new Map<string, Transfer[]>(
    allDates.map((date) => [date, (logsByDay.get(date) ?? []).map(decodeTransfer)]),
  );
  const holdersByDay = startsAtCreation
    ? computeHolderCounts(transfersByDay, allDates)
    : new Map<string, number | null>(allDates.map((date) => [date, null]));
  const holdersAsOfByDay = holdersAsOfBlocks(allDates, logsByDay, fromBlock);

  // Receipts are only needed for the published days and the window retention looks back over;
  // holders come from the logs alone.
  const windowDays = options.days ?? 30;
  const computedDates = allDates.slice(-(windowDays + RETENTION_LOOKBACK_DAYS));
  const txSummaries = await fetchTransactionSummaries(
    rpc,
    computedDates.flatMap((date) => hashesOf(logsByDay, date)),
  );

  const walletsByDay: DayWallets[] = computedDates.map((date) => ({
    date,
    wallets: activeWalletSet(hashesOf(logsByDay, date), txSummaries),
  }));
  const return7d = computeReturnRate(walletsByDay, 7);
  const return30d = computeReturnRate(walletsByDay, 30);

  const days = buildDayRecords({
    dates: computedDates,
    logsByDay,
    txSummaries,
    holdersByDay,
    holdersAsOfByDay,
    walletsByDay,
    return7d,
    return30d,
    todayUtc,
    sourceLabel,
  });

  return {
    package: "@globalmpc/dapp-stats",
    version: PACKAGE_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    chain: { chainId },
    contract: options.label !== undefined ? { address: options.address, label: options.label } : { address: options.address },
    days: days.slice(-windowDays),
  };
}

function hashesOf(logsByDay: DayLogs, date: string): Hex[] {
  return (logsByDay.get(date) ?? []).map((log) => log.transactionHash);
}

type DayLogs = ReadonlyMap<string, readonly { blockNumber: number; transactionHash: Hex }[]>;

/**
 * The last block the holder replay has incorporated as of the end of each date. A day with no
 * activity carries the previous day's block forward; before any activity it is `fromBlock`, which
 * the walk covered and found no transfers in.
 */
function holdersAsOfBlocks(dates: readonly string[], logsByDay: DayLogs, fromBlock: number): Map<string, number> {
  const result = new Map<string, number>();
  let lastKnownBlock = fromBlock;
  for (const date of dates) {
    for (const log of logsByDay.get(date) ?? []) {
      if (log.blockNumber > lastKnownBlock) lastKnownBlock = log.blockNumber;
    }
    result.set(date, lastKnownBlock);
  }
  return result;
}

interface BuildDaysInput {
  dates: readonly string[];
  logsByDay: DayLogs;
  txSummaries: ReadonlyMap<Hex, TxSummary>;
  holdersByDay: ReadonlyMap<string, number | null>;
  holdersAsOfByDay: ReadonlyMap<string, number>;
  walletsByDay: readonly DayWallets[];
  return7d: readonly (number | null)[];
  return30d: readonly (number | null)[];
  todayUtc: string;
  sourceLabel: string;
}

/** One `DayRecord` per date in `dates`, in order. */
function buildDayRecords(input: BuildDaysInput): DayRecord[] {
  const days: DayRecord[] = [];
  for (const [index, date] of input.dates.entries()) {
    const dayLogs = input.logsByDay.get(date) ?? [];
    const hashes = hashesOf(input.logsByDay, date);
    let blockRange: DayRecord["blockRange"] = null;
    if (dayLogs.length > 0) {
      let lowest = dayLogs[0]!.blockNumber;
      let highest = lowest;
      for (const log of dayLogs) {
        if (log.blockNumber < lowest) lowest = log.blockNumber;
        if (log.blockNumber > highest) highest = log.blockNumber;
      }
      blockRange = { fromBlock: lowest, toBlock: highest };
    }
    const holders = input.holdersByDay.get(date) ?? null;
    days.push({
      date,
      stage: date === input.todayUtc ? "provisional" : "final",
      blockRange,
      source: { rpc: input.sourceLabel, methods: ["eth_getLogs", "eth_getTransactionReceipt", "eth_getBlockByNumber"] },
      transactions: countTransactions(hashes),
      activeWallets: input.walletsByDay[index]!.wallets.size,
      holders,
      holdersAsOfBlock: holders === null ? null : (input.holdersAsOfByDay.get(date) ?? null),
      return7d: input.return7d[index] ?? null,
      return30d: input.return30d[index] ?? null,
      gas: splitGas(hashes, input.txSummaries),
    });
  }
  return days;
}
