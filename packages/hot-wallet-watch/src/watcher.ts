import type { Rpc } from "@globalmpc/evm-log-walker";
import { SEVERITY, type Alert, type AlertKind } from "./alerts.js";
import { WatchError } from "./errors.js";
import { classifyCode, parseQuantity, type Address, type CodeState, type Hex } from "./hex.js";
import { errorKind, isDeadline, readWallet, withDeadline, type Observation } from "./read.js";
import { assertKeys, assertRecord, resolveWallets, type OutflowLimit, type ResolvedWallet, type WalletSpec } from "./spec.js";

export interface WatcherOptions {
  /**
   * One client per independent provider, each made with `createRpc`. Every endpoint is read and
   * judged on its own; with one alone, a lying or stale provider goes unnoticed, so use two or more.
   */
  endpoints: readonly Rpc[];
  /** The chain the wallets live on. An endpoint answering another `eth_chainId` is left out. */
  chainId: number;
  wallets: readonly WalletSpec[];
  /** An endpoint more than this many blocks behind the newest head is reported (`endpoint-lagging`). Default 20. */
  maxLagBlocks?: number;
  /**
   * Time each endpoint has per pass, once for its chain id and head and once for all its wallet reads;
   * an endpoint that runs out counts as failed for the rest of the pass. Default 10 000 ms.
   */
  requestTimeoutMs?: number;
  /** Requests in flight at once per endpoint, so a pass over many wallets stays under rate limits. Default 8. */
  maxConcurrentRequests?: number;
  /**
   * Clock in milliseconds since the epoch, for outflow windows. Default: a monotonic clock anchored at
   * start-up, so a wall-clock step cannot drop or freeze a window.
   */
  now?: () => number;
}

/** One wallet as the pass saw it, across the endpoints that answered. */
export interface WalletReport {
  address: Address;
  label: string;
  /** The most alarming code state any endpoint reported, or null when none could read the wallet. */
  code: CodeState | null;
  /** The highest nonce any endpoint reported, as a decimal string. */
  nonce: string | null;
  /** The lowest native balance any endpoint reported, in wei, as a decimal string. */
  balance: string | null;
}

export interface Report {
  /** When the pass ran, in milliseconds since the epoch: wall time, or the `now` clock when one is given. */
  at: number;
  /** The newest head among the endpoints that answered, or null when none did. */
  block: number | null;
  /** Each endpoint's head this pass, or null when it did not answer or is on another chain. */
  endpoints: ReadonlyArray<{ label: string; head: number | null }>;
  wallets: readonly WalletReport[];
  alerts: readonly Alert[];
}

export interface Watcher {
  /**
   * One pass over every wallet. Never throws. Lasts at most about twice `requestTimeoutMs`, plus up to
   * 10 s for `expectedNonce` callbacks.
   */
  check(): Promise<Report>;
}

/** The keys `createWatcher` accepts; `watch` accepts these and its own. */
export const WATCHER_OPTION_KEYS: readonly string[] = ["endpoints", "chainId", "wallets", "maxLagBlocks", "requestTimeoutMs", "maxConcurrentRequests", "now"];

const DEFAULT_MAX_LAG_BLOCKS = 20;
/** The longest delay Node's timers accept; a longer one fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT = 8;

/** An endpoint's request slots, kept across passes: a call still running from an earlier pass keeps its slot. */
interface Slots {
  running: number;
  waiting: Array<() => void>;
}

type Ask = (method: string, params: readonly unknown[], skip?: () => boolean) => Promise<unknown>;

/**
 * One endpoint's requests for one phase of a pass, through its slots: at most `max` in flight across
 * passes, a slot freed only when the call itself settles, all within `budgetMs`. After a timeout, or
 * once the budget is spent, this phase's queued requests fail at once, so a slow or hung endpoint costs
 * a pass one budget. A request whose `skip()` is true when its turn comes is not sent.
 */
