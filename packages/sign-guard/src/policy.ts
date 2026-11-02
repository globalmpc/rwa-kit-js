import { SignGuardError } from "./errors.js";
import { isAddress, isSelector, normalizeAddress, ZERO_ADDRESS, type Address, type Hex } from "./hex.js";

/** A spend cap over a sliding window: at most `max` base units within any `durationMs`. */
export interface SpendWindow {
  durationMs: number;
  max: bigint;
}

/** A count cap over a sliding window: at most `max` signatures within any `durationMs`. */
export interface CountWindow {
  durationMs: number;
  max: number;
}

/**
 * One contract the key may call, and the functions it may call there. `selectors` lists 4-byte
 * function selectors; `"0x"` stands for a call with no calldata, a plain value transfer. There is
 * no wildcard: a contract allowed "any function" is a contract that can be asked to do anything.
 */
export interface CallRule {
  to: Address;
  selectors: readonly Hex[];
}

/**
 * An ERC-20 the key may send with `transfer(address,uint256)`. The amount in the calldata is
 * capped per transaction and, optionally, per window. `recipients`, when given, is the only set
 * of addresses the token may be sent to. Other functions on the token, `approve` included, are
 * refused unless a `CallRule` names them.
 */
export interface TokenRule {
  token: Address;
  maxAmount: bigint;
  window?: SpendWindow;
  recipients?: readonly Address[];
}

export interface TransactionPolicy {
  calls?: readonly CallRule[];
  tokens?: readonly TokenRule[];
  /** Largest native value one transaction may carry, in wei. Default 0: no native value at all. */
  maxValue?: bigint;
  /** Native value allowed across transactions in a sliding window, in wei. */
  window?: SpendWindow;
  /** Whether a transaction without `to` (a contract deployment) may be signed. Default false. */
  allowContractCreation?: boolean;
}

/**
 * EIP-7702 delegations the key may sign. An authorization to any other contract is refused, and
 * so is one with chain id 0, which is valid on every chain. An authorization to the zero address
 * clears a delegation and is allowed on a policy chain without an entry, counted in its own window.
 */
export interface AuthorizationPolicy {
  allow: readonly Address[];
  /** How many delegations may be signed per window, across the policy's chains. Default one per hour. */
  window?: CountWindow;
  /**
   * How many delegation resets may be signed per window, across the policy's chains. Default 25 per hour: enough for a
   * `presignResets` set, few enough that the key cannot be made to hand out resets without end (each
   * one, broadcast, uses up a nonce of the account).
   */
  resetWindow?: CountWindow;
}

/**
 * Typed data (EIP-712) the key may sign: a domain naming `verifyingContract` and the policy's chain,
 * and a primary type from `primaryTypes`. `name`, when given, must match the domain exactly.
 */
export interface TypedDataRule {
  verifyingContract: Address;
  name?: string;
  primaryTypes: readonly string[];
}

/** Text messages (EIP-191 `personal_sign`) the key may sign: those starting with a listed prefix. */
export interface MessagePolicy {
  prefixes: readonly string[];
}

/**
 * What a key may sign. Everything not named here is refused: a policy with only `chainIds` signs
 * nothing but delegation resets (see `AuthorizationPolicy.resetWindow`). Raw hash signing is refused
 * under every policy and has no setting.
 */
export interface SignPolicy {
  /** Chains a signature may be valid on. Required and non-empty. */
  chainIds: readonly number[];
  transactions?: TransactionPolicy;
  authorizations?: AuthorizationPolicy;
  typedData?: readonly TypedDataRule[];
  messages?: MessagePolicy;
}

export interface ResolvedTokenRule {
  token: Address;
  maxAmount: bigint;
  window: SpendWindow | undefined;
  /** Undefined means any recipient. */
  recipients: ReadonlySet<Address> | undefined;
}

export interface ResolvedTypedDataRule {
  verifyingContract: Address;
  name: string | undefined;
  primaryTypes: ReadonlySet<string>;
}

/** A validated policy with addresses in lower case and every default filled in. */
export interface ResolvedPolicy {
  readonly chainIds: ReadonlySet<number>;
  readonly transactions: {
    readonly calls: ReadonlyMap<Address, ReadonlySet<Hex>>;
    readonly tokens: ReadonlyMap<Address, ResolvedTokenRule>;
    readonly maxValue: bigint;
    readonly window: SpendWindow | undefined;
    readonly allowContractCreation: boolean;
  };
  readonly authorizations: {
    readonly allow: ReadonlySet<Address>;
    readonly window: CountWindow;
    readonly resetWindow: CountWindow;
  };
  readonly typedData: readonly ResolvedTypedDataRule[];
  readonly messages: readonly string[];
}

