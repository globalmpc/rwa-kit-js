import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createRpc, type Rpc } from "@globalmpc/evm-log-walker";
import type { Alert } from "../alerts.js";
import { WatchError } from "../errors.js";
import { isAddress, type Address } from "../hex.js";
import { assertKeys, assertRecord, type WalletSpec } from "../spec.js";
import { watch } from "../watch.js";
import { createWatcher, type Report } from "../watcher.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Where `HOT_WALLET_WATCH_RPC` is read from. The bin passes `process.env`. */
  env?: Record<string, string | undefined>;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: typeof globalThis.fetch;
  /** File access, injectable so tests never touch disk. */
  readFile?: (path: string) => Promise<string>;
  /**
   * Called when `watch` starts; the signal it returns stops the loop. The bin aborts it on SIGINT and
   * SIGTERM. `check` never calls it, so it stays interruptible the default way.
   */
  watchSignal?: () => AbortSignal;
}

/** Endpoints separated by spaces, read when `--rpc` is absent. The place for a keyed URL. */
export const ENDPOINT_VARIABLE = "HOT_WALLET_WATCH_RPC";

export const EXIT = {
  CLEAN: 0,
  USAGE: 1,
  UNREACHABLE: 2,
  WARNING: 10,
  CRITICAL: 20,
} as const;

export const USAGE = `Usage: hot-wallet-watch <command> [options]

Watches hot wallets for the signs of a takeover: an EIP-7702 delegation to a
contract you did not approve, code at the address, a nonce rising without your
own send, and outflows above a set rate. Every reading is compared across the
endpoints given, and any one of them seeing trouble raises the alarm.

Commands:
  check                one pass over the wallets given with --wallet
  watch                pass after pass, from a config file, printing each
                        alert as one JSON line, until interrupted

Options for check:
  --wallet <addr>[=label]   a wallet to check; repeat for several
  --allow-delegate <addr>   an EIP-7702 delegate the wallets may carry; repeat
  --json                    print the report as JSON

Options for watch:
  --config <file>      wallets, endpoints and limits, as JSON (see the README)

Options for both:
  --rpc <url>          a JSON-RPC endpoint; repeat to add independent ones.
                        Use two or more providers: readings are compared
  --chain-id <n>       the chain the wallets live on; an endpoint on another
                        chain is left out. Default 56 (BNB Smart Chain), or
                        the config's "chainId"
  -h, --help           show this help

Environment:
  ${ENDPOINT_VARIABLE}  endpoints separated by spaces, used when --rpc is absent;
                        for watch it also wins over the config file's "rpc".
                        Put a keyed URL here: an argument is kept in shell
                        history and shown to other users in the process list.

Endpoints are named by position (endpoint-1, endpoint-2) in all output.

Exit codes for check: 0 no alert, 10 warnings only, 20 at least one critical
alert, 1 usage error, 2 no endpoint answered. watch exits 0 when interrupted
and 1 on a usage or config error. Either command exits 3 when its standard
output closes before it is done.`;

export async function runHotWalletWatch(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("Run hot-wallet-watch --help for usage.");
    return EXIT.USAGE;
  }
  if (parsed.command === "help") {
    io.stdout(USAGE);
    return EXIT.CLEAN;
  }
  try {
    return parsed.command === "check" ? await runCheck(parsed, io) : await runWatch(parsed, io);
  } catch (error) {
    if (error instanceof WatchError) {
      io.stderr(error.message);
      return EXIT.USAGE;
    }
    throw error;
  }
}

function parse(argv: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      rpc: { type: "string", multiple: true },
      wallet: { type: "string", multiple: true },
      "allow-delegate": { type: "string", multiple: true },
      config: { type: "string" },
      "chain-id": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { command: "help" as const };
  const [command, ...rest] = positionals;
  if (command !== "check" && command !== "watch") {
    // Echoed only when it looks like a command: a misplaced positional is often a keyed endpoint URL.
    throw new Error(command === undefined ? "missing command" : /^[a-z-]{1,20}$/.test(command) ? `unknown command "${command}"` : "unknown command; expected check or watch");
  }
  // Not echoed: a stray argument is often an endpoint URL, which can carry a key.
  if (rest.length > 0) throw new Error(`unexpected extra argument after "${command}"; endpoints go after --rpc`);
  if (command === "check" && values.config !== undefined) throw new Error("--config is for watch; check takes --wallet");
  if (command === "watch" && (values.wallet !== undefined || values["allow-delegate"] !== undefined)) throw new Error("watch reads its wallets from --config");
  if (command === "watch" && values.config === undefined) throw new Error("watch needs --config <file>");
  return {
    command: command === "check" ? ("check" as const) : ("watch" as const),
    rpc: values.rpc ?? [],
    wallets: values.wallet ?? [],
    delegates: values["allow-delegate"] ?? [],
    config: values.config,
    chainId: values["chain-id"] === undefined ? undefined : positiveWhole(values["chain-id"], "--chain-id"),
    json: values.json,
  };
}

