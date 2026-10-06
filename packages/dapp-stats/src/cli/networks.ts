/**
 * Public, no-signup endpoints for popular EVM chains, used by the CLI only when neither `--rpc`
 * nor `DAPP_STATS_RPC` is given. All are rate-limited and none serve archive history (verified
 * live against each one: even a few-thousand-block-old query gets refused as needing a paid or
 * keyed tier) — this table is for a quick look, not a real report.
 *
 * EVM chains only. Solana, Bitcoin, Cosmos, Ton and Tron (all offered by popular RPC providers
 * alongside these) have no `Transfer` event log or `eth_getLogs` equivalent — `evm-log-walker`
 * reads Ethereum-style event history, which those chains do not have, so they cannot be added
 * here without an entirely different fetching layer, not just another table entry.
 *
 * Each provider answers a given call differently (chunk limits, archive gating, error wording);
 * that variability is exactly what `evm-log-walker`'s `probeRpc` and adaptive `walkLogs` exist to
 * absorb, and what this package's `tx.ts` allows for (`effectiveGasPrice` missing on some
 * receipts). This table only needs to hold working URLs, not per-provider parsing logic.
 *
 * `NetworkName` is a closed string-literal union rather than a TypeScript `enum`, the same choice
 * `evm-log-walker` made for `BlockTag` and `WalkerErrorCode`: it gives the same exhaustiveness and
 * autocomplete at the type level without an `enum`'s runtime object, and it's what the rest of this
 * codebase already does.
 */
export type NetworkName = "bsc" | "polygon" | "ethereum" | "base" | "arbitrum" | "optimism";

export interface NetworkEndpoints {
  mainnet: readonly string[];
  testnet: readonly string[];
}

export const NETWORKS: Readonly<Record<NetworkName, NetworkEndpoints>> = {
  bsc: {
    mainnet: ["https://bsc-rpc.publicnode.com", "https://1rpc.io/bnb"],
    testnet: ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"],
  },
  polygon: {
    mainnet: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    testnet: ["https://polygon-amoy.drpc.org"],
  },
  ethereum: {
    mainnet: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    testnet: ["https://ethereum-sepolia-rpc.publicnode.com"],
  },
  base: {
    mainnet: ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
    testnet: ["https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org"],
  },
  arbitrum: {
    mainnet: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
    testnet: ["https://arbitrum-sepolia-rpc.publicnode.com", "https://arbitrum-sepolia.drpc.org"],
  },
  optimism: {
    mainnet: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
    testnet: ["https://optimism-sepolia-rpc.publicnode.com", "https://optimism-sepolia.drpc.org"],
  },
};

export const DEFAULT_NETWORK: NetworkName = "bsc";

export function listNetworks(): NetworkName[] {
  return Object.keys(NETWORKS) as NetworkName[];
}

export function isNetworkName(value: string): value is NetworkName {
  return Object.hasOwn(NETWORKS, value);
}
