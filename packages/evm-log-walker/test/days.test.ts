import { describe, expect, it } from "vitest";
import { createBlockTimestampCache, groupByUtcDay, utcDay } from "../src/days.js";
import { createRpc } from "../src/rpc.js";
import { collectLogs } from "../src/walk.js";
import { createFakeChain } from "./fake-chain.js";

// One block per hour from 2023-11-14 22:13:20 UTC: blocks 0 and 1 fall on the 14th, block 3 on the 15th.
const HOURLY = { blockTime: 3_600, genesisTimestamp: 1_700_000_000 };

describe("utcDay", () => {
  it("formats the UTC calendar day", () => {
    expect(utcDay(0)).toBe("1970-01-01");
    expect(utcDay(1_700_000_000)).toBe("2023-11-14");
    expect(utcDay(1_700_000_000 + 3 * 3_600)).toBe("2023-11-15");
  });
});

describe("groupByUtcDay", () => {
  it("fetches only two timestamps when every log falls on one day", async () => {
    const chain = createFakeChain({ ...HOURLY, head: 10, logs: [{ blockNumber: 0 }, { blockNumber: 1 }] });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });
    const { logs } = await collectLogs({ rpc, fromBlock: 0, toBlock: "latest" });
    const cache = createBlockTimestampCache(rpc);

    const grouped = await groupByUtcDay(logs, cache);

    expect([...grouped.keys()]).toEqual(["2023-11-14"]);
    expect(grouped.get("2023-11-14")).toHaveLength(2);
    expect(chain.callsFor("eth_getBlockByNumber").filter((call) => call.params[0] !== "latest")).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  it("resolves each block once when the logs straddle a day boundary", async () => {
    const chain = createFakeChain({ ...HOURLY, head: 10, logs: [{ blockNumber: 0 }, { blockNumber: 1 }, { blockNumber: 3 }] });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });
    const { logs } = await collectLogs({ rpc, fromBlock: 0, toBlock: "latest" });
    const cache = createBlockTimestampCache(rpc);

    const grouped = await groupByUtcDay(logs, cache);

    expect([...grouped.keys()]).toEqual(["2023-11-14", "2023-11-15"]);
    expect(grouped.get("2023-11-14")?.map((log) => log.blockNumber)).toEqual([0, 1]);
    expect(grouped.get("2023-11-15")?.map((log) => log.blockNumber)).toEqual([3]);
    // Blocks 0 and 3 were fetched for the bounds; only block 1 is new in the second pass.
    expect(chain.callsFor("eth_getBlockByNumber").filter((call) => call.params[0] !== "latest")).toHaveLength(3);
  });

  it("returns an empty map for no logs without calling the endpoint", async () => {
    const chain = createFakeChain();
    const cache = createBlockTimestampCache(createRpc({ urls: "http://a", fetch: chain.fetch }));

    expect(await groupByUtcDay([], cache)).toEqual(new Map());
    expect(chain.calls).toHaveLength(0);
  });

  it("does not remember a failed lookup", async () => {
    const chain = createFakeChain({ head: 10 });
    const cache = createBlockTimestampCache(createRpc({ urls: "http://a", fetch: chain.fetch }));

    await expect(cache.timestamp(11)).rejects.toMatchObject({ code: "E_RPC", message: expect.stringContaining("no block") });
    expect(cache.size).toBe(0);
  });

  it("resolves the blocks of a boundary-straddling batch several at a time, each once", async () => {
    const blocks = Array.from({ length: 40 }, (_, index) => index);
    const chain = createFakeChain({ ...HOURLY, head: 50, logs: blocks.map((blockNumber) => ({ blockNumber })) });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });
    const { logs } = await collectLogs({ rpc, fromBlock: 0, toBlock: "latest" });
    let inFlight = 0;
    let peak = 0;
    const cache = createBlockTimestampCache({
      urls: rpc.urls,
      async call(method, params) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return await rpc.call(method, params);
        } finally {
          inFlight--;
        }
      },
    });

    const grouped = await groupByUtcDay(logs, cache);

    expect([...grouped.values()].flat()).toHaveLength(40);
    expect(cache.size).toBe(40);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("stops issuing lookups once one has failed", async () => {
    const blocks = Array.from({ length: 40 }, (_, index) => index);
    const chain = createFakeChain({ ...HOURLY, head: 50, logs: blocks.map((blockNumber) => ({ blockNumber })) });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });
    const { logs } = await collectLogs({ rpc, fromBlock: 0, toBlock: "latest" });
    let lookups = 0;
    const cache = createBlockTimestampCache({
      urls: rpc.urls,
      async call(method, params) {
        const mine = ++lookups;
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (mine === 5) throw new Error("gone away");
        return rpc.call(method, params);
      },
    });

    await expect(groupByUtcDay(logs, cache)).rejects.toThrow("gone away");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lookups).toBeLessThan(20);
  });
});
