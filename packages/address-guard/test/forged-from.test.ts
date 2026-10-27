import { describe, expect, it } from "vitest";
import { deriveTrustedRecipients } from "../src/trusted.js";
import type { HistoryEvent } from "../src/history.js";
import type { Address, Hex } from "../src/hex.js";

/**
 * Phase 0 spike. An ERC-20 `Transfer(from, to, value)` names `from` in its topics, but that is the
 * token's accounting, not the transaction's sender. `transferFrom(victim, attacker, 0)` emits
 * `Transfer(victim, attacker, 0)` while `tx.from` is the attacker: EIP-20 requires the event even
 * for a zero value, and the allowance check most tokens use passes for zero (`0 >= 0`).
 *
 * So a look-alike can mint a log that reads as an outgoing send from the victim to itself. If the
 * log's `from` topic were enough to call something a trusted recipient, the attacker's address
 * would become trusted and every later check would wave it through — the precise failure this
 * package exists to prevent. These addresses are synthetic; see NOTES.md.
 */
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const ATTACKER = "0x2222222222222222222222222222222222222222" as Address;
const GENUINE = "0x3333333333333333333333333333333333333333" as Address;
const TOKEN = "0x4444444444444444444444444444444444444444" as Address;

function event(over: Partial<HistoryEvent>): HistoryEvent {
  const counterparty = over.counterparty ?? GENUINE;
  return {
    owner: OWNER,
    counterparty,
    direction: "out",
    valueRaw: 1_000n,
    success: true,
    txFrom: OWNER,
    // A direct transfer(address,uint256) on the token: the recipient is in the signed calldata,
    // which is what makes it evidence of a choice rather than just of a signature.
    txTo: TOKEN,
    txTransferTo: counterparty,
    txHash: `0x${"ab".repeat(32)}` as Hex,
    blockNumber: 100n,
    token: TOKEN,
    ...over,
  };
}

describe("the zero-value transferFrom forgery", () => {
  it("does not trust a recipient whose only evidence is a log the owner did not send", () => {
    const forged = event({
      // The log says the owner sent it...
      direction: "out",
      counterparty: ATTACKER,
      // ...but the transaction was the attacker's, and it moved nothing.
      txFrom: ATTACKER,
      valueRaw: 0n,
    });

    expect(deriveTrustedRecipients([forged])).toEqual([]);
  });

  it("still trusts a recipient the owner really sent to", () => {
    expect(deriveTrustedRecipients([event({ counterparty: GENUINE })])).toEqual([GENUINE]);
  });

  it("rejects each half of the forgery on its own", () => {
    // A real value, but somebody else's transaction: still a forgery.
    expect(deriveTrustedRecipients([event({ counterparty: ATTACKER, txFrom: ATTACKER })])).toEqual([]);
    // The owner's own transaction, but nothing moved: no evidence of an intended recipient.
    expect(deriveTrustedRecipients([event({ counterparty: ATTACKER, valueRaw: 0n })])).toEqual([]);
  });
});
