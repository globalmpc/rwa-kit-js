import type { Hex } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { splitGas } from "../../src/metrics/gas.js";
import type { TxSummary } from "../../src/tx.js";

const W1: Hex = "0x1111111111111111111111111111111111111111";
const HASH_A: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: Hex = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function summary(hash: Hex, sponsored: boolean): TxSummary {
  return { hash, from: W1, blockNumber: 1, gasPrice: sponsored ? 0n : 5n, sponsored };
}

describe("splitGas", () => {
  it("classifies by gasPrice === 0, the whole product policy is that users always pay their own gas", () => {
    const txSummaries = new Map<Hex, TxSummary>([
      [HASH_A, summary(HASH_A, false)],
      [HASH_B, summary(HASH_B, true)],
    ]);
    expect(splitGas([HASH_A, HASH_B], txSummaries)).toEqual({ sponsored: 1, userPaid: 1 });
  });

  it("counts each transaction once even if its hash repeats across several logs", () => {
    const txSummaries = new Map<Hex, TxSummary>([[HASH_A, summary(HASH_A, false)]]);
    expect(splitGas([HASH_A, HASH_A, HASH_A], txSummaries)).toEqual({ sponsored: 0, userPaid: 1 });
  });

  it("reports all zero on a day with no transactions", () => {
    expect(splitGas([], new Map())).toEqual({ sponsored: 0, userPaid: 0 });
  });
});
