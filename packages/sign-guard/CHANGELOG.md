# Changelog

All notable changes to `@globalmpc/sign-guard` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-31

### Added

- `guardAccount`: wraps a viem local account (JSON-RPC accounts are refused, and a signing method
  the account lacks is installed as one that refuses, so viem never falls back to the node) so
  `signTransaction`, `signAuthorization`, `signTypedData`, `signMessage` and `sign` ask the policy
  first. A refused request throws a `SignGuardError` with code `E_DENIED` and the decision; nothing
  is signed. The signable fields are copied before the check and the copy is signed, so a request
  changed after it was checked, or a getter answering differently on a second read, cannot slip
  through; transactions are signed from the standard Ethereum fields only. Any other function on the
  account, such as `getHdKey`, is replaced by one that refuses synchronously, and of the other
  fields only `address`, `type`, `publicKey`, `source` and `nonceManager` are carried over. The
  account's own type is returned, so the wrapper drops into viem clients unchanged.
  `trustedSerializers` admits a chain's own serializer by identity (viem passes one for Base and
  Optimism) and is copied when the account is wrapped; any other serializer is refused, and the
  serializer is read once, so the one checked is the one used. Window amounts stay spent when the
  wrapped signer throws, unless `releaseOnSignerError` is set.
- `findRefusal`: the `SignGuardError` refusal inside an error or its causes. Some viem actions wrap
  the refusal in their own error and others do not, so callers use this rather than `instanceof`.
- `createSignGuard`: `check(request)` judges a request and reserves its window amounts;
  `release(decision)` returns them after a failed signature, once per decision and only for
  decisions the guard issued. `onDecision` receives a copy, so it cannot change what is signed.
  `onDecision` sees every decision; if it throws, an allowed request is refused as `audit.failed`.
  Malformed requests are refused as `request.malformed` and recorded, never thrown. The resolved
  policy is not exposed. `scope` prefixes every ledger key, so guards sharing one ledger keep their
  windows apart; the ledger receives its own copy of each spend. `check` copies the signable fields
  once and returns the copy as `decision.request`, to be signed in place of the caller's object. A
  clock that is not a whole number of milliseconds refuses as `clock.invalid`; a ledger that throws,
  or whose `reserve` answers anything but exactly `true` or `false`, refuses as `ledger.failed`,
  with partial reservations given back.
- `evaluate`: the policy alone, pure. Rules: pinned chain ids (chain id 0 refused), contract and
  4-byte function allowlist with no wildcard, native value cap per transaction and per sliding
  window, ERC-20 `transfer(address,uint256)` caps per transfer and per window with an optional
  recipient list, contract creation off by default, blob and unknown transaction types refused,
  custom serializers and an `input` field refused, EIP-7702 delegations only to listed contracts and
  one per hour by default, delegation resets (to the zero address) allowed on a policy chain and
  counted in their own window (25 per hour by default), authorization lists inside transactions held
  to the same rules, typed data only for a listed `verifyingContract` and primary type on the policy
  chain with an `EIP712Domain` type, if any, equal to the one the domain implies (viem's wallet
  client always sends that one), text messages only with a listed prefix, raw byte messages and raw
  hashes refused.
- `resolvePolicy`: validates a policy and fills defaults; unknown keys are refused, and a policy
  that names contracts must have exactly one chain id.
- `policyFromJson` and `requestsFromJson`: JSON forms with amounts as decimal strings.
- `createMemoryLedger` and the `SpendLedger` interface for windows shared across processes.
- `presignResets`: signed authorizations that clear a delegation, for consecutive nonces, to keep
  offline and broadcast from any funded account if a hostile delegation lands.
- `sign-guard check` command-line tool: validates a policy file and judges a file of requests in
  order with windows applied, text or JSON output, `--now` and `--step` for window tests, exit codes
  0 allowed, 20 refused, 1 usage or invalid input, 2 a file could not be read.

[Unreleased]: https://github.com/globalmpc/rwa-kit-js/commits/main
[0.1.0]: https://www.npmjs.com/package/@globalmpc/sign-guard/v/0.1.0
