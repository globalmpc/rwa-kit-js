/**
 * When `indexerThenRpc` prefers an indexer over RPC. An index that has not caught up can hold a
 * recent dust transfer while missing older genuine sends, which empties the trusted set, so an
 * indexer's answer is used only when its own stated coverage and the range it read both span
 * the whole request and it returned events.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import type { History, HistoryEvent, HistorySource } from "../src/history.js";
import { indexerThenRpc, rpcLogSource } from "../src/sources.js";
import { deriveTrustedRecipients } from "../src/trusted.js";
import { fakeChain, GENUINE, IMITATOR, OWNER, STRANGER, TOKEN } from "./fake-chain.js";
import { genuineSend, mockSource, poisonedHistory } from "./fixtures.js";

function io(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: {},
    source: () => mockSource(poisonedHistory),
    ...over,
  };
}

/**
 * An indexer that states the range it has actually indexed. Only a source that can do this is
 * ever preferred over RPC; `coverage` is what `indexerThenRpc` checks, never the echoed query.
 */
function indexer(fromBlock: number, toBlock: number, events: History["events"]): HistorySource {
  return {
    fetch: async (_owner, range): Promise<History> => ({
      events,
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        // The query range is echoed, as any source does...
        fromBlock: range?.fromBlock ?? 0,
        toBlock: range?.toBlock ?? 0,
        // ...while coverage is the independent claim about what has been indexed.
        coverage: { fromBlock, toBlock },
      },
    }),
  };
}

/** An indexer that answers but states no coverage: never preferred, however many events it has. */
function indexerWithoutCoverage(events: History["events"]): HistorySource {
  return {
    fetch: async (_owner, range): Promise<History> => ({
      events,
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        fromBlock: range?.fromBlock ?? 0,
        toBlock: range?.toBlock ?? 0,
      },
    }),
  };
}

const rpcSource: HistorySource = {
  fetch: async (): Promise<History> => ({
    events: [genuineSend()],
    source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 1_000 },
  }),
}

describe("an indexer is only preferred when it can prove its coverage", () => {
  /**
   * An indexer given as one more URL on an RPC client would only be failed over from on transport
   * errors, so an indexer answering with an empty array would be accepted. There is no --indexer
   * flag: a plain JSON-RPC endpoint cannot state what it has indexed, and rpcLogSource never sets
   * SourceInfo.coverage.
   */
  it("does not accept --indexer as an option at all", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--indexer", "https://i.example"],
      context,
    );
    expect(code).toBe(EXIT.USAGE);
  });

  it("never lets rpcLogSource claim indexed coverage", async () => {
    const chain = fakeChain({ head: 100, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }] });
    const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER, { fromBlock: 0, toBlock: 100 });
    expect(source.kind).toBe("rpc");
    expect(source.coverage).toBeUndefined();
  });
});

describe("a partially indexed answer is not complete", () => {
  const event = (): HistoryEvent => ({ ...genuineSend(), blockNumber: 50n });

  // `coverage` is the independent claim indexerThenRpc checks; fromBlock/toBlock merely echo
  // the query, which is why they cannot be used for it.
  const lagging = (fromBlock: number, toBlock: number): HistorySource => ({
    fetch: async (_owner, range): Promise<History> => ({
      events: [event()],
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        fromBlock: range?.fromBlock ?? 0,
        toBlock: range?.toBlock ?? 0,
        coverage: { fromBlock, toBlock },
      },
    }),
  });
  const full: HistorySource = {
    fetch: async (): Promise<History> => ({
      events: [event(), { ...genuineSend(STRANGER), blockNumber: 10n }],
      source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 100 },
    }),
  };

  it("falls back when the indexer starts later than requested, despite having events", async () => {
    const { source, events } = await indexerThenRpc(lagging(40, 100), full).fetch(OWNER, { fromBlock: 0 });
    expect(source.kind).toBe("rpc");
    expect(deriveTrustedRecipients(events)).toHaveLength(2);
  });

  it("falls back when the indexer stops earlier than requested", async () => {
    const { source } = await indexerThenRpc(lagging(0, 60), full).fetch(OWNER, { fromBlock: 0, toBlock: 100 });
    expect(source.kind).toBe("rpc");
  });

  it("accepts the indexer when it covers the whole requested range", async () => {
    const { source } = await indexerThenRpc(lagging(0, 100), full).fetch(OWNER, { fromBlock: 0, toBlock: 100 });
    expect(source.kind).toBe("indexer");
  });

  it("names the shortfall in the error when both sources are unusable", async () => {
    const broken: HistorySource = {
      fetch: async () => {
        throw new Error("rpc down");
      },
    };
    await expect(indexerThenRpc(lagging(40, 100), broken).fetch(OWNER, { fromBlock: 0 })).rejects.toMatchObject({
      code: "E_NO_SOURCE",
    });
  });
});

