import { describe, expect, it } from "vitest";
import { watch, WatchError, type Alert, type Report } from "../src/index.js";
import { delegationCode, FakeEndpoint, HOT, SWEEPER } from "./fake-chain.js";

/** Runs `watch` for `passes` passes on a manual clock, then stops it. */
async function run(
  endpoint: FakeEndpoint,
  passes: number,
  between: (pass: number) => void,
  options: { repeatAfterMs?: number; onAlert?: (alert: Alert) => void | Promise<void>; callbackTimeoutMs?: number; wallet?: Parameters<typeof watch>[0]["wallets"][number] } = {},
) {
  const sent: Array<{ pass: number; kind: string }> = [];
  const stop = new AbortController();
  let pass = 0;
  let now = 0;
  await watch({
    chainId: 56,
    endpoints: [endpoint.rpc()],
    wallets: [options.wallet ?? { address: HOT }],
    intervalMs: 1,
    ...(options.repeatAfterMs === undefined ? {} : { repeatAfterMs: options.repeatAfterMs }),
    ...(options.callbackTimeoutMs === undefined ? {} : { callbackTimeoutMs: options.callbackTimeoutMs }),
    now: () => now,
    signal: stop.signal,
    onAlert: async (alert) => {
      sent.push({ pass, kind: alert.kind });
      await options.onAlert?.(alert);
    },
    onReport: (_report: Report) => {
      pass++;
      now += 1_000;
      if (pass >= passes) stop.abort();
      else between(pass);
    },
  });
  return sent;
}

