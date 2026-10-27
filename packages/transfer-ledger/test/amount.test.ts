import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "../src/amount.js";

describe("parseUnits / formatUnits", () => {
  it("converts token units to base units exactly, and back", () => {
    expect(parseUnits("12.5", 18)).toBe(12_500_000_000_000_000_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("100", 0)).toBe(100n);
    expect(formatUnits(12_500_000_000_000_000_000n, 18)).toBe("12.5");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(0n, 18)).toBe("0");
    expect(formatUnits(-5n, 1)).toBe("-0.5");
  });

  it("keeps values beyond 2^53 exact", () => {
    expect(formatUnits(parseUnits("123456789012345678.123456789012345678", 18), 18)).toBe("123456789012345678.123456789012345678");
  });

  it("refuses anything it would have to round or guess", () => {
    for (const text of ["1.0000001", "-1", "+1", "1e3", "1,000", "", ".5", "1.", "abc"]) {
      expect(() => parseUnits(text, 6)).toThrow(expect.objectContaining({ code: "E_INTENT_FORMAT" }));
    }
  });

  it("rejects decimals outside 0 to 255", () => {
    expect(() => parseUnits("1", -1)).toThrow(expect.objectContaining({ code: "E_INVALID_ARGUMENT" }));
    expect(() => formatUnits(1n, 256)).toThrow(expect.objectContaining({ code: "E_INVALID_ARGUMENT" }));
  });
});
