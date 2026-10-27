import type { Address, Hex } from "./hex.js";

/** Which way the owner's balance moved in one event. */
export type Direction = "in" | "out";

/**
 * One transfer involving the owner, as a history source reports it.
 *
 * `counterparty` and `txFrom` are different things and the difference is the point of this
 * package: `counterparty` comes from the event's indexed topics, which anyone can make name any
 * account, while `txFrom` is the transaction's own sender. See
 * `deriveTrustedRecipients`.
 */
export interface HistoryEvent {
  /** The account whose history this is. */
  owner: Address;
  /** The other side of the transfer, from the event's topics. Not proof of who sent it. */
  counterparty: Address;
  direction: Direction;
  /** Token base units, never a decimal string. Zero is a real value and is reported as such. */
  valueRaw: bigint;
  /** `false` for a reverted transaction: it moved nothing. */
  success: boolean;
  /** The transaction's own sender, from `eth_getTransactionByHash`. */
  txFrom: Address;
  /**
   * The transaction's target — what the owner's signature actually called.
   *
   * `txFrom` alone says the owner signed something; it does not say what. A transaction to a
   * contract the owner has approved can move a real token to a recipient the owner never saw.
   */
  txTo?: Address;
  /**
   * The recipient named in the transaction's own calldata, when that calldata is exactly an
   * ERC-20 `transfer(address,uint256)` call — and `undefined` for every other shape.
   *
   * This is the only field that evidences a *choice*. The address is in the bytes the owner
   * signed, so a wallet showed it to them before they approved it.
   */
  txTransferTo?: Address;
  txHash: Hex;
  blockNumber: bigint;
  /** The token contract. Absent for a native-coin transfer. */
  token?: Address;
}

/**
 * Where a set of events came from, and over which blocks. Attached to every result this package
 * returns, including every `--json` payload, so a figure can always be traced back.
 *
 * `fromBlock` and `toBlock` are numbers, matching `WalkOptions` in `@globalmpc/evm-log-walker`;
 * `HistoryEvent.blockNumber` is a `bigint` because it is part of this package's own data model.
 */
export interface SourceInfo {
  kind: "indexer" | "rpc";
  /**
   * Origin of the **first endpoint configured** for this fetch, passed through `redactEndpoint`
   * so a keyed URL never reaches a log.
   *
   * Not necessarily the endpoint that answered: `Rpc` fails over between endpoints and keeps the
   * one that last answered as its preferred, but does not expose which that is. When several were
   * configured, read `endpoints` instead of treating this as the answering host.
   */
  endpoint: string;
  /** Every endpoint configured for this fetch, by origin, in the order given. */
  endpoints: readonly string[];
  /** The range this answer was **asked for**, after any clamping the source applied. */
  fromBlock: number;
  toBlock: number;
  /**
   * The range the source can **independently vouch for having indexed**, when it knows one.
   *
   * This is deliberately not the same thing as `fromBlock`/`toBlock`. Those echo the query; this
   * is a claim about the source's own completeness, and only a source that can actually establish
   * it — an indexer exposing its indexed head, for example — may set it. `rpcLogSource` never
   * does: it asks a node for a range and reports what came back, which says nothing about whether
   * anything was missed.
   *
   * `indexerThenRpc` requires this field before it will trust an indexer over RPC. Without it,
   * comparing the echoed query range against the requested range is a tautology.
   */
  coverage?: { fromBlock: number; toBlock: number };
}

/** Events plus their provenance. Every `HistorySource` returns this shape. */
export interface History {
  events: HistoryEvent[];
  source: SourceInfo;
}

/** An inclusive block range. Omit to let the source choose its own bounds. */
export interface BlockRange {
  fromBlock: number;
  toBlock?: number;
}

/** Anything that can supply an owner's transfer history. Implemented by rpcLogSource and friends. */
export interface HistorySource {
  fetch(owner: Address, range?: BlockRange): Promise<History>;
}
