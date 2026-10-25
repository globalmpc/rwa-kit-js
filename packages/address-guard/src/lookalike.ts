import { GuardError } from "./errors.js";
import { addressBody, checkedAddress, normalizeAddress, type Address } from "./hex.js";

/** Characters compared at each end by default: what a wallet UI usually shows. */
export const DEFAULT_PREFIX = 4;
export const DEFAULT_SUFFIX = 4;

export interface LookalikeOptions {
  /** Hex characters compared at the start, after `0x`. Default 4. */
  prefix?: number;
  /** Hex characters compared at the end. Default 4. */
  suffix?: number;
}

/** One known address that a candidate imitates, with the parts that did and did not match. */
export interface LookalikeMatch {
  /** The address being imitated, lower-cased. */
  known: Address;
  /**
   * Where `known` came from: a recipient the owner has really paid, or another entry in the same
   * batch. The distinction is not cosmetic — "you have paid this before" and "another row of this
   * file looks like it" are different claims, and only the first rests on the history source.
   */
  knownFrom: "history" | "batch";
  /** The shared opening characters, without `0x`. */
  prefix: string;
  /** The shared closing characters. */
  suffix: string;
  /** The candidate's middle, which differs from `knownMiddle`. */
  candidateMiddle: string;
  knownMiddle: string;
}

/**
 * The addresses in `known` that `candidate` imitates: same opening and closing characters, a
 * different middle.
 *
 * Comparison is on the 40 hex characters after `0x` and is case-insensitive, because casing is an
 * EIP-55 checksum rather than part of the address. An exact match is never a look-alike: it is the
 * same account, which `assessRecipient` reports as `"trusted"`.
 *
 * Pure. Throws `E_INVALID_ARGUMENT` when `prefix` and `suffix` leave no middle to differ in —
 * with `prefix + suffix >= 40` every "look-alike" would in fact be an exact match, so a caller
 * asking for that has asked for a check that cannot fire.
 */
export function findLookalikes(
  candidate: Address,
  known: readonly Address[],
  options: LookalikeOptions = {},
  /** Recorded on each match as `knownFrom`. Defaults to `"history"`. */
  knownFrom: "history" | "batch" = "history",
): LookalikeMatch[] {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const suffix = options.suffix ?? DEFAULT_SUFFIX;
  assertWindow(prefix, "prefix");
  assertWindow(suffix, "suffix");
  if (prefix + suffix >= 40) {
    throw new GuardError(
      "E_INVALID_ARGUMENT",
      `prefix (${prefix}) plus suffix (${suffix}) must be under 40, or no middle is left to differ in`,
    );
  }

  const body = addressBody(checkedAddress(candidate, "candidate"));
  const head = body.slice(0, prefix);
  const tail = body.slice(40 - suffix);
  const matches: LookalikeMatch[] = [];
  const seen = new Set<string>();

  for (const entry of known) {
    const other = normalizeAddress(checkedAddress(entry, "known address"));
    if (seen.has(other)) continue;
    seen.add(other);
    const otherBody = addressBody(other);
    if (otherBody === body) continue; // the same account, not an imitation of it
    if (otherBody.slice(0, prefix) !== head || otherBody.slice(40 - suffix) !== tail) continue;
    matches.push({
      known: other,
      knownFrom,
      prefix: head,
      suffix: tail,
      candidateMiddle: body.slice(prefix, 40 - suffix),
      knownMiddle: otherBody.slice(prefix, 40 - suffix),
    });
  }
  return matches;
}

function assertWindow(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new GuardError("E_INVALID_ARGUMENT", `${name} must be a positive integer, got ${String(value)}`);
  }
}
