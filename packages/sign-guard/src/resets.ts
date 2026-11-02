import { SignGuardError } from "./errors.js";
import { ZERO_ADDRESS, type Address } from "./hex.js";

/** Most resets signed in one call. Each one is a separate signature with the key. */
export const MAX_PRESIGNED_RESETS = 1000;

export interface PresignResetsOptions {
  /** The chain the resets are valid on. */
  chainId: number;
  /** The account's current transaction count (`eth_getTransactionCount`, "pending"). */
  fromNonce: number;
  /** How many consecutive nonces to cover. */
  count: number;
}

/** An account that can sign EIP-7702 authorizations, as viem's local accounts can. */
export interface AuthorizationSigner<T> {
  signAuthorization(parameters: { address: Address; chainId: number; nonce: number }): Promise<T>;
}

/**
 * Signs EIP-7702 authorizations that delegate the account to the zero address, which clears any
 * delegation, for `count` consecutive nonces starting at `fromNonce`.
 *
 * An authorization is valid only while the account's nonce equals the one it names, so a set covering
 * the next nonces stays usable while the account is idle or sends a few transactions. Kept offline,
 * they let anyone with gas try to undo a hostile delegation without the key. It is a first response,
 * not a guarantee: the delegate's code runs as the account, and every contract it creates raises the
 * account's nonce, so a delegate built for it can move the nonce past the whole set first. They cannot move funds or grant
 * control. A stolen set can still be a nuisance: broadcasting one clears any delegation and uses up
 * the nonce it names, which drops a pending transaction at that nonce. Keep them out of public reach.
 * Sign a new set whenever the nonce has moved past the last one. If one signature fails, the error
 * propagates and the set is discarded: sign with the raw account while it is safe, or, signing through
 * the guard, keep `count` within the room left in `authorizations.resetWindow`. That window is the
 * guard's ledger and scope: an attempt whose signature fails still counts unless `releaseOnSignerError`
 * gives it back, and guards of one key share it only when they share a ledger and scope.
 */
export async function presignResets<T>(account: AuthorizationSigner<T>, options: PresignResetsOptions): Promise<T[]> {
  const { chainId, fromNonce, count } = options;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new SignGuardError("E_INVALID_ARGUMENT", "chainId must be a positive whole number");
  }
  if (!Number.isSafeInteger(fromNonce) || fromNonce < 0) {
    throw new SignGuardError("E_INVALID_ARGUMENT", "fromNonce must be a whole number of 0 or more");
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PRESIGNED_RESETS) {
    throw new SignGuardError("E_INVALID_ARGUMENT", `count must be between 1 and ${MAX_PRESIGNED_RESETS}`);
  }
  if (count - 1 > Number.MAX_SAFE_INTEGER - fromNonce) {
    throw new SignGuardError("E_INVALID_ARGUMENT", "fromNonce + count is above Number.MAX_SAFE_INTEGER");
  }
  const resets: T[] = [];
  for (let nonce = fromNonce; nonce < fromNonce + count; nonce++) {
    resets.push(await account.signAuthorization({ address: ZERO_ADDRESS, chainId, nonce }));
  }
  return resets;
}
