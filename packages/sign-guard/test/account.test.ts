import { recoverAuthorizationAddress } from "viem/utils";
import { createWalletClient, custom, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress, serializeTransaction, toHex } from "viem";
import { base, bsc } from "viem/chains";
import { english, generateMnemonic, generatePrivateKey, mnemonicToAccount, privateKeyToAccount, toAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createSignGuard, findRefusal, guardAccount, SignGuardError, type Decision } from "../src/index.js";
import { CHAIN, CHECK_IN, DELEGATE, PAYEE, PERMIT_CONTRACT, relayerPolicy, RELAY_TARGET, STRANGER, SWEEPER, TOKEN, transferData } from "./fixtures.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const FEES = { gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 } as const;

function freshAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

/** The guard's refusal, found directly or as the `cause` of the error viem wraps it in. */
async function refusal(promise: Promise<unknown>): Promise<Decision> {
  try {
    await promise;
  } catch (thrown) {
    let error: unknown = thrown;
    while (!(error instanceof SignGuardError) && error instanceof Error && error.cause !== undefined) error = error.cause;
    expect(error).toBeInstanceOf(SignGuardError);
    expect((error as SignGuardError).code).toBe("E_DENIED");
    const decision = (error as SignGuardError).decision;
    if (decision === undefined) throw new Error("refusal without a decision");
    return decision;
  }
  throw new Error("expected the guard to refuse");
}