describe("an unverifiable indexer answer is refused, which is the CLI default path", () => {
  /**
   * The CLI passes no range unless --from-block is given, so a coverage check that ran only when
   * a range was passed would accept, by default, a lagging index holding one recent dust
   * transfer — leaving the trusted set empty and reporting the look-alike as "new".
   */
  it("refuses an indexer answer when no range can be measured", async () => {
    const { source } = await indexerThenRpc(indexer(0, 1_000, [genuineSend()]), rpcSource).fetch(OWNER);
    expect(source.kind).toBe("rpc");
  });

  it("refuses an index that claims the range but returns nothing", async () => {
    const { source } = await indexerThenRpc(indexer(0, 100, []), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 100 });
    expect(source.kind).toBe("rpc");
  });

  /**
   * A source's fromBlock/toBlock describe the range it was queried for, so comparing them with
   * the query always passes. Coverage must be stated independently.
   */
  it("refuses an answer that states no coverage, however many events it carries", async () => {
    const { source } = await indexerThenRpc(indexerWithoutCoverage([genuineSend()]), rpcSource).fetch(OWNER, {
      fromBlock: 0,
      toBlock: 100,
    });
    expect(source.kind).toBe("rpc");
  });

  it("accepts an index that covers the range and has events", async () => {
    const { source } = await indexerThenRpc(indexer(0, 100, [genuineSend()]), rpcSource).fetch(OWNER, {
      fromBlock: 0,
      toBlock: 100,
    });
    expect(source.kind).toBe("indexer");
  });
});

describe("both requested bounds reach the coverage check", () => {
  /**
   * --to-block must reach the fetch range, not only each source's configuration, or an index
   * stopping before the requested end block could not be detected.
   */
  it("falls back when the index stops before --to-block", async () => {
    const { source } = await indexerThenRpc(indexer(0, 60, [genuineSend()]), rpcSource).fetch(OWNER, {
      fromBlock: 0,
      toBlock: 100,
    });
    expect(source.kind).toBe("rpc");
  });

  it("falls back when the index starts after --from-block, and says so when RPC fails too", async () => {
    const late = indexer(50, 200, [genuineSend()]);
    const { source } = await indexerThenRpc(late, rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("rpc");

    const down: HistorySource = {
      fetch: async () => {
        throw new Error("rpc down");
      },
    };
    const failure = await indexerThenRpc(late, down).fetch(OWNER, { fromBlock: 0, toBlock: 200 }).catch((error: unknown) => error);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toContain("indexed only from block 50, and 0 was requested");
  });

  it("rejects --indexer outright, since no JSON-RPC endpoint can prove coverage", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", IMITATOR, "--owner", OWNER, "--rpc", "https://rpc.example", "--token", TOKEN, "--indexer", "https://indexer.example",
       "--from-block", "0", "--to-block", "500"],
      context,
    );
    expect(code).toBe(EXIT.USAGE);
  });
});

