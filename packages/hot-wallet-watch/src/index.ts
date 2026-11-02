export { SEVERITY, type Alert, type AlertKind, type Severity } from "./alerts.js";
export { WatchError, type WatchErrorCode } from "./errors.js";
export { classifyCode, type Address, type CodeState, type Hex } from "./hex.js";
export type { OutflowLimit, TokenWatch, WalletSpec } from "./spec.js";
export { watch, type WatchOptions } from "./watch.js";
export { createWatcher, type Report, type Watcher, type WatcherOptions, type WalletReport } from "./watcher.js";
export { configFromJson } from "./cli/hot-wallet-watch.js";
