import type { Address, Hex, SignPolicy } from "../src/index.js";

export const CHAIN = 56;
export const OTHER_CHAIN = 1;

/** Placeholder addresses: repeated digits, belonging to nobody. */
export const RELAY_TARGET: Address = "0x1111111111111111111111111111111111111111";
export const TOKEN: Address = "0x2222222222222222222222222222222222222222";
export const PAYEE: Address = "0x3333333333333333333333333333333333333333";
export const STRANGER: Address = "0x4444444444444444444444444444444444444444";
export const DELEGATE: Address = "0x5555555555555555555555555555555555555555";
export const SWEEPER: Address = "0x6666666666666666666666666666666666666666";
export const PERMIT_CONTRACT: Address = "0x7777777777777777777777777777777777777777";

/** `checkIn()`, any 4-byte selector stands in for a function the relayer may call. */
export const CHECK_IN: Hex = "0x183ff085";
export const APPROVE: Hex = "0x095ea7b3";

export const ONE_HOUR = 3_600_000;

export function transferData(recipient: Address, amount: bigint): Hex {
  return `0xa9059cbb${recipient.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

export function approveData(spender: Address, amount: bigint): Hex {
  return `${APPROVE}${spender.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

/** A policy shaped like a relayer key's: one contract, one function, a token with caps, one permit. */
export function relayerPolicy(): SignPolicy {
  return {
    chainIds: [CHAIN],
    transactions: {
      calls: [{ to: RELAY_TARGET, selectors: [CHECK_IN] }],
      tokens: [{ token: TOKEN, maxAmount: 1_000n, window: { durationMs: ONE_HOUR, max: 2_500n }, recipients: [PAYEE] }],
      maxValue: 10n ** 16n,
      window: { durationMs: ONE_HOUR, max: 3n * 10n ** 16n },
    },
    authorizations: { allow: [DELEGATE] },
    typedData: [{ verifyingContract: PERMIT_CONTRACT, name: "Example", primaryTypes: ["ClaimPermit"] }],
    messages: { prefixes: ["Sign in to example.org"] },
  };
}
