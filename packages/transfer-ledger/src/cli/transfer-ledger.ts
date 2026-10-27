import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { createRpc, fromQuantity, redactEndpoint, WalkerError, type BlockTag, type Rpc } from "@globalmpc/evm-log-walker";
import { assertDecimals } from "../amount.js";
import { LedgerError } from "../errors.js";
import { fetchTransfersByRange, fetchTransfersByTransaction, type TransactionStatus } from "../fetch.js";
import { isAddress, isTransactionHash, normalizeAddress, type Hex } from "../hex.js";
import { parseIntentCsv, parseIntentJson, type Intent } from "../intent.js";
import { reconcile } from "../reconcile.js";
import { buildReport, parseSavedTransfers, serializeTransfers, type Report, type ReportFinding } from "../report.js";
import { selectPayouts, type Transfer } from "../transfers.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: typeof globalThis.fetch;
  /** Where `TRANSFER_LEDGER_RPC` is read from. The bin passes `process.env`. */
  env?: Record<string, string | undefined>;
  /** File access, injectable so tests never touch disk. Defaults to `node:fs/promises`. */
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
  /** Overrides the clock, in milliseconds since epoch. For tests only. */
  now?: () => number;
}

/** Endpoints separated by spaces, read when `--rpc` is absent. The place for a keyed URL. */
export const ENDPOINT_VARIABLE = "TRANSFER_LEDGER_RPC";

/** Exit codes. `NOT_CLEAN` is what makes the command usable as a gate after a payout round. */
export const EXIT = { CLEAN: 0, USAGE: 1, FAILED: 2, NOT_CLEAN: 3 } as const;

export const USAGE = `Usage: transfer-ledger --intent <file> --decimals <n> <transfers source> [options]

Checks a payout round: compares the intended payments in --intent with the
token transfers that actually happened, one transfer per transaction hash and
log index, and reports missing payments, duplicates, overpayments,
underpayments and transfers to addresses the list does not name.

Transfers source (exactly one):
  --tx <hash>          a transaction of the round; repeat for several.
                        Reads each receipt (needs --token)
  --from <block>       every transfer of --token sent by --payer from this
                        block, with --to <block|tag> (default finalized)
  --transfers <file>   a file written earlier by --save-transfers. Offline,
                        no endpoint needed

Options:
  --intent <file>      the payout list, CSV (recipient,amount[,round]) or
                        JSON ([{recipient, amount, round}]); amounts in token
                        units, such as 12.5
  --decimals <n>       the token's decimals, used to read the amounts exactly
  --token <address>    the token contract (taken from --transfers if absent)
  --payer <address>    only payouts from this wallet count. Repeat it, wallet
                        first, for a multisend contract that pulls the total in
                        and pays from itself: its transfers count only in
                        transactions where the wallet moved the token too.
                        Required with --from, recommended with --tx
  --round <name>       the round to check, when the intent file holds several
  --rpc <url>          JSON-RPC endpoint; repeat to add fallbacks
  --save-transfers <file>  also write the transfers read, for an offline re-check
  --json               print the report as JSON instead of a summary
  -h, --help           show this help

Environment:
  ${ENDPOINT_VARIABLE}  endpoints separated by spaces, used when --rpc is absent.
                      Put a keyed URL here: an argument is kept in shell
                      history and shown to other users in the process list.

Exit codes: 0 clean, 1 usage error, 2 the round could not be read,
3 the round is not clean.`;

interface ParsedCli {
  intent: string;
  decimals: number;
  token?: Hex;
  payers?: Hex[];
  round?: string;
  json: boolean;
  saveTransfers?: string;
  source:
    | { kind: "tx"; hashes: Hex[] }
    | { kind: "range"; fromBlock: number; toBlock: number | BlockTag }
    | { kind: "file"; path: string };
  rpc: string[];
}

