/**
 * Every failure this package raises carries a stable code, so callers can branch on it without
 * parsing messages. RPC failures from `@globalmpc/evm-log-walker` (its own `WalkerError` /
 * `RpcError`) pass through unchanged; these codes cover what this package adds on top.
 */
export type StatsErrorCode =
  /** A caller-supplied argument is not usable. */
  | "E_INVALID_ARGUMENT"
  /** A log shaped like a `Transfer` event did not decode: wrong topic count or a malformed address. */
  | "E_MALFORMED_TRANSFER"
  /** A transaction or receipt the endpoint returned is missing a field this package needs. */
  | "E_MALFORMED_TX";

export class StatsError extends Error {
  readonly code: StatsErrorCode;

  constructor(code: StatsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StatsError";
    this.code = code;
  }
}

