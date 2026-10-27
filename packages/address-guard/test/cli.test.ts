import { describe, expect, it } from "vitest";
import { EXIT, ENDPOINT_VARIABLE, runAddressGuard, USAGE, type CliIo } from "../src/cli/address-guard.js";
import { toChecksum } from "../src/checksum.js";
import type { Address } from "../src/hex.js";
import { GENUINE, IMITATOR, mockSource, OWNER, poisonedHistory, STRANGER, TOKEN } from "./fixtures.js";

const RPC = "https://rpc.example/secret-key";

interface Run {
  code: number;
  out: string[];
  err: string[];
  json: () => unknown;
}

async function run(argv: string[], over: Partial<CliIo> = {}, dropSource = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: {},
    source: () => mockSource(poisonedHistory),
    ...over,
  };
  // exactOptionalPropertyTypes forbids `{ source: undefined }`, so the key is removed instead.
  if (dropSource) delete (io as { source?: unknown }).source;
  const code = await runAddressGuard(argv, io);
  return { code, out, err, json: () => JSON.parse(out.join("\n")) as unknown };
}

describe("usage", () => {
  it("prints help and exits 0", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(EXIT.TRUSTED);
    expect(out.join("\n")).toBe(USAGE);
  });

  it("exits 1 with no command", async () => {
    const { code, err } = await run([]);
    expect(code).toBe(EXIT.USAGE);
    expect(err.join(" ")).toContain("a command is required");
  });

  it("exits 1 for an unknown command", async () => {
    const { code, err } = await run(["frobnicate"]);
    expect(code).toBe(EXIT.USAGE);
    expect(err.join(" ")).toContain('unknown command "frobnicate"');
  });

  it("exits 1 when check has no --owner", async () => {
    const { code, err } = await run(["check", GENUINE, "--rpc", RPC, "--token", TOKEN]);
    expect(code).toBe(EXIT.USAGE);
    expect(err.join(" ")).toContain("--owner is required");
  });

  it("exits 1 when no endpoint is configured", async () => {
    const { code, err } = await run(["check", GENUINE, "--owner", OWNER], {}, true);
    expect(code).toBe(EXIT.USAGE);
    expect(err.join(" ")).toContain(ENDPOINT_VARIABLE);
  });

  it("reads endpoints from the environment when --rpc is absent", async () => {
    const { code } = await run(["check", GENUINE, "--owner", OWNER, "--token", TOKEN], {
      env: { [ENDPOINT_VARIABLE]: RPC },
    });
    expect(code).toBe(EXIT.TRUSTED);
  });

  it("rejects a malformed option value", async () => {
    const { code, err } = await run(["check", GENUINE, "--owner", "0xnope", "--rpc", RPC, "--token", TOKEN]);
    expect(code).toBe(EXIT.USAGE);
    expect(err.join(" ")).toContain("--owner");
  });
});

describe("checksum", () => {
  it("prints the EIP-55 spelling and exits 0", async () => {
    const { code, out } = await run(["checksum", GENUINE]);
    expect(code).toBe(EXIT.TRUSTED);
    expect(out[0]).toBe(toChecksum(GENUINE));
  });

  it("exits 30 for a malformed address", async () => {
    const { code } = await run(["checksum", "0xnope"]);
    expect(code).toBe(EXIT.INVALID);
  });

  it("exits 30 for a mangled checksum", async () => {
    const checksummed = toChecksum(GENUINE);
    const index = [...checksummed].findIndex((c, i) => i > 1 && /[a-fA-F]/.test(c));
    const char = checksummed[index] as string;
    const mangled =
      checksummed.slice(0, index) +
      (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()) +
      checksummed.slice(index + 1);
    const { code } = await run(["checksum", mangled]);
    expect(code).toBe(EXIT.INVALID);
  });

  it("needs no endpoint and reports source null in JSON", async () => {
    const { code, json } = await run(["checksum", GENUINE, "--json"]);
    expect(code).toBe(EXIT.TRUSTED);
    expect(json()).toMatchObject({ command: "checksum", source: null, checksum: "unchecksummed" });
  });

  it("exits 1 with no address", async () => {
    expect((await run(["checksum"])).code).toBe(EXIT.USAGE);
  });
});

