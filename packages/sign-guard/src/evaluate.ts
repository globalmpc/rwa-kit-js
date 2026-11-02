import type { RuleId, Spend, Summary, Verdict } from "./decision.js";
import {
  addressWord,
  argumentWord,
  isAddress,
  isBytes,
  normalizeAddress,
  selectorOf,
  uintWord,
  ZERO_ADDRESS,
  type Address,
  type Hex,
} from "./hex.js";
import type { ResolvedPolicy } from "./policy.js";
import type { AuthorizationLike, MessageLike, SignRequest, TransactionLike, TypedDataLike } from "./request.js";

/** `transfer(address,uint256)`. */
export const TRANSFER_SELECTOR: Hex = "0xa9059cbb";

/** Transaction types that carry no blobs. `eip7702` is further limited by the authorization rules. */
const TRANSACTION_TYPES = new Set(["legacy", "eip2930", "eip1559", "eip7702"]);

/** Selector plus two argument words, exactly: `transfer(address,uint256)` with nothing appended. */
const TRANSFER_CALLDATA_LENGTH = 2 + 8 + 64 * 2;

/**
 * Judges one request against a policy. Pure: no clock, no windows, no I/O. A `SignGuard` adds the
 * windows; this function alone answers "would the policy ever allow this?".
 */
export function evaluate(request: SignRequest, policy: ResolvedPolicy): Verdict {
  if (typeof request !== "object" || request === null) return deny("request.malformed", "the request is not an object", {});
  switch (request.kind) {
    case "transaction":
      return evaluateTransaction(request.transaction, request.customSerializer === true, policy);
    case "authorization":
      return evaluateAuthorization(request.authorization, policy);
    case "typedData":
      return evaluateTypedData(request.typedData, policy);
    case "message":
      return evaluateMessage(request.message, policy);
    case "hash":
      return deny("hash.denied", "raw hash signing is never allowed: a 32-byte digest can be a transaction, a delegation or a permit, and nothing shows which", {});
    case "unreadable":
      return deny("request.malformed", "the request could not be copied for checking: a signed field holds a function or proxy, or a getter threw", {
        method: String(request.method),
      });
    case "unknown":
      return deny("method.unknown", unknownMethodReason(String(request.method)), { method: String(request.method) });
  }
  const kind = String((request as unknown as { kind?: unknown }).kind);
  return deny("method.unknown", unknownMethodReason(kind), { method: kind });
}

/**
 * The reason given for a method the guard does not know. The name comes from the caller, so it is
 * quoted with JSON escaping: a newline in it cannot forge a line in a log.
 */
export function unknownMethodReason(method: string): string {
  return `${JSON.stringify(method)} is not a signing method the guard knows, so it is refused`;
}

