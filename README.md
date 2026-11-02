# rwa-kit-js

Built by [MPC (Mineral Project Coin)](https://www.globalmpc.tech) — mining real-world asset (RWA) infrastructure.

Open-source npm packages for real-world-asset (RWA) and BNB Chain developers, published under `@globalmpc`. One repository, one folder per package. The packages read chain data from **BNB Smart Chain (BSC)** by default and work with other EVM networks.

## Technology Stack

- **Blockchain:** BNB Smart Chain (default), opBNB and other EVM-compatible chains, over HTTP JSON-RPC.
- **Language:** TypeScript 5.9, Node.js 22.14+, ES modules.
- **Development:** pnpm 10.33 workspace, Vitest.
- **Dependencies:** none at runtime beyond `@globalmpc/evm-log-walker` (used by `dapp-stats`, `transfer-ledger`, `address-guard`, `holder-snapshot` and `hot-wallet-watch`). `sign-guard` wraps a [viem](https://viem.sh) account and has no runtime dependencies of its own.

## Supported Networks

- **BNB Smart Chain Mainnet (Chain ID: 56)** — default network of the `dapp-stats` CLI (`--network bsc`).
- **BNB Smart Chain Testnet (Chain ID: 97)** — `--network bsc --testnet`.
- **opBNB Mainnet (Chain ID: 204)** — through your own endpoint (`--rpc`, or `createRpc` in code); `evm-log-walker` documents the limits of the public opBNB endpoints.
- Polygon (137), Ethereum (1), Base (8453), Arbitrum One (42161) and Optimism (10), with their testnets — built-in public endpoints, see the [`dapp-stats` network table](packages/dapp-stats/README.md#choosing-a-network).

The built-in endpoints are listed in [`packages/dapp-stats/src/cli/networks.ts`](packages/dapp-stats/src/cli/networks.ts).

## Contract Addresses

None. These packages read event logs and receipts from existing contracts; they deploy no contracts and hold no keys or funds. `sign-guard` checks signatures for a key you hold; it never stores or sees the key itself.

## Packages

| Package | What it does | npm |
|---|---|---|
| [`@globalmpc/evm-log-walker`](packages/evm-log-walker) | Reads contract event logs from BNB Chain and other EVM networks reliably: probes what an endpoint allows, walks history in adaptive chunks, resumes from a checkpoint, buckets logs by UTC day, and finds a contract's creation block (`creation-block` CLI). | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Fevm-log-walker)](https://www.npmjs.com/package/@globalmpc/evm-log-walker) |
| [`@globalmpc/dapp-stats`](packages/dapp-stats) | Computes a dApp's own activity numbers from chain data on top of `evm-log-walker`: daily transactions, unique active wallets, holders, 7-day and 30-day wallet return, and the sponsored-vs-user-paid gas split. Outputs dated JSON and a self-contained static page (`dapp-stats` CLI); every figure carries its RPC source and block range. | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Fdapp-stats)](https://www.npmjs.com/package/@globalmpc/dapp-stats) |
| [`@globalmpc/transfer-ledger`](packages/transfer-ledger) | Checks a bulk token payout against what was meant to be paid: reads every ERC-20 transfer by transaction hash and log index, so one multisend counts as many payments, and reports missing payments, duplicates and overpayments. Runs offline from a saved round; non-zero exit code when a round is not clean (`transfer-ledger` CLI). | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Ftransfer-ledger)](https://www.npmjs.com/package/@globalmpc/transfer-ledger) |
| [`@globalmpc/holder-snapshot`](packages/holder-snapshot) | Works out who held a token at a given block and what each holder is owed: replays every `Transfer` since creation, verifies the balances against the token's own `balanceOf` and `totalSupply`, then splits a payout pool pro-rata or equally with exclusions, a minimum balance and a per-wallet cap. Writes the `recipient,amount` CSV the payout tools read (`holder-snapshot` CLI). | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Fholder-snapshot)](https://www.npmjs.com/package/@globalmpc/holder-snapshot) |
| [`@globalmpc/address-guard`](packages/address-guard) | Catches address-poisoning look-alikes before you send: derives the recipients you have really paid from your own outgoing transfers, then flags any destination that shares the first and last 4 hex characters of one of them but differs in the middle, and verifies the EIP-55 checksum. Runs offline in CI with a non-zero exit code (`address-guard` CLI). | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Faddress-guard)](https://www.npmjs.com/package/@globalmpc/address-guard) |
| [`@globalmpc/sign-guard`](packages/sign-guard) | A signing policy for hot wallets: wraps a viem account so every transaction, EIP-7702 delegation, typed-data and message signature is checked against a written allowlist first (pinned chains, allowed contracts and functions, native and token caps per transaction and per window, no blind hash signing). Anything the policy does not name is refused (`sign-guard` CLI tests a policy file in CI). | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Fsign-guard)](https://www.npmjs.com/package/@globalmpc/sign-guard) |
| [`@globalmpc/hot-wallet-watch`](packages/hot-wallet-watch) | Watches hot wallets for the signs of a takeover, block by block: an EIP-7702 delegation to a contract you did not approve, code at the address, a nonce rising without your own send, and native or token outflows above a set rate. Readings are cross-checked across independent endpoints and any one seeing trouble raises the alarm (`hot-wallet-watch` CLI: one-off `check` or a continuous `watch` printing JSON alerts). | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Fhot-wallet-watch)](https://www.npmjs.com/package/@globalmpc/hot-wallet-watch) |

## Layout

```
packages/<package>/      one npm package: package.json, src/, test/, README, CHANGELOG
tsconfig.base.json       shared TypeScript strictness, extended by every package
pnpm-workspace.yaml      workspace and dependency policy
.github/workflows/       ci.yml checks every package; release.yml publishes one package per tag
```

## Releases

A release is a tag on the public repository in the form `<package>-v<version>`. The workflow verifies the tag against `package.json`, publishes to npm through trusted publishing with provenance (no stored token), and creates a GitHub Release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).
