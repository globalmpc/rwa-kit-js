/**
 * One test per finding from the code review on MPC-280. Each asserts the corrected behaviour and
 * fails if the original defect returns.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { toChecksum } from "../src/checksum.js";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import type { Address, Hex } from "../src/hex.js";
import type { History, HistoryEvent, HistorySource } from "../src/history.js";
import { indexerThenRpc, rpcLogSource } from "../src/sources.js";
import { deriveTrustedRecipients, isRealOutgoingSend } from "../src/trusted.js";
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

describe("F1 a payout row must never trust itself", () => {
  /**
   * `intended` is lower-cased; `row.recipient` keeps the file's casing. Comparing them directly
   * left a checksummed row's own address in its `known` set, where it matched itself exactly and
   * won the trusted verdict over the look-alike evidence. A single-row batch exited 0.
   */
  it("flags a checksummed look-alike row instead of self-trusting it", async () => {
    const context = io({ readFile: async () => `${toChecksum(IMITATOR)},5\n` });
    const code = await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    expect(code).toBe(EXIT.LOOKALIKE);
    expect(context.out.join("\n")).toContain("LOOKALIKE");
  });

  it("flags it in lower case too, so the fix is not casing-specific", async () => {
    const context = io({ readFile: async () => `${IMITATOR},5\n` });
    expect(await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.LOOKALIKE,
    );
  });

  it("still trusts a genuine recipient written in checksummed form", async () => {
    const context = io({ readFile: async () => `${toChecksum(GENUINE)},5\n` });
    expect(await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.TRUSTED,
    );
  });

  it("still catches a row imitating another row when neither is in the history", async () => {
    const pair = "0x7777000000000000000000000000000000007777" as Address;
    const copy = "0x7777111111111111111111111111111111117777" as Address;
    const context = io({ readFile: async () => `${toChecksum(pair)}\n${toChecksum(copy)}\n` });
    expect(await runAddressGuard(["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.LOOKALIKE,
    );
  });
});

describe("F2 an indexer is only preferred when it can prove its coverage", () => {
  /**
   * The original defect was that --indexer merely prepended a URL to one RPC client, which fails
   * over on transport failures alone, so an indexer answering with an empty array was accepted.
   * The flag is now gone: a plain JSON-RPC endpoint cannot state what it has indexed, and
   * rpcLogSource therefore never sets SourceInfo.coverage.
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

describe("F3 a partially indexed answer is not complete", () => {
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

describe("F4 provenance does not claim an endpoint that may not have answered", () => {
  it("lists every configured endpoint without echoing any part of the URL", async () => {
    const chain = fakeChain({ head: 100, transfers: [] });
    const rpc = createRpc({
      urls: ["https://first.example/key-one", "https://second.example/key-two"],
      fetch: chain.fetch,
    });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    // Positional by default: a host can itself be the credential on a keyed-subdomain provider.
    expect(source.endpoints).toEqual(["endpoint-1", "endpoint-2"]);
    expect(source.endpoint).toBe("endpoint-1");
    expect(JSON.stringify(source)).not.toContain("key-one");
    expect(JSON.stringify(source)).not.toContain("key-two");
    expect(JSON.stringify(source)).not.toContain("first.example");
  });

  it("always reports kind rpc, since it cannot vouch for an index", async () => {
    const chain = fakeChain({ head: 100, transfers: [] });
    const rpc = createRpc({ urls: "https://i.example", fetch: chain.fetch });
    const { source } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(source.kind).toBe("rpc");
    expect(source.coverage).toBeUndefined();
  });
});

describe("F5 isRealOutgoingSend enforces the zero-value rule itself", () => {
  const event = (valueRaw: bigint): HistoryEvent => ({
    owner: OWNER,
    counterparty: GENUINE,
    direction: "out",
    valueRaw,
    success: true,
    txFrom: OWNER,
    token: TOKEN,
    txTo: TOKEN,
    txTransferTo: GENUINE,
    txHash: `0x${"ab".repeat(32)}` as Hex,
    blockNumber: 1n,
  });

  it("rejects a zero value at any floor a caller passes", () => {
    for (const floor of [0n, -1n, 1n]) {
      expect(isRealOutgoingSend(event(0n), floor)).toBe(false);
    }
  });

  it("still accepts a non-zero value at a zero floor", () => {
    expect(isRealOutgoingSend(event(1n), 0n)).toBe(true);
  });
});

describe("F6 an invalid candidate is judged before any endpoint is contacted", () => {
  // NonNullable: `source` is optional, so CliIo["source"] includes undefined, which
  // exactOptionalPropertyTypes refuses to accept into Partial<CliIo>.
  const dead = (): NonNullable<CliIo["source"]> => () => ({
    fetch: async () => {
      throw new Error("endpoint down");
    },
  });

  it("exits 30 even when the endpoint is unavailable", async () => {
    const context = io({ source: dead() });
    const code = await runAddressGuard(["check", "0xnope", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context);
    expect(code).toBe(EXIT.INVALID);
    expect(context.out.join("\n")).toContain("INVALID");
  });

  it("reports source null in JSON, since no history was read", async () => {
    const context = io({ source: dead() });
    await runAddressGuard(["check", "0xnope", "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--json"], context);
    expect(JSON.parse(context.out.join("\n"))).toMatchObject({ verdict: "invalid", source: null, trustedCount: 0 });
  });

  it("still exits 2 for a valid candidate when the endpoint is unavailable", async () => {
    const context = io({ source: dead() });
    expect(await runAddressGuard(["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN], context)).toBe(
      EXIT.FAILED,
    );
  });
});
