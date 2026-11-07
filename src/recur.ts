// Движок повторов: рецепт (JSON) -> следующий момент срабатывания.
// Время считается по стенным часам пояса пользователя, в базе всё в UTC (мс).
import {
  DAY,
  HOUR,
  MINUTE,
  addDaysWall,
  civilDay,
  daysInMonth,
  fromCivilDay,
  wallOf,
  wallToUtc,
} from "./time/tz.ts";

export type Freq = "minutes" | "hours" | "days" | "weeks" | "months" | "years";

export interface Recipe {
  freq: Freq;
  /** шаг: каждые N минут/часов/дней/недель/месяцев/лет, >= 1 */
  interval: number;
  /** стенное время срабатывания для дней и крупнее */
  at?: { h: number; mi: number };
  /** дни недели 1=Пн..7=Вс (для weeks) */
  weekdays?: number[];
  /** число месяца или «последний день» (для months/years) */
  monthDay?: number | "last";
  /** «N-я пятница месяца»: n = 1..4 или -1 (последняя) */
  nth?: { n: number; weekday: number };
  /** месяц 1..12 (для years) */
  month?: number;
  /** начало ряда: первое срабатывание (UTC, мс) */
  anchor: number;
  /** ряд заканчивается не позже этого момента (UTC, мс) */
  until?: number;
}

/** День месяца с учётом короткого месяца: 31-е в апреле -> 30-е, 29-е в феврале -> 28/29. */
export function clampDay(y: number, mo: number, day: number | "last"): number {
  const dim = daysInMonth(y, mo);
  return day === "last" ? dim : Math.min(day, dim);
}

/** Дата n-го (или последнего, n=-1) дня недели в месяце. */
export function nthWeekdayOfMonth(y: number, mo: number, n: number, weekday: number): number {
  if (n > 0) {
    const first = fromCivilDay(civilDay(y, mo, 1));
    const delta = (weekday - first.wd + 7) % 7;
    const day = 1 + delta + (n - 1) * 7;
    return day <= daysInMonth(y, mo) ? day : daysInMonth(y, mo); // 5-я, которой нет -> последняя
  }
  const dim = daysInMonth(y, mo);
  const last = fromCivilDay(civilDay(y, mo, dim));
  return dim - ((last.wd - weekday + 7) % 7);
}

function atOf(r: Recipe, tz: string): { h: number; mi: number } {
  if (r.at) return r.at;
  const w = wallOf(r.anchor, tz);
  return { h: w.h, mi: w.mi };
}

/**
 * Первое срабатывание ряда строго позже `after` (и не раньше начала ряда),
 * либо null, если ряд закончился (`until`).
 */
export function nextOccurrence(r: Recipe, after: number, tz: string): number | null {
  const t = rawNext(r, after, tz);
  if (t === null) return null;
  if (r.until !== undefined && t > r.until) return null;
  return t;
}

function rawNext(r: Recipe, after: number, tz: string): number | null {
  const step = Math.max(1, Math.floor(r.interval));
  if (r.freq === "minutes" || r.freq === "hours") {
    const len = step * (r.freq === "minutes" ? MINUTE : HOUR);
    if (after < r.anchor) return r.anchor;
    return r.anchor + (Math.floor((after - r.anchor) / len) + 1) * len;
  }
  const at = atOf(r, tz);
  const a = wallOf(r.anchor, tz);
  const aDay = civilDay(a.y, a.mo, a.d);
  const aft = wallOf(after, tz);
  const nDay = civilDay(aft.y, aft.mo, aft.d);
  const mk = (y: number, mo: number, d: number) => wallToUtc({ y, mo, d, h: at.h, mi: at.mi }, tz);

  if (r.freq === "days") {
    for (let k = Math.max(0, Math.floor((nDay - aDay) / step) - 1); k < 100000; k++) {
      const c = fromCivilDay(aDay + k * step);
      const t = mk(c.y, c.mo, c.d);
      if (t > after && t >= r.anchor) return t;
    }
    return null;
  }

  if (r.freq === "weeks") {
    const wds = [...new Set(r.weekdays?.length ? r.weekdays : [a.wd])].sort((x, y) => x - y);
    const weekStart = aDay - (a.wd - 1);
    const w0 = Math.floor((nDay - weekStart) / 7 / step) - 1;
    for (let w = Math.max(0, w0); w < 20000; w++) {
      for (const wd of wds) {
        const day = weekStart + w * step * 7 + (wd - 1);
        if (day < aDay) continue;
        const c = fromCivilDay(day);
        const t = mk(c.y, c.mo, c.d);
        if (t > after && t >= r.anchor) return t;
      }
    }
    return null;
  }

  if (r.freq === "months") {
    const base = a.y * 12 + (a.mo - 1);
    const nowIdx = aft.y * 12 + (aft.mo - 1);
    for (let k = Math.max(0, Math.floor((nowIdx - base) / step) - 1); k < 5000; k++) {
      const idx = base + k * step;
      const y = Math.floor(idx / 12);
      const mo = (idx % 12) + 1;
      const day = r.nth
        ? nthWeekdayOfMonth(y, mo, r.nth.n, r.nth.weekday)
        : clampDay(y, mo, r.monthDay ?? a.d);
      const t = mk(y, mo, day);
      if (t > after && t >= r.anchor) return t;
    }
    return null;
  }

  // years
  const month = r.month ?? a.mo;
  for (let k = Math.max(0, Math.floor((aft.y - a.y) / step) - 1); k < 500; k++) {
    const y = a.y + k * step;
    const t = mk(y, month, clampDay(y, month, r.monthDay ?? a.d));
    if (t > after && t >= r.anchor) return t;
  }
  return null;
}

/**
 * Запуск ряда в момент `now`: ставит начало ряда (anchor) так, чтобы шаг считался от первого
 * настоящего срабатывания («каждую вторую пятницу» — ближайшая пятница, потом через 2 недели).
 * Возвращает рецепт и первое срабатывание (или null, если ряд уже закончен).
 */
export function startSeries(
  draft: Omit<Recipe, "anchor">,
  now: number,
  tz: string,
): { recipe: Recipe; first: number } | null {
  if (draft.freq === "minutes" || draft.freq === "hours") {
    const len = Math.max(1, draft.interval) * (draft.freq === "minutes" ? MINUTE : HOUR);
    const first = now + len;
    if (draft.until !== undefined && first > draft.until) return null;
    return { recipe: { ...draft, anchor: first }, first };
  }
  const probe = nextOccurrence({ ...draft, interval: 1, anchor: now }, now, tz);
  if (probe === null) return null;
  const recipe: Recipe = { ...draft, anchor: probe };
  if (draft.until !== undefined && probe > draft.until) return null;
  return { recipe, first: probe };
}

/** Момент «заранее»: за n дней до срока, в то же стенное время. */
export function leadTime(due: number, daysBefore: number, tz: string): number {
  return addDaysWall(due, -daysBefore, tz);
}

export { DAY };
