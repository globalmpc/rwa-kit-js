/**
 * The trust rule: which transfers make a recipient trusted. A Transfer log can be forged, a
 * contract can emit one without moving a token, and an approved spender can move tokens in a
 * transaction the owner signed without choosing the recipient; none of these may create trust.
 */
import { createRpc } from "@globalmpc/evm-log-walker";
import { describe, expect, it } from "vitest";
import { assessRecipient } from "../src/assess.js";
import { EXIT, runAddressGuard, type CliIo } from "../src/cli/address-guard.js";
import type { Address, Hex } from "../src/hex.js";
import type { HistoryEvent } from "../src/history.js";
import { rpcLogSource } from "../src/sources.js";
import { deriveTrustedRecipients, isRealOutgoingSend, ownerNamedRecipient } from "../src/trusted.js";
import { fakeChain, GENUINE, IMITATOR, OWNER, SPENDER, TOKEN } from "./fake-chain.js";
import { approvedSpenderSend, genuineSend, mockSource, poisonedHistory } from "./fixtures.js";

function io(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    env: {},
    source: () => mockSource(poisonedHistory),
    ...over,
  };
}

describe("isRealOutgoingSend enforces the zero-value rule itself", () => {
  const event = (valueRaw: bigint): HistoryEvent => ({
    owner: OWNER,
    counterparty: GENUINE,
    direction: "out",
    valueRaw,
    success: true,
    txFrom: OWNER,
    token: TOKEN,
    txTo: TOKEN,
    txTransferTo: GENUINE,
    txHash: `0x${"ab".repeat(32)}` as Hex,
    blockNumber: 1n,
  });

  it("rejects a zero value at any floor a caller passes", () => {
    for (const floor of [0n, -1n, 1n]) {
      expect(isRealOutgoingSend(event(0n), floor)).toBe(false);
    }
  });

  it("still accepts a non-zero value at a zero floor", () => {
    expect(isRealOutgoingSend(event(1n), 0n)).toBe(true);
  });
});

describe("a fabricated Transfer log cannot create trust", () => {
  /**
   * The attack the token filter closes. Any contract may emit a three-topic
   * Transfer(owner, anyone, value) without moving a token. If the owner signs one transaction to
   * an attacker's contract -- a fake airdrop claim, the most ordinary phishing step there is --
   * every condition of the trust rule holds: direction out, a log so the transaction succeeded,
   * a non-zero value, and txFrom genuinely the owner. The look-alike becomes trusted and `check`
   * would exit 0 on it.
   */
  const EVIL = "0xdead00000000000000000000000000000000dead" as Address;

  it("refuses to read without a named token, so the log can never be collected", () => {
    const rpc = createRpc({ urls: "https://r.example", fetch: fakeChain({ head: 100, transfers: [] }).fetch });
    expect(() => rpcLogSource(rpc, { tokens: [] })).toThrow(/tokens is required/);
  });

  it("shows the bypass is real when an unnamed contract's log is believed", () => {
    // What an unfiltered read would have produced: the attacker's contract naming the owner.
    const fabricated = {
      ...genuineSend(IMITATOR),
      token: EVIL,
      valueRaw: 1_000n,
      txFrom: OWNER, // the owner really signed the transaction
      // ...and the calldata named this recipient, so every condition but the token holds. The
      // attacker's contract is both the token that emitted the log and what was called.
      txTo: EVIL,
      txTransferTo: IMITATOR,
    };
    // Every condition of the rule is met, so the look-alike would be trusted.
    expect(deriveTrustedRecipients([fabricated])).toEqual([IMITATOR]);
  });

  it("excludes it once only named tokens are read", async () => {
    const chain = fakeChain({
      head: 100,
      transfers: [
        { blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n, token: TOKEN },
        // The attacker's contract emits the same shape from a different address.
        { blockNumber: 20, from: OWNER, to: IMITATOR, valueRaw: 1_000n, token: EVIL, txFrom: OWNER },
      ],
    });
    const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
    const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
    expect(deriveTrustedRecipients(events)).toEqual([GENUINE]);
  });

  it("requires --token on every command that reads history", async () => {
    for (const argv of [
      ["check", GENUINE, "--owner", OWNER, "--rpc", "https://r.example"],
      ["scan", OWNER, "--rpc", "https://r.example"],
      ["payouts", "/f.csv", "--owner", OWNER, "--rpc", "https://r.example"],
    ]) {
      const context = io({ readFile: async () => `${GENUINE}\n` });
      expect(await runAddressGuard(argv, context)).toBe(EXIT.USAGE);
      expect(context.err.join(" ")).toContain("--token is required");
    }
  });

  it("leaves checksum working without one, since it reads no history", async () => {
    expect(await runAddressGuard(["checksum", GENUINE], io())).toBe(EXIT.TRUSTED);
  });
});

