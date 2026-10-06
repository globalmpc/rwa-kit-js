/**
 * Colors for the rendered page. Every field is a plain CSS color value (hex, `rgb()`, whatever),
 * inlined into the page's own `<style>` as CSS custom properties — no external stylesheet, no
 * runtime dependency, so a fully custom theme costs nothing at read time.
 */
export interface PageTheme {
  background: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  /** The print button and the "still counting today" row. */
  accent: string;
  /** Text color on top of an accent-filled element (the print button). */
  onAccent: string;
  /** Background tint on the paired transactions/active-wallets cells. */
  pairHighlight: string;
  /** Background of a table's header bar (the day-by-day table and every breakdown section). */
  sectionHeaderBg: string;
  /** Text color on top of `sectionHeaderBg`. */
  sectionHeaderText: string;
  /** For the browser's native form controls and scrollbars, not this page's own colors. */
  colorScheme: "light" | "dark";
}

/**
 * The default: a formal document, the same visual language as a due-diligence questionnaire or
 * KYB (know-your-business) form — bordered "Item / Answer" tables under a solid deep-copper header
 * bar on white, meant to be printed and filed, not viewed as a dashboard.
 *
 * Near-black text, mid-grey muted text and light-grey borders on plain white, with a deep copper
 * header bar and accent carrying white text on top, since a dark foreground doesn't read on a
 * copper this deep.
 */
export const DOCUMENT_THEME: PageTheme = {
  background: "#ffffff",
  surface: "#ffffff",
  border: "#cfcfcf",
  text: "#1c1c1c",
  textMuted: "#6b6b6b",
  accent: "#b56a35",
  onAccent: "#ffffff",
  pairHighlight: "#f6e7db",
  sectionHeaderBg: "#b56a35",
  sectionHeaderText: "#ffffff",
  colorScheme: "light",
};

/**
 * A dark palette: near-black background, light text and a gold accent, using flat colors only so
 * the report still reads as precise and printable. Selectable via `--theme dark`;
 * `DOCUMENT_THEME` is the default.
 */
export const DARK_THEME: PageTheme = {
  background: "#04070f",
  surface: "#0f141d",
  border: "rgba(255, 255, 255, 0.12)",
  text: "#eff2f5",
  textMuted: "#899098",
  accent: "#eabc6e",
  onAccent: "#04070f",
  pairHighlight: "#141a26",
  sectionHeaderBg: "#0f141d",
  sectionHeaderText: "#eff2f5",
  colorScheme: "dark",
};

/** A light palette: white and warm off-white surfaces with an orange accent. Selectable via `--theme light`. */
export const LIGHT_THEME: PageTheme = {
  background: "#ffffff",
  surface: "#f7f5f2",
  border: "#e8e2da",
  text: "#1e2329",
  textMuted: "#707a8a",
  accent: "#d77e49",
  onAccent: "#04070f",
  pairHighlight: "#fdf6ec",
  sectionHeaderBg: "#f7f5f2",
  sectionHeaderText: "#1e2329",
  colorScheme: "light",
};

export const DEFAULT_THEME: PageTheme = DOCUMENT_THEME;

/** Fills in anything left out of a partial theme with `DEFAULT_THEME`'s value for that field. */
export function resolveTheme(theme?: Partial<PageTheme>): PageTheme {
  return { ...DEFAULT_THEME, ...theme };
}
