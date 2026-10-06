import { floorTo } from "../format.js";
import type { DayRecord, Report } from "../schema.js";
import { resolveTheme, type PageTheme } from "./theme.js";

export interface RenderPageOptions {
  /** Overrides one or more colors from `DEFAULT_THEME` (a formal deep-copper/white document palette). */
  theme?: Partial<PageTheme>;
}

type BreakdownRow = readonly [item: string, answer: string];

/**
 * Renders a `Report` as one self-contained HTML page: no external requests, no CDN, no runtime
 * dependency — every style and script is inlined, and the full report is embedded as JSON in a
 * `<script type="application/json">` block so the page works opened directly from disk (`file://`)
 * or hosted anywhere a static file can be served. Transactions and active wallets are grouped
 * under one "Activity" header so they always read together; every row states its own source and
 * block range next to it. Printing (or "save as PDF") always renders on a plain white background,
 * regardless of the on-screen theme, since a dark page is a poor default for paper.
 */
export function renderPage(report: Report, options?: RenderPageOptions): string {
  const title = report.contract.label ?? report.contract.address;
  const theme = resolveTheme(options?.theme);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} activity</title>
<style>${buildStyle(theme)}</style>
</head>
<body>
<main>
  <div class="header-row">
    <div>
      <h1>${escapeHtml(title)} activity</h1>
      <p class="meta">
        <code>${escapeHtml(report.contract.address)}</code> &middot; chain ${report.chain.chainId} &middot;
        generated ${escapeHtml(report.generatedAt)} &middot; @globalmpc/dapp-stats ${escapeHtml(report.version)}
      </p>
    </div>
    <button type="button" class="no-print" onclick="window.print()">Print / save as PDF</button>
  </div>
  <p class="note">
    Every number below states the RPC endpoint and block range it came from. Recompute any of them
    from the same public chain data yourself &mdash; nothing here comes from a private database.
  </p>
  <table>
    <thead>
      <tr>
        <th rowspan="2">Date</th>
        <th rowspan="2">Stage</th>
        <th colspan="2">Activity</th>
        <th rowspan="2">Holders</th>
        <th rowspan="2">7d return</th>
        <th rowspan="2">30d return</th>
        <th rowspan="2">Gas: sponsored / user-paid</th>
        <th rowspan="2">Source</th>
      </tr>
      <tr>
        <th>Transactions</th>
        <th>Active wallets</th>
      </tr>
    </thead>
    <tbody>${report.days.map(renderDayRow).join("")}</tbody>
  </table>
  ${renderReportInfoSection(report)}
  ${renderMethodologySection()}
</main>
<script type="application/json" id="dapp-stats-report">${embedJson(report)}</script>
</body>
</html>
`;
}

function renderDayRow(day: DayRecord): string {
  const range = day.blockRange ? `blocks ${day.blockRange.fromBlock}–${day.blockRange.toBlock}` : "no activity this day";
  return `<tr class="stage-${day.stage}">
        <td>${escapeHtml(day.date)}</td>
        <td>${day.stage}</td>
        <td class="pair">${day.transactions}</td>
        <td class="pair">${day.activeWallets}</td>
        <td>${formatHolders(day.holders, day.holdersAsOfBlock)}</td>
        <td>${formatRate(day.return7d)}</td>
        <td>${formatRate(day.return30d)}</td>
        <td>${day.gas.sponsored} sponsored / ${day.gas.userPaid} user-paid</td>
        <td class="source">${escapeHtml(day.source.rpc)}<br /><span class="range">${escapeHtml(range)}</span></td>
      </tr>`;
}

/** `null` means the walk didn't start at the contract's true creation block — say so, not "0". */
function formatHolders(holders: number | null, asOfBlock: number | null): string {
  if (holders === null) {
    return `not available <span class="range">walk did not start at creation block</span>`;
  }
  return `${holders} <span class="range">as of block ${asOfBlock}</span>`;
}

/** Never rounds up: a rate this page shows never reads better than what was actually observed. */
function formatRate(value: number | null): string {
  if (value === null) return "not enough history yet";
  return `${floorTo(value * 100, 1).toFixed(1)}%`;
}

/**
 * "Item / Answer" tables, the same visual pattern a due-diligence or KYB (know-your-business)
 * questionnaire uses, so a reviewer gets this report's own metadata and methodology without
 * leaving the document — nothing here is computed from the chain, it's fixed text plus the
 * report's own fields.
 */
function renderReportInfoSection(report: Report): string {
  const rows: BreakdownRow[] = [
    ["Contract address", report.contract.address],
    ...(report.contract.label !== undefined ? ([["Label", report.contract.label]] as BreakdownRow[]) : []),
    ["Chain ID", String(report.chain.chainId)],
    ["Report generated", report.generatedAt],
    ["Package", report.package],
    ["Package version", report.version],
    ["Days published", String(report.days.length)],
  ];
  return renderBreakdownSection("1. Report information", rows);
}

function renderMethodologySection(): string {
  const rows: BreakdownRow[] = [
    ["Transactions", "Count of distinct transaction hashes among that day's Transfer logs."],
    ["Active wallets", "Count of distinct transaction senders (the address that signed the transaction) among that day's transactions."],
    [
      "Holders",
      "Count of addresses with a non-zero balance, replayed from every Transfer since the contract's creation block up to the block named in “as of block” — cumulative, not limited to the published lookback window. Shown as “not available” when the walk is not known to start at the creation block, or from the first day a transfer spends a balance the replay never saw arrive — a wrong count would be worse than an honest gap, and every other figure on this page is unaffected.",
    ],
    [
      "7-day / 30-day return",
      "Fraction of a day's active wallets also active at least once in the preceding 7 (or 30) UTC days, floored rather than rounded. Shown as “not enough history yet” before that many prior days exist in the walked range.",
    ],
    [
      "Gas: sponsored / user-paid",
      "A transaction is “sponsored” when its effective gas price is exactly zero (someone other than the sender paid); otherwise “user-paid”.",
    ],
    [
      "Source & block range",
      "The RPC endpoint and block span each day's transactions, active-wallet and gas figures were computed from. Holders carry the last block their balance replay incorporated instead, since a holder count is cumulative rather than a per-day figure.",
    ],
  ];
  return renderBreakdownSection("2. Methodology", rows);
}

function renderBreakdownSection(heading: string, rows: readonly BreakdownRow[]): string {
  const body = rows.map(([item, answer]) => `<tr><td>${escapeHtml(item)}</td><td>${escapeHtml(answer)}</td></tr>`).join("");
  return `<section class="breakdown">
    <h2>${escapeHtml(heading)}</h2>
    <table class="breakdown-table">
      <thead><tr><th>Item</th><th>Answer</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

