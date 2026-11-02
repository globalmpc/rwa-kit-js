import type { AuthorizationLike, MessageLike, SignRequest, TransactionLike, TypedDataLike } from "./request.js";

/**
 * The fields a signature covers, and only those. viem hands `signTransaction` its whole prepared
 * request, the account object included; what is signed is built from the standard Ethereum fields
 * alone, so a field the guard did not check cannot reach the signature.
 */
const TRANSACTION_FIELDS = [
  "type",
  "chainId",
  "nonce",
  "to",
  "value",
  "data",
  "input",
  "gas",
  "gasPrice",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "accessList",
  "authorizationList",
  "blobs",
  "blobVersionedHashes",
  "maxFeePerBlobGas",
  "sidecars",
] as const;
/** `to` is viem's output format (`"object"`, `"hex"`, `"bytes"`), passed on so the result keeps its shape. */
const AUTHORIZATION_FIELDS = ["address", "contractAddress", "chainId", "nonce", "to"] as const;
const TYPED_DATA_FIELDS = ["domain", "types", "primaryType", "message"] as const;

/**
 * A copy of a request holding only the fields a signature covers, each read once and deep-copied.
 * Check the copy and sign the copy: a request changed after the check, or a getter answering
 * differently on a second read, then cannot change what is signed.
 *
 * Never throws. A request that cannot be copied (a function or proxy in a signed field, a getter that
 * throws, something that is not a request) comes back as `{ kind: "unreadable" }`, which every
 * policy refuses as `request.malformed`; a kind the guard does not know comes back as `unknown`.
 * Either way the attempt is still judged and recorded. `SignGuard.check` calls this itself and
 * returns the copy as `decision.request`.
 */
export function snapshotRequest(request: SignRequest): SignRequest {
  let kind: unknown;
  try {
    kind = (request as { kind?: unknown }).kind;
    switch (kind) {
      case "transaction": {
        const { transaction, customSerializer } = request as Extract<SignRequest, { kind: "transaction" }>;
        return { kind, transaction: pick<TransactionLike>(transaction, TRANSACTION_FIELDS), customSerializer: customSerializer === true };
      }
      case "authorization":
        return { kind, authorization: pick<AuthorizationLike>((request as Extract<SignRequest, { kind: "authorization" }>).authorization, AUTHORIZATION_FIELDS) };
      case "typedData":
        return { kind, typedData: pick<TypedDataLike>((request as Extract<SignRequest, { kind: "typedData" }>).typedData, TYPED_DATA_FIELDS) };
      case "message":
        return { kind, message: structuredClone((request as Extract<SignRequest, { kind: "message" }>).message) as MessageLike };
      case "hash":
        return { kind };
      case "unknown":
      case "unreadable":
        return { kind, method: String((request as { method?: unknown }).method) };
      default:
        // A kind that is spelt, but not one the guard knows, is an unknown method; anything else is unreadable.
        return typeof kind === "string" ? { kind: "unknown", method: kind } : { kind: "unreadable", method: "request" };
    }
  } catch {
    return { kind: "unreadable", method: typeof kind === "string" ? kind : "request" };
  }
}

/** Each field read once and deep-copied. Anything but a plain object throws, so the request is unreadable. */
function pick<T>(value: unknown, fields: readonly string[]): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("not an object");
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const field of fields) {
    const fieldValue = source[field];
    if (fieldValue !== undefined) copy[field] = structuredClone(fieldValue);
  }
  return copy as T;
}
