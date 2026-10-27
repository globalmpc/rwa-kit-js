import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createRpc, redactEndpoint, WalkerError, type Rpc } from "@globalmpc/evm-log-walker";
import { assessRecipient, type Assessment, type Verdict } from "../assess.js";
import { checksumState, toChecksum } from "../checksum.js";
import { GuardError } from "../errors.js";
import { checkedAddress, isAddress, normalizeAddress, type Address } from "../hex.js";
import type { BlockRange, History, HistoryEvent, HistorySource, SourceInfo } from "../history.js";
import { DEFAULT_PREFIX, DEFAULT_SUFFIX, findLookalikes } from "../lookalike.js";
import { parsePayoutCsv } from "../payouts.js";
import { rpcLogSource } from "../sources.js";
import { redactSecrets, secretsFromEndpoints } from "../redact.js";
import { deriveTrustedRecipients } from "../trusted.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: typeof globalThis.fetch;
  /** Where `ADDRESS_GUARD_RPC` is read from. The bin passes `process.env`. */
  env?: Record<string, string | undefined>;
  /** File access, injectable so tests never touch disk. Defaults to `node:fs/promises`. */
  readFile?: (path: string) => Promise<string>;
  /** Replaces the history source, so tests can drive the CLI without a chain. */
  source?: (rpc: Rpc) => HistorySource;
}

/** Endpoints separated by spaces, read when `--rpc` is absent. The place for a keyed URL. */
export const ENDPOINT_VARIABLE = "ADDRESS_GUARD_RPC";

/**
 * Exit codes. The verdict codes are spaced by ten so a caller can test a range, and the worst
 * verdict in a run decides the code: a clean batch with one look-alike exits 20.
 */
export const EXIT = {
  TRUSTED: 0,
  USAGE: 1,
  FAILED: 2,
  NEW: 10,
  LOOKALIKE: 20,
  INVALID: 30,
} as const;

/**
 * Look-alike matches kept per payout row. Every address in a bucket matches the row by
 * construction, so the first decides the verdict; the rest is volume. The true count travels with
 * the result as `imitatesTotal`, so nothing is hidden by the cap.
 */
const EVIDENCE_LIMIT = 10;

const VERDICT_EXIT: Record<Verdict, number> = {
  trusted: EXIT.TRUSTED,
  new: EXIT.NEW,
  lookalike: EXIT.LOOKALIKE,
  invalid: EXIT.INVALID,
  "bad-checksum": EXIT.INVALID,
};

export const USAGE = `Usage: address-guard <command> [options]

Catches address-poisoning look-alikes before you send. Trusted recipients are
derived from your own outgoing sends: a successful, non-zero transfer whose
transaction you signed. A destination sharing the first and last 4 hex
characters of one of them, but differing in the middle, is a look-alike.

Commands:
  check <candidate>    judge one destination against the owner's history
  scan <owner>         list look-alikes that sent dust or zero-value
                        transfers to the owner
  checksum <address>   print the EIP-55 spelling and whether the input matched
  payouts <file>       judge every recipient in a payout file

Options:
  --owner <address>    the account whose history is the source of trust
                        (required by check and payouts)
  --rpc <url>          JSON-RPC endpoint; repeat to add fallbacks
  --token <address>    the ERC-20 to read; repeat for several. REQUIRED by
                        check, scan and payouts. Any contract can emit
                        Transfer(you, anyone, value) without moving a token, so
                        naming the ones you trust is what makes a send evidence
                        of a payment rather than of a signature
  --from-block <n>     first block to read. Default: the most recent window
  --to-block <n>       last block to read. Default finalized
  --min-value <raw>    smallest transfer, in base units, that counts as a real
                        send. Default 1
  --prefix <n>         leading hex characters compared. Default 4
  --suffix <n>         trailing hex characters compared. Default 4
  --json               print JSON instead of a summary
  -h, --help           show this help

Environment:
  ${ENDPOINT_VARIABLE}  endpoints separated by spaces, used when --rpc is absent.
                    Put a keyed URL here: an argument is kept in shell history
                    and shown to other users in the process list.

Exit codes: 0 trusted, 10 new, 20 look-alike, 30 invalid or bad checksum,
1 usage error, 2 the history could not be read.

Every --json payload carries a "source" object naming the endpoint, by origin
only, and the block range the answer was derived from. "checksum" needs no
history and reports source null.

There is no --indexer flag. indexerThenRpc in the library will prefer an
indexer over RPC, but only one that states the block range it has actually
indexed, and a plain JSON-RPC endpoint cannot: it answers the range it is asked
for and says nothing about what it may have missed. Trusting one anyway is how
a partially synced index empties the trusted set and turns a look-alike into a
"new" address.`;

