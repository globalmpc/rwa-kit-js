import { SignGuardError } from "./errors.js";
import type { SignPolicy } from "./policy.js";
import type { SignRequest } from "./request.js";

/**
 * Reads a policy written as JSON. JSON has no bigint, so amounts (`maxValue`, `maxAmount`, every
 * `window.max` except the authorization count) are decimal strings in base units: `"1000000"`, not
 * `1000000` or `1e6`, because a JSON number cannot hold every amount exactly. Everything else is
 * checked by `createSignGuard` exactly as for a policy written in code.
 */
export function policyFromJson(text: string): SignPolicy {
  const value = parse(text, "policy", "E_INVALID_POLICY");
  if (!isRecord(value)) return invalid("E_INVALID_POLICY", "the policy file must hold one JSON object");
  const policy: Record<string, unknown> = { ...value };
  if (isRecord(value["transactions"])) {
    const transactions: Record<string, unknown> = { ...value["transactions"] };
    convertAmount(transactions, "maxValue", "transactions.maxValue");
    convertWindow(transactions, "transactions.window");
    if (Array.isArray(transactions["tokens"])) {
      transactions["tokens"] = transactions["tokens"].map((rule: unknown, index) => {
        if (!isRecord(rule)) return rule;
        const copy: Record<string, unknown> = { ...rule };
        convertAmount(copy, "maxAmount", `transactions.tokens[${index}].maxAmount`);
        convertWindow(copy, `transactions.tokens[${index}].window`);
        return copy;
      });
    }
    policy["transactions"] = transactions;
  }
  return policy as unknown as SignPolicy;
}

/**
 * Reads one request or a list of them, in the shape `SignRequest` describes. `transaction.value`
 * is a decimal string in wei; a typed-data `domain.chainId` may be a number or a decimal string.
 */
export function requestsFromJson(text: string): SignRequest[] {
  const value = parse(text, "requests", "E_INVALID_ARGUMENT");
  const list = Array.isArray(value) ? value : [value];
  return list.map((item: unknown, index) => {
    const where = `request ${index + 1}`;
    if (!isRecord(item) || typeof item["kind"] !== "string") {
      return invalid("E_INVALID_ARGUMENT", `${where} must be an object with a "kind"`);
    }
    const request: Record<string, unknown> = { ...item };
    if (item["kind"] === "transaction" && isRecord(item["transaction"])) {
      const transaction: Record<string, unknown> = { ...item["transaction"] };
      convertAmount(transaction, "value", `${where}: transaction.value`, "E_INVALID_ARGUMENT");
      request["transaction"] = transaction;
    }
    if (item["kind"] === "typedData" && isRecord(item["typedData"]) && isRecord(item["typedData"]["domain"])) {
      const domain: Record<string, unknown> = { ...item["typedData"]["domain"] };
      if (typeof domain["chainId"] === "string" && /^\d+$/.test(domain["chainId"])) domain["chainId"] = BigInt(domain["chainId"]);
      request["typedData"] = { ...item["typedData"], domain };
    }
    return request as unknown as SignRequest;
  });
}

function convertWindow(parent: Record<string, unknown>, where: string): void {
  if (!isRecord(parent["window"])) return;
  const window: Record<string, unknown> = { ...parent["window"] };
  convertAmount(window, "max", `${where}.max`);
  parent["window"] = window;
}

function convertAmount(
  parent: Record<string, unknown>,
  key: string,
  where: string,
  code: "E_INVALID_POLICY" | "E_INVALID_ARGUMENT" = "E_INVALID_POLICY",
): void {
  const value = parent[key];
  if (value === undefined) return;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    invalid(code, `${where} must be a decimal string in base units, such as "1000000"`);
  }
  parent[key] = BigInt(value);
}

function parse(text: string, what: string, code: "E_INVALID_POLICY" | "E_INVALID_ARGUMENT"): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    return invalid(code, `the ${what} file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: "E_INVALID_POLICY" | "E_INVALID_ARGUMENT", message: string): never {
  throw new SignGuardError(code, message);
}
