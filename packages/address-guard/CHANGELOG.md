# Changelog

All notable changes to `@globalmpc/address-guard` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-27

### Added

- `deriveTrustedRecipients`: the recipients an owner has really sent to. An event counts only when
  it is outgoing, succeeded, moved a non-zero amount, was signed by the owner (the transaction's
  own `from`), and the owner's signed calldata named the recipient — a direct
  `transfer(address,uint256)` call on the token whose address argument is the counterparty. An
  ERC-20 `Transfer` log names its `from` in an indexed topic, so `transferFrom(victim, attacker, 0)`
  can mint a log that reads as the victim's own send; and an approved spender can move the owner's
  tokens in a transaction the owner signed without ever seeing the recipient. Believing either
  would let a look-alike enrol itself as trusted. Payouts made through a multisend or a Safe do
  not evidence an intended recipient, so those recipients stay `new`. `isRealOutgoingSend` and
  `ownerNamedRecipient` expose the individual checks. Pure and offline.
- `toChecksum`, `isValidChecksum` and `checksumState`: EIP-55 over keccak-256. `isValidChecksum`
  gives the same answer as viem's `isAddress`, including its asymmetry — all lower case passes,
  all upper case does not. `checksumState` separates "unchecksummed" from "wrong".
- `findLookalikes`: every known address a candidate imitates — same first and last `n` hex
  characters, different middle, compared case-insensitively. An exact match is never a look-alike,
  and a window leaving no middle is refused rather than silently never firing. Each match records
  `knownFrom: "history" | "batch"`.
- `assessRecipient`: one verdict of `trusted`, `new`, `lookalike`, `invalid` or `bad-checksum`,
  with `reasons[]` and `evidence[]`. An exact trusted match outranks look-alike-ness; a look-alike
  outranks a checksum complaint. `AssessContext.peers` holds other recipients in the same batch,
  kept apart from `trusted`: a peer match can flag a look-alike but never produce `trusted`.
- `rpcLogSource`: history over JSON-RPC through
  `@globalmpc/evm-log-walker`'s adaptive `eth_getLogs` walk, with every producing transaction
  looked up by hash at bounded concurrency to establish its real sender and calldata. `tokens` is
  required: any contract can emit `Transfer(owner, anyone, value)` without a token moving, so an
  unfiltered read is unsound, not just slow. Batches are streamed, and the transfers kept are
  bounded by `maxEvents` (`DEFAULT_MAX_EVENTS`, 200 000; must be a positive safe integer).
  `onCheckpoint` reports progress with a `phase` of `"outgoing"` or `"incoming"`; it is not a
  resume mechanism.
- `indexerThenRpc`: prefer an indexer, fall back to RPC, and record which one answered. An
  indexer's answer is used only when it states its own `coverage`, that coverage and the range it
  actually read both span the full requested range (both bounds required), and it returned events.
  An empty answer cannot be told apart from an index still catching up, so it is verified against
  RPC.
- `SourceInfo` on every history: the block range read, an optional `coverage`, and the configured
  endpoints named by position (`endpoint-1`, …) rather than by URL, since a host can itself carry
  a key. `endpointLabel` opts back into origins.
- `parsePayoutCsv`: one recipient per line, `#` comments and an optional header row that must be
  exactly `recipient`, `address` or `to`. Amounts are not parsed; this tool decides where not to
  send, never how much.
- `redactSecrets` and `secretsFromEndpoints`: mask every credential-bearing part of an endpoint URL
  (userinfo, path, query; four characters or longer), in both percent-encoded and decoded spellings,
  matched case-insensitively.
- `forEachConcurrently`: bounded-concurrency iteration; a non-positive or fractional limit is
  refused.
- `address-guard` command-line tool with `check`, `scan`, `checksum` and `payouts`, text and JSON
  output, and exit codes 0 trusted, 10 new, 20 look-alike, 30 invalid or bad checksum, 1 usage
  error, 2 the history could not be read. Every JSON payload carries a `source` object naming the
  endpoint and block range the answer came from.
- `--token`: required by `check`, `scan` and `payouts`; repeat it to read several tokens.
- `--rpc`/`ADDRESS_GUARD_RPC`: the endpoint to read history from, the variable being the place for
  a keyed URL. Any part of an endpoint beyond its origin is masked in every message the CLI writes.
  There is no `--indexer` flag, since a JSON-RPC endpoint cannot say how much of the chain it has
  seen; `indexerThenRpc` remains for adapters that can.
- `--from-block`/`--to-block` are resolved to a concrete window through the RPC endpoint. Numeric
  options above `Number.MAX_SAFE_INTEGER` and surplus positional arguments are refused rather than
  silently rounded or ignored.
- `check` judges a malformed candidate before reading any history, so it exits 30 with
  `source: null` even when the endpoint is unreachable.
- `scan` reports every inbound transfer from a look-alike counterparty, smallest first, naming both
  `claimedBy` (the forgeable address in the log) and `txFrom` (who signed). Addresses already
  trusted are excluded.
- `payouts` indexes recipients by the compared prefix and suffix, so cost stays linear in the file
  size. Evidence per row is capped at 10, with the true count reported as `imitatesTotal` and
  `evidenceTruncated` when the cap applies.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
[0.1.0]: https://www.npmjs.com/package/@globalmpc/address-guard/v/0.1.0
