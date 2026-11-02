/** A `0x`-prefixed hexadecimal string. */
export type Hex = `0x${string}`;

/** A 20-byte address, `0x` plus 40 hex characters, in any letter case. */
export type Address = `0x${string}`;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * The code an EIP-7702 delegation leaves at an account: the designator `0xef0100` followed by the
 * delegate's 20-byte address. Ordinary contract code never starts with `0xef` (EIP-3541).
 */
const DELEGATION_PATTERN = /^0xef0100([0-9a-fA-F]{40})$/i;

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/** Addresses are compared in lower case; EIP-55 letter case carries a checksum, not identity. */
export function normalizeAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}

/** A JSON-RPC quantity as a bigint, or undefined when the value is not one. */
export function parseQuantity(value: unknown): bigint | undefined {
  return typeof value === "string" && QUANTITY_PATTERN.test(value) ? BigInt(value) : undefined;
}

/** Even-length `0x` hex, as `eth_getCode` returns. */
export function isBytes(value: unknown): value is Hex {
  return typeof value === "string" && BYTES_PATTERN.test(value);
}

/** A single 32-byte ABI word, as `balanceOf` returns. */
export function parseWord(value: unknown): bigint | undefined {
  return typeof value === "string" && WORD_PATTERN.test(value) ? BigInt(value) : undefined;
}

/** What the code at an address says about it. */
export type CodeState =
  | { kind: "none" }
  | { kind: "delegated"; delegate: Address }
  | { kind: "contract"; size: number };

/**
 * Classifies `eth_getCode` output: no code (an ordinary account), an EIP-7702 delegation and its
 * delegate, or contract code.
 */
export function classifyCode(code: Hex): CodeState {
  if (code === "0x") return { kind: "none" };
  const delegation = DELEGATION_PATTERN.exec(code);
  if (delegation?.[1] !== undefined) return { kind: "delegated", delegate: `0x${delegation[1].toLowerCase()}` };
  return { kind: "contract", size: (code.length - 2) / 2 };
}
