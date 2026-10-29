import { describe, expect, it } from "vitest";
import { allocate } from "../src/allocate.js";
import { formatUnits, parseUnits } from "../src/amount.js";
import { BalanceReplay, replayBalances, sumBalances, type Holder } from "../src/balances.js";
import { ZERO_ADDRESS, type Address, type Hex } from "../src/hex.js";
import { toPayoutCsv } from "../src/payout.js";
import { applyRules } from "../src/rules.js";
import type { Transfer } from "../src/transfers.js";

const a = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
let nextLog = 0;
const t = (from: Address, to: Address, value: bigint, blockNumber: number): Transfer => ({
  from,
  to,
  value,
  blockNumber,
  transactionHash: `0x${(nextLog + 1).toString(16).padStart(64, "0")}` as Hex,
  logIndex: nextLog++,
});

describe("parseUnits / formatUnits", () => {
  it("converts exactly in both directions", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("10000", 6)).toBe(10_000_000_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(25_900_000n * 10n ** 18n, 18)).toBe("25900000");
  });

  it("formats a zero-decimal token as a plain integer", () => {
    expect(formatUnits(10n, 0)).toBe("10");
    expect(formatUnits(0n, 0)).toBe("0");
    expect(parseUnits("10", 0)).toBe(10n);
  });

  it("refuses more decimal places than the token has, rather than rounding", () => {
    expect(() => parseUnits("0.0000001", 6)).toThrow(/more than 6 decimal/);
    expect(() => parseUnits("-1", 6)).toThrow(/not a non-negative decimal/);
    expect(() => parseUnits("1e6", 6)).toThrow(/not a non-negative decimal/);
  });
});

describe("replayBalances", () => {
  it("replays mints, transfers and burns into balances at a block", () => {
    const holders = replayBalances(
      [t(ZERO_ADDRESS, a(1), 100n, 10), t(a(1), a(2), 30n, 11), t(a(2), ZERO_ADDRESS, 10n, 12), t(a(1), a(3), 5n, 20)],
      { atBlock: 15 },
    );
    expect(holders).toEqual([
      { address: a(1), balance: 70n },
      { address: a(2), balance: 20n },
    ]);
    expect(sumBalances(holders)).toBe(90n);
  });

  it("drops holders whose balance returns to zero, and never lists the zero address", () => {
    const holders = replayBalances([t(ZERO_ADDRESS, a(1), 10n, 1), t(a(1), a(2), 10n, 2)], { atBlock: 5 });
    expect(holders).toEqual([{ address: a(2), balance: 10n }]);
  });

  it("orders by block and log index, whatever order the transfers arrive in", () => {
    const mintLog = t(ZERO_ADDRESS, a(1), 10n, 1);
    const sendLog = t(a(1), a(2), 10n, 2);
    expect(replayBalances([sendLog, mintLog], { atBlock: 2 })).toEqual([{ address: a(2), balance: 10n }]);
  });

  it("counts the same log once when it is read twice", () => {
    const mintLog = t(ZERO_ADDRESS, a(1), 10n, 1);
    expect(replayBalances([mintLog, { ...mintLog }], { atBlock: 1 })).toEqual([{ address: a(1), balance: 10n }]);
  });

  it("refuses a history that does not start at creation", () => {
    expect(() => replayBalances([t(a(1), a(2), 10n, 5)], { atBlock: 5 })).toThrow(/negative balance/);
    expect(() => replayBalances([t(ZERO_ADDRESS, a(1), 10n, 1), t(a(1), a(2), -5n, 2)], { atBlock: 5 })).toThrow(
      /negative value/,
    );
  });
});

describe("applyRules", () => {
  const holders: Holder[] = [
    { address: a(1), balance: 1000n },
    { address: a(2), balance: 500n },
    { address: a(3), balance: 5n },
    { address: a(4), balance: 300n },
  ];

  it("records a reason for every exclusion, listed before contract before minimum", () => {
    const { eligible, excluded } = applyRules(holders, { exclude: [a(1)], contracts: [a(1), a(4)], minBalance: 10n });
    expect(eligible.map((h) => h.address)).toEqual([a(2)]);
    expect(excluded).toEqual([
      { address: a(1), balance: 1000n, reason: "listed" },
      { address: a(3), balance: 5n, reason: "below-minimum" },
      { address: a(4), balance: 300n, reason: "contract" },
    ]);
  });

  it("matches excluded addresses whatever their casing", () => {
    const upper = `0x${"AB".repeat(20)}` as Address;
    const { excluded } = applyRules([{ address: upper.toLowerCase() as Address, balance: 1n }], { exclude: [upper] });
    expect(excluded).toHaveLength(1);
  });
});