export const DEFAULT_AUTHORIZATION_WINDOW: CountWindow = Object.freeze({ durationMs: 3_600_000, max: 1 });
export const DEFAULT_RESET_WINDOW: CountWindow = Object.freeze({ durationMs: 3_600_000, max: 25 });

/**
 * Validates a policy and fills in its defaults. Unknown keys are refused rather than ignored, so a
 * misspelt rule fails loudly instead of quietly leaving the key with different limits than its
 * author wrote down.
 */
export function resolvePolicy(policy: SignPolicy): ResolvedPolicy {
  assertRecord(policy, "policy");
  assertKeys(policy, ["chainIds", "transactions", "authorizations", "typedData", "messages"], "policy");
  const resolved: ResolvedPolicy = {
    chainIds: resolveChainIds(policy.chainIds),
    transactions: resolveTransactions(policy.transactions),
    authorizations: resolveAuthorizations(policy.authorizations),
    typedData: resolveTypedData(policy.typedData),
    messages: resolveMessages(policy.messages),
  };
  assertOneChainForContracts(resolved);
  return resolved;
}

/**
 * A rule names a contract by address, and the same address can be a different contract on another
 * chain (a reused deployer nonce, a different deployment). So a policy that names contracts covers
 * exactly one chain; give each chain its own policy.
 */
function assertOneChainForContracts(policy: ResolvedPolicy): void {
  if (policy.chainIds.size < 2) return;
  const names =
    policy.transactions.calls.size > 0 ||
    policy.transactions.tokens.size > 0 ||
    policy.authorizations.allow.size > 0 ||
    policy.typedData.length > 0;
  if (names) {
    fail("a policy that names contracts (calls, tokens, authorizations.allow, typedData) must have exactly one chain id: the same address can be a different contract on another chain; give each chain its own policy");
  }
}

function resolveChainIds(chainIds: unknown): ReadonlySet<number> {
  if (!Array.isArray(chainIds) || chainIds.length === 0) {
    fail("chainIds must be a non-empty list: a signature valid on an unnamed chain can be replayed there");
  }
  for (const chainId of chainIds) assertChainId(chainId, "chainIds");
  return new Set(chainIds as number[]);
}

function resolveTransactions(input: TransactionPolicy | undefined): ResolvedPolicy["transactions"] {
  if (input === undefined) {
    return { calls: new Map(), tokens: new Map(), maxValue: 0n, window: undefined, allowContractCreation: false };
  }
  assertRecord(input, "transactions");
  assertKeys(input, ["calls", "tokens", "maxValue", "window", "allowContractCreation"], "transactions");
  const calls = new Map<Address, Set<Hex>>();
  for (const [index, rule] of listOf(input.calls, "transactions.calls").entries()) {
    const where = `transactions.calls[${index}]`;
    assertRecord(rule, where);
    assertKeys(rule, ["to", "selectors"], where);
    const to = resolveAddress(rule.to, `${where}.to`);
    const selectors = listOf(rule.selectors, `${where}.selectors`);
    if (selectors.length === 0) fail(`${where}.selectors is empty; list the functions the key may call`);
    const set = calls.get(to) ?? new Set<Hex>();
    for (const selector of selectors) {
      if (selector !== "0x" && !isSelector(selector)) {
        fail(`${where}.selectors has ${describe(selector)}; expected a 4-byte selector like 0xa9059cbb, or "0x" for no calldata`);
      }
      set.add(selector.toLowerCase() as Hex);
    }
    calls.set(to, set);
  }
  const tokens = new Map<Address, ResolvedTokenRule>();
  for (const [index, rule] of listOf(input.tokens, "transactions.tokens").entries()) {
    const where = `transactions.tokens[${index}]`;
    assertRecord(rule, where);
    assertKeys(rule, ["token", "maxAmount", "window", "recipients"], where);
    const token = resolveAddress(rule.token, `${where}.token`);
    if (tokens.has(token)) fail(`${where}.token appears twice; give each token one rule`);
    tokens.set(token, {
      token,
      maxAmount: resolveAmount(rule.maxAmount, `${where}.maxAmount`),
      window: rule.window === undefined ? undefined : resolveSpendWindow(rule.window, `${where}.window`),
      recipients:
        rule.recipients === undefined
          ? undefined
          : new Set(listOf(rule.recipients, `${where}.recipients`).map((recipient, at) => resolveAddress(recipient, `${where}.recipients[${at}]`))),
    });
  }
  if (input.allowContractCreation !== undefined && typeof input.allowContractCreation !== "boolean") {
    fail("transactions.allowContractCreation must be true or false");
  }
  return {
    calls,
    tokens,
    maxValue: input.maxValue === undefined ? 0n : resolveAmount(input.maxValue, "transactions.maxValue"),
    window: input.window === undefined ? undefined : resolveSpendWindow(input.window, "transactions.window"),
    allowContractCreation: input.allowContractCreation ?? false,
  };
}

