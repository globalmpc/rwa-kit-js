# Changelog

All notable changes to `@globalmpc/transfer-ledger` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-28

### Added

- `reconcile`: compares a payout list with the transfers the chain shows, one recipient at a time,
  and reports `missing`, `duplicate`, `overpaid`, `underpaid`, `extra` and `unexpected` payments.
  Transfers are identified by transaction hash plus log index, so one multisend counts as many
  payments and the same transaction read twice is never a duplicate. Pure and offline.
- `parseIntentCsv` and `parseIntentJson`: the payout list, with amounts in token units converted
  exactly; every problem names its line, and a file with several rounds needs one chosen.
- `fetchTransfersByTransaction` (through receipts, reporting reverted transactions) and
  `fetchTransfersByRange` (through `evm-log-walker`'s adaptive `eth_getLogs` walk, filtered on the
  payers). `selectPayouts`: the payout wallet first, then any contract paying on its behalf, such
  as a multisend that pulls the total in first; a contract's transfers count only in transactions
  where the wallet moved the token too, so a shared contract never brings in other senders'
  payouts, and transfers between payers are left out.
- `buildReport`, `serializeTransfers` and `parseSavedTransfers`: a JSON-safe report with exact
  base-unit amounts, and a saved-transfers file for re-checking a round offline.
- `transfer-ledger` command-line tool with text and JSON output and exit codes 0 clean, 1 usage
  error, 2 the round could not be read, 3 the round is not clean. Endpoints come from `--rpc` or,
  for a keyed URL, from `TRANSFER_LEDGER_RPC`, and are reported by origin only.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
[0.1.0]: https://www.npmjs.com/package/@globalmpc/transfer-ledger/v/0.1.0
