# Changelog

All notable changes to `@globalmpc/evm-log-walker` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- README: a diagram of the reading pipeline and of the creation-block search, above the install line.

## [0.1.0] - 2026-09-25

First release.

### Added

- `createRpc`: a JSON-RPC client with endpoint failover, retries with backoff, `Retry-After`
  support, a default `user-agent`, shared headers, and per-endpoint headers so a credential reaches
  only the endpoint it belongs to. Redirects are not followed and not retried, so a credential in any header cannot be
  replayed to another origin, and an endpoint that is not an http(s) URL is reported by position,
  never echoed. JSON-RPC errors and HTTP 4xx refusals surface as `RpcError` with the endpoint's own
  wording; a malformed value from an endpoint surfaces as `E_RPC`.
- `redactEndpoint` and `sanitizeProviderText`: every error message and `RpcError.url` show an
  endpoint's origin only, never its path, query or userinfo, and text an endpoint sent is
  flattened and capped before it is embedded, so neither a credential nor a forged log line can
  reach a log through this package.
- `probeRpc`: measures what an endpoint answers before a walk starts, with the walk's own filter:
  chain id, head, `finalized` tag, largest served `eth_getLogs` span, and past-state support. Spans
  may be given in any order and the largest is tried first; spans wider than the chain are probed
  once, not once per span, and a malformed address or topic is rejected before any call rather
  than reported as an endpoint limit.
- `walkLogs` and `collectLogs`: read logs in chunks, halving the chunk when the endpoint refuses
  a span or a result count and growing it back after five accepted calls, with a checkpoint after
  every handled batch so a walk can resume without skipping logs. A refusal worded as a rate limit
  is never halved on, a key problem only when the wording names the span, and only the
  endpoint's own words are matched, never the endpoint's name.
- `createBlockTimestampCache`, `utcDay`, `groupByUtcDay`: bucket logs by UTC day with two
  timestamp fetches per batch in the common case, and several lookups at a time otherwise,
  stopping at the first failure.
- `findCreationBlock`: steps back from the head in doubling strides until code disappears, bisects
  that stride, and verifies the result against the deployment receipt, reporting `confirmed` or
  `unconfirmed`. Endpoints without past state produce `E_NO_ARCHIVE_STATE`.
- `creation-block` command-line tool with text and JSON output and exit codes 0, 1 and 2. Endpoints
  come from `--rpc` or, for a keyed URL that must stay out of shell history, from
  `CREATION_BLOCK_RPC` (space-separated).
- Errors carry stable codes: `E_RPC`, `E_LOGS_UNAVAILABLE`, `E_NO_ARCHIVE_STATE`, `E_NO_CODE`,
  `E_INVALID_ARGUMENT`.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
[0.1.0]: https://www.npmjs.com/package/@globalmpc/evm-log-walker/v/0.1.0
