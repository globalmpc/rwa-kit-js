import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMemoryLedger, createSignGuard, SignGuardError, type Decision, type SignRequest, type Spend, type SpendLedger } from "../src/index.js";
import { CHAIN, CHECK_IN, DELEGATE, ONE_HOUR, PAYEE, relayerPolicy, RELAY_TARGET, TOKEN, transferData } from "./fixtures.js";

function send(amount: bigint): SignRequest {
  return { kind: "transaction", transaction: { chainId: CHAIN, to: TOKEN, data: transferData(PAYEE, amount) } };
}

function delegate(nonce: number): SignRequest {
  return { kind: "authorization", authorization: { address: DELEGATE, chainId: CHAIN, nonce } };
}

describe("createSignGuard", () => {
  it("fails at start-up on a malformed policy", () => {
    expect(() => createSignGuard({ chainIds: [] })).toThrow(SignGuardError);
  });

  it("enforces the token window and frees it as time passes", async () => {
    let now = 1_000_000;
    const guard = createSignGuard(relayerPolicy(), { now: () => now });
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    const third = await guard.check(send(1_000n));
    expect(third).toMatchObject({ allowed: false, rule: "window.exceeded", reservations: [] });
    expect(third.reason).toContain(`token:${CHAIN}:${TOKEN}`);
    expect((await guard.check(send(500n))).allowed).toBe(true);
    expect((await guard.check(send(1n))).allowed).toBe(false);
    now += ONE_HOUR;
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
  });

  it("allows one delegation per hour by default", async () => {
    let now = 0;
    const guard = createSignGuard(relayerPolicy(), { now: () => now });
    expect((await guard.check(delegate(1))).allowed).toBe(true);
    expect((await guard.check(delegate(2))).rule).toBe("window.exceeded");
    now += ONE_HOUR - 1;
    expect((await guard.check(delegate(2))).rule).toBe("window.exceeded");
    now += 1;
    expect((await guard.check(delegate(2))).allowed).toBe(true);
  });

  it("enforces the native window across contract calls", async () => {
    const guard = createSignGuard(relayerPolicy(), { now: () => 0 });
    const call = (value: bigint): SignRequest => ({ kind: "transaction", transaction: { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, value } });
    for (let index = 0; index < 3; index++) expect((await guard.check(call(10n ** 16n))).allowed).toBe(true);
    expect((await guard.check(call(1n))).rule).toBe("window.exceeded");
    expect((await guard.check(call(0n))).allowed).toBe(true);
  });

  it("gives reservations back on release, once, and only for its own decisions", async () => {
    const guard = createSignGuard(relayerPolicy(), { now: () => 0 });
    const first = await guard.check(send(1_000n));
    await guard.check(send(1_000n));
    expect((await guard.check(send(1_000n))).allowed).toBe(false);
    await guard.release(first);
    await guard.release(first);
    await guard.release({ ...first });
    first.reservations = [{ ...first.reservations[0]!, amount: 2_500n }];
    await guard.release(first);
    // One release frees 1,000 of the 2,000 used: 1,000 + 500 fit, a further 1,000 does not.
    // Had the second release (or the forged copy) freed more, the last check would pass.
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    expect((await guard.check(send(500n))).allowed).toBe(true);
    expect((await guard.check(send(1_000n))).allowed).toBe(false);
  });

  it("releases what it issued even if the decision's spends are edited in place", async () => {
    const guard = createSignGuard(relayerPolicy(), { now: () => 0 });
    const small = await guard.check(send(1n));
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    (small.reservations[0] as { amount: bigint }).amount = 1_000n;
    await guard.release(small);
    expect((await guard.check(send(501n))).allowed).toBe(false);
  });

  it("keeps the windows of guards sharing a ledger apart by scope, and hands the ledger its own copies", async () => {
    const ledger = createMemoryLedger();
    const stored: Spend[] = [];
    const recording: SpendLedger = { reserve: (spend, at) => (stored.push(spend), ledger.reserve(spend, at)), release: (spend, at) => ledger.release(spend, at) };
    const a = createSignGuard(relayerPolicy(), { ledger: recording, scope: "key-a", now: () => 0 });
    const b = createSignGuard(relayerPolicy(), { ledger: recording, scope: "key-b", now: () => 0 });
    expect((await a.check(delegate(1))).allowed).toBe(true);
    const fromB = await b.check(delegate(1));
    expect(fromB.allowed).toBe(true);
    expect(fromB.reservations[0]?.key).toBe("key-b:authorization");
    (fromB.reservations[0] as { amount: bigint }).amount = 0n;
    expect(stored.map((spend) => spend.amount)).toEqual([1n, 1n]);
  });

  it("refuses a shared key used with two window lengths, instead of letting one erase the other", async () => {
    let now = 0;
    const ledger = createMemoryLedger();
    const hourly = createSignGuard({ chainIds: [CHAIN], authorizations: { allow: [DELEGATE], window: { durationMs: ONE_HOUR, max: 3 } } }, { ledger, scope: "k", now: () => now });
    const minutely = createSignGuard({ chainIds: [204], authorizations: { allow: [DELEGATE], window: { durationMs: 60_000, max: 1 } } }, { ledger, scope: "k", now: () => now });
    const delegateOn = (chainId: number): SignRequest => ({ kind: "authorization", authorization: { address: DELEGATE, chainId, nonce: 0 } });
    expect((await minutely.check(delegateOn(204))).allowed).toBe(true);
    now = 10_000;
    const mismatch = await hourly.check(delegateOn(CHAIN));
    expect(mismatch.rule).toBe("ledger.failed");
    expect(mismatch.reason).toContain("give it one length");
    // Once nothing is left counting under the old length, the key is free to take the new one.
    now = 200_000;
    expect((await hourly.check(delegateOn(CHAIN))).allowed).toBe(true);
  });

  it("records ledger.failed whatever the ledger throws", async () => {
    const seen: string[] = [];
    let reads = 0;
    const shifting = Object.create(Error.prototype, { message: { get: () => (reads++ === 0 ? "x" : 7) } }) as Error;
    for (const thrown of [Object.create(null), 42, "text", Object.assign(new Error(), { message: 7 }), shifting, { message: "plain object" }]) {
      const ledger: SpendLedger = {
        reserve: () => {
          throw thrown;
        },
        release: () => undefined,
      };
      const guard = createSignGuard(relayerPolicy(), { ledger, onDecision: (decision) => void seen.push(decision.rule) });
      expect((await guard.check(send(1n))).rule).toBe("ledger.failed");
    }
    expect(seen).toEqual(Array(6).fill("ledger.failed"));
  });

  it("refuses when the ledger answers anything but true or false", async () => {
    for (const answer of ["0", 1, { ok: false }, undefined]) {
      const ledger = { reserve: () => answer, release: () => undefined } as unknown as SpendLedger;
      const decision = await createSignGuard(relayerPolicy(), { ledger }).check(send(1n));
      expect(decision.rule).toBe("ledger.failed");
      expect(decision.reason).toContain("not true or false");
    }
  });

  it("refuses unknown option keys, so a misspelt hook is not silently dropped", () => {
    expect(() => createSignGuard(relayerPolicy(), { onDecison: () => undefined } as never)).toThrow('unknown option "onDecison"');
    expect(() => createSignGuard(relayerPolicy(), null as never)).toThrow(SignGuardError);
  });

  it("caps resets across chains with one window", async () => {
    const guard = createSignGuard({ chainIds: [CHAIN, 204], authorizations: { allow: [], resetWindow: { durationMs: ONE_HOUR, max: 1 } } }, { now: () => 0 });
    const reset = (chainId: number): SignRequest => ({ kind: "authorization", authorization: { address: "0x0000000000000000000000000000000000000000", chainId, nonce: 0 } });
    expect((await guard.check(reset(CHAIN))).allowed).toBe(true);
    expect((await guard.check(reset(204))).rule).toBe("window.exceeded");
  });

  it("stamps decisions with real time when the clock is broken, and reports audit failures", async () => {
    const before = Date.now();
    const decision = await createSignGuard(relayerPolicy(), { now: () => Number.NaN }).check(send(1n));
    expect(decision.rule).toBe("clock.invalid");
    expect(decision.at).toBeGreaterThanOrEqual(before);
    const seen: string[] = [];
    let calls = 0;
    const guard = createSignGuard(relayerPolicy(), {
      onDecision: (d) => {
        calls++;
        if (calls === 1) throw new Error("webhook timeout");
        seen.push(d.rule);
      },
    });
    expect((await guard.check(send(1n))).rule).toBe("audit.failed");
    expect(seen).toEqual(["audit.failed"]);
  });

  it("releases what it issued, not what an edited decision claims", async () => {
    const guard = createSignGuard(relayerPolicy(), { now: () => 0 });
    const small = await guard.check(send(1n));
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    small.reservations = [{ ...small.reservations[0]!, amount: 1_000n }];
    await guard.release(small);
    // Only the 1 issued to `small` came back: 2,000 is still used, so 501 does not fit. Had the
    // edited 1,000 been released, one of the other transfers' entries would be gone and 501 would fit.
    expect((await guard.check(send(501n))).allowed).toBe(false);
    expect((await guard.check(send(500n))).allowed).toBe(true);
  });

  it("hands onDecision a copy, so the hook cannot change what is signed", async () => {
    const guard = createSignGuard(relayerPolicy(), {
      onDecision: (decision) => {
        if (decision.request.kind === "transaction") (decision.request.transaction as { to?: string }).to = TOKEN;
      },
    });
    const decision = await guard.check({ kind: "transaction", transaction: { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN } });
    expect(decision.request).toMatchObject({ transaction: { to: RELAY_TARGET } });
  });

  it("records malformed requests instead of throwing, on a whole-millisecond wall clock by default", async () => {
    const seen: Decision[] = [];
    const guard = createSignGuard(relayerPolicy(), { onDecision: (decision) => void seen.push(decision) });
    const decision = await guard.check({ kind: "authorization", authorization: { address: 123, chainId: CHAIN, nonce: 1 } } as never);
    expect(decision).toMatchObject({ allowed: false, rule: "authorization.malformed" });
    expect(await guard.check(undefined as never)).toMatchObject({ allowed: false, rule: "request.malformed", kind: "unreadable" });
    expect(seen).toHaveLength(2);
    expect(Math.abs(decision.at - Date.now())).toBeLessThan(60_000);
    expect(Number.isInteger(decision.at)).toBe(true);
    expect("policy" in guard).toBe(false);
  });

  it("judges its own snapshot, so a getter cannot answer differently later", async () => {
    let reads = 0;
    const request = {
      kind: "transaction",
      transaction: {
        chainId: CHAIN,
        data: CHECK_IN,
        get to() {
          reads++;
          return reads === 1 ? RELAY_TARGET : TOKEN;
        },
      },
    } as unknown as SignRequest;
    const decision = await createSignGuard(relayerPolicy()).check(request);
    expect(decision.allowed).toBe(true);
    expect(decision.request).toMatchObject({ kind: "transaction", transaction: { to: RELAY_TARGET } });
    expect(decision.request).not.toBe(request);
    expect(reads).toBe(1);
  });

  it("refuses every request when the clock is not a whole number, instead of letting windows lapse", async () => {
    for (const now of [() => Number.NaN, () => 1.5, () => -1, () => undefined as unknown as number, () => { throw new Error("no clock"); }]) {
      const guard = createSignGuard(relayerPolicy(), { now });
      expect((await guard.check(send(1n))).rule).toBe("clock.invalid");
    }
  });

  it("refuses, rolls back and records when the ledger fails", async () => {
    const seen: Decision[] = [];
    const inner = createMemoryLedger();
    const ledger: SpendLedger = {
      reserve: (spend, at) => {
        if (spend.key.startsWith("token")) throw new Error("redis down");
        return inner.reserve(spend, at);
      },
      release: (spend, at) => inner.release(spend, at),
    };
    const policy = { chainIds: [CHAIN], transactions: { maxValue: 10n, window: { durationMs: ONE_HOUR, max: 10n }, tokens: [{ token: TOKEN, maxAmount: 5n, window: { durationMs: ONE_HOUR, max: 5n } }] } };
    const guard = createSignGuard(policy, { ledger, now: () => 0, onDecision: (decision) => void seen.push(decision) });
    const request: SignRequest = { kind: "transaction", transaction: { chainId: CHAIN, to: TOKEN, value: 10n, data: transferData(PAYEE, 1n) } };
    expect((await guard.check(request)).rule).toBe("ledger.failed");
    expect(seen.map((decision) => decision.rule)).toEqual(["ledger.failed"]);
    expect(inner.reserve({ key: `native:${CHAIN}`, amount: 10n, durationMs: ONE_HOUR, max: 10n }, 0)).toBe(true);
  });

  it("caps resets at 25 an hour by default, apart from the delegation window", async () => {
    const guard = createSignGuard(relayerPolicy(), { now: () => 0 });
    const reset = (nonce: number): SignRequest => ({ kind: "authorization", authorization: { address: "0x0000000000000000000000000000000000000000", chainId: CHAIN, nonce } });
    for (let nonce = 0; nonce < 25; nonce++) expect((await guard.check(reset(nonce))).allowed).toBe(true);
    expect((await guard.check(reset(25))).rule).toBe("window.exceeded");
    expect((await guard.check(delegate(1))).allowed).toBe(true);
  });

  it("records a refusal for a payload that is not an object", async () => {
    const seen: Decision[] = [];
    const guard = createSignGuard(relayerPolicy(), { onDecision: (decision) => void seen.push(decision) });
    expect((await guard.check({ kind: "transaction", transaction: () => 1 } as never)).rule).toBe("request.malformed");
    expect((await guard.check({ kind: "typedData", typedData: Symbol("x") } as never)).rule).toBe("request.malformed");
    expect((await guard.check({ kind: "authorization", authorization: [] } as never)).rule).toBe("request.malformed");
    expect(seen.map((decision) => decision.rule)).toEqual(["request.malformed", "request.malformed", "request.malformed"]);
  });

  it("calls a misspelt kind an unknown method", async () => {
    expect(await createSignGuard(relayerPolicy()).check({ kind: "typed-data" } as never)).toMatchObject({ rule: "method.unknown", kind: "unknown" });
  });

  it("refuses and records a request it cannot copy", async () => {
    const seen: Decision[] = [];
    const guard = createSignGuard(relayerPolicy(), { onDecision: (decision) => void seen.push(decision) });
    const request = { kind: "transaction", transaction: { chainId: CHAIN, to: RELAY_TARGET, data: CHECK_IN, accessList: [() => 1] } } as unknown as SignRequest;
    expect(await guard.check(request)).toMatchObject({ allowed: false, kind: "unreadable", rule: "request.malformed", summary: { method: "transaction" } });
    const throwing = {
      kind: "message",
      get message(): string {
        throw new Error("boom");
      },
    } as unknown as SignRequest;
    expect((await guard.check(throwing)).rule).toBe("request.malformed");
    expect(seen).toHaveLength(2);
  });

  it("reports every decision to the hook, allowed and refused", async () => {
    const seen: Decision[] = [];
    const guard = createSignGuard(relayerPolicy(), { now: () => 42, onDecision: (decision) => void seen.push(decision) });
    await guard.check(send(1n));
    await guard.check({ kind: "hash" });
    expect(seen.map((decision) => [decision.kind, decision.allowed, decision.rule, decision.at])).toEqual([
      ["transaction", true, "allowed", 42],
      ["hash", false, "hash.denied", 42],
    ]);
  });

  it("refuses and frees the window when the audit hook fails", async () => {
    let failing = true;
    const guard = createSignGuard(relayerPolicy(), {
      now: () => 0,
      onDecision: () => {
        if (failing) throw new Error("log store down");
      },
    });
    expect(await guard.check(send(1_000n))).toMatchObject({ allowed: false, rule: "audit.failed" });
    failing = false;
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    expect((await guard.check(send(1_000n))).allowed).toBe(true);
    expect((await guard.check(send(1_000n))).allowed).toBe(false);
  });

  it("returns earlier reservations when a later window is full", async () => {
    const reserved: string[] = [];
    const inner = createMemoryLedger();
    const ledger: SpendLedger = {
      reserve: (spend, at) => {
        const ok = spend.key.startsWith("native") ? inner.reserve(spend, at) : false;
        if (ok) reserved.push(spend.key);
        return ok;
      },
      release: (spend, at) => {
        reserved.splice(reserved.indexOf(spend.key), 1);
        return inner.release(spend, at);
      },
    };
    const guard = createSignGuard(
      { chainIds: [CHAIN], transactions: { maxValue: 10n, window: { durationMs: 1, max: 10n }, tokens: [{ token: TOKEN, maxAmount: 5n, window: { durationMs: 1, max: 5n } }] } },
      { ledger, now: () => 0 },
    );
    const decision = await guard.check({ kind: "transaction", transaction: { chainId: CHAIN, to: TOKEN, value: 1n, data: transferData(PAYEE, 1n) } });
    expect(decision.rule).toBe("window.exceeded");
    expect(reserved).toEqual([]);
  });

  it("never lets the sum inside any window pass its limit (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.bigInt({ min: 0n, max: 1_000n }), fc.integer({ min: 0, max: 1_200_000 })), { maxLength: 40 }), async (steps) => {
        let now = 0;
        const guard = createSignGuard(relayerPolicy(), { now: () => now });
        const accepted: Array<{ at: number; amount: bigint }> = [];
        for (const [amount, gap] of steps) {
          now += gap;
          if ((await guard.check(send(amount))).allowed) accepted.push({ at: now, amount });
          const inWindow = accepted.filter((entry) => entry.at > now - ONE_HOUR).reduce((sum, entry) => sum + entry.amount, 0n);
          expect(inWindow).toBeLessThanOrEqual(2_500n);
        }
      }),
    );
  });
});
