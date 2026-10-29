# @globalmpc/holder-snapshot

Built by [MPC (Mineral Project Coin)](https://www.globalmpc.tech) — mining real-world asset (RWA) infrastructure.

Who held a token at a given block, and what each holder is owed. Replays every ERC-20 `Transfer` since the token's creation into balances, checks them against the token's own `balanceOf` and `totalSupply` at that block, then splits a payout pool pro-rata or equally — with exclusions, a minimum balance and a per-wallet cap — into a `recipient,amount` CSV. Built on [`@globalmpc/evm-log-walker`](../evm-log-walker). No database, no hosted service, no keys.

The use case is a dividend, yield or airdrop round: "split 10 000 USDT across holders of our token as of block 45 000 000, pro-rata, skip the treasury, the liquidity pool and anyone under 100 tokens." The usual alternative — a block-explorer export and a spreadsheet — has no check that the list is complete and no way to reproduce it later. This package does both.

```sh
npm install @globalmpc/holder-snapshot
```

## Where it fits

The CSV it writes is the format the other payout tools in this kit read, so one file goes through every step of a round:

| Step | Question | Tool |
|---|---|---|
| 1. Plan | Who is owed what? | **holder-snapshot** |
| 2. Check recipients | Is any address a poisoned look-alike? | [`address-guard payouts`](../address-guard) |
| 3. Pay | — | your wallet or multisend |
| 4. Reconcile | Did everyone get exactly what was planned, once? | `transfer-ledger` |

## Command line

```sh
# 1. Snapshot: holders at a block, checked against the token. Writes the snapshot file.
export HOLDER_SNAPSHOT_RPC="https://your-archive-endpoint/KEY"
holder-snapshot snapshot --token 0xYourToken --block 45000000 --classify --out snapshot.json

# 2. Distribute: 10 000 of a 6-decimal payout token, pro-rata. Every balance in the file is
#    rechecked against the chain first (the same HOLDER_SNAPSHOT_RPC is used).
holder-snapshot distribute --token 0xYourToken --snapshot snapshot.json --pool 10000 --decimals 6 \
  --exclude 0xTreasury --exclude 0x000000000000000000000000000000000000dEaD \
  --exclude-contracts --min-balance 100 --cap 500 --out payouts.csv
```

`snapshot` prints what it read and whether it checks out:

```
token        0x… on chain 56
block        45000000 (2026-09-30T23:59:58.000Z)
history      blocks 31000412-45000000 (from creation), 18234 transfer(s)
holders      812, total 25900000, 14 contract(s)
verified     yes: totalSupply matches and 812 balance(s) match balanceOf
source       endpoint-1
```

`distribute` explains where the pool went, including who got nothing and why:

```
pool         10000 (pro-rata), cap 500
eligible     690; excluded 122 (listed 2, contract 14, below-minimum 106)
paid         688 recipient(s), total 9999.999871, 3 at the cap
unpaid       2 holder(s) whose share rounds to zero
remainder    0.000129
rechecked    yes: all 812 balance(s) and totalSupply match the chain
```

Without `--out`, `distribute` writes the CSV to stdout and the summary to stderr, so it can be piped. `--json` prints the full snapshot or distribution instead.

| Option | Command | Meaning |
|---|---|---|
| `--block <n\|tag>` | snapshot | snapshot block, or `latest`, `safe`, `finalized`. Default `finalized` |
| `--from-block <n>` | snapshot | first block to replay. Default: the creation block, found automatically |
| `--decimals <n>` | both | snapshot: for a token without `decimals()`. distribute: the payout token's (required) |
| `--sample <n\|all>` | snapshot | holders checked against `balanceOf`. Default `all`, which a payout needs; a number checks that many of the largest plus as many spread across the rest — a quicker look that `distribute` will not pay from without a recheck |
| `--classify` | snapshot | mark each holder as contract or wallet (one `eth_getCode` each) |
| `--snapshot <file>` | distribute | a file written by `snapshot --out` (required) |
| `--token <address>` | both | snapshot: the ERC-20 to read. distribute: the token whose holders are paid; the file must be of it (required) |
| `--pool <amount>` | distribute | total to distribute, in payout-token units (required) |
| `--mode <mode>` | distribute | `pro-rata` (default) or `equal` |
| `--cap <amount>` | distribute | most any one holder receives, in payout-token units |
| `--min-balance <amount>` | distribute | holders below this, in snapshot-token units, get nothing |
| `--exclude <address>` | distribute | never pay this address; repeat for several |
| `--exclude-contracts` | distribute | never pay a contract; needs a `--classify` snapshot |
| `--out <file>` | both | snapshot: the JSON file. distribute: the CSV |
| `--rpc <url>` | both | JSON-RPC endpoint; repeat to add fallbacks. distribute uses it to recheck the file |
| `--offline` | distribute | skip the recheck and trust the snapshot file as written |

Several endpoints may be given as fallbacks, but they must all serve the same chain: the client fails over between them call by call, so before reading anything every endpoint is asked its chain id, and differing answers are refused. In code, a client with more than one endpoint must come from `connectSameChain`; `takeSnapshot` and `recheckSnapshot` refuse any other.

`HOLDER_SNAPSHOT_RPC` (space-separated endpoints) is the place for a keyed URL: an argument is kept in shell history and shown to other users in the process list. Endpoints are named by position (`endpoint-1`) in every output and every error message, never by URL or host, because some providers put the key in the host itself; and a key a provider echoes back in an error is masked before it is printed.

Exit codes: `0` ok, `1` usage error, or the rules leave nobody to pay, `2` the chain or a file could not be read, `3` the snapshot does not match the token's own balances or its history start could not be confirmed. In CI, a non-zero exit stops the round before anyone is paid from a wrong list. An empty payout is never written as a header-only file.

### Trusting a snapshot file

A snapshot file carries no proof of where it came from: one edited after it was written can still say `verified: true`. Two things guard against that:

- **Reading a file**, `parseSnapshot` refuses one whose parts contradict each other — holders that do not add up to the supply it recorded, or a `verified` flag alongside mismatches. That catches an added, removed or resized holder.
- **Before paying**, `distribute` requires `--token` and refuses a file of any other token — the file cannot vouch for which token it describes — then reads every holder's balance and `totalSupply()` back from the chain at the snapshot block, and for a `--classify` snapshot every holder's contract status too (`recheckSnapshot`). That also catches a holder swapped for another address at the same balance, or a liquidity pool relabelled as a wallet so that `--exclude-contracts` would pay it, which no check of the file alone can see. It is one or two calls per holder.

`--offline` skips the second step. Use it only for a file you produced and kept under your control, such as one committed alongside the CI job that consumes it.

## How a snapshot is checked

A balance is everything that ever arrived minus everything that ever left, so the replay starts at the token's creation block. Three checks then stand between the replay and a payout:

1. **Before replay**, the creation block must be confirmed: `findCreationBlock` finds the first block with code at the token's address, then confirms it by the deployment's receipt. A token deployed by another contract (a factory) leaves no receipt to confirm, and an endpoint that has pruned old state can answer "no code" for blocks after the real deployment, making the search land too late. An unconfirmed start leaves the snapshot unverified (exit 3); take it again with `--from-block` set to a creation block you have checked, for example on a block explorer.
2. **During replay**, a balance going negative means transfers are missing; the snapshot is refused (`E_INCOMPLETE_HISTORY`, exit 3).
3. **After replay**, `totalSupply()` at the snapshot block must equal the sum of replayed balances, and `balanceOf` must agree for every holder. Checking only some is not enough to pay from: a balance moved between two unchecked wallets without an event leaves the supply unchanged. `--sample <n>` gives a quicker look — the largest holders plus the middle of even intervals through the rest, at least one — but `buildDistribution` refuses a snapshot whose check did not cover every holder, unless `distribute` rechecks it first.

History is replayed batch by batch as it is read, so memory grows with the number of holders, not the number of transfers.

A token whose balances do not follow from its events — rebasing, reflection, or fee-on-transfer without a matching event — fails the second check. That is deliberate: its holder list cannot be rebuilt from logs, and `distribute` refuses an unverified snapshot.

Reading balances at a past block needs an endpoint that keeps historical state (an archive node). Public endpoints usually serve only recent blocks.

## How the pool is split

- **Exact arithmetic.** All amounts are `bigint` base units. Every share is rounded down, so the total paid can never exceed the pool; what is left over is reported as `remainder`, not handed to an arbitrary holder.
- **Pro-rata with a cap.** A holder whose share exceeds the cap is fixed at the cap and the rest of the pool is shared again among the others, repeating until nobody new crosses it. In `equal` mode everyone is already level, so a cap leaves the excess in `remainder`.
- **Every exclusion has a reason**: `listed`, `contract` or `below-minimum`, in that order of precedence. A holder whose share rounds to zero is listed as `unpaid`.
- **Order-independent.** The same snapshot and rules always produce the same file.

## API

```js
import { buildDistribution, connectSameChain, parseUnits, takeSnapshot, toPayoutCsv } from "@globalmpc/holder-snapshot";

// One endpoint can also be a plain createRpc client; fallbacks must come through connectSameChain.
const { rpc } = await connectSameChain({ urls: process.env.HOLDER_SNAPSHOT_RPC.split(" ") });
const snapshot = await takeSnapshot(rpc, { token: "0xYourToken", block: 45_000_000, classify: true });
if (!snapshot.verification.verified) throw new Error("snapshot does not match the token");

const distribution = buildDistribution(snapshot, {
  pool: parseUnits("10000", 6),
  exclude: ["0xTreasury"],
  excludeContracts: true,
  minBalance: parseUnits("100", snapshot.decimals),
});
const csv = toPayoutCsv(distribution.allocations, 6);
```

| Export | What it does |
|---|---|
| `takeSnapshot(rpc, options)` | holders at a block, with `verification` and `source` |
| `buildDistribution(snapshot, options)` | rules plus allocation; refuses an unverified snapshot |
| `serializeSnapshot` / `parseSnapshot` | the snapshot file; parsing refuses one that contradicts itself |
| `recheckSnapshot(rpc, snapshot, { token })` | every holder's balance, contract flag and the supply, read back from the chain, for a token the caller names |
| `connectSameChain(rpcOptions)` | a client whose endpoints were each asked their chain id; required for more than one endpoint |
| `replayBalances(transfers, { atBlock })` | pure: `Transfer` events to balances |
| `applyRules(holders, rules)` | pure: eligible holders and reasoned exclusions |
| `allocate(holders, { pool, mode, cap })` | pure: the split, with `remainder` and `unpaid` |
| `toPayoutCsv(allocations, decimals)` | the `recipient,amount` file |
| `fetchTransfers`, `verifyBalances`, `findContracts` | the chain reads `takeSnapshot` is built from |
| `parseUnits` / `formatUnits` | exact token-unit conversion |

## Errors

Every error this package raises is a `SnapshotError` with a stable `code`: `E_INVALID_ARGUMENT`, `E_INVALID_ADDRESS`, `E_INVALID_AMOUNT`, `E_MALFORMED_TRANSFER`, `E_MALFORMED_RESPONSE`, `E_INCOMPLETE_HISTORY`, `E_UNVERIFIED`, `E_SNAPSHOT_FORMAT` and `E_NOTHING_TO_PAY`. Endpoint failures are `evm-log-walker`'s `WalkerError` / `RpcError`, unchanged.

## What it does not do

- **It does not pay.** It writes the list; sending is up to your wallet or multisend, and checking the result is `transfer-ledger`'s job.
- **It does not look through contracts.** A liquidity pool or vault is one holder; the people with a stake in it are not resolved. Exclude it, or handle it separately.
- **It does not judge recipients.** Run the CSV through `address-guard payouts` before sending.

## Development

```sh
pnpm --filter @globalmpc/holder-snapshot check   # typecheck, test, build
```

Tests run against an in-memory chain; nothing touches the network.

## License

MIT
