import { describe, expect, it } from "vitest";
import { RpcError, WalkerError } from "../src/errors.js";
import { fromQuantity } from "../src/hex.js";
import { createRpc, redactEndpoint } from "../src/rpc.js";
import { createFakeChain } from "./fake-chain.js";

describe("createRpc", () => {
  it("fails over after transport failures and stays on the endpoint that answered", async () => {
    const chain = createFakeChain({ head: 10, transportFailures: { "http://a": 2 } });
    const rpc = createRpc({ urls: ["http://a", "http://b"], fetch: chain.fetch, retries: 1, backoffMs: 1 });

    expect(fromQuantity(await rpc.call("eth_blockNumber", []))).toBe(10);
    expect(chain.calls.map((call) => call.url)).toEqual(["http://a", "http://a", "http://b"]);

    await rpc.call("eth_blockNumber", []);
    expect(chain.calls.at(-1)?.url).toBe("http://b");
  });

  it("returns a JSON-RPC error as RpcError without trying another endpoint", async () => {
    const chain = createFakeChain({ head: 100_000, maxLogSpan: 1_000 });
    const rpc = createRpc({ urls: ["http://a", "http://b"], fetch: chain.fetch });

    const failure = await rpc
      .call("eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x2710" }])
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcError);
    const rpcError = failure as RpcError;
    expect(rpcError.code).toBe("E_RPC");
    expect(rpcError.rpcCode).toBe(-32000);
    expect(rpcError.method).toBe("eth_getLogs");
    expect(rpcError.url).toBe("http://a");
    expect(rpcError.message).toContain("exceed maximum block range");
    expect(rpcError.detail).toBe("exceed maximum block range: 1000");
    expect(chain.calls).toHaveLength(1);
  });

  it("throws E_RPC naming the attempts when no endpoint answers", async () => {
    const chain = createFakeChain({ transportFailures: { "http://a": 99, "http://b": 99 } });
    const rpc = createRpc({ urls: ["http://a", "http://b"], fetch: chain.fetch, retries: 1, backoffMs: 1 });

    await expect(rpc.call("eth_blockNumber", [])).rejects.toMatchObject({
      code: "E_RPC",
      message: expect.stringContaining("no endpoint answered after 4 attempts"),
    });
    expect(chain.calls).toHaveLength(4);
  });

  it("surfaces an HTTP 4xx as a refusal with its status, without retrying or failing over", async () => {
    const chain = createFakeChain({ head: 100_000, httpRefusal: { aboveSpan: 1_000, status: 403, body: "archive spans need a token" } });
    const rpc = createRpc({ urls: ["http://a", "http://b"], fetch: chain.fetch, retries: 1 });

    const failure = await rpc
      .call("eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x2710" }])
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcError);
    expect(failure as RpcError).toMatchObject({ httpStatus: 403, rpcCode: undefined, refused: true, url: "http://a" });
    expect((failure as RpcError).detail).toBe("HTTP 403 archive spans need a token");
    expect(chain.calls).toHaveLength(1);
  });

  it("reads a JSON-RPC error carried by an HTTP 4xx, keeping both the code and the status", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "Archive requests require a personal token" } });
    const chain = createFakeChain({ head: 100_000, httpRefusal: { aboveSpan: 1_000, status: 403, body } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const failure = await rpc
      .call("eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x2710" }])
      .then(() => null, (error: unknown) => error);

    expect(failure as RpcError).toMatchObject({ httpStatus: 403, rpcCode: -32602, refused: true });
    expect((failure as RpcError).detail).toBe("Archive requests require a personal token");
  });

  it("waits before retrying, doubling the wait each time", async () => {
    const chain = createFakeChain({ head: 10, transportFailures: { "http://a": 2 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch, retries: 2, backoffMs: 20 });
    const started = Date.now();

    expect(fromQuantity(await rpc.call("eth_blockNumber", []))).toBe(10);

    expect(Date.now() - started).toBeGreaterThanOrEqual(20 + 40 - 2);
    expect(chain.calls).toHaveLength(3);
  });

  it("retries an HTTP 429 after its Retry-After", async () => {
    const chain = createFakeChain({ head: 10, rateLimits: { "http://a": { times: 1, retryAfter: "0" } } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch, retries: 1, backoffMs: 5_000 });
    const started = Date.now();

    expect(fromQuantity(await rpc.call("eth_blockNumber", []))).toBe(10);

    // Retry-After: 0 wins over the 5 s backoff.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(chain.calls).toHaveLength(2);
  });

  it("treats a 5xx response as a transport failure", async () => {
    const fetchImpl: typeof globalThis.fetch = async () => new Response("busy", { status: 503 });
    const rpc = createRpc({ urls: "http://a", fetch: fetchImpl, retries: 0 });

    await expect(rpc.call("eth_blockNumber", [])).rejects.toMatchObject({
      code: "E_RPC",
      message: expect.stringContaining("HTTP 503"),
    });
  });

  it("sends a user agent and content type by default, and lets callers add or override headers", async () => {
    const chain = createFakeChain();
    await createRpc({ urls: "http://a", fetch: chain.fetch }).call("eth_blockNumber", []);
    expect(chain.calls[0]?.headers).toEqual({ "content-type": "application/json", "user-agent": "@globalmpc/evm-log-walker" });

    await createRpc({ urls: "http://a", fetch: chain.fetch, headers: { authorization: "Bearer k", "user-agent": "mine" } }).call("eth_blockNumber", []);
    expect(chain.calls[1]?.headers).toEqual({ "content-type": "application/json", "user-agent": "mine", authorization: "Bearer k" });
  });

  it("sends an endpoint's own headers to that endpoint alone, even on failover", async () => {
    const chain = createFakeChain({ head: 10, transportFailures: { "http://keyed": 1 } });
    const rpc = createRpc({
      urls: [{ url: "http://keyed", headers: { authorization: "Bearer secret" } }, "http://public"],
      fetch: chain.fetch,
      retries: 0,
      headers: { "x-client": "walker-tests" },
    });

    await rpc.call("eth_blockNumber", []);

    expect(chain.calls.map((call) => call.url)).toEqual(["http://keyed", "http://public"]);
    expect(chain.calls[0]?.headers).toMatchObject({ authorization: "Bearer secret", "x-client": "walker-tests" });
    expect(chain.calls[1]?.headers).not.toHaveProperty("authorization");
    expect(chain.calls[1]?.headers).toMatchObject({ "x-client": "walker-tests", "user-agent": "@globalmpc/evm-log-walker" });
  });

  it("lower-cases header names so an override cannot be sent twice", async () => {
    const chain = createFakeChain();
    await createRpc({ urls: "http://a", fetch: chain.fetch, headers: { "Content-Type": "application/json; charset=utf-8" } }).call("eth_blockNumber", []);

    expect(chain.calls[0]?.headers).toEqual({ "content-type": "application/json; charset=utf-8", "user-agent": "@globalmpc/evm-log-walker" });
  });

  it("redacts keys, userinfo and query strings from the endpoint in errors", async () => {
    const keyed = "https://user:pw@rpc.example/v1/0123456789abcdef0123456789abcdef?apikey=topsecret";
    const chain = createFakeChain({ transportFailures: { [keyed]: 99 } });
    const rpc = createRpc({ urls: keyed, fetch: chain.fetch, retries: 0 });

    const failure = (await rpc.call("eth_blockNumber", []).then(() => null, (error: unknown) => error)) as RpcError;

    expect(failure.url).toBe("https://rpc.example");
    for (const secret of ["0123456789abcdef", "topsecret", "pw"]) {
      expect(failure.message).not.toContain(secret);
    }
  });

  it("keeps a short or dotted path key out of errors as well, since only the origin is shown", async () => {
    for (const keyed of ["https://archive.example/v1/abc123xy", "https://archive.example/t/eyJhbGciOi.eyJzdWIi.SflKxw"]) {
      const chain = createFakeChain({ transportFailures: { [keyed]: 99 } });
      const rpc = createRpc({ urls: keyed, fetch: chain.fetch, retries: 0 });
      const failure = (await rpc.call("eth_blockNumber", []).then(() => null, (error: unknown) => error)) as RpcError;
      expect(failure.url).toBe("https://archive.example");
      expect(failure.message).not.toMatch(/abc123xy|eyJ/);
    }
  });

  it("names the endpoint by position when several are configured", async () => {
    const chain = createFakeChain({ head: 100_000, maxLogSpan: 1_000, transportFailures: { "http://a": 99 } });
    const rpc = createRpc({ urls: ["http://a", "http://b"], fetch: chain.fetch, retries: 0, backoffMs: 1 });

    const failure = (await rpc.call("eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x2710" }]).then(() => null, (error: unknown) => error)) as RpcError;

    expect(failure.url).toBe("http://b");
    expect(failure.message).toBe("eth_getLogs failed at http://b (endpoint 2 of 2): exceed maximum block range: 1000");
  });

  it("flattens and caps text the endpoint sent before putting it in a message", async () => {
    const hostile = `line one\nforged log line\u0007\u2028more ${"x".repeat(500)}`;
    const chain = createFakeChain({ logsFailure: { code: -32000, message: hostile } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const failure = (await rpc.call("eth_getLogs", [{}]).then(() => null, (error: unknown) => error)) as RpcError;

    expect(failure.message).not.toMatch(/[\n\r\u0007\u2028]/);
    expect(failure.detail.startsWith("line one forged log line more xxx")).toBe(true);
    expect(failure.detail.endsWith(" [truncated]")).toBe(true);
    expect(failure.detail.length).toBeLessThanOrEqual(200 + " [truncated]".length);
  });

  it("asks fetch not to follow redirects, so a credential in any header cannot be replayed to another origin", async () => {
    const chain = createFakeChain();
    await createRpc({ urls: { url: "http://a", headers: { "x-api-key": "secret" } }, fetch: chain.fetch }).call("eth_blockNumber", []);

    expect(chain.calls[0]?.redirect).toBe("manual");
  });

  it("names an endpoint that is not an http(s) URL by position, without echoing it", () => {
    expect(() => createRpc({ urls: "not a url" })).toThrow(/endpoint 1 of 1 is not an http\(s\) URL/);
    expect(() => createRpc({ urls: ["http://a", { url: "archive.example/v1/topsecret" }] })).toThrow(
      /^endpoint 2 of 2 is not an http\(s\) URL \(include the scheme, for example https:\/\/\)$/,
    );
    expect(() => createRpc({ urls: "archive.example/v1/topsecret" })).not.toThrow(/topsecret/);
    for (const schemeless of ["localhost:8545", "ftp://a", ""]) {
      expect(() => createRpc({ urls: schemeless })).toThrow(WalkerError);
    }
  });

  it("does not retry a redirect, moves to the next endpoint, and says what happened", async () => {
    const chain = createFakeChain({ head: 10 });
    let redirected = 0;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      if (String(input) === "http://moved") {
        redirected++;
        return new Response("", { status: 307, headers: { location: "http://elsewhere/" } });
      }
      return chain.fetch(input, init);
    };

    const rpc = createRpc({ urls: ["http://moved", "http://a"], fetch: fetchImpl, retries: 2, backoffMs: 5_000 });
    expect(fromQuantity(await rpc.call("eth_blockNumber", []))).toBe(10);
    expect(redirected).toBe(1);

    const alone = createRpc({ urls: "http://moved", fetch: fetchImpl, retries: 2, backoffMs: 5_000 });
    await expect(alone.call("eth_blockNumber", [])).rejects.toMatchObject({
      code: "E_RPC",
      message: "eth_blockNumber failed at http://moved: no endpoint answered after 1 attempt (the endpoint answered with a redirect, which this client does not follow; configure its new location instead)",
    });
    expect(redirected).toBe(2);
  });

  it("rejects an empty endpoint list", () => {
    expect(() => createRpc({ urls: [] })).toThrow(WalkerError);
    expect(() => createRpc({ urls: [] })).toThrow(/at least one endpoint/);
  });
});

describe("redactEndpoint", () => {
  it("keeps the origin, including a non-default port", () => {
    expect(redactEndpoint("https://bsc-rpc.publicnode.com")).toBe("https://bsc-rpc.publicnode.com");
    expect(redactEndpoint("https://bsc-dataseed.bnbchain.org/")).toBe("https://bsc-dataseed.bnbchain.org");
    expect(redactEndpoint("http://localhost:8545/")).toBe("http://localhost:8545");
  });

  it("drops the path, query, fragment and userinfo whatever they contain", () => {
    expect(redactEndpoint("https://bsc-mainnet.example/v1/0123456789abcdef0123456789abcdef")).toBe("https://bsc-mainnet.example");
    expect(redactEndpoint("https://rpc.example/bsc/abc123xy?key=x#f")).toBe("https://rpc.example");
    expect(redactEndpoint("https://user:pw@rpc.example/bsc/mainnet")).toBe("https://rpc.example");
  });

  it("names an invalid URL instead of throwing", () => {
    expect(redactEndpoint("nope")).toBe("<invalid url>");
  });
});