interface Options {
  owner?: Address;
  rpc: string[];
  tokens?: Address[];
  fromBlock?: number;
  toBlock?: number;
  minValueRaw?: bigint;
  prefix?: number;
  suffix?: number;
  json: boolean;
}

/**
 * Runs the tool. Returns the exit code rather than calling `process.exit`, so tests assert codes
 * without a subprocess, and writes only through `io`.
 */
export async function runAddressGuard(argv: readonly string[], io: CliIo): Promise<number> {
  let command: string | undefined;
  let positional: string | undefined;
  let options: Options;
  try {
    const parsed = parse(argv, io.env ?? {});
    if (parsed.help) {
      io.stdout(USAGE);
      return EXIT.TRUSTED;
    }
    command = parsed.command;
    positional = parsed.positional;
    options = parsed.options;
  } catch (error) {
    io.stderr(message(error));
    io.stderr("");
    io.stderr(USAGE);
    return EXIT.USAGE;
  }

  try {
    switch (command) {
      case "checksum":
        return runChecksum(positional, options, io);
      case "check":
        return await runCheck(positional, options, io);
      case "scan":
        return await runScan(positional, options, io);
      case "payouts":
        return await runPayouts(positional, options, io);
      default:
        io.stderr(command === undefined ? "a command is required" : `unknown command "${command}"`);
        io.stderr("");
        io.stderr(USAGE);
        return EXIT.USAGE;
    }
  } catch (error) {
    // Endpoint URLs are the only place the user hands us a credential, so they define what must
    // never be echoed back out of a provider's error text.
    // The same URL components provenance refuses to echo must not reach stderr through a
    // provider's error text either.
    const secrets = secretsFromEndpoints(options.rpc);
    if (error instanceof GuardError && error.code.startsWith("E_INVALID")) {
      io.stderr(message(error, secrets));
      return EXIT.USAGE;
    }
    io.stderr(message(error, secrets));
    return EXIT.FAILED;
  }
}

function runChecksum(input: string | undefined, options: Options, io: CliIo): number {
  if (input === undefined) {
    io.stderr("checksum needs an address");
    return EXIT.USAGE;
  }
  if (!isAddress(input)) {
    if (options.json) {
      io.stdout(stringify({ command: "checksum", input, valid: false, verdict: "invalid", source: null }));
    } else {
      io.stderr(`${input} is not a 20-byte hex address`);
    }
    return EXIT.INVALID;
  }
  const checksummed = toChecksum(input);
  const state = checksumState(input);
  if (options.json) {
    io.stdout(stringify({ command: "checksum", input, checksummed, checksum: state, source: null }));
  } else {
    io.stdout(checksummed);
    if (state === "mismatch") io.stderr("the input's casing does not match this checksum");
    if (state === "unchecksummed") io.stderr("the input carried no checksum to verify");
  }
  return state === "mismatch" ? EXIT.INVALID : EXIT.TRUSTED;
}