function phaseGate(rpc: Rpc, slots: Slots, max: number, budgetMs: number): { ask: Ask; close: () => void } {
  const createdAt = performance.now();
  let spent = false;
  const mine = new Set<() => void>();
  const next = () => {
    while (slots.running < max && slots.waiting.length > 0) slots.waiting.shift()?.();
  };
  const flush = () => {
    for (let index = slots.waiting.length - 1; index >= 0; index--) {
      const start = slots.waiting[index];
      if (start !== undefined && mine.has(start)) slots.waiting.splice(index, 1);
    }
    for (const start of [...mine]) start();
  };
  const timer = setTimeout(() => {
    spent = true;
    flush();
  }, budgetMs);
  const ask: Ask = (method, params, skip) =>
    new Promise((resolve, reject) => {
      const start = () => {
        mine.delete(start);
        const remaining = budgetMs - (performance.now() - createdAt);
        // A rejected start takes no slot, so it hands nothing on: the loop in next() or flush() goes on to
        // the following entry. No recursion, however long the queue.
        if (skip?.() === true) {
          reject(Object.assign(new Error("not sent: the wallet's core read already failed"), { name: "SkippedError" }));
          return;
        }
        if (spent || remaining <= 0) {
          reject(Object.assign(new Error("not sent: this endpoint's time for the pass is spent"), { name: "TimeoutError" }));
          if (!spent) {
            spent = true;
            flush();
          }
          return;
        }
        slots.running++;
        const settled = Promise.resolve().then(() => rpc.call(method, params));
        settled
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            slots.running--;
            next();
          });
        withDeadline(settled, remaining).then(resolve, (error: unknown) => {
          if (isDeadline(error)) {
            spent = true;
            flush();
          }
          reject(error);
        });
      };
      if (slots.running < max && slots.waiting.length === 0) start();
      else {
        mine.add(start);
        slots.waiting.push(start);
      }
    });
  return { ask, close: () => clearTimeout(timer) };
}

/**
 * A clock that never throws: whole milliseconds, holding its last good value when `now` throws or
 * returns something unusable, so one bad reading cannot mix in another epoch.
 */
export function clockReader(now: () => number): () => number {
  let last: number | undefined;
  return () => {
    try {
      const at = Math.floor(now());
      if (Number.isSafeInteger(at) && at >= 0) {
        last = at;
        return at;
      }
    } catch {
      // fall through to the last good value
    }
    return last ?? 0;
  };
}

/** One asset's balance history for a wallet. */
interface AssetFlow {
  /**
   * Each endpoint's last balance, the head and pass it was read at, and the run of readings since then
   * from below that head: how many, and the first and newest heads among them.
   */
  endpoints: Map<string, { last: bigint; head: number; pass: number; behind: number; behindFirst: number; behindHead: number }>;
  /** The highest balance any endpoint reported on the most recent pass that read this asset. */
  previous: bigint | undefined;
  /** One window per wallet and asset: each pass adds the largest fall any endpoint measured. */
  drops: Array<{ at: number; amount: bigint }>;
}

/** What the endpoints together have established about a wallet, pass after pass. */
interface WalletMemory {
  /** A frozen wallet's nonce: the lowest any endpoint reported on the first pass that read it. */
  frozenNonce: bigint | undefined;
  native: AssetFlow;
  tokens: Map<Address, AssetFlow>;
}

/** Consecutive far-behind readings after which an endpoint's outflow series restarts. */
const RESTART_AFTER = 3;

const newFlow = (): AssetFlow => ({ endpoints: new Map(), previous: undefined, drops: [] });

/**
 * Creates a watcher. Each `check()` reads every wallet from every endpoint at that endpoint's own head
 * and raises an alert when any endpoint sees trouble: the alarm wins. Each endpoint's balance is
 * compared with its own last reading, so one that lies or lags can only blind itself; one that missed
 * the last pass is compared with the higher of its own last reading and the highest any endpoint
 * reported then. Each pass adds the largest fall any endpoint measured to one window per wallet and
 * asset, so a drain seen in parts by endpoints taking turns still adds up. A frozen wallet has one baseline, the lowest nonce any endpoint reported on the first
 * pass. Keep one watcher and call
 * `check()` repeatedly (or use `watch`), since that history lives in it.
 */
