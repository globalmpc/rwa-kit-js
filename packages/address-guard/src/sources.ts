import { resolveBlock, walkLogs, type BlockTag, type Rpc } from "@globalmpc/evm-log-walker";
import { forEachConcurrently } from "./concurrency.js";
import { GuardError } from "./errors.js";
import { addressToTopic, checkedAddress, isAddress, normalizeAddress, type Address, type Hex } from "./hex.js";
import type { BlockRange, History, HistoryEvent, HistorySource, SourceInfo } from "./history.js";
import { decodeTransferLog, isErc20Transfer, TRANSFER_TOPIC, type TransferLog } from "./transfer-log.js";

/**
 * The default endpoint name: its position in the configured list, carrying no part of the URL.
 * See `RpcLogSourceOptions.endpointLabel` for why the host is not used.
 */
export function defaultEndpointLabel(_url: string, index: number): string {
  return `endpoint-${index + 1}`;
}

/** Transactions looked up at once. `evm-log-walker`'s `Rpc` already retries and fails over per call. */
const CONCURRENCY = 8;

/** Blocks read in one pass when the caller names no bound. Roughly a month on a 3-second chain. */
export const DEFAULT_MAX_BLOCKS = 900_000;

/**
 * Transfers involving the owner kept in one fetch before the read is abandoned.
 *
 * Deriving trust needs the owner's transfers in memory, so the only safe bound is a declared one.
 * Reaching it fails with a message naming the fix (a narrower range, or `tokens`) rather than
 * letting the process be killed with no verdict and no explanation.
 */
export const DEFAULT_MAX_EVENTS = 200_000;

export interface RpcLogSourceOptions {
  /**
   * The ERC-20 contracts to read. **Required**, and every one of them must be a token you trust.
   *
   * An unfiltered read is not merely expensive, it is unsound for deriving trust. Any contract can
   * emit `Transfer(owner, anyone, value)` with three topics and no token actually moving. If the
   * owner signs a single transaction to an attacker's contract — a fake airdrop claim, the most
   * ordinary phishing step there is — that contract can emit
   * `Transfer(owner, lookalike, 1000)`, and every condition of the trust rule then holds: the
   * direction is out, a log exists so the transaction succeeded, the value is non-zero, and
   * `txFrom` really is the owner, because the owner really did sign it. The look-alike becomes a
   * trusted recipient.
   *
   * Naming the contracts closes it: a genuine ERC-20 emits `Transfer` only when its own balances
   * move, so a log from a token you trust is evidence of a payment you made.
   */
  tokens: readonly Address[];
  /**
   * Largest span read in one call to `fetch`. When the requested range is wider, the **most
   * recent** `maxBlocks` are read and `SourceInfo.fromBlock` reports the block actually started
   * from, so a truncated history is never mistaken for a complete one.
   */
  maxBlocks?: number;
  /** Last block, inclusive, or a tag resolved once per fetch. Default `"finalized"`. */
  toBlock?: number | BlockTag;
  /** Largest block span per `eth_getLogs` call, passed through to `evm-log-walker`. */
  chunkSize?: number;
  /** Transfers kept before the fetch is abandoned. Default `DEFAULT_MAX_EVENTS`. */
  maxEvents?: number;
  /**
   * How an endpoint is named in `SourceInfo`. Defaults to its position — `endpoint-1`,
   * `endpoint-2` — which carries no part of the URL.
   *
   * The default is positional rather than the host because a host can itself be the credential:
   * some providers issue keyed subdomains, so `https://<key>.rpc.example` would put the key into
   * `source.endpoint` of every successful `--json` result. A position is still provenance — it
   * says which of the endpoints *you configured* an answer came from — and it cannot leak.
   *
   * Pass `redactEndpoint` from `@globalmpc/evm-log-walker` to report scheme, host and port
   * instead, when you know your hosts carry no secret.
   */
  endpointLabel?: (url: string, index: number) => string;
  /**
   * Called after each batch with the walker's checkpoint and which of the two walks it belongs to.
   *
   * For **progress reporting**, not resumption. A fetch runs two filtered walks -- the owner at
   * the `from` topic, then at the `to` topic -- and keeps the decoded transfers only in memory, so
   * restarting a later `fetch` at `nextBlock` would omit the first walk's earlier transfers and
   * every inbound transfer the second walk had not reached. The `phase` is included so a caller
   * can tell the two sequences apart instead of seeing one interleaved counter.
   */
  onCheckpoint?: (checkpoint: {
    nextBlock: number;
    toBlock: number;
    phase: "outgoing" | "incoming";
  }) => void | Promise<void>;
}