describe("check", () => {
  it("exits 0 for a trusted recipient", async () => {
    const { code, out } = await run(["check", GENUINE, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN]);
    expect(code).toBe(EXIT.TRUSTED);
    expect(out[0]).toContain("TRUSTED");
  });

  it("exits 10 for an unrelated address", async () => {
    const { code, out } = await run(["check", STRANGER, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN]);
    expect(code).toBe(EXIT.NEW);
    expect(out[0]).toContain("NEW");
  });

  it("exits 20 for a look-alike and names what it imitates", async () => {
    const { code, out } = await run(["check", IMITATOR, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN]);
    expect(code).toBe(EXIT.LOOKALIKE);
    expect(out.join("\n")).toContain("LOOKALIKE");
    expect(out.join("\n")).toContain(`imitates ${toChecksum(GENUINE)}`);
  });

  it("exits 30 for a malformed candidate", async () => {
    const { code } = await run(["check", "0xnope", "--owner", OWNER, "--rpc", RPC, "--token", TOKEN]);
    expect(code).toBe(EXIT.INVALID);
  });

  it("exits 1 with no candidate", async () => {
    expect((await run(["check", "--owner", OWNER, "--rpc", RPC, "--token", TOKEN])).code).toBe(EXIT.USAGE);
  });

  it("exits 2 when the history cannot be read", async () => {
    const { code, err } = await run(["check", GENUINE, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      source: () => ({
        fetch: async () => {
          throw new Error("endpoint is down");
        },
      }),
    });
    expect(code).toBe(EXIT.FAILED);
    expect(err.join(" ")).toContain("endpoint is down");
  });

  it("carries source into the JSON payload and never leaks the endpoint path", async () => {
    const { json, out } = await run(["check", IMITATOR, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN, "--json"]);
    const payload = json() as Record<string, unknown>;
    expect(payload).toMatchObject({ command: "check", verdict: "lookalike", trustedCount: 1 });
    expect(payload["source"]).toMatchObject({ kind: "rpc", fromBlock: 100, toBlock: 200 });
    expect(out.join("\n")).not.toContain("secret-key");
  });

  it("honours a widened window", async () => {
    // With prefix 6 the shared opening is abcd11 vs abcd00, so the imitation no longer matches.
    const { code } = await run(["check", IMITATOR, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN, "--prefix", "6"]);
    expect(code).toBe(EXIT.NEW);
  });

  it("honours --min-value when deriving trust", async () => {
    // The genuine send is 1_000_000; a floor above it leaves nothing trusted.
    const { code, json } = await run([
      "check", GENUINE, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN, "--min-value", "2000000", "--json",
    ]);
    expect(code).toBe(EXIT.NEW);
    expect(json()).toMatchObject({ trustedCount: 0 });
  });
});

