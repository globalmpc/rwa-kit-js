import { describe, expect, it } from "vitest";
import { EXIT, runHolderSnapshot } from "../src/cli/holder-snapshot.js";
import { redactEndpoints, secretsFromEndpoints } from "../src/redact.js";
import { TOKEN } from "./fake-chain.js";
import { memoryIo } from "./io.js";

describe("redactEndpoints", () => {
  it("names a keyed subdomain by position in a transport error", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const run = memoryIo(down);
    const code = await runHolderSnapshot(["snapshot", "--token", TOKEN, "--rpc", "https://secret123.rpc.example"], run.io);
    expect(code).toBe(EXIT.FAILED);
    const printed = run.err.join("\n");
    expect(printed).not.toMatch(/secret123/i);
    expect(printed).toContain("endpoint-1");
  });

  it("masks a keyed subdomain label a provider echoes on its own", () => {
    expect(redactEndpoints("invalid API key: secret123", ["https://secret123.rpc.example"])).toBe(
      "invalid API key: [redacted]",
    );
    expect(redactEndpoints("rpc.example rejected the call", ["https://secret123.rpc.example"])).toBe(
      "rpc.example rejected the call",
    );
  });

  it("masks a query value containing + in the spelling it was written", () => {
    expect(secretsFromEndpoints(["https://r.example/?apikey=abcd+efgh"])).toContain("abcd+efgh");
    expect(redactEndpoints("invalid key abcd+efgh", ["https://r.example/?apikey=abcd+efgh"])).toBe("invalid key [redacted]");
  });
});
