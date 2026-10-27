import type { Hex } from "@globalmpc/evm-log-walker";
import { GuardError, type GuardErrorCode } from "./errors.js";

export type { Hex } from "@globalmpc/evm-log-walker";

/**
 * A 20-byte account address. Any casing: a checksummed and a lower-case spelling name the same
 * account. `isValidChecksum` judges the casing; this type only promises the shape.
 */
export type Address = `0x${string}`;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function isTransactionHash(value: unknown): value is Hex {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/**
 * Addresses are compared lower-cased. A checksummed and a lower-case spelling of the same address
 * are the same account; the checksum is not verified here, only the 20-byte shape.
 */
export function normalizeAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}

/** Throws `E_INVALID_ADDRESS` unless `value` is a 20-byte hex address. Returns it lower-cased. */
export function checkedAddress(value: unknown, name: string): Address {
  if (!isAddress(value)) {
    throw new GuardError("E_INVALID_ADDRESS", `${name} ${String(value)} is not a 20-byte hex address`);
  }
  return normalizeAddress(value);
}

/** The 40 hex characters of an address, lower-cased, without the `0x`. */
export function addressBody(address: Address): string {
  return normalizeAddress(address).slice(2);
}

/** Decodes a hex quantity an endpoint returned into a `bigint`. Token amounts exceed 2^53. */
export function hexToBigInt(value: unknown, field: string, code: GuardErrorCode = "E_MALFORMED_TRANSFER"): bigint {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new GuardError(code, `expected a hex quantity for ${field}, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** The low 20 bytes of a 32-byte log topic, which is how an indexed `address` parameter is packed. */
export function topicToAddress(topic: Hex): Address {
  return normalizeAddress(`0x${topic.slice(-40)}` as Address);
}

/** An address as an indexed topic: left-padded to 32 bytes, for an `eth_getLogs` topic filter. */
export function addressToTopic(address: Address): Hex {
  return `0x${addressBody(address).padStart(64, "0")}` as Hex;
}
