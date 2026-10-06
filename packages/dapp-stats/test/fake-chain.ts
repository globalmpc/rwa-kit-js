/**
 * A well-behaved in-memory chain: unlike `evm-log-walker`'s own fixture, this one never refuses a
 * call. Endpoint resilience (chunking, refusals, retries) is `evm-log-walker`'s job and is tested
 * there; this fixture only needs to answer `eth_getLogs`, `eth_getTransactionReceipt`,
 * `eth_getTransactionByHash`, `eth_getBlockByNumber` and `eth_chainId` correctly so this
 * package's own metric logic can be tested against known data.
 */
import type { Hex } from "@globalmpc/evm-log-walker";
import { TRANSFER_TOPIC } from "../src/transfers.js";

export interface FakeTransfer {
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
  from: Hex;
  to: Hex;
  value: bigint;
}

export interface FakeTxInfo {
  from: Hex;
  blockNumber: number;
  /** Reported as the receipt's `effectiveGasPrice`, unless `legacy` is set. */
  gasPrice: bigint;
  /** Omit `effectiveGasPrice` from the receipt, forcing the `eth_getTransactionByHash` fallback. */
  legacy?: boolean;
}

export interface FakeChainOptions {
  chainId?: number;
  address?: Hex;
  head: number;
  genesisTimestamp?: number;
  blockTime?: number;
  transfers: readonly FakeTransfer[];
  transactions: ReadonlyMap<Hex, FakeTxInfo>;
}

export interface RecordedCall {
  method: string;
  params: unknown[];
}

export const DEFAULT_ADDRESS: Hex = "0x1111111111111111111111111111111111111111";

export function createFakeChain(options: FakeChainOptions): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const chainId = options.chainId ?? 56;
  const address = options.address ?? DEFAULT_ADDRESS;
  const blockTime = options.blockTime ?? 3;
  const genesisTimestamp = options.genesisTimestamp ?? 1_700_000_000;
  const calls: RecordedCall[] = [];
  const timestampOf = (blockNumber: number): number => genesisTimestamp + blockNumber * blockTime;

  function handle(method: string, params: unknown[]): unknown {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId":
        return numberToQuantity(chainId);

      case "eth_getBlockByNumber": {
        const [tag] = params as [string];
        const blockNumber = isTag(tag) ? options.head : Number.parseInt(tag, 16);
        return { number: numberToQuantity(blockNumber), timestamp: numberToQuantity(timestampOf(blockNumber)) };
      }

      case "eth_getLogs": {
        const [filter] = params as [{ fromBlock: string; toBlock: string }];
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        return options.transfers
          .filter((transfer) => transfer.blockNumber >= from && transfer.blockNumber <= to)
          .map((transfer) => ({
            address,
            topics: [TRANSFER_TOPIC, addressToTopic(transfer.from), addressToTopic(transfer.to)],
            data: bigintToData(transfer.value),
            blockNumber: numberToQuantity(transfer.blockNumber),
            blockHash: addressToTopic(address),
            transactionHash: transfer.transactionHash,
            transactionIndex: numberToQuantity(0),
            logIndex: numberToQuantity(transfer.logIndex),
            removed: false,
          }));
      }

      case "eth_getTransactionReceipt": {
        const [hash] = params as [Hex];
        const tx = options.transactions.get(hash);
        if (!tx) return null;
        const receipt: Record<string, unknown> = { from: tx.from, blockNumber: numberToQuantity(tx.blockNumber) };
        if (!tx.legacy) receipt["effectiveGasPrice"] = bigintToQuantity(tx.gasPrice);
        return receipt;
      }

      case "eth_getTransactionByHash": {
        const [hash] = params as [Hex];
        const tx = options.transactions.get(hash);
        if (!tx) return null;
        return { from: tx.from, blockNumber: numberToQuantity(tx.blockNumber), gasPrice: bigintToQuantity(tx.gasPrice) };
      }

      default:
        throw new Error(`fake chain: unhandled method ${method}`);
    }
  }

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const result = handle(body.method, body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
}

function isTag(value: string): boolean {
  return value === "latest" || value === "finalized" || value === "safe";
}

function numberToQuantity(value: number): Hex {
  return `0x${value.toString(16)}` as Hex;
}

function bigintToQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

function bigintToData(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function addressToTopic(address: Hex): Hex {
  return `0x${"0".repeat(24)}${address.slice(2)}` as Hex;
}
