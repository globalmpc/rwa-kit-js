import type { Holder } from "./balances.js";
import { SnapshotError } from "./errors.js";
import { normalizeAddress, type Address } from "./hex.js";

/** `"pro-rata"` shares the pool by balance; `"equal"` gives every eligible holder the same amount. */
export type AllocationMode = "pro-rata" | "equal";

export interface AllocateOptions {
  /** The total to distribute, in the payout token's base units. */
  pool: bigint;
  /** Default `"pro-rata"`. */
  mode?: AllocationMode;
  /**
   * The most any one holder receives, in the payout token's base units. In pro-rata mode the
   * amount a capped holder would have received above it is shared among the others in proportion
   * to their balances; in equal mode everyone is already level, so it stays in `remainder`.
   */
  cap?: bigint;
}

export interface Allocation extends Holder {
  /** What this holder is paid, in the payout token's base units. Always greater than zero. */
  amount: bigint;
  /** True when the cap limited this holder's amount. */
  capped: boolean;
}

export interface AllocationResult {
  /** Holders paid a non-zero amount: largest first, then by address. */
  allocations: Allocation[];
  /** Eligible holders whose share rounded down to zero base units. */
  unpaid: Holder[];
  /** The sum of every allocation. Never more than the pool. */
  allocated: bigint;
  /** `pool - allocated`: rounding dust, plus whatever a cap left undistributable. */
  remainder: bigint;
}

/**
 * Splits `pool` among `holders`.
 *
 * Every amount is rounded down to a whole base unit, so the total paid can never exceed the pool,
 * and what rounding leaves over is reported as `remainder` rather than handed to an arbitrary
 * holder. The arithmetic is exact `bigint` throughout: a 25.9M-token supply at 18 decimals and a
 * pool at 6 decimals is far beyond what a floating-point share would get right.
 *
 * A cap is applied by repeated levelling: every holder whose exact share exceeds the cap is fixed at
 * the cap, the rest of the pool is shared again among the others, and this repeats until nobody new
 * crosses it. The result does not depend on the order holders are given in. Pure and offline.
 */
export function allocate(input: readonly Holder[], options: AllocateOptions): AllocationResult {
  const { pool, cap } = options;
  // One wallet, one share: a checksummed and a lower-case spelling must not become two rows that
  // each receive up to the cap.
  const holders = input.map((holder) => ({ ...holder, address: normalizeAddress(holder.address) }));
  const mode = options.mode ?? "pro-rata";
  if (pool < 0n) throw new SnapshotError("E_INVALID_ARGUMENT", `pool must not be negative, got ${pool}`);
  if (cap !== undefined && cap <= 0n) throw new SnapshotError("E_INVALID_ARGUMENT", `cap must be greater than zero, got ${cap}`);
  if (mode !== "pro-rata" && mode !== "equal") {
    throw new SnapshotError("E_INVALID_ARGUMENT", `mode must be "pro-rata" or "equal", got "${String(mode)}"`);
  }
  for (const holder of holders) {
    if (holder.balance <= 0n) {
      throw new SnapshotError("E_INVALID_ARGUMENT", `${holder.address} has a balance of ${holder.balance}; only holders with a positive balance can share`);
    }
  }
  const seen = new Set<Address>();
  for (const holder of holders) {
    if (seen.has(holder.address)) {
      throw new SnapshotError("E_INVALID_ARGUMENT", `${holder.address} is listed more than once (addresses are compared case-insensitively)`);
    }
    seen.add(holder.address);
  }

  const { amounts, capped } = mode === "equal" ? equalShares(holders, pool, cap) : proRataShares(holders, pool, cap);

  const allocations: Allocation[] = [];
  const unpaid: Holder[] = [];
  let allocated = 0n;
  for (const holder of holders) {
    const amount = amounts.get(holder.address) ?? 0n;
    if (amount === 0n) {
      unpaid.push(holder);
      continue;
    }
    allocated += amount;
    allocations.push({ ...holder, amount, capped: capped.has(holder.address) });
  }
  allocations.sort((a, b) => (a.amount === b.amount ? (a.address < b.address ? -1 : 1) : a.amount > b.amount ? -1 : 1));
  return { allocations, unpaid, allocated, remainder: pool - allocated };
}

interface Shares {
  amounts: Map<Address, bigint>;
  /** Holders whose share the cap reduced. */
  capped: Set<Address>;
}

function equalShares(holders: readonly Holder[], pool: bigint, cap: bigint | undefined): Shares {
  const shares: Shares = { amounts: new Map(), capped: new Set() };
  if (holders.length === 0) return shares;
  let each = pool / BigInt(holders.length);
  const limited = cap !== undefined && each > cap;
  if (limited) each = cap;
  for (const holder of holders) {
    shares.amounts.set(holder.address, each);
    if (limited) shares.capped.add(holder.address);
  }
  return shares;
}

function proRataShares(holders: readonly Holder[], pool: bigint, cap: bigint | undefined): Shares {
  const shares: Shares = { amounts: new Map(), capped: new Set() };
  let active = [...holders];
  let remaining = pool;
  for (;;) {
    const weight = active.reduce((sum, holder) => sum + holder.balance, 0n);
    if (weight === 0n) return shares;
    // remaining * balance / weight > cap, compared without dividing so no rounding hides a crossing.
    const over = cap === undefined ? [] : active.filter((holder) => remaining * holder.balance > cap * weight);
    if (over.length === 0) {
      for (const holder of active) shares.amounts.set(holder.address, (remaining * holder.balance) / weight);
      return shares;
    }
    const capAmount = cap as bigint;
    for (const holder of over) {
      shares.amounts.set(holder.address, capAmount);
      shares.capped.add(holder.address);
    }
    remaining -= capAmount * BigInt(over.length);
    const fixed = new Set(over.map((holder) => holder.address));
    active = active.filter((holder) => !fixed.has(holder.address));
  }
}
