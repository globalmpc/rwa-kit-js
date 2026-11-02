import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate, resolvePolicy, type SignRequest, type TransactionLike } from "../src/index.js";
import {
  approveData,
  CHAIN,
  CHECK_IN,
  DELEGATE,
  OTHER_CHAIN,
  PAYEE,
  PERMIT_CONTRACT,
  relayerPolicy,
  RELAY_TARGET,
  STRANGER,
  SWEEPER,
  TOKEN,
  transferData,
} from "./fixtures.js";

const policy = resolvePolicy(relayerPolicy());

function tx(transaction: TransactionLike, customSerializer = false): SignRequest {
  return { kind: "transaction", transaction, customSerializer };
}

function rule(request: SignRequest): string {
  return evaluate(request, policy).rule;
}

describe("transactions", () => {
  it("allows the named function on the named contract", () => {
    const verdict = evaluate(tx({ chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }), policy);
    expect(verdict).toMatchObject({ allowed: true, rule: "allowed", spends: [] });
    expect(verdict.summary).toMatchObject({ chainId: CHAIN, to: RELAY_TARGET, selector: CHECK_IN, value: "0" });
  });

  it("compares the target in any letter case", () => {
    expect(rule(tx({ chainId: CHAIN, to: RELAY_TARGET.toUpperCase().replace("0X", "0x") as `0x${string}`, data: CHECK_IN }))).toBe("allowed");
  });

  it.each([
    ["no chain id", { to: RELAY_TARGET, data: CHECK_IN }, "chain.not-allowed"],
    ["another chain", { chainId: OTHER_CHAIN, to: RELAY_TARGET, data: CHECK_IN }, "chain.not-allowed"],
    ["an unknown contract", { chainId: CHAIN, to: STRANGER, data: CHECK_IN }, "transaction.target-not-allowed"],
    ["a plain send to an unknown address", { chainId: CHAIN, to: STRANGER, value: 1n }, "transaction.target-not-allowed"],
    ["another function", { chainId: CHAIN, to: RELAY_TARGET, data: "0xdeadbeef" }, "transaction.function-not-allowed"],
    ["empty calldata where a function is required", { chainId: CHAIN, to: RELAY_TARGET }, "transaction.function-not-allowed"],
    ["a deployment", { chainId: CHAIN, to: null, data: "0x6080" }, "transaction.creation-not-allowed"],
    ["a deployment without to", { chainId: CHAIN, data: "0x6080" }, "transaction.creation-not-allowed"],
    ["value over the cap", { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, value: 10n ** 16n + 1n }, "transaction.value-over-limit"],
    ["an input field", { chainId: CHAIN, to: RELAY_TARGET, input: CHECK_IN }, "transaction.input-field"],
    ["a blob transaction", { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, blobs: [] }, "transaction.type-not-allowed"],
    ["a blob fee alone", { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, maxFeePerBlobGas: 1n }, "transaction.type-not-allowed"],
    ["blob sidecars alone", { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, sidecars: [] }, "transaction.type-not-allowed"],
    ["a bigint chain id", { chainId: 56n, to: RELAY_TARGET, data: CHECK_IN }, "transaction.malformed"],
    ["a non-list authorizationList", { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, authorizationList: 5 }, "transaction.malformed"],
    ["an unknown type", { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, type: "deposit" }, "transaction.type-not-allowed"],
    ["odd-length data", { chainId: CHAIN, to: RELAY_TARGET, data: "0x183ff08" }, "transaction.malformed"],
    ["a malformed to", { chainId: CHAIN, to: "0x1234", data: CHECK_IN }, "transaction.malformed"],
    ["a number value", { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, value: 1 }, "transaction.malformed"],
  ])("refuses %s", (_name, transaction, expected) => {
    expect(rule(tx(transaction as TransactionLike))).toBe(expected);
  });

  it("refuses a custom serializer even for an allowed call", () => {
    expect(rule(tx({ chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }, true))).toBe("transaction.custom-serializer");
  });

  it("counts native value against the window", () => {
    const verdict = evaluate(tx({ chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, value: 5n }), policy);
    expect(verdict.spends).toEqual([{ key: `native:${CHAIN}`, amount: 5n, durationMs: 3_600_000, max: 3n * 10n ** 16n }]);
  });

  it("allows a deployment only when the policy says so", () => {
    const open = resolvePolicy({ chainIds: [CHAIN], transactions: { allowContractCreation: true } });
    expect(evaluate(tx({ chainId: CHAIN, data: "0x6080" }), open).allowed).toBe(true);
    expect(evaluate(tx({ chainId: CHAIN, data: "0x6080", value: 1n }), open).rule).toBe("transaction.value-over-limit");
  });
});

