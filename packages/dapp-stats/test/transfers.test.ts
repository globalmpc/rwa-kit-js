import type { Log } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { StatsError } from "../src/errors.js";
import { decodeTransfer, TRANSFER_TOPIC } from "../src/transfers.js";

const FROM = "0x1111111111111111111111111111111111111111" as const;
const TO = "0x2222222222222222222222222222222222222222" as const;
const OTHER_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925" as const;
const FROM_TOPIC = `0x${"0".repeat(24)}${FROM.slice(2)}` as const;
const TO_TOPIC = `0x${"0".repeat(24)}${TO.slice(2)}` as const;
const SOME_HASH = "0x5555555555555555555555555555555555555555555555555555555555555555".slice(0, 66) as `0x${string}`;
const SOME_BLOCK_HASH = "0x4444444444444444444444444444444444444444444444444444444444444444".slice(0, 66) as `0x${string}`;

function baseLog(overrides: Partial<Log> = {}): Log {
  return {
    address: "0x3333333333333333333333333333333333333333",
    topics: [TRANSFER_TOPIC, FROM_TOPIC, TO_TOPIC],
    data: `0x${(100n).toString(16).padStart(64, "0")}`,
    blockNumber: 42,
    blockHash: SOME_BLOCK_HASH,
    transactionHash: SOME_HASH,
    transactionIndex: 0,
    logIndex: 1,
    removed: false,
    ...overrides,
  } as Log;
}

describe("decodeTransfer", () => {
  it("decodes from, to and value out of the indexed topics and data", () => {
    const transfer = decodeTransfer(baseLog());
    expect(transfer.from).toBe(FROM);
    expect(transfer.to).toBe(TO);
    expect(transfer.value).toBe(100n);
    expect(transfer.blockNumber).toBe(42);
    expect(transfer.logIndex).toBe(1);
  });

  it("rejects a log with a different topic count", () => {
    const log = baseLog({ topics: [TRANSFER_TOPIC, `0x${"0".repeat(24)}${FROM.slice(2)}`] });
    expect(() => decodeTransfer(log)).toThrow(StatsError);
    expect(() => decodeTransfer(log)).toThrow(/not a Transfer/);
  });

  it("rejects a log whose signature topic is not Transfer", () => {
    const log = baseLog({ topics: [OTHER_TOPIC, FROM_TOPIC, TO_TOPIC] });
    expect(() => decodeTransfer(log)).toThrow(/not a Transfer/);
  });
});