describe("allocate", () => {
  const holders: Holder[] = [
    { address: a(1), balance: 600n },
    { address: a(2), balance: 300n },
    { address: a(3), balance: 100n },
  ];

  it("splits pro-rata by balance", () => {
    const result = allocate(holders, { pool: 1000n });
    expect(result.allocations.map((x) => [x.address, x.amount])).toEqual([
      [a(1), 600n],
      [a(2), 300n],
      [a(3), 100n],
    ]);
    expect(result.remainder).toBe(0n);
  });

  it("rounds down and reports the dust, never paying more than the pool", () => {
    const result = allocate(holders, { pool: 7n });
    // 4.2, 2.1, 0.7 → 4, 2, 0
    expect(result.allocations.map((x) => x.amount)).toEqual([4n, 2n]);
    expect(result.unpaid.map((h) => h.address)).toEqual([a(3)]);
    expect(result.allocated).toBe(6n);
    expect(result.remainder).toBe(1n);
  });

  it("shares a capped holder's excess among the others, levelling repeatedly", () => {
    // 1000 pro-rata: 600/300/100. Cap 350: a(1) capped, 650 left over 400 weight → 487.5 / 162.5;
    // a(2) now crosses 350 too, so 300 left for a(3).
    const result = allocate(holders, { pool: 1000n, cap: 350n });
    expect(Object.fromEntries(result.allocations.map((x) => [x.address, x.amount]))).toEqual({ [a(1)]: 350n, [a(2)]: 350n, [a(3)]: 300n });
    expect(result.allocations.filter((x) => x.capped).map((x) => x.address)).toEqual([a(1), a(2)]);
    expect(result.remainder).toBe(0n);
  });

  it("keeps what nobody can take when everyone is at the cap", () => {
    const result = allocate(holders, { pool: 1000n, cap: 100n });
    expect(result.allocated).toBe(300n);
    expect(result.remainder).toBe(700n);
  });

  it("gives equal shares in equal mode, capped", () => {
    expect(allocate(holders, { pool: 10n, mode: "equal" }).allocations.map((x) => x.amount)).toEqual([3n, 3n, 3n]);
    const capped = allocate(holders, { pool: 1000n, mode: "equal", cap: 200n });
    expect(capped.allocations.every((x) => x.amount === 200n && x.capped)).toBe(true);
    expect(capped.remainder).toBe(400n);
  });

  it("never exceeds the pool or the cap, and does not depend on input order", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let round = 0; round < 200; round += 1) {
      const size = 1 + (random() % 30);
      const set: Holder[] = Array.from({ length: size }, (_, i) => ({ address: a(i + 1), balance: BigInt(1 + (random() % 1_000_000)) }));
      const pool = BigInt(random());
      const cap = round % 2 === 0 ? BigInt(1 + (random() % 100_000_000)) : undefined;
      const result = allocate(set, { pool, ...(cap !== undefined ? { cap } : {}) });
      expect(result.allocated + result.remainder).toBe(pool);
      expect(result.allocated <= pool).toBe(true);
      if (cap !== undefined) expect(result.allocations.every((x) => x.amount <= cap)).toBe(true);
      const reversed = allocate([...set].reverse(), { pool, ...(cap !== undefined ? { cap } : {}) });
      expect(reversed.allocations).toEqual(result.allocations);
    }
  });

  it("refuses a negative pool, a non-positive cap, duplicates and empty balances", () => {
    expect(() => allocate(holders, { pool: -1n })).toThrow(/pool/);
    expect(() => allocate(holders, { pool: 1n, cap: 0n })).toThrow(/cap/);
    expect(() => allocate([...holders, holders[0] as Holder], { pool: 1n })).toThrow(/more than once/);
    expect(() => allocate([{ address: a(9), balance: 0n }], { pool: 1n })).toThrow(/positive balance/);
  });

  it("returns the whole pool as remainder when nobody is eligible", () => {
    expect(allocate([], { pool: 5n })).toEqual({ allocations: [], unpaid: [], allocated: 0n, remainder: 5n });
  });
});

describe("toPayoutCsv", () => {
  it("writes recipient,amount in token units", () => {
    const { allocations } = allocate([{ address: a(1), balance: 1n }], { pool: 1_500_000n });
    expect(toPayoutCsv(allocations, 6)).toBe(`recipient,amount\n${a(1)},1.5\n`);
  });

  it("refuses an empty list rather than writing a header-only file", () => {
    expect(() => toPayoutCsv([], 6)).toThrow(/no holder receives/);
  });
});

describe("address casing", () => {
  const lower = `0x${"ab".repeat(20)}` as Address;
  const upper = `0x${"AB".repeat(20)}` as Address;

  it("allocate refuses the same wallet spelled twice", () => {
    expect(() =>
      allocate(
        [
          { address: lower, balance: 1n },
          { address: upper, balance: 1n },
        ],
        { pool: 1_000n, cap: 100n },
      ),
    ).toThrow(/more than once/);
  });

  it("allocate writes the address lower-cased", () => {
    expect(allocate([{ address: upper, balance: 1n }], { pool: 5n }).allocations[0]?.address).toBe(lower);
  });

  it("replay treats one wallet spelled two ways as one balance", () => {
    expect(replayBalances([t(ZERO_ADDRESS, upper, 10n, 1), t(lower, a(1), 4n, 2)], { atBlock: 10 })).toEqual([
      { address: lower, balance: 6n },
      { address: a(1), balance: 4n },
    ]);
  });
});

describe("BalanceReplay", () => {
  it("gives the same balances batch by batch as all at once", () => {
    const all = [t(ZERO_ADDRESS, a(1), 100n, 1), t(a(1), a(2), 40n, 2), t(a(2), a(3), 10n, 3), t(a(1), ZERO_ADDRESS, 5n, 4)];
    const replay = new BalanceReplay({ atBlock: 10 });
    for (const transfer of all) replay.apply([transfer]);
    expect(replay.holders()).toEqual(replayBalances(all, { atBlock: 10 }));
    expect(replay.applied).toBe(4);
  });

  it("refuses a batch that reaches back before a block already applied", () => {
    const replay = new BalanceReplay({ atBlock: 10 });
    replay.apply([t(ZERO_ADDRESS, a(1), 1n, 5)]);
    expect(() => replay.apply([t(ZERO_ADDRESS, a(1), 1n, 4)])).toThrow(/chain order/);
  });
});
