import type { Hex } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { ZERO_ADDRESS } from "../../src/hex.js";
import { computeHolderCounts } from "../../src/metrics/holders.js";
import type { Transfer } from "../../src/transfers.js";

const W1: Hex = "0x1111111111111111111111111111111111111111";
const W2: Hex = "0x2222222222222222222222222222222222222222";
const W3: Hex = "0x3333333333333333333333333333333333333333";
const HASH: Hex = "0x5555555555555555555555555555555555555555555555555555555555555555".slice(0, 66) as Hex;

function transfer(from: Hex, to: Hex, value: bigint, logIndex: number): Transfer {
  return { from, to, value, blockNumber: 1, transactionHash: HASH, logIndex };
}

describe("computeHolderCounts", () => {
  it("counts non-zero balances as of each day, mint and burn excluded from holding the zero address", () => {
    const byDay = new Map<string, Transfer[]>([
      ["d1", [transfer(ZERO_ADDRESS, W1, 100n, 0)]], // mint: W1 = 100
      ["d2", [transfer(W1, W2, 40n, 0)]], // W1 = 60, W2 = 40
      ["d3", []], // no activity: unchanged
      ["d4", [transfer(W1, ZERO_ADDRESS, 60n, 0), transfer(ZERO_ADDRESS, W3, 10n, 1)]], // W1 burns to 0, W3 = 10
    ]);
    const result = computeHolderCounts(byDay, ["d1", "d2", "d3", "d4"]);
    expect(result.get("d1")).toBe(1); // W1
    expect(result.get("d2")).toBe(2); // W1, W2
    expect(result.get("d3")).toBe(2); // unchanged
    expect(result.get("d4")).toBe(2); // W2, W3 (W1 fully burned out)
  });

  it("reports null from the day a balance would go negative onward, instead of throwing or a wrong count", () => {
    // W1 sends 40 it was never recorded as receiving: the walk didn't start at creation.
    const byDay = new Map<string, Transfer[]>([
      ["d1", [transfer(ZERO_ADDRESS, W2, 5n, 0)]], // fine: W2 = 5, count still correct
      ["d2", [transfer(W1, W2, 40n, 0)]], // W1 has no recorded balance: incomplete from here on
      ["d3", [transfer(ZERO_ADDRESS, W3, 1n, 0)]], // more real activity, but still unknowable now
    ]);
    const result = computeHolderCounts(byDay, ["d1", "d2", "d3"]);
    expect(result.get("d1")).toBe(1); // correct and unaffected
    expect(result.get("d2")).toBeNull();
    expect(result.get("d3")).toBeNull(); // stays null: the running balance can never be trusted again
  });
});