export function createWatcher(options: WatcherOptions): Watcher {
  assertRecord(options, "options");
  assertKeys(options, WATCHER_OPTION_KEYS, "options");
  const endpoints = resolveEndpoints(options.endpoints);
  const chainId = options.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) invalid("chainId must be a positive whole number, such as 56 for BNB Smart Chain");
  const wallets = resolveWallets(options.wallets);
  const maxLag = wholeNumber(options.maxLagBlocks ?? DEFAULT_MAX_LAG_BLOCKS, "maxLagBlocks", 0);
  const timeoutMs = wholeNumber(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs", 1);
  if (timeoutMs > MAX_TIMER_MS) invalid(`requestTimeoutMs must be at most ${MAX_TIMER_MS}`);
  const maxConcurrent = wholeNumber(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT, "maxConcurrentRequests", 1);
  if (options.now !== undefined && typeof options.now !== "function") invalid("now must be a function");
  const now = clockReader(options.now ?? monotonicNow);
  const slots: Slots[] = endpoints.map(() => ({ running: 0, waiting: [] }));
  const clockGiven = options.now !== undefined;
  const labels = endpoints.map((_, index) => `endpoint-${index + 1}`);
  const memories = new Map<Address, WalletMemory>(
    wallets.map((wallet) => [wallet.address, { frozenNonce: undefined, native: newFlow(), tokens: new Map(wallet.tokens.map((token) => [token.token, newFlow()])) }]),
  );
  let pass = 0;

  return {
    async check() {
      const at = now();
      // The report carries wall time for logs and dashboards; windows run on the watcher's own clock.
      const reportedAt = clockGiven ? at : Date.now();
      pass++;
      const alerts: Alert[] = [];
      const heads = await Promise.all(
        endpoints.map(async (rpc, index) => {
          const gate = phaseGate(rpc, slots[index] as Slots, maxConcurrent, timeoutMs);
          try {
            return await readHead(gate.ask, chainId);
          } finally {
            gate.close();
          }
        }),
      );
      const answered = heads.flatMap((head) => (typeof head === "number" ? [head] : []));
      const newest = answered.length > 0 ? Math.max(...answered) : null;
      heads.forEach((head, index) => {
        const label = labels[index] ?? "";
        if (typeof head !== "number") alerts.push(alert("endpoint-failed", null, null, `${label} ${head.reason}`, [label], { endpoint: label }));
        else if (newest !== null && newest - head > maxLag) {
          alerts.push(alert("endpoint-lagging", null, head, `${label} is ${newest - head} blocks behind the newest head`, [label], { endpoint: label, behind: newest - head }));
        }
      });
      const endpointReport = heads.map((head, index) => ({ label: labels[index] ?? "", head: typeof head === "number" ? head : null }));
      const used = endpoints.flatMap((rpc, index) => {
        const head = heads[index];
        if (typeof head !== "number") return [];
        // At most `maxConcurrentRequests` in flight across passes, all within `requestTimeoutMs` for its reads.
        const gate = phaseGate(rpc, slots[index] as Slots, maxConcurrent, timeoutMs);
        return [{ ask: gate.ask, close: gate.close, label: labels[index] ?? "", head }];
      });
      if (used.length === 0) {
        alerts.push(alert("no-endpoint", null, null, "no endpoint answered on the expected chain: nothing is being watched", [], {}));
        return { at: reportedAt, block: null, endpoints: endpointReport, wallets: wallets.map(unreadWallet), alerts };
      }

      // Every wallet's code, nonce and balance reads are queued before any token read, so the delegation
      // checks get the endpoint's slots first.
      let releaseTokens = () => undefined as void;
      const tokensQueued = new Promise<void>((resolve) => {
        releaseTokens = resolve;
      });
      const pending = wallets.map((wallet) => ({
        wallet,
        readings: used.map(({ ask, label, head }) => ({ label, head, reading: readWallet(ask, wallet, `0x${head.toString(16)}` as Hex, tokensQueued) })),
      }));
      releaseTokens();
      const reports = await Promise.all(
        pending.map(async ({ wallet, readings }) => {
          const settled = await Promise.all(readings.map(async ({ label, head, reading }) => ({ label, head, reading: await reading })));
          return judgeWallet(wallet, settled, memories.get(wallet.address) as WalletMemory, pass, at, alerts);
        }),
      ).finally(() => {
        for (const { close } of used) close();
      });
      return { at: reportedAt, block: newest, endpoints: endpointReport, wallets: reports, alerts };
    },
  };
}

