import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRpc, redactEndpoint, WalkerError, type BlockTag } from "@globalmpc/evm-log-walker";
import { StatsError } from "../errors.js";
import { isAddress, type Hex } from "../hex.js";
import { renderPage } from "../page/render.js";
import { DOCUMENT_THEME, DARK_THEME, LIGHT_THEME, type PageTheme } from "../page/theme.js";
import { computeReport } from "../report.js";
import { DEFAULT_NETWORK, isNetworkName, listNetworks, NETWORKS, type NetworkName } from "./networks.js";

/** CLI-selectable built-in themes. A fully custom theme is a library-level option (`renderPage`'s `theme`). */
const THEME_PRESETS: Readonly<Record<string, PageTheme>> = { document: DOCUMENT_THEME, dark: DARK_THEME, light: LIGHT_THEME };
const DEFAULT_THEME_NAME = "document";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: typeof globalThis.fetch;
  /** Where `DAPP_STATS_RPC` is read from. The bin passes `process.env`. */
  env?: Record<string, string | undefined>;
  /** Overrides the clock, in milliseconds since epoch. For tests only. */
  now?: () => number;
  /** Filesystem writes, injectable so tests never touch disk. Defaults to `node:fs/promises`. */
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  /**
   * Opens a path with the OS's default handler, for `--open`. Defaults to `open` (macOS),
   * `rundll32 url.dll,FileProtocolHandler` (Windows) or `xdg-open` (everything else) via
   * `node:child_process` — no new
   * dependency. Best-effort: a failure (headless server, no display) is reported on stderr but
   * does not change the exit code, since the report was already written either way.
   */
  open?: (path: string) => Promise<void>;
}

/** Endpoints separated by spaces, read when `--rpc` is absent. The place for a keyed URL. */
export const ENDPOINT_VARIABLE = "DAPP_STATS_RPC";

/** Re-exported so a caller checking what the CLI defaults to doesn't need to import `./networks.js` too. */
export { NETWORKS } from "./networks.js";

export const USAGE = `Usage: dapp-stats <address> --out <dir> [--rpc <url>...] [options]

Reads every Transfer log for <address> and writes a dated JSON report plus a
regenerated index.html into --out. Holders are replayed from the contract's
creation block regardless of --days; --days only trims how many of the most
recent UTC days are published.

Options:
  --rpc <url>        JSON-RPC endpoint; repeat to add fallbacks. Takes
                      precedence over --network and ${ENDPOINT_VARIABLE}
  --network <name>   a known chain's public endpoints, used when --rpc and
                      ${ENDPOINT_VARIABLE} are both absent (default: ${DEFAULT_NETWORK}).
                      One of: ${listNetworks().join(", ")}.
                      Rate-limited, no archive history, EVM chains only
  --testnet          use --network's testnet endpoints instead of mainnet
  --out <dir>        output directory (required)
  --days <n>         days of history to publish (default 30)
  --from <block>     first block of the walk (default: the contract's creation block;
                      needs an archive endpoint if omitted)
  --from-is-creation --from is the contract's creation block. Without it, an
                      explicit --from publishes holders as not available
  --to <block|tag>   last block, inclusive (default finalized)
  --label <text>     a human name for the contract, shown on the page
  --theme <name>     page color theme: ${Object.keys(THEME_PRESETS).join(", ")} (default: ${DEFAULT_THEME_NAME})
  --json             print the computed report to stdout instead of a summary
  --open             open the written index.html in the default browser
  -h, --help         show this help

Environment:
  ${ENDPOINT_VARIABLE}  endpoints separated by spaces, used when --rpc is absent,
                      overriding --network. Put a keyed URL here: an argument
                      is kept in shell history and shown to other users in
                      the process list.`;