function evaluateTransaction(transaction: TransactionLike, customSerializer: boolean, policy: ResolvedPolicy): Verdict {
  if (typeof transaction !== "object" || transaction === null) {
    return deny("transaction.malformed", "the transaction is not an object", {});
  }
  if (customSerializer) {
    return deny("transaction.custom-serializer", "a custom serializer could sign other bytes than the fields that were checked", {});
  }
  if (transaction.input !== undefined) {
    return deny("transaction.input-field", "the transaction has an `input` field; calldata belongs in `data`, the field that is signed", {});
  }
  if (
    transaction.blobs !== undefined ||
    transaction.blobVersionedHashes !== undefined ||
    transaction.maxFeePerBlobGas !== undefined ||
    transaction.sidecars !== undefined ||
    transaction.type === "eip4844"
  ) {
    return deny("transaction.type-not-allowed", "blob transactions are not allowed", { type: "eip4844" });
  }
  if (transaction.type !== undefined && !TRANSACTION_TYPES.has(transaction.type)) {
    return deny("transaction.type-not-allowed", `transaction type ${JSON.stringify(transaction.type)} is not allowed`, { type: String(transaction.type) });
  }
  const chainId = transaction.chainId;
  if (chainId === undefined) {
    return deny("chain.not-allowed", "the transaction has no chain id; without one it can be replayed on any chain", {});
  }
  if (typeof chainId !== "number") {
    return deny("transaction.malformed", `chainId must be a number, as viem takes it, not a ${typeof chainId}`, {});
  }
  if (!policy.chainIds.has(chainId)) {
    return deny("chain.not-allowed", `chain ${String(chainId)} is not in the policy`, { chainId: String(chainId) });
  }
  const value = transaction.value ?? 0n;
  if (typeof value !== "bigint" || value < 0n) {
    return deny("transaction.malformed", "value must be a bigint of 0 or more", { chainId });
  }
  const data = transaction.data ?? "0x";
  if (!isBytes(data)) {
    return deny("transaction.malformed", "data must be even-length 0x-prefixed hex", { chainId });
  }

  const authorizationList = transaction.authorizationList ?? [];
  if (!Array.isArray(authorizationList)) {
    return deny("transaction.malformed", "authorizationList must be a list", { chainId });
  }
  for (const authorization of authorizationList as readonly AuthorizationLike[]) {
    // A signed authorization is serialized from `address`; the `contractAddress` alias exists only for signing one.
    if (typeof authorization === "object" && authorization !== null && authorization.address === undefined) {
      return deny("transaction.authorization-list", "an authorization in the list has no `address`, the field a transaction carries", { chainId });
    }
    const { verdict } = evaluateAuthorizationShape(authorization, policy);
    if (!verdict.allowed) {
      return deny("transaction.authorization-list", `the transaction carries an authorization that is not allowed: ${verdict.reason}`, {
        chainId,
        delegate: verdict.summary.delegate ?? null,
      });
    }
  }

  const to = transaction.to;
  const base = { chainId, to: to ?? null, value: value.toString(), selector: selectorOf(data) };
  if (to === undefined || to === null) {
    if (!policy.transactions.allowContractCreation) {
      return deny("transaction.creation-not-allowed", "the transaction has no `to`, which deploys a contract, and the policy does not allow that", base);
    }
  } else if (!isAddress(to)) {
    return deny("transaction.malformed", "`to` is not a 20-byte address", { chainId });
  }

  if (value > policy.transactions.maxValue) {
    return deny("transaction.value-over-limit", `value ${value} is above the limit of ${policy.transactions.maxValue} per transaction`, base);
  }
  const spends: Spend[] = [];
  const nativeWindow = policy.transactions.window;
  if (value > 0n && nativeWindow !== undefined) {
    spends.push({ key: `native:${chainId}`, amount: value, durationMs: nativeWindow.durationMs, max: nativeWindow.max });
  }
  if (to === undefined || to === null) return allow("contract creation allowed by the policy", base, spends);

  const target = normalizeAddress(to);
  const selector = selectorOf(data);
  const token = policy.transactions.tokens.get(target);
  if (token !== undefined && selector === TRANSFER_SELECTOR) {
    const recipientWord = argumentWord(data, 0);
    const amountWord = argumentWord(data, 1);
    const recipient = recipientWord === undefined ? undefined : addressWord(recipientWord);
    if (data.length !== TRANSFER_CALLDATA_LENGTH || recipient === undefined || amountWord === undefined) {
      return deny("token.malformed-transfer", "the transfer calldata is not exactly transfer(address,uint256)", base);
    }
    const amount = uintWord(amountWord);
    const summary = { ...base, token: target, recipient, amount: amount.toString() };
    if (token.recipients !== undefined && !token.recipients.has(recipient)) {
      return deny("token.recipient-not-allowed", `${recipient} is not an allowed recipient of this token`, summary);
    }
    if (amount > token.maxAmount) {
      return deny("token.amount-over-limit", `amount ${amount} is above the limit of ${token.maxAmount} per transfer`, summary);
    }
    if (token.window !== undefined && amount > 0n) {
      spends.push({ key: `token:${chainId}:${target}`, amount, durationMs: token.window.durationMs, max: token.window.max });
    }
    return allow("token transfer within the policy", summary, spends);
  }

  const selectors = policy.transactions.calls.get(target);
  if (selectors?.has(selector) === true) return allow("call allowed by the policy", base, spends);
  if (selectors === undefined && token === undefined) {
    return deny("transaction.target-not-allowed", `${target} is not a contract or recipient the policy allows`, base);
  }
  return deny("transaction.function-not-allowed", `function ${selector} on ${target} is not allowed`, base);
}