interface Seen {
  label: string;
  head: number;
  observation: Observation;
}

type Raise = (kind: AlertKind, message: string, from: readonly Seen[] | readonly string[], detail?: Alert["detail"]) => void;

async function judgeWallet(
  wallet: ResolvedWallet,
  readings: ReadonlyArray<{ label: string; head: number; reading: Awaited<ReturnType<typeof readWallet>> }>,
  memory: WalletMemory,
  pass: number,
  at: number,
  alerts: Alert[],
): Promise<WalletReport> {
  const raise: Raise = (kind, message, from, detail = {}) => {
    const observedBy = from.map((entry) => (typeof entry === "string" ? entry : entry.label));
    const blocks = from.flatMap((entry) => (typeof entry === "string" ? [] : [entry.head]));
    alerts.push(alert(kind, wallet, blocks.length > 0 ? Math.max(...blocks) : null, message, observedBy, detail));
  };
  const seen = triageReadings(wallet, readings, raise);
  if (seen.length === 0) {
    raise("wallet-unreadable", `no endpoint could read ${wallet.label}, so it is not being watched`, readings.map(({ label }) => label));
    return unreadWallet(wallet);
  }
  const code = judgeCode(wallet, seen, raise);
  const nonce = await judgeNonce(wallet, seen, memory, raise);
  judgeOutflows(wallet, seen, memory, pass, at, raise);
  judgeAgreement(wallet, seen, raise);
  const balance = seen.reduce((low, { observation }) => (observation.balance < low ? observation.balance : low), seen[0]?.observation.balance ?? 0n);
  return { address: wallet.address, label: wallet.label, code, nonce: nonce.toString(), balance: balance.toString() };
}

/** The readings that count; every failed one, and every failed token read, is a warning. */
function triageReadings(wallet: ResolvedWallet, readings: ReadonlyArray<{ label: string; head: number; reading: Awaited<ReturnType<typeof readWallet>> }>, raise: Raise): Seen[] {
  const seen: Seen[] = [];
  for (const { label, head, reading } of readings) {
    if (!reading.ok) {
      raise("endpoint-failed", `${label} could not read ${wallet.label}: ${reading.reason}`, [label], { endpoint: label });
      continue;
    }
    seen.push({ label, head, observation: reading.observation });
    for (const [token, reason] of reading.observation.tokenFailures) {
      raise("endpoint-failed", `${label} could not read token ${token} for ${wallet.label}: ${reason}`, [label], { endpoint: label, token });
    }
  }
  return seen;
}

/** Any endpoint seeing a hostile delegation or unexpected code raises it. Returns the most alarming state. */
function judgeCode(wallet: ResolvedWallet, seen: readonly Seen[], raise: Raise): CodeState | null {
  const codes = seen.map((entry) => ({ entry, state: classifyCode(entry.observation.code) }));
  if (!wallet.contract) {
    const hostile = new Map<Address, Seen[]>();
    for (const { entry, state } of codes) {
      if (state.kind === "delegated" && !wallet.delegates.has(state.delegate)) hostile.set(state.delegate, [...(hostile.get(state.delegate) ?? []), entry]);
    }
    for (const [delegate, from] of hostile) {
      raise("delegated", `${wallet.label} is delegated to ${delegate}, which is not an allowed delegate: that contract now controls the wallet`, from, { delegate });
    }
    const unexpected = codes.filter(({ state }) => state.kind === "contract").map(({ entry }) => entry);
    if (unexpected.length > 0) raise("unexpected-code", `${wallet.label} has contract code, and an ordinary wallet has none`, unexpected);
  }
  const worst =
    codes.find(({ state }) => state.kind === "delegated" && !wallet.delegates.has(state.delegate)) ??
    codes.find(({ state }) => state.kind === "contract") ??
    codes.find(({ state }) => state.kind === "delegated") ??
    codes[0];
  return worst?.state ?? null;
}

