import { describeProviderValue, WalkerError } from "./errors.js";

/** A `0x`-prefixed hexadecimal string. */
export type Hex = `0x${string}`;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TOPIC_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

export function isAddress(value: unknown): value is Hex {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function isTopic(value: unknown): value is Hex {
  return typeof value === "string" && TOPIC_PATTERN.test(value);
}

/** Encodes a block number the way JSON-RPC expects a quantity: `0x` plus hex, no leading zeros. */
export function toQuantity(value: number): Hex {
  assertBlockNumber(value, "block number");
  return `0x${value.toString(16)}`;
}

/** Decodes a JSON-RPC quantity into a number. Rejects values above `Number.MAX_SAFE_INTEGER`. */
export function fromQuantity(value: unknown): number {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new WalkerError("E_INVALID_ARGUMENT", `expected a hex quantity, got ${JSON.stringify(value)}`);
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) {
    throw new WalkerError("E_INVALID_ARGUMENT", `quantity ${value} is above Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
}

/**
 * Decodes a quantity an endpoint returned. A malformed value there is the endpoint's fault, so it
 * surfaces as `E_RPC`; `E_INVALID_ARGUMENT` is reserved for the caller's own arguments.
 */
export function rpcQuantity(value: unknown, method: string): number {
  try {
    return fromQuantity(value);
  } catch (cause) {
    throw new WalkerError(
      "E_RPC",
      `${method} returned something other than a hex quantity: ${describeProviderValue(value)}`,
      { cause },
    );
  }
}

export function assertBlockNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WalkerError("E_INVALID_ARGUMENT", `${label} must be a non-negative integer, got ${String(value)}`);
  }
}