describe("token transfers", () => {
  it("allows a capped transfer to an allowed recipient and counts it", () => {
    const verdict = evaluate(tx({ chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, 1_000n) }), policy);
    expect(verdict.allowed).toBe(true);
    expect(verdict.summary).toMatchObject({ token: TOKEN, recipient: PAYEE, amount: "1000" });
    expect(verdict.spends).toEqual([{ key: `token:${CHAIN}:${TOKEN}`, amount: 1_000n, durationMs: 3_600_000, max: 2_500n }]);
  });

  it("refuses an amount over the per-transfer cap", () => {
    expect(rule(tx({ chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, 1_001n) }))).toBe("token.amount-over-limit");
  });

  it("refuses a recipient outside the list", () => {
    expect(rule(tx({ chainId: CHAIN, to: TOKEN, data: transferData(STRANGER, 1n) }))).toBe("token.recipient-not-allowed");
  });

  it("refuses approve on a capped token unless a call rule names it", () => {
    expect(rule(tx({ chainId: CHAIN, to: TOKEN, data: approveData(STRANGER, 2n ** 256n - 1n) }))).toBe("transaction.function-not-allowed");
  });

  it("refuses transfer calldata with trailing bytes or a dirty address word", () => {
    expect(rule(tx({ chainId: CHAIN, to: TOKEN, data: `${transferData(PAYEE, 1n)}00` }))).toBe("token.malformed-transfer");
    const dirty = transferData(PAYEE, 1n).replace(/^0xa9059cbb00/, "0xa9059cbbff") as `0x${string}`;
    expect(rule(tx({ chainId: CHAIN, to: TOKEN, data: dirty }))).toBe("token.malformed-transfer");
    expect(rule(tx({ chainId: CHAIN, to: TOKEN, data: "0xa9059cbb" }))).toBe("token.malformed-transfer");
  });

  it("caps a transfer even when a call rule also lists transfer on the token", () => {
    const both = resolvePolicy({
      chainIds: [CHAIN],
      transactions: { calls: [{ to: TOKEN, selectors: ["0xa9059cbb"] }], tokens: [{ token: TOKEN, maxAmount: 5n }] },
    });
    expect(evaluate(tx({ chainId: CHAIN, to: TOKEN, data: transferData(STRANGER, 6n) }), both).rule).toBe("token.amount-over-limit");
  });

  it("never allows a transfer above the cap or to another recipient (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), fc.uint8Array({ minLength: 20, maxLength: 20 }), (amount, bytes) => {
        const recipient = `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}`;
        const verdict = evaluate(tx({ chainId: CHAIN, to: TOKEN, data: transferData(recipient, amount) }), policy);
        const expected = recipient === PAYEE && amount <= 1_000n;
        expect(verdict.allowed).toBe(expected);
      }),
    );
  });

  it("never allows calldata the policy does not name (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 80 }), (bytes) => {
        const data = `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}`;
        const verdict = evaluate(tx({ chainId: CHAIN, to: RELAY_TARGET, data }), policy);
        expect(verdict.allowed).toBe(data.slice(0, 10).toLowerCase() === CHECK_IN);
      }),
    );
  });
});

