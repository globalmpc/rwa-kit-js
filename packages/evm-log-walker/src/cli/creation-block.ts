import { parseArgs } from "node:util";
import { findCreationBlock } from "../creation-block.js";
import { WalkerError } from "../errors.js";
import { isAddress, type Hex } from "../hex.js";
import { createRpc } from "../rpc.js";
import type { BlockTag } from "../walk.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Replacement for the global `fetch`, for tests. */
  fetch?: typeof globalThis.fetch;
  /** Where `CREATION_BLOCK_RPC` is read from. The bin passes `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Endpoints separated by spaces, read when `--rpc` is absent. The place for a keyed URL. */
export const ENDPOINT_VARIABLE = "CREATION_BLOCK_RPC";

export const USAGE = `Usage: creation-block <address> [--rpc <url>...] [options]

Finds the block a contract was deployed in by bisecting eth_getCode, then
checks the block for the deployment receipt. The endpoint must serve past
state (archive); public BNB Chain and opBNB endpoints do not.

Options:
  --rpc <url>        JSON-RPC endpoint; repeat to add fallbacks
  --from <block>     a block before the deployment (default 0)
  --to <block|tag>   a block at which the contract exists (default latest)
  --json             print the result as JSON
  -h, --help         show this help

Environment:
  ${ENDPOINT_VARIABLE}  endpoints separated by spaces, used when --rpc is absent.
                      Put a keyed URL here: an argument is kept in shell
                      history and shown to other users in the process list.`;

/** Exit codes: 0 found, 1 usage error, 2 lookup failed. */
export async function runCreationBlock(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseCli>;
  let rpc: ReturnType<typeof createRpc>;
  try {
    parsed = parseCli(argv, io.env ?? {});
    if (parsed.help) {
      io.stdout(USAGE);
      return 0;
    }
    const rpcOptions: Parameters<typeof createRpc>[0] = { urls: parsed.rpc };
    if (io.fetch) rpcOptions.fetch = io.fetch;
    // The client validates the endpoints; a bad one is the user's argument, so a usage error.
    rpc = createRpc(rpcOptions);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("");
    io.stderr(USAGE);
    return 1;
  }

  try {
    const result = await findCreationBlock(rpc, parsed.address, parsed.range);
    if (parsed.json) {
      io.stdout(JSON.stringify(result));
    } else {
      io.stdout(`address   ${result.address}`);
      io.stdout(`creation  ${result.blockNumber}`);
      io.stdout(
        result.verification === "confirmed"
          ? "verified  yes (deployment receipt found in that block)"
          : "verified  no (no deployment receipt in that block; see README)",
      );
      io.stdout(`probes    ${result.probes}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof WalkerError) {
      io.stderr(`${error.code}: ${error.message}`);
    } else {
      io.stderr(error instanceof Error ? error.message : String(error));
    }
    return 2;
  }
}

interface ParsedCli {
  help: boolean;
  json: boolean;
  address: Hex;
  rpc: string[];
  range: { fromBlock?: number; toBlock?: number | BlockTag };
}

function parseCli(argv: readonly string[], env: Record<string, string | undefined>): ParsedCli {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      rpc: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  const help = values.help === true;
  if (help) {
    return { help, json: false, address: "0x", rpc: [], range: {} };
  }
  const [address, ...extra] = positionals;
  if (address === undefined) throw new Error("missing <address>");
  if (extra.length > 0) throw new Error(`unexpected argument: ${extra[0]}`);
  if (!isAddress(address)) throw new Error(`${address} is not a 20-byte hex address`);
  const rpc = parseEndpoints(values.rpc, env[ENDPOINT_VARIABLE]);

  const range: ParsedCli["range"] = {};
  if (values.from !== undefined) range.fromBlock = parseBlock(values.from, "--from");
  if (values.to !== undefined) {
    range.toBlock =
      values.to === "latest" || values.to === "finalized" || values.to === "safe" ? values.to : parseBlock(values.to, "--to");
  }
  return { help, json: values.json === true, address, rpc, range };
}

/** `--rpc` flags, or else the variable. Validation is the client's, so it lives in one place. */
function parseEndpoints(flags: string[] | undefined, variable: string | undefined): string[] {
  const endpoints =
    flags !== undefined && flags.length > 0
      ? flags
      : (variable ?? "").split(/\s+/).filter((entry) => entry !== "");
  if (endpoints.length === 0) throw new Error(`missing --rpc <url> (or ${ENDPOINT_VARIABLE})`);
  return endpoints;
}

function parseBlock(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a block number, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large`);
  return parsed;
}
