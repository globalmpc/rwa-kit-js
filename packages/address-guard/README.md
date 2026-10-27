# @globalmpc/address-guard

Catch address-poisoning look-alikes before you send.

An attacker generates an address sharing the first and last few hex characters of one you really
pay, then sends you a dust or zero-value transfer so it appears in your wallet history. Later you
copy the destination from that history, check that it "starts 0xabcd and ends abcd", and pay the
attacker instead.

This package derives your trusted recipients from your own outgoing sends, flags any destination
that imitates one of them, and verifies EIP-55 checksums. It is a library and a CLI, runs offline
once the history is in hand, and exits non-zero in CI.

```sh
npm install @globalmpc/address-guard
```

## Security note: what "trusted" means

**`trusted` means "you have really sent here before". It does not mean "safe".**

A recipient becomes trusted only through a transfer that left your account, succeeded, moved a
non-zero amount, and came from a transaction *you* signed. That is a statement about your own
history and nothing else. The address may still belong to a counterparty who has since been
compromised, a service that has changed hands, or a contract that was upgraded. This package
decides where **not** to send; it never decides that sending is a good idea.

## Example

```ts
import { createRpc } from "@globalmpc/evm-log-walker";
import { assessRecipient, deriveTrustedRecipients, rpcLogSource } from "@globalmpc/address-guard";

const rpc = createRpc({ urls: process.env.RPC_URL! });
// tokens is required, and each must be a token you trust — see "Why tokens is required".
const source = rpcLogSource(rpc, { tokens: ["0x…token"], maxBlocks: 900_000 });

const { events, source: provenance } = await source.fetch("0x…owner");
const trusted = deriveTrustedRecipients(events);

const verdict = assessRecipient("0x…candidate", { trusted, source: provenance });
console.log(verdict.verdict, verdict.reasons);
// "lookalike" [ 'shares 0xabcd…abcd with a trusted recipient but differs in the middle' ]
```

Every result carries the `source` it was derived from — which endpoint, and the block range
actually read — so no figure is ever reported without saying where it came from.

Endpoints are named by **position** (`endpoint-1`, `endpoint-2`), not by host. A host can itself be
the credential: some providers issue keyed subdomains, so reporting `https://<key>.rpc.example`
would put the key in every successful result. A position still identifies which of the endpoints
*you configured* was used, and cannot leak. Pass `endpointLabel: redactEndpoint` when you know your
hosts carry no secret. The client also fails over without reporting which endpoint answered, so
`endpoint` names the first configured one rather than the answering host.

## CLI

```sh
# Judge one destination against the owner's history
address-guard check 0x…candidate --owner 0x…owner --rpc "$RPC_URL" --token 0x…token

# Find look-alikes that have poisoned the owner's history. Each finding names the
# address the inbound log claims, and separately who signed the transaction.
address-guard scan 0x…owner --rpc "$RPC_URL" --token 0x…token

# Print the EIP-55 spelling; no endpoint needed
address-guard checksum 0x…address

# Gate a payout file in CI
address-guard payouts recipients.csv --owner 0x…owner --rpc "$RPC_URL" --token 0x…token --json
```

Exit codes: **0** trusted, **10** new, **20** look-alike, **30** invalid or bad checksum, **1**
usage error, **2** the history could not be read. A batch reports its worst verdict, so one
look-alike among clean rows exits 20.

Put a keyed endpoint in `ADDRESS_GUARD_RPC` rather than `--rpc`: an argument stays in shell history
and is visible to other users in the process list.

A recipient is never compared against itself, whatever casing the file uses.

**There is no `--indexer` flag.** `indexerThenRpc` will prefer an indexer over RPC, but only one
that sets `SourceInfo.coverage` — its own statement of the block range it has actually indexed —
and that covers the whole requested range, and returned events. A plain JSON-RPC endpoint cannot
make that statement: it answers the range it is asked for and says nothing about what it may have
missed, so `rpcLogSource` never sets `coverage`. Trusting one anyway is how a partially synced
index empties the trusted set and turns a look-alike into a `new` address. To use a real indexer,
write a `HistorySource` adapter that reports its indexed head and compose it yourself.

