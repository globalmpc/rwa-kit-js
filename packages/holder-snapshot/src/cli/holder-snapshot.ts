import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { WalkerError, type BlockTag, type RpcOptions } from "@globalmpc/evm-log-walker";
import type { AllocationMode } from "../allocate.js";
import { formatUnits, parseUnits } from "../amount.js";
import { connectSameChain } from "../chain.js";
import { buildDistribution, type Distribution } from "../distribute.js";
import { SnapshotError } from "../errors.js";
import { checkedAddress, type Address } from "../hex.js";
import { toPayoutCsv } from "../payout.js";
import { redactEndpoints } from "../redact.js";
import { parseSnapshot, recheckSnapshot, serializeSnapshot, takeSnapshot, type FromBlockOrigin, type Snapshot } from "../snapshot.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: typeof globalThis.fetch;
  /** Where `HOLDER_SNAPSHOT_RPC` is read from. The bin passes `process.env`. */
  env?: Record<string, string | undefined>;
  /** File access, injectable so tests never touch disk. Defaults to `node:fs/promises`. */
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
}

/** Endpoints separated by spaces, read when `--rpc` is absent. The place for a keyed URL. */
export const ENDPOINT_VARIABLE = "HOLDER_SNAPSHOT_RPC";

export const EXIT = {
  OK: 0,
  USAGE: 1,
  FAILED: 2,
  UNVERIFIED: 3,
} as const;

export const USAGE = `Usage: holder-snapshot <command> [options]

Who held a token at a block, and what each holder is owed from a payout pool.

Commands:
  snapshot             replay the token's Transfer history into balances at a
                        block, and check them against balanceOf and totalSupply
  distribute           split a pool across a saved snapshot's holders and
                        write the payout list as CSV (recipient,amount)

snapshot options:
  --token <address>    the ERC-20 whose holders are wanted (required)
  --block <n|tag>      snapshot block, or latest, safe or finalized.
                        Default finalized
  --from-block <n>     first block to replay. Default: the token's creation
                        block, found automatically
  --decimals <n>       the token's decimals, for a token without decimals()
  --sample <n|all>     holders checked against balanceOf. Default all, which a
                        payout needs; a number checks that many of the largest
                        plus as many spread across the rest, a quicker look
                        that distribute will not pay from without a recheck
  --classify           also mark each holder as contract or wallet, so
                        distribute can use --exclude-contracts
  --out <file>         write the snapshot as JSON, for distribute
  --rpc <url>          JSON-RPC endpoint; repeat to add fallbacks. Must keep
                        historical state (an archive node) for past blocks

distribute options:
  --snapshot <file>    a snapshot written by "snapshot --out" (required)
  --token <address>    the token whose holders are paid (required); the file
                        must be of this token
  --pool <amount>      total to distribute, in payout-token units (required)
  --decimals <n>       the payout token's decimals (required)
  --mode <mode>        pro-rata (default) or equal
  --cap <amount>       most any one holder receives, in payout-token units;
                        pro-rata shares the excess among the others
  --min-balance <amt>  holders below this, in snapshot-token units, get nothing
  --exclude <address>  never pay this address; repeat for several (treasury,
                        liquidity pool, burn address)
  --exclude-contracts  never pay a contract (needs a --classify snapshot)
  --out <file>         write the CSV here. Default: CSV to stdout, summary to
                        stderr
  --rpc <url>          endpoint to recheck every balance in the snapshot file
                        against before paying from it (required unless
                        --offline)
  --offline            skip the recheck and trust the file as written: only
                        for a file you produced and kept under your control

  --json               print JSON instead of a summary
  -h, --help           show this help

Environment:
  ${ENDPOINT_VARIABLE}  endpoints separated by spaces, used when --rpc is
                        absent. Put a keyed URL here: an argument is kept in
                        shell history and shown in the process list.

Exit codes: 0 ok, 1 usage error or nothing to pay, 2 the chain or a file could
not be read, 3 the snapshot does not match the token's own balances or its
history start could not be confirmed.`;

interface Parsed {
  command: string;
  help: boolean;
  json: boolean;
  rpc: string[];
  token?: Address;
  block?: number | BlockTag;
  fromBlock?: number;
  decimals?: number;
  sample?: number | "all";
  offline: boolean;
  classify: boolean;
  out?: string;
  snapshot?: string;
  pool?: string;
  mode?: AllocationMode;
  cap?: string;
  minBalance?: string;
  exclude: Address[];
  excludeContracts: boolean;
}

/**
 * Runs the tool. Returns the exit code rather than calling `process.exit`, so tests assert codes
 * without a subprocess, and writes only through `io`.
 */
