import { describe, expect, it } from "vitest";
import { classifyCode, createWatcher, WatchError, type Alert, type WalletSpec } from "../src/index.js";
import { COLD, DELEGATE, delegationCode, FakeEndpoint, HOT, SWEEPER, TOKEN } from "./fake-chain.js";

const kinds = (alerts: readonly Alert[]) => alerts.map((alert) => alert.kind).sort();

function pair() {
  const a = new FakeEndpoint().set(HOT, { balance: 1_000n, nonce: 5n });
  const b = new FakeEndpoint().set(HOT, { balance: 1_000n, nonce: 5n });
  return { a, b, endpoints: [a.rpc("a"), b.rpc("b")] };
}

describe("classifyCode", () => {
  it("tells no code, a delegation and contract code apart", () => {
    expect(classifyCode("0x")).toEqual({ kind: "none" });
    expect(classifyCode(delegationCode(SWEEPER))).toEqual({ kind: "delegated", delegate: SWEEPER });
    expect(classifyCode("0x6080604052")).toEqual({ kind: "contract", size: 5 });
    expect(classifyCode(`${delegationCode(SWEEPER)}00`)).toMatchObject({ kind: "contract" });
  });
});

describe("createWatcher", () => {
  it("reports a clean wallet with no alerts, each endpoint read at its own head", async () => {
    const { a, b, endpoints } = pair();
    b.head = 998;
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, label: "relayer" }] }).check();
    expect(report.alerts).toEqual([]);
    expect(report.block).toBe(1_000);
    expect([...a.blocksAsked]).toEqual(["0x3e8"]);
    expect([...b.blocksAsked]).toEqual(["0x3e6"]);
    expect(report.wallets).toEqual([{ address: HOT, label: "relayer", code: { kind: "none" }, nonce: "5", balance: "1000" }]);
    expect(report.endpoints).toEqual([
      { label: "endpoint-1", head: 1_000 },
      { label: "endpoint-2", head: 998 },
    ]);
  });

  it("raises a critical alert for a delegation to an unlisted contract", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { code: delegationCode(SWEEPER) });
    b.set(HOT, { code: delegationCode(SWEEPER) });
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0]).toMatchObject({ kind: "delegated", severity: "critical", detail: { delegate: SWEEPER }, observedBy: ["endpoint-1", "endpoint-2"], block: 1_000 });
    expect(report.wallets[0]?.code).toEqual({ kind: "delegated", delegate: SWEEPER });
  });

  it("accepts a delegation to a listed delegate", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { code: delegationCode(DELEGATE) });
    b.set(HOT, { code: delegationCode(DELEGATE) });
    expect((await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, delegates: [DELEGATE] }] }).check()).alerts).toEqual([]);
  });

  it("lets one endpoint seeing the delegation raise the alarm, and flags the disagreement", async () => {
    const { a, endpoints } = pair();
    a.set(HOT, { code: delegationCode(SWEEPER) });
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(kinds(report.alerts)).toEqual(["delegated", "endpoints-disagree"]);
    expect(report.alerts.find((alert) => alert.kind === "delegated")?.observedBy).toEqual(["endpoint-1"]);
  });

  it("raises unexpected code, except for a wallet declared a contract", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { code: "0x6080604052" });
    b.set(HOT, { code: "0x6080604052" });
    expect(kinds((await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check()).alerts)).toEqual(["unexpected-code"]);
    expect((await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, contract: true }] }).check()).alerts).toEqual([]);
  });

  it("raises an unexpected nonce on a frozen wallet after the first reading", async () => {
    const { a, b, endpoints } = pair();
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, frozen: true }] });
    expect((await watcher.check()).alerts).toEqual([]);
    a.set(HOT, { nonce: 6n });
    b.set(HOT, { nonce: 6n });
    const report = await watcher.check();
    expect(report.alerts[0]).toMatchObject({ kind: "unexpected-nonce", severity: "critical", detail: { source: "frozen", observed: "6" }, observedBy: ["endpoint-1", "endpoint-2"] });
  });

  it("compares the nonce with what your own system sent", async () => {
    const { endpoints } = pair();
    let sent = 5;
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, expectedNonce: () => sent }] });
    expect((await watcher.check()).alerts).toEqual([]);
    sent = 4;
    expect((await watcher.check()).alerts[0]).toMatchObject({ kind: "unexpected-nonce", detail: { expected: "4", observed: "5" } });
  });

  it("warns, without stopping, when expectedNonce fails or answers nonsense", async () => {
    for (const expectedNonce of [() => { throw new Error("db down"); }, () => -1, () => 1.5, () => "5" as unknown as number, async () => Promise.reject(new Error("x"))]) {
      const { endpoints } = pair();
      expect(kinds((await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, expectedNonce }] }).check()).alerts)).toEqual(["expected-nonce-failed"]);
    }
  });

  it("raises a native outflow above the cap, net of deposits, within the window", async () => {
    const { a, b, endpoints } = pair();
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 500n } }], now: () => now });
    const setBalance = (balance: bigint) => {
      a.set(HOT, { balance });
      b.set(HOT, { balance });
      a.head++;
      b.head++;
    };
    expect((await watcher.check()).alerts).toEqual([]);
    now = 1_000;
    setBalance(700n); // 300 out
    expect((await watcher.check()).alerts).toEqual([]);
    now = 2_000;
    setBalance(1_200n); // a deposit is not an outflow
    expect((await watcher.check()).alerts).toEqual([]);
    now = 3_000;
    setBalance(900n); // 300 more: 600 in the window
    expect((await watcher.check()).alerts[0]).toMatchObject({ kind: "outflow", detail: { asset: "native", amount: "600", max: "500" } });
    now = 70_000; // both falls have left the window
    expect((await watcher.check()).alerts).toEqual([]);
  });

  it("raises a token outflow read through balanceOf", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { tokens: { [TOKEN]: 10_000n } });
    b.set(HOT, { tokens: { [TOKEN]: 10_000n } });
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, tokens: [{ token: TOKEN, outflow: { durationMs: 60_000, max: 1_000n } }] }], now: () => 0 });
    expect((await watcher.check()).alerts).toEqual([]);
    a.set(HOT, { tokens: { [TOKEN]: 0n } });
    b.set(HOT, { tokens: { [TOKEN]: 0n } });
    a.head++;
    b.head++;
    expect((await watcher.check()).alerts[0]).toMatchObject({ kind: "outflow", detail: { asset: "token", token: TOKEN, amount: "10000" } });
  });

  it("takes the lowest balance any endpoint reports, so one endpoint cannot hide a drain", async () => {
    const { a, endpoints } = pair();
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 100n } }], now: () => 0 });
    await watcher.check();
    a.set(HOT, { balance: 0n });
    expect(kinds((await watcher.check()).alerts)).toEqual(["endpoints-disagree", "outflow"]);
  });

  it("goes on with the endpoints that answer, and warns about the one that does not", async () => {
    const { a, endpoints } = pair();
    a.broken.set("eth_getBalance", "fail");
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed"]);
    expect(report.wallets[0]?.balance).toBe("1000");
  });

  it("treats a malformed answer as a failed reading, never as all clear", async () => {
    for (const [method, value] of [["eth_getCode", 7], ["eth_getCode", "0x0"], ["eth_getTransactionCount", "0x01"], ["eth_getBalance", null]] as const) {
      const a = new FakeEndpoint().set(HOT, { balance: 1n });
      a.broken.set(method, value);
      const report = await createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, tokens: [{ token: TOKEN, outflow: { durationMs: 1, max: 0n } }] }] }).check();
      expect(kinds(report.alerts)).toEqual(["endpoint-failed", "wallet-unreadable"]);
      expect(report.wallets[0]?.code).toBeNull();
    }
  });

  it("raises no-endpoint when nothing answers", async () => {
    const { a, b, endpoints } = pair();
    a.broken.set("eth_blockNumber", "fail");
    b.broken.set("eth_blockNumber", "0xzz");
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(report.block).toBeNull();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed", "endpoint-failed", "no-endpoint"]);
    expect(report.alerts.find((alert) => alert.kind === "no-endpoint")?.severity).toBe("critical");
  });

  it("reports a lagging endpoint but still lets it raise the alarm, reading each at its own head", async () => {
    const { a, b, endpoints } = pair();
    b.head = 900;
    b.set(HOT, { code: delegationCode(SWEEPER) });
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(report.block).toBe(1_000);
    expect(kinds(report.alerts)).toEqual(["delegated", "endpoint-lagging"]);
    expect(report.alerts.find((alert) => alert.kind === "delegated")).toMatchObject({ observedBy: ["endpoint-2"], block: 900 });
    expect([...a.blocksAsked]).toEqual(["0x3e8"]);
  });

  it("cannot be blinded by an endpoint reporting an inflated head", async () => {
    const { a, b, endpoints } = pair();
    a.head = 4_000_000_000;
    b.set(HOT, { code: delegationCode(SWEEPER) });
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(report.alerts.find((alert) => alert.kind === "delegated")?.observedBy).toEqual(["endpoint-2"]);
  });

  it("leaves out an endpoint on another chain", async () => {
    const { b, endpoints } = pair();
    b.chainId = 97;
    b.set(HOT, { code: delegationCode(SWEEPER) });
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed"]);
    expect(report.alerts[0]?.message).toContain("is on chain 97, not 56");
    expect(report.endpoints[1]).toMatchObject({ head: null });
  });

  it("does not let an endpoint first read after a compromise adopt it, for frozen nonces and outflows", async () => {
    const { a, b, endpoints } = pair();
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, frozen: true, outflow: { durationMs: 60_000, max: 100n } }], now: () => 0 });
    b.broken.set("eth_getCode", "fail");
    await watcher.check(); // only endpoint-1 reads: nonce 5, balance 1,000
    a.broken.set("eth_blockNumber", "fail");
    b.broken.delete("eth_getCode");
    b.set(HOT, { nonce: 6n, balance: 0n }); // the key signed and the wallet was drained
    b.head++;
    const report = await watcher.check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed", "outflow", "unexpected-nonce"]);
    expect(report.alerts.find((alert) => alert.kind === "outflow")).toMatchObject({ observedBy: ["endpoint-2"], detail: { amount: "1000" } });
  });

  it("keeps the frozen baseline at the lowest first nonce, so one inflated nonce cannot blind the others", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { nonce: 4_294_967_295n });
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, frozen: true }] });
    // The baseline is 5, the lowest first reading; the inflated endpoint is itself raised (the alarm wins).
    expect((await watcher.check()).alerts.find((alert) => alert.kind === "unexpected-nonce")?.observedBy).toEqual(["endpoint-1"]);
    b.set(HOT, { nonce: 6n });
    const report = await watcher.check();
    expect(report.alerts.find((alert) => alert.kind === "unexpected-nonce")?.observedBy).toEqual(["endpoint-1", "endpoint-2"]);
  });

  it("still detects outflows after an endpoint reported one inflated block", async () => {
    const a = new FakeEndpoint().set(HOT, { balance: 1_000n });
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 100n } }], now: () => now });
    a.head = 4_000_000_000;
    await watcher.check();
    a.head = 1_001;
    now = 1;
    await watcher.check();
    a.head = 1_002;
    a.set(HOT, { balance: 0n });
    now = 2;
    await watcher.check();
    // The third reading in a row from far behind the bogus head restarts the series, counting the fall.
    a.head = 1_003;
    now = 3;
    expect((await watcher.check()).alerts[0]).toMatchObject({ kind: "outflow", detail: { amount: "1000" } });
  });

  it("moves on from an endpoint that hangs, within the request deadline", async () => {
    const { endpoints } = pair();
    const hanging = { urls: [], call: () => new Promise<never>(() => undefined) };
    const started = Date.now();
    const report = await createWatcher({ chainId: 56, endpoints: [hanging, ...endpoints], wallets: [{ address: HOT }], requestTimeoutMs: 50 }).check();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(kinds(report.alerts)).toEqual(["endpoint-failed"]);
  });

  it("keeps checking code and nonce when a token read fails", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { code: delegationCode(SWEEPER) });
    b.set(HOT, { code: delegationCode(SWEEPER) });
    a.broken.set("eth_call", "0x");
    b.broken.set("eth_call", "fail");
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, tokens: [{ token: TOKEN, outflow: { durationMs: 1, max: 0n } }] }] }).check();
    expect(kinds(report.alerts)).toEqual(["delegated", "endpoint-failed", "endpoint-failed", "token-unreadable"]);
    expect(report.alerts.filter((alert) => alert.kind === "endpoint-failed").map((alert) => alert.detail["token"])).toEqual([TOKEN, TOKEN]);
  });

  it("cannot be silenced by an endpoint that always reports a low balance", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { balance: 100n });
    b.set(HOT, { balance: 0n }); // lying or broken, always low
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 50n } }], now: () => now });
    await watcher.check();
    a.set(HOT, { balance: 0n });
    a.head++;
    now = 1;
    const report = await watcher.check();
    expect(report.alerts.find((alert) => alert.kind === "outflow")).toMatchObject({ observedBy: ["endpoint-1"], detail: { amount: "100" } });
  });

  it("sees a deposit swept within a lagging endpoint's lag", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { balance: 100n });
    b.set(HOT, { balance: 100n });
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 40n } }], now: () => now });
    await watcher.check();
    a.set(HOT, { balance: 150n }); // a deposit; endpoint-2 is a few blocks behind and still shows 100
    a.head++;
    now = 1;
    await watcher.check();
    a.set(HOT, { balance: 100n }); // swept
    a.head++;
    now = 2;
    const report = await watcher.check();
    expect(report.alerts.find((alert) => alert.kind === "outflow")).toMatchObject({ observedBy: ["endpoint-1"], detail: { amount: "50" } });
  });

  it("adds up a drain seen in parts by endpoints taking turns to fail", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { balance: 100n });
    b.set(HOT, { balance: 100n });
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 70n } }], now: () => now });
    const step = async (balance: bigint, down: FakeEndpoint, up: FakeEndpoint) => {
      down.broken.set("eth_getBalance", "fail");
      up.broken.delete("eth_getBalance");
      a.set(HOT, { balance });
      b.set(HOT, { balance });
      now += 1;
      return watcher.check();
    };
    await watcher.check();
    await step(60n, b, a);
    await step(20n, a, b);
    const report = await step(0n, b, a);
    // Caught. The total errs high (a returning endpoint measures from its own older, higher reading).
    const outflow = report.alerts.find((alert) => alert.kind === "outflow");
    expect(BigInt(String(outflow?.detail["amount"]))).toBeGreaterThanOrEqual(100n);
  });

  it("measures a returning endpoint from its own higher reading, not a liar's low one", async () => {
    const { a: honest, b: liar, endpoints } = pair();
    honest.set(HOT, { balance: 100n });
    liar.set(HOT, { balance: 0n });
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 50n } }], now: () => now });
    await watcher.check();
    honest.set(HOT, { balance: 0n }); // drained while the honest endpoint's balance read fails
    honest.broken.set("eth_getBalance", "fail");
    now = 1;
    await watcher.check();
    honest.broken.delete("eth_getBalance");
    now = 2;
    const report = await watcher.check();
    expect(report.alerts.find((alert) => alert.kind === "outflow")).toMatchObject({ observedBy: ["endpoint-1"], detail: { amount: "100" } });
  });

  it("counts a drain seen only by an endpoint that was down during the deposit", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { balance: 10n });
    b.set(HOT, { balance: 10n });
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 50n } }], now: () => 0 });
    await watcher.check();
    b.broken.set("eth_blockNumber", "fail");
    a.set(HOT, { balance: 100n }); // a deposit, seen by endpoint-1 alone
    await watcher.check();
    a.broken.set("eth_blockNumber", "fail");
    b.broken.delete("eth_blockNumber");
    b.set(HOT, { balance: 10n }); // drained while endpoint-2 was away
    const report = await watcher.check();
    expect(report.alerts.find((alert) => alert.kind === "outflow")).toMatchObject({ observedBy: ["endpoint-2"], detail: { amount: "90", fall: "90" } });
  });

  it("counts a token drain read by an endpoint whose first token read failed", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { tokens: { [TOKEN]: 1_000n } });
    b.broken.set("eth_call", "fail");
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, tokens: [{ token: TOKEN, outflow: { durationMs: 60_000, max: 100n } }] }], now: () => 0 });
    await watcher.check();
    a.broken.set("eth_blockNumber", "fail");
    b.broken.delete("eth_call");
    b.set(HOT, { tokens: { [TOKEN]: 0n } });
    const report = await watcher.check();
    expect(report.alerts.find((alert) => alert.kind === "outflow")).toMatchObject({ detail: { asset: "token", amount: "1000" } });
  });

  it("does not call a failed token read a disagreement", async () => {
    const { a, b, endpoints } = pair();
    a.set(HOT, { tokens: { [TOKEN]: 5n } });
    b.set(HOT, { tokens: { [TOKEN]: 5n } });
    b.broken.set("eth_call", "fail");
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, tokens: [{ token: TOKEN, outflow: { durationMs: 1, max: 0n } }] }] }).check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed"]);
  });

  it("compares a token across every endpoint that read it, not only against the first", async () => {
    const endpoints = [new FakeEndpoint(), new FakeEndpoint().set(HOT, { tokens: { [TOKEN]: 100n } }), new FakeEndpoint().set(HOT, { tokens: { [TOKEN]: 50n } })];
    endpoints[0]!.broken.set("eth_call", "fail");
    const report = await createWatcher({ chainId: 56, endpoints: endpoints.map((e) => e.rpc()), wallets: [{ address: HOT, tokens: [{ token: TOKEN, outflow: { durationMs: 1, max: 0n } }] }] }).check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed", "endpoints-disagree"]);
    expect(report.alerts.find((alert) => alert.kind === "endpoints-disagree")?.detail["endpoint"]).toBe("endpoint-1,endpoint-2,endpoint-3");
  });

  it("reports each disagreeing group of endpoints apart, and names a failed head read's error", async () => {
    const endpoints = [new FakeEndpoint(), new FakeEndpoint().set(HOT, { balance: 1n }), new FakeEndpoint(), new FakeEndpoint().set(HOT, { balance: 2n })];
    endpoints[2]!.head = 1_001;
    endpoints[3]!.head = 1_001;
    const broken = new FakeEndpoint();
    broken.broken.set("eth_chainId", "fail");
    const report = await createWatcher({ chainId: 56, endpoints: [...endpoints.map((e) => e.rpc()), broken.rpc()], wallets: [{ address: HOT }] }).check();
    expect(report.alerts.filter((alert) => alert.kind === "endpoints-disagree").map((alert) => alert.detail["endpoint"])).toEqual(["endpoint-1,endpoint-2", "endpoint-3,endpoint-4"]);
    expect(report.alerts.find((alert) => alert.detail["endpoint"] === "endpoint-5")?.message).toContain("RpcError");
  });

  it("stamps reports with wall time when no clock is given", async () => {
    const { endpoints } = pair();
    const before = Date.now();
    const report = await createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT }] }).check();
    expect(report.at).toBeGreaterThanOrEqual(before);
    expect(report.at).toBeLessThanOrEqual(Date.now());
  });

  it("does not read a load balancer stepping back a few blocks as a fall", async () => {
    const a = new FakeEndpoint().set(HOT, { balance: 100n });
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 150n } }], now: () => now });
    for (const [head, balance] of [[1_000, 100n], [1_001, 200n], [1_000, 100n], [1_002, 200n], [1_001, 100n]] as const) {
      a.head = head;
      a.set(HOT, { balance });
      now += 1;
      expect((await watcher.check()).alerts).toEqual([]);
    }
  });

  it("keeps at most maxConcurrentRequests in flight per endpoint", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = {
      urls: [],
      call: async (method: string) => {
        if (method === "eth_chainId") return "0x38";
        if (method === "eth_blockNumber") return "0x3e8";
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return method === "eth_getCode" ? "0x" : "0x0";
      },
    };
    const wallets = Array.from({ length: 10 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}` }));
    const report = await createWatcher({ chainId: 56, endpoints: [slow as never], wallets, maxConcurrentRequests: 3 }).check();
    expect(report.alerts).toEqual([]);
    expect(peak).toBe(3);
  });

  it("does not count a withdrawal twice after a load balancer steps back", async () => {
    const a = new FakeEndpoint();
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 150n } }], now: () => now });
    for (const [head, balance] of [[1_000, 200n], [1_001, 100n], [1_000, 200n], [1_002, 100n]] as const) {
      a.head = head;
      a.set(HOT, { balance });
      now += 1;
      expect((await watcher.check()).alerts).toEqual([]);
    }
  });

  it("bounds a pass when one endpoint hangs, and holds the concurrency cap against a slow one", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = {
      urls: [],
      call: async (method: string) => {
        if (method === "eth_chainId") return "0x38";
        if (method === "eth_blockNumber") return "0x3e8";
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 500));
        inFlight--;
        return method === "eth_getCode" ? "0x" : "0x0";
      },
    };
    const { endpoints } = pair();
    const wallets = Array.from({ length: 50 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}` }));
    const started = Date.now();
    const report = await createWatcher({ chainId: 56, endpoints: [...endpoints, slow as never], wallets, requestTimeoutMs: 100, maxConcurrentRequests: 8 }).check();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(peak).toBeLessThanOrEqual(8);
    expect(report.alerts.every((alert) => alert.kind === "endpoint-failed")).toBe(true);
  });

  it("catches a deposit then drain around a stuck node far behind", async () => {
    const a = new FakeEndpoint();
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 500n } }], now: () => now });
    const kindsSeen: string[] = [];
    for (const [head, balance] of [[1_000, 100n], [1_002, 1_000n], [970, 100n], [1_006, 0n]] as const) {
      a.head = head;
      a.set(HOT, { balance });
      now += 1;
      kindsSeen.push(...(await watcher.check()).alerts.map((alert) => alert.kind));
    }
    expect(kindsSeen).toContain("outflow");
  });

  it("holds the concurrency cap across passes against calls that never settle", async () => {
    let inFlight = 0;
    let peak = 0;
    const hung = {
      urls: [],
      call: (method: string) => {
        if (method === "eth_chainId") return Promise.resolve("0x38");
        if (method === "eth_blockNumber") return Promise.resolve("0x3e8");
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise<never>(() => undefined);
      },
    };
    const wallets = Array.from({ length: 3 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}` }));
    const watcher = createWatcher({ chainId: 56, endpoints: [hung as never], wallets, maxConcurrentRequests: 2, requestTimeoutMs: 30 });
    for (let pass = 0; pass < 4; pass++) await watcher.check();
    expect(peak).toBe(2);
  });

  it("holds a custom clock's last good value when it fails once, so windows still clear", async () => {
    const { a, b, endpoints } = pair();
    let now: number | (() => never) = 0;
    const clock = () => (typeof now === "number" ? now : now());
    const watcher = createWatcher({ chainId: 56, endpoints, wallets: [{ address: HOT, outflow: { durationMs: 1_000, max: 10n } }], now: clock });
    await watcher.check();
    now = () => {
      throw new Error("clock broke");
    };
    a.set(HOT, { balance: 900n });
    b.set(HOT, { balance: 900n });
    expect(kinds((await watcher.check()).alerts)).toEqual(["outflow"]);
    now = 5_000;
    expect((await watcher.check()).alerts).toEqual([]);
  });

  it("does not count a spend again each time a load balancer returns to a stuck node", async () => {
    const a = new FakeEndpoint();
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 500n } }], now: () => now });
    const seen: string[] = [];
    const sequence = [[1_000, 1_000n], [1_001, 700n], [900, 1_000n], [1_002, 700n], [900, 1_000n], [1_003, 700n], [900, 1_000n], [1_004, 700n]] as const;
    for (const [head, balance] of sequence) {
      a.head = head;
      a.set(HOT, { balance });
      now += 1;
      seen.push(...(await watcher.check()).alerts.map((alert) => alert.kind));
    }
    expect(seen).not.toContain("outflow");
  });

  it("queues every wallet's core reads before any token read, and survives a huge queue", async () => {
    const a = new FakeEndpoint();
    const order: string[] = [];
    const original = a.fetch;
    const recording: typeof globalThis.fetch = async (input, init) => {
      order.push((JSON.parse(String(init?.body)) as { method: string }).method);
      return original(input, init);
    };
    const rpc = (await import("@globalmpc/evm-log-walker")).createRpc({ urls: "https://a.example", fetch: recording, retries: 0 });
    const tokens = Array.from({ length: 5 }, (_, index) => ({ token: `0x${(index + 0x100).toString(16).padStart(40, "0")}` as `0x${string}`, outflow: { durationMs: 1, max: 0n } }));
    const wallets = Array.from({ length: 3 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}`, tokens }));
    await createWatcher({ chainId: 56, endpoints: [rpc], wallets, maxConcurrentRequests: 1 }).check();
    const reads = order.filter((method) => method !== "eth_chainId" && method !== "eth_blockNumber");
    expect(reads.slice(0, 9).every((method) => method !== "eth_call")).toBe(true);

    const broken = new FakeEndpoint();
    broken.broken.set("eth_getCode", "fail");
    const many = Array.from({ length: 5_000 }, (_, index) => ({ token: `0x${(index + 0x1000).toString(16).padStart(40, "0")}` as `0x${string}`, outflow: { durationMs: 1, max: 0n } }));
    const report = await createWatcher({ chainId: 56, endpoints: [broken.rpc()], wallets: [{ address: HOT, tokens: many }], maxConcurrentRequests: 1 }).check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed", "wallet-unreadable"]);
  });

  it("is not blinded long by an inflated head within maxLagBlocks", async () => {
    const a = new FakeEndpoint().set(HOT, { balance: 1_000n });
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 60_000, max: 100n } }], now: () => now });
    await watcher.check();
    a.head = 1_015; // bogus, but within maxLagBlocks
    now = 1;
    await watcher.check();
    a.set(HOT, { balance: 0n });
    const seen: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      a.head = 1_001 + pass;
      now += 1;
      seen.push(...(await watcher.check()).alerts.map((alert) => alert.kind));
    }
    expect(seen).toContain("outflow");
  });

  it("does not recount spending when a load balancer keeps landing on a stuck node", async () => {
    const a = new FakeEndpoint();
    let now = 0;
    let live = 1_000n;
    let liveHead = 1_000;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 600_000, max: 250n } }], now: () => now });
    const seen: string[] = [];
    for (let pass = 0; pass < 24; pass++) {
      const stuck = pass % 4 !== 0; // live, stuck, stuck, stuck, ...
      if (!stuck) {
        live -= 10n; // the relayer spends 10 per live pass
        liveHead += 4;
      }
      a.head = stuck ? 990 : liveHead;
      a.set(HOT, { balance: stuck ? 1_000n : live });
      now += 1;
      seen.push(...(await watcher.check()).alerts.map((alert) => alert.kind));
    }
    expect(seen).not.toContain("outflow");
  });

  it("restarts after an inflated head once a slow chain has advanced, not before", async () => {
    const a = new FakeEndpoint().set(HOT, { balance: 1_000n });
    let now = 0;
    const watcher = createWatcher({ chainId: 56, endpoints: [a.rpc()], wallets: [{ address: HOT, outflow: { durationMs: 600_000, max: 100n } }], now: () => now });
    await watcher.check();
    a.head = 2_000; // bogus
    now = 1;
    await watcher.check();
    a.set(HOT, { balance: 0n });
    const seen: string[][] = [];
    for (const head of [1_001, 1_001, 1_001, 1_002]) {
      a.head = head; // slow blocks: the same head repeats before the chain moves
      now += 1;
      seen.push((await watcher.check()).alerts.map((alert) => alert.kind));
    }
    expect(seen).toEqual([[], [], [], ["outflow"]]);
  });

  it("does not send a wallet's remaining reads once one of its core reads failed", async () => {
    const a = new FakeEndpoint();
    a.broken.set("eth_getCode", "fail");
    let sent = 0;
    const original = a.fetch;
    const counting: typeof globalThis.fetch = async (input, init) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method !== "eth_chainId" && method !== "eth_blockNumber") sent++;
      return original(input, init);
    };
    const rpc = (await import("@globalmpc/evm-log-walker")).createRpc({ urls: "https://a.example", fetch: counting, retries: 0 });
    const tokens = Array.from({ length: 10 }, (_, index) => ({ token: `0x${(index + 0x100).toString(16).padStart(40, "0")}` as `0x${string}`, outflow: { durationMs: 1, max: 0n } }));
    await createWatcher({ chainId: 56, endpoints: [rpc], wallets: [{ address: HOT, tokens }], maxConcurrentRequests: 1 }).check();
    // The failed read's slot may pass to the next queued read before the failure is seen: one more, no further.
    expect(sent).toBeLessThanOrEqual(2);
  });

  it("does not fail other wallets when a custom client throws its own TimeoutError", async () => {
    const { endpoints } = pair();
    let thrown = false;
    const custom = {
      urls: [],
      call: async (method: string, params: readonly unknown[]) => {
        if (method === "eth_getCode" && params[0] === HOT && !thrown) {
          thrown = true;
          throw Object.assign(new Error("client timeout"), { name: "TimeoutError" });
        }
        return endpoints[0]!.call(method, params);
      },
    };
    const report = await createWatcher({ chainId: 56, endpoints: [custom as never], wallets: [{ address: HOT }, { address: COLD }], maxConcurrentRequests: 1 }).check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed", "wallet-unreadable"]);
    expect(report.alerts.find((alert) => alert.kind === "wallet-unreadable")?.wallet?.address).toBe(HOT);
  });

  it("survives a client that throws synchronously", async () => {
    const { endpoints } = pair();
    const broken = { urls: [], call: () => { throw new Error("sync"); } };
    const report = await createWatcher({ chainId: 56, endpoints: [broken, ...endpoints], wallets: [{ address: HOT }] }).check();
    expect(kinds(report.alerts)).toEqual(["endpoint-failed"]);
  });

  it.each([
    [{ endpoints: [], wallets: [{ address: HOT }] }, "endpoints must be a non-empty list"],
    [{ endpoints: [{}], wallets: [{ address: HOT }] }, "not a client made with createRpc"],
    [{ wallets: [] }, "wallets must be a non-empty list"],
    [{ wallets: [{ address: "0x12" }] }, "20-byte address"],
    [{ wallets: [{ address: HOT }, { address: HOT.toUpperCase().replace("0X", "0x") }] }, "listed twice"],
    [{ wallets: [{ address: HOT, frozn: true }] }, 'unknown key "frozn"'],
    [{ wallets: [{ address: HOT, outflow: { durationMs: 1, max: 5 } }] }, "must be a bigint"],
    [{ wallets: [{ address: HOT, outflow: { durationMs: 0, max: 5n } }] }, "positive whole number"],
    [{ wallets: [{ address: HOT, tokens: [{ token: TOKEN, outflow: { durationMs: 1, max: 1n } }, { token: TOKEN, outflow: { durationMs: 1, max: 1n } }] }] }, "lists a token twice"],
    [{ wallets: [{ address: HOT, label: "" }] }, "non-empty string"],
    [{ wallets: [{ address: HOT, frozen: "yes" }] }, "true or false"],
    [{ wallets: [{ address: HOT }], maxLagBlocks: -1 }, "maxLagBlocks"],
    [{ wallets: [{ address: HOT }], chainId: 0 }, "chainId must be a positive whole number"],
    [{ wallets: [{ address: HOT }], requestTimeoutMs: 0 }, "requestTimeoutMs"],
    [{ wallets: [{ address: HOT }], requestTimeoutMs: 3_000_000_000 }, "at most 2147483647"],
    [{ wallets: [{ address: HOT }], extra: 1 }, 'unknown key "extra"'],
  ])("refuses a bad configuration: %#", (options, message) => {
    const { endpoints } = pair();
    const merged = { chainId: 56, endpoints, ...options } as unknown as Parameters<typeof createWatcher>[0];
    expect(() => createWatcher(merged)).toThrow(WatchError);
    expect(() => createWatcher(merged)).toThrow(message);
  });

  it("watches several wallets in one pass", async () => {
    const { a, b, endpoints } = pair();
    a.set(COLD, { code: delegationCode(SWEEPER) });
    b.set(COLD, { code: delegationCode(SWEEPER) });
    const wallets: WalletSpec[] = [{ address: HOT, label: "hot" }, { address: COLD, label: "cold", frozen: true }];
    const report = await createWatcher({ chainId: 56, endpoints, wallets }).check();
    expect(report.alerts.map((alert) => [alert.kind, alert.wallet?.label])).toEqual([["delegated", "cold"]]);
  });
});