Credentials never reach a message. Every component of an endpoint URL you supply — path, query,
userinfo, fragment — is masked in each line the CLI writes, at any length from four characters up,
so a provider that echoes your key back in an error cannot put it in a CI log. Hosts are not
reported at all by default, for the keyed-subdomain case above.

`payouts` reads one recipient per line, optionally followed by a comma and anything else. Blank
lines and `#` comments are skipped, and a `recipient`/`address`/`to` header is dropped. Amounts are
not parsed — this tool decides where not to send, never how much. A recipient is judged against
your trusted set *and* against the file's other recipients, because a row imitating another row is
the same attack carried out inside one batch.

## API

| Export | What it does |
| --- | --- |
| `toChecksum(a)` | The EIP-55 spelling. Matches viem's `getAddress`. |
| `isValidChecksum(a)` | Whether the casing is acceptable: the exact checksum, or all lower case. Matches viem's `isAddress`. |
| `checksumState(a)` | `"checksummed"` / `"unchecksummed"` / `"mismatch"`, when the distinction matters. |
| `deriveTrustedRecipients(events, opts?)` | The recipients you have really sent to. See the rule below. |
| `findLookalikes(candidate, known, opts?)` | Every known address the candidate imitates, with the shared ends. |
| `assessRecipient(candidate, ctx)` | One verdict, with `reasons[]` and `evidence[]`. `ctx.trusted` and `ctx.peers` are separate: a match against a recipient you have really paid and a match against another row of the same batch are different claims, and each `evidence` entry says which it was via `knownFrom`. |
| `rpcLogSource(rpc, opts?)` | History over JSON-RPC, through `@globalmpc/evm-log-walker`. |
| `indexerThenRpc(indexer, rpc, opts?)` | Prefer an indexer over RPC, but only one that states the range it has indexed — see below. |
| `parsePayoutCsv(text)` | The payout-file format above. |

### Why `tokens` is required

`rpcLogSource` refuses to run without at least one token contract, and the CLI refuses without
`--token`. This is a soundness requirement, not a performance one.

Any contract can emit a three-topic `Transfer(owner, anyone, value)` log without a token moving.
So if the owner signs a single transaction to an attacker's contract — a fake airdrop claim, the
most ordinary phishing step there is — that contract can emit `Transfer(owner, lookalike, 1000)`,
and **every condition of the trust rule below is satisfied**: the direction is out, a log exists
so the transaction succeeded, the value is non-zero, and `txFrom` genuinely is the owner, because
the owner genuinely signed it. The look-alike would become a trusted recipient and `check` would
exit 0 on it.

Naming the contracts closes it. A genuine ERC-20 emits `Transfer` only when its own balances move,
so a log from a token you name is evidence of a payment you made. Name only tokens you trust: the
guarantee is inherited from the contract, not from this package.

### The rule for a real outgoing send

`deriveTrustedRecipients` counts an event only when **all five** hold:

1. `direction === "out"` — money left the owner.
2. `success === true` — a reverted transaction moved nothing.
3. `valueRaw > 0n`, and `>= minValueRaw` when given — a zero-value transfer is not a send.
4. `txFrom === owner` — **the owner's own transaction**, not somebody else's.
5. **The owner's signed calldata named this recipient** — the transaction called the token
   directly with `transfer(address,uint256)`, and its address argument is this counterparty.

Rule 5 exists because signing a transaction is not the same as choosing a recipient. An owner who
has approved a spender — and approvals are everywhere — can sign a call to that spender, which
then calls `transferFrom(owner, attacker, value)` on a token you trust. The movement is real, the
token is named, the value is non-zero and the signer is the owner, so rules 1–4 all pass while the
owner never saw the recipient. The recipient is only demonstrably *chosen* when it is in the bytes
the owner signed, which is what a wallet renders as "send X to Y" before asking for a signature.

