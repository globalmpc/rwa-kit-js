import type { Hex, Rpc } from "@globalmpc/evm-log-walker";
import { forEachConcurrently } from "./concurrency.js";
import { StatsError } from "./errors.js";
import { hexToBigInt, hexToInt, isAddress } from "./hex.js";

/** Transactions fetched at once. `evm-log-walker`'s `Rpc` already retries and fails over per call. */
const CONCURRENCY = 8;

export interface TxSummary {
  hash: Hex;
  /** The address that signed the transaction (the receipt's `from`). */
  from: Hex;
  blockNumber: number;
  /** What was actually paid per unit of gas: the receipt's `effectiveGasPrice`, or the legacy `gasPrice`. */
  gasPrice: bigint;
  /** `gasPrice === 0n`: someone other than the sender covered gas for this transaction. */
  sponsored: boolean;
}

/**
 * Fetches one summary per unique transaction hash, deduplicating first since a transaction can
 * appear through more than one log. Uses the receipt alone when it carries `effectiveGasPrice`
 * (every endpoint this package has been run against does); falls back to `eth_getTransactionByHash`
 * for a legacy receipt that omits it.
 */
export async function fetchTransactionSummaries(rpc: Rpc, hashes: readonly Hex[]): Promise<Map<Hex, TxSummary>> {
  const unique = [...new Set(hashes)];
  const result = new Map<Hex, TxSummary>();
  await forEachConcurrently(unique, CONCURRENCY, async (hash) => {
    result.set(hash, await fetchOne(rpc, hash));
  });
  return result;
}

async function fetchOne(rpc: Rpc, hash: Hex): Promise<TxSummary> {
  const receipt = await rpc.call<Record<string, unknown> | null>("eth_getTransactionReceipt", [hash]);
  if (!receipt) {
    throw new StatsError("E_MALFORMED_TX", `eth_getTransactionReceipt returned no receipt for ${hash}`);
  }
  const from = receipt["from"];
  if (!isAddress(from)) {
    throw new StatsError("E_MALFORMED_TX", `eth_getTransactionReceipt returned a malformed "from" for ${hash}`);
  }
  const blockNumber = hexToInt(receipt["blockNumber"], "receipt.blockNumber");
  const gasPrice =
    typeof receipt["effectiveGasPrice"] === "string"
      ? hexToBigInt(receipt["effectiveGasPrice"], "receipt.effectiveGasPrice")
      : await fetchLegacyGasPrice(rpc, hash);
  return { hash, from, blockNumber, gasPrice, sponsored: gasPrice === 0n };
}

async function fetchLegacyGasPrice(rpc: Rpc, hash: Hex): Promise<bigint> {
  const tx = await rpc.call<Record<string, unknown> | null>("eth_getTransactionByHash", [hash]);
  if (!tx) {
    throw new StatsError("E_MALFORMED_TX", `eth_getTransactionByHash returned no transaction for ${hash}`);
  }
  return hexToBigInt(tx["gasPrice"], "transaction.gasPrice");
}
