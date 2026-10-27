# Phase 0 notes — what this package builds on

Working notes, not published documentation. `files` in `package.json` excludes this file.

## `@globalmpc/evm-log-walker` API actually used

Read from `packages/evm-log-walker/src/index.ts` at `8082648`. Real names only; nothing below is invented.

| Export | Kind | Why this package needs it |
| --- | --- | --- |
| `createRpc(options)` | fn | Builds the JSON-RPC client. Multi-endpoint failover, retries, timeout, `redirect: "manual"`. |
| `Rpc` | type | `{ call<T>(method, params): Promise<T>; urls: readonly string[] }`. The only transport contract. |
| `Endpoint` | type | `{ url, headers? }` — per-endpoint headers, where a keyed URL's credential belongs. |
| `redactEndpoint(url)` | fn | Origin only (scheme/host/port). Every `SourceInfo.endpoint` is passed through this. |
| `walkLogs(options)` | async gen | Bounded, checkpointed `eth_getLogs` walk. Yields `LogBatch`, returns `WalkSummary`. |
| `collectLogs(options)` | fn | `walkLogs` to completion. Used when the whole range fits in memory. |
| `resolveBlock(rpc, block)` | fn | Resolves `"latest" \| "finalized" \| "safe"` to a number once, up front. |
| `Log` | type | Decoded log. `blockNumber`/`logIndex`/`transactionIndex` are numbers; `removed` is present. |
| `LogBatch`, `Checkpoint`, `WalkSummary` | types | `Checkpoint` is `{ nextBlock, toBlock }` — resume by passing `nextBlock` as `fromBlock`. |
| `BlockTag`, `TopicFilter` | types | `TopicFilter` is `(Hex \| Hex[] \| null)[]`, so position 1 or 2 can be an address set. |
| `WalkerError`, `RpcError`, `isRangeLimitError` | class/fn | Thrown through unchanged. This package adds its own codes on top. |
| `Hex` | type | `` `0x${string}` ``. Re-exported from this package's `hex.ts`, as `transfer-ledger` does. |
| `fromQuantity`, `toQuantity` | fn | Hex quantity <-> number for block numbers. |

Deliberately unused: `probeRpc`, `findCreationBlock`, `createBlockTimestampCache`, `groupByUtcDay`,
`utcDay`, `sanitizeProviderText`.

## Can the walker support a bounded, checkpointed Transfer-log scan?

**Yes.** `WalkOptions` carries `fromBlock`, `toBlock` (number or tag), `chunkSize`, `minChunkSize`
and `onCheckpoint`. `walkLogs` halves the chunk on a range-limit refusal and grows it back after
five accepted calls, and calls `onCheckpoint({ nextBlock, toBlock })` after each batch is consumed.
Filtering is `address` plus `topics`, and `TopicFilter` allows an array at one position, so
`[TRANSFER_TOPIC, null, ownerTopic]` reads incoming transfers and `[TRANSFER_TOPIC, ownerTopic]`
outgoing ones. The Phase 0 stop condition does not apply.

## Batched transaction lookups — a correction to the brief

The brief asks for `eth_getTransactionByHash` "in batches". `Rpc.call` cannot do JSON-RPC array
batching: `rpc.ts` sends `JSON.stringify({ jsonrpc, id, method, params })`, a single object, and
there is no batch entry point. "Batched" is therefore implemented as **bounded concurrency**, which
is what `transfer-ledger` already does for receipts: `forEachConcurrently(items, 8, task)` in
`packages/transfer-ledger/src/concurrency.ts`. This package carries its own copy of that helper
rather than depending on `transfer-ledger`, because packages here depend on each other only through
the registry and a look-alike check must not pull in a payout reconciler.

## Prior art followed

- `packages/transfer-ledger/src/hex.ts` — each package keeps its own `hex.ts`; the walker exports
  only `Hex`, `fromQuantity`, `toQuantity`. `addressToTopic` / `topicToAddress` are copied from it.
- `packages/transfer-ledger/src/transfers.ts` — `TRANSFER_TOPIC`, and the rule that an ERC-20
  `Transfer` has exactly three topics (an ERC-721 `Transfer` shares the signature but has four).
- `packages/transfer-ledger/src/errors.ts` — one error class with a stable `code` union.
- `packages/transfer-ledger/src/cli/transfer-ledger.ts` — `parseArgs` from `node:util`, a `CliIo`
  interface with injected `stdout`/`stderr`/`env`/`fetch`, an exported `EXIT` map and `USAGE`
  string, and `run…(argv, io): Promise<number>` so exit codes are testable without a subprocess.

## The zero-value `transferFrom` risk (Phase 0 spike)

An ERC-20 `Transfer(from, to, value)` log names `from` in its topics, but that is the token's
accounting, not the transaction's sender. `transferFrom(victim, attacker, 0)` emits
`Transfer(victim, attacker, 0)` while `tx.from` is the attacker.

Confirmed from the specification rather than a live fixture. EIP-20 places no lower bound on the
allowance for a zero transfer, and it requires `Transfer` to fire even when `value` is zero. The
OpenZeppelin implementation most tokens use checks `currentAllowance >= value` before spending, so
`value == 0` against a zero allowance passes (`0 >= 0`) and the event fires. Any address can
therefore mint a log that appears to be an outgoing send from any holder.

**Rule adopted, the stricter one:** an event counts as a real outgoing send only when the
transaction's own `from` equals the owner, fetched with `eth_getTransactionByHash`. The log's
`from` topic is never trusted on its own. Both halves are also required: `success === true` and
`valueRaw > 0n`.

Residual uncertainty, recorded in the README: this was derived from EIP-20 and the OpenZeppelin
sources, not reproduced against a specific deployed token. A token that reverts on a zero-value
`transferFrom` would make the attack impossible for that token, but the rule costs nothing there,
so the strict rule holds regardless and no token-specific behaviour is assumed.
