import type { Alert } from "./alerts.js";
import { WatchError } from "./errors.js";
import { isDeadline, withDeadline } from "./read.js";
import { assertKeys, assertRecord } from "./spec.js";
import { clockReader, createWatcher, MAX_TIMER_MS, monotonicNow, WATCHER_OPTION_KEYS, wholeNumber, type Report, type WatcherOptions } from "./watcher.js";

export interface WatchOptions extends WatcherOptions {
  /**
   * Called when an alert first appears, again at once if it gets worse (a larger outflow, a higher
   * nonce), and every `repeatAfterMs` while it persists.
   */
  onAlert: (alert: Alert) => void | Promise<void>;
  /** Called after every pass with the full report, for dashboards and heartbeats. */
  onReport?: (report: Report) => void | Promise<void>;
  /** Time between passes. Default 3 000 ms, a few BNB Smart Chain blocks. */
  intervalMs?: number;
  /** How often an alert that is still true is sent again. Default 600 000 ms. */
  repeatAfterMs?: number;
  /** Time each `onAlert` or `onReport` call may take before the watch moves on. Default 10 000 ms. */
  callbackTimeoutMs?: number;
  /** Stops the loop. `watch` resolves once the current pass has finished. */
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_REPEAT_AFTER_MS = 600_000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 10_000;

/**
 * Runs `check()` every `intervalMs` until `signal` aborts. An alert is sent when it first appears,
 * again at once when it gets worse, and every `repeatAfterMs` while it stays true; once a pass no
 * longer raises it, it is forgotten, so its return is sent at once. A callback that throws is retried
 * on the next pass, even if the alert's condition has cleared by then, until it is delivered; one that
 * takes longer than `callbackTimeoutMs` is cut off and counted as sent, since it may have been. Either
 * way a broken pager never stops the watch.
 */
export async function watch(options: WatchOptions): Promise<void> {
  assertRecord(options, "options");
  assertKeys(
    options,
    [...WATCHER_OPTION_KEYS, "onAlert", "onReport", "intervalMs", "repeatAfterMs", "callbackTimeoutMs", "signal"],
    "options",
  );
  const {
    onAlert,
    onReport,
    intervalMs = DEFAULT_INTERVAL_MS,
    repeatAfterMs = DEFAULT_REPEAT_AFTER_MS,
    callbackTimeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
    signal,
    ...watcherOptions
  } = options;
  if (typeof onAlert !== "function") throw new WatchError("E_INVALID_ARGUMENT", "onAlert must be a function");
  if (onReport !== undefined && typeof onReport !== "function") throw new WatchError("E_INVALID_ARGUMENT", "onReport must be a function");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new WatchError("E_INVALID_ARGUMENT", "signal must be an AbortSignal");
  for (const [name, value] of [["intervalMs", intervalMs], ["repeatAfterMs", repeatAfterMs], ["callbackTimeoutMs", callbackTimeoutMs]] as const) {
    if (wholeNumber(value, name, 1) > MAX_TIMER_MS) throw new WatchError("E_INVALID_ARGUMENT", `${name} must be at most ${MAX_TIMER_MS}`);
  }
  const watcher = createWatcher(watcherOptions);
  // Repeats run on the same clock as the outflow windows, so a wall-clock step cannot freeze them.
  const clock = clockReader(watcherOptions.now ?? monotonicNow);
  /** Per ongoing alert: when it was last sent, and how bad it was on the last pass. */
  const lastSent = new Map<string, { at: number; magnitude: bigint }>();
  /** Runs a callback within its deadline: true when it completed or timed out (it may have delivered). */
  const call = (callback: () => void | Promise<void>) =>
    withDeadline(Promise.resolve().then(callback), callbackTimeoutMs).then(
      () => true,
      (error: unknown) => isDeadline(error),
    );
  /**
   * Alerts whose delivery threw, kept until delivered: sent again on the next pass, even
   * if the condition has cleared by then, so a takeover that undoes itself is not lost to one failed page.
   */
  const undelivered = new Map<string, Alert>();

  while (signal?.aborted !== true) {
    const report = await watcher.check();
    const at = clock();
    const active = new Set<string>();
    const due: Array<{ alert: Alert; key: string; magnitude: bigint }> = [];
    for (const alert of report.alerts) {
      const key = alertKey(alert);
      const magnitude = alertMagnitude(alert);
      active.add(key);
      const previous = lastSent.get(key);
      // Worse: a new fall this pass (even if an older, larger one has left the window), or a higher nonce.
      const worse = previous !== undefined && (newFall(alert) || magnitude > previous.magnitude);
      if (previous !== undefined && !worse && !undelivered.has(key) && at - previous.at < repeatAfterMs) {
        lastSent.set(key, { at: previous.at, magnitude });
        continue;
      }
      due.push({ alert, key, magnitude });
    }
    // Critical alerts go out first, together; then the warnings, together. A slow pager costs at most
    // two callback deadlines per pass, and a warning never delays a critical alert.
    for (const [key, alert] of undelivered) if (!active.has(key)) due.push({ alert, key, magnitude: alertMagnitude(alert) });
    const deliver = async ({ alert, key, magnitude }: (typeof due)[number]) => {
      if (await call(() => onAlert(alert))) {
        if (active.has(key)) lastSent.set(key, { at, magnitude });
        undelivered.delete(key);
      } else undelivered.set(key, alert);
    };
    await Promise.all(due.filter(({ alert }) => alert.severity === "critical").map(deliver));
    await Promise.all(due.filter(({ alert }) => alert.severity !== "critical").map(deliver));
    for (const key of lastSent.keys()) if (!active.has(key)) lastSent.delete(key);
    if (onReport !== undefined) await call(() => onReport(report));
    await sleep(intervalMs, signal);
  }
}

/** What makes two alerts the same ongoing condition: kind, wallet, and what it is about. */
function alertKey(alert: Alert): string {
  const detail = alert.detail;
  const subject = [detail["delegate"], detail["token"], detail["endpoint"], detail["asset"], detail["source"]].filter((part) => part !== undefined).join("/");
  return `${alert.kind}|${alert.wallet?.address ?? ""}|${subject}`;
}

/** How bad an alert is, for "it got worse": the observed nonce. */
function alertMagnitude(alert: Alert): bigint {
  const value = alert.detail["observed"];
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

/** An outflow alert whose balance fell again this pass: new money leaving. */
function newFall(alert: Alert): boolean {
  const fall = alert.detail["fall"];
  return typeof fall === "string" && /^\d+$/.test(fall) && BigInt(fall) > 0n;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
