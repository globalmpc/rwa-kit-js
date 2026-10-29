import type { Holder } from "./balances.js";
import { normalizeAddress, type Address } from "./hex.js";

export interface EligibilityRules {
  /** Holders below this balance, in the snapshot token's base units, receive nothing. */
  minBalance?: bigint;
  /** Addresses that never receive a share: the treasury, a liquidity pool, a burn address. */
  exclude?: readonly Address[];
  /**
   * Addresses known to be contracts, all of which are excluded. A liquidity pool or a vault holds
   * tokens on behalf of others, and paying it pays nobody in particular.
   */
  contracts?: ReadonlySet<Address> | readonly Address[];
}

/** Why a holder received no share. When several apply, the first in this order is reported. */
export type ExclusionReason = "listed" | "contract" | "below-minimum";

export interface Exclusion extends Holder {
  reason: ExclusionReason;
}

export interface Eligibility {
  eligible: Holder[];
  excluded: Exclusion[];
}

/**
 * Splits holders into those who share in a payout and those who do not, recording a reason for
 * every exclusion so the list can be audited: "why did this wallet get nothing?" always has an
 * answer in the output. Input order is kept. Pure and offline.
 */
export function applyRules(holders: readonly Holder[], rules: EligibilityRules = {}): Eligibility {
  const listed = new Set((rules.exclude ?? []).map(normalizeAddress));
  const contracts = new Set([...(rules.contracts ?? [])].map(normalizeAddress));
  const eligible: Holder[] = [];
  const excluded: Exclusion[] = [];
  for (const holder of holders) {
    const address = normalizeAddress(holder.address);
    const reason: ExclusionReason | undefined = listed.has(address)
      ? "listed"
      : contracts.has(address)
        ? "contract"
        : rules.minBalance !== undefined && holder.balance < rules.minBalance
          ? "below-minimum"
          : undefined;
    if (reason === undefined) eligible.push(holder);
    else excluded.push({ ...holder, reason });
  }
  return { eligible, excluded };
}
