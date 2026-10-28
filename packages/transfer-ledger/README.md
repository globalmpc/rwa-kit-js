# @globalmpc/transfer-ledger

Built by [MPC (Mineral Project Coin)](https://www.globalmpc.tech) — mining real-world asset (RWA) infrastructure.

Check a bulk token payout against what was meant to be paid.

One multisend transaction can carry hundreds of token transfers. Anything that records payments by transaction hash counts them as one payment, so a double payment and a missed one look the same from outside: the transaction succeeded. The only identity a transfer has is its transaction hash plus its position in that transaction's logs. This package reads every ERC-20 transfer that way, compares the result with your payout list, and reports missing payments, duplicates, overpayments, underpayments and payments to addresses the list does not name. It runs offline against a saved copy of the round, and its exit code is non-zero when a round is not clean, so it can gate a pipeline after every payout. Built on [`@globalmpc/evm-log-walker`](../evm-log-walker). Node 22.14 or newer (CI runs the current Node 22).

```sh
npm install @globalmpc/transfer-ledger
```

## The payout list

A CSV file: a header row naming `recipient` and `amount`, and optionally `round`, in any order; one intended payment per row. Amounts are in token units, as a person writes them, and are converted exactly using `--decimals`: an amount with more decimal places than the token has is an error, never rounded. A recipient may appear on several rows; each row is one payment.

```csv
# Q3 dividend, paid 2026-10-01
round,recipient,amount
Q3,0x1111111111111111111111111111111111111111,125.50
Q3,0x2222222222222222222222222222222222222222,40
Q3,0x3333333333333333333333333333333333333333,7.25
```

The same list in JSON: `[{ "recipient": "0x…", "amount": "125.50", "round": "Q3" }]`. Amounts are strings in JSON too, because a JSON number cannot hold every token amount exactly. When a file holds several rounds, pass `--round` to choose one; the command refuses to guess. Blank lines and lines starting with `#` are ignored, and every problem names the line it is on.

## Command line

Point it at the round's transactions:

```sh
npx --package @globalmpc/transfer-ledger transfer-ledger \
  --intent q3.csv --decimals 18 \
  --token 0xYourTokenAddress --payer 0xYourPayoutWallet \
  --tx 0xFirstMultisendHash --tx 0xSecondMultisendHash \
  --rpc https://bsc-dataseed.bnbchain.org \
  --save-transfers q3-transfers.json
```

Each `--tx` is read through its receipt: one call per transaction, so an endpoint without log history serves it, as long as it still keeps receipts that old. `--payer` keeps only transfers sent from the payout wallet, so a fee or a refund moving in the same transaction does not count as a payout. Some multisend contracts pull the round's total in first and pay each recipient from the contract itself; pass `--payer` twice then, the payout wallet first and the contract second. The move between the two is left out as a step of the payout, not a payment, and because such a contract is usually shared by many senders, its transfers count only in transactions where your wallet moved the token too, so other people's payouts through the same contract never enter your round. When the transaction hashes are not at hand, `--from <block> --to <block|tag>` reads every transfer of the token sent by `--payer` in that range instead, through `evm-log-walker`'s adaptive `eth_getLogs` walk.

`--save-transfers` writes everything that was read, with the `--payer` addresses used. Checking the same round again from that file needs no endpoint at all and applies the same payers, which is how it runs in CI:

```sh
transfer-ledger --intent q3.csv --decimals 18 --transfers q3-transfers.json
```

`TRANSFER_LEDGER_RPC` (space-separated endpoints) is the place for a keyed URL: an argument is kept in shell history and shown to other users in the process list. Reports name endpoints by origin only, never a path or key. `--json` prints the full report instead of the summary.

Exit codes: **0** clean, **1** usage error, **2** the round could not be read (a malformed list, an endpoint failure), **3** the round is not clean.

## A real run

A USDT multisend on BNB Chain: one transaction, 19 transfers to 19 recipients ([0xf420998b…c58c1ea](https://bscscan.com/tx/0xf420998b0c21b0ab1621985c395565bdb29a001483c40d27afd19e503c58c1ea)). With a payout list holding exactly what was sent, run on 4 October 2026:

```
token        0x55d398326f99059ff775485246999027b3197955 (18 decimals), chain 56
source       https://bsc-dataseed.bnbchain.org
transactions 1 read
intended     19 payment(s) to 19 recipient(s), total 1.083292339866071314
paid         19 transfer(s), total 1.083292339866071314
result       clean: every intended payment was made once, at the intended amount, and nothing else was paid
```

The same round re-checked offline from the saved file, against a list edited three ways: one recipient left off the list, one listed below what was paid, and one listed who was never paid. The output from the `result` line on:

```
result       NOT CLEAN: 1 missing, 1 overpaid, 1 unexpected

overpaid    0x408ff6a3684b3887508f8cb30813c2fe94bfbbe9 intended 0.02, paid 0.025841796240153918 (intent line 3) by 0xf420998b0c21b0ab1621985c395565bdb29a001483c40d27afd19e503c58c1ea#797
missing     0x000000000000000000000000000000000000dead 0.5 (intent line 20): no transfer found
unexpected  0x1e1083f21359861b57fe526f949558b1c4c414cf 0.03359636780874656: not on the payout list, by 0xf420998b0c21b0ab1621985c395565bdb29a001483c40d27afd19e503c58c1ea#795
```

Each finding names the list line and the exact transfer (`hash#logIndex`), so it can be looked up on an explorer. The 19 transfers were read identically from two independent endpoints. On the same day `bsc-rpc.publicnode.com` refused this receipt as an archive request and `bsc.drpc.org` answered with no receipt at all, so pick an endpoint that keeps receipts as old as the round.

## What counts as what

Transfers are first made unique by transaction hash plus log index, so reading the same transaction twice never creates a duplicate, while two transfers in one transaction stay two payments. Then, for each recipient:

| Finding | Meaning |
|---|---|
| `missing` | A line of the list with no transfer for it. |
| `duplicate` | A further transfer of an amount the recipient was already paid in full. The finding names both transfers. |
| `overpaid` / `underpaid` | A transfer that pays a line, but a different amount. |
| `extra` | A transfer to a listed recipient that matches none of their lines. |
| `unexpected` | A transfer to an address the list does not name. |

Matching is exact first (each line takes the earliest transfer of exactly its amount, in chain order), then duplicates, then what is left is paired by the smallest difference in amount, so a payment lands on the line it most plausibly paid. Addresses are compared without regard to letter case.

## From code

```js
import { createRpc } from "@globalmpc/evm-log-walker";
import { buildReport, fetchTransfersByTransaction, parseIntentCsv, reconcile } from "@globalmpc/transfer-ledger";
import { readFile } from "node:fs/promises";

const intents = parseIntentCsv(await readFile("q3.csv", "utf8"), { decimals: 18, round: "Q3" });
const { transfers } = await fetchTransfersByTransaction(createRpc({ urls: "https://bsc-dataseed.bnbchain.org" }), {
  token: "0xYourTokenAddress",
  payers: ["0xYourPayoutWallet"],
  transactionHashes: ["0xFirstMultisendHash"],
});
const result = reconcile(intents, transfers); // pure and offline: no endpoint, no clock
if (!result.clean) console.log(result.counts, result.findings);
```

| Function | Purpose |
|---|---|
| `parseIntentCsv(text, { decimals, round? })`, `parseIntentJson(…)` | The payout list as `Intent[]`, amounts in base units as `bigint`. |
| `fetchTransfersByTransaction(rpc, { token, payers?, transactionHashes })` | The token's transfers in those transactions, plus each transaction's status (a reverted one moved nothing). |
| `fetchTransfersByRange(rpc, { token, payers, fromBlock, toBlock?, chunkSize? })` | Every transfer of the token sent by one of `payers` in a block range. |
| `reconcile(intents, transfers)` | The comparison: `clean`, totals, per-recipient results, `findings`, `counts`. |
| `buildReport(reconciliation, options)` | The JSON-safe report the CLI prints: amounts as exact base-unit strings plus token units. |
| `serializeTransfers(…)`, `parseSavedTransfers(text)` | The `--save-transfers` file format, for an offline re-check. |
| `parseUnits(text, decimals)`, `formatUnits(value, decimals)` | Exact token-unit conversion; refuses anything it would have to round. |
| `selectPayouts(transfers, payers)` | The payer rule above: the wallet's payouts, and a contract's only in the wallet's transactions. |
| `transferKey(transfer)`, `uniqueTransfers(transfers)`, `decodeTransfer(log)` | Transfer identity and decoding. |

## Errors

All errors this package raises are `LedgerError` with a stable `code`; RPC failures arrive as `evm-log-walker`'s own errors.

| Code | Meaning |
|---|---|
| `E_INVALID_ARGUMENT` | An argument is unusable: a malformed address, hash or decimals. Nothing was sent. |
| `E_INTENT_FORMAT` | The payout list or a saved transfers file does not follow the format; the message names the line or entry. |
| `E_MALFORMED_TRANSFER` | A log shaped like a `Transfer` did not decode. |
| `E_MALFORMED_TX` | A receipt is missing or lacks a field this package needs. |

## What it does not do

- Native-coin payouts. A transfer of BNB or ETH emits no log, so it cannot be read this way; only ERC-20 tokens.
- Read token decimals from the chain. You pass `--decimals`, so the amounts in your list are read the way you wrote them.
- Send, retry or fix payments. It reports; what to do about a finding is a decision for whoever owns the payout.
- Judge timing. Every transfer you point it at counts, whenever it happened in the range or transactions given.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @globalmpc/transfer-ledger check   # typecheck, tests, build
```

Tests run against an in-memory chain; nothing in the test suite touches the network.

## License

MIT. See [LICENSE](LICENSE).
