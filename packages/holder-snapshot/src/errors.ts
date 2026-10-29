/**
 * Every failure this package raises carries a stable code, so callers can branch on it without
 * parsing messages. RPC failures from `@globalmpc/evm-log-walker` (its own `WalkerError` /
 * `RpcError`) pass through unchanged; these codes cover what this package adds on top.
 */
export type SnapshotErrorCode =
  /** A caller-supplied argument is not usable. */
  | "E_INVALID_ARGUMENT"
  /** A value shaped like an address is not a 20-byte hex address. */
  | "E_INVALID_ADDRESS"
  /** A token amount is not a valid decimal for the token's decimals. */
  | "E_INVALID_AMOUNT"
  /** A log shaped like a `Transfer` event did not decode. */
  | "E_MALFORMED_TRANSFER"
  /** An endpoint answered a call with something this package cannot read. */
  | "E_MALFORMED_RESPONSE"
  /** A balance went negative during replay: the history does not start at the token's creation. */
  | "E_INCOMPLETE_HISTORY"
  /** The replayed balances disagree with the token's own `balanceOf` or `totalSupply`. */
  | "E_UNVERIFIED"
  /** A saved snapshot file does not follow the documented format, or contradicts itself. */
  | "E_SNAPSHOT_FORMAT"
  /** The rules and pool leave no holder with a non-zero amount. */
  | "E_NOTHING_TO_PAY";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SnapshotError";
    this.code = code;
  }
}