/**
 * Reads the owner's ERC-20 transfer history over JSON-RPC, through `evm-log-walker`'s adaptive,
 * checkpointed `eth_getLogs` walk.
 *
 * Two filtered walks are made per fetch — one with the owner at the `from` topic, one at the `to`
 * topic — rather than one unfiltered walk, so the endpoint returns only this owner's transfers.
 *
 * Every transaction that produced a log is then looked up with `eth_getTransactionByHash`, with
 * `CONCURRENCY` in flight, because the log's `from` topic is not proof of who sent it. See
 * `deriveTrustedRecipients`.
 *
 * `success` is `true` for every event this source returns, and that is not an assumption: a
 * reverted transaction's logs are discarded and never appear in `eth_getLogs` output, so a log
 * that came back is a log from a transaction that succeeded. No receipt fetch is needed.
 *
 * Native-coin sends are not read: they produce no log. See the README's limitations.
 */
export function rpcLogSource(rpc: Rpc, options: RpcLogSourceOptions): HistorySource {
  // `options?.` rather than `options.`: the type makes this unreachable, but a JavaScript caller
  // omitting the argument entirely should get the explanation below, not a TypeError.
  if (!Array.isArray(options?.tokens) || options.tokens.length === 0) {
    throw new GuardError(
      "E_INVALID_ARGUMENT",
      "tokens is required and must name at least one trusted ERC-20 contract: any contract can emit " +
        "Transfer(owner, anyone, value) without moving a token, so an unfiltered read cannot establish trust",
    );
  }
  const tokens = options.tokens.map((token) => checkedAddress(token, "token"));
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1) {
    throw new GuardError("E_INVALID_ARGUMENT", `maxBlocks must be a positive integer, got ${String(maxBlocks)}`);
  }

  return {
    async fetch(ownerInput: Address, range?: BlockRange): Promise<History> {
      const owner = checkedAddress(ownerInput, "owner");
      const toBlock = await resolveBlock(rpc, range?.toBlock ?? options.toBlock ?? "finalized");
      const requestedFrom = range?.fromBlock ?? 0;
      if (!Number.isInteger(requestedFrom) || requestedFrom < 0) {
        throw new GuardError("E_INVALID_ARGUMENT", `fromBlock must be a non-negative integer, got ${String(requestedFrom)}`);
      }
      // Clamp to the most recent window: recent sends are the ones a look-alike imitates, and the
      // range actually read is reported, so a clamp is visible rather than silent.
      const fromBlock = Math.max(requestedFrom, toBlock - maxBlocks + 1, 0);
      const label = options.endpointLabel ?? defaultEndpointLabel;
      const endpoints = rpc.urls.map((url, index) => label(url, index));
      // kind is always "rpc" and `coverage` is never set. This source asks a node for a range and
      // reports what came back; it cannot establish that nothing was missed, so it must not claim
      // to. Labelled "indexer", it would make indexerThenRpc's completeness check compare the
      // echoed query range against the requested range -- always equal, so always satisfied.
      const source: SourceInfo = {
        kind: "rpc",
        endpoint: endpoints[0] ?? "",
        endpoints,
        fromBlock,
        toBlock,
      };
      if (fromBlock > toBlock) {
        return { events: [], source };
      }

      const ownerTopic = addressToTopic(owner);
      const collected = new Map<string, TransferLog>();
      const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
      // Infinity and NaN both make `collected.size > maxEvents` permanently false, which turns
      // the advertised memory bound into no bound at all.
      if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
        throw new GuardError(
          "E_INVALID_ARGUMENT",
          `maxEvents must be a positive safe integer, got ${String(maxEvents)}`,
        );
      }
      const phases = [
        { phase: "outgoing", topics: [TRANSFER_TOPIC, ownerTopic] },
        { phase: "incoming", topics: [TRANSFER_TOPIC, null, ownerTopic] },
      ] as const satisfies readonly { phase: "outgoing" | "incoming"; topics: (Hex | null)[] }[];
      for (const { phase, topics } of phases) {
        await walk(rpc, tokens, [...topics], fromBlock, toBlock, options, collected, maxEvents, phase);
      }
      const transfers = ordered(collected);
      const facts = await transactionFacts(rpc, transfers.map((transfer) => transfer.transactionHash));
      const events = transfers.map((transfer) => toEvent(transfer, owner, facts));
      return { events, source };
    },
  };
}

