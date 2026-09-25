# @globalmpc/evm-log-walker

Read contract event logs from BNB Chain and other EVM networks reliably, and find a contract's creation block.

Every public endpoint answers `eth_getLogs` differently: one caps the block span, one caps the result count, one refuses log history outright, and none keeps past state. This package measures what an endpoint allows, walks history in chunks that adapt to the answer, checkpoints after every batch so a walk can resume, buckets logs by UTC day, and finds creation blocks with a receipt check. No runtime dependencies. Node 22.14 or newer (CI runs the current Node 22).

```sh
npm install @globalmpc/evm-log-walker
```

## Quick start

Probe the endpoint with the filter you will walk, walk with the chunk it answered, then bucket by day.

```js
import { collectLogs, createBlockTimestampCache, createRpc, groupByUtcDay, probeRpc } from "@globalmpc/evm-log-walker";

const rpc = createRpc({ urls: ["https://bsc-rpc.publicnode.com"] });
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEbF2De08d9173bc095c";
// keccak256("Transfer(address,address,uint256)"); compute other signatures with viem's toEventSelector or ethers' id
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const capabilities = await probeRpc(rpc, { address: WBNB, topics: [TRANSFER] });
// { chainId: 56, head: 123570303, finalizedTag: true, maxLogSpan: 100, archiveState: false }

const { logs, summary } = await collectLogs({
  rpc,
  address: WBNB,
  topics: [TRANSFER],
  fromBlock: capabilities.head - 300,
  toBlock: "finalized",
  chunkSize: capabilities.maxLogSpan ?? 100,
});
// summary: { fromBlock: 123570003, toBlock: 123570308, batches: 4, logs: 12534, calls: 4, rejectedCalls: 0, finalChunkSize: 100 }

const byDay = await groupByUtcDay(logs, createBlockTimestampCache(rpc));
// Map { "2026-09-23" => [ ...12534 logs ] }
```

Run as written on 2026-09-23: 12,534 WBNB transfers over 306 blocks in 4 calls, no refusals. The endpoint caps results at 20,000 per call, so a dense filter gets a 100-block span there; the probe found that in three calls instead of the walk discovering it one refused call at a time. `toBlock: "finalized"` resolves when the walk starts, so the window can be a few blocks longer than `head - 300`.

## Walking a long range with checkpoints

`walkLogs` yields one batch per accepted call. The checkpoint for a batch fires after your code has handled it and asked for the next one, so a walk that stops between the two repeats at most one batch and never skips one. Resume by passing the stored `nextBlock` as `fromBlock`.

```js
import { walkLogs } from "@globalmpc/evm-log-walker";
import { readFile, writeFile } from "node:fs/promises";

const stored = JSON.parse(await readFile("checkpoint.json", "utf8").catch(() => "null"));

for await (const batch of walkLogs({
  rpc,
  address: WBNB,
  topics: [TRANSFER],
  fromBlock: stored?.nextBlock ?? 123_000_000,
  chunkSize: 100,
  onCheckpoint: (checkpoint) => writeFile("checkpoint.json", JSON.stringify(checkpoint)),
})) {
  // batch.fromBlock, batch.toBlock, batch.logs
}
```

If a repeated batch matters to you, deduplicate on `(transactionHash, logIndex)`, which is the only identity a log has. Both are numbers on the decoded `Log`.

## How the walker adapts

- A refused call because of a block-span cap ("exceed maximum block range"), a result cap ("query exceeds max results"), JSON-RPC code -32005, or an HTTP 403 or 413 halves the chunk and retries the same range. After five accepted calls at a reduced size the chunk doubles again, up to `chunkSize`.
- When the smallest chunk (`minChunkSize`, default 1) is refused, the walk stops with `E_LOGS_UNAVAILABLE`, naming the endpoint and quoting its answer. That is what a public BNB Chain data seed does for every span.
- A refusal worded as a rate limit ("rate limit", "request rate", "request count", "too many requests", "quota") is never taken as "ask for less", whatever its code or status: asking for less would not help, and each retry would count against the limit. It surfaces as `RpcError` at once. A key problem ("unauthorized", "invalid api key") is taken as "ask for less" only when the wording also names the span, as it does for a range reserved for key holders.
- A refusal worded differently from the patterns above is treated as fatal and surfaces as `RpcError` with the endpoint's wording, so nothing is retried blindly. Only the endpoint's own words (`RpcError.detail`) are matched, never the message, which also names the endpoint.
- `toBlock` defaults to `"finalized"` and is resolved once at the start, so a walk never reads blocks that can still be reorganised. Pass `"latest"` if you accept that.

