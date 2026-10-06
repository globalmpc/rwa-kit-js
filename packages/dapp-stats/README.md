# @globalmpc/dapp-stats

Compute a dApp's own activity numbers from chain data, and publish them so a reviewer can check the arithmetic instead of trusting it: daily transactions, unique active wallets, holders, 7-day and 30-day wallet return, and the sponsored-vs-user-paid gas split. Built on [`@globalmpc/evm-log-walker`](../evm-log-walker). Output is dated JSON plus a self-contained static page — no database, no hosted service, no runtime dependencies. Every number states the RPC endpoint and block range it came from.

Two ways to use it, both first-class:

- **As a library**, `import { computeReport, renderPage } from "@globalmpc/dapp-stats"` inside your own app (a dashboard, a Slack bot, a scheduled job) — see [Quick start](#quick-start).
- **As a standalone CLI**, `dapp-stats <address> --out ./activity` — see [Command line](#command-line). The CLI is a thin wrapper around the same two functions; it doesn't do anything you couldn't do yourself in code.

```sh
npm install @globalmpc/dapp-stats
```

## Quick start

```js
import { writeFile } from "node:fs/promises";
import { createRpc, redactEndpoint } from "@globalmpc/evm-log-walker";
import { computeReport, renderPage } from "@globalmpc/dapp-stats";

const url = "https://bsc-rpc.publicnode.com";
const rpc = createRpc({ urls: [url] });
const TOKEN = "0xYourTokenAddress";
const CREATION_BLOCK = 0; // replace with your contract's creation block

const report = await computeReport({
  rpc,
  address: TOKEN,
  sourceLabel: redactEndpoint(url),
  fromBlock: CREATION_BLOCK, // see "Finding a creation block" below
  fromBlockIsCreation: true,
  days: 30,
  label: "Example token",
});

console.log(report.days.at(-1));

await writeFile("index.html", renderPage(report));
```

`report.days.at(-1)` is the UTC day of `toBlock`, even when nothing happened on it; every day in `report.days` has the same shape (`DayRecord` in `src/schema.ts`). Open the written `index.html` directly from disk, or upload it anywhere a static file can be served — it embeds its own data, no network request involved.

## Command line

```sh
npx --package @globalmpc/dapp-stats dapp-stats 0xYourTokenAddress \
  --rpc https://bsc-rpc.publicnode.com \
  --from <creation-block> --from-is-creation \
  --out ./activity \
  --days 30 \
  --label "Example token"
```

Writes `./activity/data/<latest-date>.json` (the full report) and regenerates `./activity/index.html`. Run it again later — on a schedule, or by hand — and it produces a new dated JSON file each time while the page always reflects the latest run. `DAPP_STATS_RPC` (space-separated endpoints) is the place for a keyed URL, the same way `evm-log-walker`'s `creation-block` handles it: an argument is kept in shell history and shown to other users in the process list. `--from-is-creation` says the `--from` block is the contract's creation block; without it, an explicit `--from` publishes holders as not available (see [Holders need the full history](#holders-need-the-full-history-not-just-the-lookback-window)). `--json` prints the computed report to stdout instead of the short summary. Exit codes: 0 written, 1 usage error, 2 the report could not be computed.

### Choosing a network

`--rpc` is optional. Leave it out (and don't set `DAPP_STATS_RPC`) and the CLI falls back to `--network`'s public endpoints, printing a note to say so. `--network` (default `bsc`) is a closed set — `NetworkName` in the code, a string-literal union rather than an `enum` (matching how `evm-log-walker` types `BlockTag`, so both packages read the same way), not a free-form string:

| `--network` | Provider(s) used for the built-in default | Mainnet chain ID | Testnet |
|---|---|---|---|
| `bsc` (default) | publicnode, 1rpc | 56 | BNB Testnet (97) |
| `polygon` | publicnode, [dRPC](https://drpc.org) | 137 | Polygon Amoy (80002) |
| `ethereum` | publicnode, dRPC | 1 | Sepolia (11155111) |
| `base` | publicnode, dRPC | 8453 | Base Sepolia (84532) |
| `arbitrum` | publicnode, dRPC | 42161 | Arbitrum Sepolia (421614) |
| `optimism` | publicnode, dRPC | 10 | Optimism Sepolia (11155420) |

Pass `--testnet` to use the testnet column instead of mainnet — useful for trying the tool against a contract you've only deployed to a test network so far. Every URL in this table was checked live before being added; each one is still rate-limited and serves no archive history at all, so an automatic creation-block lookup, or any `--from` older than roughly the last few hundred blocks, will fail on it with an archive-access error from the endpoint. That's enough to poke at recent activity, not to produce a real report — for that, pass your own endpoint, which overrides `--network` entirely:

```sh
dapp-stats 0xYourTokenAddress --network polygon --testnet --out ./activity   # try it on Polygon Amoy
dapp-stats 0xYourTokenAddress --rpc https://<your-endpoint>/<api-key> --out ./activity
# or, to keep the key out of shell history:
DAPP_STATS_RPC="https://<your-endpoint>/<api-key>" dapp-stats 0xYourTokenAddress --out ./activity
```

**Only EVM chains are here, and only ever will be through this table.** Popular RPC providers (dRPC included) also offer Solana, Bitcoin, Cosmos, Ton and Tron — none of those have an `eth_getLogs`/`Transfer`-event equivalent, since `evm-log-walker` reads Ethereum-style event history specifically. Adding one of those chains would mean writing a whole new data-fetching layer, not another row in this table.

Calling `computeReport` directly from code always requires your own `Rpc` (there is no default at the library level, only in the CLI) — build it with `evm-log-walker`'s `createRpc`, which also accepts a bearer token or any other header on a specific endpoint without it leaking to a public fallback. `NETWORKS`, `NetworkName` and `isNetworkName` are exported too, if your own app wants the same table (to populate a network picker, for example) without reimplementing it:

```js
import { createRpc } from "@globalmpc/evm-log-walker";
import { NETWORKS } from "@globalmpc/dapp-stats";

const rpc = createRpc({
  urls: [{ url: "https://your-archive-endpoint.example/v1", headers: { authorization: "Bearer <token>" } }],
});

console.log(NETWORKS.polygon.testnet); // ["https://polygon-amoy.drpc.org"]
```

### Viewing, printing and branding the report

```sh
dapp-stats 0xYourTokenAddress --out ./activity --open
```

`--open` launches the freshly written `index.html` in your default browser once it's written (via the OS's own `open`, `rundll32 url.dll,FileProtocolHandler` or `xdg-open`, no new dependency; Windows avoids `cmd /c start` because `cmd.exe` would re-parse `&` or `|` in the path) — if there's no display to open one on, it prints a one-line note and still exits 0, since the files were written either way. The page itself has a **"Print / save as PDF"** button: every browser's print dialog can save to PDF or send to an actual printer, which is where "downloadable document" comes from — the page deliberately does not pull in a `.docx`-generation library just to also offer a Word file, since that would break the "no runtime dependencies" rule the whole package follows; PDF-via-print covers the same need without it. Printing always renders on a plain white background regardless of the on-screen theme, so it doesn't waste ink or come out illegibly dark.

By default the page reads as a formal document, not a dashboard: a deep-copper header bar on white, near-black text and light-grey borders, bordered tables, no charts — the same visual language as a due-diligence or KYB (know-your-business) questionnaire, because that's what this report actually is for a reviewer. Two "Item / Answer" sections below the daily-activity table carry that same look: **Report information** (contract, chain, label, generated-at) and **Methodology** (a plain-language definition of every metric — transactions, active wallets, holders, return rate, gas split, source & block range — so a reviewer never has to leave the document to know what a number means).

```sh
dapp-stats 0xYourTokenAddress --out ./activity --theme dark
```

```js
import { computeReport, renderPage, DOCUMENT_THEME } from "@globalmpc/dapp-stats";

const report = await computeReport({ /* ... */ });

// Full custom palette: anything left out falls back to DOCUMENT_THEME's value for that field.
const html = renderPage(report, {
  theme: { ...DOCUMENT_THEME, accent: "#2e7dd1", sectionHeaderBg: "#2e7dd1" },
});
```

The CLI's `--theme` picks between three built-in presets: `document` (the default, above), `dark` and `light`. A fully custom per-field palette (any CSS color value, for `background`, `surface`, `border`, `text`, `textMuted`, `accent`, `onAccent`, `pairHighlight`, `sectionHeaderBg`, `sectionHeaderText`, `colorScheme`) is a library-level option via `renderPage`'s second argument, since that's a lot of ground to cover with flags. The color values are inlined as CSS custom properties, so a custom theme costs nothing at read time — no stylesheet fetch, no build step. Printing keeps whichever theme is active — including its header-bar color — and only forces the page background and body text to a print-safe light/dark pairing, so `document` prints exactly as it looks on screen.

## What "source and block range" means here

Every `DayRecord` in a report carries one `source` (`{ rpc, methods }`) and one `blockRange` (`{ fromBlock, toBlock }`) for the figures computed from that day's own logs — `transactions`, `activeWallets` and `gas`. They are not repeated per field: all of a day's figures come from the same calls, so nesting the same source under every number would just be noise. URLs in `source.rpc` are always origins: `computeReport` cuts every URL inside `sourceLabel` down to its scheme, host and port before writing it, so a keyed endpoint can't reach the published files even if a caller passes the full URL, or several URLs in one string. A plain name such as `"my node"` is kept as given. The CLI lists every endpoint it was given (`--rpc` flags, `DAPP_STATS_RPC` or `--network`'s fallbacks), comma separated, because the client fails over between them call by call and any of them may have answered part of a run. `holders` is different: it is a *cumulative* count since the contract's creation, so it carries its own `holdersAsOfBlock` instead — the last block whose transfers have been folded into the running balance, which on a day with zero activity is the previous day's block, not a fabricated range for a day nothing happened in. A day with no logs reports `blockRange: null` rather than a made-up span.

Percentages (`return7d`, `return30d`, the page's rendered rates) are always floored, never rounded up, and `return7d`/`return30d` are `null` — not `0` — on a day the report does not yet have enough preceding history to answer for (typically the first week or month after a contract's creation, or after `--from` cuts the walk short of true genesis).

## Holders need the full history, not just the lookback window

A holder count is a running balance, replayed from every `Transfer` since the contract's creation. `--days`/`options.days` only trims how many of the *most recent* UTC days are published — the walk itself always starts at `fromBlock`.

Holders are only computed when the walk is known to start at the creation block: `fromBlock` omitted (so `findCreationBlock` finds it), or an explicit `fromBlock` passed with `fromBlockIsCreation: true` (`--from-is-creation` on the command line). Any other explicit `fromBlock` publishes `holders: null` and `holdersAsOfBlock: null` on every day. A replay that starts late can't be relied on to notice: if the window only holds incoming transfers, no balance ever goes negative and the result is a plausible but too-low count. `fromBlockIsCreation` is trusted, not checked: verifying it would need the same archive-state lookup that a stored creation block exists to avoid, so only pass it for a block that came from `findCreationBlock` or `creation-block`. As a backstop, a balance going negative still turns holders to `null` from that day on, but a wrong claim over a quiet window publishes `0`. Every other figure is unaffected either way.

The walk is the slow part of a run for an old, high-volume token, but receipts — the per-transaction calls — are only fetched for the published days plus the 30 days retention looks back over; holders come from the logs alone.

## Finding a creation block

If you don't already know it, `evm-log-walker`'s own `creation-block` CLI finds it (needs an archive endpoint):

```sh
export CREATION_BLOCK_RPC=https://<your archive endpoint>
npx --package @globalmpc/evm-log-walker creation-block 0xYourTokenAddress
```

Omitting `fromBlock`/`--from` does this automatically, but costs the same archive-endpoint lookup on every run; storing the result once and passing it explicitly, with `fromBlockIsCreation: true` / `--from-is-creation`, is cheaper.

## How gas is classified

A transaction is classified as **sponsored** when its gas price (the receipt's `effectiveGasPrice`, or the legacy `gasPrice` when a receipt omits it) is exactly `0` — someone other than the sender covered it — and **user-paid** otherwise. The split is still published rather than omitted, because a reader can't tell "measured and found zero" from "not measured at all" unless the number is actually there.

## API

| Function | Purpose |
|---|---|
| `computeReport(options)` | Reads every `Transfer` log for a contract and returns a `Report`. See the option reference in `src/report.ts`'s doc comment. |
| `renderPage(report, options?)` | A `Report` as one self-contained HTML string: no external requests, no CDN, no runtime dependency. `options.theme` overrides any field of `DEFAULT_THEME`. |
| `NETWORKS`, `NetworkName`, `isNetworkName`, `listNetworks`, `DEFAULT_NETWORK` | The CLI's `--network` table, for an app that wants the same list (e.g. a network picker) without reimplementing it. |
| `DOCUMENT_THEME` (= `DEFAULT_THEME`), `DARK_THEME`, `LIGHT_THEME`, `resolveTheme`, `PageTheme` | The three built-in page themes and the type a custom one implements. |
| `decodeTransfer(log)` | Decodes an `evm-log-walker` `Log` as an ERC-20 `Transfer(address,address,uint256)`. Throws `E_MALFORMED_TRANSFER` for anything else. |
| `fetchTransactionSummaries(rpc, hashes)` | One `{ from, blockNumber, gasPrice, sponsored }` per unique transaction hash. |
| `computeHolderCounts(transfersByDay, orderedDates)` | Cumulative non-zero-balance count per day from a full transfer history. Does not throw: from the first day a balance would go negative, that day and every later one is `null`. Only pass a history known to start at the creation block — a late start without any negative balance still undercounts. |
| `computeReturnRate(days, windowDays)` | Fraction of each day's wallets also seen in the preceding `windowDays` days; `null` before there is a full window of history. |
| `splitGas`, `countTransactions`, `activeWalletSet` | The remaining per-day building blocks `computeReport` composes. |

Every function takes the `Rpc` object `@globalmpc/evm-log-walker`'s `createRpc` returns.

## Errors

`StatsError` carries a stable `code`, the same shape as `evm-log-walker`'s `WalkerError`; an RPC failure from the walk itself surfaces as `evm-log-walker`'s own `WalkerError`/`RpcError` unchanged. An incomplete holder history is not an error: it shows up as `holders: null`, never as a thrown code.

| Code | Meaning |
|---|---|
| `E_INVALID_ARGUMENT` | A caller-supplied argument is not usable. |
| `E_MALFORMED_TRANSFER` | A log shaped like a `Transfer` event did not decode. |
| `E_MALFORMED_TX` | A transaction or receipt the endpoint returned is missing a field this package needs. |

## What it does not do

- Decode any event other than `Transfer(address,address,uint256)`. A contract that does not emit that event has no holder count to compute.
- Store its own state or checkpoints. Point `fromBlock` at a saved value to avoid re-deriving the creation block on every run.
- Detect sponsorship any way other than `gasPrice === 0`. A meta-transaction pattern that still shows a non-zero `gasPrice` on the sponsor's transaction will not be recognised as sponsored.
- Serve the page. It writes a plain HTML file; hosting it is up to you.
- Retry or fail over RPC calls itself — that's `evm-log-walker`'s job, and this package uses the `Rpc` it hands back.
- Generate a `.docx` (Word) file. The page's print button covers "downloadable document" through the browser's own PDF export, without pulling in a document-generation dependency.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter @globalmpc/dapp-stats check   # typecheck, tests, build
```

Tests run against an in-memory chain fixture (`test/fake-chain.ts`) with hand-computed expected results; nothing in the test suite touches the network.

## License

MIT. See [LICENSE](LICENSE).
