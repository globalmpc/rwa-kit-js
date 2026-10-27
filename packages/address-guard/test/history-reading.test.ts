/**
 * Reading history over RPC: bounded memory, progress reporting and argument validation for the
 * walk and its concurrent lookups.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { forEachConcurrently } from "../src/concurrency.js";
import { GuardError } from "../src/errors.js";
import { rpcLogSource } from "../src/sources.js";
import { fakeChain, GENUINE, OWNER, TOKEN } from "./fake-chain.js";



describe("a history larger than the cap fails with a message, not an OOM", () => {
  it("names the fix when too many transfers match", async () => {
    const transfers = Array.from({ length: 30 }, (_, i) => ({
      blockNumber: i + 1,
      from: OWNER,
      to: GENUINE,
      valueRaw: 1n,
    }));
    const rpc = createRpc({ urls: "https://r.example", fetch: fakeChain({ head: 100, transfers }).fetch });
    await expect(rpcLogSource(rpc, { tokens: [TOKEN], maxEvents: 10 }).fetch(OWNER)).rejects.toMatchObject({
      code: "E_TOO_MANY_EVENTS",
    });
  });

  it("stays within the cap for an ordinary history", async () => {
    const rpc = createRpc({
      urls: "https://r.example",
      fetch: fakeChain({ head: 100, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }] }).fetch,
    });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN], maxEvents: 10 }).fetch(OWNER);
    expect(events).toHaveLength(1);
  });
});

describe("a checkpoint says which walk it belongs to", () => {
  it("labels the outgoing and incoming phases", async () => {
    const seen: { phase: string; nextBlock: number }[] = [];
    const chain = fakeChain({ head: 300, transfers: [] });
    const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
    await rpcLogSource(rpc, {
      tokens: [TOKEN],
      chunkSize: 100,
      onCheckpoint: (checkpoint) => void seen.push({ phase: checkpoint.phase, nextBlock: checkpoint.nextBlock }),
    }).fetch(OWNER, { fromBlock: 0 });
    expect(new Set(seen.map((entry) => entry.phase))).toEqual(new Set(["outgoing", "incoming"]));
    // Each phase restarts from the same first block, which is why an unlabelled counter was
    // impossible to interpret.
    expect(seen.filter((e) => e.phase === "outgoing").length).toBeGreaterThan(1);
    expect(seen.filter((e) => e.phase === "incoming").length).toBeGreaterThan(1);
  });
});

describe("a non-positive concurrency limit is refused", () => {
  it("does not resolve without running the task", async () => {
    let ran = 0;
    for (const limit of [0, -1, 1.5]) {
      await expect(forEachConcurrently([1], limit, async () => void ran++)).rejects.toThrow(GuardError);
    }
    expect(ran).toBe(0);
  });

  it("still runs with a valid limit", async () => {
    let ran = 0;
    await forEachConcurrently([1, 2, 3], 2, async () => void ran++);
    expect(ran).toBe(3);
  });
});

describe("an unusable maxEvents is refused", () => {
  const rpc = () => createRpc({ urls: "https://r.example", fetch: fakeChain({ head: 100, transfers: [] }).fetch });

  it("rejects Infinity and NaN, which would disable the cap", async () => {
    for (const maxEvents of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1.5]) {
      await expect(rpcLogSource(rpc(), { tokens: [TOKEN], maxEvents }).fetch(OWNER)).rejects.toThrow(GuardError);
    }
  });

  it("accepts a positive safe integer", async () => {
    await expect(rpcLogSource(rpc(), { tokens: [TOKEN], maxEvents: 10 }).fetch(OWNER)).resolves.toBeDefined();
  });
});
