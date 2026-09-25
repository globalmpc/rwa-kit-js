import { RpcError, WalkerError } from "./errors.js";

/** A minimal JSON-RPC client. Every function in this package takes one. */
export interface Rpc {
  call<T = unknown>(method: string, params: readonly unknown[]): Promise<T>;
  /** The endpoints in the order they were given. */
  readonly urls: readonly string[];
}

/** An endpoint with headers that are sent to it alone. A credential belongs here, on the one endpoint that needs it. */
export interface Endpoint {
  url: string;
  headers?: Record<string, string>;
}

export interface RpcOptions {
  /**
   * One or more HTTP JSON-RPC endpoints, tried in order; later ones are used when an earlier one
   * stops answering. A plain string is an endpoint without headers of its own.
   */
  urls: string | Endpoint | readonly (string | Endpoint)[];
  /** Replacement for the global `fetch`, for tests and custom transports. */
  fetch?: typeof globalThis.fetch;
  /**
   * Headers sent to every endpoint, overriding the defaults `content-type: application/json` and
   * a `user-agent` naming this package (some public endpoints refuse requests without one).
   * Never put a credential here: it would reach every endpoint in the list, including a public
   * fallback. Put it on the `Endpoint` instead.
   */
  headers?: Record<string, string>;
  /** Extra attempts per endpoint after a transport failure. Default 2, so three attempts each. */
  retries?: number;
  /**
   * Wait before the first retry, doubled for each further one. Default 500 ms. An HTTP 429 with a
   * `Retry-After` header waits that long instead, up to 30 s.
   */
  backoffMs?: number;
  /** Time allowed for one request. Default 30 000 ms. */
  timeoutMs?: number;
}

const USER_AGENT = "@globalmpc/evm-log-walker";

/** An endpoint after the shared and own headers have been merged. */
interface ResolvedEndpoint {
  url: string;
  headers: Record<string, string>;
}

interface Answer {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  /** Set when the endpoint refused with an HTTP 4xx. */
  httpStatus?: number;
}

/**
 * Creates a client that fails over between endpoints on transport failures (network errors,
 * 5xx, 408 and 429 responses, timeouts, malformed bodies, redirects) and stays on the endpoint
 * that last answered.
 *
 * A JSON-RPC error response is not a transport failure. It is returned to the caller as an
 * `RpcError` without trying the next endpoint, because it describes what this endpoint will and
 * will not serve, and the walker adapts to exactly that.
 */
export function createRpc(options: RpcOptions): Rpc {
  const shared = mergeHeaders({ "content-type": "application/json", "user-agent": USER_AGENT }, options.headers);
  const endpoints: ResolvedEndpoint[] = toEndpoints(options.urls).map((endpoint) => ({
    url: endpoint.url,
    headers: mergeHeaders(shared, endpoint.headers),
  }));
  const urls = endpoints.map((endpoint) => endpoint.url);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let preferred = 0;
  let nextId = 0;

  async function request(endpoint: ResolvedEndpoint, method: string, params: readonly unknown[]): Promise<Answer> {
    const response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect is not followed. `fetch` would replay the request at the new location with
      // its headers, dropping only `authorization` when the origin changes, so a credential in
      // any other header would reach a third party. An endpoint that moved is configured anew.
      redirect: "manual",
    });
    if (isRedirect(response)) {
      throw new Redirected();
    }
    const text = await response.text();
    const body = parseJsonObject(text);
    if (!response.ok) {
      if (response.status === 429) {
        throw new RateLimited(retryAfterMs(response.headers.get("retry-after")));
      }
      if (!isRefusalStatus(response.status)) {
        throw new Error(`HTTP ${response.status}`);
      }
      // Some endpoints send a refusal as a 4xx carrying a JSON-RPC error body. Keep both.
      const error = body?.error ?? { message: `HTTP ${response.status}${text ? ` ${text}` : ""}` };
      return { error, httpStatus: response.status };
    }
    if (!body) {
      throw new Error("response body is not a JSON object");
    }
    return body;
  }

  return {
    urls,
    async call<T>(method: string, params: readonly unknown[]): Promise<T> {
      let lastCause: unknown;
      let lastUrl = urls[preferred] as string;
      let attempts = 0;
      for (let offset = 0; offset < endpoints.length; offset++) {
        const index = (preferred + offset) % endpoints.length;
        const endpoint = endpoints[index] as ResolvedEndpoint;
        const url = endpoint.url;
        lastUrl = url;
        for (let attempt = 0; attempt <= retries; attempt++) {
          let answer: Answer;
          attempts++;
          try {
            answer = await request(endpoint, method, params);
          } catch (cause) {
            lastCause = cause;
            if (cause instanceof Redirected) {
              // Deterministic: the same request would be redirected again. On to the next endpoint.
              break;
            }
            if (attempt < retries) {
              await sleep(cause instanceof RateLimited && cause.retryAfterMs !== undefined ? cause.retryAfterMs : backoffMs * 2 ** attempt);
            }
            continue;
          }
          if (answer.error) {
            const details: ConstructorParameters<typeof RpcError>[0] = {
              method,
              url: redactEndpoint(url),
              endpoint: { index: index + 1, count: endpoints.length },
              message: answer.error.message ?? "unknown JSON-RPC error",
              cause: answer.error,
            };
            if (typeof answer.error.code === "number") {
              details.rpcCode = answer.error.code;
            }
            if (answer.httpStatus !== undefined) {
              details.httpStatus = answer.httpStatus;
            }
            throw new RpcError(details);
          }
          preferred = index;
          return answer.result as T;
        }
      }
      throw new RpcError({
        method,
        url: redactEndpoint(lastUrl),
        message: `no endpoint answered after ${attempts} attempt${attempts === 1 ? "" : "s"} (${describe(lastCause)})`,
        cause: lastCause,
      });
    },
  };
}

