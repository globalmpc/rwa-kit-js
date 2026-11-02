/** A `0x`-prefixed hexadecimal string. */
export type Hex = `0x${string}`;

/** A 20-byte account or contract address, `0x` plus 40 hex characters, in any letter case. */
export type Address = `0x${string}`;

/** The zero address. An EIP-7702 authorization naming it clears a delegation instead of setting one. */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/** Even-length hex with a `0x` prefix: the shape of calldata. `0x` alone is empty calldata. */
export function isBytes(value: unknown): value is Hex {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

/** A 4-byte function selector such as `0xa9059cbb`. */
export function isSelector(value: unknown): value is Hex {
  return typeof value === "string" && SELECTOR_PATTERN.test(value);
}

/** Addresses are compared in lower case; EIP-55 letter case carries a checksum, not identity. */
export function normalizeAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}

/** The selector of a call, or `0x` for a call with no calldata (a plain value transfer). */
export function selectorOf(data: Hex): Hex {
  return data.length <= 2 ? "0x" : (data.slice(0, 10).toLowerCase() as Hex);
}

/** The `index`-th 32-byte argument word after the selector, as hex without a prefix. */
export function argumentWord(data: Hex, index: number): string | undefined {
  const start = 10 + index * 64;
  const word = data.slice(start, start + 64);
  return word.length === 64 ? word : undefined;
}

/** An address argument: a word whose first 12 bytes are zero. Anything else is not an address. */
export function addressWord(word: string): Address | undefined {
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return undefined;
  return `0x${word.slice(24).toLowerCase()}`;
}

export function uintWord(word: string): bigint {
  return BigInt(`0x${word}`);
}
