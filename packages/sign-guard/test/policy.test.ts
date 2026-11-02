import { describe, expect, it } from "vitest";
import { DEFAULT_AUTHORIZATION_WINDOW, resolvePolicy, SignGuardError, type SignPolicy } from "../src/index.js";
import { CHAIN, DELEGATE, relayerPolicy, RELAY_TARGET, TOKEN } from "./fixtures.js";

function invalid(policy: unknown): string {
  try {
    resolvePolicy(policy as SignPolicy);
  } catch (error) {
    expect(error).toBeInstanceOf(SignGuardError);
    expect((error as SignGuardError).code).toBe("E_INVALID_POLICY");
    return (error as SignGuardError).message;
  }
  throw new Error("expected the policy to be refused");
}

describe("resolvePolicy", () => {
  it("fills in defaults that sign nothing", () => {
    const resolved = resolvePolicy({ chainIds: [CHAIN] });
    expect(resolved.transactions.calls.size).toBe(0);
    expect(resolved.transactions.tokens.size).toBe(0);
    expect(resolved.transactions.maxValue).toBe(0n);
    expect(resolved.transactions.allowContractCreation).toBe(false);
    expect(resolved.authorizations.allow.size).toBe(0);
    expect(resolved.authorizations.window).toEqual(DEFAULT_AUTHORIZATION_WINDOW);
    expect(resolved.typedData).toEqual([]);
    expect(resolved.messages).toEqual([]);
  });

  it("lower-cases addresses and merges call rules for the same contract", () => {
    const upper = RELAY_TARGET.toUpperCase().replace("0X", "0x") as `0x${string}`;
    const resolved = resolvePolicy({
      chainIds: [CHAIN],
      transactions: { calls: [{ to: upper, selectors: ["0xAABBCCDD"] }, { to: RELAY_TARGET, selectors: ["0x"] }] },
    });
    expect([...(resolved.transactions.calls.get(RELAY_TARGET) ?? [])]).toEqual(["0xaabbccdd", "0x"]);
  });

  it("accepts the full relayer policy", () => {
    const resolved = resolvePolicy(relayerPolicy());
    expect(resolved.transactions.tokens.get(TOKEN)?.maxAmount).toBe(1_000n);
    expect(resolved.authorizations.allow.has(DELEGATE)).toBe(true);
  });

  it.each([
    ["chainIds must be a non-empty list", {}],
    ["chainIds must be a non-empty list", { chainIds: [] }],
    ["0 would mean every chain", { chainIds: [0] }],
    ["chain ids are positive whole numbers", { chainIds: [1.5] }],
    ['unknown key "extra"', { chainIds: [CHAIN], extra: true }],
    ['unknown key "maxValu"', { chainIds: [CHAIN], transactions: { maxValu: 1n } }],
    ["must be a bigint", { chainIds: [CHAIN], transactions: { maxValue: 1 } }],
    ["must be a bigint of 0 or more", { chainIds: [CHAIN], transactions: { maxValue: -1n } }],
    ["20-byte address", { chainIds: [CHAIN], transactions: { calls: [{ to: "0x12", selectors: ["0x"] }] } }],
    ["selectors is empty", { chainIds: [CHAIN], transactions: { calls: [{ to: RELAY_TARGET, selectors: [] }] } }],
    ["4-byte selector", { chainIds: [CHAIN], transactions: { calls: [{ to: RELAY_TARGET, selectors: ["*"] }] } }],
    ["selectors is empty", { chainIds: [CHAIN], transactions: { calls: [{ to: RELAY_TARGET }] } }],
    ["appears twice", { chainIds: [CHAIN], transactions: { tokens: [{ token: TOKEN, maxAmount: 1n }, { token: TOKEN, maxAmount: 2n }] } }],
    ["positive whole number of milliseconds", { chainIds: [CHAIN], transactions: { window: { durationMs: 0, max: 1n } } }],
    ["true or false", { chainIds: [CHAIN], transactions: { allowContractCreation: "yes" } }],
    ["always allowed and needs no entry", { chainIds: [CHAIN], authorizations: { allow: ["0x0000000000000000000000000000000000000000"] } }],
    ["whole number of signatures", { chainIds: [CHAIN], authorizations: { allow: [], window: { durationMs: 1, max: -1 } } }],
    ["primaryTypes is empty", { chainIds: [CHAIN], typedData: [{ verifyingContract: TOKEN, primaryTypes: [] }] }],
    ["is the domain", { chainIds: [CHAIN], typedData: [{ verifyingContract: TOKEN, primaryTypes: ["EIP712Domain"] }] }],
    ['unknown key "chainId"', { chainIds: [CHAIN], typedData: [{ verifyingContract: TOKEN, chainId: 97, primaryTypes: ["A"] }] }],
    ["would allow every message", { chainIds: [CHAIN], messages: { prefixes: [""] } }],
    ["policy must be an object", "not an object"],
  ])("refuses a policy: %s", (message, policy) => {
    expect(invalid(policy)).toContain(message);
  });

  it("refuses a policy that names contracts on more than one chain", () => {
    expect(invalid({ ...relayerPolicy(), chainIds: [CHAIN, 204] })).toContain("must have exactly one chain id");
    expect(invalid({ chainIds: [CHAIN, 204], authorizations: { allow: [DELEGATE] } })).toContain("must have exactly one chain id");
    expect(resolvePolicy({ chainIds: [CHAIN, 204], messages: { prefixes: ["Sign in"] } }).chainIds.size).toBe(2);
  });

  it("describes values a JSON printer cannot", () => {
    expect(invalid({ chainIds: [CHAIN], transactions: { calls: [{ to: { nested: 1n }, selectors: ["0x"] }] } })).toContain("a object");
  });
});