function evaluateAuthorization(authorization: AuthorizationLike, policy: ResolvedPolicy): Verdict {
  const { verdict, reset } = evaluateAuthorizationShape(authorization, policy);
  if (!verdict.allowed) return verdict;
  // One window per key across its chains, as documented, not one per chain.
  const window = reset ? policy.authorizations.resetWindow : policy.authorizations.window;
  const key = reset ? "reset" : "authorization";
  return allow(verdict.reason, verdict.summary, [{ key, amount: 1n, durationMs: window.durationMs, max: BigInt(window.max) }]);
}

/**
 * The authorization rules without the count window: shared by direct signing and authorization lists.
 * `reset` is true for an allowed delegation to the zero address, which has its own window.
 */
function evaluateAuthorizationShape(authorization: AuthorizationLike, policy: ResolvedPolicy): { verdict: Verdict; reset: boolean } {
  const verdict = judgeAuthorization(authorization, policy);
  return { verdict, reset: verdict.allowed && verdict.summary.reset === true };
}

function judgeAuthorization(authorization: AuthorizationLike, policy: ResolvedPolicy): Verdict {
  if (typeof authorization !== "object" || authorization === null) {
    return deny("authorization.malformed", "the authorization is not an object", {});
  }
  const { address, contractAddress, chainId, nonce } = authorization;
  if ((address !== undefined && !isAddress(address)) || (contractAddress !== undefined && !isAddress(contractAddress))) {
    return deny("authorization.malformed", "the authorization names no valid contract address", {});
  }
  if (address !== undefined && contractAddress !== undefined && address.toLowerCase() !== contractAddress.toLowerCase()) {
    return deny("authorization.malformed", "`address` and `contractAddress` name different contracts", {});
  }
  const delegate = contractAddress ?? address;
  if (delegate === undefined) return deny("authorization.malformed", "the authorization names no valid contract address", {});
  if (!Number.isSafeInteger(chainId) || chainId < 0 || !Number.isSafeInteger(nonce) || nonce < 0) {
    return deny("authorization.malformed", "chainId and nonce must be whole numbers of 0 or more", {});
  }
  const target = normalizeAddress(delegate);
  const summary = { chainId, nonce, delegate: target, reset: target === ZERO_ADDRESS };
  if (target === ZERO_ADDRESS) {
    if (!policy.chainIds.has(chainId)) {
      return deny("chain.not-allowed", `chain ${chainId} is not in the policy; a reset is pinned to the policy chains like every other signature`, summary);
    }
    return allow("clearing a delegation is always allowed on a policy chain", summary, []);
  }
  if (chainId === 0) {
    return deny("authorization.chain-zero", "an authorization with chain id 0 is valid on every chain", summary);
  }
  if (!policy.chainIds.has(chainId)) {
    return deny("chain.not-allowed", `chain ${chainId} is not in the policy`, summary);
  }
  if (!policy.authorizations.allow.has(target)) {
    return deny("authorization.delegate-not-allowed", `delegating this account to ${target} is not allowed: the contract would control the account and everything it holds`, summary);
  }
  return allow("delegation to an allowed contract", summary, []);
}