/**
 * Tries `indexer` first and falls back to `rpc`.
 *
 * The indexer's answer is accepted only when it is **complete for the requested range**: it must
 * set `SourceInfo.coverage`, and that coverage must reach at least as far back as
 * `range.fromBlock` and at least as far forward as `range.toBlock`.
 *
 * `coverage` has to be the source's own statement about what it has indexed. A source that merely
 * echoes the range it was queried for -- which is all `rpcLogSource` can do -- cannot satisfy
 * this, and so is never trusted over RPC. That is why the CLI has no `--indexer` flag: a plain
 * JSON-RPC endpoint has no way to say how much of the chain it has seen. An index still catching up is the dangerous case — it can hold a
 * recent inbound dust transfer while missing the owner's older genuine sends, which would leave
 * the trusted set empty and let a look-alike pass as `"new"`. Event count cannot detect that;
 * the covered range can.
 *
 * When no range was requested there is nothing to measure coverage against, so the weaker test
 * applies: an answer with no events at all is treated as no answer, because an empty index and a
 * quiet owner are indistinguishable.
 *
 * `SourceInfo.kind` always names whichever source the events actually came from. When both fail,
 * the indexer's failure is raised with the RPC failure attached as its cause, so neither is lost.
 */
export function indexerThenRpc(indexer: HistorySource, rpc: HistorySource): HistorySource {
  return {
    async fetch(owner: Address, range?: BlockRange): Promise<History> {
      let indexerFailure: unknown;
      try {
        const answer = await indexer.fetch(owner, range);
        const shortfall = coverageShortfall(answer, range);
        if (shortfall === undefined) return answer;
        indexerFailure = new GuardError("E_NO_SOURCE", `the indexer's answer is not usable: ${shortfall}`);
      } catch (error) {
        indexerFailure = error;
      }
      try {
        return await rpc.fetch(owner, range);
      } catch (rpcFailure) {
        throw new GuardError(
          "E_NO_SOURCE",
          "neither the indexer nor the RPC endpoint could supply a history, so no verdict can be given",
          { cause: indexerFailure instanceof Error ? indexerFailure : rpcFailure },
        );
      }
    },
  };
}

/**
 * Why an indexer's answer cannot be trusted as complete, or `undefined` when it can.
 *
 * With a requested range, coverage is measured against it. Without one, the only signal left is
 * whether anything came back at all.
 */
