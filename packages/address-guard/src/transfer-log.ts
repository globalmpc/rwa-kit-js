import type { Log } from "@globalmpc/evm-log-walker";
import { GuardError } from "./errors.js";
import { hexToBigInt, isAddress, normalizeAddress, topicToAddress, type Address, type Hex } from "./hex.js";

/** `keccak256("Transfer(address,address,uint256)")`. */
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** One decoded ERC-20 `Transfer`, before it is turned into a `HistoryEvent`. */
export interface TransferLog {
  token: Address;
  from: Address;
  to: Address;
  valueRaw: bigint;
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
}

/**
 * True for a log that is an ERC-20 `Transfer`. An ERC-721 `Transfer` shares the signature but
 * carries four topics, because its token id is indexed, so the topic count tells them apart.
 */
export function isErc20Transfer(log: Pick<Log, "topics">): boolean {
  return log.topics.length === 3 && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC;
}

/** Decodes an ERC-20 `Transfer` log. Throws `E_MALFORMED_TRANSFER` for anything else. */
export function decodeTransferLog(log: Log): TransferLog {
  const where = `log ${log.transactionHash}#${log.logIndex}`;
  if (!isErc20Transfer(log)) {
    throw new GuardError("E_MALFORMED_TRANSFER", `${where} is not an ERC-20 Transfer(address,address,uint256) event`);
  }
  if (!isAddress(log.address)) {
    throw new GuardError("E_MALFORMED_TRANSFER", `${where} has a malformed contract address`);
  }
  return {
    token: normalizeAddress(log.address),
    from: topicToAddress(log.topics[1] as Hex),
    to: topicToAddress(log.topics[2] as Hex),
    valueRaw: hexToBigInt(log.data, `${where} value`),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash.toLowerCase() as Hex,
    logIndex: log.logIndex,
  };
}