/**
 * JSON safe to place inside a `<script>` element: `<` becomes `<`, so a string field such as
 * the label can never close the element early (`</script>`) or open a comment (`<!--`). The
 * escape is valid JSON, so `JSON.parse` on the element's text returns the original report.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Theme colors become CSS custom properties on `:root`, so every rule below reads `var(--...)`
 * once and a caller's `theme` override (or the print media query) only has to redeclare those
 * properties, not restate every rule that uses them.
 */
function buildStyle(theme: PageTheme): string {
  return `
  :root {
    color-scheme: ${theme.colorScheme};
    --bg: ${theme.background};
    --surface: ${theme.surface};
    --border: ${theme.border};
    --text: ${theme.text};
    --text-muted: ${theme.textMuted};
    --accent: ${theme.accent};
    --on-accent: ${theme.onAccent};
    --pair-highlight: ${theme.pairHighlight};
    --section-header-bg: ${theme.sectionHeaderBg};
    --section-header-text: ${theme.sectionHeaderText};
  }
  body { margin: 0; padding: 2rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 960px; margin: 0 auto; }
  .header-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; color: var(--text); }
  h2 { font-size: 1.1rem; margin: 0 0 0.75rem; color: var(--text); }
  .meta { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 1rem; }
  .note { color: var(--text-muted); font-size: 0.9rem; max-width: 70ch; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin-top: 1rem; }
  th, td { border: 1px solid var(--border); padding: 0.4rem 0.5rem; text-align: right; vertical-align: top; }
  th:first-child, td:first-child, td.source { text-align: left; }
  thead th { background: var(--section-header-bg); color: var(--section-header-text); }
  td.pair { background: var(--pair-highlight); }
  tr.stage-provisional { font-style: italic; color: var(--accent); }
  .range { color: var(--text-muted); font-size: 0.75rem; display: block; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  button.no-print {
    font: inherit; font-weight: 600; padding: 0.5rem 1rem; margin: 0; border: 1px solid var(--border);
    border-radius: 6px; background: var(--accent); color: var(--on-accent); cursor: pointer; flex-shrink: 0;
  }
  button.no-print:hover { filter: brightness(1.08); }
  /* "Item / Answer" breakdown sections: same table look, but left-aligned throughout and a
     fixed-width label column, matching a due-diligence questionnaire's layout. */
  section.breakdown { margin-top: 2rem; }
  .breakdown-table th, .breakdown-table td { text-align: left; }
  .breakdown-table td:first-child { font-weight: 600; width: 24%; }
  /* Printing keeps each theme's own colors (the copper header bar prints as a copper header bar) and
     only guards against a dark on-screen theme's background/text, which would waste ink on paper
     and isn't the point of the default document theme, which is already print-ready as-is. */
  @media print {
    /* Chrome (and most browsers) drop background-color by default when printing/exporting to PDF,
       unless told to keep it — without this, the header bars print as plain white with only text
       and borders surviving. */
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
    /* White background with near-black body text and a mid-grey for muted text. */
    :root { --bg: #ffffff; --text: #1c1c1c; --text-muted: #6b6b6b; color-scheme: light; }
    .no-print { display: none; }
    body { padding: 0; }
    tr, section.breakdown { break-inside: avoid; }
    @page { margin: 1.5cm; }
  }
`;
}
