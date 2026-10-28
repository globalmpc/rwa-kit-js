/**
 * Endpoint URLs can carry credentials in their path, query, userinfo or host. Nothing this
 * package writes — error messages or the provenance in a JSON result — may echo one.
 */
import { createRpc, redactEndpoint } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import { redactSecrets, secretsFromEndpoints } from "../src/redact.js";
import { defaultEndpointLabel, rpcLogSource } from "../src/sources.js";
import { fakeChain, GENUINE, OWNER, TOKEN } from "./fake-chain.js";
import { mockSource, poisonedHistory } from "./fixtures.js";

function io(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: {},
    source: () => mockSource(poisonedHistory),
    ...over,
  };
}

describe("provenance does not claim an endpoint that may not have answered", () => {
  it("lists every configured endpoint without echoing any part of the URL", async () => {
    const chain = fakeChain({ head: 100, transfers: [] });
    const rpc = createRpc({
      urls: ["https://first.example/key-one", "https://second.example/key-two"],
      fetch: chain.fetch,
    });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    // Positional by default: a host can itself be the credential on a keyed-subdomain provider.
    expect(source.endpoints).toEqual(["endpoint-1", "endpoint-2"]);
    expect(source.endpoint).toBe("endpoint-1");
    expect(JSON.stringify(source)).not.toContain("key-one");
    expect(JSON.stringify(source)).not.toContain("key-two");
    expect(JSON.stringify(source)).not.toContain("first.example");
  });

  it("always reports kind rpc, since it cannot vouch for an index", async () => {
    const chain = fakeChain({ head: 100, transfers: [] });
    const rpc = createRpc({ urls: "https://i.example", fetch: chain.fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(source.kind).toBe("rpc");
    expect(source.coverage).toBeUndefined();
  });
});

describe("a provider's error text cannot carry a credential to stderr", () => {
  it("extracts the secret-bearing parts of an endpoint URL, never the origin", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/v2/super-secret-key?apikey=another-secret"]);
    expect(secrets).toContain("super-secret-key");
    expect(secrets).toContain("another-secret");
    expect(secrets).not.toContain("rpc.example");
    // Short path fragments are ignored, or every message would be scrubbed to noise.
    expect(secrets).not.toContain("v2");
  });

  it("masks every occurrence, whatever the casing", () => {
    const text = redactSecrets("invalid API key: Super-Secret-Key (Super-Secret-Key)", ["Super-Secret-Key"]);
    expect(text).toBe("invalid API key: [redacted] ([redacted])");
  });

  /**
   * The walker's sanitizeProviderText strips control characters and caps length; it does not
   * remove secrets. A provider echoing the key back would otherwise put it in a CI log.
   */
  it("does not print a key the provider echoed back", async () => {
    const key = "super-secret-key-value";
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `invalid API key: ${key}` } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky, source: undefined as never });
    delete (context as { source?: unknown }).source;
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", `https://rpc.example/${key}`, "--token", TOKEN],
      context,
    );
    expect(code).toBe(EXIT.FAILED);
    const written = [...context.out, ...context.err].join("\n");
    expect(written).not.toContain(key);
    expect(written).toContain("[redacted]");
    // The origin is still named, so the message remains diagnosable.
    expect(written).toContain("rpc.example");
  });
});

describe("a percent-encoded credential is masked in both spellings", () => {
  it("collects the decoded form as well as the encoded one", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/key%2Fpart123"]);
    expect(secrets).toContain("key%2Fpart123");
    expect(secrets).toContain("key/part123");
  });

  it("collects the encoded form when the URL carries the decoded one", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/?token=abc+def-ghi"]);
    expect(secrets.some((entry) => entry.includes("abc"))).toBe(true);
  });

  /** A provider echoing the decoded key must not put it in a log. */
  it("does not print a decoded credential the provider echoed back", async () => {
    const encoded = "key%2Fpart123456";
    const decoded = "key/part123456";
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `invalid key: ${decoded}` } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky });
    delete (context as { source?: unknown }).source;
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", `https://rpc.example/${encoded}`, "--token", TOKEN],
      context,
    );
    expect(code).toBe(EXIT.FAILED);
    const written = [...context.out, ...context.err].join("\n");
    expect(written).not.toContain(decoded);
    expect(written).toContain("[redacted]");
  });

  it("survives a malformed percent sequence instead of throwing", () => {
    expect(() => secretsFromEndpoints(["https://rpc.example/bad%ZZsequence"])).not.toThrow();
    expect(secretsFromEndpoints(["https://rpc.example/bad%ZZsequence"])).toContain("bad%ZZsequence");
  });
});

