import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { toChecksum } from "../src/checksum.js";
import type { Address } from "../src/hex.js";
import type { SourceInfo } from "../src/history.js";

const TRUSTED = "0xabcd00000000000000000000000000000000abcd" as Address;
const IMITATOR = "0xabcd11111111111111111111111111111111abcd" as Address;
const UNRELATED = "0x9999000000000000000000000000000000009999" as Address;

const SOURCE: SourceInfo = {
  kind: "rpc",
  endpoint: "https://rpc.example",
  endpoints: ["https://rpc.example"],
  fromBlock: 1,
  toBlock: 2,
};

describe("assessRecipient", () => {
  it("calls an exact trusted address trusted", () => {
    const result = assessRecipient(TRUSTED, { trusted: [TRUSTED] });
    expect(result.verdict).toBe("trusted");
    expect(result.normalized).toBe(TRUSTED);
    expect(result.evidence).toEqual([]);
    expect(result.reasons.join(" ")).toContain("really sent");
  });

  it("accepts the checksummed spelling of a trusted address", () => {
    expect(assessRecipient(toChecksum(TRUSTED), { trusted: [TRUSTED] }).verdict).toBe("trusted");
  });

  it("calls an unrelated well-formed address new", () => {
    const result = assessRecipient(UNRELATED, { trusted: [TRUSTED] });
    expect(result.verdict).toBe("new");
    expect(result.evidence).toEqual([]);
  });

  it("calls an imitator a look-alike and names what it imitates", () => {
    const result = assessRecipient(IMITATOR, { trusted: [TRUSTED] });
    expect(result.verdict).toBe("lookalike");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.known).toBe(TRUSTED);
  });

  it("calls a malformed value invalid and leaves normalized unset", () => {
    for (const bad of ["", "0x", "0xnope", `0x${"ab".repeat(19)}`, "not an address"]) {
      const result = assessRecipient(bad, { trusted: [TRUSTED] });
      expect(result.verdict).toBe("invalid");
      expect(result.normalized).toBeUndefined();
      expect(result.evidence).toEqual([]);
    }
  });

  it("calls a mangled checksum bad-checksum", () => {
    // A trusted address with one letter's case wrong: right bytes, wrong casing.
    const checksummed = toChecksum(TRUSTED);
    const flipped = flipFirstLetterCase(checksummed);
    const result = assessRecipient(flipped, { trusted: [TRUSTED] });
    expect(result.verdict).toBe("bad-checksum");
    expect(result.reasons.join(" ")).toContain("EIP-55");
  });

  /**
   * A look-alike outranks a checksum complaint: both mean "do not send", and reporting the casing
   * instead would hide the dangerous half. The checksum problem still appears in `reasons`.
   */
  it("reports a look-alike ahead of a checksum problem, keeping both reasons", () => {
    const flipped = flipFirstLetterCase(toChecksum(IMITATOR));
    const result = assessRecipient(flipped, { trusted: [TRUSTED] });
    expect(result.verdict).toBe("lookalike");
    expect(result.checksum).toBe("mismatch");
    expect(result.reasons.some((r) => r.includes("EIP-55"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("differs in the middle"))).toBe(true);
  });

  describe("verdict precedence", () => {
    /**
     * A trusted address stays trusted when some other trusted address happens to share both
     * ends with it. The resemblance is still reported, but it is not this address's problem --
     * crying look-alike over a recipient the owner really pays is how a tool gets ignored.
     */
    it("keeps trusted when another trusted address resembles it", () => {
      const result = assessRecipient(TRUSTED, { trusted: [TRUSTED, IMITATOR] });
      expect(result.verdict).toBe("trusted");
      expect(result.evidence.map((m) => m.known)).toEqual([IMITATOR]);
      expect(result.reasons.join(" ")).toContain("does not make this one suspect");
    });

    /** Correct bytes, corrupt casing: safe to send, but the input was edited by hand. */
    it("prefers bad-checksum over trusted when the casing is corrupt", () => {
      const result = assessRecipient(flipFirstLetterCase(toChecksum(TRUSTED)), { trusted: [TRUSTED] });
      expect(result.verdict).toBe("bad-checksum");
    });

    /** Both mean "do not send"; reporting the casing would hide the imitation. */
    it("prefers lookalike over bad-checksum", () => {
      const result = assessRecipient(flipFirstLetterCase(toChecksum(IMITATOR)), { trusted: [TRUSTED] });
      expect(result.verdict).toBe("lookalike");
      expect(result.checksum).toBe("mismatch");
    });

    it("prefers invalid over everything", () => {
      expect(assessRecipient("0xZZ", { trusted: [TRUSTED] }).verdict).toBe("invalid");
    });
  });

  it("says so when there was no history to compare against", () => {
    const result = assessRecipient(UNRELATED, { trusted: [] });
    expect(result.verdict).toBe("new");
    expect(result.reasons.join(" ")).toContain("no trusted recipients");
  });

  it("carries the source through to the result, including for an invalid candidate", () => {
    expect(assessRecipient(UNRELATED, { trusted: [], source: SOURCE }).source).toEqual(SOURCE);
    expect(assessRecipient("0xnope", { trusted: [], source: SOURCE }).source).toEqual(SOURCE);
  });

  it("omits source entirely when the caller gave none", () => {
    expect("source" in assessRecipient(UNRELATED, { trusted: [] })).toBe(false);
  });

  it("honours a custom window", () => {
    const wide = "0xabcdef000000000000000000000000000000abcd" as Address;
    const near = "0xabcdef111111111111111111111111111111abcd" as Address;
    expect(assessRecipient(near, { trusted: [wide], prefix: 6 }).verdict).toBe("lookalike");
    // A suffix wide enough to reach into the differing middle: the ends no longer match.
    expect(assessRecipient(near, { trusted: [wide], prefix: 6, suffix: 30 }).verdict).toBe("new");
  });

  it("propagates a window that leaves no middle as an error", () => {
    expect(() => assessRecipient(UNRELATED, { trusted: [TRUSTED], prefix: 20, suffix: 20 })).toThrow(
      /no middle is left/,
    );
  });
});

/** Flips the case of the first cased character, producing a checksum mismatch. */
function flipFirstLetterCase(address: Address): string {
  const body = [...address.slice(2)];
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string;
    if (/[a-fA-F]/.test(char)) {
      body[i] = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
      return `0x${body.join("")}`;
    }
  }
  throw new Error("no cased character to flip");
}
