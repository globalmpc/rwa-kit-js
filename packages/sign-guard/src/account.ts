import type { Decision } from "./decision.js";
import { deniedError, SignGuardError } from "./errors.js";
import { unknownMethodReason } from "./evaluate.js";
import { assertOptionKeys, createSignGuard, GUARD_OPTION_KEYS, type SignGuard, type SignGuardOptions } from "./guard.js";
import type { Address, Hex } from "./hex.js";
import type { SignPolicy } from "./policy.js";
import type { SignRequest } from "./request.js";

/**
 * The account shape the guard wraps: viem's `LocalAccount` (`privateKeyToAccount`, `mnemonicToAccount`,
 * `toAccount`). Parameters are typed `never` so any account's own, narrower parameter types fit;
 * `guardAccount` returns the account's own type, so callers keep viem's types.
 */
export interface GuardableAccount {
  address: Address;
  /** Must be `"local"`: viem signs any other account type over JSON-RPC, where no guard can stand. */
  type: string;
  sign?: ((parameters: never) => Promise<unknown>) | undefined;
  signAuthorization?: ((parameters: never) => Promise<unknown>) | undefined;
  signMessage?: ((parameters: never) => Promise<unknown>) | undefined;
  signTransaction?: ((transaction: never, options?: never) => Promise<unknown>) | undefined;
  signTypedData?: ((parameters: never) => Promise<unknown>) | undefined;
}

export interface GuardAccountOptions extends SignGuardOptions {
  /**
   * Serializers the caller may pass to `signTransaction`, compared by identity. viem's wallet
   * client passes a chain's own serializer when the chain defines one (Base and Optimism do; BNB
   * Smart Chain and opBNB do not): list it here, for example
   * `trustedSerializers: [base.serializers.transaction]`. Any other serializer is refused. The list
   * is copied when the account is wrapped; changing it later changes nothing.
   */
  trustedSerializers?: readonly unknown[];
  /**
   * Give an allowed request's window amounts back when the wrapped signing method throws. Default
   * false: a remote signer (a KMS behind `toAccount`) can produce a signature and still throw, for
   * example on a timeout, and refunding then would let a caller collect signatures past the window.
   * Set it for a local private-key account, where an error means no signature was made.
   */
  releaseOnSignerError?: boolean;
}

type Method = (...args: unknown[]) => Promise<unknown>;

const KNOWN_METHODS: readonly string[] = ["sign", "signAuthorization", "signMessage", "signTransaction", "signTypedData"];

/** The non-function fields viem reads from a local account; the only ones the guarded copy carries. */
const ACCOUNT_FIELDS: readonly string[] = ["address", "type", "publicKey", "source", "nonceManager"];

/**
 * Returns a copy of `account` whose signing methods ask the guard first. A refused request throws a
 * `SignGuardError` with code `E_DENIED` and the decision; nothing is signed.
 *
 * What is signed is the request as the guard judged it (`decision.request`): the signable fields,
 * each read once and copied before the check. A request object changed after it was checked, or one with getters
 * that answer differently the second time, cannot slip through. Transactions are signed from the
 * standard Ethereum fields only; chain-specific extras (a fee currency, for example) are dropped.
 * Any other function on the account, such as viem's `getHdKey`, is replaced by one that refuses: a
 * method the guard does not know could sign, or hand out the key. Of the other fields, only those
 * viem reads (`address`, `type`, `publicKey`, `source`, `nonceManager`) are carried over. A signing method the account
 * lacks is installed as one that refuses, because viem would otherwise fall back to asking the RPC
 * node to sign. Only local accounts (`type: "local"`) are accepted, for the same reason.
 *
 * `options` other than `trustedSerializers` and `releaseOnSignerError` configure the guard created
 * from a policy; passing them with a ready-made `SignGuard`, which carries its own, is an error.
 *
 * The guard protects the methods of this object only. Code holding the original account, or the
 * key itself, is not bound by it: give the key to the guard's process and nothing else.
 */