## Finding a creation block

Deployment scripts rarely record it, and explorers no longer offer it for free on BNB Chain. The finder steps back from the head in doubling strides until code disappears, bisects that last stride, then looks for the deployment receipt in the block it found.

```sh
export CREATION_BLOCK_RPC=https://<your archive endpoint>
npx --package @globalmpc/evm-log-walker creation-block 0xbb4CdB9CBd36B01bD1cBaEbF2De08d9173bc095c
```

```
address   0xbb4CdB9CBd36B01bD1cBaEbF2De08d9173bc095c
creation  149268
verified  yes (deployment receipt found in that block)
probes    55
```

Measured on 2026-09-23 against a keyed archive endpoint: 55 probes, 11 s, for a contract 123 million blocks old. A contract deployed last week takes a handful. Add `--json` for machine output, `--from` for a block known to be before the deployment, and `--to` for a block at which the contract exists. Exit codes: 0 found, 1 usage error, 2 lookup failed.

`CREATION_BLOCK_RPC` takes one or more endpoints separated by spaces (a comma can be part of a URL) and is the place for a keyed URL: a `--rpc` argument would be kept in shell history and shown to other users in the process list. `--rpc` (repeatable) suits public endpoints and wins when both are given. An endpoint that is not an `http:` or `https:` URL is reported by position, never echoed.

From code:

```js
import { findCreationBlock } from "@globalmpc/evm-log-walker";

const result = await findCreationBlock(rpc, WBNB);
// { address, blockNumber: 149268, verification: "confirmed", probes: 55 }
```

**This needs past state.** Public BNB Chain and opBNB endpoints refuse `eth_getCode` at old blocks, and the error says so:

```
E_NO_ARCHIVE_STATE: https://bsc-dataseed.bnbchain.org has no state for block 123570352 (it answered "missing trie node"). Finding a creation block needs an archive endpoint; public BNB Chain and opBNB endpoints do not keep past state.
```

**Read `verification` before relying on the block.** `confirmed` means a transaction in that block has a receipt whose `contractAddress` is the address, which settles it. `unconfirmed` means either the contract was created by another contract (a factory or a proxy deployer leaves no `contractAddress` on any receipt), or the endpoint answered past-state queries with empty results instead of refusing them and the search landed on the edge of its state window. Some free "archive" endpoints are pools of mixed backends and answered the same block differently across calls on 2026-09-23; an `unconfirmed` result from one of those should be cross-checked on a keyed endpoint.

## What endpoints answered on 2026-09-23

| Endpoint | `eth_getLogs` | Past state for `eth_getCode` |
|---|---|---|
| `bsc-rpc.publicnode.com` | 100 blocks for a dense filter (20,000-result cap); wider spans refused with HTTP 403 | refused |
| `bsc-dataseed.bnbchain.org` | refused at every span ("limit exceeded") | refused ("missing trie node") |
| `opbnb-mainnet-rpc.bnbchain.org`, `opbnb.publicnode.com` | 50,000 blocks | refused |
| keyed archive provider (NodeReal) | 50,000 blocks | served |

These are measurements, not documentation. Limits change; that is why `probeRpc` exists.

## API

