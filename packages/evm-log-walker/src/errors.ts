/**
 * Every failure this package raises carries a stable code, so callers can branch on it
 * without parsing messages. Messages are written for a person reading a log.
 */
export type WalkerErrorCode =
  /** The transport failed on every endpoint, or an endpoint returned a JSON-RPC error. */
  | "E_RPC"
  /** The endpoint refused `eth_getLogs` for this filter even at the smallest chunk size. */
  | "E_LOGS_UNAVAILABLE"
  /** The endpoint has no historical state, so `eth_getCode` at a past block cannot be answered. */
  | "E_NO_ARCHIVE_STATE"
  /** No contract code exists at the address within the searched range. */
  | "E_NO_CODE"
  /** A caller-supplied argument is not usable. */
  | "E_INVALID_ARGUMENT";

export class WalkerError extends Error {
  readonly code: WalkerErrorCode;

  constructor(code: WalkerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WalkerError";
    this.code = code;
  }
}

export interface RpcErrorDetails {
  method: string;
  /** The endpoint's origin only (see `redactEndpoint`), so the error is safe to log. */
  url: string;
  /** Which endpoint of the client's list, for messages, when there is more than one. */
  endpoint?: { index: number; count: number };
  /**
   * What went wrong, without the method and endpoint. Provider text is sanitised before it is
   * embedded: control characters removed, whitespace collapsed, length capped.
   */
  message: string;
  /** The `error.code` of a JSON-RPC error response. Absent for transport failures. */
  rpcCode?: number;
  /** The HTTP status when the endpoint refused the request without a JSON-RPC body. */
  httpStatus?: number;
  cause?: unknown;
}

/** A JSON-RPC request that did not produce a result. */
export class RpcError extends WalkerError {
  readonly method: string;
  /** The endpoint's origin only, never its path or query, so the error is safe to log. */
  readonly url: string;
  readonly rpcCode: number | undefined;
  readonly httpStatus: number | undefined;
  /** The endpoint's own wording, or the transport failure, without the method and endpoint. */
  readonly detail: string;

  constructor(details: RpcErrorDetails) {
    const detail = sanitizeProviderText(details.message);
    const which =
      details.endpoint && details.endpoint.count > 1
        ? ` (endpoint ${details.endpoint.index} of ${details.endpoint.count})`
        : "";
    super("E_RPC", `${details.method} failed at ${details.url}${which}: ${detail}`, {
      cause: details.cause,
    });
    this.name = "RpcError";
    this.method = details.method;
    this.url = details.url;
    this.rpcCode = details.rpcCode;
    this.httpStatus = details.httpStatus;
    this.detail = detail;
  }

  /**
   * True when the endpoint answered and declined: a JSON-RPC error, or an HTTP 4xx other than
   * 408 and 429. Everything else (network errors, timeouts, 5xx, 408, 429) is a transport failure
   * that the client already retried and failed over.
   */
  get refused(): boolean {
    return this.rpcCode !== undefined || this.httpStatus !== undefined;
  }
}

/** A value an endpoint sent, as JSON, made fit for a message the way `sanitizeProviderText` does. */
export function describeProviderValue(value: unknown): string {
  return sanitizeProviderText(String(JSON.stringify(value)));
}

const MAX_PROVIDER_TEXT = 200;

/**
 * Makes text an endpoint sent fit for a single log line: control characters and Unicode line
 * separators become spaces, whitespace collapses, and anything past 200 characters is dropped
 * with a marker. An endpoint can then neither forge log lines nor flood a log.
 */
export function sanitizeProviderText(text: string): string {
  const flat = text
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_PROVIDER_TEXT ? `${flat.slice(0, MAX_PROVIDER_TEXT)} [truncated]` : flat;
}
