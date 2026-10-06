/**
 * Rounds a fraction down to `decimals` places, never up, so a published rate never reads better
 * than what was actually observed.
 */
export function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

/** Every UTC calendar day from `start` to `end`, inclusive, as `YYYY-MM-DD`, ascending. */
export function utcDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return dates;
}