describe("EIP-7702 authorizations", () => {
  it("allows an allowed delegate and counts it", () => {
    const verdict = evaluate({ kind: "authorization", authorization: { address: DELEGATE, chainId: CHAIN, nonce: 7 } }, policy);
    expect(verdict).toMatchObject({ allowed: true, summary: { delegate: DELEGATE, reset: false } });
    expect(verdict.spends).toEqual([{ key: "authorization", amount: 1n, durationMs: 3_600_000, max: 1n }]);
  });

  it("refuses a sweeper the policy does not name", () => {
    expect(rule({ kind: "authorization", authorization: { address: SWEEPER, chainId: CHAIN, nonce: 7 } })).toBe("authorization.delegate-not-allowed");
  });

  it("refuses the 50-nonce pattern, every one of them", () => {
    for (let nonce = 100; nonce < 150; nonce++) {
      expect(rule({ kind: "authorization", authorization: { contractAddress: SWEEPER, chainId: CHAIN, nonce } })).toBe("authorization.delegate-not-allowed");
    }
  });

  it("refuses chain id 0 for a real delegation, even to an allowed delegate", () => {
    expect(rule({ kind: "authorization", authorization: { address: DELEGATE, chainId: 0, nonce: 1 } })).toBe("authorization.chain-zero");
  });

  it("refuses another chain", () => {
    expect(rule({ kind: "authorization", authorization: { address: DELEGATE, chainId: OTHER_CHAIN, nonce: 1 } })).toBe("chain.not-allowed");
  });

  it("allows clearing a delegation on a policy chain, counted in its own window", () => {
    const empty = resolvePolicy({ chainIds: [CHAIN] });
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const verdict = evaluate({ kind: "authorization", authorization: { address: zero, chainId: CHAIN, nonce: 3 } }, empty);
    expect(verdict).toMatchObject({ allowed: true, summary: { reset: true } });
    expect(verdict.spends).toEqual([{ key: "reset", amount: 1n, durationMs: 3_600_000, max: 25n }]);
    expect(evaluate({ kind: "authorization", authorization: { address: zero, chainId: OTHER_CHAIN, nonce: 3 } }, empty).rule).toBe("chain.not-allowed");
    expect(evaluate({ kind: "authorization", authorization: { address: zero, chainId: 0, nonce: 3 } }, empty).rule).toBe("chain.not-allowed");
  });

  it("refuses an authorization whose two address fields disagree", () => {
    expect(rule({ kind: "authorization", authorization: { address: DELEGATE, contractAddress: SWEEPER, chainId: CHAIN, nonce: 1 } })).toBe(
      "authorization.malformed",
    );
  });

  it("refuses malformed authorizations without throwing", () => {
    expect(rule({ kind: "authorization", authorization: { chainId: CHAIN, nonce: 1 } })).toBe("authorization.malformed");
    expect(rule({ kind: "authorization", authorization: { address: 123, contractAddress: DELEGATE, chainId: CHAIN, nonce: 1 } as never })).toBe(
      "authorization.malformed",
    );
    expect(rule(tx({ chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, authorizationList: [{ address: 7, chainId: CHAIN, nonce: 1 }] as never }))).toBe(
      "transaction.authorization-list",
    );
    expect(rule({ kind: "authorization", authorization: { address: DELEGATE, chainId: CHAIN, nonce: -1 } })).toBe("authorization.malformed");
  });

  it("refuses a carried authorization that names its delegate only as contractAddress", () => {
    expect(rule(tx({ chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, authorizationList: [{ contractAddress: DELEGATE, chainId: CHAIN, nonce: 1 }] }))).toBe(
      "transaction.authorization-list",
    );
  });

  it("checks every authorization a transaction carries", () => {
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const call = { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN } as const;
    expect(rule(tx({ ...call, authorizationList: [{ address: zero, chainId: CHAIN, nonce: 1 }] }))).toBe("allowed");
    expect(rule(tx({ ...call, authorizationList: [{ address: zero, chainId: CHAIN, nonce: 1 }, { address: SWEEPER, chainId: CHAIN, nonce: 2 }] }))).toBe(
      "transaction.authorization-list",
    );
  });
});