export async function runTransferLedger(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ParsedCli;
  try {
    const result = parseCli(argv, io.env ?? {});
    if (result === "help") {
      io.stdout(USAGE);
      return EXIT.CLEAN;
    }
    parsed = result;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("");
    io.stderr(USAGE);
    return EXIT.USAGE;
  }

  const read = io.readFile ?? ((path: string) => readFile(path, "utf8"));
  const write = io.writeFile ?? ((path: string, data: string) => writeFile(path, data));
  try {
    const intentText = await read(parsed.intent);
    const intentOptions = parsed.round === undefined ? { decimals: parsed.decimals } : { decimals: parsed.decimals, round: parsed.round };
    const intents: Intent[] =
      extname(parsed.intent).toLowerCase() === ".json" ? parseIntentJson(intentText, intentOptions) : parseIntentCsv(intentText, intentOptions);

    const loaded = await loadTransfers(parsed, io, read);
    if (parsed.saveTransfers !== undefined) {
      await write(parsed.saveTransfers, serializeTransfers(loaded.token, loaded.read, loaded.source, loaded.chainId, loaded.payers));
    }

    const report = buildReport(reconcile(intents, loaded.transfers), {
      token: loaded.token,
      decimals: parsed.decimals,
      source: loaded.source,
      ...(parsed.round !== undefined ? { round: parsed.round } : {}),
      ...(loaded.chainId !== undefined ? { chainId: loaded.chainId } : {}),
      ...(loaded.transactions !== undefined ? { transactions: loaded.transactions } : {}),
      ...(io.now ? { now: io.now } : {}),
    });

    if (parsed.json) {
      io.stdout(JSON.stringify(report));
    } else {
      for (const line of summarize(report)) io.stdout(line);
    }
    return report.clean ? EXIT.CLEAN : EXIT.NOT_CLEAN;
  } catch (error) {
    if (error instanceof LedgerError || error instanceof WalkerError) {
      io.stderr(`${error.code}: ${error.message}`);
    } else {
      io.stderr(error instanceof Error ? error.message : String(error));
    }
    return EXIT.FAILED;
  }
}

interface Loaded {
  token: Hex;
  /** The round's payouts, after the payer rule. */
  transfers: Transfer[];
  /** Everything read, before the payer rule: what --save-transfers writes. */
  read: Transfer[];
  payers?: Hex[];
  source: string;
  chainId?: number;
  transactions?: TransactionStatus[];
}

async function loadTransfers(parsed: ParsedCli, io: CliIo, read: (path: string) => Promise<string>): Promise<Loaded> {
  if (parsed.source.kind === "file") {
    const saved = parseSavedTransfers(await read(parsed.source.path));
    if (parsed.token !== undefined && parsed.token !== saved.token) {
      throw new LedgerError("E_INVALID_ARGUMENT", `--token ${parsed.token} does not match the transfers file's token ${saved.token}`);
    }
    // --payer on the command line wins; otherwise the payers the round was read with apply again.
    const payers = parsed.payers ?? saved.payers;
    const transfers = payers === undefined ? saved.transfers : selectPayouts(saved.transfers, payers);
    const loaded: Loaded = { token: saved.token, transfers, read: saved.transfers, source: saved.source };
    if (payers !== undefined) loaded.payers = payers;
    if (saved.chainId !== undefined) loaded.chainId = saved.chainId;
    return loaded;
  }

  const token = parsed.token as Hex;
  const rpcOptions: Parameters<typeof createRpc>[0] = { urls: parsed.rpc };
  if (io.fetch) rpcOptions.fetch = io.fetch;
  const rpc: Rpc = createRpc(rpcOptions);
  // Every configured endpoint: the client fails over per call, so any of them may have answered.
  const source = [...new Set(parsed.rpc.map(redactEndpoint))].join(", ");
  const chainId = fromQuantity(await rpc.call<unknown>("eth_chainId", []));
  if (parsed.source.kind === "tx") {
    const fetched = await fetchTransfersByTransaction(rpc, {
      token,
      transactionHashes: parsed.source.hashes,
      ...(parsed.payers !== undefined ? { payers: parsed.payers } : {}),
    });
    const loaded: Loaded = { token, transfers: fetched.transfers, read: fetched.read, source, chainId, transactions: fetched.transactions };
    if (parsed.payers !== undefined) loaded.payers = parsed.payers;
    return loaded;
  }
  const fetched = await fetchTransfersByRange(rpc, {
    token,
    payers: parsed.payers as Hex[],
    fromBlock: parsed.source.fromBlock,
    toBlock: parsed.source.toBlock,
  });
  return { token, transfers: fetched.transfers, read: fetched.read, source, chainId, payers: parsed.payers as Hex[] };
}

