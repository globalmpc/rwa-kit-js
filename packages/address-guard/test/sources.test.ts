import { createRpc, redactEndpoint } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { GuardError } from "../src/errors.js";
import type { Address, Hex } from "../src/hex.js";
import type { History, HistorySource } from "../src/history.js";
import { DEFAULT_MAX_BLOCKS, indexerThenRpc, rpcLogSource } from "../src/sources.js";
import { deriveTrustedRecipients } from "../src/trusted.js";
import { fakeChain, GENUINE, IMITATOR, OWNER, STRANGER, TOKEN } from "./fake-chain.js";

const ENDPOINT = "https://rpc.example/key-that-must-not-leak";

function rpcFor(options: Parameters<typeof fakeChain>[0]) {
  const chain = fakeChain(options);
  return { rpc: createRpc({ urls: ENDPOINT, fetch: chain.fetch, retries: 0 }), calls: chain.calls };
}

describe("rpcLogSource", () => {
  it("reads outgoing and incoming transfers and labels their direction", async () => {
    const { rpc } = rpcFor({
      head: 500,
      transfers: [
        { blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n },
        { blockNumber: 20, from: STRANGER, to: OWNER, valueRaw: 7n },
      ],
    });
    const { events, source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ counterparty: GENUINE, direction: "out", valueRaw: 1_000n, blockNumber: 10n });
    expect(events[1]).toMatchObject({ counterparty: STRANGER, direction: "in", valueRaw: 7n });
    expect(source.kind).toBe("rpc");
  });

  it("names the endpoint by position, carrying no part of the URL", async () => {
    const { rpc } = rpcFor({ head: 50, transfers: [] });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(source.endpoint).toBe("endpoint-1");
    expect(source.endpoint).not.toContain("key-that-must-not-leak");
    expect(source.endpoint).not.toContain("rpc.example");
  });

  it("reports origins when the caller opts in", async () => {
    const { rpc } = rpcFor({ head: 50, transfers: [] });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN], endpointLabel: redactEndpoint }).fetch(OWNER);
    expect(source.endpoint).toBe("https://rpc.example");
    expect(source.endpoint).not.toContain("key-that-must-not-leak");
  });

  it("resolves the owner's own sends through eth_getTransactionByHash, not the log topic", async () => {
    const { rpc, calls } = rpcFor({
      head: 500,
      transfers: [
        // The forgery: the log says the owner sent it, the transaction was the imitator's.
        { blockNumber: 10, from: OWNER, to: IMITATOR, valueRaw: 0n, txFrom: IMITATOR },
        { blockNumber: 11, from: OWNER, to: GENUINE, valueRaw: 500n },
      ],
    });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    const forged = events.find((event) => event.counterparty === IMITATOR);
    expect(forged?.txFrom).toBe(IMITATOR);
    expect(forged?.direction).toBe("out");
    // The whole point: the forgery is read, reported, and then excluded by the trust rule.
    expect(deriveTrustedRecipients(events)).toEqual([GENUINE]);
    expect(calls.filter((call) => call.method === "eth_getTransactionByHash")).toHaveLength(2);
  });

  it("marks every event successful, because a reverted transaction emits no readable log", async () => {
    const { rpc } = rpcFor({ head: 50, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }] });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(events.every((event) => event.success)).toBe(true);
  });

  it("ignores reorged logs and ERC-721 transfers", async () => {
    const { rpc } = rpcFor({
      head: 50,
      transfers: [
        { blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n, removed: true },
        { blockNumber: 11, from: OWNER, to: STRANGER, valueRaw: 1n, erc721: true },
        { blockNumber: 12, from: OWNER, to: GENUINE, valueRaw: 5n },
      ],
    });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(events).toHaveLength(1);
    expect(events[0]?.valueRaw).toBe(5n);
  });

  it("clamps a wide range to the most recent window and reports what it read", async () => {
    const { rpc } = rpcFor({ head: 10_000, transfers: [] });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN], maxBlocks: 100 }).fetch(OWNER, { fromBlock: 0 });
    expect(source.toBlock).toBe(10_000);
    expect(source.fromBlock).toBe(9_901);
  });

  it("honours a narrower caller range without widening it", async () => {
    const { rpc } = rpcFor({ head: 10_000, transfers: [] });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER, { fromBlock: 9_000, toBlock: 9_500 });
    expect(source).toMatchObject({ fromBlock: 9_000, toBlock: 9_500 });
  });

  it("survives an endpoint that refuses wide spans, via the walker's chunking", async () => {
    const { rpc } = rpcFor({
      head: 5_000,
      maxLogSpan: 100,
      transfers: [{ blockNumber: 4_900, from: OWNER, to: GENUINE, valueRaw: 2n }],
    });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN], chunkSize: 2_000 }).fetch(OWNER, { fromBlock: 4_000 });
    expect(events).toHaveLength(1);
  });

  it("reports checkpoints so a long scan can be resumed", async () => {
    const seen: number[] = [];
    const { rpc } = rpcFor({ head: 300, transfers: [] });
    await rpcLogSource(rpc, {
      tokens: [TOKEN],
      chunkSize: 100,
      onCheckpoint: (checkpoint) => void seen.push(checkpoint.nextBlock),
    }).fetch(OWNER, { fromBlock: 0 });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(301);
  });

  it("fails loudly when a transaction cannot be read, rather than guessing its sender", async () => {
    const hash = `0x${(1).toString(16).padStart(64, "0")}` as Hex;
    const { rpc } = rpcFor({
      head: 50,
      transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }],
      missingTransactions: [hash],
    });
    await expect(rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER)).rejects.toThrow(GuardError);
  });

  it("validates its own arguments", () => {
    const { rpc } = rpcFor({ head: 10, transfers: [] });
    // tokens is required: an unfiltered read lets any contract inject a Transfer log.
    expect(() => rpcLogSource(rpc, { tokens: [] })).toThrow(/tokens is required/);
    expect(() => rpcLogSource(rpc, { tokens: [TOKEN], maxBlocks: 0 })).toThrow(GuardError);
    expect(() => rpcLogSource(rpc, { tokens: ["0xnope" as Address] })).toThrow(GuardError);
  });

  it("rejects a malformed owner before making any call", async () => {
    const { rpc, calls } = rpcFor({ head: 10, transfers: [] });
    await expect(rpcLogSource(rpc, { tokens: [TOKEN] }).fetch("0xnope" as Address)).rejects.toThrow(GuardError);
    expect(calls).toHaveLength(0);
  });

  it("exposes a documented default window", () => {
    expect(DEFAULT_MAX_BLOCKS).toBeGreaterThan(0);
  });
});

