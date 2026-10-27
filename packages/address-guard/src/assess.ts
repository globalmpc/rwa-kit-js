import { checksumState, type ChecksumState } from "./checksum.js";
import { isAddress, normalizeAddress, type Address } from "./hex.js";
import type { SourceInfo } from "./history.js";
import { findLookalikes, type LookalikeMatch, type LookalikeOptions } from "./lookalike.js";

/**
 * What to do about a destination.
 *
 * - `"trusted"` — the owner has really sent here before. Not a promise that it is safe; see the
 *   security note in the README.
 * - `"new"` — well-formed and unlike anything in the history. Normal for a first payment.
 * - `"lookalike"` — imitates a trusted address. Do not send.
 * - `"invalid"` — not a 20-byte hex address.
 * - `"bad-checksum"` — carries case information that contradicts its EIP-55 checksum.
 */
export type Verdict = "trusted" | "new" | "lookalike" | "invalid" | "bad-checksum";

export interface AssessContext extends LookalikeOptions {
  /** Addresses the owner has really sent to, from `deriveTrustedRecipients`. */
  trusted: readonly Address[];
  /**
   * Other addresses the candidate should be compared against that the owner has **not** paid —
   * the remaining recipients of the same payout file, typically.
   *
   * Kept apart from `trusted` because the two support different statements. A match against
   * `trusted` means "you have really paid something that looks like this"; a match against
   * `peers` means "another row of this batch looks like this", which rests on the file rather
   * than on the history. Folding peers into `trusted` made the reasons claim the owner had paid
   * addresses it had never seen, with `trustedCount` sitting at zero in the same payload.
   *
   * A peer match never produces a `"trusted"` verdict.
   */
  peers?: readonly Address[];
  /** Where `trusted` came from. Carried into the result so every verdict can be traced. */
  source?: SourceInfo;
}

export interface Assessment {
  /** The candidate exactly as supplied, casing included. */
  candidate: string;
  /** Lower-cased, present only when the candidate is a well-formed address. */
  normalized?: Address;
  verdict: Verdict;
  checksum?: ChecksumState;
  /** Why, in the order the checks ran. Always at least one line. */
  reasons: string[];
  /** The trusted addresses this candidate imitates. Empty unless the verdict is `"lookalike"`. */
  evidence: LookalikeMatch[];
  /** Provenance of `trusted`, when the caller supplied it. */
  source?: SourceInfo;
}

/**
 * Judges one destination against the owner's trusted recipients.
 *
 * Checks run in order of how much they should stop a payment, and the first that fires decides
 * the verdict:
 *
 * 1. not an address at all -> `"invalid"`.
 * 2. an exact trusted match whose casing is not corrupt -> `"trusted"`.
 * 3. imitates a trusted address -> `"lookalike"`.
 * 4. casing contradicts the EIP-55 checksum -> `"bad-checksum"`.
 * 5. otherwise -> `"new"`.
 *
 * Two orderings here are deliberate. An exact match outranks look-alike-ness, because the owner
 * having really sent here says everything and the existence of some other imitating address says
 * nothing about this one -- flagging a known-good recipient is how a tool teaches people to
 * ignore it. But a look-alike outranks a checksum complaint, because both mean "do not send" and
 * reporting the casing would hide the dangerous half.
 *
 * The exception in step 2 is why `trusted` is conditional: correct bytes in a spelling no tool
 * would emit still means the input was edited by hand, and that is cheap to stop for.
 *
 * Nothing is lost at any step. Every check that fired is listed in `reasons`, and `evidence` is
 * populated whenever a resemblance was found, trusted or not.
 *
 * Pure: no I/O. `ctx.trusted` is whatever the caller derived, and `ctx.source` is carried through
 * unchanged so a JSON result always names where the history came from.
 */
export function assessRecipient(candidate: string, ctx: AssessContext): Assessment {
  const reasons: string[] = [];

  if (!isAddress(candidate)) {
    return {
      candidate,
      verdict: "invalid",
      reasons: ["not a 20-byte hex address (expected 0x followed by 40 hex characters)"],
      evidence: [],
      ...(ctx.source !== undefined ? { source: ctx.source } : {}),
    };
  }

  const normalized = normalizeAddress(candidate);
  const checksum = checksumState(candidate);
  if (checksum === "mismatch") {
    reasons.push("the EIP-55 checksum does not match this spelling, so at least one character's case is wrong");
  } else if (checksum === "unchecksummed") {
    reasons.push("no EIP-55 checksum to verify: the address is all lower case");
  }

  const window = {
    ...(ctx.prefix !== undefined ? { prefix: ctx.prefix } : {}),
    ...(ctx.suffix !== undefined ? { suffix: ctx.suffix } : {}),
  };
  const evidence = [
    ...findLookalikes(normalized, ctx.trusted, window, "history"),
    ...findLookalikes(normalized, ctx.peers ?? [], window, "batch"),
  ];
  const trusted = ctx.trusted.some((entry) => normalizeAddress(entry) === normalized);

  const base = {
    candidate,
    normalized,
    checksum,
    evidence,
    ...(ctx.source !== undefined ? { source: ctx.source } : {}),
  };

  // An exact trusted match decides it, but only while the spelling is one a tool could have
  // produced. Corrupt casing on correct bytes still means the input was hand-edited, which is
  // worth stopping for even though these particular bytes are safe.
  if (trusted && checksum !== "mismatch") {
    reasons.push("the owner has really sent to this address before");
    if (evidence.length > 0) {
      reasons.push(
        `${evidence.length} other address(es) share both ends with it, which does not make this one suspect`,
      );
    }
    return { ...base, verdict: "trusted", reasons };
  }
  if (evidence.length > 0) {
    const first = evidence[0] as LookalikeMatch;
    const fromHistory = evidence.filter((match) => match.knownFrom === "history").length;
    const fromBatch = evidence.length - fromHistory;
    const parts: string[] = [];
    if (fromHistory > 0) parts.push(`${fromHistory} recipient(s) the owner has really paid`);
    if (fromBatch > 0) parts.push(`${fromBatch} other recipient(s) in this batch`);
    reasons.push(`shares 0x${first.prefix}…${first.suffix} with ${parts.join(" and ")}, but differs in the middle`);
    return { ...base, verdict: "lookalike", reasons };
  }
  if (checksum === "mismatch") {
    return { ...base, verdict: "bad-checksum", reasons };
  }
  reasons.push(
    ctx.trusted.length === 0
      ? "no trusted recipients were derived, so nothing could be compared"
      : "unlike every trusted recipient, in both ends and the middle",
  );
  return { ...base, verdict: "new", reasons };
}
