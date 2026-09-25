import { describe, expect, it } from "vitest";
import { probeRpc } from "../src/probe.js";
import { createRpc } from "../src/rpc.js";
import { createFakeChain, DEFAULT_ADDRESS, TRANSFER_TOPIC } from "./fake-chain.js";

describe("probeRpc", () => {
  it("reports the largest answered span, the finalized tag and archive state", async () => {
    const chain = createFakeChain({ head: 100_000, maxLogSpan: 5_000, archive: true });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const capabilities = await probeRpc(rpc, { address: DEFAULT_ADDRESS, topics: [TRANSFER_TOPIC] });

    expect(capabilities).toEqual({
      chainId: 56,
      head: 100_000,
      finalizedTag: true,
      maxLogSpan: 5_000,
      archiveState: true,
    });
    // 50 000 and 10 000 refused, 5 000 answered, then no smaller span is tried.
    expect(chain.callsFor("eth_getLogs")).toHaveLength(3);
  });

  it("reports null when the endpoint never serves log history", async () => {
    const chain = createFakeChain({ head: 100_000, maxLogSpan: null });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const capabilities = await probeRpc(rpc);

    expect(capabilities.maxLogSpan).toBeNull();
    expect(chain.callsFor("eth_getLogs")).toHaveLength(6);
  });

  it("counts an HTTP refusal as a span that is not served", async () => {
    const chain = createFakeChain({ head: 100_000, maxLogSpan: 50_000, httpRefusal: { aboveSpan: 1_000, status: 403 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    expect((await probeRpc(rpc)).maxLogSpan).toBe(1_000);
  });

  it("reports a missing finalized tag and missing archive state", async () => {
    const chain = createFakeChain({ head: 100_000, archive: false, finalizedTag: false });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const capabilities = await probeRpc(rpc);

    expect(capabilities.finalizedTag).toBe(false);
    expect(capabilities.archiveState).toBe(false);
  });

  it("never probes below block 0 on a short chain", async () => {
    const chain = createFakeChain({ head: 50, maxLogSpan: 100_000 });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const capabilities = await probeRpc(rpc, { spans: [1_000] });

    expect(capabilities.maxLogSpan).toBe(51);
  });

  it("sends one call for all spans wider than the chain instead of repeating it", async () => {
    const chain = createFakeChain({ head: 50, maxLogSpan: null });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const capabilities = await probeRpc(rpc);

    expect(capabilities.maxLogSpan).toBeNull();
    // Blocks 0..50 once (for every span above 51), then 50..50 for the span of 1.
    expect(chain.callsFor("eth_getLogs").map((call) => (call.params[0] as { fromBlock: string }).fromBlock)).toEqual(["0x0", "0x32"]);
  });

  it("tries the largest span first whatever order the spans are given in", async () => {
    const chain = createFakeChain({ head: 100_000, maxLogSpan: 5_000 });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    const capabilities = await probeRpc(rpc, { spans: [1, 100, 5_000, 1_000] });

    expect(capabilities.maxLogSpan).toBe(5_000);
    expect(chain.callsFor("eth_getLogs")).toHaveLength(1);
  });

  it("reports a malformed answer from the endpoint as E_RPC, not as a bad argument", async () => {
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "latest" }), { status: 200 });
    };
    const rpc = createRpc({ urls: "http://a", fetch: fetchImpl });

    await expect(probeRpc(rpc)).rejects.toMatchObject({ code: "E_RPC", message: expect.stringContaining("eth_chainId") });
  });

  it("rejects a span that is not a positive integer", async () => {
    const chain = createFakeChain();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(probeRpc(rpc, { spans: [0] })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });

  it("rejects a malformed address or topic before any call, instead of reporting it as a limit", async () => {
    const chain = createFakeChain();
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch });

    await expect(probeRpc(rpc, { address: "0x1234" })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(probeRpc(rpc, { topics: ["0xabc"] })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    expect(chain.calls).toHaveLength(0);
  });

  it("surfaces a transport failure instead of reporting a capability", async () => {
    const chain = createFakeChain({ transportFailures: { "http://a": 99 } });
    const rpc = createRpc({ urls: "http://a", fetch: chain.fetch, retries: 0, backoffMs: 1 });

    await expect(probeRpc(rpc)).rejects.toMatchObject({ code: "E_RPC" });
  });
});
