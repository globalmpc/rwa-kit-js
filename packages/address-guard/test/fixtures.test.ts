import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { deriveTrustedRecipients } from "../src/trusted.js";
import {
  failedSend,
  forgedFrom,
  GENUINE,
  genuineSend,
  IMITATOR,
  poisonedHistory,
  receivedDust,
  zeroValueSend,
} from "./fixtures.js";

describe("the poisoned history fixture", () => {
  it("trusts only the genuine send", () => {
    expect(deriveTrustedRecipients(poisonedHistory)).toEqual([GENUINE]);
  });

  it("rejects each decoy on its own", () => {
    expect(deriveTrustedRecipients([receivedDust()])).toEqual([]);
    expect(deriveTrustedRecipients([forgedFrom()])).toEqual([]);
    expect(deriveTrustedRecipients([zeroValueSend()])).toEqual([]);
    expect(deriveTrustedRecipients([failedSend()])).toEqual([]);
  });

  it("calls the imitator a look-alike once trust comes from the genuine send alone", () => {
    const trusted = deriveTrustedRecipients(poisonedHistory);
    expect(assessRecipient(IMITATOR, { trusted }).verdict).toBe("lookalike");
    expect(assessRecipient(GENUINE, { trusted }).verdict).toBe("trusted");
  });

  /**
   * What trusting the log's `from` would cost: the forgery and the zero-value send both name the
   * imitator as an outgoing counterparty, so a naive derivation enrols it. From then on the
   * imitator is an exact trusted match and every later check waves it through -- no warning, no
   * evidence, exit code 0. This is the whole reason `deriveTrustedRecipients` checks `txFrom`.
   */
  it("would wave the imitator through as trusted if the log's from were believed", () => {
    const naive = poisonedHistory
      .filter((event) => event.direction === "out")
      .map((event) => event.counterparty);
    expect(naive).toContain(IMITATOR);
    expect(assessRecipient(IMITATOR, { trusted: naive }).verdict).toBe("trusted");

    // With the real rule, the imitator never enters the set and is caught.
    const trusted = deriveTrustedRecipients(poisonedHistory);
    expect(trusted).toEqual([GENUINE]);
    expect(assessRecipient(IMITATOR, { trusted }).verdict).toBe("lookalike");
    expect(assessRecipient(GENUINE, { trusted }).verdict).toBe("trusted");
  });

  it("counts a dust send as real once the floor allows it", () => {
    const dustOut = { ...genuineSend(), valueRaw: 1n };
    expect(deriveTrustedRecipients([dustOut])).toEqual([GENUINE]);
    expect(deriveTrustedRecipients([dustOut], { minValueRaw: 2n })).toEqual([]);
  });
});