export async function runHolderSnapshot(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv, io.env ?? {});
  } catch (error) {
    io.stderr(text(error));
    io.stderr("");
    io.stderr(USAGE);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout(USAGE);
    return EXIT.OK;
  }

  try {
    switch (parsed.command) {
      case "snapshot":
        return await runSnapshot(parsed, io);
      case "distribute":
        return await runDistribute(parsed, io);
      default:
        io.stderr(parsed.command === "" ? "a command is required" : `unknown command "${parsed.command}"`);
        io.stderr("");
        io.stderr(USAGE);
        return EXIT.USAGE;
    }
  } catch (error) {
    // The walker names an endpoint's origin in its errors, and a provider is free to echo the key
    // it was sent, so no part of a supplied endpoint URL is printed: hosts become endpoint-N and
    // everything beyond the origin is masked.
    io.stderr(redactEndpoints(text(error), parsed.rpc));
    if (error instanceof SnapshotError) {
      if (error.code === "E_INCOMPLETE_HISTORY" || error.code === "E_UNVERIFIED") return EXIT.UNVERIFIED;
      if (
        error.code === "E_INVALID_ARGUMENT" ||
        error.code === "E_INVALID_AMOUNT" ||
        error.code === "E_INVALID_ADDRESS" ||
        error.code === "E_NOTHING_TO_PAY"
      ) {
        return EXIT.USAGE;
      }
    }
    return EXIT.FAILED;
  }
}

async function runSnapshot(parsed: Parsed, io: CliIo): Promise<number> {
  if (parsed.token === undefined) throw new SnapshotError("E_INVALID_ARGUMENT", "--token is required");
  if (parsed.rpc.length === 0) throw new SnapshotError("E_INVALID_ARGUMENT", `an endpoint is required: pass --rpc or set ${ENDPOINT_VARIABLE}`);
  const { rpc } = await connectSameChain(rpcOptions(parsed, io));
  const snapshot = await takeSnapshot(rpc, {
    token: parsed.token,
    classify: parsed.classify,
    ...(parsed.block !== undefined ? { block: parsed.block } : {}),
    ...(parsed.fromBlock !== undefined ? { fromBlock: parsed.fromBlock } : {}),
    ...(parsed.decimals !== undefined ? { decimals: parsed.decimals } : {}),
    ...(parsed.sample !== undefined ? { sample: parsed.sample } : {}),
  });
  // Written even when unverified: the mismatches are what someone needs to investigate, and
  // distribute refuses the file anyway.
  if (parsed.out !== undefined) await write(io)(parsed.out, serializeSnapshot(snapshot));

  if (parsed.json) {
    io.stdout(serializeSnapshot(snapshot).trimEnd());
  } else {
    for (const line of summarizeSnapshot(snapshot)) io.stdout(line);
    if (parsed.out !== undefined) io.stdout(`written      ${parsed.out}`);
  }
  return snapshot.verification.verified ? EXIT.OK : EXIT.UNVERIFIED;
}

