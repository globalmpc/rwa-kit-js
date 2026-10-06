import type { Hex } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { computeReturnRate, type DayWallets } from "../../src/metrics/retention.js";

const W1: Hex = "0x1111111111111111111111111111111111111111";
const W2: Hex = "0x2222222222222222222222222222222222222222";
const W3: Hex = "0x3333333333333333333333333333333333333333";

function days(wallets: Hex[][]): DayWallets[] {
  return wallets.map((w, index) => ({ date: `d${index}`, wallets: new Set(w) }));
}

describe("computeReturnRate", () => {
  it("returns null for every day before a full window of prior days exists", () => {
    const result = computeReturnRate(days([[W1], [W1], [W1]]), 7);
    expect(result).toEqual([null, null, null]);
  });

  it("returns null on a day with no active wallets, even with enough history", () => {
    const data = days([[W1], [W1], [W1], [W1], [W1], [W1], [W1], []]);
    expect(computeReturnRate(data, 7)[7]).toBeNull();
  });

  it("computes the fraction of today's wallets seen in the prior window, floored not rounded", () => {
    // Day 3 (index 3) wallets: W1 (seen on day 0), W2 (seen on day 1), W3 (new). 2/3 return.
    const data = days([[W1], [W2], [], [W1, W2, W3]]);
    const result = computeReturnRate(data, 3);
    expect(result[3]).toBe(0.666); // floor(2/3 * 1000)/1000, never 0.667
  });

  it("is 0 when none of today's wallets were seen in the window, not null", () => {
    const data = days([[W1], [W1], [W1], [W2]]);
    expect(computeReturnRate(data, 3)[3]).toBe(0);
  });

  it("is 1 when every one of today's wallets returned", () => {
    const data = days([[W1], [], [], [W1]]);
    expect(computeReturnRate(data, 3)[3]).toBe(1);
  });
});