async function runCheck(candidate: string | undefined, options: Options, io: CliIo): Promise<number> {
  if (candidate === undefined) {
    io.stderr("check needs a candidate address");
    return EXIT.USAGE;
  }
  const owner = requireOwner(options);

  // A malformed candidate is decided by its own shape, so it is judged before any endpoint is
  // contacted. Otherwise an unreachable endpoint would turn a certain "invalid" into exit 2.
  if (!isAddress(candidate)) {
    const assessment = assessRecipient(candidate, { trusted: [] });
    if (options.json) {
      io.stdout(stringify({ command: "check", owner, trustedCount: 0, ...assessment, source: null }));
    } else {
      io.stdout(`${assessment.verdict.toUpperCase()}  ${candidate}`);
      for (const reason of assessment.reasons) io.stdout(`  - ${reason}`);
      io.stdout("source: none read — the candidate is not an address, so no history was fetched");
    }
    return VERDICT_EXIT[assessment.verdict];
  }

  const { trusted, source } = await loadTrusted(owner, options, io);
  const assessment = assessRecipient(candidate, {
    trusted,
    source,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.suffix !== undefined ? { suffix: options.suffix } : {}),
  });

  if (options.json) {
    io.stdout(stringify({ command: "check", owner, trustedCount: trusted.length, ...assessment, source }));
  } else {
    io.stdout(`${assessment.verdict.toUpperCase()}  ${candidate}`);
    for (const reason of assessment.reasons) io.stdout(`  - ${reason}`);
    for (const match of assessment.evidence) io.stdout(`  imitates ${toChecksum(match.known)}`);
    io.stdout(describe(source, trusted.length));
  }
  return VERDICT_EXIT[assessment.verdict];
}

async function runScan(owner: string | undefined, options: Options, io: CliIo): Promise<number> {
  if (owner === undefined) {
    io.stderr("scan needs an owner address");
    return EXIT.USAGE;
  }
  const checked = checkedAddress(owner, "owner");
  const { events, source } = await loadHistory(checked, options, io);
  const trusted = deriveTrustedRecipients(events, minValue(options));

  // Every inbound sender, judged against the trusted set. The look-alike test is itself the
  // filter: sharing both ends with an address the owner really pays is specific enough that an
  // amount threshold would only hide cases. The amount is reported, so dust is visible as dust.
  // Keyed by the address the inbound log *names*, which is its `from` topic -- forgeable, which
  // is this package's whole premise. It is never called the sender: `txFrom` is who signed the
  // transaction, and the two differ in exactly the attack being looked for. Every inbound
  // transfer is kept, not just the first, because a look-alike often sends something ordinary
  // before the dust and naming the wrong transaction misleads whoever goes to look it up.
  const claimed = new Map<Address, { valueRaw: bigint; txHash: string; blockNumber: bigint; txFrom: Address }[]>();
  for (const event of events) {
    if (event.direction !== "in") continue;
    const address = normalizeAddress(event.counterparty);
    const seen = claimed.get(address) ?? [];
    seen.push({
      valueRaw: event.valueRaw,
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      txFrom: normalizeAddress(event.txFrom),
    });
    claimed.set(address, seen);
  }

  const trustedSet = new Set(trusted);
  const findings = [...claimed.entries()]
    // An address the owner really pays is not a poisoner, even when another trusted address
    // happens to share both its ends. This mirrors assessRecipient's precedence, which scan
    // bypasses by calling findLookalikes directly.
    .filter(([address]) => !trustedSet.has(address))
    .map(([address, transfers]) => ({
      /** The address the log named. Not proof that it sent anything; compare with `txFrom`. */
      claimedBy: address,
      // Smallest first: the dust is the poisoning, and it should lead.
      transfers: [...transfers].sort((a, b) =>
        a.valueRaw === b.valueRaw ? Number(a.blockNumber - b.blockNumber) : a.valueRaw < b.valueRaw ? -1 : 1,
      ),
      imitates: findLookalikes(address, trusted, {
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options.suffix !== undefined ? { suffix: options.suffix } : {}),
      }),
    }))
    .filter((finding) => finding.imitates.length > 0);

  if (options.json) {
    io.stdout(stringify({ command: "scan", owner: checked, trustedCount: trusted.length, findings, source }));
  } else if (findings.length === 0) {
    io.stdout(`No look-alike addresses found among ${claimed.size} inbound counterparty address(es).`);
    io.stdout(describe(source, trusted.length));
  } else {
    io.stdout(`${findings.length} look-alike address(es) poisoning this history:`);
    for (const finding of findings) {
      io.stdout(`  ${toChecksum(finding.claimedBy)}  (named by the transfer log)`);
      for (const transfer of finding.transfers) {
        io.stdout(`    ${transfer.valueRaw} at block ${transfer.blockNumber} in ${transfer.txHash}`);
        io.stdout(`      transaction signed by ${toChecksum(transfer.txFrom)}`);
      }
      for (const match of finding.imitates) io.stdout(`    imitates ${toChecksum(match.known)}`);
    }
    io.stdout(describe(source, trusted.length));
  }
  return findings.length > 0 ? EXIT.LOOKALIKE : EXIT.TRUSTED;
}