/** The text summary: totals first, then one line per finding with everything needed to look it up. */
export function summarize(report: Report): string[] {
  const s = report.summary;
  const lines = [
    `token        ${report.token} (${report.decimals} decimals)${report.chainId !== undefined ? `, chain ${report.chainId}` : ""}`,
    ...(report.round !== undefined ? [`round        ${report.round}`] : []),
    `source       ${report.source}`,
  ];
  if (report.transactions !== undefined) {
    const failed = report.transactions.filter((tx) => !tx.succeeded);
    lines.push(`transactions ${report.transactions.length} read${failed.length > 0 ? `, ${failed.length} reverted: ${failed.map((tx) => tx.hash).join(", ")}` : ""}`);
  }
  lines.push(
    `intended     ${s.intendedCount} payment(s) to ${s.recipients} recipient(s), total ${s.intendedTotal.units}`,
    `paid         ${s.paidCount} transfer(s), total ${s.paidTotal.units}`,
  );
  if (s.repeatedInputs > 0) lines.push(`note         ${s.repeatedInputs} transfer(s) appeared more than once in the inputs and were counted once`);
  if (report.clean) {
    lines.push("result       clean: every intended payment was made once, at the intended amount, and nothing else was paid");
    return lines;
  }
  const counts = Object.entries(s.counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  lines.push(`result       NOT CLEAN: ${counts}`, "");
  for (const finding of report.findings) lines.push(describe(finding));
  return lines;
}

function describe(finding: ReportFinding): string {
  const at = (transfer: { transactionHash: Hex; logIndex: number }) => `${transfer.transactionHash}#${transfer.logIndex}`;
  const line = finding.line !== undefined ? ` (intent line ${finding.line})` : "";
  switch (finding.kind) {
    case "missing":
      return `missing     ${finding.recipient} ${finding.intended?.units}${line}: no transfer found`;
    case "duplicate":
      return `duplicate   ${finding.recipient} ${finding.transfer?.amount.units}${line}: paid again by ${at(finding.transfer!)}, already paid by ${at(finding.firstPaidBy!)}`;
    case "overpaid":
    case "underpaid":
      return `${finding.kind.padEnd(11)} ${finding.recipient} intended ${finding.intended?.units}, paid ${finding.transfer?.amount.units}${line} by ${at(finding.transfer!)}`;
    case "extra":
      return `extra       ${finding.recipient} ${finding.transfer?.amount.units}: matches none of this recipient's lines, by ${at(finding.transfer!)}`;
    case "unexpected":
      return `unexpected  ${finding.recipient} ${finding.transfer?.amount.units}: not on the payout list, by ${at(finding.transfer!)}`;
  }
}

function parseCli(argv: readonly string[], env: Record<string, string | undefined>): ParsedCli | "help" {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      intent: { type: "string" },
      decimals: { type: "string" },
      token: { type: "string" },
      payer: { type: "string", multiple: true },
      round: { type: "string" },
      tx: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      transfers: { type: "string" },
      rpc: { type: "string", multiple: true },
      "save-transfers": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) return "help";
  if (positionals.length > 0) throw new Error(`unexpected argument: ${positionals[0]}`);
  if (values.intent === undefined) throw new Error("missing --intent <file>");
  if (values.decimals === undefined) throw new Error("missing --decimals <n>; the intent amounts are in token units and need it to be read exactly");
  if (!/^\d+$/.test(values.decimals)) throw new Error(`--decimals expects a whole number, got ${values.decimals}`);
  const decimals = Number(values.decimals);
  assertDecimals(decimals);

  const token = values.token === undefined ? undefined : address(values.token, "--token");
  const payers = values.payer === undefined ? undefined : values.payer.map((value) => address(value, "--payer"));
  const sources = [values.tx !== undefined, values.from !== undefined, values.transfers !== undefined].filter(Boolean).length;
  if (sources !== 1) throw new Error("give exactly one transfers source: --tx, --from or --transfers");
  if (values.to !== undefined && values.from === undefined) throw new Error("--to needs --from <block>");

  let source: ParsedCli["source"];
  if (values.transfers !== undefined) {
    source = { kind: "file", path: values.transfers };
  } else {
    if (token === undefined) throw new Error("missing --token <address>");
    if (values.tx !== undefined) {
      for (const hash of values.tx) if (!isTransactionHash(hash)) throw new Error(`--tx ${hash} is not a 32-byte transaction hash`);
      source = { kind: "tx", hashes: values.tx as Hex[] };
    } else {
      if (payers === undefined) throw new Error("--from needs --payer <address>, so only the payout wallet's transfers are read");
      const to = values.to ?? "finalized";
      source = {
        kind: "range",
        fromBlock: block(values.from as string, "--from"),
        toBlock: to === "latest" || to === "finalized" || to === "safe" ? to : block(to, "--to"),
      };
    }
  }

  const rpc =
    values.rpc !== undefined && values.rpc.length > 0
      ? values.rpc
      : (env[ENDPOINT_VARIABLE] ?? "").split(/\s+/).filter((entry) => entry !== "");
  if (source.kind !== "file" && rpc.length === 0) throw new Error(`missing --rpc <url> (or ${ENDPOINT_VARIABLE})`);

  const result: ParsedCli = { intent: values.intent, decimals, json: values.json === true, source, rpc };
  if (token !== undefined) result.token = token;
  if (payers !== undefined) result.payers = payers;
  if (values.round !== undefined) result.round = values.round;
  if (values["save-transfers"] !== undefined) result.saveTransfers = values["save-transfers"];
  return result;
}

function address(value: string, flag: string): Hex {
  if (!isAddress(value)) throw new Error(`${flag} ${value} is not a 20-byte hex address`);
  return normalizeAddress(value);
}

function block(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a block number, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large`);
  return parsed;
}
