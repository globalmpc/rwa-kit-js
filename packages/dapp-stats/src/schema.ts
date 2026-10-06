import type { Hex } from "@globalmpc/evm-log-walker";

export interface BlockRange {
  fromBlock: number;
  toBlock: number;
}

export interface Source {
  /**
   * The RPC endpoint the figures came from, as an origin only (scheme, host, port), never a full
   * URL with a key in it. With fallbacks configured, every endpoint that may have answered, comma
   * separated, since the client can fail over between them call by call.
   */
  rpc: string;
  /** JSON-RPC methods this day's figures were computed from. */
  methods: readonly string[];
}

/**
 * `"final"`: the day's calendar date has fully elapsed, so no further log for it can appear.
 * `"provisional"`: this is the current UTC day; more activity may still land in it.
 */
export type DayStage = "final" | "provisional";

export interface GasSplit {
  sponsored: number;
  userPaid: number;
}

export interface DayRecord {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  stage: DayStage;
  /**
   * The block span this day's `transactions`, `activeWallets` and `gas` were computed from.
   * `null` when the day had zero on-chain activity: there is no range to report, not a range of
   * zero blocks.
   */
  blockRange: BlockRange | null;
  source: Source;
  transactions: number;
  activeWallets: number;
  /**
   * Distinct addresses holding a non-zero balance, replayed from every `Transfer` since the
   * contract's creation up to and including `blockRange`'s (or the prior day's) last block.
   * `null` on every day when the walk is not known to start at the contract's creation block
   * (an explicit `fromBlock` without `fromBlockIsCreation`), and from the first day a transfer
   * spends a balance the replay never saw arrive — a count would be wrong rather than merely
   * incomplete, so it is withheld rather than shown wrong.
   */
  holders: number | null;
  /** The block `holders` is a count as of. `null` exactly when `holders` is `null`. */
  holdersAsOfBlock: number | null;
  /**
   * Fraction (0..1) of `activeWallets` also seen active in the preceding 7 (or 30) UTC days.
   * `null` when the report does not cover a full window of prior days yet (for example, the
   * first week after the contract's creation) or when `activeWallets` is zero that day.
   */
  return7d: number | null;
  return30d: number | null;
  gas: GasSplit;
}

export interface Report {
  package: "@globalmpc/dapp-stats";
  /** This package's own version, so a reader knows which computation rules produced the report. */
  version: string;
  /** When this report was generated, ISO 8601. */
  generatedAt: string;
  chain: { chainId: number };
  contract: { address: Hex; label?: string };
  /** Ascending by date. Only the requested lookback window; the walk itself may go back further. */
  days: DayRecord[];
}
