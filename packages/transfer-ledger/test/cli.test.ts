import { describe, expect, it } from "vitest";
import { ENDPOINT_VARIABLE, EXIT, runTransferLedger, USAGE } from "../src/cli/transfer-ledger.js";
import { serializeTransfers } from "../src/report.js";
import { address, createFakeChain, hash, PAYER, TOKEN } from "./fake-chain.js";

const INTENT = `recipient,amount\n${address(1)},1.5\n${address(2)},2\n`;

function scenario(extra: { to: `0x${string}`; amount: bigint }[] = []) {
  return createFakeChain([
    { hash: hash(1), blockNumber: 100, logs: [{ to: address(1), amount: 1_500_000n }, { to: address(2), amount: 2_000_000n }, ...extra] },
  ]);
}

function io(fetchImpl: typeof globalThis.fetch, files: Record<string, string> = { "payouts.csv": INTENT }, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  return {
    out,
    err,
    written,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      fetch: fetchImpl,
      env,
      now: () => Date.parse("2026-10-04T00:00:00Z"),
      readFile: async (path: string) => {
        const text = files[path] ?? written.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      writeFile: async (path: string, data: string) => {
        written.set(path, data);
      },
    },
  };
}

const ONLINE = ["--intent", "payouts.csv", "--decimals", "6", "--token", TOKEN, "--payer", PAYER, "--tx", hash(1), "--rpc", "http://a"];

