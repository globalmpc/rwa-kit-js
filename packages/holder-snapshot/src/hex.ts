import { SnapshotError, type SnapshotErrorCode } from "./errors.js";

export type { Hex } from "@globalmpc/evm-log-walker";

/** A 20-byte account address. This package stores and compares them lower-cased. */
export type Address = `0x${string}`;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/** Lower-cases an address, so a checksummed and a lower-case spelling name the same holder. */
export function normalizeAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}

/** Throws `E_INVALID_ADDRESS` unless `value` is a 20-byte hex address. Returns it lower-cased. */
export function checkedAddress(value: unknown, name: string): Address {
  if (!isAddress(value)) {
    throw new SnapshotError("E_INVALID_ADDRESS", `${name} ${String(value)} is not a 20-byte hex address`);
  }
  return normalizeAddress(value);
}

/** Decodes a hex quantity an endpoint returned into a `bigint`. Token amounts exceed 2^53. */
export function hexToBigInt(value: unknown, field: string, code: SnapshotErrorCode = "E_MALFORMED_RESPONSE"): bigint {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new SnapshotError(code, `expected a hex quantity for ${field}, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** The low 20 bytes of a 32-byte log topic, which is how an indexed `address` parameter is packed. */
export function topicToAddress(topic: string): Address {
  return normalizeAddress(`0x${topic.slice(-40)}` as Address);
}

/** An address as a 32-byte ABI word, for `eth_call` calldata. */
export function addressWord(address: Address): string {
  return normalizeAddress(address).slice(2).padStart(64, "0");
}

/** A block number as the hex quantity JSON-RPC expects. */
export function blockQuantity(block: number): `0x${string}` {
  return `0x${block.toString(16)}`;
}