async function runDistribute(parsed: Parsed, io: CliIo): Promise<number> {
  if (parsed.snapshot === undefined) throw new SnapshotError("E_INVALID_ARGUMENT", "--snapshot <file> is required");
  if (parsed.token === undefined) {
    throw new SnapshotError("E_INVALID_ARGUMENT", "--token is required: the snapshot file must be of the token you mean to pay holders of, and the file alone cannot say so");
  }
  if (parsed.pool === undefined) throw new SnapshotError("E_INVALID_ARGUMENT", "--pool <amount> is required");
  if (parsed.decimals === undefined) throw new SnapshotError("E_INVALID_ARGUMENT", "--decimals <n> (the payout token's) is required");
  if (!parsed.offline && parsed.rpc.length === 0) {
    throw new SnapshotError(
      "E_INVALID_ARGUMENT",
      `distribute rechecks every balance in the snapshot against the chain before paying from it: pass --rpc or set ${ENDPOINT_VARIABLE}, ` +
        "or pass --offline to trust the file as written",
    );
  }
  let snapshot = parseSnapshot(await read(io)(parsed.snapshot));
  if (snapshot.token !== parsed.token) {
    throw new SnapshotError("E_UNVERIFIED", `the snapshot file is of token ${snapshot.token}, not --token ${parsed.token}`);
  }
  if (!parsed.offline) {
    // A file carries no proof of where it came from: one edited after it was written still says
    // "verified". Reading every balance back binds the payout to the chain, not to the file.
    const { rpc } = await connectSameChain(rpcOptions(parsed, io));
    const recheck = await recheckSnapshot(rpc, snapshot, { token: parsed.token });
    if (!recheck.verified) {
      throw new SnapshotError(
        "E_UNVERIFIED",
        `the snapshot file does not match the chain at block ${snapshot.block}: ${recheck.mismatches.length} of ` +
          `${recheck.checked} balance(s) differ` +
          (recheck.totalSupply === recheck.replayedSupply ? "" : `, and the holders add up to ${recheck.replayedSupply} against totalSupply ${recheck.totalSupply}`) +
          (recheck.contractMismatches.length === 0 ? "" : `, and ${recheck.contractMismatches.length} contract flag(s) are wrong`) +
          `${recheck.mismatches.slice(0, 5).map((m) => `\n  ${m.address}: file ${m.replayed}, balanceOf ${m.onChain}`).join("")}` +
          `${recheck.contractMismatches.slice(0, 5).map((address) => `\n  ${address}: contract flag differs from eth_getCode`).join("")}`,
      );
    }
    // Every balance has now been checked against the chain, whatever the file's own check covered.
    snapshot = { ...snapshot, verification: recheck };
  }
  const decimals = parsed.decimals;
  const distribution = buildDistribution(snapshot, {
    pool: parseUnits(parsed.pool, decimals),
    exclude: parsed.exclude,
    excludeContracts: parsed.excludeContracts,
    ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
    ...(parsed.cap !== undefined ? { cap: parseUnits(parsed.cap, decimals) } : {}),
    ...(parsed.minBalance !== undefined ? { minBalance: parseUnits(parsed.minBalance, snapshot.decimals) } : {}),
  });
  const csv = toPayoutCsv(distribution.allocations, decimals);

  if (parsed.out !== undefined) await write(io)(parsed.out, csv);
  if (parsed.json) {
    io.stdout(JSON.stringify(distribution, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
    return EXIT.OK;
  }
  const summary = summarizeDistribution(distribution, snapshot, decimals);
  summary.push(
    parsed.offline
      ? "rechecked    no (--offline): the snapshot file is trusted as written"
      : `rechecked    yes: all ${snapshot.holders.length} balance(s)${snapshot.classified ? ", contract flags" : ""} and totalSupply match the chain`,
  );
  if (parsed.out !== undefined) {
    for (const line of summary) io.stdout(line);
    io.stdout(`written      ${parsed.out}`);
  } else {
    // The CSV is the data and goes to stdout, so it can be piped; the summary goes to stderr.
    io.stdout(csv.trimEnd());
    for (const line of summary) io.stderr(line);
  }
  return EXIT.OK;
}

const ORIGIN_TEXT: Record<FromBlockOrigin, string> = {
  creation: "from creation",
  "creation-unconfirmed": "from an unconfirmed creation block",
  given: "from a given block",
};

/** The text summary of a snapshot: what was read, what it found, and whether it checks out. */
export function summarizeSnapshot(snapshot: Snapshot): string[] {
  const v = snapshot.verification;
  const total = formatUnits(v.replayedSupply, snapshot.decimals);
  const lines = [
    `token        ${snapshot.token} on chain ${snapshot.chainId}`,
    `block        ${snapshot.block} (${new Date(snapshot.blockTimestamp * 1000).toISOString()})`,
    `history      blocks ${snapshot.source.fromBlock}-${snapshot.block} (${ORIGIN_TEXT[snapshot.source.fromBlockOrigin]}), ${snapshot.transfers} transfer(s)`,
    `holders      ${snapshot.holders.length}, total ${total}` +
      (snapshot.classified ? `, ${snapshot.holders.filter((holder) => holder.contract === true).length} contract(s)` : ""),
  ];
  const checksPassed = v.totalSupply === v.replayedSupply && v.mismatches.length === 0;
  if (v.verified) {
    lines.push(`verified     yes: totalSupply matches and ${v.checked} balance(s) match balanceOf`);
  } else if (checksPassed && snapshot.source.fromBlockOrigin === "creation-unconfirmed") {
    lines.push(
      `verified     NO: balances match, but the creation block ${snapshot.source.fromBlock} could not be confirmed, ` +
        "so earlier transfers may be missing; take the snapshot again with --from-block set to a creation block you have checked",
    );
  } else {
    const supply = v.totalSupply === v.replayedSupply ? "totalSupply matches" : `totalSupply is ${formatUnits(v.totalSupply, snapshot.decimals)}, replay gives ${total}`;
    lines.push(`verified     NO: ${supply}; ${v.mismatches.length} of ${v.checked} balance(s) differ`);
    for (const m of v.mismatches) {
      lines.push(`mismatch     ${m.address} replayed ${formatUnits(m.replayed, snapshot.decimals)}, balanceOf ${formatUnits(m.onChain, snapshot.decimals)}`);
    }
  }
  lines.push(`source       ${snapshot.source.endpoints.join(", ")}`);
  return lines;
}

/** The text summary of a distribution: who shares, who does not and why, and where the pool went. */
export function summarizeDistribution(distribution: Distribution, snapshot: Snapshot, decimals: number): string[] {
  const reasons = new Map<string, number>();
  for (const exclusion of distribution.excluded) reasons.set(exclusion.reason, (reasons.get(exclusion.reason) ?? 0) + 1);
  const breakdown = [...reasons].map(([reason, n]) => `${reason} ${n}`).join(", ");
  const capped = distribution.allocations.filter((allocation) => allocation.capped).length;
  const lines = [
    `snapshot     ${snapshot.token} at block ${snapshot.block}, ${snapshot.holders.length} holder(s)`,
    `pool         ${formatUnits(distribution.pool, decimals)} (${distribution.mode})` +
      (distribution.cap !== undefined ? `, cap ${formatUnits(distribution.cap, decimals)}` : ""),
    `eligible     ${distribution.eligible}` + (distribution.excluded.length > 0 ? `; excluded ${distribution.excluded.length} (${breakdown})` : ""),
    `paid         ${distribution.allocations.length} recipient(s), total ${formatUnits(distribution.allocated, decimals)}` +
      (capped > 0 ? `, ${capped} at the cap` : ""),
  ];
  if (distribution.unpaid.length > 0) lines.push(`unpaid       ${distribution.unpaid.length} holder(s) whose share rounds to zero`);
  lines.push(`remainder    ${formatUnits(distribution.remainder, decimals)}`);
  return lines;
}

function rpcOptions(parsed: Parsed, io: CliIo): RpcOptions {
  return { urls: [...parsed.rpc], ...(io.fetch !== undefined ? { fetch: io.fetch } : {}) };
}

function read(io: CliIo): (path: string) => Promise<string> {
  return io.readFile ?? ((path: string) => readFile(path, "utf8"));
}

function write(io: CliIo): (path: string, data: string) => Promise<void> {
  return io.writeFile ?? ((path: string, data: string) => writeFile(path, data));
}

function text(error: unknown): string {
  if (error instanceof SnapshotError || error instanceof WalkerError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function parse(argv: readonly string[], env: Record<string, string | undefined>): Parsed {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      token: { type: "string" },
      block: { type: "string" },
      "from-block": { type: "string" },
      decimals: { type: "string" },
      sample: { type: "string" },
      classify: { type: "boolean", default: false },
      out: { type: "string" },
      snapshot: { type: "string" },
      pool: { type: "string" },
      mode: { type: "string" },
      cap: { type: "string" },
      "min-balance": { type: "string" },
      exclude: { type: "string", multiple: true },
      "exclude-contracts": { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      rpc: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals.length > 1) {
    throw new SnapshotError("E_INVALID_ARGUMENT", `one command is expected, but got: ${positionals.join(" ")}`);
  }
  const mode = values.mode;
  if (mode !== undefined && mode !== "pro-rata" && mode !== "equal") {
    throw new SnapshotError("E_INVALID_ARGUMENT", `--mode must be pro-rata or equal, got "${mode}"`);
  }
  const fromEnv = (env[ENDPOINT_VARIABLE] ?? "").split(/\s+/).filter((entry) => entry !== "");
  return {
    command: positionals[0] ?? "",
    help: values.help === true,
    json: values.json === true,
    rpc: values.rpc !== undefined && values.rpc.length > 0 ? values.rpc : fromEnv,
    classify: values.classify === true,
    exclude: (values.exclude ?? []).map((entry) => checkedAddress(entry, "--exclude")),
    excludeContracts: values["exclude-contracts"] === true,
    ...(values.token !== undefined ? { token: checkedAddress(values.token, "--token") } : {}),
    ...(values.block !== undefined ? { block: blockArgument(values.block) } : {}),
    ...(values["from-block"] !== undefined ? { fromBlock: integer(values["from-block"], "--from-block") } : {}),
    ...(values.decimals !== undefined ? { decimals: integer(values.decimals, "--decimals") } : {}),
    offline: values.offline === true,
    ...(values.sample !== undefined ? { sample: values.sample === "all" ? "all" : integer(values.sample, "--sample") } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.snapshot !== undefined ? { snapshot: values.snapshot } : {}),
    ...(values.pool !== undefined ? { pool: values.pool } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(values.cap !== undefined ? { cap: values.cap } : {}),
    ...(values["min-balance"] !== undefined ? { minBalance: values["min-balance"] } : {}),
  };
}

function blockArgument(value: string): number | BlockTag {
  if (value === "latest" || value === "safe" || value === "finalized") return value;
  return integer(value, "--block");
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new SnapshotError("E_INVALID_ARGUMENT", `${name} must be a non-negative integer, got "${value}"`);
  }
  // The digit test alone admits values Number() rounds, which would read a different block.
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new SnapshotError("E_INVALID_ARGUMENT", `${name} is above Number.MAX_SAFE_INTEGER, got "${value}"`);
  }
  return parsed;
}
