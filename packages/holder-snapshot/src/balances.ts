import { SnapshotError } from "./errors.js";
import { normalizeAddress, ZERO_ADDRESS, type Address } from "./hex.js";
import type { Transfer } from "./transfers.js";

/** One holder and its balance in the snapshot token's base units. */
export interface Holder {
  address: Address;
  balance: bigint;
}

export interface ReplayOptions {
  /** The snapshot block. Transfers after it are ignored; transfers in it are included. */
  atBlock: number;
}

/**
 * Replays `Transfer` events, in chain order, into each address's balance at `atBlock`.
 *
 * `transfers` must hold every transfer of the token from its creation: a balance is the sum of
 * everything that ever arrived minus everything that ever left. Mints come from the zero address
 * and burns go to it, so the zero address is never a holder.
 *
 * A balance going negative means the history is missing earlier transfers, not that a wallet spent
 * tokens it never had, so it throws `E_INCOMPLETE_HISTORY` rather than returning numbers that are
 * wrong for every holder downstream of the gap. That check is a backstop, not proof of
 * completeness: a late start that only misses incoming transfers never goes negative, which is why
 * `takeSnapshot` also compares the result with the token's own `balanceOf` and `totalSupply`.
 *
 * The same log read twice (one transaction hash and log index) is counted once. Pure and offline.
 */
export function replayBalances(transfers: readonly Transfer[], options: ReplayOptions): Holder[] {
  const replay = new BalanceReplay(options);
  replay.apply(transfers);
  return replay.holders();
}

/**
 * `replayBalances`, fed one batch at a time, so a token with millions of transfers is replayed as
 * its history is read and only the running balances are held. Batches must arrive in chain order,
 * as `evm-log-walker` yields them: within a batch any order is fine, but a batch may not reach back
 * before a block already applied.
 */
export class BalanceReplay {
  readonly #atBlock: number;
  readonly #balances = new Map<Address, bigint>();
  /** Logs applied in the current block. A log belongs to one block, so this never grows past one. */
  #keys = new Set<string>();
  #block = -1;
  #applied = 0;

  constructor(options: ReplayOptions) {
    if (!Number.isSafeInteger(options.atBlock) || options.atBlock < 0) {
      throw new SnapshotError("E_INVALID_ARGUMENT", `atBlock must be a non-negative integer, got ${String(options.atBlock)}`);
    }
    this.#atBlock = options.atBlock;
  }

  /** Transfers applied so far, after dropping duplicates and anything after the snapshot block. */
  get applied(): number {
    return this.#applied;
  }

  apply(batch: readonly Transfer[]): void {
    const ordered = batch
      .filter((transfer) => transfer.blockNumber <= this.#atBlock)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    for (const transfer of ordered) {
      if (transfer.blockNumber < this.#block) {
        throw new SnapshotError(
          "E_INVALID_ARGUMENT",
          `transfer in block ${transfer.blockNumber} arrived after block ${this.#block} was applied; batches must be in chain order`,
        );
      }
      if (transfer.blockNumber > this.#block) {
        this.#block = transfer.blockNumber;
        this.#keys = new Set();
      }
      const key = `${transfer.transactionHash}#${transfer.logIndex}`;
      if (this.#keys.has(key)) continue;
      this.#keys.add(key);
      this.#move(transfer);
      this.#applied += 1;
    }
  }

  holders(): Holder[] {
    return sortHolders([...this.#balances].map(([address, balance]) => ({ address, balance })));
  }

  #move(transfer: Transfer): void {
    const balances = this.#balances;
    // One wallet, one balance: a mint to a checksummed spelling and a later send from the
    // lower-case one must meet in the same entry, or a complete history looks incomplete.
    const from = normalizeAddress(transfer.from);
    const to = normalizeAddress(transfer.to);
    // An ERC-20 `value` is a `uint256`; a negative one would credit the sender and skip the recipient.
    if (transfer.value < 0n) {
      throw new SnapshotError(
        "E_INVALID_ARGUMENT",
        `transfer ${transfer.transactionHash}#${transfer.logIndex} has a negative value; an ERC-20 transfer value is never negative`,
      );
    }
    if (from !== ZERO_ADDRESS) {
      const next = (balances.get(from) ?? 0n) - transfer.value;
      if (next < 0n) {
        throw new SnapshotError(
          "E_INCOMPLETE_HISTORY",
          `${from} would hold a negative balance after ${transfer.transactionHash}#${transfer.logIndex} ` +
            `in block ${transfer.blockNumber}: the history does not start at the token's creation block`,
        );
      }
      if (next === 0n) balances.delete(from);
      else balances.set(from, next);
    }
    if (to !== ZERO_ADDRESS && transfer.value > 0n) {
      balances.set(to, (balances.get(to) ?? 0n) + transfer.value);
    }
  }
}

/** Largest balance first, then by address, so the same snapshot always lists holders in the same order. */
export function sortHolders<T extends Holder>(holders: T[]): T[] {
  return holders.sort((a, b) => (a.balance === b.balance ? (a.address < b.address ? -1 : 1) : a.balance > b.balance ? -1 : 1));
}

/** The sum of every holder's balance, which a complete replay makes equal to `totalSupply()`. */
export function sumBalances(holders: readonly Holder[]): bigint {
  return holders.reduce((sum, holder) => sum + holder.balance, 0n);
}
