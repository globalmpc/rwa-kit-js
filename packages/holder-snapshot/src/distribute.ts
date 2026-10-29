import { allocate, type Allocation, type AllocationMode } from "./allocate.js";
import type { Holder } from "./balances.js";
import { SnapshotError } from "./errors.js";
import type { Address } from "./hex.js";
import { applyRules, type Exclusion } from "./rules.js";
import type { Snapshot } from "./snapshot.js";

export interface DistributionOptions {
  /** The total to distribute, in the payout token's base units. */
  pool: bigint;
  /** Default `"pro-rata"`. */
  mode?: AllocationMode;
  /** The most any one holder receives, in the payout token's base units. */
  cap?: bigint;
  /** Holders below this balance, in the snapshot token's base units, receive nothing. */
  minBalance?: bigint;
  /** Addresses that never receive a share. */
  exclude?: readonly Address[];
  /** Exclude every holder that is a contract. Needs a snapshot taken with `classify: true`. */
  excludeContracts?: boolean;
}

export interface Distribution {
  token: Address;
  chainId: number;
  block: number;
  pool: bigint;
  mode: AllocationMode;
  cap?: bigint;
  /** Holders who shared in the pool, including any whose share rounded to zero. */
  eligible: number;
  excluded: Exclusion[];
  allocations: Allocation[];
  /** Eligible holders whose share rounded down to zero base units. */
  unpaid: Holder[];
  allocated: bigint;
  remainder: bigint;
}

/**
 * Turns a verified snapshot into a payout: applies the eligibility rules, then splits the pool.
 *
 * Refuses a snapshot whose verification failed (`E_UNVERIFIED`): its balances disagree with the
 * token's own, and every pro-rata share computed from them would be wrong. Refuses one whose
 * check was sampled too: a balance moved between two unsampled wallets without an event leaves
 * the supply unchanged, so only a check of every holder makes the balances payable. Pure and
 * offline.
 */
export function buildDistribution(snapshot: Snapshot, options: DistributionOptions): Distribution {
  if (!snapshot.verification.verified) {
    throw new SnapshotError(
      "E_UNVERIFIED",
      `the snapshot of ${snapshot.token} at block ${snapshot.block} failed verification ` +
        `(${snapshot.verification.mismatches.length} balance mismatch(es); replayed supply ` +
        `${snapshot.verification.replayedSupply}, totalSupply ${snapshot.verification.totalSupply}), so no payout is built from it`,
    );
  }
  if (snapshot.verification.checked < snapshot.holders.length) {
    throw new SnapshotError(
      "E_UNVERIFIED",
      `only ${snapshot.verification.checked} of ${snapshot.holders.length} balances were checked against balanceOf; ` +
        "a payout needs every one checked: take the snapshot with every holder checked (the default), or recheck it",
    );
  }
  if (options.excludeContracts === true && !snapshot.classified) {
    throw new SnapshotError("E_INVALID_ARGUMENT", "excluding contracts needs a snapshot taken with classify (--classify on the command line)");
  }
  const { eligible, excluded } = applyRules(snapshot.holders, {
    ...(options.minBalance !== undefined ? { minBalance: options.minBalance } : {}),
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    ...(options.excludeContracts === true ? { contracts: snapshot.holders.filter((holder) => holder.contract === true).map((holder) => holder.address) } : {}),
  });
  const mode = options.mode ?? "pro-rata";
  const result = allocate(
    eligible.map(({ address, balance }) => ({ address, balance })),
    { pool: options.pool, mode, ...(options.cap !== undefined ? { cap: options.cap } : {}) },
  );
  return {
    token: snapshot.token,
    chainId: snapshot.chainId,
    block: snapshot.block,
    pool: options.pool,
    mode,
    ...(options.cap !== undefined ? { cap: options.cap } : {}),
    eligible: eligible.length,
    excluded: excluded.map(({ address, balance, reason }) => ({ address, balance, reason })),
    allocations: result.allocations,
    unpaid: result.unpaid,
    allocated: result.allocated,
    remainder: result.remainder,
  };
}
