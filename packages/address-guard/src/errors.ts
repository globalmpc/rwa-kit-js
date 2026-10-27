/**
 * Every failure this package raises carries a stable code, so callers can branch on it without
 * parsing messages. RPC failures from `@globalmpc/evm-log-walker` (its own `WalkerError` /
 * `RpcError`) pass through unchanged; these codes cover what this package adds on top.
 */
export type GuardErrorCode =
  /** A caller-supplied argument is not usable. */
  | "E_INVALID_ARGUMENT"
  /** A value shaped like an address is not a 20-byte hex address. */
  | "E_INVALID_ADDRESS"
  /** A log shaped like a `Transfer` event did not decode: wrong topic count or a malformed field. */
  | "E_MALFORMED_TRANSFER"
  /** A transaction the endpoint returned is missing, or is missing a field this package needs. */
  | "E_MALFORMED_TX"
  /** The payout file does not follow the documented format. */
  | "E_PAYOUT_FORMAT"
  /** No history source could answer, so no verdict can be given. */
  | "E_NO_SOURCE"
  /** More transfers involve the owner than the configured cap allows to be held at once. */
  | "E_TOO_MANY_EVENTS";

export class GuardError extends Error {
  readonly code: GuardErrorCode;

  constructor(code: GuardErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuardError";
    this.code = code;
  }
}
