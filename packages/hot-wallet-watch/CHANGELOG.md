# Changelog

All notable changes to `@globalmpc/hot-wallet-watch` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-31

### Added

- `createWatcher`: one pass checks each endpoint's chain id and head, then reads every wallet from
  every endpoint at that endpoint's own head, each endpoint given `requestTimeoutMs` for its head
  and again for its wallet reads, so a pass lasts at most about twice that plus up to 10 seconds for
  `expectedNonce`. Every endpoint is judged on its own, and the alarm wins: a delegation or code
  seen by any endpoint is raised, so an endpoint that lies, lags or reports an inflated head can
  only blind itself. For outflows each endpoint is compared with its own last reading, so one that
  lies, lags or always reports low can only blind itself; an endpoint that missed the last pass is
  compared with the higher of its own last reading and the highest any endpoint reported then; each
  pass adds the largest fall any endpoint measured to one window per wallet and asset, so a drain
  seen in parts by endpoints taking turns still adds up; a frozen wallet's baseline is the lowest
  nonce any endpoint reported on the first pass, so neither an inflated reading nor an endpoint
  first read after a compromise can reset it. Malformed answers are failed readings, never clean
  ones; a failed token read does not cost the wallet its code and nonce checks. `check()` never
  throws for anything the chain does. Outflow windows and repeats run on a monotonic clock by
  default; `Report.at` is wall time unless a `now` clock is given. Requests are limited to
  `maxConcurrentRequests` (8) in flight per endpoint, counted until each call settles, and an
  endpoint that has used up its `requestTimeoutMs` for the pass has its remaining reads failed at
  once, unsent; and a reading from behind an endpoint's last head is skipped for outflows (the
  series restarts after three such readings in a row during which the chain advanced, counting any
  fall since its last good reading; a stuck node never restarts it). Every wallet's code, nonce and
  balance reads are queued before any token read.
- Alerts: `delegated` (EIP-7702 delegation to a contract outside the wallet's `delegates`),
  `unexpected-code`, `unexpected-nonce` (above `expectedNonce()`, or a `frozen` wallet's nonce
  rising), `outflow` (native or ERC-20 balance falls, net of deposits, above a cap within a sliding
  window; `detail.fall` is this pass's own fall), `wallet-unreadable`, `no-endpoint` and
  `token-unreadable` as critical; `endpoints-disagree`, `endpoint-failed`, `endpoint-lagging` and
  `expected-nonce-failed` as warnings. Endpoints are named by position, never by URL.
- `watch`: passes every `intervalMs` until `signal` aborts; an alert is sent when it first appears,
  again at once when it gets worse (a new fall, a higher nonce), and every `repeatAfterMs` while it
  persists; alerts due in a pass are sent together, critical first; a callback that throws is
  retried on the next pass until delivered, even if its condition has cleared; one that takes longer
  than `callbackTimeoutMs` is cut off and counted as sent. Timer options are capped at 2,147,483,647
  ms.
- `WalletSpec` validation with unknown keys refused; `expectedNonce` is given 10 seconds.
- `classifyCode` and `configFromJson`.
- `hot-wallet-watch` command-line tool: `check` (one pass, text or JSON, exit codes 0 clean, 10
  warnings, 20 critical, 1 usage, 2 no endpoint) and `watch --config` (alerts as JSON lines until
  interrupted, exit 1 on a usage or config error, exit 3 when standard output closes). `--chain-id`,
  default 56. Endpoints from `--rpc`, then `HOT_WALLET_WATCH_RPC`, then the config's `rpc`; an
  unknown command is echoed only when it looks like one; config errors never echo values from the
  file, which can hold a keyed URL, nor the path given. Both commands exit 3 when standard output
  closes early.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
[0.1.0]: https://www.npmjs.com/package/@globalmpc/hot-wallet-watch/v/0.1.0
