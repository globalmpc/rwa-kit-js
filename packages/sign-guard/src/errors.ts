import type { Decision } from "./decision.js";

export type SignGuardErrorCode =
  /** The policy is malformed. Nothing is signed under a policy that could not be read. */
  | "E_INVALID_POLICY"
  /** An argument other than the policy is malformed. */
  | "E_INVALID_ARGUMENT"
  /** The policy refused the request. `decision` says which rule and why. */
  | "E_DENIED";

export class SignGuardError extends Error {
  override readonly name = "SignGuardError";
  readonly code: SignGuardErrorCode;
  /** Set when `code` is `E_DENIED`. */
  readonly decision: Decision | undefined;

  constructor(code: SignGuardErrorCode, message: string, decision?: Decision) {
    super(message);
    this.code = code;
    this.decision = decision;
  }
}

/**
 * The guard's refusal inside any error: the error itself, or one of its causes. Some viem actions
 * (`sendTransaction`, `writeContract`, `deployContract` and others) wrap the refusal in their own
 * error, others throw it as it is; use this rather than `instanceof`. Returns undefined when the
 * error is not a refusal.
 */
export function findRefusal(error: unknown): SignGuardError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof SignGuardError && current.code === "E_DENIED") return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

/** The error thrown in place of a signature the policy refused. */
export function deniedError(decision: Decision): SignGuardError {
  return new SignGuardError("E_DENIED", `sign-guard refused a ${decision.kind} request: ${decision.reason}`, decision);
}