/**
 * A frozen wallet is judged against the lowest nonce any endpoint reported on the first pass, so an
 * inflated reading cannot raise the baseline and a late endpoint cannot reset it. Returns the highest nonce.
 */
async function judgeNonce(wallet: ResolvedWallet, seen: readonly Seen[], memory: WalletMemory, raise: Raise): Promise<bigint> {
  const nonce = seen.reduce((high, { observation }) => (observation.nonce > high ? observation.nonce : high), 0n);
  if (wallet.frozen) {
    if (memory.frozenNonce === undefined) memory.frozenNonce = seen.reduce((low, { observation }) => (observation.nonce < low ? observation.nonce : low), nonce);
    const baseline = memory.frozenNonce;
    const risen = seen.filter((entry) => entry.observation.nonce > baseline);
    if (risen.length > 0) {
      const highest = risen.reduce((high, entry) => (entry.observation.nonce > high ? entry.observation.nonce : high), 0n);
      raise("unexpected-nonce", `${wallet.label} is frozen but its nonce rose to ${highest}: someone signed with its key`, risen, { source: "frozen", observed: highest.toString() });
    }
  }
  if (wallet.expectedNonce !== undefined) {
    const expected = await readExpectedNonce(wallet.expectedNonce);
    if (expected === undefined) raise("expected-nonce-failed", `expectedNonce for ${wallet.label} failed, timed out or returned something other than a whole number`, []);
    else if (nonce > expected) {
      raise("unexpected-nonce", `${wallet.label} has nonce ${nonce} but your system sent ${expected}: someone else signed with its key`, seen.filter((entry) => entry.observation.nonce > expected), {
        source: "expected",
        expected: expected.toString(),
        observed: nonce.toString(),
      });
    }
  }
  return nonce;
}

/** Each endpoint measured against its own last reading; one window per wallet and asset. */
function judgeOutflows(wallet: ResolvedWallet, seen: readonly Seen[], memory: WalletMemory, pass: number, at: number, raise: Raise): void {
  if (wallet.outflow !== undefined) {
    const limit = wallet.outflow;
    const out = trackAsset(memory.native, seen.map((entry) => ({ entry, value: entry.observation.balance })), pass, at, limit);
    if (out !== undefined) {
      raise("outflow", `${out.total} wei left ${wallet.label} within ${limit.durationMs} ms, above the cap of ${limit.max}`, out.from, {
        asset: "native",
        amount: out.total.toString(),
        fall: out.fall.toString(),
        max: limit.max.toString(),
      });
    }
  }
  for (const token of wallet.tokens) {
    const flow = memory.tokens.get(token.token);
    if (seen.every((entry) => !entry.observation.tokens.has(token.token))) {
      raise("token-unreadable", `no endpoint could read token ${token.token} for ${wallet.label}, so its outflow cap is not being watched`, seen, { token: token.token });
      continue;
    }
    if (flow === undefined) continue;
    const readings = seen.flatMap((entry) => {
      const value = entry.observation.tokens.get(token.token);
      return value === undefined ? [] : [{ entry, value }];
    });
    const out = trackAsset(flow, readings, pass, at, token.outflow);
    if (out !== undefined) {
      raise("outflow", `${out.total} of token ${token.token} left ${wallet.label} within ${token.outflow.durationMs} ms, above the cap of ${token.outflow.max}`, out.from, {
        asset: "token",
        token: token.token,
        amount: out.total.toString(),
        fall: out.fall.toString(),
        max: token.outflow.max.toString(),
      });
    }
  }
}

