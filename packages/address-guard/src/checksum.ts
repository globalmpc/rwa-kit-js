import { keccak_256 } from "@noble/hashes/sha3.js";
import { addressBody, checkedAddress, isAddress, type Address } from "./hex.js";

const HEX = "0123456789abcdef";

/**
 * How an address's casing relates to its EIP-55 checksum.
 *
 * `"unchecksummed"` is not a failure. An all-lower-case address carries no case information, so
 * there is nothing to verify; it is the form most tools print and most people paste. `"mismatch"`
 * means the address does carry case information and it is wrong, which is worth stopping for.
 */
export type ChecksumState = "checksummed" | "unchecksummed" | "mismatch";

/**
 * The EIP-55 checksummed spelling of an address.
 *
 * Keccak-256 of the 40 lower-case hex characters (as ASCII, without the `0x`); each address
 * character is upper-cased when the hash digit in the same position is 8 or above. Matches
 * `getAddress` in viem, which the differential tests assert.
 *
 * Throws `E_INVALID_ADDRESS` unless the input is a 20-byte hex address.
 */
export function toChecksum(address: Address): Address {
  const body = addressBody(checkedAddress(address, "address"));
  const digest = keccak_256(new TextEncoder().encode(body));
  let out = "";
  for (let i = 0; i < 40; i++) {
    const char = body.charAt(i);
    // Two hex digits per byte: the high nibble first, so character i uses byte i >> 1.
    const byte = digest[i >> 1] ?? 0;
    const nibble = (i & 1) === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return `0x${out}`;
}

/**
 * Whether an address's casing is acceptable under EIP-55: either the exact checksummed spelling,
 * or all lower case, which carries no checksum to contradict.
 *
 * This is deliberately the same answer as `isAddress` in viem with its default `strict: true`,
 * including viem's asymmetry — an all-lower-case address passes, an all-upper-case one does not.
 * Use `checksumState` when "unchecksummed" and "wrong" need telling apart.
 */
export function isValidChecksum(address: unknown): boolean {
  if (!isAddress(address)) return false;
  const body = addressBody(address);
  return address === `0x${body}` || address === toChecksum(address);
}

/** Classifies an address's casing. Throws `E_INVALID_ADDRESS` for anything but a 20-byte address. */
export function checksumState(address: Address): ChecksumState {
  const checked = checkedAddress(address, "address");
  if (address === toChecksum(checked)) return "checksummed";
  if (address === `0x${addressBody(checked)}`) return "unchecksummed";
  return "mismatch";
}

/** True when `value` is 40 hex characters after `0x`, whatever its casing. Re-exported for the CLI. */
export { isAddress } from "./hex.js";

/** The hex alphabet used to read a digest nibble, exported only so tests can assert the table. */
export const HEX_DIGITS = HEX;
