import type { RequestKind, SignRequest } from "./request.js";

/** Why a request was allowed or refused. Stable identifiers, safe to alert and count on. */
export type RuleId =
  | "allowed"
  | "hash.denied"
  | "method.unknown"
  | "chain.not-allowed"
  | "transaction.malformed"
  | "transaction.custom-serializer"
  | "transaction.input-field"
  | "transaction.type-not-allowed"
  | "transaction.creation-not-allowed"
  | "transaction.value-over-limit"
  | "transaction.target-not-allowed"
  | "transaction.function-not-allowed"
  | "transaction.authorization-list"
  | "token.malformed-transfer"
  | "token.amount-over-limit"
  | "token.recipient-not-allowed"
  | "authorization.malformed"
  | "authorization.chain-zero"
  | "authorization.delegate-not-allowed"
  | "typed-data.malformed"
  | "typed-data.not-allowed"
  | "message.raw"
  | "message.not-allowed"
  | "window.exceeded"
  | "audit.failed"
  | "clock.invalid"
  | "ledger.failed"
  | "request.malformed";

/** Plain values describing the request, for logs and alerts. Never contains key material. */
export type Summary = Readonly<Record<string, string | number | boolean | null>>;

/**
 * An amount counted against a sliding window. Native value and token amounts are in base units;
 * authorizations count 1 each.
 */
export interface Spend {
  /**
   * The ledger key: `native:56`, `token:56:0x…`, `authorization` or `reset`, after the guard's
   * `scope` prefix if one is set.
   */
  key: string;
  amount: bigint;
  durationMs: number;
  max: bigint;
}

/** The outcome of the policy alone, before any window is consulted. */
export interface Verdict {
  allowed: boolean;
  rule: RuleId;
  reason: string;
  summary: Summary;
  /** What an allowed request would count against its windows. Empty when refused. */
  spends: readonly Spend[];
}

/** The final answer for one request, after windows were checked and reserved. */
export interface Decision {
  allowed: boolean;
  kind: RequestKind;
  rule: RuleId;
  reason: string;
  summary: Summary;
  /** When the decision was made, in milliseconds since the epoch. */
  at: number;
  /** Window amounts reserved for this request. Empty when refused. */
  reservations: readonly Spend[];
  /**
   * The request as it was judged: the signable fields, copied once. Sign this, never the object that
   * was passed to `check`. It holds calldata and typed-data messages; log `summary` instead if those
   * must not reach your logs.
   */
  request: SignRequest;
}