export function guardAccount<A extends GuardableAccount>(account: A, guard: SignGuard | SignPolicy, options: GuardAccountOptions = {}): A {
  const type: unknown = account.type; // read once: the value checked is the value the copy gets
  if (type !== "local") {
    throw new SignGuardError(
      "E_INVALID_ARGUMENT",
      `guardAccount needs a local account (type "local"), got ${JSON.stringify(type)}: viem signs other accounts over JSON-RPC, outside any guard`,
    );
  }
  assertOptionKeys(options, [...GUARD_OPTION_KEYS, "trustedSerializers", "releaseOnSignerError"]);
  const { trustedSerializers = [], releaseOnSignerError = false, ...guardOptions } = options;
  if (!Array.isArray(trustedSerializers)) {
    throw new SignGuardError("E_INVALID_ARGUMENT", "trustedSerializers must be a list, such as [base.serializers.transaction]");
  }
  if (typeof releaseOnSignerError !== "boolean") {
    throw new SignGuardError("E_INVALID_ARGUMENT", "releaseOnSignerError must be true or false");
  }
  const trusted = new Set(trustedSerializers);
  const ignored = Object.entries(guardOptions).filter(([, value]) => value !== undefined).map(([key]) => key);
  if (isSignGuard(guard) && ignored.length > 0) {
    throw new SignGuardError(
      "E_INVALID_ARGUMENT",
      `${ignored.join(", ")} configure a guard created from a policy; pass them to createSignGuard instead, since this SignGuard already has its own`,
    );
  }
  const signGuard = isSignGuard(guard) ? guard : createSignGuard(guard, guardOptions);
  const methods = account as unknown as Record<string, unknown>;
  const guarded: Record<string, unknown> = {};

  // Functions the guard does not know are refused; other fields are left out unless viem needs them,
  // so nothing on the account (a nested signer client, a key object) is reachable through the copy.
  for (const [key, value] of Object.entries(account)) {
    if (typeof value === "function" && !KNOWN_METHODS.includes(key)) guarded[key] = refuseNow(signGuard, key);
  }
  // Read through any getter, so an account that keeps these on a prototype stays usable by viem.
  for (const key of ACCOUNT_FIELDS) {
    const value = methods[key];
    if (value !== undefined && typeof value !== "function") guarded[key] = value;
  }
  guarded["type"] = "local";
  // A signing method the account lacks is refused before any check, so no window is spent on it.
  for (const name of KNOWN_METHODS) guarded[name] = refuse(signGuard, name);

  const bound = (name: string): Method | undefined => {
    const method = methods[name];
    return typeof method === "function" ? ((method as Method).bind(account) as Method) : undefined;
  };
  const sign = (request: SignRequest, signer: (judged: SignRequest) => Promise<unknown>) => run(signGuard, request, releaseOnSignerError, signer);

  const hash = bound("sign");
  if (hash !== undefined) guarded["sign"] = async (parameters: { hash: Hex }) => sign({ kind: "hash" }, () => hash(parameters));

  const signAuthorization = bound("signAuthorization");
  if (signAuthorization !== undefined) {
    guarded["signAuthorization"] = async (authorization: never) =>
      sign({ kind: "authorization", authorization }, (judged) => signAuthorization(field(judged, "authorization")));
  }

  const signMessage = bound("signMessage");
  if (signMessage !== undefined) {
    guarded["signMessage"] = async (parameters: unknown) =>
      sign(messageRequest(parameters), (judged) => signMessage({ message: field(judged, "message") }));
  }

  const signTransaction = bound("signTransaction");
  if (signTransaction !== undefined) {
    guarded["signTransaction"] = async (transaction: never, signOptions?: unknown) => {
      // Read once: the serializer checked is the serializer used, whatever happens to signOptions later.
      // One that cannot be read counts as an unknown serializer and is refused.
      const read = readField(signOptions, "serializer");
      const serializer = read.ok ? read.value : undefined;
      const customSerializer = !read.ok || (serializer !== undefined && !trusted.has(serializer));
      return sign({ kind: "transaction", transaction, customSerializer }, (judged) => signTransaction(field(judged, "transaction"), { serializer }));
    };
  }

  const signTypedData = bound("signTypedData");
  if (signTypedData !== undefined) {
    guarded["signTypedData"] = async (typedData: never) => sign({ kind: "typedData", typedData }, (judged) => signTypedData(field(judged, "typedData")));
  }

  return guarded as unknown as A;
}

async function run(guard: SignGuard, request: SignRequest, releaseOnError: boolean, sign: (judged: SignRequest) => Promise<unknown>): Promise<unknown> {
  const decision: Decision = await guard.check(request);
  if (!decision.allowed) throw deniedError(decision);
  try {
    return await sign(decision.request);
  } catch (error) {
    // A failed refund must not hide why signing failed; the amount then simply stays spent.
    if (releaseOnError) await Promise.resolve().then(() => guard.release(decision)).catch(() => undefined);
    throw error;
  }
}


/**
 * A message request whose `message` is read only when the guard copies it, so a getter that throws
 * becomes an unreadable request (refused and recorded) rather than an error before the check.
 */
function messageRequest(parameters: unknown): SignRequest {
  return {
    kind: "message",
    get message() {
      return (parameters as { message: never }).message;
    },
  };
}

/**
 * Stands in for a non-signing function the guard does not know, such as viem's synchronous
 * `getHdKey`. It throws at once, so a synchronous caller gets an error rather than a promise it
 * never handles; the attempt is still recorded through the guard.
 */
function refuseNow(guard: SignGuard, method: string): () => never {
  return () => {
    void guard.check({ kind: "unknown", method }).catch(() => undefined);
    // Built here because the caller is synchronous; same rule and reason the guard records, timed
    // by the wall clock at the throw.
    throw deniedError({
      allowed: false,
      kind: "unknown",
      rule: "method.unknown",
      reason: unknownMethodReason(method),
      summary: { method },
      at: Date.now(),
      reservations: [],
      request: { kind: "unknown", method },
    });
  };
}

/**
 * Stands in for a signing method the account lacks, where viem would otherwise ask the RPC node.
 * Recorded as `method.unknown`; no window is touched.
 */
function refuse(guard: SignGuard, method: string): Method {
  return async () => {
    throw deniedError(await guard.check({ kind: "unknown", method }));
  };
}

/** A field of the judged request. A request is only allowed when it has the kind it was built as. */
function field(judged: SignRequest, name: string): never {
  return (judged as unknown as Record<string, never>)[name] as never;
}

/** One read of a caller's field; `ok` is false when a getter threw. */
function readField(value: unknown, name: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined };
  } catch {
    return { ok: false };
  }
}

function isSignGuard(value: SignGuard | SignPolicy): value is SignGuard {
  return typeof value === "object" && value !== null && typeof (value as Partial<SignGuard>).check === "function";
}