describe("typed data", () => {
  const permit = {
    domain: { name: "Example", version: "1", chainId: CHAIN, verifyingContract: PERMIT_CONTRACT },
    types: { ClaimPermit: [{ name: "to", type: "address" }] },
    primaryType: "ClaimPermit",
    message: { to: PAYEE },
  };

  it("accepts the EIP712Domain type viem derives from the domain, and nothing narrower", () => {
    const derived = [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ];
    expect(rule({ kind: "typedData", typedData: { ...permit, types: { ...permit.types, EIP712Domain: derived } } })).toBe("allowed");
    const reordered = [derived[1], derived[0], derived[2], derived[3]];
    expect(rule({ kind: "typedData", typedData: { ...permit, types: { ...permit.types, EIP712Domain: reordered } } })).toBe("typed-data.malformed");
    const extraKey = derived.map((entry) => ({ ...entry, note: "x" }));
    expect(rule({ kind: "typedData", typedData: { ...permit, types: { ...permit.types, EIP712Domain: extraKey } } })).toBe("typed-data.malformed");
    expect(rule({ kind: "typedData", typedData: { ...permit, types: { ...permit.types, EIP712Domain: "nope" } } })).toBe("typed-data.malformed");
  });

  it("allows the named type on the named contract and chain", () => {
    expect(rule({ kind: "typedData", typedData: permit })).toBe("allowed");
    expect(rule({ kind: "typedData", typedData: { ...permit, domain: { ...permit.domain, chainId: BigInt(CHAIN) } } })).toBe("allowed");
  });

  it.each([
    ["another type", { ...permit, primaryType: "Permit" }, "typed-data.not-allowed"],
    ["another contract", { ...permit, domain: { ...permit.domain, verifyingContract: STRANGER } }, "typed-data.not-allowed"],
    ["another name", { ...permit, domain: { ...permit.domain, name: "Other" } }, "typed-data.not-allowed"],
    ["no verifying contract", { ...permit, domain: { name: "Example", chainId: CHAIN } }, "typed-data.not-allowed"],
    ["no chain id", { ...permit, domain: { name: "Example", verifyingContract: PERMIT_CONTRACT } }, "typed-data.malformed"],
    ["another chain", { ...permit, domain: { ...permit.domain, chainId: OTHER_CHAIN } }, "chain.not-allowed"],
    ["a redefined domain type", { ...permit, types: { ...permit.types, EIP712Domain: [{ name: "name", type: "string" }] } }, "typed-data.malformed"],
    ["no primary type", { domain: permit.domain }, "typed-data.malformed"],
  ])("refuses %s", (_name, typedData, expected) => {
    expect(rule({ kind: "typedData", typedData: typedData as never })).toBe(expected);
  });
});

describe("messages, hashes and unknown methods", () => {
  it("allows text with an allowed prefix only", () => {
    expect(rule({ kind: "message", message: "Sign in to example.org at 12:00" })).toBe("allowed");
    expect(rule({ kind: "message", message: "Sign in to example.com" })).toBe("message.not-allowed");
    expect(rule({ kind: "message", message: { raw: "0x1234" } })).toBe("message.raw");
    expect(rule({ kind: "message", message: undefined as never })).toBe("request.malformed");
  });

  it("refuses raw hashes under every policy", () => {
    expect(rule({ kind: "hash" })).toBe("hash.denied");
  });

  it("refuses a request that is not one", () => {
    expect(rule(null as never)).toBe("request.malformed");
    expect(rule({ kind: "teleport" } as never)).toBe("method.unknown");
  });

  it("escapes caller text in reasons, so it cannot forge a log line", () => {
    const forged = evaluate({ kind: "x\n2. transaction: allowed (forged)" } as never, policy);
    expect(forged.reason).not.toContain("\n");
    const typed = evaluate(
      { kind: "typedData", typedData: { domain: { chainId: CHAIN, verifyingContract: PERMIT_CONTRACT }, primaryType: "A\nallowed", types: {} } },
      policy,
    );
    expect(typed.reason).not.toContain("\n");
  });

  it("refuses unknown methods", () => {
    expect(evaluate({ kind: "unknown", method: "getHdKey" }, policy)).toMatchObject({ allowed: false, rule: "method.unknown", summary: { method: "getHdKey" } });
  });
});