describe("guardAccount with a viem private-key account", () => {
  it("signs an allowed transaction that recovers to the account", async () => {
    const account = freshAccount();
    const guarded = guardAccount(account, relayerPolicy());
    const signed = await guarded.signTransaction({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(account.address);
    expect(guarded.address).toBe(account.address);
    expect(guarded.publicKey).toBe(account.publicKey);
    expect(guarded.source).toBe("privateKey");
  });

  it("refuses a transfer to a stranger and signs nothing", async () => {
    const guarded = guardAccount(freshAccount(), relayerPolicy());
    const decision = await refusal(guarded.signTransaction({ ...FEES, chainId: CHAIN, to: TOKEN, data: transferData(STRANGER, 1n) }));
    expect(decision.rule).toBe("token.recipient-not-allowed");
  });

  it("refuses the sweeper delegation pattern across 50 nonces", async () => {
    const guarded = guardAccount(freshAccount(), relayerPolicy());
    for (let nonce = 0; nonce < 50; nonce++) {
      const decision = await refusal(guarded.signAuthorization({ contractAddress: SWEEPER, chainId: CHAIN, nonce }));
      expect(decision.rule).toBe("authorization.delegate-not-allowed");
    }
  });

  it("keeps viem's output format for authorizations", async () => {
    const guarded = guardAccount(freshAccount(), relayerPolicy());
    const hex = await guarded.signAuthorization({ address: DELEGATE, chainId: CHAIN, nonce: 1, to: "hex" } as never);
    expect(hex).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs an allowed delegation and a reset, both recoverable", async () => {
    const account = freshAccount();
    const guarded = guardAccount(account, relayerPolicy());
    const delegation = await guarded.signAuthorization({ address: DELEGATE, chainId: CHAIN, nonce: 4 });
    expect(await recoverAuthorizationAddress({ authorization: delegation })).toBe(account.address);
    const reset = await guarded.signAuthorization({ address: ZERO, chainId: CHAIN, nonce: 5 });
    expect(reset.address).toBe(ZERO);
    expect(await recoverAuthorizationAddress({ authorization: reset })).toBe(account.address);
  });

  it("refuses raw hash signing", async () => {
    const guarded = guardAccount(freshAccount(), relayerPolicy());
    const hash = `0x${"ab".repeat(32)}` as const;
    expect((await refusal(guarded.sign({ hash }))).rule).toBe("hash.denied");
  });

  it("refuses a custom serializer, which could sign other bytes", async () => {
    const guarded = guardAccount(freshAccount(), relayerPolicy());
    const sneaky = () => serializeTransaction({ ...FEES, chainId: CHAIN, to: STRANGER, value: 10n ** 18n });
    const signTransaction = guarded.signTransaction as (transaction: unknown, options: { serializer: unknown }) => Promise<unknown>;
    const decision = await refusal(signTransaction({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }, { serializer: sneaky }));
    expect(decision.rule).toBe("transaction.custom-serializer");
  });

  it("signs what it checked, not what a getter answers later", async () => {
    const account = freshAccount();
    const guarded = guardAccount(account, relayerPolicy());
    let reads = 0;
    const shifting = {
      ...FEES,
      chainId: CHAIN,
      data: CHECK_IN,
      get to() {
        reads++;
        return reads === 1 ? RELAY_TARGET : STRANGER;
      },
    };
    const signed = await guarded.signTransaction(shifting);
    expect(reads).toBe(1);
    const recovered = await import("viem").then(({ parseTransaction }) => parseTransaction(signed));
    expect(recovered.to?.toLowerCase()).toBe(RELAY_TARGET);
  });

  it("signs allowed typed data and refuses a redefined domain type", async () => {
    const account = freshAccount();
    const guarded = guardAccount(account, relayerPolicy());
    const typedData = {
      domain: { name: "Example", version: "1", chainId: CHAIN, verifyingContract: PERMIT_CONTRACT },
      types: { ClaimPermit: [{ name: "to", type: "address" }] },
      primaryType: "ClaimPermit",
      message: { to: PAYEE },
    } as const;
    const signature = await guarded.signTypedData(typedData);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(account.address);
    const narrowed = { ...typedData, types: { ...typedData.types, EIP712Domain: [{ name: "name", type: "string" }] } };
    expect((await refusal(guarded.signTypedData(narrowed as never))).rule).toBe("typed-data.malformed");
  });

  it("signs an allowed message and refuses others", async () => {
    const account = freshAccount();
    const guarded = guardAccount(account, relayerPolicy());
    const message = "Sign in to example.org, nonce 1";
    const signature = await guarded.signMessage({ message });
    expect(await recoverMessageAddress({ message, signature })).toBe(account.address);
    expect((await refusal(guarded.signMessage({ message: "Approve everything" }))).rule).toBe("message.not-allowed");
  });

  it("keeps the window spent when the signer throws, by default, since a remote signer may have signed", async () => {
    const account = freshAccount();
    let calls = 0;
    const flaky = {
      ...account,
      signTransaction: async (...args: Parameters<typeof account.signTransaction>) => {
        calls++;
        await account.signTransaction(...args);
        throw new Error("timeout after signing");
      },
    };
    const guarded = guardAccount(flaky, createSignGuard(relayerPolicy(), { now: () => 0 }));
    const big = { ...FEES, chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, 1_000n) };
    await expect(guarded.signTransaction(big)).rejects.toThrow("timeout");
    await expect(guarded.signTransaction(big)).rejects.toThrow("timeout");
    expect((await refusal(guarded.signTransaction(big))).rule).toBe("window.exceeded");
    expect(calls).toBe(2);
  });

  it("signs with the serializer that was checked, even if the options object changes afterwards", async () => {
    let evilCalls = 0;
    const evil = () => {
      evilCalls++;
      return "0xdeadbeef" as const;
    };
    const account = freshAccount();
    const guarded = guardAccount(account, relayerPolicy());
    const signTransaction = guarded.signTransaction as (transaction: unknown, options: { serializer?: unknown }) => Promise<`0x${string}`>;
    const options: { serializer?: unknown } = {};
    const pending = signTransaction({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }, options);
    options.serializer = evil;
    const signed = await pending;
    expect(evilCalls).toBe(0);
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(account.address);

    let reads = 0;
    const shifty = {
      get serializer() {
        reads++;
        return reads === 1 ? undefined : evil;
      },
    };
    await signTransaction({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }, shifty);
    expect(evilCalls).toBe(0);
  });

  it("releases the window when the signer fails and releaseOnSignerError is set", async () => {
    const account = freshAccount();
    let broken = true;
    const flaky = {
      ...account,
      signTransaction: async (...args: Parameters<typeof account.signTransaction>) => {
        if (broken) throw new Error("hsm offline");
        return account.signTransaction(...args);
      },
    };
    const guard = createSignGuard(relayerPolicy(), { now: () => 0 });
    const guarded = guardAccount(flaky, guard, { releaseOnSignerError: true });
    const big = { ...FEES, chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, 1_000n) };
    await expect(guarded.signTransaction(big)).rejects.toThrow("hsm offline");
    broken = false;
    await guarded.signTransaction(big);
    await guarded.signTransaction(big);
    expect((await refusal(guarded.signTransaction(big))).rule).toBe("window.exceeded");
  });
});