describe("signing a transaction is not choosing a recipient", () => {
  /**
   * The attack. An owner who has approved a spender -- and approvals are everywhere -- signs a
   * call to that spender, which calls transferFrom(owner, lookalike, value) on a token this
   * package trusts. The movement is real, the token is named, the value is non-zero and the
   * signer is the owner. Without the calldata condition every other condition holds while the
   * owner never saw the recipient, and the look-alike would become trusted: a one-time drain
   * turned into persistent mis-trust, so a later manual payment to it would be waved through.
   */
  it("does not trust a recipient the owner's calldata never named", () => {
    expect(deriveTrustedRecipients([approvedSpenderSend(IMITATOR)])).toEqual([]);
  });

  it("still trusts a direct transfer the owner signed", () => {
    expect(deriveTrustedRecipients([genuineSend(GENUINE)])).toEqual([GENUINE]);
  });

  it("keeps the look-alike catchable when both events are present", () => {
    const trusted = deriveTrustedRecipients([genuineSend(GENUINE), approvedSpenderSend(IMITATOR)]);
    expect(trusted).toEqual([GENUINE]);
    expect(assessRecipient(IMITATOR, { trusted }).verdict).toBe("lookalike");
  });

  describe("ownerNamedRecipient", () => {
    const direct = genuineSend(GENUINE);

    it("requires the transaction to have called the token itself", () => {
      expect(ownerNamedRecipient(direct)).toBe(true);
      expect(ownerNamedRecipient({ ...direct, txTo: SPENDER })).toBe(false);
    });

    it("requires the signed recipient to be the one the log reports", () => {
      expect(ownerNamedRecipient({ ...direct, txTransferTo: IMITATOR })).toBe(false);
    });

    it("refuses when any of the three fields is missing", () => {
      for (const missing of ["token", "txTo", "txTransferTo"] as const) {
        const event = { ...direct };
        delete event[missing];
        expect(ownerNamedRecipient(event)).toBe(false);
      }
    });

    it("compares case-insensitively", () => {
      const upper = `0x${GENUINE.slice(2).toUpperCase()}` as Address;
      expect(ownerNamedRecipient({ ...direct, txTransferTo: upper })).toBe(true);
    });
  });

  describe("read end to end", () => {
    it("decodes a plain transfer and trusts its recipient", async () => {
      const chain = fakeChain({
        head: 200,
        transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n }],
      });
      const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
      const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
      expect(events[0]).toMatchObject({ txTo: TOKEN, txTransferTo: GENUINE });
      expect(deriveTrustedRecipients(events)).toEqual([GENUINE]);
    });

    it("does not trust a transfer routed through an approved spender", async () => {
      const chain = fakeChain({
        head: 200,
        transfers: [
          // The owner signed a call to the spender; the token moved to the imitator.
          { blockNumber: 10, from: OWNER, to: IMITATOR, valueRaw: 1_000n, txFrom: OWNER, txTo: SPENDER, txTransferTo: null },
        ],
      });
      const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
      const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
      expect(events[0]?.txTo).toBe(SPENDER);
      expect(events[0]?.txTransferTo).toBeUndefined();
      expect(deriveTrustedRecipients(events)).toEqual([]);
    });

    it("does not decode calldata that is not a plain transfer", async () => {
      const chain = fakeChain({
        head: 200,
        transfers: [{ blockNumber: 10, from: OWNER, to: GENUINE, valueRaw: 1_000n, txTransferTo: null }],
      });
      const rpc = createRpc({ urls: "https://r.example", fetch: chain.fetch });
      const { events } = await rpcLogSource(rpc, { tokens: [TOKEN] }).fetch(OWNER);
      expect(events[0]?.txTransferTo).toBeUndefined();
      expect(deriveTrustedRecipients(events)).toEqual([]);
    });
  });
});
