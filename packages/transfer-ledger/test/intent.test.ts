import { describe, expect, it } from "vitest";
import { parseIntentCsv, parseIntentJson } from "../src/intent.js";

const A = "0x00000000000000000000000000000000000000A1";
const B = "0x00000000000000000000000000000000000000b2";

describe("parseIntentCsv", () => {
  it("reads the documented format: header in any order and case, quotes, comments, blank lines", () => {
    const csv = `# round 1 dividends\nAmount,Recipient\n\n"12.5",${A}\n7,"${B}"\n`;
    expect(parseIntentCsv(csv, { decimals: 2 })).toEqual([
      { recipient: A.toLowerCase(), amount: 1250n, line: 4 },
      { recipient: B, amount: 700n, line: 5 },
    ]);
  });

  it("keeps each line as its own payment when a recipient appears twice", () => {
    expect(parseIntentCsv(`recipient,amount\n${A},1\n${A},1\n`, { decimals: 0 })).toHaveLength(2);
  });

  it("selects a round, and refuses to guess when the file holds several", () => {
    const csv = `round,recipient,amount\nQ1,${A},1\nQ2,${B},2\n`;
    expect(parseIntentCsv(csv, { decimals: 0, round: "Q2" })).toEqual([{ recipient: B, amount: 2n, round: "Q2", line: 3 }]);
    expect(() => parseIntentCsv(csv, { decimals: 0 })).toThrow(/holds 2 rounds/);
    expect(() => parseIntentCsv(csv, { decimals: 0, round: "Q3" })).toThrow(/no payments for round Q3/);
  });

  it("names the line of every problem", () => {
    expect(() => parseIntentCsv(`recipient,amount\n0x1234,1\n`, { decimals: 0 })).toThrow(/line 2: recipient "0x1234"/);
    expect(() => parseIntentCsv(`recipient,amount\n${A},1.5\n`, { decimals: 0 })).toThrow(/line 2: amount 1.5 has more than 0 decimal places/);
    expect(() => parseIntentCsv(`recipient,amount\n${A},0\n`, { decimals: 0 })).toThrow(/line 2: amount is zero/);
    expect(() => parseIntentCsv(`recipient,amount\n${A}\n`, { decimals: 0 })).toThrow(/line 2: expected 2 values, got 1/);
    expect(() => parseIntentCsv(`address,value\n${A},1\n`, { decimals: 0 })).toThrow(/must name recipient and amount/);
    expect(() => parseIntentCsv(`# only a comment\n`, { decimals: 0 })).toThrow(/empty/);
  });
});

describe("parseIntentJson", () => {
  it("reads an array of string amounts, and rejects numbers that could lose precision", () => {
    expect(parseIntentJson(JSON.stringify([{ recipient: A, amount: "0.5" }]), { decimals: 1 })).toEqual([
      { recipient: A.toLowerCase(), amount: 5n, line: 1 },
    ]);
    expect(() => parseIntentJson(JSON.stringify([{ recipient: A, amount: 1 }]), { decimals: 0 })).toThrow(/must be strings/);
    expect(() => parseIntentJson("{", { decimals: 0 })).toThrow(/not valid JSON/);
    expect(() => parseIntentJson("{}", { decimals: 0 })).toThrow(/must be an array/);
  });
});
