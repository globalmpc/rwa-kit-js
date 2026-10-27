import type { Hex } from "@globalmpc/evm-log-walker";
import { LedgerError, type LedgerErrorCode } from "./errors.js";

export type { Hex } from "@globalmpc/evm-log-walker";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

export function isAddress(value: unknown): value is Hex {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function isTransactionHash(value: unknown): value is Hex {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/**
 * Addresses are compared lower-cased. A checksummed and a lower-case spelling of the same address
 * are the same recipient; the checksum is not verified, only the 20-byte shape.
 */
export function normalizeAddress(address: Hex): Hex {
  return address.toLowerCase() as Hex;
}

/** Decodes a hex quantity an endpoint returned into a `bigint`. Token amounts exceed 2^53. */
export function hexToBigInt(value: unknown, field: string, code: LedgerErrorCode = "E_MALFORMED_TRANSFER"): bigint {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new LedgerError(code, `expected a hex quantity for ${field}, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Decodes a hex quantity an endpoint returned into a `number`. Rejects values above 2^53 - 1. */
export function hexToInt(value: unknown, field: string, code: LedgerErrorCode = "E_MALFORMED_TRANSFER"): number {
  const big = hexToBigInt(value, field, code);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LedgerError(code, `${field} is above Number.MAX_SAFE_INTEGER`);
  }
  return Number(big);
}

/** The low 20 bytes of a 32-byte log topic, which is how an indexed `address` parameter is packed. */
export function topicToAddress(topic: Hex): Hex {
  return normalizeAddress(`0x${topic.slice(-40)}` as Hex);
}

/** An address as an indexed topic: left-padded to 32 bytes, for an `eth_getLogs` topic filter. */
export function addressToTopic(address: Hex): Hex {
  return `0x${normalizeAddress(address).slice(2).padStart(64, "0")}` as Hex;
}
