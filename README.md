# rwa-kit-js

Open-source npm packages for real-world-asset (RWA) and BNB Chain developers, published under `@globalmpc`. One repository, one folder per package.

## Packages

| Package | What it does | npm |
|---|---|---|
| [`@globalmpc/evm-log-walker`](packages/evm-log-walker) | Reads contract event logs from BNB Chain and other EVM networks reliably: probes what an endpoint allows, walks history in adaptive chunks, resumes from a checkpoint, buckets logs by UTC day, and finds a contract's creation block (`creation-block` CLI). | first release pending |

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
