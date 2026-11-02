import { WatchError } from "./errors.js";
import { isAddress, normalizeAddress, type Address } from "./hex.js";

/** An outflow cap: at most `max` base units leaving within any `durationMs`. */
export interface OutflowLimit {
  durationMs: number;
  max: bigint;
}

/** An ERC-20 balance to watch for outflows. */
export interface TokenWatch {
  token: Address;
  outflow: OutflowLimit;
}

/** One wallet to watch, and what counts as trouble for it. */
export interface WalletSpec {
  address: Address;
  /** A name for alerts. Default: the address. */
  label?: string;
  /**
   * EIP-7702 delegates this wallet may carry. A delegation to any other contract is an alert. Default
   * none: an ordinary hot wallet has no code at all.
   */
  delegates?: readonly Address[];
  /**
   * The wallet is a smart contract (a Safe, a vault): its code is expected and not checked. Its nonce
   * and outflows still are.
   */
  contract?: boolean;
  /**
   * The wallet should never send: any rise in its nonce after the first reading is an alert. For
   * cold and treasury wallets.
   */
  frozen?: boolean;
  /**
   * The number of transactions your own system has sent from this wallet. A higher nonce on chain
   * means someone else signed with the key. Called once per pass.
   */
  expectedNonce?: () => number | Promise<number>;
  /** Native outflow cap, measured as the fall in balance between readings, net of deposits. */
  outflow?: OutflowLimit;
  /** ERC-20 outflow caps, measured the same way. */
  tokens?: readonly TokenWatch[];
}

export interface ResolvedWallet {
  address: Address;
  label: string;
  delegates: ReadonlySet<Address>;
  contract: boolean;
  frozen: boolean;
  expectedNonce: (() => number | Promise<number>) | undefined;
  outflow: OutflowLimit | undefined;
  tokens: readonly TokenWatch[];
}

/** Validates wallet specs. Unknown keys are refused, so a misspelt rule fails loudly. */
export function resolveWallets(wallets: unknown): ResolvedWallet[] {
  if (!Array.isArray(wallets) || wallets.length === 0) fail("wallets must be a non-empty list");
  const seen = new Set<Address>();
  return wallets.map((wallet: unknown, index) => {
    const where = `wallets[${index}]`;
    assertRecord(wallet, where);
    assertKeys(wallet, ["address", "label", "delegates", "contract", "frozen", "expectedNonce", "outflow", "tokens"], where);
    const spec = wallet as Partial<Record<keyof WalletSpec, unknown>>;
    const address = resolveAddress(spec.address, `${where}.address`);
    if (seen.has(address)) fail(`${where}.address is listed twice`);
    seen.add(address);
    if (spec.label !== undefined && (typeof spec.label !== "string" || spec.label === "")) fail(`${where}.label must be a non-empty string`);
    for (const flag of ["contract", "frozen"] as const) {
      if (spec[flag] !== undefined && typeof spec[flag] !== "boolean") fail(`${where}.${flag} must be true or false`);
    }
    if (spec.expectedNonce !== undefined && typeof spec.expectedNonce !== "function") fail(`${where}.expectedNonce must be a function`);
    const tokens = listOf(spec.tokens, `${where}.tokens`).map((token, at) => {
      const tokenWhere = `${where}.tokens[${at}]`;
      assertRecord(token, tokenWhere);
      assertKeys(token, ["token", "outflow"], tokenWhere);
      const entry = token as Partial<Record<keyof TokenWatch, unknown>>;
      return { token: resolveAddress(entry.token, `${tokenWhere}.token`), outflow: resolveOutflow(entry.outflow, `${tokenWhere}.outflow`) };
    });
    if (new Set(tokens.map((token) => token.token)).size !== tokens.length) fail(`${where}.tokens lists a token twice`);
    return {
      address,
      label: typeof spec.label === "string" ? spec.label : address,
      delegates: new Set(listOf(spec.delegates, `${where}.delegates`).map((delegate, at) => resolveAddress(delegate, `${where}.delegates[${at}]`))),
      contract: spec.contract === true,
      frozen: spec.frozen === true,
      expectedNonce: spec.expectedNonce as ResolvedWallet["expectedNonce"],
      outflow: spec.outflow === undefined ? undefined : resolveOutflow(spec.outflow, `${where}.outflow`),
      tokens,
    };
  });
}

function resolveOutflow(value: unknown, where: string): OutflowLimit {
  assertRecord(value, where);
  assertKeys(value, ["durationMs", "max"], where);
  const { durationMs, max } = value as Partial<Record<keyof OutflowLimit, unknown>>;
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0) fail(`${where}.durationMs must be a positive whole number of milliseconds`);
  if (typeof max !== "bigint" || max < 0n) fail(`${where}.max must be a bigint of 0 or more, in base units`);
  return { durationMs, max };
}

function resolveAddress(value: unknown, where: string): Address {
  if (!isAddress(value)) fail(`${where} must be a 0x-prefixed 20-byte address`);
  return normalizeAddress(value);
}

function listOf(value: unknown, where: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${where} must be a list`);
  return value;
}

export function assertRecord(value: unknown, where: string): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
}

export function assertKeys(value: object, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where} has an unknown key "${key}"; allowed: ${allowed.join(", ")}`);
  }
}

function fail(message: string): never {
  throw new WatchError("E_INVALID_ARGUMENT", message);
}