/** Exit codes: 0 written, 1 usage error, 2 the report could not be computed. */
export async function runDappStats(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ParsedCli;
  let rpc: ReturnType<typeof createRpc>;
  try {
    const result = parseCli(argv, io.env ?? {});
    if (result === "help") {
      io.stdout(USAGE);
      return 0;
    }
    parsed = result;
    if (parsed.usingDefaultRpc) {
      const label = `${parsed.network}${parsed.testnet ? " testnet" : ""}`;
      io.stderr(
        `note: no --rpc given; using the public "${label}" endpoint(s) (${parsed.rpc.join(", ")}), which are rate-limited ` +
          `and do not serve archive history. Pass --rpc or set ${ENDPOINT_VARIABLE} for your own.`,
      );
    }
    const rpcOptions: Parameters<typeof createRpc>[0] = { urls: parsed.rpc };
    if (io.fetch) rpcOptions.fetch = io.fetch;
    rpc = createRpc(rpcOptions);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("");
    io.stderr(USAGE);
    return 1;
  }

  try {
    const report = await computeReport({
      rpc,
      address: parsed.address,
      // Every configured endpoint: the client fails over per call, so any of them may have served
      // part of the data, and naming only the first would claim a source that may not be true.
      sourceLabel: [...new Set(parsed.rpc.map(redactEndpoint))].join(", "),
      days: parsed.days,
      ...(parsed.from !== undefined ? { fromBlock: parsed.from, fromBlockIsCreation: parsed.fromIsCreation } : {}),
      ...(parsed.to !== undefined ? { toBlock: parsed.to } : {}),
      ...(parsed.label !== undefined ? { label: parsed.label } : {}),
      ...(io.now ? { now: io.now } : {}),
    });

    const writeDir = io.mkdir ?? mkdir;
    const writeFn = io.writeFile ?? writeFile;
    const lastDate = report.days.at(-1)?.date ?? new Date((io.now ?? Date.now)()).toISOString().slice(0, 10);
    const jsonPath = join(parsed.out, "data", `${lastDate}.json`);
    const htmlPath = join(parsed.out, "index.html");
    await writeDir(join(parsed.out, "data"), { recursive: true });
    await writeFn(jsonPath, JSON.stringify(report, null, 2));
    await writeFn(htmlPath, renderPage(report, { theme: parsed.theme }));

    if (parsed.open) {
      const openFn = io.open ?? openInBrowser;
      try {
        await openFn(resolve(htmlPath));
      } catch (error) {
        io.stderr(`note: could not open a browser automatically (${error instanceof Error ? error.message : String(error)}); open ${htmlPath} yourself.`);
      }
    }

    if (parsed.json) {
      io.stdout(JSON.stringify(report));
    } else {
      io.stdout(`address     ${report.contract.address}`);
      io.stdout(`chain       ${report.chain.chainId}`);
      io.stdout(`days        ${report.days.length}`);
      io.stdout(`written     ${jsonPath}`);
      io.stdout(`written     ${htmlPath}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof StatsError || error instanceof WalkerError) {
      io.stderr(`${error.code}: ${error.message}`);
    } else {
      io.stderr(error instanceof Error ? error.message : String(error));
    }
    return 2;
  }
}

/**
 * No new dependency: runs the OS's own opener rather than an `open`-style npm package. The path is
 * passed as an argument, never spliced into a shell command, so quotes or `$(...)` in `--out`
 * cannot run anything. Windows uses `rundll32` rather than `cmd /c start`, because `cmd.exe`
 * re-parses its own command line and would treat `&` or `|` in the path as command separators.
 */
function openInBrowser(path: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", path]]
        : ["xdg-open", [path]];
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, (error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

interface ParsedCli {
  json: boolean;
  address: Hex;
  rpc: string[];
  usingDefaultRpc: boolean;
  network: NetworkName;
  testnet: boolean;
  out: string;
  days: number;
  open: boolean;
  theme: PageTheme;
  from?: number;
  fromIsCreation: boolean;
  to?: number | BlockTag;
  label?: string;
}

function parseCli(argv: readonly string[], env: Record<string, string | undefined>): ParsedCli | "help" {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      rpc: { type: "string", multiple: true },
      network: { type: "string" },
      testnet: { type: "boolean" },
      out: { type: "string" },
      days: { type: "string" },
      from: { type: "string" },
      "from-is-creation": { type: "boolean" },
      to: { type: "string" },
      label: { type: "string" },
      theme: { type: "string" },
      json: { type: "boolean" },
      open: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) return "help";
  const [address, ...extra] = positionals;
  if (address === undefined) throw new Error("missing <address>");
  if (extra.length > 0) throw new Error(`unexpected argument: ${extra[0]}`);
  if (!isAddress(address)) throw new Error(`${address} is not a 20-byte hex address`);
  if (values.out === undefined) throw new Error("missing --out <dir>");

  const network = values.network ?? DEFAULT_NETWORK;
  if (!isNetworkName(network)) {
    throw new Error(`--network must be one of: ${listNetworks().join(", ")} (got ${network})`);
  }
  const testnet = values.testnet === true;
  const { urls: rpc, usedDefault: usingDefaultRpc } = resolveEndpoints(values.rpc, env[ENDPOINT_VARIABLE], network, testnet);
  const days = values.days !== undefined ? parsePositiveInt(values.days, "--days") : 30;

  const themeName = values.theme ?? DEFAULT_THEME_NAME;
  const theme = THEME_PRESETS[themeName];
  if (theme === undefined) {
    throw new Error(`--theme must be one of: ${Object.keys(THEME_PRESETS).join(", ")} (got ${themeName})`);
  }

  const result: ParsedCli = {
    json: values.json === true,
    address,
    rpc,
    usingDefaultRpc,
    network,
    testnet,
    out: values.out,
    days,
    open: values.open === true,
    theme,
    fromIsCreation: values["from-is-creation"] === true,
  };
  if (values.from !== undefined) result.from = parseBlock(values.from, "--from");
  if (result.fromIsCreation && result.from === undefined) throw new Error("--from-is-creation needs --from <block>");
  if (values.to !== undefined) {
    result.to = values.to === "latest" || values.to === "finalized" || values.to === "safe" ? values.to : parseBlock(values.to, "--to");
  }
  if (values.label !== undefined) result.label = values.label;
  return result;
}

/** `--rpc` flags, then the variable, then `--network`'s (or the default network's) public endpoints. */
function resolveEndpoints(
  flags: string[] | undefined,
  variable: string | undefined,
  network: NetworkName,
  testnet: boolean,
): { urls: string[]; usedDefault: boolean } {
  if (flags !== undefined && flags.length > 0) {
    return { urls: flags, usedDefault: false };
  }
  const fromEnv = (variable ?? "").split(/\s+/).filter((entry) => entry !== "");
  if (fromEnv.length > 0) {
    return { urls: fromEnv, usedDefault: false };
  }
  const endpoints = NETWORKS[network];
  return { urls: [...(testnet ? endpoints.testnet : endpoints.mainnet)], usedDefault: true };
}

function parseBlock(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a block number, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large`);
  return parsed;
}

function parsePositiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${flag} expects a positive integer, got ${value}`);
  return Number(value);
}
