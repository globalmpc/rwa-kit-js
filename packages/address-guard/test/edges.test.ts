import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import { GuardError } from "../src/errors.js";
import { hexToBigInt, isTransactionHash, topicToAddress, type Address, type Hex } from "../src/hex.js";
import { parsePayoutCsv } from "../src/payouts.js";
import { rpcLogSource } from "../src/sources.js";
import { decodeTransferLog, TRANSFER_TOPIC } from "../src/transfer-log.js";
import { fakeChain, GENUINE, OWNER, TOKEN } from "./fake-chain.js";
import { mockSource, poisonedHistory } from "./fixtures.js";

/** Reaches the guards the main suites do not: malformed input, empty ranges, argument parsing. */

describe("hex helpers", () => {
  it("recognises a 32-byte transaction hash", () => {
    expect(isTransactionHash(`0x${"ab".repeat(32)}`)).toBe(true);
    expect(isTransactionHash(`0x${"ab".repeat(31)}`)).toBe(false);
    expect(isTransactionHash(undefined)).toBe(false);
  });

  it("unpacks an address from an indexed topic", () => {
    expect(topicToAddress(`0x${GENUINE.slice(2).padStart(64, "0")}` as Hex)).toBe(GENUINE);
  });

  it("rejects a non-quantity", () => {
    expect(() => hexToBigInt("nope", "value")).toThrow(GuardError);
    expect(() => hexToBigInt(undefined, "value")).toThrow(GuardError);
    expect(hexToBigInt("0x10", "value")).toBe(16n);
  });
});

describe("decodeTransferLog", () => {
  const log = {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`] as Hex[],
    data: "0x1" as Hex,
    blockNumber: 1,
    blockHash: "0x" as Hex,
    transactionHash: `0x${"ab".repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };

  it("rejects a log that is not an ERC-20 Transfer", () => {
    expect(() => decodeTransferLog({ ...log, topics: [TRANSFER_TOPIC] })).toThrow(/not an ERC-20 Transfer/);
  });

  it("rejects a malformed contract address", () => {
    expect(() => decodeTransferLog({ ...log, address: "0xnope" as Address })).toThrow(/malformed contract address/);
  });
});

describe("rpcLogSource edges", () => {
  const rpcFor = (options: Parameters<typeof fakeChain>[0]) =>
    createRpc({ urls: "https://rpc.example", fetch: fakeChain(options).fetch, retries: 0 });

  it("rejects a negative fromBlock", async () => {
    const source = rpcLogSource(rpcFor({ head: 10, transfers: [] }), { tokens: [TOKEN] });
    await expect(source.fetch(OWNER, { fromBlock: -1 })).rejects.toThrow(GuardError);
    await expect(source.fetch(OWNER, { fromBlock: 1.5 })).rejects.toThrow(GuardError);
  });

  it("returns nothing, with a source, when the range is empty", async () => {
    const source = rpcLogSource(rpcFor({ head: 10, transfers: [] }), { tokens: [TOKEN] });
    const { events, source: info } = await source.fetch(OWNER, { fromBlock: 50 });
    expect(events).toEqual([]);
    expect(info).toMatchObject({ fromBlock: 50, toBlock: 10 });
  });

  it("fails when a transaction has no usable from", async () => {
    const rpc = rpcFor({
      head: 50,
      transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1n }],
      malformedTransactions: true,
    });
    await expect(rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER)).rejects.toThrow(/no usable from/);
  });

  it("refuses to read without a token filter", () => {
    const rpc = rpcFor({ head: 50, transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 9n }] });
    // @ts-expect-error tokens is required: an unfiltered read cannot establish trust.
    expect(() => rpcLogSource(rpc)).toThrow(/tokens is required/);
    expect(() => rpcLogSource(rpc, { tokens: [] })).toThrow(/tokens is required/);
  });
});

describe("parsePayoutCsv", () => {
  it("skips blanks, comments and a header row", () => {
    const rows = parsePayoutCsv(`# a note\n\naddress,amount\n${GENUINE},5\n`);
    expect(rows).toEqual([{ line: 4, raw: GENUINE, recipient: GENUINE, rest: "5" }]);
  });

  it("keeps a malformed row rather than failing the file", () => {
    const rows = parsePayoutCsv(`nonsense\n${GENUINE}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.recipient).toBeUndefined();
  });

  it("does not mistake an address in the first row for a header", () => {
    expect(parsePayoutCsv(`${GENUINE}\n`)[0]?.recipient).toBe(GENUINE);
  });

  it("refuses a file with no rows", () => {
    expect(() => parsePayoutCsv("\n# nothing\n")).toThrow(GuardError);
  });
});

describe("CLI argument handling", () => {
  const io = (): CliIo & { out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l), env: {}, source: () => mockSource(poisonedHistory) };
  };

  it("rejects a non-numeric --from-block", async () => {
    const context = io();
    expect(await runAddressGuard(["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--from-block", "soon"], context)).toBe(EXIT.USAGE);
    expect(context.err.join(" ")).toContain("--from-block");
  });

  it("rejects a non-numeric --min-value", async () => {
    const context = io();
    expect(await runAddressGuard(["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--min-value", "lots"], context)).toBe(EXIT.USAGE);
  });

  it("accepts --token and both block bounds together", async () => {
    const context = io();
    const code = await runAddressGuard(
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN,
       "--token", TOKEN, "--from-block", "1", "--to-block", "500", "--suffix", "4"],
      context,
    );
    expect(code).toBe(EXIT.TRUSTED);
  });

  it("rejects a malformed --token", async () => {
    const context = io();
    expect(await runAddressGuard(["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example", "--token", TOKEN, "--token", "0xnope"], context)).toBe(EXIT.USAGE);
  });

  it("reports an invalid address as JSON when asked", async () => {
    const context = io();
    const code = await runAddressGuard(["checksum", "0xnope", "--json"], context);
    expect(code).toBe(EXIT.INVALID);
    expect(JSON.parse(context.out.join("\n"))).toMatchObject({ verdict: "invalid", valid: false, source: null });
  });
});
