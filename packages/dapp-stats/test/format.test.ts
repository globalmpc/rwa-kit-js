import { describe, expect, it } from "vitest";
import { floorTo, utcDateRange } from "../src/format.js";

describe("floorTo", () => {
  it("floors instead of rounding, even when rounding would go the other way", () => {
    expect(floorTo(2 / 3, 3)).toBe(0.666); // Math.round would give 0.667
    expect(floorTo(0.4999, 0)).toBe(0); // Math.round would give 1
    expect(floorTo(1, 3)).toBe(1);
    expect(floorTo(0, 3)).toBe(0);
  });
});

describe("utcDateRange", () => {
  it("lists every date inclusive, ascending, crossing a month boundary", () => {
    expect(utcDateRange("2026-01-30", "2026-02-02")).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });

  it("returns a single date when start equals end", () => {
    expect(utcDateRange("2026-01-01", "2026-01-01")).toEqual(["2026-01-01"]);
  });
});