function resolveAuthorizations(input: AuthorizationPolicy | undefined): ResolvedPolicy["authorizations"] {
  if (input === undefined) return { allow: new Set(), window: DEFAULT_AUTHORIZATION_WINDOW, resetWindow: DEFAULT_RESET_WINDOW };
  assertRecord(input, "authorizations");
  assertKeys(input, ["allow", "window", "resetWindow"], "authorizations");
  const allow = new Set(listOf(input.allow, "authorizations.allow").map((address, index) => resolveAddress(address, `authorizations.allow[${index}]`)));
  if (allow.has(ZERO_ADDRESS)) {
    fail("authorizations.allow names the zero address; clearing a delegation is always allowed and needs no entry");
  }
  return {
    allow,
    window: input.window === undefined ? DEFAULT_AUTHORIZATION_WINDOW : resolveCountWindow(input.window, "authorizations.window"),
    resetWindow: input.resetWindow === undefined ? DEFAULT_RESET_WINDOW : resolveCountWindow(input.resetWindow, "authorizations.resetWindow"),
  };
}

function resolveTypedData(input: readonly TypedDataRule[] | undefined): ResolvedTypedDataRule[] {
  return listOf(input, "typedData").map((rule, index) => {
    const where = `typedData[${index}]`;
    assertRecord(rule, where);
    assertKeys(rule, ["verifyingContract", "name", "primaryTypes"], where);
    if (rule.name !== undefined && typeof rule.name !== "string") fail(`${where}.name must be a string`);
    const primaryTypes = listOf(rule.primaryTypes, `${where}.primaryTypes`);
    if (primaryTypes.length === 0) fail(`${where}.primaryTypes is empty; list the message types the key may sign`);
    for (const primaryType of primaryTypes) {
      if (typeof primaryType !== "string" || primaryType === "") fail(`${where}.primaryTypes has ${describe(primaryType)}`);
      if (primaryType === "EIP712Domain") fail(`${where}.primaryTypes names EIP712Domain, which is the domain, not a message`);
    }
    return {
      verifyingContract: resolveAddress(rule.verifyingContract, `${where}.verifyingContract`),
      name: rule.name,
      primaryTypes: new Set(primaryTypes),
    };
  });
}

function resolveMessages(input: MessagePolicy | undefined): string[] {
  if (input === undefined) return [];
  assertRecord(input, "messages");
  assertKeys(input, ["prefixes"], "messages");
  const prefixes = listOf(input.prefixes, "messages.prefixes");
  for (const prefix of prefixes) {
    if (typeof prefix !== "string" || prefix === "") {
      fail(`messages.prefixes has ${describe(prefix)}; an empty prefix would allow every message`);
    }
  }
  return [...prefixes];
}

function resolveSpendWindow(window: SpendWindow, where: string): SpendWindow {
  assertRecord(window, where);
  assertKeys(window, ["durationMs", "max"], where);
  return { durationMs: resolveDuration(window.durationMs, `${where}.durationMs`), max: resolveAmount(window.max, `${where}.max`) };
}

function resolveCountWindow(window: CountWindow, where: string): CountWindow {
  assertRecord(window, where);
  assertKeys(window, ["durationMs", "max"], where);
  if (!Number.isSafeInteger(window.max) || window.max < 0) fail(`${where}.max must be a whole number of signatures, 0 or more`);
  return { durationMs: resolveDuration(window.durationMs, `${where}.durationMs`), max: window.max };
}

function resolveDuration(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(`${where} must be a positive whole number of milliseconds`);
  return value;
}

function resolveAmount(value: unknown, where: string): bigint {
  if (typeof value !== "bigint" || value < 0n) fail(`${where} must be a bigint of 0 or more, in base units`);
  return value;
}

function resolveAddress(value: unknown, where: string): Address {
  if (!isAddress(value)) fail(`${where} is ${describe(value)}; expected a 0x-prefixed 20-byte address`);
  return normalizeAddress(value);
}

function assertChainId(value: unknown, where: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${where} has ${describe(value)}; chain ids are positive whole numbers, and 0 would mean every chain`);
  }
}

function listOf<T>(value: readonly T[] | undefined, where: string): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${where} must be a list`);
  return value;
}

function assertRecord(value: unknown, where: string): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
}

function assertKeys(value: object, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where} has an unknown key "${key}"; allowed: ${allowed.join(", ")}`);
  }
}

function describe(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return `a ${typeof value}`;
  }
}

function fail(message: string): never {
  throw new SignGuardError("E_INVALID_POLICY", message);
}