/** Endpoints at the same head should agree; a difference is worth knowing even when nothing is wrong. */
function judgeAgreement(wallet: ResolvedWallet, seen: readonly Seen[], raise: Raise): void {
  const byHead = new Map<number, Seen[]>();
  for (const entry of seen) byHead.set(entry.head, [...(byHead.get(entry.head) ?? []), entry]);
  for (const [head, group] of byHead) {
    // Every pair, not each against the first: a token the first endpoint failed to read is skipped in
    // its comparisons, so two others reading it differently would otherwise go unnoticed.
    if (group.some((a, index) => group.slice(index + 1).some((b) => !sameObservation(a.observation, b.observation)))) {
      raise("endpoints-disagree", `endpoints gave different readings of ${wallet.label} at block ${head}`, group, { endpoint: group.map((entry) => entry.label).join(",") });
    }
  }
}

/**
 * Records one pass of readings for an asset and returns the outflow when the window total passes the
 * cap. Each endpoint's fall is measured from its own reading on the last pass; an endpoint that missed
 * it is measured from the higher of its own last reading and the highest balance any endpoint reported
 * on the most recent pass, so a drain while it was away still counts. The pass adds the largest fall
 * any endpoint measured to one window per wallet and asset. Both rules err towards raising the alarm:
 * a lagging endpoint can count one fall a pass late, on top of the endpoint that saw it first.
 */
function trackAsset(
  flow: AssetFlow,
  readings: ReadonlyArray<{ entry: Seen; value: bigint }>,
  pass: number,
  at: number,
  limit: OutflowLimit,
): { total: bigint; fall: bigint; from: Seen[] } | undefined {
  const falls = readings.map(({ entry, value }): { entry: Seen; fall: bigint; counted: boolean } => {
    const own = flow.endpoints.get(entry.label);
    if (own !== undefined && entry.head < own.head) {
      // A reading from behind the endpoint's last head (a load balancer answering from a node that lags,
      // or a stuck one) is skipped: otherwise a deposit or a spend already counted would count again.
      // Only RESTART_AFTER such readings in a row, during which the chain advanced (the newest head in the
      // run is above its first), restart the series: that is a real chain below a bogus inflated head. A
      // stuck node repeats one head, so it never restarts it; the live head coming back resets the run.
      const behind = own.behind + 1;
      const firstHead = own.behind === 0 ? entry.head : own.behindFirst;
      const newestHead = Math.max(own.behindHead, entry.head);
      if (behind < RESTART_AFTER || newestHead <= firstHead) {
        flow.endpoints.set(entry.label, { ...own, behind, behindFirst: firstHead, behindHead: newestHead });
        return { entry, fall: 0n, counted: false };
      }
      // The restart counts any fall from the last reading before the gap, so a drain while the
      // endpoint was reporting from behind is not lost.
      flow.endpoints.set(entry.label, { last: value, head: entry.head, pass, behind: 0, behindFirst: 0, behindHead: 0 });
      return { entry, fall: value < own.last ? own.last - value : 0n, counted: false };
    }
    const shared = flow.previous;
    const baseline =
      own !== undefined && own.pass === pass - 1 ? own.last : own === undefined ? shared : shared !== undefined && shared > own.last ? shared : own.last;
    flow.endpoints.set(entry.label, { last: value, head: entry.head, pass, behind: 0, behindFirst: 0, behindHead: 0 });
    return { entry, fall: baseline !== undefined && value < baseline ? baseline - value : 0n, counted: true };
  });
  // A skipped (stepped-back) reading must not become the baseline others are measured from.
  const highest = readings
    .filter((_, index) => falls[index]?.counted === true)
    .reduce<bigint | undefined>((high, { value }) => (high === undefined || value > high ? value : high), undefined);
  if (highest !== undefined) flow.previous = highest;
  const fall = falls.reduce((high, item) => (item.fall > high ? item.fall : high), 0n);
  flow.drops = flow.drops.filter((drop) => drop.at > at - limit.durationMs);
  if (fall > 0n) flow.drops.push({ at, amount: fall });
  const total = flow.drops.reduce((sum, drop) => sum + drop.amount, 0n);
  if (total <= limit.max) return undefined;
  const falling = falls.filter((item) => item.fall > 0n).map((item) => item.entry);
  return { total, fall, from: falling.length > 0 ? falling : readings.map((item) => item.entry) };
}

