import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Decision } from "../decision.js";
import { SignGuardError } from "../errors.js";
import { createSignGuard } from "../guard.js";
import { policyFromJson, requestsFromJson } from "../json.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** File access, injectable so tests never touch disk. Defaults to `node:fs/promises`. */
  readFile?: (path: string) => Promise<string>;
}

/** Exit codes, spaced like the other tools in this kit so a caller can test a range. */
export const EXIT = {
  ALLOWED: 0,
  USAGE: 1,
  FAILED: 2,
  DENIED: 20,
} as const;

export const USAGE = `Usage: sign-guard check --policy <file> [requests-file] [options]

Checks a signing policy, and optionally runs requests through it, without any
key. Use it in CI to prove a policy file is valid and refuses what it should.

Commands:
  check                validate the policy; with a requests file, judge each
                        request in order, windows included, and print why

Options:
  --policy <file>      the policy, as JSON (amounts as decimal strings)
  --now <ms>           clock for the first request, in milliseconds since the
                        epoch. Default: the current time
  --step <ms>          time between requests, for window tests. Default 0
  --json               print JSON instead of a summary
  -h, --help           show this help

Requests file: one request object or a list, each with "kind" set to
"transaction", "authorization", "typedData", "message" or "hash".

Exit codes: 0 every request allowed (or the policy is valid and no requests
were given), 20 at least one request refused, 1 usage error or invalid policy
or request file, 2 a file could not be read.`;

interface Options {
  policy: string;
  requests: string | undefined;
  now: number | undefined;
  step: number;
  json: boolean;
}

export async function runSignGuard(argv: readonly string[], io: CliIo): Promise<number> {
  let options: Options | "help";
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("Run sign-guard --help for usage.");
    return EXIT.USAGE;
  }
  if (options === "help") {
    io.stdout(USAGE);
    return EXIT.ALLOWED;
  }

  const read = io.readFile ?? ((path: string) => readFile(path, "utf8"));
  let policyText: string;
  let requestsText: string | undefined;
  try {
    policyText = await read(options.policy);
    requestsText = options.requests === undefined ? undefined : await read(options.requests);
  } catch (error) {
    io.stderr(`could not read a file: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.FAILED;
  }

  let clock = options.now ?? Date.now();
  try {
    const guard = createSignGuard(policyFromJson(policyText), { now: () => clock });
    const requests = requestsText === undefined ? [] : requestsFromJson(requestsText);
    const decisions: Decision[] = [];
    for (const request of requests) {
      decisions.push(await guard.check(request));
      clock += options.step;
    }
    const denied = decisions.filter((decision) => !decision.allowed).length;
    if (options.json) {
      io.stdout(JSON.stringify({ policy: "valid", allowed: decisions.length - denied, denied, decisions }, bigintAsString, 2));
    } else {
      io.stdout(requests.length === 0 ? "policy is valid" : `policy is valid; ${decisions.length - denied} allowed, ${denied} refused`);
      decisions.forEach((decision, index) => io.stdout(formatDecision(index + 1, decision)));
    }
    return denied > 0 ? EXIT.DENIED : EXIT.ALLOWED;
  } catch (error) {
    if (error instanceof SignGuardError) {
      io.stderr(`${error.code === "E_INVALID_POLICY" ? "invalid policy" : "invalid request"}: ${error.message}`);
      return EXIT.USAGE;
    }
    throw error;
  }
}

function parseOptions(argv: readonly string[]): Options | "help" {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      policy: { type: "string" },
      now: { type: "string" },
      step: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return "help";
  const [command, requests, ...rest] = positionals;
  if (command !== "check") throw new Error(command === undefined ? "missing command" : `unknown command "${command}"`);
  if (rest.length > 0) throw new Error(`unexpected argument "${rest[0]}"`);
  if (values.policy === undefined) throw new Error("--policy is required");
  return {
    policy: values.policy,
    requests,
    now: values.now === undefined ? undefined : wholeNumber(values.now, "--now"),
    step: values.step === undefined ? 0 : wholeNumber(values.step, "--step"),
    json: values.json,
  };
}

function wholeNumber(text: string, flag: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) throw new Error(`${flag} must be a whole number of milliseconds`);
  return value;
}

function formatDecision(position: number, decision: Decision): string {
  const verdict = decision.allowed ? "allowed" : `REFUSED ${decision.rule}`;
  return `${position}. ${decision.kind}: ${verdict} (${decision.reason})`;
}

function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