function evaluateTypedData(typedData: TypedDataLike, policy: ResolvedPolicy): Verdict {
  if (typeof typedData !== "object" || typedData === null) {
    return deny("typed-data.malformed", "the typed data is not an object", {});
  }
  const { domain, primaryType, types } = typedData;
  if (typeof domain !== "object" || domain === null || typeof primaryType !== "string") {
    return deny("typed-data.malformed", "typed data needs a domain and a primaryType", {});
  }
  if (typeof types === "object" && types !== null && Object.hasOwn(types, "EIP712Domain")) {
    const declared = (types as Record<string, unknown>)["EIP712Domain"];
    if (!sameDomainType(declared, derivedDomainType(domain))) {
      return deny("typed-data.malformed", "the request's EIP712Domain type differs from its domain, which can leave the chain id or contract out of what is signed", { primaryType });
    }
  }
  const chainId = toChainId(domain.chainId);
  if (chainId === undefined) {
    return deny("typed-data.malformed", "the domain has no usable chainId; such a signature is valid on every chain", { primaryType });
  }
  const verifyingContract = domain.verifyingContract;
  const summary = {
    chainId,
    primaryType,
    verifyingContract: isAddress(verifyingContract) ? normalizeAddress(verifyingContract) : null,
    name: typeof domain.name === "string" ? domain.name : null,
  };
  if (!policy.chainIds.has(chainId)) return deny("chain.not-allowed", `chain ${chainId} is not in the policy`, summary);
  if (summary.verifyingContract === null) {
    return deny("typed-data.not-allowed", "the domain names no verifyingContract, so the policy cannot tell what the signature authorises", summary);
  }
  const contract: Address = summary.verifyingContract;
  const match = policy.typedData.some(
    (rule) =>
      rule.verifyingContract === contract &&
      (rule.name === undefined || rule.name === domain.name) &&
      rule.primaryTypes.has(primaryType),
  );
  if (!match) return deny("typed-data.not-allowed", `${JSON.stringify(primaryType)} for ${contract} is not allowed`, summary);
  return allow("typed data allowed by the policy", summary, []);
}

function evaluateMessage(message: MessageLike, policy: ResolvedPolicy): Verdict {
  if (typeof message !== "string" && (typeof message !== "object" || message === null || !("raw" in message))) {
    return deny("request.malformed", "the message is missing, or is neither text nor { raw }", {});
  }
  if (typeof message !== "string") {
    return deny("message.raw", "raw byte messages are not allowed; only text with an allowed prefix can be signed", {});
  }
  const prefix = policy.messages.find((candidate) => message.startsWith(candidate));
  if (prefix === undefined) return deny("message.not-allowed", "the message does not start with an allowed prefix", { length: message.length });
  return allow("message starts with an allowed prefix", { length: message.length, prefix }, []);
}

/**
 * The EIP712Domain type a domain implies: one entry per field present, in the standard order. viem's
 * wallet client always sends this exact list; any other list changes what the domain hash covers.
 */
function derivedDomainType(domain: NonNullable<TypedDataLike["domain"]>): Array<{ name: string; type: string }> {
  const fields: Array<{ name: string; type: string }> = [];
  if (typeof domain.name === "string") fields.push({ name: "name", type: "string" });
  if (typeof domain.version === "string") fields.push({ name: "version", type: "string" });
  if (typeof domain.chainId === "number" || typeof domain.chainId === "bigint") fields.push({ name: "chainId", type: "uint256" });
  if (domain.verifyingContract) fields.push({ name: "verifyingContract", type: "address" });
  if (domain.salt) fields.push({ name: "salt", type: "bytes32" });
  return fields;
}

function sameDomainType(declared: unknown, derived: ReadonlyArray<{ name: string; type: string }>): boolean {
  if (!Array.isArray(declared) || declared.length !== derived.length) return false;
  return derived.every((field, index) => {
    const entry: unknown = declared[index];
    if (typeof entry !== "object" || entry === null) return false;
    const { name, type } = entry as { name?: unknown; type?: unknown };
    return name === field.name && type === field.type && Object.keys(entry).length === 2;
  });
}

function toChainId(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function allow(reason: string, summary: Summary, spends: readonly Spend[]): Verdict {
  return { allowed: true, rule: "allowed", reason, summary, spends };
}

function deny(rule: RuleId, reason: string, summary: Summary): Verdict {
  return { allowed: false, rule, reason, summary, spends: [] };
}
