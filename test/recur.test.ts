import { describe, expect, it } from "vitest";
import { type Recipe, leadTime, nextOccurrence, nthWeekdayOfMonth, startSeries } from "../src/recur.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";

const at9 = { h: 9, mi: 0 };

function series(draft: Omit<Recipe, "anchor">, now = NOW) {
  const s = startSeries(draft, now, TZ);
  if (!s) throw new Error("ряд пуст");
  return s;
}

/** Следующие n срабатываний ряда. */
function take(r: Recipe, n: number, after = r.anchor - 1): number[] {
  const out: number[] = [];
  let t = after;
  for (let i = 0; i < n; i++) {
    const nx = nextOccurrence(r, t, TZ);
    if (nx === null) break;
    out.push(nx);
    t = nx;
  }
  return out;
}

describe("повторы: минуты и часы", () => {
  it("каждые 20 минут: первое через 20 минут, шаг ровный", () => {
    const s = series({ freq: "minutes", interval: 20 });
    expect(s.first).toBe(NOW + 20 * MINUTE);
    expect(take(s.recipe, 3)).toEqual([NOW + 20 * MINUTE, NOW + 40 * MINUTE, NOW + 60 * MINUTE]);
  });

  it("до 23:00: после границы ряд заканчивается", () => {
    const until = kyiv(2026, 11, 7, 12, 50);
    const s = series({ freq: "minutes", interval: 20, until });
    expect(take(s.recipe, 10)).toEqual([NOW + 20 * MINUTE, NOW + 40 * MINUTE]);
  });

  it("догонялка: после простоя следующий шаг — первый в будущем, без пачки пропущенных", () => {
    const s = series({ freq: "minutes", interval: 20 });
    const later = NOW + 5 * 3600_000 + 5 * MINUTE;
    expect(nextOccurrence(s.recipe, later, TZ)).toBe(NOW + 5 * 3600_000 + 20 * MINUTE);
  });
});

describe("повторы: дни и недели", () => {
  it("каждый день в 09:00: сказано в 12:00 — первое завтра", () => {
    const s = series({ freq: "days", interval: 1, at: at9 });
    expect(s.first).toBe(kyiv(2026, 11, 8, 9, 0));
  });

  it("каждый день в 18:00: сказано в 12:00 — первое сегодня", () => {
    const s = series({ freq: "days", interval: 1, at: { h: 18, mi: 0 } });
    expect(s.first).toBe(kyiv(2026, 11, 7, 18, 0));
  });

  it("каждые 2 дня, переход на летнее время: стенное время 09:00 не уезжает", () => {
    const now = kyiv(2026, 3, 26, 12, 0);
    const s = series({ freq: "days", interval: 2, at: at9 }, now);
    const list = take(s.recipe, 3);
    // ближайшее 09:00 — 27-го; 29 марта — сутки с переводом часов, стенные 09:00 сохраняются
    expect(list).toEqual([kyiv(2026, 3, 27, 9, 0), kyiv(2026, 3, 29, 9, 0), kyiv(2026, 3, 31, 9, 0)]);
  });

  it("по будням", () => {
    const s = series({ freq: "weeks", interval: 1, weekdays: [1, 2, 3, 4, 5], at: at9 }); // сегодня суббота
    expect(take(s.recipe, 3)).toEqual([kyiv(2026, 11, 9, 9), kyiv(2026, 11, 10, 9), kyiv(2026, 11, 11, 9)]);
  });

  it("каждую вторую пятницу: ближайшая пятница, потом через 14 дней", () => {
    const s = series({ freq: "weeks", interval: 2, weekdays: [5], at: { h: 15, mi: 0 } });
    expect(take(s.recipe, 3)).toEqual([kyiv(2026, 11, 13, 15), kyiv(2026, 11, 27, 15), kyiv(2026, 12, 11, 15)]);
  });

  it("понедельник и среда, раз в 2 недели", () => {
    const s = series({ freq: "weeks", interval: 2, weekdays: [1, 3], at: at9 });
    expect(take(s.recipe, 4)).toEqual([
      kyiv(2026, 11, 9, 9),
      kyiv(2026, 11, 11, 9),
      kyiv(2026, 11, 23, 9),
      kyiv(2026, 11, 25, 9),
    ]);
  });
});

