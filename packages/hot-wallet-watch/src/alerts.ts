import type { Address } from "./hex.js";

export type AlertKind =
  /** The wallet carries an EIP-7702 delegation to a contract not in its `delegates`. */
  | "delegated"
  /** Contract code appeared at an address that should have none. */
  | "unexpected-code"
  /** The nonce is above what your own system sent, or a frozen wallet's nonce rose: someone else signed. */
  | "unexpected-nonce"
  /** More native value or tokens left the wallet within the window than its outflow cap allows. */
  | "outflow"
  /** No configured endpoint could read this wallet, so it is not being watched this pass. */
  | "wallet-unreadable"
  /** No endpoint answered at all: nothing is being watched this pass. */
  | "no-endpoint"
  /** No endpoint could read a watched token's balance this pass, so its outflow cap is not watched. */
  | "token-unreadable"
  /** Endpoints answered differently about the same block. */
  | "endpoints-disagree"
  /** One endpoint failed or answered something malformed; others still decided. */
  | "endpoint-failed"
  /** One endpoint's head is more than `maxLagBlocks` behind the newest. It is still read, and can still raise the alarm. */
  | "endpoint-lagging"
  /** `expectedNonce` threw, took more than 10 seconds, or returned something other than a whole number. */
  | "expected-nonce-failed";

/** `critical` means a takeover may be under way; `warning` means the watch itself is degraded. */
export type Severity = "critical" | "warning";

export interface Alert {
  kind: AlertKind;
  severity: Severity;
  /** The wallet concerned, or null for an alert about the endpoints as a whole. */
  wallet: { address: Address; label: string } | null;
  /** The block the reading was taken at, or null when no block could be agreed. */
  block: number | null;
  message: string;
  /** Endpoints that saw it, by position (`endpoint-1`, …): a host can itself carry a key. */
  observedBy: readonly string[];
  /** Plain values for routing and dashboards: the delegate, the token, amounts as decimal strings. */
  detail: Readonly<Record<string, string | number | boolean | null>>;
}

export const SEVERITY: Readonly<Record<AlertKind, Severity>> = {
  delegated: "critical",
  "unexpected-code": "critical",
  "unexpected-nonce": "critical",
  outflow: "critical",
  "wallet-unreadable": "critical",
  "no-endpoint": "critical",
  "token-unreadable": "critical",
  "endpoints-disagree": "warning",
  "endpoint-failed": "warning",
  "endpoint-lagging": "warning",
  "expected-nonce-failed": "warning",
};