/**
 * The endpoint as it appears in every message and in `RpcError.url`: its origin only, that is
 * scheme, host and port. The path, query string, fragment and userinfo are dropped, because
 * keyed providers put credentials in any of them and a rule that guesses which path segments
 * are secret is a rule with misses. When several endpoints share an origin, messages name the
 * endpoint by its position in the list.
 */
export function redactEndpoint(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<invalid url>";
  }
}

function toEndpoints(urls: RpcOptions["urls"]): Endpoint[] {
  const given: readonly (string | Endpoint)[] = typeof urls === "string" || !isReadonlyArray(urls) ? [urls] : urls;
  if (given.length === 0) {
    throw new WalkerError("E_INVALID_ARGUMENT", "createRpc needs at least one endpoint URL");
  }
  return given.map((entry, index) => {
    const endpoint: Endpoint = typeof entry === "string" ? { url: entry } : entry;
    if (!isHttpUrl(endpoint.url)) {
      // Named by position, not echoed: the string may hold a credential, and this message reaches logs.
      throw new WalkerError(
        "E_INVALID_ARGUMENT",
        `endpoint ${index + 1} of ${given.length} is not an http(s) URL (include the scheme, for example https://)`,
      );
    }
    return endpoint;
  });
}

/**
 * Whether `value` is an `http:` or `https:` URL. `new URL` alone is not enough: `localhost:8545`
 * parses, with `localhost` as its scheme, and would then fail as a transport error.
 */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isReadonlyArray(value: unknown): value is readonly (string | Endpoint)[] {
  return Array.isArray(value);
}

/** Later layers win. Names are lower-cased so `Content-Type` and `content-type` cannot both be sent. */
function mergeHeaders(...layers: (Record<string, string> | undefined)[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      merged[name.toLowerCase()] = value;
    }
  }
  return merged;
}

/** An HTTP status that states a decision about the request rather than a temporary condition. */
function isRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const MAX_RETRY_AFTER_MS = 30_000;

class RateLimited extends Error {
  constructor(readonly retryAfterMs: number | undefined) {
    super("HTTP 429");
  }
}

class Redirected extends Error {
  constructor() {
    super("the endpoint answered with a redirect, which this client does not follow; configure its new location instead");
  }
}

/**
 * A redirect under `redirect: "manual"`: Node hands back the 3xx response itself, a browser an
 * `opaqueredirect` response with status 0. Judged by the response, not by an error's wording.
 */
function isRedirect(response: Response): boolean {
  return (response.status >= 300 && response.status < 400) || response.type === "opaqueredirect";
}

/** Reads a `Retry-After` given in seconds. A date form or an absent header yields undefined. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Math.min(Number(header) * 1_000, MAX_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonObject(text: string): Answer | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Answer) : undefined;
  } catch {
    return undefined;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