describe("transfer-ledger CLI", () => {
  it("exits 0 and says clean when the round matches the list", async () => {
    const { out, err, io: streams } = io(scenario().fetch);
    expect(await runTransferLedger(ONLINE, streams)).toBe(EXIT.CLEAN);
    expect(err).toEqual([]);
    expect(out.find((line) => line.startsWith("result"))).toContain("clean");
    expect(out).toContain("paid         2 transfer(s), total 3.5");
  });

  it("exits 3 and lists each finding when the round is not clean", async () => {
    const { out, io: streams } = io(scenario([{ to: address(2), amount: 2_000_000n }]).fetch);
    expect(await runTransferLedger(ONLINE, streams)).toBe(EXIT.NOT_CLEAN);
    expect(out.find((line) => line.startsWith("result"))).toBe("result       NOT CLEAN: 1 duplicate");
    expect(out.at(-1)).toBe(
      `duplicate   ${address(2)} 2 (intent line 3): paid again by ${hash(1)}#2, already paid by ${hash(1)}#1`,
    );
  });

  it("prints the report as JSON with --json, with the endpoint by origin only", async () => {
    const { out, io: streams } = io(scenario().fetch);
    const code = await runTransferLedger([...ONLINE.slice(0, -1), "https://rpc.example/v1/SECRETKEY", "--json"], streams);
    expect(code).toBe(EXIT.CLEAN);
    expect(out[0]).not.toContain("SECRETKEY");
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ package: "@globalmpc/transfer-ledger", source: "https://rpc.example", chainId: 56, clean: true });
  });

  it("saves the transfers, then re-checks them offline with --transfers and no endpoint", async () => {
    const online = io(scenario().fetch);
    await runTransferLedger([...ONLINE, "--save-transfers", "round.json"], online.io);
    const saved = online.written.get("round.json") as string;

    const calls: string[] = [];
    const offline = io(async () => {
      calls.push("network");
      throw new Error("offline");
    }, { "payouts.csv": INTENT, "round.json": saved });
    expect(await runTransferLedger(["--intent", "payouts.csv", "--decimals", "6", "--transfers", "round.json"], offline.io)).toBe(EXIT.CLEAN);
    expect(calls).toEqual([]);
  });

  it("re-checks a pull-in multisend offline exactly as it checked it live", async () => {
    const CONTRACT = address(0x5e5e);
    const chain = createFakeChain([
      {
        hash: hash(1),
        blockNumber: 100,
        logs: [
          { from: PAYER, to: CONTRACT, amount: 3_500_000n },
          { from: CONTRACT, to: address(1), amount: 1_500_000n },
          { from: CONTRACT, to: address(2), amount: 2_000_000n },
        ],
      },
    ]);
    const argv = ["--intent", "payouts.csv", "--decimals", "6", "--token", TOKEN, "--payer", PAYER, "--payer", CONTRACT, "--tx", hash(1), "--rpc", "http://a"];
    const online = io(chain.fetch);
    expect(await runTransferLedger([...argv, "--save-transfers", "round.json"], online.io)).toBe(EXIT.CLEAN);
    const saved = online.written.get("round.json") as string;
    expect(JSON.parse(saved).transfers).toHaveLength(3);

    // With the payers from the file, and with them given again: both clean.
    for (const extra of [[], ["--payer", PAYER, "--payer", CONTRACT]]) {
      const offline = io(chain.fetch, { "payouts.csv": INTENT, "round.json": saved });
      expect(await runTransferLedger(["--intent", "payouts.csv", "--decimals", "6", "--transfers", "round.json", ...extra], offline.io)).toBe(EXIT.CLEAN);
    }
  });

  it("refuses a --token that differs from the transfers file's token", async () => {
    const files = { "payouts.csv": INTENT, "round.json": serializeTransfers(TOKEN, [], "x") };
    const { err, io: streams } = io(scenario().fetch, files);
    const code = await runTransferLedger(["--intent", "payouts.csv", "--decimals", "6", "--transfers", "round.json", "--token", address(5)], streams);
    expect(code).toBe(EXIT.FAILED);
    expect(err[0]).toMatch(/does not match the transfers file's token/);
  });

  it(`reads endpoints from ${ENDPOINT_VARIABLE} when --rpc is absent`, async () => {
    const { io: streams } = io(scenario().fetch, { "payouts.csv": INTENT }, { [ENDPOINT_VARIABLE]: "http://a" });
    expect(await runTransferLedger(ONLINE.slice(0, -2), streams)).toBe(EXIT.CLEAN);
  });

  it("reads a whole range for a payer with --from", async () => {
    const { io: streams } = io(scenario().fetch);
    const argv = ["--intent", "payouts.csv", "--decimals", "6", "--token", TOKEN, "--payer", PAYER, "--from", "0", "--to", "200", "--rpc", "http://a"];
    expect(await runTransferLedger(argv, streams)).toBe(EXIT.CLEAN);
  });

  it("exits 2, naming the line, when the intent file is malformed", async () => {
    const { err, io: streams } = io(scenario().fetch, { "payouts.csv": `recipient,amount\n${address(1)},1.1234567\n` });
    expect(await runTransferLedger(ONLINE, streams)).toBe(EXIT.FAILED);
    expect(err[0]).toBe("E_INTENT_FORMAT: line 2: amount 1.1234567 has more than 6 decimal places");
  });

  it("exits 1 with usage on a missing or conflicting option", async () => {
    const cases = [
      ["--decimals", "6", "--transfers", "x"],
      ["--intent", "payouts.csv", "--transfers", "x"],
      ["--intent", "payouts.csv", "--decimals", "6"],
      ["--intent", "payouts.csv", "--decimals", "6", "--transfers", "x", "--tx", hash(1)],
      ["--intent", "payouts.csv", "--decimals", "6", "--token", TOKEN, "--from", "0", "--rpc", "http://a"],
      ["--intent", "payouts.csv", "--decimals", "6", "--token", TOKEN, "--tx", hash(1)],
      ["--intent", "payouts.csv", "--decimals", "6", "--token", TOKEN, "--tx", "0x12", "--rpc", "http://a"],
      ["--intent", "payouts.csv", "--decimals", "6.5", "--transfers", "x"],
    ];
    for (const argv of cases) {
      const { err, io: streams } = io(scenario().fetch);
      expect(await runTransferLedger(argv, streams)).toBe(EXIT.USAGE);
      expect(err.at(-1)).toBe(USAGE);
    }
  });

  it("prints usage and exits 0 with --help", async () => {
    const { out, io: streams } = io(scenario().fetch);
    expect(await runTransferLedger(["--help"], streams)).toBe(EXIT.CLEAN);
    expect(out).toEqual([USAGE]);
  });
});