async function runPayouts(file: string | undefined, options: Options, io: CliIo): Promise<number> {
  if (file === undefined) {
    io.stderr("payouts needs a file");
    return EXIT.USAGE;
  }
  const owner = requireOwner(options);
  const read = io.readFile ?? ((path: string) => readFile(path, "utf8"));
  let text: string;
  try {
    text = await read(file);
  } catch (error) {
    throw new GuardError("E_PAYOUT_FORMAT", `could not read ${file}: ${message(error)}`, { cause: error });
  }
  const rows = parsePayoutCsv(text);
  const { trusted, source } = await loadTrusted(owner, options, io);

  // A recipient is judged against the trusted set and against the file's other recipients: a row
  // imitating another row is the same attack carried out inside the batch.
  //
  // Both sides of the self-exclusion are normalized. `intended` is lower-cased while
  // `row.recipient` keeps the file's own casing, so comparing them directly left a checksummed
  // row's own address in `known` -- it then matched itself exactly and was reported trusted,
  // which is the one verdict a look-alike must never receive.
  const intended = rows.flatMap((row) => (row.recipient === undefined ? [] : [normalizeAddress(row.recipient)]));
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const suffix = options.suffix ?? DEFAULT_SUFFIX;

  // Indexed by the window actually compared, so each row is judged against the handful of
  // addresses that could possibly match it instead of against all of them. Building a list per
  // row and rescanning it made a 10 000-row file quadratic. Bucketing is exact, not an
  // approximation: findLookalikes matches only on this prefix and suffix, so an address in
  // another bucket could never have matched.
  const window = (address: Address): string => {
    const body = address.slice(2);
    return `${body.slice(0, prefix)}:${body.slice(40 - suffix)}`;
  };
  const buckets = new Map<string, Set<Address>>();
  for (const address of [...trusted, ...intended]) {
    const key = window(address);
    const bucket = buckets.get(key) ?? new Set<Address>();
    bucket.add(address);
    buckets.set(key, bucket);
  }
  const trustedSet = new Set(trusted);

  const results = rows.map((row) => {
    const self = row.recipient === undefined ? undefined : normalizeAddress(row.recipient);
    const candidates = self === undefined ? new Set<Address>() : (buckets.get(window(self)) ?? new Set<Address>());
    // The row's own address is excluded, or it would match itself exactly and be called trusted.
    // Everything in a bucket shares the compared window by construction, so every peer is a
    // match and the first already decides the verdict. Only the evidence is capped, and the true
    // count is reported, so a file where thousands of addresses share one window produces a
    // bounded result rather than a quadratic pile of identical findings.
    //
    // Selected while iterating and stopped at the cap: copying and filtering the whole bucket
    // first would scan every entry for every row, which is the quadratic cost the bucket was
    // meant to remove.
    const totalPeers = candidates.size - (self !== undefined && candidates.has(self) ? 1 : 0);
    // Split by provenance. A match against something the owner really paid and a match against
    // another row of this file are different claims, and only the first rests on the history
    // source; folding them together made the reasons assert payments that never happened.
    const historyPeers: Address[] = [];
    const batchPeers: Address[] = [];
    for (const entry of candidates) {
      if (historyPeers.length + batchPeers.length >= EVIDENCE_LIMIT) break;
      if (entry === self) continue;
      (trustedSet.has(entry) ? historyPeers : batchPeers).push(entry);
    }
    // An exact trusted match lives in the row's own bucket, which the loop above skips, so it is
    // put back explicitly to keep the trusted verdict reachable.
    const trusted = self !== undefined && trustedSet.has(self) ? [...historyPeers, self] : historyPeers;
    const assessment = assessRecipient(row.raw, { trusted, peers: batchPeers, source, prefix, suffix });
    return {
      line: row.line,
      ...assessment,
      // Measured against the evidence actually reported, not against the input list: that list
      // also holds the row's own address when it is trusted, which hid the truncation.
      ...(totalPeers > assessment.evidence.length
        ? { imitatesTotal: totalPeers, evidenceTruncated: true as const }
        : {}),
    };
  });

  // Annotated: EXIT.TRUSTED is the literal 0, which would pin the accumulator's type.
  const worst = results.reduce<number>((code, result) => Math.max(code, VERDICT_EXIT[result.verdict]), EXIT.TRUSTED);
  if (options.json) {
    io.stdout(stringify({ command: "payouts", owner, file, trustedCount: trusted.length, results, source }));
  } else {
    for (const result of results) {
      io.stdout(`line ${result.line}  ${result.verdict.toUpperCase()}  ${result.candidate}`);
      for (const match of result.evidence) io.stdout(`    imitates ${toChecksum(match.known)}`);
    }
    const counts = new Map<Verdict, number>();
    for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
    io.stdout([...counts.entries()].map(([verdict, n]) => `${n} ${verdict}`).join(", "));
    io.stdout(describe(source, trusted.length));
  }
  return worst;
}

