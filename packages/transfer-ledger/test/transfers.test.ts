import { describe, expect, it } from "vitest";
import type { Hex } from "@globalmpc/evm-log-walker";
import { decodeTransfer, TRANSFER_TOPIC, uniqueTransfers, type Transfer } from "../src/transfers.js";
import { hash, TOKEN } from "./fake-chain.js";

const topic = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

describe("decodeTransfer", () => {
  it("decodes an ERC-20 Transfer, lower-casing addresses", () => {
    const transfer = decodeTransfer({
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topic(0xc0de), topic(0xa1)],
      data: "0x64",
      blockNumber: 7,
      transactionHash: hash(1),
      transactionIndex: 4,
      logIndex: 3,
    });
    expect(transfer).toEqual({
      token: TOKEN,
      from: "0x000000000000000000000000000000000000c0de",
      to: "0x00000000000000000000000000000000000000a1",
      amount: 100n,
      blockNumber: 7,
      transactionHash: hash(1),
      transactionIndex: 4,
      logIndex: 3,
    });
  });

  it("rejects an ERC-721 Transfer, which has the same signature and four topics", () => {
    expect(() =>
      decodeTransfer({ address: TOKEN, topics: [TRANSFER_TOPIC, topic(1), topic(2), topic(3)], data: "0x", blockNumber: 1, transactionHash: hash(1), transactionIndex: 0, logIndex: 0 }),
    ).toThrow(expect.objectContaining({ code: "E_MALFORMED_TRANSFER" }));
  });
});

describe("uniqueTransfers", () => {
  const base: Transfer = { token: TOKEN, from: TOKEN, to: TOKEN, amount: 5n, blockNumber: 1, transactionHash: hash(1), transactionIndex: 0, logIndex: 0 };

  it("keeps two transfers of the same amount in one transaction: two log indexes are two payments", () => {
    expect(uniqueTransfers([base, { ...base, logIndex: 1 }])).toEqual({ transfers: [base, { ...base, logIndex: 1 }], dropped: 0 });
  });

  it("orders transfers by block, then position in the block, then log index, not by hash", () => {
    const later = { ...base, transactionHash: hash(1), transactionIndex: 9 };
    const earlier = { ...base, transactionHash: hash(2), transactionIndex: 1 };
    expect(uniqueTransfers([later, earlier]).transfers).toEqual([earlier, later]);
  });

  it("collapses the same log read twice, whatever the hash's letter case", () => {
    const again = { ...base, transactionHash: hash(1).toUpperCase().replace("0X", "0x") as Hex };
    expect(uniqueTransfers([base, again]).dropped).toBe(1);
  });
});
