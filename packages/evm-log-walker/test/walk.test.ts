import { describe, expect, it } from "vitest";
import { RpcError } from "../src/errors.js";
import { createRpc } from "../src/rpc.js";
import { collectLogs, walkLogs, type Checkpoint, type Log } from "../src/walk.js";
import { createFakeChain, DEFAULT_ADDRESS, OTHER_ADDRESS, OTHER_TOPIC, TRANSFER_TOPIC } from "./fake-chain.js";

const MATCHING_BLOCKS = [10, 4_999, 5_000, 12_345, 20_000];

function chainWithLogs(options: Parameters<typeof createFakeChain>[0] = {}) {
  return createFakeChain({
    head: 21_000,
    logs: [
      ...MATCHING_BLOCKS.map((blockNumber) => ({ blockNumber })),
      { blockNumber: 100, address: OTHER_ADDRESS },
      { blockNumber: 200, topics: [OTHER_TOPIC] },
    ],
    ...options,
  });
}

const identity = (log: Log) => `${log.transactionHash}:${log.logIndex}`;

describe("walkLogs", () => {
  it("walks the range in chunks, filters by address and topic, and decodes quantities", async () => {
    const chain = chainWithLogs();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const { logs, summary } = await collectLogs({ rpc, address: DEFAULT_ADDRESS, topics: [TRANSFER_TOPIC], fromBlock: 0 });

    expect(logs.map((log) => log.blockNumber)).toEqual(MATCHING_BLOCKS);
    expect(logs[0]).toMatchObject({ address: DEFAULT_ADDRESS, topics: [TRANSFER_TOPIC], logIndex: 0, transactionIndex: 0, removed: false });
    expect(summary).toEqual({
      fromBlock: 0,
      toBlock: chain.finalized,
      batches: 5,
      logs: 5,
      calls: 5,
      rejectedCalls: 0,
      finalChunkSize: 5_000,
    });
  });

  it("shrinks the chunk when the endpoint caps the block span, then grows it back", async () => {
    const chain = chainWithLogs({ maxLogSpan: 1_000 });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const { logs, summary } = await collectLogs({ rpc, address: DEFAULT_ADDRESS, topics: [TRANSFER_TOPIC], fromBlock: 0 });

    expect(logs.map((log) => log.blockNumber)).toEqual(MATCHING_BLOCKS);
    expect(new Set(logs.map(identity)).size).toBe(logs.length);
    // 5 000, 2 500 and 1 250 refused before 625 is accepted; later regrowth to 1 250 is refused again.
    expect(summary.rejectedCalls).toBeGreaterThanOrEqual(3);
    expect(summary.finalChunkSize).toBeLessThanOrEqual(1_000);
    expect(summary.calls).toBe(summary.batches + summary.rejectedCalls);
  });

  it("shrinks the chunk when the endpoint caps the result count", async () => {
    const chain = createFakeChain({ head: 200, logs: [1, 2, 3, 4, 5].map((blockNumber) => ({ blockNumber })), maxLogResults: 2 });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const { logs, summary } = await collectLogs({ rpc, fromBlock: 0, toBlock: "latest" });

    expect(logs.map((log) => log.blockNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(summary.rejectedCalls).toBeGreaterThan(0);
  });

  it("shrinks the chunk when the endpoint refuses a span with an HTTP 403", async () => {
    const chain = chainWithLogs({ maxLogSpan: 50_000, httpRefusal: { aboveSpan: 2_000, status: 403 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const { logs, summary } = await collectLogs({ rpc, address: DEFAULT_ADDRESS, topics: [TRANSFER_TOPIC], fromBlock: 0 });

    expect(logs.map((log) => log.blockNumber)).toEqual(MATCHING_BLOCKS);
    expect(summary.rejectedCalls).toBeGreaterThan(0);
    expect(summary.finalChunkSize).toBeLessThanOrEqual(2_000);
  });

  it("halves on a key-worded 403 only when the wording also names the span", async () => {
    const chain = chainWithLogs({ maxLogSpan: 50_000, httpRefusal: { aboveSpan: 2_000, status: 403, body: "Unauthorized: this block range requires an API key" } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const { logs, summary } = await collectLogs({ rpc, address: DEFAULT_ADDRESS, topics: [TRANSFER_TOPIC], fromBlock: 0 });

    expect(logs.map((log) => log.blockNumber)).toEqual(MATCHING_BLOCKS);
    expect(summary.finalChunkSize).toBeLessThanOrEqual(2_000);
  });

  it("never halves on a rate limit, or on a key problem that says nothing about the span", async () => {
    const wordings = [
      { logsFailure: { code: -32000, message: "daily request count exceeded, request rate limited" } },
      { logsFailure: { code: -32005, message: "rate limit exceeded" } },
      { logsFailure: { code: -32005, message: "project ID request rate exceeded" } },
      { maxLogSpan: 50_000, httpRefusal: { aboveSpan: 0, status: 403, body: "unauthorized: invalid api key" } },
      { maxLogSpan: 50_000, httpRefusal: { aboveSpan: 0, status: 403, body: "too many requests" } },
    ];
    for (const options of wordings) {
      const chain = chainWithLogs(options);
      const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

      const failure = await collectLogs({ rpc, address: DEFAULT_ADDRESS, fromBlock: 0 }).then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(RpcError);
      expect(chain.callsFor("eth_getLogs")).toHaveLength(1);
    }
  });

  it("matches the endpoint's own words, not the endpoint's name, when deciding to halve", async () => {
    const chain = chainWithLogs({ logsFailure: { code: -32601, message: "the method eth_getLogs does not exist" } });
    const rpc = createRpc({ urls: "https://too-large.example", fetch: chain.fetch });

    await expect(collectLogs({ rpc, fromBlock: 0 })).rejects.toBeInstanceOf(RpcError);
    expect(chain.callsFor("eth_getLogs")).toHaveLength(1);
  });

  it("reports a log with a malformed hash or quantity as E_RPC", async () => {
    const good = {
      address: DEFAULT_ADDRESS,
      topics: [TRANSFER_TOPIC],
      data: "0x",
      blockNumber: "0xa",
      blockHash: `0x${"1".repeat(64)}`,
      transactionHash: `0x${"2".repeat(64)}`,
      transactionIndex: "0x0",
      logIndex: "0x0",
    };
    const elements: unknown[] = [{ ...good, transactionHash: null }, { ...good, blockHash: "0x12" }, { ...good, logIndex: "latest" }, null, 1];
    for (const element of elements) {
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
        const result = method === "eth_getLogs" ? [element] : { number: "0x64" };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
      };
      const rpc = createRpc({ urls: "http://a", fetch: fetchImpl });

      await expect(collectLogs({ rpc, fromBlock: 0, toBlock: 100 })).rejects.toMatchObject({ code: "E_RPC" });
    }
  });

  it("gives up with E_LOGS_UNAVAILABLE when even the smallest chunk is refused", async () => {
    const chain = chainWithLogs({ maxLogSpan: null });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(collectLogs({ rpc, fromBlock: 0 })).rejects.toMatchObject({
      code: "E_LOGS_UNAVAILABLE",
      message: expect.stringContaining("refused eth_getLogs for 1 block(s)"),
    });
    // 5 000 halves down to 1: 13 refused calls.
    expect(chain.callsFor("eth_getLogs")).toHaveLength(13);
  });

  it("checkpoints after each handled batch, and a resume from one neither repeats nor skips logs", async () => {
    const chain = chainWithLogs();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });
    const filter = { rpc, address: DEFAULT_ADDRESS, topics: [TRANSFER_TOPIC] };
    const batches: Log[][] = [];
    const checkpoints: Checkpoint[] = [];

    for await (const batch of walkLogs({ ...filter, fromBlock: 0, onCheckpoint: (cp) => void checkpoints.push(cp) })) {
      batches.push(batch.logs);
      // The checkpoint for this batch has not fired yet: it fires once the consumer asks for the next one.
      expect(checkpoints).toHaveLength(batches.length - 1);
    }
    expect(checkpoints.map((cp) => cp.nextBlock)).toEqual([5_000, 10_000, 15_000, 20_000, chain.finalized + 1]);
    expect(checkpoints.every((cp) => cp.toBlock === chain.finalized)).toBe(true);

    // Simulate a restart after the second checkpoint was stored.
    const handled = batches.slice(0, 2).flat();
    const { logs: rest } = await collectLogs({ ...filter, fromBlock: checkpoints[1]!.nextBlock });

    expect(handled.map((log) => log.blockNumber)).toEqual([10, 4_999, 5_000]);
    expect(rest.map((log) => log.blockNumber)).toEqual([12_345, 20_000]);
  });

  it("resolves toBlock from a tag once, or takes a number as is", async () => {
    const chain = chainWithLogs();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const latest = await collectLogs({ rpc, address: DEFAULT_ADDRESS, fromBlock: 0, toBlock: "latest" });
    expect(latest.summary.toBlock).toBe(21_000);

    const bounded = await collectLogs({ rpc, address: DEFAULT_ADDRESS, fromBlock: 0, toBlock: 100 });
    expect(bounded.summary.toBlock).toBe(100);
    expect(bounded.logs.map((log) => log.blockNumber)).toEqual([10]);
  });

  it("returns an empty summary when fromBlock is past toBlock", async () => {
    const chain = chainWithLogs();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const { logs, summary } = await collectLogs({ rpc, fromBlock: 500, toBlock: 100 });

    expect(logs).toEqual([]);
    expect(summary.calls).toBe(0);
  });

  it("propagates errors that are not range limits", async () => {
    const chain = chainWithLogs({ logsFailure: { code: -32601, message: "the method eth_getLogs does not exist" } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(collectLogs({ rpc, fromBlock: 0 })).rejects.toBeInstanceOf(RpcError);
    expect(chain.callsFor("eth_getLogs")).toHaveLength(1);
  });

  it("stops when the signal is aborted", async () => {
    const chain = chainWithLogs();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(collectLogs({ rpc, fromBlock: 0, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(chain.callsFor("eth_getLogs")).toHaveLength(0);
  });

  it("rejects unusable arguments before making a call", async () => {
    const chain = chainWithLogs();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(collectLogs({ rpc, fromBlock: -1 })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(collectLogs({ rpc, fromBlock: 0, chunkSize: 0 })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(collectLogs({ rpc, fromBlock: 0, chunkSize: 10, minChunkSize: 20 })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(collectLogs({ rpc, fromBlock: 0, address: "0x1234" })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(collectLogs({ rpc, fromBlock: 0, topics: ["0xabc"] })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    expect(chain.calls).toHaveLength(0);
  });
});
