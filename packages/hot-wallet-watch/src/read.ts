import { isBytes, parseQuantity, parseWord, type Address, type Hex } from "./hex.js";
import type { ResolvedWallet } from "./spec.js";

/** Marks the errors `withDeadline` itself raises, apart from any `TimeoutError` a caller's code throws. */
const DEADLINE = Symbol("hot-wallet-watch deadline");

/** Whether `error` is this package's own deadline passing (not a timeout thrown by other code). */
export function isDeadline(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[DEADLINE] === true;
}

/** `balanceOf(address)`. */
const BALANCE_OF = "0x70a08231";

/** What one endpoint says about one wallet at one block. */
export interface Observation {
  code: Hex;
  nonce: bigint;
  balance: bigint;
  /** Token balances by lower-case token address; a token whose read failed is absent. */
  tokens: ReadonlyMap<Address, bigint>;
  /** Tokens whose `balanceOf` failed or answered malformed data, with the reason. */
  tokenFailures: ReadonlyMap<Address, string>;
}

export type Reading = { ok: true; observation: Observation } | { ok: false; reason: string };

/**
 * Reads a wallet from one endpoint at block `block` through `ask`, which makes one JSON-RPC call to
 * that endpoint and enforces its deadline. Every value is checked for shape. Code, nonce and balance
 * decide whether the reading counts: a malformed or missing answer there is a failed reading, never a
 * clean one. A token read that fails is reported on its own and does not cost the wallet its code and
 * nonce checks.
 */
export async function readWallet(
  ask: (method: string, params: readonly unknown[], skip?: () => boolean) => Promise<unknown>,
  wallet: ResolvedWallet,
  block: Hex,
  tokensQueued: Promise<void> = Promise.resolve(),
): Promise<Reading> {
  // Code, nonce and balance are queued at once; token reads only once `tokensQueued` resolves, so a
  // caller can put every wallet's core reads ahead of any token read. Once a core read has failed, the
  // wallet's token reads still waiting are not sent.
  let abandoned = false;
  const skip = () => abandoned;
  const coreRead = (method: string) =>
    ask(method, [wallet.address, block], skip).catch((error: unknown) => {
      abandoned = true; // the wallet's other queued reads, core and token, are not sent
      throw error;
    });
  const core = Promise.all([coreRead("eth_getCode"), coreRead("eth_getTransactionCount"), coreRead("eth_getBalance")]);
  const tokenReads = tokensQueued.then(() =>
    Promise.all(
      wallet.tokens.map((token) =>
        ask("eth_call", [{ to: token.token, data: `${BALANCE_OF}${wallet.address.slice(2).padStart(64, "0")}` }, block], skip).then(
          (value) => ({ token: token.token, value: parseWord(value), reason: "balanceOf answered something other than one 32-byte word" }),
          (error: unknown) => ({ token: token.token, value: undefined, reason: `balanceOf failed (${errorKind(error)})` }),
        ),
      ),
    ),
  );
  const fail = (reason: string): Reading => {
    abandoned = true;
    return { ok: false, reason };
  };
  try {
    const [code, nonce, balance] = await core;
    if (!isBytes(code)) return fail("eth_getCode answered something other than hex bytes");
    const parsedNonce = parseQuantity(nonce);
    if (parsedNonce === undefined) return fail("eth_getTransactionCount answered something other than a quantity");
    const parsedBalance = parseQuantity(balance);
    if (parsedBalance === undefined) return fail("eth_getBalance answered something other than a quantity");
    const tokens = new Map<Address, bigint>();
    const tokenFailures = new Map<Address, string>();
    for (const read of await tokenReads) {
      if (read.value === undefined) tokenFailures.set(read.token, read.reason);
      else tokens.set(read.token, read.value);
    }
    return { ok: true, observation: { code, nonce: parsedNonce, balance: parsedBalance, tokens, tokenFailures } };
  } catch (error) {
    // The provider's own text can name the host, which can carry a key; only the kind of failure is kept.
    return fail(`the request failed (${errorKind(error)})`);
  }
}

/** Rejects with a `TimeoutError` when `promise` has not settled within `ms`: no endpoint can stall a pass. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("deadline passed"), { name: "TimeoutError", [DEADLINE]: true })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The kind of a thrown error, such as `RpcError`, read defensively and escaped. */
export function errorKind(error: unknown): string {
  try {
    const name: unknown = error instanceof Error ? error.name : undefined;
    return JSON.stringify(typeof name === "string" ? name.slice(0, 40) : "unknown error");
  } catch {
    return JSON.stringify("unknown error");
  }
}