describe("повторы: месяцы и годы", () => {
  it("каждый месяц 20-го: сказано 7-го — первое 20-го этого месяца; сказано 25-го — в следующем", () => {
    const a = series({ freq: "months", interval: 1, monthDay: 20, at: at9 });
    expect(a.first).toBe(kyiv(2026, 11, 20, 9));
    const b = series({ freq: "months", interval: 1, monthDay: 20, at: at9 }, kyiv(2026, 11, 25, 12));
    expect(b.first).toBe(kyiv(2026, 12, 20, 9));
  });

  it("31-го: в коротких месяцах — последний день (30 апр, 28 фев, 29 фев в високосный)", () => {
    const s = series({ freq: "months", interval: 1, monthDay: 31, at: at9 }, kyiv(2027, 1, 15, 12));
    expect(take(s.recipe, 3)).toEqual([kyiv(2027, 1, 31, 9), kyiv(2027, 2, 28, 9), kyiv(2027, 3, 31, 9)]);
    const leap = series({ freq: "months", interval: 1, monthDay: 29, at: at9 }, kyiv(2028, 1, 30, 12));
    expect(take(leap.recipe, 1)).toEqual([kyiv(2028, 2, 29, 9)]);
    const nonLeap = series({ freq: "months", interval: 1, monthDay: 29, at: at9 }, kyiv(2027, 1, 30, 12));
    expect(take(nonLeap.recipe, 1)).toEqual([kyiv(2027, 2, 28, 9)]);
  });

  it("последний день месяца", () => {
    const s = series({ freq: "months", interval: 1, monthDay: "last", at: at9 });
    expect(take(s.recipe, 4)).toEqual([
      kyiv(2026, 11, 30, 9),
      kyiv(2026, 12, 31, 9),
      kyiv(2027, 1, 31, 9),
      kyiv(2027, 2, 28, 9),
    ]);
  });

  it("последняя пятница и вторая пятница месяца", () => {
    expect(nthWeekdayOfMonth(2026, 11, -1, 5)).toBe(27);
    expect(nthWeekdayOfMonth(2026, 11, 2, 5)).toBe(13);
    expect(nthWeekdayOfMonth(2026, 2, -1, 5)).toBe(27);
    const s = series({ freq: "months", interval: 1, nth: { n: 2, weekday: 5 }, at: at9 });
    expect(take(s.recipe, 2)).toEqual([kyiv(2026, 11, 13, 9), kyiv(2026, 12, 11, 9)]);
  });

  it("каждый квартал и каждые полгода", () => {
    const q = series({ freq: "months", interval: 3, monthDay: 15, at: at9 });
    expect(take(q.recipe, 3)).toEqual([kyiv(2026, 11, 15, 9), kyiv(2027, 2, 15, 9), kyiv(2027, 5, 15, 9)]);
  });

  it("каждый год 29 февраля: в невисокосный — 28 февраля", () => {
    const s = series({ freq: "years", interval: 1, month: 2, monthDay: 29, at: at9 }, kyiv(2027, 3, 1, 12));
    expect(take(s.recipe, 2)).toEqual([kyiv(2028, 2, 29, 9), kyiv(2029, 2, 28, 9)]);
  });

  it("ряд с until заканчивается: null", () => {
    const s = series({ freq: "months", interval: 1, monthDay: 20, at: at9, until: kyiv(2027, 1, 1) });
    expect(take(s.recipe, 5)).toEqual([kyiv(2026, 11, 20, 9), kyiv(2026, 12, 20, 9)]);
    expect(startSeries({ freq: "months", interval: 1, monthDay: 20, at: at9, until: NOW }, NOW, TZ)).toBeNull();
  });
});

describe("заранее", () => {
  it("за 7, 3 и 1 день — в то же стенное время, в том числе через смену часов", () => {
    const due = kyiv(2026, 3, 30, 9, 0);
    expect(leadTime(due, 1, TZ)).toBe(kyiv(2026, 3, 29, 9, 0));
    expect(leadTime(due, 3, TZ)).toBe(kyiv(2026, 3, 27, 9, 0));
    expect(leadTime(due, 7, TZ)).toBe(kyiv(2026, 3, 23, 9, 0));
  });
});