function requireOwner(options: Options): Address {
  if (options.owner === undefined) {
    throw new GuardError("E_INVALID_ARGUMENT", "--owner is required: trust is derived from one account's own sends");
  }
  return options.owner;
}

function minValue(options: Options): { minValueRaw?: bigint } {
  return options.minValueRaw !== undefined ? { minValueRaw: options.minValueRaw } : {};
}

async function loadHistory(owner: Address, options: Options, io: CliIo): Promise<History> {
  if (options.rpc.length === 0) {
    throw new GuardError(
      "E_INVALID_ARGUMENT",
      `an endpoint is required: pass --rpc or set ${ENDPOINT_VARIABLE}`,
    );
  }

  if (options.tokens === undefined || options.tokens.length === 0) {
    throw new GuardError(
      "E_INVALID_ARGUMENT",
      "--token is required: any contract can emit Transfer(you, anyone, value) without moving a " +
        "token, so a send only proves a payment when it comes from a token you name",
    );
  }
  const rpc = createRpc({
    urls: [...options.rpc],
    ...(io.fetch !== undefined ? { fetch: io.fetch } : {}),
  });
  const source =
    io.source?.(rpc) ??
    rpcLogSource(rpc, {
      tokens: options.tokens,
      ...(options.toBlock !== undefined ? { toBlock: options.toBlock } : {}),
    });
  return source.fetch(owner, requestedRange(options));
}

/** The bounds the user asked for, with no resolution. Used when there is no indexer to verify. */
function requestedRange(options: Options): BlockRange | undefined {
  if (options.fromBlock === undefined) return undefined;
  return {
    fromBlock: options.fromBlock,
    ...(options.toBlock !== undefined ? { toBlock: options.toBlock } : {}),
  };
}

