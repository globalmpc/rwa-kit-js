# Changelog

All notable changes to `@globalmpc/holder-snapshot` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-27

### Added

- `takeSnapshot`: every holder of an ERC-20 and its balance at a block, replayed from the token's
  `Transfer` events since its creation block, which is found automatically. History is replayed
  batch by batch as it is read, so memory grows with holders, not transfers. Carries the chain id,
  block timestamp, token decimals (0 to 36; a token answering more is refused), and a `source`
  naming the endpoints by position, the block range replayed and how its start was established.
- A creation block that `findCreationBlock` could not confirm by its deployment receipt — a
  factory deployment, or an endpoint whose pruned history made the search land late — leaves the
  snapshot unverified (`fromBlockOrigin: "creation-unconfirmed"`) until it is taken again with a
  `fromBlock` the caller vouches for.
- `verifyBalances`: checks a replay against the token itself at the snapshot block —
  `totalSupply()` must equal the replayed sum, and `balanceOf` must agree for every holder (the
  default) or, for a quicker look, a deterministic sample of the largest holders plus the middle of
  even intervals through the rest. A sampled check is never payable: `buildDistribution` refuses a
  snapshot whose check did not cover every holder. A token whose balances do not follow from its events fails,
  and its snapshot cannot be paid from.
- `replayBalances` and `BalanceReplay`: pure replay of `Transfer` events into balances, in chain
  order, all at once or batch by batch, counting a log read twice once and treating addresses
  case-insensitively. A balance going negative throws `E_INCOMPLETE_HISTORY` rather than producing
  a list that is wrong for every holder after the gap.
- `applyRules`: eligibility by exclusion list, contract status and minimum balance, recording a
  reason for every holder left out.
- `allocate`: splits a pool pro-rata or equally in exact `bigint` base units. Addresses are compared
  case-insensitively, so one wallet can never take two shares. Shares are rounded down so the total
  never exceeds the pool, and the leftover is reported as `remainder`. A per-wallet cap is applied
  by repeated levelling, sharing a capped holder's excess among the others. The result does not
  depend on input order.
- `buildDistribution`: rules plus allocation from a snapshot; refuses an unverified one
  (`E_UNVERIFIED`).
- `toPayoutCsv`: the `recipient,amount` file that `address-guard payouts` and `transfer-ledger`
  read. An empty list is refused (`E_NOTHING_TO_PAY`) rather than written as a header-only file.
- `serializeSnapshot` / `parseSnapshot`: a snapshot file, so a payout can be rebuilt later. Parsing
  refuses a file whose parts contradict each other, such as holders that do not add up to the
  supply it recorded. `recheckSnapshot` takes the token from the caller, not the file, and reads
  every holder's balance, contract flag and the supply back from the chain, which also catches a holder swapped for another address or a contract
  relabelled as a wallet.
- `connectSameChain`: builds a client after asking each endpoint its chain id, refusing endpoints on
  different chains, since the client fails over between them call by call. `takeSnapshot` and
  `recheckSnapshot` accept a client with more than one endpoint only from here. `takeSnapshot` also reads the
  chain id again at the end and refuses a change.
- `streamTransfers`, `replayFromChain`, `fetchTransfers`, `findContracts`, `readBalance`,
  `readTotalSupply`, `readDecimals`, `parseUnits`, `formatUnits` and `redactEndpoints`.
- `holder-snapshot` command-line tool with `snapshot` and `distribute`, text and JSON output, and
  exit codes 0 ok, 1 usage error or nothing to pay, 2 the chain or a file could not be read, 3 the
  snapshot does not match the token or its history start is unconfirmed. `distribute` requires
  `--token` and refuses a file of another token, then rechecks every balance in the snapshot file
  against the chain before paying from it, unless `--offline` is given. Endpoints come from `--rpc` or, for a keyed URL, from `HOLDER_SNAPSHOT_RPC`; they are
  named by position in every output and error message, never by URL or host, and any credential a
  provider echoes back is masked.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
[0.1.0]: https://www.npmjs.com/package/@globalmpc/holder-snapshot/v/0.1.0
