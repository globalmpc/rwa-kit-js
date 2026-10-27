import type { Log } from "@globalmpc/evm-log-walker";
import { LedgerError } from "./errors.js";
import { hexToBigInt, isAddress, normalizeAddress, topicToAddress, type Hex } from "./hex.js";

/** `keccak256("Transfer(address,address,uint256)")`. */
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * One token transfer. Its identity is `transactionHash` plus `logIndex`: one multisend
 * transaction carries many transfers, so the hash alone cannot tell them apart.
 */
export interface Transfer {
  token: Hex;
  from: Hex;
  to: Hex;
  amount: bigint;
  blockNumber: number;
  transactionHash: Hex;
  /** Position of the transaction in its block, for chain order. */
  transactionIndex: number;
  logIndex: number;
}

/** The only identity a transfer has: `<transactionHash>:<logIndex>`. */
export function transferKey(transfer: Pick<Transfer, "transactionHash" | "logIndex">): string {
  return `${transfer.transactionHash.toLowerCase()}:${transfer.logIndex}`;
}

/**
 * Decodes a `Transfer(address indexed from, address indexed to, uint256 value)` log. Throws
 * `E_MALFORMED_TRANSFER` for anything else, including an ERC-721 `Transfer`, which has the same
 * signature but four topics.
 */
export function decodeTransfer(
  log: Pick<Log, "address" | "topics" | "data" | "blockNumber" | "transactionHash" | "transactionIndex" | "logIndex">,
): Transfer {
  const where = `log ${log.transactionHash}#${log.logIndex}`;
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) {
    throw new LedgerError("E_MALFORMED_TRANSFER", `${where} is not an ERC-20 Transfer(address,address,uint256) event`);
  }
  if (!isAddress(log.address)) {
    throw new LedgerError("E_MALFORMED_TRANSFER", `${where} has a malformed contract address`);
  }
  return {
    token: normalizeAddress(log.address),
    from: topicToAddress(log.topics[1] as Hex),
    to: topicToAddress(log.topics[2] as Hex),
    amount: hexToBigInt(log.data, `${where} value`),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash.toLowerCase() as Hex,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

/** True for a log that is an ERC-20 `Transfer` (three topics, the Transfer signature). */
export function isErc20Transfer(log: Pick<Log, "topics">): boolean {
  return log.topics.length === 3 && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC;
}

/**
 * Removes repeated copies of the same transfer (same transaction hash and log index), which
 * appear when the same transaction is fetched twice or two inputs overlap. Two different log
 * indexes are two payments, even with the same amount in the same transaction; only the same log
 * read twice is collapsed. Returns the unique transfers in chain order and how many copies were
 * dropped.
 */
export function uniqueTransfers(transfers: readonly Transfer[]): { transfers: Transfer[]; dropped: number } {
  const byKey = new Map<string, Transfer>();
  for (const transfer of transfers) {
    const key = transferKey(transfer);
    if (!byKey.has(key)) byKey.set(key, transfer);
  }
  const unique = [...byKey.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex,
  );
  return { transfers: unique, dropped: transfers.length - unique.length };
}

/**
 * Keeps the transfers that are payouts of one payer's round. `payers[0]` is the payout wallet;
 * further payers are contracts that pay on its behalf, such as a multisend that pulls the total in
 * first and pays recipients from itself. Such a contract is often shared by many senders, so a
 * transfer from it counts only inside a transaction in which the payout wallet itself moved the
 * token. Transfers between payers are steps of the payout, not payments, and are left out.
 */
export function selectPayouts(transfers: readonly Transfer[], payers: readonly Hex[]): Transfer[] {
  const listed = new Set(payers.map(normalizeAddress));
  const wallet = normalizeAddress(payers[0] as Hex);
  const walletTransactions = new Set(transfers.filter((transfer) => transfer.from === wallet).map((transfer) => transfer.transactionHash));
  return transfers.filter(
    (transfer) =>
      listed.has(transfer.from) &&
      !listed.has(transfer.to) &&
      (transfer.from === wallet || walletTransactions.has(transfer.transactionHash)),
  );
}
