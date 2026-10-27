import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { toChecksum } from "../src/checksum.js";
import { GuardError } from "../src/errors.js";
import type { Address } from "../src/hex.js";
import { findLookalikes } from "../src/lookalike.js";

const HEX = "0123456789abcdef";

const anyAddress = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Address);

/** Replaces the character at `index` with a different hex digit, keeping the address well-formed. */
function mutate(address: Address, index: number, pick: number): Address {
  const body = [...address.slice(2)];
  const current = body[index] as string;
  const options = [...HEX].filter((c) => c !== current);
  body[index] = options[pick % options.length] as string;
  return `0x${body.join("")}` as Address;
}

describe("findLookalikes", () => {
  const known = "0xabcd00000000000000000000000000000000abcd" as Address;

  it("flags an address that keeps both ends and changes the middle", () => {
    const candidate = "0xabcd11111111111111111111111111111111abcd" as Address;
    const [match] = findLookalikes(candidate, [known]);
    expect(match).toMatchObject({ known, prefix: "abcd", suffix: "abcd" });
    expect(match?.candidateMiddle).not.toBe(match?.knownMiddle);
  });

  it("does not flag an exact match, in any casing", () => {
    expect(findLookalikes(known, [known])).toEqual([]);
    expect(findLookalikes(toChecksum(known), [known])).toEqual([]);
    expect(findLookalikes(known, [toChecksum(known)])).toEqual([]);
  });

  it("does not flag a different prefix or a different suffix", () => {
    expect(findLookalikes("0xabce11111111111111111111111111111111abcd" as Address, [known])).toEqual([]);
    expect(findLookalikes("0xabcd11111111111111111111111111111111abce" as Address, [known])).toEqual([]);
  });

  it("reports every trusted address a candidate imitates, deduplicated", () => {
    const second = "0xabcd22222222222222222222222222222222abcd" as Address;
    const candidate = "0xabcd33333333333333333333333333333333abcd" as Address;
    const matches = findLookalikes(candidate, [known, second, known]);
    expect(matches.map((m) => m.known)).toEqual([known, second]);
  });

  it("honours a wider window", () => {
    const candidate = "0xabcdef111111111111111111111111111111abcd" as Address;
    const wide = "0xabcdef222222222222222222222222222222abcd" as Address;
    expect(findLookalikes(candidate, [wide], { prefix: 6 })).toHaveLength(1);
    expect(findLookalikes(candidate, [wide], { prefix: 6, suffix: 6 })).toEqual([]);
  });

  it("refuses a window that leaves no middle", () => {
    expect(() => findLookalikes(known, [known], { prefix: 20, suffix: 20 })).toThrow(GuardError);
    expect(() => findLookalikes(known, [known], { prefix: 0 })).toThrow(GuardError);
    expect(() => findLookalikes(known, [known], { suffix: 1.5 })).toThrow(GuardError);
  });

  it("rejects a malformed candidate or known entry", () => {
    expect(() => findLookalikes("0xnope" as Address, [known])).toThrow(GuardError);
    expect(() => findLookalikes(known, ["0xnope" as Address])).toThrow(GuardError);
  });
});

describe("properties", () => {
  it("mutating only the middle always yields a look-alike", () => {
    fc.assert(
      fc.property(anyAddress, fc.integer({ min: 4, max: 35 }), fc.nat(), (known, index, pick) => {
        const candidate = mutate(known, index, pick);
        expect(findLookalikes(candidate, [known])).toHaveLength(1);
        expect(assessRecipient(candidate, { trusted: [known] }).verdict).toBe("lookalike");
      }),
    );
  });

  it("mutating the prefix or the suffix never yields a look-alike", () => {
    fc.assert(
      fc.property(
        anyAddress,
        fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 36, max: 39 })),
        fc.nat(),
        (known, index, pick) => {
          const candidate = mutate(known, index, pick);
          expect(findLookalikes(candidate, [known])).toEqual([]);
          expect(assessRecipient(candidate, { trusted: [known] }).verdict).toBe("new");
        },
      ),
    );
  });

  it("is case-insensitive: checksum casing never changes a verdict", () => {
    fc.assert(
      fc.property(anyAddress, fc.integer({ min: 4, max: 35 }), fc.nat(), (known, index, pick) => {
        const candidate = mutate(known, index, pick);
        expect(findLookalikes(toChecksum(candidate), [toChecksum(known)])).toHaveLength(1);
      }),
    );
  });

  it("never reports an address as imitating itself", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        expect(findLookalikes(address, [address])).toEqual([]);
      }),
    );
  });
});
