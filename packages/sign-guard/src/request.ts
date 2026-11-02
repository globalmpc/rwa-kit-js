import type { Address, Hex } from "./hex.js";

/** One EIP-7702 authorization, signed or about to be signed. Same field names as viem. */
export interface AuthorizationLike {
  address?: Address | undefined;
  /** viem's alias for `address`. When both are given they must agree. */
  contractAddress?: Address | undefined;
  chainId: number;
  nonce: number;
}

/** The transaction fields the policy reads. Same names as viem's `TransactionSerializable`. */
export interface TransactionLike {
  type?: string | undefined;
  chainId?: number | undefined;
  to?: Address | null | undefined;
  value?: bigint | undefined;
  data?: Hex | undefined;
  /** Not read by viem's serializer. Refused when present, so what is checked is what is signed. */
  input?: Hex | undefined;
  authorizationList?: readonly AuthorizationLike[] | undefined;
  /** Blob fields. Blob transactions are refused. */
  blobs?: unknown | undefined;
  blobVersionedHashes?: unknown | undefined;
  maxFeePerBlobGas?: unknown | undefined;
  sidecars?: unknown | undefined;
}

export interface TypedDataLike {
  domain?: {
    name?: string | undefined;
    version?: string | undefined;
    chainId?: number | bigint | undefined;
    verifyingContract?: Address | undefined;
    salt?: Hex | undefined;
  };
  types?: unknown | undefined;
  primaryType?: string | undefined;
  message?: unknown | undefined;
}

/** A message as viem's `signMessage` takes it: text, or `{ raw }` bytes. */
export type MessageLike = string | { raw: Hex | Uint8Array };

/** Everything a key can be asked to sign, in one shape the policy can judge. */
export type SignRequest =
  | {
      kind: "transaction";
      transaction: TransactionLike;
      /** True when the caller supplied its own serializer, which could sign other bytes than these fields. */
      customSerializer?: boolean | undefined;
    }
  | { kind: "authorization"; authorization: AuthorizationLike }
  | { kind: "typedData"; typedData: TypedDataLike }
  | { kind: "message"; message: MessageLike }
  /** A raw 32-byte digest. Refused under every policy: a digest can be any of the above. */
  | { kind: "hash" }
  /** A signing method the guard does not know. Refused. */
  | { kind: "unknown"; method: string }
  /** A request that could not be copied for checking (see `snapshotRequest`). Refused. */
  | { kind: "unreadable"; method: string };

export type RequestKind = SignRequest["kind"];
