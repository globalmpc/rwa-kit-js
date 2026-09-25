# Contributing

## Setup

Node 22 (see `.nvmrc`) and pnpm 10.33.0 (see `packageManager` in `package.json`; `corepack enable` installs it).

```sh
pnpm install --frozen-lockfile
pnpm check            # typecheck, tests and build for every package
```

`pnpm check` must pass before a pull request. CI runs the same command plus a dependency audit and a secret scan.

## Layout

One package per folder under `packages/`, folder name equal to the unscoped package name (`packages/evm-log-walker` publishes `@globalmpc/evm-log-walker`). Each package has its own `package.json`, `tsconfig.json`, `README.md` and `CHANGELOG.md`, and defines the scripts `typecheck`, `test`, `build` and `check`.

Packages depend on each other through the npm registry, not the `workspace:` protocol, so each one can be published and consumed on its own.

A package README states the install line, one runnable example, and what the package does not do.

## Code

- TypeScript strict, no `any`. Shared settings live in `tsconfig.base.json`.
- Tests run on recorded fixtures. Nothing in CI calls a live RPC endpoint.
- Library code does not write to the console. Errors are thrown at the boundary with a message a caller can act on.
- Dependencies are exact versions and must be at least one day old on the registry (`minimumReleaseAge`), so a package that was just replaced upstream cannot enter the lockfile.

## Branches, commits, pull requests

- Branch from `main`: `feat/<package>-<topic>`, `fix/<package>-<topic>`, `chore/<topic>`.
- Commit messages follow Conventional Commits: `feat(evm-log-walker): resume from checkpoint`.
- One package per pull request. Fill in the template, link the issue, and add a CHANGELOG entry under `Unreleased`.

## Rules for published code

- No credentials, private keys, wallet addresses, or company-internal references in code, comments, tests or docs. Comments are published text.
- No dependency on a service or endpoint that is not public.
- Public API has documentation comments.

## Releasing

1. Move the `Unreleased` entries in the package CHANGELOG under the new version and bump `version` in `package.json`.
2. Merge to `main`.
3. Tag the public repository `<package>-v<version>` (for example `evm-log-walker-v0.1.0`). The release workflow publishes to npm with provenance and creates the GitHub Release.

## Licensing of contributions

By contributing, you agree that your contribution is licensed under the licence of the package it lands in.
