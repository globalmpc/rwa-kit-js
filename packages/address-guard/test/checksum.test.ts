import fc from "fast-check";
import { getAddress, isAddress as viemIsAddress } from "viem";
import { describe, expect, it } from "vitest";
import { checksumState, isValidChecksum, toChecksum } from "../src/checksum.js";
import { GuardError } from "../src/errors.js";
import type { Address } from "../src/hex.js";

/**
 * The four vectors in EIP-55 itself, each already in its checksummed spelling. Public
 * specification examples, not anyone's wallet.
 */
const SPEC_VECTORS = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
] as const;

/**
 * An arbitrary that yields well-formed, all-lower-case addresses. Generated as the 20 bytes an
 * address is, so every byte value is reachable; `fast-check` v4 has no `hexaString`.
 */
const anyAddress = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Address);

describe("toChecksum", () => {
  it.each(SPEC_VECTORS)("reproduces the EIP-55 vector %s from its lower-case form", (vector) => {
    expect(toChecksum(vector.toLowerCase() as Address)).toBe(vector);
  });

  it.each(SPEC_VECTORS)("leaves the already-checksummed %s unchanged", (vector) => {
    expect(toChecksum(vector as Address)).toBe(vector);
  });

  it("rejects anything that is not a 20-byte address", () => {
    for (const bad of ["", "0x", "not-an-address", `0x${"ab".repeat(19)}`, `0x${"ab".repeat(21)}`]) {
      expect(() => toChecksum(bad as Address)).toThrow(GuardError);
    }
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        const once = toChecksum(address);
        expect(toChecksum(once)).toBe(once);
      }),
    );
  });

  it("round-trips with isValidChecksum", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        expect(isValidChecksum(toChecksum(address))).toBe(true);
      }),
    );
  });

  it("changes only casing, never the address itself", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        expect(toChecksum(address).toLowerCase()).toBe(address);
      }),
    );
  });
});

describe("agreement with viem", () => {
  it.each(SPEC_VECTORS)("toChecksum matches getAddress for %s", (vector) => {
    expect(toChecksum(vector.toLowerCase() as Address)).toBe(getAddress(vector.toLowerCase()));
  });

  it("toChecksum matches getAddress for arbitrary addresses", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        expect(toChecksum(address)).toBe(getAddress(address));
      }),
    );
  });

  /**
   * viem's `isAddress` accepts an all-lower-case address (nothing to verify) and rejects an
   * all-upper-case one. `isValidChecksum` is defined to give the same answer, asymmetry included.
   */
  it("isValidChecksum matches isAddress across all four casings", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        const checksummed = toChecksum(address);
        const upper = `0x${address.slice(2).toUpperCase()}` as Address;
        for (const form of [address, checksummed, upper]) {
          expect(isValidChecksum(form)).toBe(viemIsAddress(form));
        }
      }),
    );
  });

  it("isValidChecksum matches isAddress on a flipped character", () => {
    fc.assert(
      fc.property(anyAddress, fc.nat({ max: 39 }), (address, index) => {
        const body = [...toChecksum(address).slice(2)];
        const char = body[index] as string;
        // Only a letter carries case, so only a letter can be mangled.
        fc.pre(/[a-fA-F]/.test(char));
        body[index] = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
        const mangled = `0x${body.join("")}` as Address;
        expect(isValidChecksum(mangled)).toBe(viemIsAddress(mangled));
      }),
    );
  });
});

describe("isValidChecksum and checksumState", () => {
  it("rejects malformed values without throwing", () => {
    for (const bad of [undefined, null, 42, "", "0xnope", `0x${"ab".repeat(19)}`]) {
      expect(isValidChecksum(bad)).toBe(false);
    }
  });

  it("separates an unchecksummed address from a wrong one", () => {
    const vector = SPEC_VECTORS[0];
    expect(checksumState(vector as Address)).toBe("checksummed");
    expect(checksumState(vector.toLowerCase() as Address)).toBe("unchecksummed");
    // Last letter's case flipped: case information present, and wrong.
    expect(checksumState("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Beaed" as Address)).toBe("mismatch");
  });
});