function sameObservation(a: Observation, b: Observation): boolean {
  return (
    a.code.toLowerCase() === b.code.toLowerCase() &&
    a.nonce === b.nonce &&
    a.balance === b.balance &&
    // Only tokens both endpoints read: a failed read is reported on its own, not as disagreement.
    [...a.tokens].every(([token, value]) => !b.tokens.has(token) || b.tokens.get(token) === value)
  );
}

/** The head of one endpoint on the expected chain, or why it cannot be used this pass. */
async function readHead(ask: Ask, chainId: number): Promise<number | { reason: string }> {
  try {
    // Once one head read fails, the other is not sent if it is still queued.
    let failed = false;
    const headRead = (method: string) =>
      ask(method, [], () => failed).catch((error: unknown) => {
        failed = true;
        throw error;
      });
    const [chain, head] = await Promise.all([headRead("eth_chainId"), headRead("eth_blockNumber")]);
    const parsedChain = parseQuantity(chain);
    if (parsedChain !== BigInt(chainId)) return { reason: `is on chain ${parsedChain === undefined ? "unknown" : parsedChain.toString()}, not ${chainId}, and was left out` };
    const parsedHead = parseQuantity(head);
    if (parsedHead === undefined || parsedHead > BigInt(Number.MAX_SAFE_INTEGER)) return { reason: "answered eth_blockNumber with something other than a block number" };
    return Number(parsedHead);
  } catch (error) {
    return { reason: `failed on eth_chainId or eth_blockNumber (${errorKind(error)})` };
  }
}

/** How long `expectedNonce` may take before the pass goes on without it. */
const EXPECTED_NONCE_TIMEOUT_MS = 10_000;

async function readExpectedNonce(expectedNonce: () => number | Promise<number>): Promise<bigint | undefined> {
  try {
    const value: unknown = await withDeadline(Promise.resolve().then(expectedNonce), EXPECTED_NONCE_TIMEOUT_MS);
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  } catch {
    return undefined;
  }
}

function unreadWallet(wallet: ResolvedWallet): WalletReport {
  return { address: wallet.address, label: wallet.label, code: null, nonce: null, balance: null };
}

function alert(kind: AlertKind, wallet: ResolvedWallet | null, block: number | null, message: string, observedBy: readonly string[], detail: Alert["detail"]): Alert {
  return { kind, severity: SEVERITY[kind], wallet: wallet === null ? null : { address: wallet.address, label: wallet.label }, block, message, observedBy, detail };
}

/** Milliseconds since the epoch at start-up, then monotonic: a wall-clock step does not move it. */
export function monotonicNow(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}


export function wholeNumber(value: unknown, name: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid(`${name} must be a whole number of ${min} or more`);
  return value;
}

function resolveEndpoints(endpoints: unknown): readonly Rpc[] {
  if (!Array.isArray(endpoints) || endpoints.length === 0) invalid("endpoints must be a non-empty list of clients made with createRpc");
  for (const [index, endpoint] of endpoints.entries()) {
    if (typeof endpoint !== "object" || endpoint === null || typeof (endpoint as Partial<Rpc>).call !== "function") invalid(`endpoints[${index}] is not a client made with createRpc`);
  }
  return endpoints as readonly Rpc[];
}

function invalid(message: string): never {
  throw new WatchError("E_INVALID_ARGUMENT", message);
}
