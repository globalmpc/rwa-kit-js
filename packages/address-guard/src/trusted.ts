import type { HistoryEvent } from "./history.js";
import { normalizeAddress, type Address } from "./hex.js";

export interface TrustedRecipientOptions {
  /**
   * Smallest value that counts as a real send, in token base units. A dust send is a weak signal:
   * an attacker can provoke one. Raising this asks for evidence the owner meant the transfer.
   *
   * A zero value never counts, whatever this is set to — including `0n`. That is the whole point
   * of the rule; see `deriveTrustedRecipients`.
   */
  minValueRaw?: bigint;
}

/**
 * The recipients the owner has really sent to, in first-seen order, lower-cased and deduplicated.
 *
 * An event counts only when all four hold:
 *
 * 1. `direction === "out"` — money left the owner.
 * 2. `success === true` — a reverted transaction moved nothing.
 * 3. `valueRaw > 0n`, and `>= minValueRaw` when one is given — a zero-value transfer is not a send.
 * 4. `txFrom === owner` — the owner's own transaction, not somebody else's.
 * 5. The owner's signed calldata named this recipient: the transaction called the token directly
 *    with `transfer(address,uint256)`, and its address argument is this counterparty. See
 *    `ownerNamedRecipient` — signing a transaction is not the same as choosing a recipient.
 *
 * Rule 4 is the one that matters and the reason this function exists. An ERC-20 `Transfer` log
 * names its `from` in an indexed topic, and anyone can make that topic name any account:
 * `transferFrom(victim, attacker, 0)` emits `Transfer(victim, attacker, 0)` because EIP-20
 * requires the event even for a zero value and the usual allowance check passes for zero. Trusting
 * the log's `from` would let a look-alike enrol itself as a trusted recipient, which is exactly
 * the attack this package is built to catch. Rule 3 closes the same door from the other side.
 *
 * Pure: no I/O, no clock, no network. Feed it events from any `HistorySource`.
 */
export function deriveTrustedRecipients(
  history: readonly HistoryEvent[],
  options: TrustedRecipientOptions = {},
): Address[] {
  const floor = options.minValueRaw !== undefined && options.minValueRaw > 1n ? options.minValueRaw : 1n;
  const seen = new Set<string>();
  const trusted: Address[] = [];
  for (const event of history) {
    if (!isRealOutgoingSend(event, floor)) continue;
    const recipient = normalizeAddress(event.counterparty);
    if (seen.has(recipient)) continue;
    seen.add(recipient);
    trusted.push(recipient);
  }
  return trusted;
}

/**
 * Whether one event is evidence that the owner chose to send to `counterparty`.
 *
 * The `valueRaw > 0n` test is written out rather than left to `floor`, because this predicate is
 * exported: a direct caller passing `floor: 0n` would otherwise be told that a zero-value
 * transfer is a real send, which is the one thing the rule exists to deny.
 */
export function isRealOutgoingSend(event: HistoryEvent, floor: bigint): boolean {
  if (
    event.direction !== "out" ||
    !event.success ||
    event.valueRaw <= 0n ||
    event.valueRaw < floor ||
    normalizeAddress(event.txFrom) !== normalizeAddress(event.owner)
  ) {
    return false;
  }
  return ownerNamedRecipient(event);
}

/**
 * Whether the owner's own signature named this recipient.
 *
 * `txFrom === owner` establishes only that the owner signed *something*. It does not establish
 * what. An owner who has approved a spender — and approvals are everywhere — can sign a call to
 * that spender, which then calls `transferFrom(owner, attacker, value)` on a token this package
 * trusts. The movement is real, the token is named, the value is non-zero and the signer is the
 * owner, so every other condition holds while the owner never saw the recipient.
 *
 * The recipient is only demonstrably chosen when it appears in the calldata the owner signed:
 * the transaction called the token itself, with a plain `transfer(address,uint256)`, naming this
 * counterparty. That is the shape a wallet renders as "send X to Y" before asking for a
 * signature.
 *
 * This is deliberately strict and it has a cost: a payout made through a multisend, a Safe, or
 * any other contract does not evidence an intended recipient, so those recipients stay `"new"`.
 * `"new"` is the safe answer to get wrong; `"trusted"` is not. See the README's limitations.
 */
export function ownerNamedRecipient(event: HistoryEvent): boolean {
  if (event.token === undefined || event.txTo === undefined || event.txTransferTo === undefined) {
    return false;
  }
  return (
    // The owner called the token contract directly, not something holding an approval.
    normalizeAddress(event.txTo) === normalizeAddress(event.token) &&
    // ...and the recipient in those signed bytes is the one the log reports.
    normalizeAddress(event.txTransferTo) === normalizeAddress(event.counterparty)
  );
}
