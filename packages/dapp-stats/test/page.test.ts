import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page/render.js";
import { DOCUMENT_THEME, LIGHT_THEME } from "../src/page/theme.js";
import type { Report } from "../src/schema.js";

const SAMPLE: Report = {
  package: "@globalmpc/dapp-stats",
  version: "0.1.0",
  generatedAt: "2026-09-26T08:00:00.000Z",
  chain: { chainId: 56 },
  contract: { address: "0x1111111111111111111111111111111111111111", label: "Example token" },
  days: [
    {
      date: "2026-09-24",
      stage: "final",
      blockRange: { fromBlock: 1000, toBlock: 2000 },
      source: { rpc: "https://bsc-rpc.publicnode.com", methods: ["eth_getLogs", "eth_getTransactionReceipt"] },
      transactions: 42,
      activeWallets: 17,
      holders: 5321,
      holdersAsOfBlock: 2000,
      return7d: 0.42,
      return30d: null,
      gas: { sponsored: 0, userPaid: 42 },
    },
    {
      date: "2026-09-25",
      stage: "provisional",
      blockRange: null,
      source: { rpc: "https://bsc-rpc.publicnode.com", methods: ["eth_getLogs"] },
      transactions: 0,
      activeWallets: 0,
      holders: 5321,
      holdersAsOfBlock: 2000,
      return7d: null,
      return30d: null,
      gas: { sponsored: 0, userPaid: 0 },
    },
  ],
};

describe("renderPage", () => {
  const html = renderPage(SAMPLE);

  it("is self-contained: no external script, stylesheet or fetch reference", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/\bfetch\(/);
    expect(html).not.toMatch(/XMLHttpRequest/);
  });

  it("embeds the full report as data so the page works from a local file", () => {
    const match = html.match(/<script type="application\/json" id="dapp-stats-report">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1] as string)).toEqual(SAMPLE);
  });

  it("keeps a label containing </script> inside the embedded data instead of ending the element", () => {
    const hostile = { ...SAMPLE, contract: { ...SAMPLE.contract, label: "</script><img src=x onerror=alert(1)><!--" } };
    const page = renderPage(hostile);
    const scripts = page.match(/<script type="application\/json" id="dapp-stats-report">([\s\S]*?)<\/script>/);
    expect(page).not.toContain("<img src=x");
    expect(JSON.parse(scripts![1] as string)).toEqual(hostile);
  });

  it("shows every day's source and block range", () => {
    expect(html).toContain("https://bsc-rpc.publicnode.com");
    expect(html).toContain("blocks 1000–2000");
    expect(html).toContain("no activity this day");
  });

  it("groups transactions and active wallets under one heading so they always read together", () => {
    expect(html).toMatch(/<th colspan="2">Activity<\/th>/);
    expect(html).toMatch(/<th>Transactions<\/th>\s*<th>Active wallets<\/th>/);
  });

  it("floors a return rate instead of rounding it up", () => {
    // 0.42 * 100 = 42.0 exactly here; a floor-vs-round difference is exercised in format.test.ts.
    expect(html).toContain("42.0%");
    expect(html).toContain("not enough history yet");
  });

  it("never fabricates a block range for a day with no activity", () => {
    expect(html).not.toMatch(/blocks null/);
  });

  it("offers a print/save-as-PDF button that is hidden when actually printing", () => {
    expect(html).toMatch(/<button[^>]+class="no-print"[^>]+onclick="window\.print\(\)"/);
    expect(html).toMatch(/@media print[\s\S]*?\.no-print\s*\{\s*display:\s*none/);
  });

  it("defaults to the formal deep-copper/white document theme", () => {
    expect(html).toContain(`--accent: ${DOCUMENT_THEME.accent};`);
    expect(html).toContain(`--bg: ${DOCUMENT_THEME.background};`);
    expect(html).toContain(`--section-header-bg: ${DOCUMENT_THEME.sectionHeaderBg};`);
  });

  it("forces a white, print-friendly background in @media print regardless of the screen theme", () => {
    expect(html).toMatch(/@media print[\s\S]*?--bg: #ffffff/);
  });

  it("forces background colors to survive printing/PDF export, which Chrome strips by default", () => {
    expect(html).toMatch(/@media print[\s\S]*?print-color-adjust:\s*exact/);
  });

  it("has no chart: the report is table-only, matching a due-diligence document rather than a dashboard", () => {
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("figcaption");
  });

  it("shows null holders as an honest gap, not a fabricated zero, while other figures on the same row stay visible", () => {
    const withUnknownHolders = renderPage({
      ...SAMPLE,
      days: [{ ...SAMPLE.days[0]!, holders: null, holdersAsOfBlock: null, transactions: 9 }],
    });
    expect(withUnknownHolders).toContain("not available");
    expect(withUnknownHolders).not.toMatch(/as of block null/);
    expect(withUnknownHolders).toContain(">9<"); // transactions still rendered normally
  });

  it("accepts a full built-in alternative theme", () => {
    const light = renderPage(SAMPLE, { theme: LIGHT_THEME });
    expect(light).toContain(`--bg: ${LIGHT_THEME.background};`);
    expect(light).toContain(`--accent: ${LIGHT_THEME.accent};`);
  });

  it("accepts a partial theme override, falling back to the default for anything left out", () => {
    const custom = renderPage(SAMPLE, { theme: { accent: "#ff00ff" } });
    expect(custom).toContain("--accent: #ff00ff;");
    expect(custom).toContain(`--bg: ${DOCUMENT_THEME.background};`); // untouched field keeps the default
  });

  it("includes a report-information and a methodology breakdown, in the due-diligence-style Item/Answer table pattern", () => {
    expect(html).toMatch(/<h2>1\. Report information<\/h2>/);
    expect(html).toMatch(/<h2>2\. Methodology<\/h2>/);
    expect(html).toContain("<th>Item</th><th>Answer</th>");
    expect(html).toContain("<td>Contract address</td><td>0x1111111111111111111111111111111111111111</td>");
    expect(html).toContain("<td>Label</td><td>Example token</td>");
    expect(html).toMatch(/<td>Holders<\/td><td>[^<]*cumulative/);
  });
});
