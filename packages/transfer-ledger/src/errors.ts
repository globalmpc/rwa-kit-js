/**
 * Every failure this package raises carries a stable code, so callers can branch on it without
 * parsing messages. RPC failures from `@globalmpc/evm-log-walker` (its own `WalkerError` /
 * `RpcError`) pass through unchanged; these codes cover what this package adds on top.
 */
export type LedgerErrorCode =
  /** A caller-supplied argument is not usable. */
  | "E_INVALID_ARGUMENT"
  /** The intent file (or a saved transfers file) does not follow the documented format. */
  | "E_INTENT_FORMAT"
  /** A log shaped like a `Transfer` event did not decode: wrong topic count or a malformed field. */
  | "E_MALFORMED_TRANSFER"
  /** A receipt the endpoint returned is missing, or is missing a field this package needs. */
  | "E_MALFORMED_TX";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LedgerError";
    this.code = code;
  }
}
