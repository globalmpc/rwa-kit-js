import type { Decision, RuleId, Spend, Verdict } from "./decision.js";
import { SignGuardError } from "./errors.js";
import { evaluate } from "./evaluate.js";
import { createMemoryLedger, type SpendLedger } from "./ledger.js";
import { resolvePolicy, type ResolvedPolicy, type SignPolicy } from "./policy.js";
import type { SignRequest } from "./request.js";
import { snapshotRequest } from "./snapshot.js";

export interface SignGuardOptions {
  /** Where window spends are recorded. Default: this process's memory. */
  ledger?: SpendLedger;
  /**
   * Prefix for every ledger key: one per key, such as the account address. Keys sharing one ledger
   * need different scopes, or their windows mix. Guards of the same key (one policy per chain) share
   * its scope, so the delegation and reset caps stay per key; they must then use the same
   * `authorizations.window` and `resetWindow`. Native and token windows are already kept per chain.
   */
  scope?: string;
  /**
   * Clock in whole milliseconds since the epoch. Default `Date.now`, which every process on a host
   * agrees on, as a shared ledger needs. Windows follow this clock: a host whose clock can be moved
   * can have its windows moved with it. A clock that returns anything but a whole, non-negative
   * number refuses every request (`clock.invalid`) rather than letting windows lapse.
   */
  now?: () => number;
  /**
   * Called with every decision, allowed or refused, before a signature is produced. The place to
   * write an audit log or raise an alert. If it throws, an allowed request is refused instead
   * (`audit.failed`): a signature that could not be recorded is not produced.
   */
  onDecision?: (decision: Decision) => void | Promise<void>;
}

export interface SignGuard {
  /**
   * Judges a request and, when it is allowed, reserves its window spends. Never throws for a refusal.
   * The request is copied first (the signable fields, each read once) and the copy is what is judged.
   * It comes back as `decision.request`: sign that, never the object that was passed in.
   */
  check(request: SignRequest): Promise<Decision>;
  /**
   * Returns an allowed decision's reservations. Call it only when you know no signature was made.
   * Each decision this guard issued can be released once; anything else is ignored.
   */
  release(decision: Decision): Promise<void>;
}

/**
 * Creates a guard from a policy. The policy is validated here, so a malformed one fails at start-up
 * with `E_INVALID_POLICY` rather than at the first signature. The resolved policy stays inside the
 * guard: nothing handed out can widen it later.
 */