describe("indexerThenRpc", () => {
  const history = (kind: "indexer" | "rpc"): History => ({
    events: [
      {
        owner: OWNER,
        counterparty: GENUINE,
        direction: "out",
        valueRaw: 1n,
        success: true,
        txFrom: OWNER,
        txHash: `0x${"ab".repeat(32)}` as Hex,
        blockNumber: 1n,
      },
    ],
    source: {
      kind,
      endpoint: `https://${kind}.example`,
      endpoints: [`https://${kind}.example`],
      fromBlock: 0,
      toBlock: 1,
      // Only a source stating its indexed coverage is ever preferred over RPC.
      ...(kind === "indexer" ? { coverage: { fromBlock: 0, toBlock: 1 } } : {}),
    },
  });

  const working = (kind: "indexer" | "rpc"): HistorySource => ({ fetch: async () => history(kind) });
  const broken: HistorySource = {
    fetch: async () => {
      throw new Error("indexer is down");
    },
  };
  const empty: HistorySource = {
    fetch: async () => ({
      events: [],
      source: { kind: "indexer", endpoint: "https://indexer.example", endpoints: ["https://indexer.example"], fromBlock: 0, toBlock: 1 },
    }),
  };

  it("uses the indexer when it answers with events over a verifiable range", async () => {
    const { source } = await indexerThenRpc(working("indexer"), working("rpc")).fetch(OWNER, {
      fromBlock: 0,
      toBlock: 1,
    });
    expect(source.kind).toBe("indexer");
  });

  /**
   * Without a requested range there is nothing to measure coverage against, and an event count
   * cannot stand in for one, so the indexer is refused rather than trusted.
   */
  it("refuses the indexer when no range was requested", async () => {
    const { source } = await indexerThenRpc(working("indexer"), working("rpc")).fetch(OWNER);
    expect(source.kind).toBe("rpc");
  });

  it("falls back to rpc when the indexer throws, and says so in the source", async () => {
    const { source } = await indexerThenRpc(broken, working("rpc")).fetch(OWNER, { fromBlock: 0, toBlock: 1 });
    expect(source.kind).toBe("rpc");
  });

  /**
   * An empty answer cannot be told apart from an index that is still catching up. Treating it as a
   * complete history would let a look-alike through as "new", so it falls back too.
   */
  it("falls back when the indexer answers with nothing at all", async () => {
    const { source } = await indexerThenRpc(empty, working("rpc")).fetch(OWNER, { fromBlock: 0, toBlock: 1 });
    expect(source.kind).toBe("rpc");
  });

  it("raises E_NO_SOURCE when neither source can answer", async () => {
    await expect(indexerThenRpc(broken, broken).fetch(OWNER, { fromBlock: 0, toBlock: 1 })).rejects.toMatchObject({
      code: "E_NO_SOURCE",
    });
  });

  it("passes the range through to whichever source answers", async () => {
    const seen: unknown[] = [];
    const recorder: HistorySource = {
      fetch: async (_owner, range) => {
        seen.push(range);
        return history("rpc");
      },
    };
    await indexerThenRpc(broken, recorder).fetch(OWNER, { fromBlock: 7, toBlock: 9 });
    expect(seen).toEqual([{ fromBlock: 7, toBlock: 9 }]);
  });
});
