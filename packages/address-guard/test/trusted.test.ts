import { describe, expect, it } from "vitest";
import type { Address, Hex } from "../src/hex.js";
import type { HistoryEvent } from "../src/history.js";
import { deriveTrustedRecipients, isRealOutgoingSend } from "../src/trusted.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

/**
 * A genuine direct send. When `counterparty` is overridden the signed calldata follows it, since
 * the two matching is precisely what `ownerNamedRecipient` checks.
 */
function event(over: Partial<HistoryEvent> = {}): HistoryEvent {
  const counterparty = over.counterparty ?? A;
  return {
    owner: OWNER,
    counterparty,
    direction: "out",
    valueRaw: 1_000n,
    success: true,
    txFrom: OWNER,
    // A direct transfer(address,uint256) on the token: the recipient is in the signed calldata,
    // which is what makes it evidence of a choice rather than just of a signature.
    token: TOKEN,
    txTo: TOKEN,
    txTransferTo: counterparty,
    txHash: `0x${"11".repeat(32)}` as Hex,
    blockNumber: 1n,
    ...over,
  };
}

describe("deriveTrustedRecipients", () => {
  it("keeps a genuine send", () => {
    expect(deriveTrustedRecipients([event()])).toEqual([A]);
  });

  it("ignores an incoming transfer, however large", () => {
    expect(deriveTrustedRecipients([event({ direction: "in", valueRaw: 10n ** 24n })])).toEqual([]);
  });

  it("ignores a reverted transaction", () => {
    expect(deriveTrustedRecipients([event({ success: false })])).toEqual([]);
  });

  it("ignores a zero-value transfer", () => {
    expect(deriveTrustedRecipients([event({ valueRaw: 0n })])).toEqual([]);
  });

  it("ignores a transfer the owner did not send", () => {
    expect(deriveTrustedRecipients([event({ txFrom: B })])).toEqual([]);
  });

  it("compares owner and txFrom case-insensitively", () => {
    const upper = `0x${OWNER.slice(2).toUpperCase()}` as Address;
    expect(deriveTrustedRecipients([event({ txFrom: upper })])).toEqual([A]);
  });

  it("lower-cases and deduplicates, keeping first-seen order", () => {
    const events = [
      event({ counterparty: B }),
      event({ counterparty: A }),
      event({ counterparty: `0x${B.slice(2).toUpperCase()}` as Address }),
    ];
    expect(deriveTrustedRecipients(events)).toEqual([B, A]);
  });

  it("returns nothing for an empty history", () => {
    expect(deriveTrustedRecipients([])).toEqual([]);
  });

  describe("minValueRaw", () => {
    it("drops a send below the floor", () => {
      expect(deriveTrustedRecipients([event({ valueRaw: 5n })], { minValueRaw: 10n })).toEqual([]);
    });

    it("keeps a send at the floor", () => {
      expect(deriveTrustedRecipients([event({ valueRaw: 10n })], { minValueRaw: 10n })).toEqual([A]);
    });

    /**
     * A floor of zero would otherwise admit the zero-value forgery the whole rule exists to
     * exclude, so the floor is clamped to 1 wei-equivalent and a zero value never counts.
     */
    it("still refuses a zero value when the floor is zero or negative", () => {
      for (const minValueRaw of [0n, -1n]) {
        expect(deriveTrustedRecipients([event({ valueRaw: 0n })], { minValueRaw })).toEqual([]);
        expect(deriveTrustedRecipients([event({ valueRaw: 1n })], { minValueRaw })).toEqual([A]);
      }
    });
  });
});

describe("isRealOutgoingSend", () => {
  it("requires every condition at once", () => {
    expect(isRealOutgoingSend(event(), 1n)).toBe(true);
    expect(isRealOutgoingSend(event({ direction: "in" }), 1n)).toBe(false);
    expect(isRealOutgoingSend(event({ success: false }), 1n)).toBe(false);
    expect(isRealOutgoingSend(event({ valueRaw: 0n }), 1n)).toBe(false);
    expect(isRealOutgoingSend(event({ txFrom: B }), 1n)).toBe(false);
  });
});