describe("watch", () => {
  it("sends an alert once while it persists, again after repeatAfterMs, and again when it returns", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    const sent = await run(endpoint, 8, (pass) => {
      if (pass === 5) endpoint.set(HOT, { code: "0x" }); // cleared on pass 6
      if (pass === 6) endpoint.set(HOT, { code: delegationCode(SWEEPER) }); // back on pass 7
    }, { repeatAfterMs: 3_000 });
    expect(sent).toEqual([
      { pass: 0, kind: "delegated" },
      { pass: 3, kind: "delegated" },
      { pass: 6, kind: "delegated" },
    ]);
  });

  it("keeps watching when onAlert throws", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    const sent = await run(endpoint, 3, () => undefined, {
      repeatAfterMs: 1,
      onAlert: () => {
        throw new Error("pager down");
      },
    });
    expect(sent.map(({ pass }) => pass)).toEqual([0, 1, 2]);
  });

  it("cuts off a callback that hangs, and keeps watching", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    const sent = await run(endpoint, 3, () => undefined, { repeatAfterMs: 1, callbackTimeoutMs: 20, onAlert: () => new Promise<void>(() => undefined) });
    expect(sent.map(({ pass }) => pass)).toEqual([0, 1, 2]);
  });

  it("sends an outflow again at once when it gets worse", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { balance: 1_000n });
    const sent = await run(
      endpoint,
      4,
      (pass) => {
        endpoint.head++;
        endpoint.set(HOT, { balance: [1_000n, 800n, 700n, 100n][pass] ?? 0n });
      },
      { wallet: { address: HOT, outflow: { durationMs: 60_000, max: 50n } } },
    );
    expect(sent).toEqual([
      { pass: 1, kind: "outflow" },
      { pass: 2, kind: "outflow" },
      { pass: 3, kind: "outflow" },
    ]);
  });

  it("sends a fresh drain even when an older, larger one set the last peak", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { balance: 1_000n });
    const sent: string[] = [];
    const stop = new AbortController();
    let pass = 0;
    let now = 0;
    const balances = [1_000n, 950n, 930n, 930n, 930n, 900n];
    await watch({
      chainId: 56,
      endpoints: [endpoint.rpc()],
      wallets: [{ address: HOT, outflow: { durationMs: 2_500, max: 10n } }],
      intervalMs: 1,
      now: () => now,
      signal: stop.signal,
      onAlert: (alert) => void sent.push(`${pass}:${String(alert.detail["amount"])}`),
      onReport: () => {
        pass++;
        now += 1_000;
        if (pass >= balances.length) return stop.abort();
        endpoint.head++;
        endpoint.set(HOT, { balance: balances[pass] ?? 0n });
      },
    });
    // 50 then 70; the old falls leave the window (70 at pass 2, 20 at 3, 0 at 4); a new 30 at pass 5 is sent.
    expect(sent).toEqual(["1:50", "2:70", "5:30"]);
  });

  it("keeps watching when the clock throws", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    const stop = new AbortController();
    let passes = 0;
    await watch({
      chainId: 56,
      endpoints: [endpoint.rpc()],
      wallets: [{ address: HOT }],
      intervalMs: 1,
      now: () => {
        throw new Error("clock broke");
      },
      signal: stop.signal,
      onAlert: () => undefined,
      onReport: () => {
        if (++passes >= 3) stop.abort();
      },
    });
    expect(passes).toBe(3);
  });

  it("sends an alert again on the next pass when its delivery failed", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    let attempts = 0;
    const sent = await run(endpoint, 3, () => undefined, {
      onAlert: () => {
        attempts++;
        if (attempts === 1) throw new Error("pager 503");
      },
    });
    expect(sent.map(({ pass }) => pass)).toEqual([0, 1]);
  });

  it("delivers a failed critical alert even after its condition has cleared", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    let attempts = 0;
    const sent = await run(endpoint, 3, (pass) => {
      if (pass === 1) endpoint.set(HOT, { code: "0x" }); // the sweeper undid its own delegation
    }, {
      onAlert: () => {
        attempts++;
        if (attempts === 1) throw new Error("pager timeout");
      },
    });
    expect(sent.map(({ pass, kind }) => `${pass}:${kind}`)).toEqual(["0:delegated", "1:delegated"]);
  });

  it("counts a callback that times out as sent, so a slow pager is not paged every pass", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    const sent = await run(endpoint, 4, () => undefined, { callbackTimeoutMs: 5, onAlert: () => new Promise<void>((resolve) => setTimeout(resolve, 20)) });
    expect(sent.map(({ pass }) => pass)).toEqual([0]);
  });

  it("retries an alert whose pager threw its own TimeoutError", async () => {
    const endpoint = new FakeEndpoint().set(HOT, { code: delegationCode(SWEEPER) });
    let attempts = 0;
    const sent = await run(endpoint, 3, () => undefined, {
      onAlert: () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("fetch timed out"), { name: "TimeoutError" });
      },
    });
    expect(sent.map(({ pass }) => pass)).toEqual([0, 1]);
  });

  it("returns at once when the signal is already aborted", async () => {
    const endpoint = new FakeEndpoint();
    const stop = new AbortController();
    stop.abort();
    await watch({ chainId: 56, endpoints: [endpoint.rpc()], wallets: [{ address: HOT }], onAlert: () => undefined, signal: stop.signal });
    expect(endpoint.calls).toBe(0);
  });

  it.each([
    [{ onAlert: undefined }, "onAlert must be a function"],
    [{ intervalMs: 0 }, "intervalMs must be a whole number of 1 or more"],
    [{ repeatAfterMs: 1.5 }, "repeatAfterMs must be a whole number of 1 or more"],
    [{ onReport: "x" }, "onReport must be a function"],
    [{ onAlrt: () => undefined }, 'unknown key "onAlrt"'],
    [{ callbackTimeoutMs: 0 }, "callbackTimeoutMs must be a whole number of 1 or more"],
    [{ intervalMs: 3_000_000_000 }, "at most 2147483647"],
    [{ signal: { aborted: false } }, "signal must be an AbortSignal"],
  ])("refuses bad options: %#", async (extra, message) => {
    const options = { chainId: 56, endpoints: [new FakeEndpoint().rpc()], wallets: [{ address: HOT }], onAlert: () => undefined, ...extra } as unknown as Parameters<typeof watch>[0];
    await expect(watch(options)).rejects.toThrow(WatchError);
    await expect(watch(options)).rejects.toThrow(message);
  });
});
