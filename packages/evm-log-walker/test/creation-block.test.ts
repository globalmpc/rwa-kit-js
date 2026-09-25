import { describe, expect, it } from "vitest";
import { findCreationBlock } from "../src/creation-block.js";
import { RpcError } from "../src/errors.js";
import { createRpc } from "../src/rpc.js";
import { createFakeChain, DEFAULT_ADDRESS } from "./fake-chain.js";

const HEAD = 1_000_000;
const DEPLOY_TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const DEPLOYED = { codeFrom: { [DEFAULT_ADDRESS]: 777_777 }, deployments: { [DEFAULT_ADDRESS]: { blockNumber: 777_777, txHash: DEPLOY_TX } } };

describe("findCreationBlock", () => {
  it("finds the exact creation block with about 2 * log2(age) probes and confirms it by receipt", async () => {
    const chain = createFakeChain({ head: HEAD, ...DEPLOYED });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });
    const probed: number[] = [];

    const result = await findCreationBlock(rpc, DEFAULT_ADDRESS, { onProbe: (block) => probed.push(block) });

    expect(result).toEqual({ address: DEFAULT_ADDRESS, blockNumber: 777_777, verification: "confirmed", probes: probed.length });
    expect(result.probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(HEAD - 777_777)) + 3);
    expect(probed).not.toContain(0);
    expect(chain.callsFor("eth_getTransactionReceipt")).toHaveLength(1);
  });

  it("needs only a few probes for a recent deployment and never touches genesis", async () => {
    const chain = createFakeChain({ head: HEAD, codeFrom: { [DEFAULT_ADDRESS]: HEAD - 10 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });
    const probed: number[] = [];

    const result = await findCreationBlock(rpc, DEFAULT_ADDRESS, { onProbe: (block) => probed.push(block) });

    expect(result.blockNumber).toBe(HEAD - 10);
    expect(result.probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(10)) + 3);
    expect(Math.min(...probed)).toBeGreaterThan(HEAD - 32);
  });

  it("reports unconfirmed when the block holds no direct deployment of the address", async () => {
    const chain = createFakeChain({ head: HEAD, codeFrom: { [DEFAULT_ADDRESS]: 777_777 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const result = await findCreationBlock(rpc, DEFAULT_ADDRESS);

    expect(result).toMatchObject({ blockNumber: 777_777, verification: "unconfirmed" });
  });

  it("reports unconfirmed on an endpoint that answers pruned state with empty code", async () => {
    const chain = createFakeChain({ head: HEAD, archive: false, pruneSilently: true, ...DEPLOYED });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const result = await findCreationBlock(rpc, DEFAULT_ADDRESS);

    // The bisection lands on the edge of the endpoint's state window, not on the deployment.
    expect(result.blockNumber).toBeGreaterThan(777_777);
    expect(result.verification).toBe("unconfirmed");
  });

  it("handles a contract deployed at the head and one present since block 0", async () => {
    const chain = createFakeChain({ head: HEAD, codeFrom: { [DEFAULT_ADDRESS]: HEAD, "0x3333333333333333333333333333333333333333": 0 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    expect((await findCreationBlock(rpc, DEFAULT_ADDRESS)).blockNumber).toBe(HEAD);
    const genesis = await findCreationBlock(rpc, "0x3333333333333333333333333333333333333333");
    expect(genesis).toMatchObject({ blockNumber: 0, verification: "unconfirmed" });
  });

  it("uses narrower bounds when given", async () => {
    const chain = createFakeChain({ head: HEAD, ...DEPLOYED });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const result = await findCreationBlock(rpc, DEFAULT_ADDRESS, { fromBlock: 777_000, toBlock: 778_000 });

    expect(result.blockNumber).toBe(777_777);
    expect(result.probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(1_000)) + 3);
  });

  it("reports E_NO_CODE when the address holds no code at the upper bound", async () => {
    const chain = createFakeChain({ head: HEAD });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(findCreationBlock(rpc, DEFAULT_ADDRESS)).rejects.toMatchObject({ code: "E_NO_CODE" });
  });

  it("reports E_NO_ARCHIVE_STATE when the endpoint has no past state, however it words it", async () => {
    for (const archiveError of ["missing trie node", "header not found", "state at block #2 is pruned"]) {
      const chain = createFakeChain({ head: HEAD, archive: false, archiveError, codeFrom: { [DEFAULT_ADDRESS]: 777_777 } });
      const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

      await expect(findCreationBlock(rpc, DEFAULT_ADDRESS)).rejects.toMatchObject({
        code: "E_NO_ARCHIVE_STATE",
        message: expect.stringContaining(`"${archiveError}"`),
      });
    }
  });

  it("does not mistake a key refusal from an endpoint named archive for missing archive state", async () => {
    const chain = createFakeChain({ head: HEAD, codeFrom: { [DEFAULT_ADDRESS]: 777_777 }, httpRefusals: { eth_getCode: { status: 401, body: "unauthorized" } } });
    const rpc = createRpc({ urls: "https://archive.example/v1/key", fetch: chain.fetch });

    const failure = await findCreationBlock(rpc, DEFAULT_ADDRESS).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcError);
    expect(failure as RpcError).toMatchObject({ code: "E_RPC", httpStatus: 401, url: "https://archive.example" });
  });

  it("rejects a fromBlock that already holds code, and a bad address", async () => {
    const chain = createFakeChain({ head: HEAD, codeFrom: { [DEFAULT_ADDRESS]: 777_777 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(findCreationBlock(rpc, DEFAULT_ADDRESS, { fromBlock: 800_000 })).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
      message: expect.stringContaining("already present"),
    });
    await expect(findCreationBlock(rpc, "0x1234" as never)).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });
});