describe("coverage must be stated independently, not echoed from the query", () => {
  /**
   * rpcLogSource fills SourceInfo.fromBlock/toBlock from the requested bounds. Comparing those
   * against the request is a tautology, so a completeness check built on them would pass
   * unconditionally for any such source labelled "indexer".
   */
  it("rpcLogSource never claims coverage", async () => {
    const chain = fakeChain({ head: 200, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }] });
    const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("rpc");
    expect(source.coverage).toBeUndefined();
    // The echoed query range is still reported, for provenance -- it is just not a coverage claim.
    expect(source).toMatchObject({ fromBlock: 0, toBlock: 200 });
  });

  it("refuses an rpcLogSource standing in as the indexer, even with events", async () => {
    const indexerChain = fakeChain({
      head: 200,
      // Has the recent dust, missing the older genuine send: exactly the dangerous index.
      transfers: [{ blockNumber: 100, from: IMITATOR, to: OWNER, valueRaw: 1n, txFrom: IMITATOR }],
    });
    const rpcChain = fakeChain({
      head: 200,
      transfers: [
        { blockNumber: 50, from: OWNER, to: GENUINE, valueRaw: 1_000n },
        { blockNumber: 100, from: IMITATOR, to: OWNER, valueRaw: 1n, txFrom: IMITATOR },
      ],
    });
    const asIndexer = rpcLogSource(createRpc({ urls: "https://i.example", fetch: indexerChain.fetch }), {
      tokens: [TOKEN],
    });
    const asRpc = rpcLogSource(createRpc({ urls: "https://r.example", fetch: rpcChain.fetch }), { tokens: [TOKEN] });

    const { events, source } = await indexerThenRpc(asIndexer, asRpc).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    // Falls through to RPC, so the genuine send is present and the imitator is catchable.
    expect(source.kind).toBe("rpc");
    expect(events.some((e) => e.direction === "out" && e.counterparty === GENUINE)).toBe(true);
  });

  it("the CLI has no --indexer flag to wire such a source through", async () => {
    const context = io();
    expect(
      await runAddressGuard(
        ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--indexer", "https://i.example"],
        context,
      ),
    ).toBe(EXIT.USAGE);
  });

  it("still prefers a source that does state sufficient coverage", async () => {
    const withCoverage: HistorySource = {
      fetch: async (_owner, range): Promise<History> => ({
        events: [genuineSend()],
        source: {
          kind: "indexer",
          endpoint: "https://i.example",
          endpoints: ["https://i.example"],
          fromBlock: range?.fromBlock ?? 0,
          toBlock: range?.toBlock ?? 0,
          coverage: { fromBlock: 0, toBlock: 200 },
        },
      }),
    };
    const rpcOnly: HistorySource = {
      fetch: async (): Promise<History> => ({
        events: [],
        source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 200 },
      }),
    };
    const { source } = await indexerThenRpc(withCoverage, rpcOnly).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("indexer");
  });
});

describe("an unbounded range cannot establish coverage", () => {
  const covering = (toBlock: number): HistorySource => ({
    fetch: async (_owner, range): Promise<History> => ({
      events: [genuineSend()],
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        fromBlock: range?.fromBlock ?? 0,
        toBlock: range?.toBlock ?? 0,
        coverage: { fromBlock: 0, toBlock },
      },
    }),
  });
  const rpcSource: HistorySource = {
    fetch: async (): Promise<History> => ({
      events: [genuineSend(), { ...genuineSend(GENUINE), blockNumber: 150n }],
      source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 200 },
    }),
  };

  /**
   * Both bounds must be given. With only { fromBlock: 0 }, an index covering 0-100 would look
   * complete while hiding a genuine send at 150.
   */
  it("refuses an indexer when the range has no end block", async () => {
    const { source } = await indexerThenRpc(covering(100), rpcSource).fetch(OWNER, { fromBlock: 0 });
    expect(source.kind).toBe("rpc");
  });

  it("still refuses when the end block exceeds what the index covers", async () => {
    const { source } = await indexerThenRpc(covering(100), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("rpc");
  });

  it("accepts it once both bounds are covered", async () => {
    const { source } = await indexerThenRpc(covering(200), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("indexer");
  });
});

describe("the answer's own range must span the request", () => {
  /**
   * Coverage says what a source has indexed; fromBlock/toBlock say what this answer read. A
   * source may have indexed 0-200 and still clamp one fetch to 101-200, returning a recent
   * poison transfer while omitting a genuine send at block 50.
   */
  const clamping = (fetchedFrom: number): HistorySource => ({
    fetch: async (_owner, range): Promise<History> => ({
      events: [genuineSend()],
      source: {
        kind: "indexer",
        endpoint: "https://i.example",
        endpoints: ["https://i.example"],
        fromBlock: fetchedFrom,
        toBlock: range?.toBlock ?? 200,
        coverage: { fromBlock: 0, toBlock: 200 },
      },
    }),
  });
  const rpcSource: HistorySource = {
    fetch: async (): Promise<History> => ({
      events: [genuineSend()],
      source: { kind: "rpc", endpoint: "https://r.example", endpoints: ["https://r.example"], fromBlock: 0, toBlock: 200 },
    }),
  };

  it("falls back when the answer was clamped, despite full coverage", async () => {
    const { source } = await indexerThenRpc(clamping(101), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("rpc");
  });

  it("accepts it when the answer spans the request", async () => {
    const { source } = await indexerThenRpc(clamping(0), rpcSource).fetch(OWNER, { fromBlock: 0, toBlock: 200 });
    expect(source.kind).toBe("indexer");
  });
});

describe("indexerThenRpc takes no dead option", () => {
  it("accepts exactly two arguments", async () => {
    const { indexerThenRpc } = await import("../src/sources.js");
    expect(indexerThenRpc.length).toBe(2);
  });

  it("no longer exports the discarded options type", async () => {
    const module = (await import("../src/index.js")) as Record<string, unknown>;
    expect("IndexerThenRpcOptions" in module).toBe(false);
  });
});