function coverageShortfall(answer: History, range: BlockRange | undefined): string | undefined {
  // Without a requested range there is nothing to measure coverage against, and an event count
  // cannot stand in for one: an index holding a single recent inbound dust transfer, but missing
  // the owner's older genuine sends, would be accepted and leave the trusted set empty — which
  // reports the attacker's look-alike as "new". Refuse the indexer instead and read RPC.
  // Both bounds are required. A range with no end block leaves the upper edge unchecked, and an
  // index that stops before the chain head is exactly the dangerous case: it holds the owner's
  // older transfers, satisfies the lower bound, and silently omits the recent genuine send whose
  // recipient the look-alike is imitating.
  if (range === undefined || range.toBlock === undefined) {
    return "no bounded block range was requested, so the completeness of its answer cannot be established";
  }
  // `coverage` must come from the source's own knowledge of what it has indexed. Reading
  // `fromBlock`/`toBlock` instead would compare the query against itself and pass every time.
  const coverage = answer.source.coverage;
  if (coverage === undefined) {
    return "it reports no indexed coverage, so there is nothing to check its completeness against";
  }
  if (coverage.fromBlock > range.fromBlock) {
    return `it has indexed only from block ${coverage.fromBlock}, and ${range.fromBlock} was requested, so earlier sends may be missing`;
  }
  if (coverage.toBlock < range.toBlock) {
    return `it has indexed only to block ${coverage.toBlock}, and ${range.toBlock} was requested, so recent sends may be missing`;
  }
  // Coverage is what the source has indexed; fromBlock/toBlock are what this answer actually
  // read. A source may have indexed 0-200 and still clamp one fetch to 101-200, which would
  // return a recent poison transfer while omitting a genuine send at block 50.
  if (answer.source.fromBlock > range.fromBlock || answer.source.toBlock < range.toBlock) {
    return `its answer covers only blocks ${answer.source.fromBlock}-${answer.source.toBlock}, and ${range.fromBlock}-${range.toBlock} was requested`;
  }
  // Coverage is what the index claims; an empty result is what it actually returned. An index
  // that is merely configured, or has dropped this owner, claims the range and returns nothing --
  // indistinguishable from a genuinely quiet owner. Verifying with RPC costs one extra read and
  // is the only way to tell them apart, so both conditions must hold.
  if (answer.events.length === 0) {
    return "it covers the range but returned no events, which an empty index and a quiet owner both produce";
  }
  return undefined;
}

/**
 * Walks one topic filter, decoding each batch into `collected` as it arrives.
 *
 * Batches are streamed rather than accumulated, so the raw `Log` objects — topics and data
 * strings, several times the size of a decoded transfer — are only ever held one batch at a time.
 * What stays in memory is the owner's own transfers, which is what deriving trust needs, and that
 * is bounded explicitly by `maxEvents`.
 */
async function walk(
  rpc: Rpc,
  tokens: readonly Address[],
  topics: (Hex | null)[],
  fromBlock: number,
  toBlock: number,
  options: RpcLogSourceOptions,
  collected: Map<string, TransferLog>,
  maxEvents: number,
  phase: "outgoing" | "incoming",
): Promise<void> {
  const report = options.onCheckpoint;
  const walker = walkLogs({
    rpc,
    address: tokens as Hex[],
    topics,
    fromBlock,
    toBlock,
    ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
    // The phase is added here: the walker's own checkpoint cannot know which of the two filtered
    // walks produced it, and a caller seeing one interleaved counter could not either.
    ...(report !== undefined
      ? { onCheckpoint: (checkpoint: { nextBlock: number; toBlock: number }) => report({ ...checkpoint, phase }) }
      : {}),
  });
  for (;;) {
    const step = await walker.next();
    if (step.done) return;
    for (const log of step.value.logs) {
      if (log.removed || !isErc20Transfer(log)) continue;
      const transfer = decodeTransferLog(log);
      // transactionHash plus logIndex is a transfer's only identity; one multisend holds many,
      // and a transfer where the owner is both sender and recipient is read by both walks.
      collected.set(`${transfer.transactionHash}:${transfer.logIndex}`, transfer);
      if (collected.size > maxEvents) {
        await walker.return(undefined as never).catch(() => undefined);
        throw new GuardError(
          "E_TOO_MANY_EVENTS",
          `more than ${maxEvents} transfers involve this owner in blocks ${fromBlock}-${toBlock}. ` +
            "Narrow the range with fromBlock/toBlock, restrict it with tokens, or raise maxEvents.",
        );
      }
    }
  }
}