describe("guardAccount inside a viem wallet client", () => {
  it("signs through sendTransaction on BNB Smart Chain and refuses a stranger", async () => {
    const sent: string[] = [];
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_chainId") return toHex(CHAIN);
        if (method === "eth_sendRawTransaction") {
          sent.push((params as string[])[0] ?? "");
          return `0x${"11".repeat(32)}`;
        }
        throw new Error(`unexpected RPC call ${method}`);
      },
    });
    const account = freshAccount();
    const wallet = createWalletClient({ account: guardAccount(account, relayerPolicy()), chain: bsc, transport });
    await wallet.sendTransaction({ ...FEES, to: RELAY_TARGET, data: CHECK_IN });
    expect(sent).toHaveLength(1);
    expect(await recoverTransactionAddress({ serializedTransaction: sent[0] as `0x02${string}` })).toBe(account.address);
    const decision = await refusal(wallet.sendTransaction({ ...FEES, to: STRANGER, value: 1n }));
    expect(decision.rule).toBe("transaction.target-not-allowed");
    expect(sent).toHaveLength(1);
  });

  it("signs typed data through the wallet client, which adds the derived EIP712Domain type", async () => {
    const account = freshAccount();
    const wallet = createWalletClient({ account: guardAccount(account, relayerPolicy()), chain: bsc, transport: custom({ request: async () => null }) });
    const typedData = {
      domain: { name: "Example", version: "1", chainId: CHAIN, verifyingContract: PERMIT_CONTRACT },
      types: { ClaimPermit: [{ name: "to", type: "address" }] },
      primaryType: "ClaimPermit",
      message: { to: PAYEE },
    } as const;
    const signature = await wallet.signTypedData(typedData);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(account.address);
  });

  it("refuses an OP-stack chain serializer unless it is trusted", async () => {
    const request = { ...FEES, chainId: base.id, to: RELAY_TARGET, data: CHECK_IN };
    const policy = { chainIds: [base.id], transactions: { calls: [{ to: RELAY_TARGET, selectors: [CHECK_IN] }] } };
    const serializer = base.serializers?.transaction;
    if (serializer === undefined) throw new Error("viem defines no Base serializer");
    const strict = guardAccount(freshAccount(), policy);
    expect((await refusal(strict.signTransaction(request, { serializer }))).rule).toBe("transaction.custom-serializer");
    const account = freshAccount();
    const trusting = guardAccount(account, policy, { trustedSerializers: [serializer] });
    const signed = await trusting.signTransaction(request, { serializer });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(account.address);
  });
});