async function loadTrusted(
  owner: Address,
  options: Options,
  io: CliIo,
): Promise<{ trusted: Address[]; source: SourceInfo }> {
  const { events, source } = await loadHistory(owner, options, io);
  return { trusted: deriveTrustedRecipients(events, minValue(options)), source };
}

function describe(source: SourceInfo, trustedCount: number): string {
  return `source: ${source.kind} ${source.endpoint}, blocks ${source.fromBlock}-${source.toBlock}, ${trustedCount} trusted recipient(s)`;
}

/** `bigint` has no JSON form, so every one is written as a base-10 string. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => (typeof inner === "bigint" ? inner.toString() : inner), 2);
}

/**
 * An error as it is safe to write to stderr.
 *
 * `RpcError` embeds the endpoint's own wording. The walker sanitises its shape but not its
 * content, so a provider answering `invalid API key: <key>` would put that key in a CI log.
 * Anything the user's endpoint URLs reveal as a secret is masked first.
 */
function message(error: unknown, secrets: readonly string[] = []): string {
  const text =
    error instanceof GuardError || error instanceof WalkerError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return secrets.length === 0 ? text : redactSecrets(text, secrets);
}

function parse(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): { command?: string; positional?: string; options: Options; help: boolean } {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      owner: { type: "string" },
      rpc: { type: "string", multiple: true },
      token: { type: "string", multiple: true },
      "from-block": { type: "string" },
      "to-block": { type: "string" },
      "min-value": { type: "string" },
      prefix: { type: "string" },
      suffix: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const fromEnv = (env[ENDPOINT_VARIABLE] ?? "").split(/\s+/).filter((entry) => entry !== "");
  const options: Options = {
    rpc: values.rpc ?? fromEnv,
    json: values.json === true,
    ...(values.owner !== undefined ? { owner: checkedAddress(values.owner, "--owner") } : {}),
    ...(values.token !== undefined ? { tokens: values.token.map((t) => checkedAddress(t, "--token")) } : {}),
    ...(values["from-block"] !== undefined ? { fromBlock: integer(values["from-block"], "--from-block") } : {}),
    ...(values["to-block"] !== undefined ? { toBlock: integer(values["to-block"], "--to-block") } : {}),
    ...(values["min-value"] !== undefined ? { minValueRaw: natural(values["min-value"], "--min-value") } : {}),
    ...(values.prefix !== undefined ? { prefix: integer(values.prefix, "--prefix") } : {}),
    ...(values.suffix !== undefined ? { suffix: integer(values.suffix, "--suffix") } : {}),
  };

  // Every command takes at most one argument. Ignoring the rest would let
  // `payouts safe.csv unchecked.csv` exit 0 having read only the first file.
  if (positionals.length > 2) {
    throw new GuardError(
      "E_INVALID_ARGUMENT",
      `only one argument is expected after the command, but ${positionals.length - 1} were given ` +
        `(${positionals.slice(1).join(", ")}); run the command once per input`,
    );
  }
  return {
    help: values.help === true,
    options,
    ...(positionals[0] !== undefined ? { command: positionals[0] } : {}),
    ...(positionals[1] !== undefined ? { positional: positionals[1] } : {}),
  };
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new GuardError("E_INVALID_ARGUMENT", `${name} must be a non-negative integer, got "${value}"`);
  }
  // The digit test alone admits values Number() rounds: 9007199254740993 becomes
  // ...992, and the command would then read a different range from the one asked for.
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new GuardError(
      "E_INVALID_ARGUMENT",
      `${name} is above Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}), got "${value}"`,
    );
  }
  return parsed;
}

function natural(value: string, name: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new GuardError("E_INVALID_ARGUMENT", `${name} must be a non-negative integer, got "${value}"`);
  }
  return BigInt(value);
}

export { redactEndpoint };