| Function | Purpose |
|---|---|
| `createRpc({ urls, headers?, retries?, backoffMs?, timeoutMs?, fetch? })` | JSON-RPC client. `urls` is one or more endpoints, each a string or `{ url, headers }`. Fails over between them on network errors, 5xx, 408 and 429, timeouts and redirects (never followed); retries with doubling backoff and honours `Retry-After`; sends a `user-agent` naming this package. A JSON-RPC error or an HTTP 4xx surfaces as `RpcError` from that endpoint without failover. |
| `redactEndpoint(url)` | The form of an endpoint that appears in every error: its origin only (scheme, host, port). |
| `sanitizeProviderText(text)` | What is done to any text an endpoint sent before it enters a message: control characters removed, whitespace collapsed, capped at 200 characters. |
| `probeRpc(rpc, { address?, topics?, spans? })` | Measures `chainId`, `head`, `finalizedTag`, `maxLogSpan` (largest answered span at the head, `null` when logs are not served) and `archiveState`. `spans` may be given in any order; the largest is tried first. |
| `walkLogs(options)` | Async generator of `LogBatch`; returns a `WalkSummary`. Options: `rpc`, `address?`, `topics?`, `fromBlock`, `toBlock?`, `chunkSize?`, `minChunkSize?`, `onCheckpoint?`, `signal?`. |
| `collectLogs(options)` | `walkLogs` to the end; returns `{ logs, summary }`. |
| `resolveBlock(rpc, blockOrTag)` | Resolves `"latest"`, `"finalized"` or `"safe"` to a number. |
| `createBlockTimestampCache(rpc)` | Fetches each block's timestamp once. |
| `groupByUtcDay(logs, cache)` | `Map<"YYYY-MM-DD", Log[]>`, keys ascending; two timestamp fetches when a batch falls on one day. |
| `utcDay(timestampSeconds)` | `"YYYY-MM-DD"`. |
| `findCreationBlock(rpc, address, { fromBlock?, toBlock?, onProbe? })` | `{ address, blockNumber, verification, probes }`. |
| `isRangeLimitError(error)` | The rule the walker uses to decide "ask for less". |
| `toQuantity(number)`, `fromQuantity(hex)` | JSON-RPC quantity encoding. |

Every function takes the `Rpc` from `createRpc`, so a custom transport is one object with a `call(method, params)` method.

### Keyed endpoints

Put a credential on the endpoint that needs it, never in the shared `headers`, which go to every endpoint in the list:

```js
const rpc = createRpc({
  urls: [
    { url: "https://archive.example/v1/<key>", headers: { authorization: "Bearer <token>" } },
    "https://bsc-rpc.publicnode.com",
  ],
});
```

The token above is sent to the archive endpoint only; the public fallback receives the shared headers. Redirects are not followed (`redirect: "manual"`): the client moves to the next endpoint without retrying, and the error says the endpoint answered with a redirect, because `fetch` would otherwise replay the request at the new location with its headers, dropping only `authorization` when the origin changes; a credential in any other header would reach whoever the endpoint pointed at. An endpoint that is not an `http:` or `https:` URL is reported by position, never echoed. Error messages and `RpcError.url` show an endpoint's origin only, never its path, query string or userinfo, so a key of any shape anywhere in the URL cannot reach a log; when several endpoints share an origin the message says which one by position. Text an endpoint sends back is flattened to one line and capped before it is embedded, so an endpoint cannot forge log lines either. The `cause` on an `RpcError` still holds the raw error object for debugging; log `message` and `detail`, not `cause`.

## Errors

All errors are `WalkerError` with a stable `code`; `RpcError` extends it with `method`, `url`, `rpcCode`, `httpStatus` and `detail` (the endpoint's own wording).

| Code | Meaning |
|---|---|
| `E_RPC` | No endpoint answered, or the endpoint returned a JSON-RPC error, an HTTP 4xx, or a malformed value. |
| `E_LOGS_UNAVAILABLE` | The endpoint refused `eth_getLogs` for this filter even at `minChunkSize`. |
| `E_NO_ARCHIVE_STATE` | The endpoint has no past state; a creation block cannot be found there. |
| `E_NO_CODE` | The address holds no code at `toBlock`. |
| `E_INVALID_ARGUMENT` | An argument is unusable; nothing was sent. |

## What it does not do

- Decode event data. Pass topic hashes and decode `data` with viem, ethers or your ABI tooling.
- Store checkpoints. You persist the object `onCheckpoint` hands you.
- Pace requests below an endpoint's rate limit. It retries with backoff and honours `Retry-After`; steady-state throughput is yours to set with `chunkSize`.
- WebSocket or subscription transports. HTTP JSON-RPC only.
- Guarantee a creation block on an endpoint that answers pruned state with empty results. It reports `unconfirmed` so you can tell.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @globalmpc/evm-log-walker check   # typecheck, tests, build
```

Tests run against an in-memory chain that refuses requests the way public BNB Chain and opBNB endpoints do. Nothing in the test suite touches the network.

## License

MIT. See [LICENSE](LICENSE).