describe("guardAccount with other accounts", () => {
  it("blocks getHdKey on an HD account, so the key cannot be read through the wrapper", async () => {
    const account = mnemonicToAccount(generateMnemonic(english));
    const seen: Decision[] = [];
    const guarded = guardAccount(account, relayerPolicy(), { onDecision: (decision) => void seen.push(decision) });
    let thrown: unknown;
    try {
      guarded.getHdKey();
    } catch (error) {
      thrown = error;
    }
    expect(findRefusal(thrown)?.decision).toMatchObject({ allowed: false, rule: "method.unknown", summary: { method: "getHdKey" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.map((decision) => decision.rule)).toEqual(["method.unknown"]);
  });

  it("refuses a method the account lacks instead of leaving viem to ask the RPC node", async () => {
    const minimal = {
      address: freshAccount().address,
      type: "local" as const,
      signMessage: async (_parameters: { message: unknown }) => "0x00" as const,
    };
    const guarded = guardAccount(minimal, relayerPolicy()) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    expect(Object.keys(guarded).sort()).toEqual(["address", "sign", "signAuthorization", "signMessage", "signTransaction", "signTypedData", "type"]);
    const permit = {
      domain: { name: "Example", chainId: CHAIN, verifyingContract: PERMIT_CONTRACT },
      types: { ClaimPermit: [{ name: "to", type: "address" }] },
      primaryType: "ClaimPermit",
      message: { to: PAYEE },
    };
    expect((await refusal(guarded["signTypedData"]!(permit))).rule).toBe("method.unknown");
    expect((await refusal(guarded["signTransaction"]!({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }))).rule).toBe("method.unknown");
    expect((await refusal(guarded["signMessage"]!({ message: "hello" }))).rule).toBe("message.not-allowed");
  });

  it("keeps type and address of an account that defines them as prototype getters", async () => {
    const inner = freshAccount();
    class KmsAccount {
      get type() {
        return "local" as const;
      }
      get address() {
        return inner.address;
      }
      signTransaction = inner.signTransaction;
    }
    const guarded = guardAccount(new KmsAccount(), relayerPolicy());
    expect(guarded.type).toBe("local");
    expect(guarded.address).toBe(inner.address);
    const wallet = createWalletClient({ account: guarded as never, chain: bsc, transport: custom({ request: async ({ method }) => (method === "eth_chainId" ? toHex(CHAIN) : `0x${"11".repeat(32)}`) }) });
    await wallet.sendTransaction({ ...FEES, to: RELAY_TARGET, data: CHECK_IN });
  });

  it("reads type once, so a getter that changes its answer cannot turn the copy into a JSON-RPC account", () => {
    const inner = freshAccount();
    let reads = 0;
    const flipping = {
      address: inner.address,
      get type() {
        return reads++ === 0 ? "local" : "json-rpc";
      },
      signTransaction: inner.signTransaction,
    };
    expect((guardAccount(flipping as never, relayerPolicy()) as { type: string }).type).toBe("local");
  });

  it("leaves out fields viem does not need, so a nested signer is not reachable", () => {
    const inner = freshAccount();
    const withSigner = { ...inner, signer: { signTransaction: inner.signTransaction }, hdKey: { privateKey: new Uint8Array(32) } };
    const guarded = guardAccount(withSigner, relayerPolicy()) as unknown as Record<string, unknown>;
    expect(guarded["signer"]).toBeUndefined();
    expect(guarded["hdKey"]).toBeUndefined();
    expect(guarded["publicKey"]).toBe(inner.publicKey);
  });

  it("findRefusal finds the refusal whether viem wraps it or not", async () => {
    const wallet = createWalletClient({ account: guardAccount(freshAccount(), relayerPolicy()), chain: bsc, transport: custom({ request: async () => toHex(CHAIN) }) });
    const wrapped = await wallet.sendTransaction({ ...FEES, to: STRANGER, value: 1n }).catch((error: unknown) => error);
    const direct = await wallet.signMessage({ message: "nope" }).catch((error: unknown) => error);
    expect(wrapped).not.toBeInstanceOf(SignGuardError);
    expect(findRefusal(wrapped)?.decision?.rule).toBe("transaction.target-not-allowed");
    expect(findRefusal(direct)?.decision?.rule).toBe("message.not-allowed");
    expect(findRefusal(new Error("other"))).toBeUndefined();
  });

  it("validates its own options", () => {
    const account = freshAccount();
    expect(() => guardAccount(account, relayerPolicy(), { trustedSerializers: (() => "0x") as never })).toThrow("must be a list");
    expect(() => guardAccount(account, relayerPolicy(), { releaseOnSignerError: "false" as never })).toThrow("true or false");
    expect(() => guardAccount(account, createSignGuard(relayerPolicy()), { onDecision: () => undefined })).toThrow("pass them to createSignGuard instead");
    expect(() => guardAccount(account, createSignGuard(relayerPolicy()), { onDecision: undefined, scope: undefined } as never)).not.toThrow();
    expect(() => guardAccount(account, relayerPolicy(), null as never)).toThrow("options must be an object");
    expect(() => guardAccount(account, null as never)).toThrow("policy must be an object");
  });

  it("refuses to wrap a JSON-RPC account, which viem would sign for over RPC", () => {
    expect(() => guardAccount(toAccount(PAYEE) as never, relayerPolicy())).toThrow('needs a local account (type "local"), got "json-rpc"');
    expect(() => guardAccount({ address: PAYEE } as never, relayerPolicy())).toThrow("needs a local account");
  });

  it("passes { serializer } the way viem does, so a KMS-style account that destructures it works", async () => {
    const inner = freshAccount();
    const kms = toAccount({
      address: inner.address,
      sign: inner.sign,
      signAuthorization: inner.signAuthorization,
      signMessage: inner.signMessage,
      signTypedData: inner.signTypedData,
      async signTransaction(transaction, options) {
        const { serializer } = options!; // throws on undefined, as an account written this way would
        return inner.signTransaction(transaction, { serializer });
      },
    });
    const guarded = guardAccount(kms, relayerPolicy());
    const signed = await guarded.signTransaction({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(inner.address);
  });

  it("does not spend a window on a signing method the account lacks", async () => {
    const inner = freshAccount();
    const noDelegation = { address: inner.address, type: "local" as const, signTransaction: inner.signTransaction };
    const guarded = guardAccount(noDelegation, relayerPolicy()) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await refusal(guarded["signAuthorization"]!({ address: DELEGATE, chainId: CHAIN, nonce: attempt }))).rule).toBe("method.unknown");
    }
  });

  it("refuses, and records, a message whose getter throws", async () => {
    const seen: Decision[] = [];
    const guarded = guardAccount(freshAccount(), relayerPolicy(), { onDecision: (decision) => void seen.push(decision) });
    const parameters = {
      get message(): string {
        throw new Error("boom");
      },
    };
    expect((await refusal(guarded.signMessage(parameters))).rule).toBe("request.malformed");
    expect(seen.map((decision) => decision.rule)).toEqual(["request.malformed"]);
  });

  it("refuses a serializer that cannot be read", async () => {
    const guarded = guardAccount(freshAccount(), relayerPolicy());
    const signTransaction = guarded.signTransaction as (transaction: unknown, options: unknown) => Promise<unknown>;
    const options = {
      get serializer(): unknown {
        throw new Error("boom");
      },
    };
    expect((await refusal(signTransaction({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }, options))).rule).toBe("transaction.custom-serializer");
  });

  it("refuses, and records, a signable field it cannot copy", async () => {
    const seen: Decision[] = [];
    const guarded = guardAccount(freshAccount(), relayerPolicy(), { onDecision: (decision) => void seen.push(decision) });
    const withFunction = { ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, accessList: [() => 1] };
    expect((await refusal(guarded.signTransaction(withFunction as never))).rule).toBe("request.malformed");
    expect(seen.map((decision) => decision.rule)).toEqual(["request.malformed"]);
  });

  it("copies trustedSerializers, so adding one later changes nothing", async () => {
    const trustedSerializers: unknown[] = [];
    const guarded = guardAccount(freshAccount(), relayerPolicy(), { trustedSerializers });
    const evil = () => "0xdeadbeef";
    trustedSerializers.push(evil);
    const signTransaction = guarded.signTransaction as (transaction: unknown, options: { serializer: unknown }) => Promise<unknown>;
    expect((await refusal(signTransaction({ ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN }, { serializer: evil }))).rule).toBe(
      "transaction.custom-serializer",
    );
  });

  it("keeps the signer's own error when the refund fails", async () => {
    const account = freshAccount();
    const failing = { ...account, signTransaction: async (_transaction: unknown) => Promise.reject(new Error("invalid transaction")) };
    const ledger = { reserve: () => true, release: () => Promise.reject(new Error("ledger down")) };
    const guarded = guardAccount(failing, createSignGuard(relayerPolicy(), { ledger }), { releaseOnSignerError: true });
    await expect(guarded.signTransaction({ ...FEES, chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, 1n) })).rejects.toThrow("invalid transaction");
  });

  it("signs only the standard fields, dropping extras such as the account viem passes along", async () => {
    const account = freshAccount();
    const guarded = guardAccount(account, relayerPolicy());
    const extra = { ...FEES, chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, account, from: STRANGER, r: "0x01", s: "0x02", v: 27n };
    const signed = await guarded.signTransaction(extra as never);
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(account.address);
  });
});
