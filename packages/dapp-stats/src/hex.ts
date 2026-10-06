import type { Hex } from "@globalmpc/evm-log-walker";
import { StatsError } from "./errors.js";

export type { Hex } from "@globalmpc/evm-log-walker";

/** The address every ERC-20 `Transfer` uses for minting (from) and burning (to). Never a holder. */
export const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

export function isAddress(value: unknown): value is Hex {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/** Decodes a hex quantity an endpoint returned into a `bigint`. Values here can exceed 2^53. */
export function hexToBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new StatsError("E_MALFORMED_TX", `expected a hex quantity for ${field}, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Decodes a hex quantity an endpoint returned into a `number`. Rejects values above 2^53 - 1. */
export function hexToInt(value: unknown, field: string): number {
  const big = hexToBigInt(value, field);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StatsError("E_MALFORMED_TX", `${field} is above Number.MAX_SAFE_INTEGER`);
  }
  return Number(big);
}

/** The low 20 bytes of a 32-byte log topic, which is how an indexed `address` parameter is packed. */
export function topicToAddress(topic: Hex): Hex {
  return `0x${topic.slice(-40)}` as Hex;
}