type Parsed = Exclude<ReturnType<typeof parse>, { command: "help" }>;

async function runCheck(parsed: Parsed, io: CliIo): Promise<number> {
  if (parsed.wallets.length === 0) throw new WatchError("E_INVALID_ARGUMENT", "check needs at least one --wallet");
  const delegates = parsed.delegates.map((delegate) => address(delegate, "--allow-delegate"));
  const wallets: WalletSpec[] = parsed.wallets.map((value) => {
    const split = value.indexOf("=");
    const addr = split === -1 ? value : value.slice(0, split);
    const label = split === -1 ? undefined : value.slice(split + 1);
    return { address: address(addr, "--wallet"), ...(label === undefined || label === "" ? {} : { label }), delegates };
  });
  const urls = parsed.rpc.length > 0 ? parsed.rpc : splitEndpoints(io.env?.[ENDPOINT_VARIABLE]);
  const report = await createWatcher({ endpoints: endpoints(urls, io), chainId: parsed.chainId ?? DEFAULT_CHAIN_ID, wallets }).check();
  if (parsed.json) io.stdout(JSON.stringify(report, null, 2));
  else printReport(report, io);
  if (report.alerts.some((alert) => alert.kind === "no-endpoint")) return EXIT.UNREACHABLE;
  if (report.alerts.some((alert) => alert.severity === "critical")) return EXIT.CRITICAL;
  return report.alerts.length > 0 ? EXIT.WARNING : EXIT.CLEAN;
}

async function runWatch(parsed: Parsed, io: CliIo): Promise<number> {
  const read = io.readFile ?? ((path: string) => readFile(path, "utf8"));
  let text: string;
  try {
    text = await read(parsed.config ?? "");
  } catch (error) {
    // Only the error code: the message names the path, and a misplaced keyed URL can be that path.
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "unreadable";
    io.stderr(`could not read the config file (${code})`);
    return EXIT.USAGE;
  }
  const config = configFromJson(text);
  // --rpc, then the variable (the place for a keyed URL), then the config file.
  const fromEnv = splitEndpoints(io.env?.[ENDPOINT_VARIABLE]);
  const urls = parsed.rpc.length > 0 ? parsed.rpc : fromEnv.length > 0 ? fromEnv : config.rpc;
  await watch({
    endpoints: endpoints(urls, io),
    chainId: parsed.chainId ?? config.chainId ?? DEFAULT_CHAIN_ID,
    wallets: config.wallets,
    ...(config.intervalMs === undefined ? {} : { intervalMs: config.intervalMs }),
    ...(config.repeatAfterMs === undefined ? {} : { repeatAfterMs: config.repeatAfterMs }),
    ...(config.maxLagBlocks === undefined ? {} : { maxLagBlocks: config.maxLagBlocks }),
    ...(io.watchSignal === undefined ? {} : { signal: io.watchSignal() }),
    onAlert: (alert: Alert) => io.stdout(JSON.stringify(alert)),
  });
  return EXIT.CLEAN;
}

interface Config {
  rpc: string[];
  chainId: number | undefined;
  wallets: WalletSpec[];
  intervalMs: number | undefined;
  repeatAfterMs: number | undefined;
  maxLagBlocks: number | undefined;
}

/**
 * Reads a watch config. JSON has no bigint, so every `outflow.max` is a decimal string in base units.
 * `expectedNonce` cannot be written in JSON; use `frozen` for wallets that should never send, or the
 * library for a live nonce source.
 */
