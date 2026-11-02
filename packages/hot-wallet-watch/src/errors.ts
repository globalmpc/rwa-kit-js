export type WatchErrorCode =
  /** An option or wallet spec is malformed. Nothing is watched under a configuration that could not be read. */
  "E_INVALID_ARGUMENT";

export class WatchError extends Error {
  override readonly name = "WatchError";
  readonly code: WatchErrorCode;

  constructor(code: WatchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
