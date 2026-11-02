import { recoverAuthorizationAddress } from "viem/utils";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { runSignGuard, EXIT } from "../src/cli/sign-guard.js";
import { MAX_PRESIGNED_RESETS, policyFromJson, presignResets, requestsFromJson, SignGuardError } from "../src/index.js";
import { CHAIN, CHECK_IN, PAYEE, RELAY_TARGET, SWEEPER, TOKEN, transferData } from "./fixtures.js";

const POLICY = JSON.stringify({
  chainIds: [CHAIN],
  transactions: {
    calls: [{ to: RELAY_TARGET, selectors: [CHECK_IN] }],
    tokens: [{ token: TOKEN, maxAmount: "1000", window: { durationMs: 3_600_000, max: "1500" } }],
    maxValue: "0",
  },
});

const REQUESTS = JSON.stringify([
  { kind: "transaction", transaction: { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN } },
  { kind: "transaction", transaction: { chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, 1_000n) } },
  { kind: "transaction", transaction: { chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, 1_000n) } },
  { kind: "authorization", authorization: { address: SWEEPER, chainId: CHAIN, nonce: 1 } },
]);

async function run(argv: string[], files: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSignGuard(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("sign-guard check", () => {
  it("validates a policy on its own", async () => {
    expect(await run(["check", "--policy", "p.json"], { "p.json": POLICY })).toMatchObject({ code: EXIT.ALLOWED, out: "policy is valid" });
  });

  it("judges requests in order, windows included, and exits 20 on a refusal", async () => {
    const result = await run(["check", "--policy", "p.json", "r.json", "--now", "0"], { "p.json": POLICY, "r.json": REQUESTS });
    expect(result.code).toBe(EXIT.DENIED);
    expect(result.out.split("\n")).toEqual([
      "policy is valid; 2 allowed, 2 refused",
      "1. transaction: allowed (call allowed by the policy)",
      "2. transaction: allowed (token transfer within the policy)",
      expect.stringContaining("3. transaction: REFUSED window.exceeded"),
      expect.stringContaining("4. authorization: REFUSED authorization.delegate-not-allowed"),
    ]);
  });

  it("frees the window when --step moves the clock past it", async () => {
    const result = await run(["check", "--policy", "p.json", "r.json", "--step", "3600000"], { "p.json": POLICY, "r.json": REQUESTS });
    expect(result.out).toContain("3. transaction: allowed");
  });

  it("prints JSON with amounts as strings", async () => {
    const result = await run(["check", "--policy", "p.json", "r.json", "--json"], { "p.json": POLICY, "r.json": REQUESTS });
    const parsed = JSON.parse(result.out) as { allowed: number; denied: number; decisions: Array<{ reservations: Array<{ amount: string }> }> };
    expect(parsed).toMatchObject({ allowed: 2, denied: 2 });
    expect(parsed.decisions[1]?.reservations[0]?.amount).toBe("1000");
  });

  it.each([
    [["check"], "--policy is required"],
    [["verify", "--policy", "p.json"], 'unknown command "verify"'],
    [[], "missing command"],
    [["check", "--policy", "p.json", "a", "b"], 'unexpected argument "b"'],
    [["check", "--policy", "p.json", "--now", "soon"], "--now must be a whole number"],
    [["check", "--policy", "p.json", "--bogus"], "Unknown option"],
  ])("usage error for %j", async (argv, message) => {
    const result = await run(argv, { "p.json": POLICY });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.err).toContain(message);
  });

  it("exits 1 on an invalid policy, naming the problem", async () => {
    const result = await run(["check", "--policy", "p.json"], { "p.json": JSON.stringify({ chainIds: [CHAIN], transactions: { maxValue: 5 } }) });
    expect(result).toMatchObject({ code: EXIT.USAGE });
    expect(result.err).toContain("invalid policy: transactions.maxValue must be a decimal string");
  });

  it("exits 1 on malformed JSON and 2 on a missing file", async () => {
    expect((await run(["check", "--policy", "p.json"], { "p.json": "{" })).code).toBe(EXIT.USAGE);
    expect((await run(["check", "--policy", "missing.json"], {})).code).toBe(EXIT.FAILED);
  });

  it("prints usage on --help", async () => {
    const result = await run(["--help"], {});
    expect(result.code).toBe(EXIT.ALLOWED);
    expect(result.out).toContain("Usage: sign-guard check");
  });
});

describe("JSON readers", () => {
  it("converts amount strings to bigint and leaves the rest to validation", () => {
    const policy = policyFromJson(POLICY);
    expect(policy.transactions?.tokens?.[0]?.maxAmount).toBe(1_000n);
    expect(policy.transactions?.tokens?.[0]?.window?.max).toBe(1_500n);
  });

  it("reads one request or a list, with value and domain chain id converted", () => {
    const [single] = requestsFromJson(JSON.stringify({ kind: "transaction", transaction: { chainId: CHAIN, value: "7" } }));
    expect(single).toMatchObject({ transaction: { value: 7n } });
    const [typed] = requestsFromJson(JSON.stringify({ kind: "typedData", typedData: { domain: { chainId: "56" } } }));
    expect(typed).toMatchObject({ typedData: { domain: { chainId: 56n } } });
  });

  it("refuses a numeric amount and a request without kind", () => {
    expect(() => requestsFromJson(JSON.stringify([{ kind: "transaction", transaction: { value: 7 } }]))).toThrow(SignGuardError);
    expect(() => requestsFromJson(JSON.stringify([{}]))).toThrow("must be an object with a \"kind\"");
    expect(() => policyFromJson("[]")).toThrow("one JSON object");
  });
});

describe("presignResets", () => {
  it("signs consecutive resets that recover to the account", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const resets = await presignResets(account, { chainId: CHAIN, fromNonce: 12, count: 3 });
    expect(resets.map((reset) => [reset.address, reset.chainId, reset.nonce])).toEqual([
      ["0x0000000000000000000000000000000000000000", CHAIN, 12],
      ["0x0000000000000000000000000000000000000000", CHAIN, 13],
      ["0x0000000000000000000000000000000000000000", CHAIN, 14],
    ]);
    for (const reset of resets) expect(await recoverAuthorizationAddress({ authorization: reset })).toBe(account.address);
  });

  it.each([
    [{ chainId: 0, fromNonce: 0, count: 1 }, "chainId"],
    [{ chainId: CHAIN, fromNonce: -1, count: 1 }, "fromNonce"],
    [{ chainId: CHAIN, fromNonce: 0, count: 0 }, "count"],
    [{ chainId: CHAIN, fromNonce: 0, count: MAX_PRESIGNED_RESETS + 1 }, "count"],
    [{ chainId: CHAIN, fromNonce: Number.MAX_SAFE_INTEGER, count: 2 }, "MAX_SAFE_INTEGER"],
  ])("refuses %j", async (options, message) => {
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(presignResets(account, options)).rejects.toThrow(message);
  });
});