export function configFromJson(text: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's message quotes the text around the error, which can be a keyed endpoint URL.
    throw new WatchError("E_INVALID_ARGUMENT", "the config file is not valid JSON");
  }
  assertRecord(value, "config");
  assertKeys(value, ["rpc", "chainId", "wallets", "intervalMs", "repeatAfterMs", "maxLagBlocks"], "config");
  const config = value as Record<string, unknown>;
  const rpc = config["rpc"] ?? [];
  if (!Array.isArray(rpc) || rpc.some((url) => typeof url !== "string")) throw new WatchError("E_INVALID_ARGUMENT", "config.rpc must be a list of URLs");
  const wallets = config["wallets"];
  if (!Array.isArray(wallets)) throw new WatchError("E_INVALID_ARGUMENT", "config.wallets must be a list");
  return {
    rpc: rpc as string[],
    chainId: optionalNumber(config["chainId"], "config.chainId"),
    wallets: wallets.map((wallet: unknown, index) => walletFromJson(wallet, `config.wallets[${index}]`)),
    intervalMs: optionalNumber(config["intervalMs"], "config.intervalMs"),
    repeatAfterMs: optionalNumber(config["repeatAfterMs"], "config.repeatAfterMs"),
    maxLagBlocks: optionalNumber(config["maxLagBlocks"], "config.maxLagBlocks"),
  };
}

function walletFromJson(value: unknown, where: string): WalletSpec {
  assertRecord(value, where);
  if (Object.hasOwn(value, "expectedNonce")) throw new WatchError("E_INVALID_ARGUMENT", `${where}.expectedNonce cannot be set from JSON; use "frozen", or the library`);
  const wallet: Record<string, unknown> = { ...value };
  if (wallet["outflow"] !== undefined) wallet["outflow"] = outflowFromJson(wallet["outflow"], `${where}.outflow`);
  if (Array.isArray(wallet["tokens"])) {
    wallet["tokens"] = wallet["tokens"].map((token: unknown, index) => {
      if (typeof token !== "object" || token === null) return token;
      const copy: Record<string, unknown> = { ...token };
      copy["outflow"] = outflowFromJson(copy["outflow"], `${where}.tokens[${index}].outflow`);
      return copy;
    });
  }
  return wallet as unknown as WalletSpec;
}

function outflowFromJson(value: unknown, where: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = { ...value };
  const max = copy["max"];
  if (typeof max !== "string" || !/^\d+$/.test(max)) throw new WatchError("E_INVALID_ARGUMENT", `${where}.max must be a decimal string in base units, such as "1000000"`);
  copy["max"] = BigInt(max);
  return copy;
}

function optionalNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new WatchError("E_INVALID_ARGUMENT", `${where} must be a number`);
  return value;
}

/** Builds one client per URL; which source the URLs come from is decided by the caller. */
function endpoints(list: readonly string[], io: CliIo): Rpc[] {
  if (list.length === 0) throw new WatchError("E_INVALID_ARGUMENT", `give at least one endpoint with --rpc or ${ENDPOINT_VARIABLE}`);
  return list.map((url, index) => {
    if (!/^https?:\/\//i.test(url)) throw new WatchError("E_INVALID_ARGUMENT", `endpoint-${index + 1} is not an http(s) URL`);
    try {
      new URL(url);
      // No retries and a short timeout: the next pass is the retry, and abandoned calls must not pile up.
      return createRpc({ urls: url, timeoutMs: 5_000, retries: 0, ...(io.fetch === undefined ? {} : { fetch: io.fetch }) });
    } catch {
      throw new WatchError("E_INVALID_ARGUMENT", `endpoint-${index + 1} is not a valid URL`);
    }
  });
}

const DEFAULT_CHAIN_ID = 56;

function splitEndpoints(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter((url) => url !== "");
}

function positiveWhole(text: string, flag: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive whole number`);
  return value;
}

function address(value: string, flag: string): Address {
  if (!isAddress(value)) throw new WatchError("E_INVALID_ARGUMENT", `${flag} needs a 0x-prefixed 20-byte address`);
  return value;
}

function printReport(report: Report, io: CliIo): void {
  const used = report.endpoints.filter((endpoint) => endpoint.head !== null).map((endpoint) => endpoint.label);
  io.stdout(report.block === null ? "no endpoint answered" : `block ${report.block}, read from ${used.join(", ")}`);
  for (const wallet of report.wallets) {
    const code = wallet.code === null ? "unread" : wallet.code.kind === "delegated" ? `delegated to ${wallet.code.delegate}` : wallet.code.kind === "contract" ? "contract code" : "no code";
    io.stdout(`${wallet.label}: ${code}, nonce ${wallet.nonce ?? "?"}, balance ${wallet.balance ?? "?"} wei`);
  }
  for (const alert of report.alerts) io.stdout(`${alert.severity.toUpperCase()} ${alert.kind}: ${alert.message}`);
  if (report.alerts.length === 0) io.stdout("no alerts");
}
