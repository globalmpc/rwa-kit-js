# Changelog

All notable changes to `@globalmpc/address-guard` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `deriveTrustedRecipients`: the recipients an owner has really sent to. Counts an event only when
  it is outgoing, succeeded, moved a non-zero amount, and the transaction's own `from` is the
  owner. That last condition is the point: an ERC-20 `Transfer` log names its `from` in an indexed
  topic, so `transferFrom(victim, attacker, 0)` can mint a log that reads as the victim's own send,
  and believing it would let a look-alike enrol itself as trusted. Pure and offline.
- `toChecksum`, `isValidChecksum` and `checksumState`: EIP-55 over keccak-256. `isValidChecksum`
  gives the same answer as viem's `isAddress`, including its asymmetry — all lower case passes,
  all upper case does not. `checksumState` separates "unchecksummed" from "wrong".
- `findLookalikes`: every known address a candidate imitates — same first and last `n` hex
  characters, different middle, compared case-insensitively. An exact match is never a look-alike,
  and a window leaving no middle is refused rather than silently never firing.
- `assessRecipient`: one verdict of `trusted`, `new`, `lookalike`, `invalid` or `bad-checksum`,
  with `reasons[]` and `evidence[]`. An exact trusted match outranks look-alike-ness; a look-alike
  outranks a checksum complaint.
- `rpcLogSource`: history over JSON-RPC through `@globalmpc/evm-log-walker`'s adaptive,
  checkpointed `eth_getLogs` walk, with every producing transaction looked up by hash at bounded
  concurrency to establish its real sender. `indexerThenRpc`: try an indexer, fall back to RPC, and
  record which one answered — including when the indexer answers with nothing at all, which cannot
  be told apart from an index still catching up.
- `parsePayoutCsv`: one recipient per line, `#` comments and an optional header. Amounts are not
  parsed; this tool decides where not to send, never how much.
- `address-guard` command-line tool with `check`, `scan`, `checksum` and `payouts`, text and JSON
  output, and exit codes 0 trusted, 10 new, 20 look-alike, 30 invalid or bad checksum, 1 usage
  error, 2 the history could not be read. Endpoints come from `--rpc` or, for a keyed URL, from
  `ADDRESS_GUARD_RPC`, and are reported by origin only. Every JSON payload carries a `source`
  object naming the endpoint and the block range the answer came from.

### Fixed

Found in review before the first release; all six are covered by regression tests.

- `payouts` could report a look-alike as `trusted`. The self-exclusion compared a lower-cased
  address against the file's own casing, so a checksummed row kept its own address in the set it
  was judged against, matched itself exactly, and won the trusted verdict over the look-alike
  evidence. A single-row batch exited 0 — the one outcome a look-alike must never produce.
- `--indexer` only added a failover URL to one RPC client, which fails over on transport failures
  alone. An indexer answering `eth_getLogs` with an empty array has answered successfully, so the
  documented fallback to `--rpc` never fired and a look-alike was reported `new`. It now builds two
  sources and composes them with `indexerThenRpc`.
- `indexerThenRpc` accepted any answer carrying at least one event. A partially caught-up index can
  hold a recent inbound dust transfer while missing the owner's older genuine sends, which empties
  the trusted set. The answer is now accepted only when the range it reports covering reaches the
  whole requested range.
- `SourceInfo.endpoint` named the first configured endpoint as though it had answered, which is not
  knowable: the client fails over and does not report which endpoint served a call. `endpoints` now
  lists every configured endpoint and `endpoint` is documented as the first of them.
- `isRealOutgoingSend` is exported, and its zero-value protection relied on the caller passing a
  floor of at least `1n`. It now tests `valueRaw > 0n` itself, so the rule holds for direct callers.
- `check` fetched history before judging the candidate's shape, so an unreachable endpoint turned a
  certain `invalid` into exit 2. A malformed candidate is now decided first, with `source: null`.

Found in a second review round; all seven are covered by regression tests.

- `indexerThenRpc` could accept an incomplete history on the CLI's **default** path. The coverage
  check added in the first round only ran when a block range was passed, and the CLI passed none
  unless `--from-block` was given, so a lagging index holding one recent dust transfer was accepted
  and the trusted set came back empty — reporting the attacker's look-alike as `new`. An answer is
  now accepted only when a range was requested, the index covers all of it, **and** it returned
  events; an index that claims the range but answers with nothing is indistinguishable from a quiet
  owner and is verified against RPC.
- `--to-block` reached each source's configuration but not the fetch range, so an index stopping
  before the requested end block could not be detected. The CLI now resolves a concrete window —
  through the RPC endpoint, not the indexer whose completeness is in question — and passes both
  bounds.
