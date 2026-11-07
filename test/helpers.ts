import { wallToUtc } from "../src/time/tz.ts";

export const TZ = "Europe/Kyiv";

/** Момент по киевскому времени. */
export const kyiv = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  wallToUtc({ y, mo, d, h, mi }, TZ);

/** Эталон «сейчас» в тестах: суббота, 7 ноября 2026, 12:00 по Киеву. */
export const NOW = kyiv(2026, 11, 7, 12, 0);

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