describe("scan", () => {
  it("exits 20 and lists a look-alike that sent dust", async () => {
    const { code, out } = await run(["scan", OWNER, "--rpc", RPC, "--token", TOKEN]);
    expect(code).toBe(EXIT.LOOKALIKE);
    expect(out.join("\n")).toContain(toChecksum(IMITATOR));
    expect(out.join("\n")).toContain(`imitates ${toChecksum(GENUINE)}`);
  });

  it("exits 0 when no inbound dust imitates anything", async () => {
    const { code, out } = await run(["scan", OWNER, "--rpc", RPC, "--token", TOKEN], {
      source: () => mockSource(poisonedHistory.filter((event) => event.direction === "out")),
    });
    expect(code).toBe(EXIT.TRUSTED);
    expect(out.join("\n")).toContain("No look-alike addresses");
  });

  it("reports findings and source in JSON", async () => {
    const { json } = await run(["scan", OWNER, "--rpc", RPC, "--token", TOKEN, "--json"]);
    const payload = json() as {
      findings: { claimedBy: string; transfers: { valueRaw: string; txHash: string; blockNumber: string }[] }[];
      source: unknown;
    };
    expect(payload.findings).toHaveLength(1);
    // "claimedBy", not "sender": an inbound log's from topic is forgeable, which is the premise.
    expect(payload.findings[0]?.claimedBy).toBe(IMITATOR);
    // Every inbound transfer from the sender is reported, bigints as base-10 strings.
    expect(payload.findings[0]?.transfers).toHaveLength(1);
    expect(payload.findings[0]?.transfers[0]?.valueRaw).toBe("1");
    expect(payload.source).toMatchObject({ kind: "rpc" });
  });

  it("exits 1 with no owner", async () => {
    expect((await run(["scan"])).code).toBe(EXIT.USAGE);
  });
});

describe("payouts", () => {
  const file = "/payouts.csv";
  const readFile = (text: string) => async () => text;

  it("exits 0 when every recipient is trusted", async () => {
    const { code } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      readFile: readFile(`recipient,amount\n${GENUINE},10\n`),
    });
    expect(code).toBe(EXIT.TRUSTED);
  });

  it("exits 20 when a recipient imitates a trusted address", async () => {
    const { code, out } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      readFile: readFile(`${GENUINE},10\n${IMITATOR},5\n`),
    });
    expect(code).toBe(EXIT.LOOKALIKE);
    expect(out.join("\n")).toContain("LOOKALIKE");
  });

  /** A row imitating another row is the same attack carried out inside the batch. */
  it("flags a recipient that imitates another row, not just the history", async () => {
    const unknownPair = "0x7777000000000000000000000000000000007777" as Address;
    const imitator = "0x7777111111111111111111111111111111117777" as Address;
    const { code, out } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      readFile: readFile(`${unknownPair},1\n${imitator},1\n`),
    });
    expect(code).toBe(EXIT.LOOKALIKE);
    expect(out.join("\n")).toContain("LOOKALIKE");
  });

  it("exits 30 for a malformed row and still reports the others", async () => {
    const { code, out } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      readFile: readFile(`${GENUINE},10\nnot-an-address,5\n`),
    });
    expect(code).toBe(EXIT.INVALID);
    expect(out.join("\n")).toContain("INVALID");
    expect(out.join("\n")).toContain("TRUSTED");
  });

  it("reports the worst verdict, not the last", async () => {
    const { code } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      readFile: readFile(`${IMITATOR},1\n${GENUINE},1\n`),
    });
    expect(code).toBe(EXIT.LOOKALIKE);
  });

  it("includes line numbers and source in JSON", async () => {
    const { json } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN, "--json"], {
      readFile: readFile(`recipient\n${GENUINE}\n${IMITATOR}\n`),
    });
    const payload = json() as { results: { line: number; verdict: string }[]; source: unknown };
    expect(payload.results.map((r) => [r.line, r.verdict])).toEqual([
      [2, "trusted"],
      [3, "lookalike"],
    ]);
    expect(payload.source).toMatchObject({ kind: "rpc" });
  });

  it("exits 2 when the file cannot be read", async () => {
    const { code } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(code).toBe(EXIT.FAILED);
  });

  it("exits 2 for a file with no rows", async () => {
    const { code } = await run(["payouts", file, "--owner", OWNER, "--rpc", RPC, "--token", TOKEN], {
      readFile: readFile("# only a comment\n\n"),
    });
    expect(code).toBe(EXIT.FAILED);
  });

  it("exits 1 with no file", async () => {
    expect((await run(["payouts", "--owner", OWNER, "--rpc", RPC, "--token", TOKEN])).code).toBe(EXIT.USAGE);
  });
});