export function createSignGuard(policy: SignPolicy, options: SignGuardOptions = {}): SignGuard {
  assertOptionKeys(options, GUARD_OPTION_KEYS);
  const resolved = resolvePolicy(policy);
  const ledger = options.ledger ?? createMemoryLedger();
  const now = options.now ?? Date.now;
  const onDecision = options.onDecision;
  const scope = options.scope === undefined ? "" : `${options.scope}:`;
  /**
   * What each allowed decision reserved, as issued, until it is released. Release reads this record,
   * never the decision object the caller holds, so editing a decision cannot refund something else.
   */
  const issued = new WeakMap<Decision, { spends: readonly Spend[]; at: number }>();

  /** Best effort: a release that fails leaves the amount spent, which is the safe side. */
  async function releaseAll(spends: readonly Spend[], at: number): Promise<void> {
    for (const spend of spends) await Promise.resolve().then(() => ledger.release({ ...spend }, at)).catch(() => undefined);
  }

  /** Reserves every spend or none. Reports the spend that did not fit, or that the ledger failed. */
  async function reserveAll(spends: readonly Spend[], at: number): Promise<{ full: Spend } | { failed: string } | undefined> {
    const reserved: Spend[] = [];
    for (const spend of spends) {
      let fits: unknown;
      try {
        fits = await ledger.reserve({ ...spend }, at); // the ledger's own copy: nothing a caller edits reaches it
      } catch (error) {
        await releaseAll(reserved, at);
        return { failed: describeError(error) };
      }
      // Only an exact boolean is an answer; a raw "0" or a reply object must not read as room.
      if (fits !== true && fits !== false) {
        await releaseAll(reserved, at);
        return { failed: `reserve answered ${describeError(fits)}, not true or false` };
      }
      if (!fits) {
        await releaseAll(reserved, at);
        return { full: spend };
      }
      reserved.push(spend);
    }
    return undefined;
  }

  return {
    async check(incoming) {
      const request = snapshotRequest(incoming);
      const evaluated = safeEvaluate(request, resolved);
      const verdict: Verdict = { ...evaluated, spends: evaluated.spends.map((spend) => ({ ...spend, key: `${scope}${spend.key}` })) };
      const at = readClock(now);
      const decide = async (allowed: boolean, rule: RuleId, reason: string, reservations: readonly Spend[]): Promise<Decision> => {
        // With a broken clock the decision still needs a real time for the audit log; it checks no window.
        const decision: Decision = { allowed, kind: request.kind, rule, reason, summary: verdict.summary, at: at ?? Date.now(), reservations, request };
        const recorded = await notify(onDecision, decision);
        if (recorded || !allowed) {
          if (allowed) issued.set(decision, { spends: reservations.map((spend) => ({ ...spend })), at: decision.at });
          return decision;
        }
        await releaseAll(reservations, decision.at);
        const refused: Decision = { ...decision, allowed: false, rule: "audit.failed", reason: "the onDecision hook failed, so the signature was not produced", reservations: [] };
        await notify(onDecision, refused); // best effort: the hook that just failed may record the refusal
        return refused;
      };

      if (!verdict.allowed) return decide(false, verdict.rule, verdict.reason, []);
      if (at === undefined) return decide(false, "clock.invalid", "the clock did not return a whole number of milliseconds, so no window can be checked", []);

      const outcome = await reserveAll(verdict.spends, at);
      if (outcome !== undefined && "failed" in outcome) {
        return decide(false, "ledger.failed", `the spend ledger refused or failed (${outcome.failed}), so no window can be checked`, []);
      }
      if (outcome !== undefined) {
        return decide(false, "window.exceeded", `${outcome.full.key} would pass its limit of ${outcome.full.max} per ${outcome.full.durationMs} ms`, []);
      }
      return decide(true, "allowed", verdict.reason, verdict.spends);
    },
    async release(decision) {
      // Once only, and only for a decision this guard issued: a second release, or a forged decision,
      // would otherwise give back another request's reservation.
      const record = issued.get(decision);
      if (record === undefined) return;
      issued.delete(decision);
      await releaseAll(record.spends, record.at);
    },
  };
}

export const GUARD_OPTION_KEYS: readonly string[] = ["ledger", "scope", "now", "onDecision"];

/**
 * Refuses unknown option keys, as the policy does: a misspelt `onDecision` would otherwise leave the
 * guard running with no audit hook and no error.
 */
export function assertOptionKeys(options: unknown, allowed: readonly string[]): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new SignGuardError("E_INVALID_ARGUMENT", "options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new SignGuardError("E_INVALID_ARGUMENT", `unknown option "${key}"; allowed: ${allowed.join(", ")}`);
    }
  }
}

/**
 * A ledger's error (or odd answer) as JSON-escaped text of at most 200 characters, whatever it is: a
 * refusal must not fail on reading why. A `message` is read once and used whatever realm the error
 * comes from.
 */
function describeError(error: unknown): string {
  try {
    let text: string;
    if (typeof error === "string") text = error;
    else if (typeof error === "object" && error !== null) {
      const message: unknown = (error as { message?: unknown }).message;
      text = typeof message === "string" ? message : Object.prototype.toString.call(error);
    } else text = String(error);
    return JSON.stringify(text.slice(0, 200));
  } catch {
    return '"an unreadable error"';
  }
}

function readClock(now: () => number): number | undefined {
  try {
    const at = now();
    return Number.isSafeInteger(at) && at >= 0 ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The policy is written to refuse malformed input, never to throw on it. Should an input still
 * reach a throw, it is refused here, so the attempt is recorded rather than lost.
 */
function safeEvaluate(request: SignRequest, policy: ResolvedPolicy): Verdict {
  try {
    return evaluate(request, policy);
  } catch {
    return { allowed: false, rule: "request.malformed", reason: "the request could not be read", summary: {}, spends: [] };
  }
}

/**
 * Runs the hook on its own copy of the decision, so nothing it does can change the request that is
 * signed, and reports whether it succeeded. A hook error never escapes as a signature.
 */
async function notify(hook: SignGuardOptions["onDecision"], decision: Decision): Promise<boolean> {
  if (hook === undefined) return true;
  try {
    await hook(structuredClone(decision));
    return true;
  } catch {
    return false;
  }
}