describe("redaction is case-insensitive as documented", () => {
  it("masks an upper-cased echo of a lower-case key", () => {
    expect(redactSecrets("invalid key: ABC123SECRET", ["abc123secret"])).toBe("invalid key: [redacted]");
  });

  it("masks mixed casing in both directions", () => {
    expect(redactSecrets("Abc123Secret and abc123secret", ["ABC123SECRET"])).toBe("[redacted] and [redacted]");
  });

  it("treats a secret containing regex operators literally", () => {
    expect(redactSecrets("key a.b*c+d", ["a.b*c+d"])).toBe("key [redacted]");
    // The pattern must not match a different string that the unescaped regex would.
    expect(redactSecrets("key axbxcxd", ["a.b*c+d"])).toBe("key axbxcxd");
  });
});

describe("a short credential is still a credential", () => {
  it("keeps a five-character query value", () => {
    expect(secretsFromEndpoints(["https://rpc.example/?apikey=ab12c"])).toContain("ab12c");
  });

  it("keeps short userinfo", () => {
    expect(secretsFromEndpoints(["https://user1:pw123@rpc.example/"])).toContain("pw123");
  });

  it("still ignores a short path fragment, which is usually routing", () => {
    expect(secretsFromEndpoints(["https://rpc.example/v2/eth"])).not.toContain("v2");
    expect(secretsFromEndpoints(["https://rpc.example/v2/eth"])).not.toContain("eth");
  });

  it("masks a short key a provider echoes back", async () => {
    const key = "ab12c";
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `bad key ${key}` } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky });
    delete (context as { source?: unknown }).source;
    await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", `https://rpc.example/?apikey=${key}`, "--token", TOKEN],
      context,
    );
    const written = [...context.out, ...context.err].join("\n");
    expect(written).toContain("[redacted]");
    expect(written).not.toMatch(/bad key ab12c/);
  });
});

describe("provenance does not echo a keyed host", () => {
  /**
   * `redactEndpoint` strips the path but keeps the host, and some providers issue keyed
   * subdomains, so `https://<key>.rpc.example` put the key into `source.endpoint` of every
   * successful --json result.
   */
  const keyed = "https://secret-key-value.rpc.example/";

  it("names endpoints by position, not by host", async () => {
    const rpc = createRpc({ urls: keyed, fetch: fakeChain({ head: 50, transfers: [] }).fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(source.endpoint).toBe("endpoint-1");
    expect(JSON.stringify(source)).not.toContain("secret-key-value");
  });

  it("keeps a keyed subdomain out of a successful JSON payload", async () => {
    const chain = fakeChain({ head: 200, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n }] });
    const context = io({ fetch: chain.fetch });
    delete (context as { source?: unknown }).source;
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", keyed, "--token", TOKEN, "--json"],
      context,
    );
    expect(code).toBe(EXIT.TRUSTED);
    expect(context.out.join("\n")).not.toContain("secret-key-value");
  });

  it("still lets a caller opt into origins", async () => {
    const rpc = createRpc({ urls: "https://rpc.example/k", fetch: fakeChain({ head: 50, transfers: [] }).fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN], endpointLabel: redactEndpoint }).fetch(OWNER);
    expect(source.endpoint).toBe("https://rpc.example");
  });

  it("exposes the default labeller", () => {
    expect(defaultEndpointLabel("https://anything.example/key", 0)).toBe("endpoint-1");
    expect(defaultEndpointLabel("https://anything.example/key", 2)).toBe("endpoint-3");
  });
});

describe("a short path credential is collected", () => {
  it("keeps a five-character path segment", () => {
    expect(secretsFromEndpoints(["https://rpc.example/abcde"])).toContain("abcde");
  });

  it("skips a value that is not a URL and still reads the ones that are", () => {
    expect(secretsFromEndpoints(["not a url", "https://rpc.example/abcde"])).toEqual(["abcde"]);
  });

  it("keeps a four-character one", () => {
    expect(secretsFromEndpoints(["https://rpc.example/ab12"])).toContain("ab12");
  });

  it("still leaves common short routing segments alone", () => {
    const secrets = secretsFromEndpoints(["https://rpc.example/v2/eth/ws"]);
    for (const routing of ["v2", "eth", "ws"]) expect(secrets).not.toContain(routing);
  });

  it("masks a short path key a provider echoes back", async () => {
    const leaky = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "invalid key abcde" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    const context = io({ fetch: leaky });
    delete (context as { source?: unknown }).source;
    await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://rpc.example/abcde", "--token", TOKEN],
      context,
    );
    const written = [...context.out, ...context.err].join("\n");
    expect(written).not.toMatch(/invalid key abcde/);
    expect(written).toContain("[redacted]");
  });
});
