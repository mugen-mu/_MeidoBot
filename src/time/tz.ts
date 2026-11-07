// Часовые пояса без библиотек: только Intl (в Cloudflare Workers он есть).
// «Стенное время» (wall) = то, что показывают часы в поясе пользователя.

export const DEFAULT_TZ = "Europe/Kyiv";
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface Wall {
  y: number;
  mo: number; // 1..12
  d: number; // 1..31
  h: number;
  mi: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Стенное время в поясе tz для момента ms (UTC). */
export function wallOf(ms: number, tz: string): Wall & { s: number; wd: number } {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = g("year");
  const mo = g("month");
  const d = g("day");
  const wd = ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1; // 1=Пн..7=Вс
  return { y, mo, d, h: g("hour") % 24, mi: g("minute"), s: g("second"), wd };
}

/** Смещение пояса (мс) в момент ms: стенное время минус UTC. */
export function offsetAt(ms: number, tz: string): number {
  const w = wallOf(ms, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Стенное время -> момент UTC.
 * Если такого времени нет (перевод часов вперёд), сдвигаем вперёд (03:30 -> 04:30).
 * Если время бывает дважды (перевод назад), берём первое (раннее).
 */
export function wallToUtc(w: Wall, tz: string): number {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, 0);
  const oBefore = offsetAt(asUtc - DAY, tz);
  const oAfter = offsetAt(asUtc + DAY, tz);
  const cands = [...new Set([asUtc - oBefore, asUtc - oAfter])].filter(
    (c) => offsetAt(c, tz) === asUtc - c,
  );
  if (cands.length === 0) return asUtc - oBefore; // дыра: смещение «до» сдвигает время вперёд
  return Math.min(...cands);
}

/** Целое число дней от 1970-01-01 для календарной даты (без пояса). */
export function civilDay(y: number, mo: number, d: number): number {
  return Math.round(Date.UTC(y, mo - 1, d) / DAY);
}

export function fromCivilDay(n: number): { y: number; mo: number; d: number; wd: number } {
  const dt = new Date(n * DAY);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    wd: ((dt.getUTCDay() + 6) % 7) + 1,
  };
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Начало суток (00:00 по стенному времени) для момента ms. */
export function startOfDay(ms: number, tz: string): number {
  const w = wallOf(ms, tz);
  return wallToUtc({ y: w.y, mo: w.mo, d: w.d, h: 0, mi: 0 }, tz);
}

/** Сдвиг на n календарных дней с тем же стенным временем (переход на летнее время не ломает часы). */
export function addDaysWall(ms: number, n: number, tz: string): number {
  const w = wallOf(ms, tz);
  const c = fromCivilDay(civilDay(w.y, w.mo, w.d) + n);
  return wallToUtc({ y: c.y, mo: c.mo, d: c.d, h: w.h, mi: w.mi }, tz);
}

/** «HH:MM» -> минуты от полуночи или null. */
export function parseHHMM(s: string): number | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function fmtHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Ближайший момент после `after`, когда стенные часы показывают minutesOfDay (0..1439). */
export function nextTimeOfDay(after: number, minutesOfDay: number, tz: string): number {
  const w = wallOf(after, tz);
  const base = civilDay(w.y, w.mo, w.d);
  for (let k = 0; k < 3; k++) {
    const c = fromCivilDay(base + k);
    const t = wallToUtc({ ...c, h: Math.floor(minutesOfDay / 60), mi: minutesOfDay % 60 }, tz);
    if (t > after) return t;
  }
  throw new Error("nextTimeOfDay: недостижимо");
}

/** Дата по часам пояса: ГГГГ-ММ-ДД. */
export function localDate(ms: number, tz: string): string {
  const w = wallOf(ms, tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}
