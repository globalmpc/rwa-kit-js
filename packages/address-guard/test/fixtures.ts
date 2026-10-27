/**
 * Sanitized histories replayed through a mock `HistorySource`. Every address is synthetic; none is
 * anyone's wallet. One entry per case the trust rule has to get right.
 */
import type { Address, Hex } from "../src/hex.js";
import type { History, HistoryEvent, HistorySource } from "../src/history.js";
import { GENUINE, IMITATOR, OWNER, SPENDER, STRANGER, TOKEN } from "./fake-chain.js";

export { GENUINE, IMITATOR, OWNER, SPENDER, STRANGER, TOKEN };

let nonce = 0;
function hash(): Hex {
  nonce += 1;
  return `0x${nonce.toString(16).padStart(64, "0")}` as Hex;
}

function base(over: Partial<HistoryEvent>): HistoryEvent {
  return {
    owner: OWNER,
    counterparty: STRANGER,
    direction: "in",
    valueRaw: 0n,
    success: true,
    txFrom: STRANGER,
    txHash: hash(),
    blockNumber: 1n,
    token: TOKEN,
    ...over,
  };
}

/**
 * A genuine outgoing send: the only thing that makes a recipient trusted. The owner called the
 * token directly and named this recipient in the calldata they signed.
 */
export const genuineSend = (to: Address = GENUINE): HistoryEvent =>
  base({
    counterparty: to,
    direction: "out",
    valueRaw: 1_000_000n,
    txFrom: OWNER,
    txTo: TOKEN,
    txTransferTo: to,
    blockNumber: 100n,
  });

/**
 * A real movement of a named token that the owner signed but whose recipient they never named:
 * an approved spender calling `transferFrom` inside a transaction the owner authorised. Every
 * other condition of the trust rule holds, which is exactly why `ownerNamedRecipient` exists.
 */
export const approvedSpenderSend = (to: Address = IMITATOR): HistoryEvent =>
  base({
    counterparty: to,
    direction: "out",
    valueRaw: 1_000_000n,
    txFrom: OWNER,
    // The owner called the spender, not the token, and the calldata named no recipient.
    txTo: SPENDER,
    blockNumber: 105n,
  });

/** Dust arriving unasked, from an address that imitates a trusted one. */
export const receivedDust = (from: Address = IMITATOR): HistoryEvent =>
  base({ counterparty: from, direction: "in", valueRaw: 1n, txFrom: from, blockNumber: 101n });

/** The forgery: a zero-value transferFrom that makes the log read as the owner's own send. */
export const forgedFrom = (to: Address = IMITATOR): HistoryEvent =>
  base({ counterparty: to, direction: "out", valueRaw: 0n, txFrom: to, blockNumber: 102n });

/** A zero-value transfer the owner really did sign. Still not evidence of an intended recipient. */
export const zeroValueSend = (to: Address = IMITATOR): HistoryEvent =>
  base({ txTo: TOKEN, txTransferTo: to, counterparty: to, direction: "out", valueRaw: 0n, txFrom: OWNER, blockNumber: 103n });

/** A send that reverted: it moved nothing, so it proves nothing. */
export const failedSend = (to: Address = IMITATOR): HistoryEvent =>
  base({ txTo: TOKEN, txTransferTo: to, counterparty: to, direction: "out", valueRaw: 5_000n, txFrom: OWNER, success: false, blockNumber: 104n });

/** The full poisoning picture: one real send, and four things that must not be mistaken for one. */
export const poisonedHistory: HistoryEvent[] = [
  genuineSend(),
  receivedDust(),
  forgedFrom(),
  zeroValueSend(),
  failedSend(),
  approvedSpenderSend(),
];

/** A `HistorySource` that replays fixed events, so the CLI can be driven with no chain at all. */
export function mockSource(events: readonly HistoryEvent[], kind: "indexer" | "rpc" = "rpc"): HistorySource {
  return {
    fetch: async (): Promise<History> => ({
      events: [...events],
      source: { kind, endpoint: "https://fixture.example", endpoints: ["https://fixture.example"], fromBlock: 100, toBlock: 200 },
    }),
  };
}
