# Changelog

All notable changes to `@globalmpc/dapp-stats` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `computeReport`: reads a token's `Transfer` logs and transactions over a block range and produces
  daily transaction counts, unique active wallets, holder counts, 7-day and 30-day wallet return
  rate, and the sponsored-vs-user-paid gas split. Every day carries the RPC source and block range
  it was computed from, and a `stage` of `"final"` or `"provisional"`.
- `fromBlockIsCreation` / `--from-is-creation`: holders are only computed when the walk is known to
  start at the creation block (`fromBlock` omitted, or this flag set); any other explicit
  `fromBlock` publishes `holders: null`, since a late start can undercount without ever showing a
  negative balance.
- Report days run to the UTC day of `toBlock`, so quiet recent days are published as empty days.
- `sourceLabel` is cut to its origin inside `computeReport` whenever it parses as a URL, so a keyed
  endpoint never reaches the published files.
- `renderPage`: turns a `Report` into a single self-contained static HTML file — no external
  requests, no runtime dependencies, works opened directly from disk or hosted anywhere.
- `dapp-stats` command-line tool: runs a report against a contract address and writes a dated JSON
  file plus a regenerated `index.html` into an output directory. `--rpc`/`DAPP_STATS_RPC` are
  optional: without them it falls back to `--network`'s public endpoints (rate-limited, no archive
  history) and prints a note saying so, so a first run needs no signup, and a real run just needs
  `--rpc` pointed at your own endpoint.
- `--network`/`--testnet`: a closed, typed set (`NetworkName`) of public endpoints for six EVM
  chains (`bsc`, `polygon`, `ethereum`, `base`, `arbitrum`, `optimism`), mainnet and testnet each,
  every URL verified live before being added. `NETWORKS` is exported for programmatic reuse (a
  network picker, for example).
- `--open`: launches the written `index.html` in the default browser via the OS's own opener, no
  new dependency; a failure (headless host) is reported on stderr without failing the command.
- A "Print / save as PDF" button on the page, using the browser's own print/PDF export rather than
  a `.docx`-generation dependency; printing renders on a white background with near-black text,
  regardless of the on-screen theme.
- `renderPage`'s second argument, `{ theme }`: full per-field color override (`PageTheme`). Defaults
  to `DOCUMENT_THEME`, a formal deep-copper-header, white-background document layout matching a
  due-diligence/KYB questionnaire's look — table-only, no charts — the point is a document a
  reviewer prints and files, not a dashboard: near-black text and light-grey borders, with a deep
  copper (`#B56A35`) header bar and accent carrying white text. `DARK_THEME` (a dark palette)
  and `LIGHT_THEME` (a light palette) are selectable via `--theme dark` / `--theme light`.
  Colors are inlined as CSS custom properties, so a custom theme costs nothing at read time.
- Two "Item / Answer" breakdown sections, styled like the document theme's due-diligence-questionnaire
  reference: "Report information" (contract, chain, label, package version, generated-at) and
  "Methodology" (in-document, plain-language definitions of every metric — transactions, active
  wallets, holders, return rate, gas split, source & block range) — so a reviewer doesn't need the
  README open alongside the printed report to understand what a number means.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
