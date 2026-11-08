// Быстрые варианты времени для кнопок и окна «На…».
import { HOUR, MINUTE, addDaysWall, wallOf, wallToUtc } from "./tz.ts";

export interface QuickOption {
  key: string;
  label: string;
}

export const QUICK_OPTIONS: QuickOption[] = [
  { key: "m15", label: "Через 15 минут" },
  { key: "h1", label: "Через час" },
  { key: "h3", label: "Через 3 часа" },
  { key: "eve", label: "Сегодня вечером, 19:00" },
  { key: "tom", label: "Завтра утром" },
  { key: "mon", label: "В понедельник утром" },
  { key: "wk", label: "Через неделю" },
];

/** Момент для быстрого варианта или null, если ключ неизвестен. `morning` — минуты от полуночи. */
export function quickDue(key: string, now: number, tz: string, morning = 9 * 60): number | null {
  const at = (t: number, minutes: number) => {
    const w = wallOf(t, tz);
    return wallToUtc({ y: w.y, mo: w.mo, d: w.d, h: Math.floor(minutes / 60), mi: minutes % 60 }, tz);
  };
  switch (key) {
    case "m15":
      return now + 15 * MINUTE;
    case "h1":
      return now + HOUR;
    case "h3":
      return now + 3 * HOUR;
    case "eve": {
      const t = at(now, 19 * 60);
      return t > now ? t : at(addDaysWall(now, 1, tz), 19 * 60);
    }
    case "tom":
      return at(addDaysWall(now, 1, tz), morning);
    case "mon": {
      const w = wallOf(now, tz);
      const delta = ((8 - w.wd) % 7) || 7;
      return at(addDaysWall(now, delta, tz), morning);
    }
    case "wk":
      return at(addDaysWall(now, 7, tz), morning);
    default:
      return null;
  }
}
