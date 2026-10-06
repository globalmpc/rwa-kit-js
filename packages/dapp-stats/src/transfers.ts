import type { Hex, Log } from "@globalmpc/evm-log-walker";
import { StatsError } from "./errors.js";
import { hexToBigInt, isAddress, topicToAddress } from "./hex.js";

/** `keccak256("Transfer(address,address,uint256)")`. */
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface Transfer {
  from: Hex;
  to: Hex;
  value: bigint;
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
}

/**
 * Decodes a `Transfer(address indexed from, address indexed to, uint256 value)` log. `from` and
 * `to` are packed into the low 20 bytes of an indexed topic; `value` is the unindexed word in
 * `data`. Throws `E_MALFORMED_TRANSFER` for anything else, including a same-signature event with a
 * different shape.
 */
export function decodeTransfer(log: Log): Transfer {
  if (log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) {
    throw new StatsError(
      "E_MALFORMED_TRANSFER",
      `log ${log.transactionHash}#${log.logIndex} is not a Transfer(address,address,uint256) event`,
    );
  }
  const from = topicToAddress(log.topics[1] as Hex);
  const to = topicToAddress(log.topics[2] as Hex);
  if (!isAddress(from) || !isAddress(to)) {
    throw new StatsError("E_MALFORMED_TRANSFER", `log ${log.transactionHash}#${log.logIndex} has a malformed address topic`);
  }
  return {
    from,
    to,
    value: hexToBigInt(log.data, "Transfer.value"),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}
