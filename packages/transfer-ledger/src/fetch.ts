import { collectLogs, type BlockTag, type Log, type Rpc } from "@globalmpc/evm-log-walker";
import { forEachConcurrently } from "./concurrency.js";
import { LedgerError } from "./errors.js";
import { addressToTopic, hexToInt, isAddress, isTransactionHash, normalizeAddress, type Hex } from "./hex.js";
import { decodeTransfer, isErc20Transfer, selectPayouts, TRANSFER_TOPIC, type Transfer } from "./transfers.js";

/** Receipts fetched at once. `evm-log-walker`'s `Rpc` already retries and fails over per call. */
const CONCURRENCY = 8;

export interface TransactionStatus {
  hash: Hex;
  /** `false` for a reverted transaction: it moved no tokens, so every payment in it is missing. */
  succeeded: boolean;
  blockNumber: number;
}

export interface FetchedTransfers {
  /** The round's payouts: `read` after the payer rule (`selectPayouts`), or all of `read` without payers. */
  transfers: Transfer[];
  /** Every transfer of the token read, before the payer rule. What `--save-transfers` writes. */
  read: Transfer[];
  /** One entry per transaction read, for `fetchTransfersByTransaction`. */
  transactions: TransactionStatus[];
}

export interface TransactionSource {
  token: Hex;
  /**
   * Only payouts of these senders count, chosen by `selectPayouts`: the payout wallet first, then
   * any contract that pays on its behalf, such as a multisend that pulls the total in first.
   * Recommended.
   */
  payers?: readonly Hex[];
  transactionHashes: readonly Hex[];
}

/**
 * Reads the token's `Transfer` logs from the receipts of the given transactions: the payout
 * round's multisend transactions, typically. One receipt per transaction, so an endpoint without
 * archive state or log history serves it as long as it keeps receipts. A reverted transaction is
 * reported with `succeeded: false` and contributes no transfers.
 */
export async function fetchTransfersByTransaction(rpc: Rpc, source: TransactionSource): Promise<FetchedTransfers> {
  const token = checkedAddress(source.token, "token");
  const payers = source.payers === undefined ? undefined : checkedPayers(source.payers);
  if (source.transactionHashes.length === 0) {
    throw new LedgerError("E_INVALID_ARGUMENT", "at least one transaction hash is needed");
  }
  for (const hash of source.transactionHashes) {
    if (!isTransactionHash(hash)) {
      throw new LedgerError("E_INVALID_ARGUMENT", `${String(hash)} is not a 32-byte transaction hash`);
    }
  }
  const unique = [...new Set(source.transactionHashes.map((hash) => hash.toLowerCase() as Hex))];
  const byHash = new Map<Hex, { status: TransactionStatus; transfers: Transfer[] }>();
  await forEachConcurrently(unique, CONCURRENCY, async (hash) => {
    byHash.set(hash, await readReceipt(rpc, hash, token));
  });
  const ordered = unique.map((hash) => byHash.get(hash) as { status: TransactionStatus; transfers: Transfer[] });
  const all = ordered.flatMap((entry) => entry.transfers);
  return {
    transfers: payers === undefined ? all : selectPayouts(all, payers),
    read: all,
    transactions: ordered.map((entry) => entry.status),
  };
}

export interface RangeSource {
  token: Hex;
  /**
   * Required: a range is read through `eth_getLogs` filtered on the sender, never every holder's
   * transfers. Same meaning as in `TransactionSource`: the payout wallet first.
   */
  payers: readonly Hex[];
  fromBlock: number;
  /** Last block, inclusive, or a tag resolved once. Default `"finalized"`. */
  toBlock?: number | BlockTag;
  /** Largest block span per `eth_getLogs` call, passed through to `evm-log-walker`. */
  chunkSize?: number;
}

/**
 * Reads every transfer of `token` sent by one of `payers` in a block range, through `evm-log-walker`'s
 * adaptive walk: for a round paid in many transactions whose hashes are not at hand.
 */
export async function fetchTransfersByRange(rpc: Rpc, source: RangeSource): Promise<FetchedTransfers> {
  const token = checkedAddress(source.token, "token");
  const payers = checkedPayers(source.payers);
  const { logs } = await collectLogs({
    rpc,
    address: token,
    topics: [TRANSFER_TOPIC, payers.map(addressToTopic)],
    fromBlock: source.fromBlock,
    ...(source.toBlock !== undefined ? { toBlock: source.toBlock } : {}),
    ...(source.chunkSize !== undefined ? { chunkSize: source.chunkSize } : {}),
  });
  const decoded = logs.filter((log) => !log.removed && isErc20Transfer(log)).map(decodeTransfer);
  return { transfers: selectPayouts(decoded, payers), read: decoded, transactions: [] };
}

async function readReceipt(
  rpc: Rpc,
  hash: Hex,
  token: Hex,
): Promise<{ status: TransactionStatus; transfers: Transfer[] }> {
  const receipt = await rpc.call<Record<string, unknown> | null>("eth_getTransactionReceipt", [hash]);
  if (!receipt) {
    throw new LedgerError(
      "E_MALFORMED_TX",
      `eth_getTransactionReceipt returned no receipt for ${hash}: it is not mined on this chain, or the endpoint does not keep receipts that old`,
    );
  }
  const blockNumber = hexToInt(receipt["blockNumber"], `${hash} blockNumber`, "E_MALFORMED_TX");
  const transactionIndex = hexToInt(receipt["transactionIndex"], `${hash} transactionIndex`, "E_MALFORMED_TX");
  const succeeded = receipt["status"] !== "0x0";
  const rawLogs = receipt["logs"];
  if (!Array.isArray(rawLogs)) {
    throw new LedgerError("E_MALFORMED_TX", `the receipt for ${hash} has no logs array`);
  }
  const transfers: Transfer[] = [];
  for (const raw of rawLogs) {
    const log = toLog(raw, hash, transactionIndex);
    if (log.removed || normalizeAddress(log.address) !== token || !isErc20Transfer(log)) continue;
    transfers.push(decodeTransfer(log));
  }
  return { status: { hash, succeeded, blockNumber }, transfers };
}

function toLog(raw: unknown, hash: Hex, transactionIndex: number): Log {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const topics = record["topics"];
  if (!isAddress(record["address"]) || !Array.isArray(topics) || typeof record["data"] !== "string") {
    throw new LedgerError("E_MALFORMED_TX", `the receipt for ${hash} holds a malformed log`);
  }
  return {
    address: record["address"],
    topics: topics as Hex[],
    data: record["data"] as Hex,
    blockNumber: hexToInt(record["blockNumber"], `${hash} log blockNumber`, "E_MALFORMED_TX"),
    blockHash: (record["blockHash"] ?? "0x") as Hex,
    transactionHash: hash,
    transactionIndex,
    logIndex: hexToInt(record["logIndex"], `${hash} logIndex`, "E_MALFORMED_TX"),
    removed: record["removed"] === true,
  };
}

function checkedPayers(payers: readonly Hex[]): Hex[] {
  if (payers.length === 0) {
    throw new LedgerError("E_INVALID_ARGUMENT", "at least one payer address is needed");
  }
  return [...new Set(payers.map((payer) => checkedAddress(payer, "payer")))];
}

function checkedAddress(value: unknown, name: string): Hex {
  if (!isAddress(value)) {
    throw new LedgerError("E_INVALID_ARGUMENT", `${name} ${String(value)} is not a 20-byte hex address`);
  }
  return normalizeAddress(value);
}
