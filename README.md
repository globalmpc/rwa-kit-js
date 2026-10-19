# rwa-kit-js

Open-source npm packages for real-world-asset (RWA) and BNB Chain developers, published under `@globalmpc`. One repository, one folder per package. The packages read chain data from **BNB Smart Chain (BSC)** by default and work with other EVM networks.

## Technology Stack

- **Blockchain:** BNB Smart Chain (default), opBNB and other EVM-compatible chains, over HTTP JSON-RPC.
- **Language:** TypeScript 5.9, Node.js 22.14+, ES modules.
- **Development:** pnpm 10.33 workspace, Vitest.
- **Dependencies:** none at runtime beyond `@globalmpc/evm-log-walker` (used by `dapp-stats`).

## Supported Networks

- **BNB Smart Chain Mainnet (Chain ID: 56)** — default network of the `dapp-stats` CLI (`--network bsc`).
- **BNB Smart Chain Testnet (Chain ID: 97)** — `--network bsc --testnet`.
- **opBNB Mainnet (Chain ID: 204)** — through your own endpoint (`--rpc`, or `createRpc` in code); `evm-log-walker` documents the limits of the public opBNB endpoints.
- Polygon (137), Ethereum (1), Base (8453), Arbitrum One (42161) and Optimism (10), with their testnets — built-in public endpoints, see the [`dapp-stats` network table](packages/dapp-stats/README.md#choosing-a-network).

The built-in endpoints are listed in [`packages/dapp-stats/src/cli/networks.ts`](packages/dapp-stats/src/cli/networks.ts).

## Contract Addresses

None. These packages read event logs and receipts from existing contracts; they deploy no contracts and hold no keys or funds.

## Packages

| Package | What it does | npm |
|---|---|---|
| [`@globalmpc/evm-log-walker`](packages/evm-log-walker) | Reads contract event logs from BNB Chain and other EVM networks reliably: probes what an endpoint allows, walks history in adaptive chunks, resumes from a checkpoint, buckets logs by UTC day, and finds a contract's creation block (`creation-block` CLI). | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Fevm-log-walker)](https://www.npmjs.com/package/@globalmpc/evm-log-walker) |
| [`@globalmpc/dapp-stats`](packages/dapp-stats) | Computes a dApp's own activity numbers from chain data on top of `evm-log-walker`: daily transactions, unique active wallets, holders, 7-day and 30-day wallet return, and the sponsored-vs-user-paid gas split. Outputs dated JSON and a self-contained static page (`dapp-stats` CLI); every figure carries its RPC source and block range. | [![npm](https://img.shields.io/npm/v/%40globalmpc%2Fdapp-stats)](https://www.npmjs.com/package/@globalmpc/dapp-stats) |

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