- A keyed endpoint's credential could reach stderr. The walker redacts endpoint URLs to their
  origin and `sanitizeProviderText` fixes the shape of a provider's wording, but neither removes
  secrets, so a provider answering `invalid API key: <key>` had that text printed verbatim into a
  CI log. Everything beyond the origin in a supplied endpoint URL is now masked in any message the
  CLI writes.
- `--from-block`, `--to-block`, `--prefix` and `--suffix` accepted integers above
  `Number.MAX_SAFE_INTEGER`, which `Number()` silently rounds, so the command could read a
  different range from the one requested. Such values are now refused.
- `scan` kept only the first inbound transfer per sender, so the amount, hash and block it reported
  could describe a different transfer from the one that poisoned the history. Every inbound
  transfer from a look-alike sender is now reported, smallest first.
- `rpcLogSource` accumulated each complete walk before processing it. Batches are now streamed, so
  raw logs are held one batch at a time, and the transfers kept are bounded by `maxEvents`
  (`DEFAULT_MAX_EVENTS`, 200 000) — reaching it fails with a message naming the fix instead of
  exhausting memory with no verdict.
- `payouts` was quadratic: every row rebuilt a list of all other recipients and the assessment
  rescanned it, so a 10 000-row file made roughly 100 million comparisons. Recipients are indexed
  once by the prefix and suffix actually compared, which is exact rather than an approximation —
  an address in another bucket could never have matched.

Found in a third review round; all five are covered by regression tests.

- `indexerThenRpc` could still accept an incomplete history, because the completeness check added
  in the second round was a **tautology on the CLI's own path**. `rpcLogSource` fills
  `SourceInfo.fromBlock`/`toBlock` from the range it was *queried for*, so comparing those against
  the requested range always passed — and the CLI built its indexer with `rpcLogSource`.
  `SourceInfo.coverage` is now a separate, optional field holding a source's own statement of what
  it has indexed; `rpcLogSource` never sets it, and an indexer without it is never preferred over
  RPC. **`--indexer` has been removed from the CLI**: a JSON-RPC endpoint has no way to say how
  much of the chain it has seen. `indexerThenRpc` remains for adapters that can.
- `secretsFromEndpoints` collected only the percent-encoded spelling of a credential, so a provider
  echoing the decoded form (`key/part123` for a URL carrying `key%2Fpart123`) printed it to stderr
  unmasked. Both spellings are now collected.
- `scan` called an inbound transfer's counterparty the "sender" and said it "sent" the transfer.
  That address comes from the log's `from` topic, which is forgeable — the premise of this whole
  package. Findings now report `claimedBy`, the address the log names, alongside the `txFrom` that
  actually signed each transaction.
- `scan` called `findLookalikes` directly and so bypassed the exact-trusted-match precedence
  `assessRecipient` applies. Two genuine recipients sharing both ends made each other look like
  poisoners and the command exited 20. Addresses already in the trusted set are now excluded.
- `onCheckpoint` fired for both filtered walks with no way to tell them apart, while the collected
  transfers lived only in memory — so the documented "resume" was not achievable. The callback now
  carries a `phase` of `"outgoing"` or `"incoming"`, and it is documented as progress reporting
  rather than resumption.

### Not changed

- A static-analysis rule flagged `lower !== secret` in `redactSecrets` as a timing-unsafe secret
  comparison and suggested `crypto.timingSafeEqual`. It is neither a comparison against an
  attacker-supplied value nor an authentication decision: it checks whether a string we already
  hold differs from its own lower-cased form, to decide whether a second pass is needed. There is
  no oracle and no secret to protect from anyone, and `timingSafeEqual` throws on unequal lengths.
  Left as it is, deliberately.

Found in a fourth review round; all seven are covered by regression tests.

- **`tokens` is now required**, by `rpcLogSource` and by the CLI's `--token`. An unfiltered read
  was not merely expensive, it was unsound: any contract can emit a three-topic
  `Transfer(owner, anyone, value)` without a token moving, so an owner signing one transaction to
  an attacker's contract — a fake airdrop claim — let that contract emit
  `Transfer(owner, lookalike, 1000)` and satisfy *every* condition of the trust rule, `txFrom`
  included, because the owner really did sign it. The look-alike became trusted and `check` exited
  0 on it. This was the most serious defect found in any round.
- `indexerThenRpc` left the upper bound unchecked when a range had no `toBlock`, so an index
  covering blocks 0-100 satisfied a request for `{ fromBlock: 0 }` and hid a genuine send at block
  150. Both bounds are now required before an indexer is preferred.
- `redactSecrets` documented itself as case-insensitive but matched only the literal spelling and
  its lower-cased form, so a provider echoing `ABC123SECRET` for a key of `abc123secret` printed
  the credential. It now matches case-insensitively, with the secret escaped so one containing
  regex operators is treated literally.
- The payout header pattern was prefix-anchored, so a first row of `to review` was dropped as a
  header and never assessed. It must now equal `recipient`, `address` or `to`.