**This is strict and it has a cost.** A payout made through a multisend, a Safe, or any other
contract does not evidence an intended recipient, so those recipients stay `new`. `new` is the
safe answer to get wrong; `trusted` is not.

Rule 4 matters for a different reason. An ERC-20 `Transfer` log names its `from` in an indexed topic, and
anyone can make that topic name any account: `transferFrom(victim, attacker, 0)` emits
`Transfer(victim, attacker, 0)`, because EIP-20 requires the event even for a zero value and the
allowance check most implementations use passes for zero. If the log's `from` were believed, an
attacker could enrol its own look-alike address as one of your trusted recipients, and every later
check would wave it through as an exact match. Rule 3 closes the same door from the other side.

A floor of `0n` is clamped to `1n`: a zero value never counts, whatever `minValueRaw` says.

### Verdict precedence

`invalid` → `trusted` (exact match, casing not corrupt) → `lookalike` → `bad-checksum` → `new`.

An exact trusted match outranks look-alike-ness, because the fact that some *other* address
imitates this one says nothing about this one, and flagging a recipient you really pay is how a
tool gets ignored. A look-alike outranks a checksum complaint, because both mean "do not send" and
reporting the casing would hide the dangerous half. Every check that fired is still listed in
`reasons`.

## Limitations

Read these before relying on it.

- **It cannot flag a brand-new malicious address.** A destination unlike anything in your history
  is `new`, not safe. First payments are indistinguishable from first mistakes.
- **History-based only.** With no outgoing sends there are no trusted recipients, and every
  destination is `new`. The tool has nothing to say about an account that has never paid anyone.
- **Only direct transfers build trust.** A recipient paid through a multisend, a Safe, or any
  other contract stays `new`, because the owner's signed calldata never named it. If you pay
  exclusively through a contract, this package will have no trusted recipients to compare
  against — see rule 5 above.
- **Trust is inherited from the tokens you name.** A malicious token contract can emit whatever
  `Transfer` logs it likes, so `--token` must name contracts you actually trust.
- **EVM only**, and **ERC-20 `Transfer` logs only**. Native-coin sends emit no log, so they are not
  read and a recipient you have only ever paid in the native coin will not be trusted. Supply an
  indexer-backed `HistorySource` if you need them.
- **The window is bounded.** `maxBlocks` defaults to 900 000 and a wider request is clamped to the
  most recent window — recent sends are the ones a look-alike imitates. `SourceInfo.fromBlock`
  always reports the block actually read from, so a truncated history never looks complete.
- **`--prefix`/`--suffix` are a heuristic.** 4 and 4 match what wallet UIs usually show. An
  attacker matching only the first 4 characters, or matching a longer span than you check, is not
  caught. Widen the window and you trade misses for false alarms.
- **A very large history is refused, not truncated.** Deriving trust needs the owner's transfers in
  memory, so `maxEvents` (200 000 by default) bounds them. Reaching it fails with a message naming
  the fix — a narrower range, or `tokens` — rather than being killed with no verdict.
- **An endpoint without log history cannot serve it.** `evm-log-walker` shrinks its chunks and then
  reports `E_LOGS_UNAVAILABLE`; use a keyed endpoint.
- **No custody, no keys, no hosted backend.** The only network calls go to endpoints you supply.

### Recorded uncertainty

The zero-value `transferFrom` behaviour in rule 4 was derived from EIP-20 and the OpenZeppelin
implementation, **not reproduced against a specific deployed token**. A token that reverts on a
zero-value `transferFrom` would make that forgery impossible for that token — but the strict rule
costs nothing there, so it is applied regardless and no token-specific behaviour is assumed.

One line is uncovered by tests: the `txFrom === undefined` throw in `src/sources.ts`, which
`transactionSenders` makes unreachable by throwing first. It is kept as a guard against a future
refactor and is not hidden behind an ignore comment.

`assessRecipient` judges a malformed candidate from its own shape before any history is fetched, so
`invalid` and exit 30 do not depend on an endpoint being reachable.

## License

MIT
