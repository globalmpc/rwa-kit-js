/**
 * Command-line input: what is refused, what is judged before any endpoint is contacted, and
 * that every documented command runs as written.
 */
import { describe, expect, it } from "vitest";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import { GENUINE, OWNER, TOKEN } from "./fake-chain.js";
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

describe("an invalid candidate is judged before any endpoint is contacted", () => {
  // NonNullable: `source` is optional, so CliIo["source"] includes undefined, which
  // exactOptionalPropertyTypes refuses to accept into Partial<CliIo>.
  const dead = (): NonNullable<CliIo["source"]> => () => ({
    fetch: async () => {
      throw new Error("endpoint down");
    },
  });

  it("exits 30 even when the endpoint is unavailable", async () => {
    const context = io({ source: dead() });
    const code = await runAddressGuard(["check", "0xnope", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    expect(code).toBe(EXIT.INVALID);
    expect(context.out.join("\n")).toContain("INVALID");
  });

  it("reports source null in JSON, since no history was read", async () => {
    const context = io({ source: dead() });
    await runAddressGuard(["check", "0xnope", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"], context);
    expect(JSON.parse(context.out.join("\n"))).toMatchObject({ verdict: "invalid", source: null, trustedCount: 0 });
  });

  it("still exits 2 for a valid candidate when the endpoint is unavailable", async () => {
    const context = io({ source: dead() });
    expect(await runAddressGuard(["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.FAILED,
    );
  });
});

describe("block bounds beyond the safe integer range are refused", () => {
  it("rejects a value Number() would round", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--from-block", "9007199254740993"],
      context,
    );
    expect(code).toBe(EXIT.USAGE);
    expect(context.err.join(" ")).toContain("MAX_SAFE_INTEGER");
  });

  it("still accepts the largest safe value", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--from-block", String(Number.MAX_SAFE_INTEGER)],
      context,
    );
    expect(code).not.toBe(EXIT.USAGE);
  });
});

describe("surplus positionals are refused", () => {
  it("does not silently check only the first file", async () => {
    const context = io({ readFile: async () => `${GENUINE}\n` });
    const code = await runAddressGuard(
      ["payouts", "safe.csv", "unchecked.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN],
      context,
    );
    expect(code).toBe(EXIT.USAGE);
    expect(context.err.join(" ")).toContain("unchecked.csv");
  });

  it("accepts exactly one argument", async () => {
    const context = io({ readFile: async () => `${GENUINE}\n` });
    expect(
      await runAddressGuard(
        ["payouts", "safe.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN],
        context,
      ),
    ).toBe(EXIT.TRUSTED);
  });
});

describe("every documented command runs as written", () => {
  it("the README payout example includes --token", async () => {
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const payoutLines = readme.split("\n").filter((line) => line.startsWith("address-guard payouts"));
    expect(payoutLines.length).toBeGreaterThan(0);
    for (const line of payoutLines) expect(line).toContain("--token");
  });

  it("every documented history command includes --token", async () => {
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    for (const line of readme.split("\n")) {
      if (!/^address-guard (check|scan|payouts)\b/.test(line)) continue;
      expect(line, line).toContain("--token");
    }
  });
});