- Surplus positional arguments were ignored, so `payouts safe.csv unchecked.csv` assessed only the
  first file and could exit 0. They are refused.
- `forEachConcurrently` built no workers for a limit of zero or less and resolved as though every
  item had been handled. A non-positive or fractional limit is refused. (The same helper in
  `@globalmpc/transfer-ledger`, which this was copied from, has the same gap.)
- `payouts` bounded comparisons by bucket but still assessed an entire bucket per row, so a file
  whose addresses all share the compared window was quadratic again and produced an enormous
  evidence list. Every address in a bucket matches by construction, so the first decides the
  verdict: evidence is capped at 10 and the true count is reported as `imitatesTotal` with
  `evidenceTruncated`, so the cap hides nothing.

### Not changed

- The `crypto.timingSafeEqual` rule fired again on `redactSecrets`. The line it flagged
  (`lower !== secret`) no longer exists — the case-insensitive fix removed it — so the finding is
  moot. The reasoning from the previous round stands regardless: it was never a comparison against
  attacker-supplied input, nor an authentication decision.

Found in a fifth review round; all six are covered by regression tests.

- **The trust rule gained a fifth condition: the owner's signed calldata must name the
  recipient.** `txFrom === owner` establishes only that the owner signed *something*. An owner who
  has approved a spender can sign a call to that spender, which then calls
  `transferFrom(owner, attacker, value)` on a token this package trusts — a real movement of a
  named token, with the owner as signer and a non-zero value, satisfying every previous condition
  while the owner never saw the recipient. The look-alike became trusted, so a one-time approval
  drain turned into persistent mis-trust and a later manual payment to it was waved through. An
  event now also requires that the transaction called the token directly with
  `transfer(address,uint256)` and that its address argument is the counterparty. `HistoryEvent`
  gained `txTo` and `txTransferTo`; `ownerNamedRecipient` is exported. **This is strict: a payout
  made through a multisend or a Safe no longer evidences an intended recipient**, so those
  recipients stay `new`.
- `indexerThenRpc` checked what an indexer had *indexed* but not the range its answer had actually
  *read*. A source reporting coverage of blocks 0–200 could clamp one fetch to 101–200, returning a
  recent poison transfer while omitting a genuine send at block 50. The answer's own
  `fromBlock`/`toBlock` must now span the request too.
- `secretsFromEndpoints` applied a six-character floor to everything, so a five-character API key
  in a query string or in userinfo was dropped and printed. Explicit credential fields now use a
  floor of four; the higher floor is kept for path fragments, where masking `v2` or `eth` would
  scrub ordinary words from every message.
- `payouts` copied and filtered an entire bucket for each row before applying the evidence cap, so
  a file whose addresses all share the compared window scanned every entry for every row — the
  quadratic cost bucketing was meant to remove. Peers are now selected while iterating and the
  loop stops at the cap.
- `maxEvents` was used as a memory bound without validation, and `Infinity` or `NaN` made the size
  comparison permanently false, disabling the cap entirely. It must be a positive safe integer.
- The README's payout example omitted the now-required `--token`, so copying it produced a usage
  error. A test now asserts every documented `check`, `scan` and `payouts` command includes it.

Found in a sixth review round; all five are covered by regression tests.

- `SourceInfo` reported endpoints by origin, which keeps the host — and a host can itself be the
  credential, since some providers issue keyed subdomains. A successful `--json` result for
  `https://<key>.rpc.example` wrote the key into `source.endpoint` and `source.endpoints`.
  Endpoints are now named by position (`endpoint-1`), which identifies which configured endpoint
  was used without echoing any part of the URL; `endpointLabel` opts back into origins.
- `secretsFromEndpoints` kept a six-character floor for path segments, on the reasoning that a
  path is "maybe routing" — which left a five-character key in `https://rpc.example/abcde`
  unmasked and printed when a provider echoed it. There is now one floor of four for every
  component: over-masking costs readability, under-masking puts a key in a log.
- `payouts` passed the batch's other recipients to `assessRecipient` as `trusted`, so its reasons
  described addresses the owner had never paid as recipients it had, with `trustedCount` sitting
  at zero in the same payload. `AssessContext` gained a separate `peers`, and each
  `LookalikeMatch` now carries `knownFrom: "history" | "batch"` so the two claims stay apart. A
  peer match can never produce a `trusted` verdict.
- The truncation flag compared the peer count against the list passed in, which also held the
  row's own address when it was historically trusted while the count excluded it — so a trusted
  row one peer over the cap reported neither `imitatesTotal` nor `evidenceTruncated`. It is now
  measured against the evidence actually reported.
- `IndexerThenRpcOptions.maxBlocks` was accepted and immediately discarded by `void options`; it
  could not affect either source. The option and the third argument are removed.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