/** Chain order: block, then log index within the block. */
function ordered(collected: Map<string, TransferLog>): TransferLog[] {
  return [...collected.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/** `keccak256("transfer(address,uint256)")` truncated to its four-byte selector. */
const TRANSFER_SELECTOR = "0xa9059cbb";

/** What one transaction says about itself: who signed it, what it called, and whom it named. */
interface TransactionFacts {
  from: Address;
  to?: Address;
  /** The recipient argument, when the calldata is exactly a plain `transfer(address,uint256)`. */
  transferTo?: Address;
}

/**
 * Reads the recipient argument of a plain `transfer(address,uint256)` call, or `undefined` for
 * any other calldata.
 *
 * The layout is fixed: `0x`, four selector bytes, then a 32-byte word holding the address in its
 * low 20 bytes, then a 32-byte value. Anything longer or shorter is some other function, and a
 * multisend or a spender holding an approval is deliberately not decoded — the point is to
 * recognise only the shape a wallet shows the owner as "send X to Y".
 */
function plainTransferRecipient(input: unknown): Address | undefined {
  if (typeof input !== "string" || input.length !== 138) return undefined;
  if (input.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR) return undefined;
  // The high 12 bytes of the address word must be zero, or this is not an address argument.
  if (!/^0{24}$/.test(input.slice(10, 34))) return undefined;
  const candidate = `0x${input.slice(34, 74)}`;
  return isAddress(candidate) ? normalizeAddress(candidate) : undefined;
}

/**
 * What each transaction says about itself, looked up once per hash with bounded concurrency.
 *
 * `from` alone is not enough to establish an intended recipient, so `to` and the decoded
 * `transfer` argument are read in the same call. See `ownerNamedRecipient`.
 */
async function transactionFacts(rpc: Rpc, hashes: readonly Hex[]): Promise<Map<Hex, TransactionFacts>> {
  const unique = [...new Set(hashes)];
  const facts = new Map<Hex, TransactionFacts>();
  await forEachConcurrently(unique, CONCURRENCY, async (hash) => {
    const tx = await rpc.call<Record<string, unknown> | null>("eth_getTransactionByHash", [hash]);
    if (!tx) {
      throw new GuardError(
        "E_MALFORMED_TX",
        `eth_getTransactionByHash returned nothing for ${hash}: it is not on this chain, or the endpoint does not keep transactions that old`,
      );
    }
    const from = tx["from"];
    if (!isAddress(from)) {
      throw new GuardError("E_MALFORMED_TX", `eth_getTransactionByHash returned no usable from for ${hash}`);
    }
    const to = tx["to"];
    const transferTo = plainTransferRecipient(tx["input"]);
    facts.set(hash, {
      from: normalizeAddress(from),
      ...(isAddress(to) ? { to: normalizeAddress(to) } : {}),
      ...(transferTo !== undefined ? { transferTo } : {}),
    });
  });
  return facts;
}

function toEvent(transfer: TransferLog, owner: Address, facts: Map<Hex, TransactionFacts>): HistoryEvent {
  const outgoing = transfer.from === owner;
  const fact = facts.get(transfer.transactionHash);
  if (fact === undefined) {
    throw new GuardError("E_MALFORMED_TX", `no transaction was resolved for ${transfer.transactionHash}`);
  }
  return {
    owner,
    counterparty: outgoing ? transfer.to : transfer.from,
    direction: outgoing ? "out" : "in",
    valueRaw: transfer.valueRaw,
    // A reverted transaction's logs never reach eth_getLogs, so a log that came back succeeded.
    success: true,
    txFrom: fact.from,
    ...(fact.to !== undefined ? { txTo: fact.to } : {}),
    ...(fact.transferTo !== undefined ? { txTransferTo: fact.transferTo } : {}),
    txHash: transfer.transactionHash,
    blockNumber: BigInt(transfer.blockNumber),
    token: transfer.token,
  };
}
