// Запас бесплатных лимитов Cloudflare (src/usage.ts): учёт запусков, предупреждения заранее, итог недели, подсчёт строк базы и нейронов.
import { beforeEach, describe, expect, it } from "vitest";
import { Counter, Repo, setMeta } from "../src/db/repo.ts";
import { countedAi } from "../src/llm.ts";
import {
  type DayUsage,
  GAP_MINUTES,
  LIMITS,
  addRun,
  gapMinutes,
  limitWarnings,
  markWarned,
  neuronsOf,
  parseUsage,
  parseWarned,
  resetTime,
  statusLines,
  utcDay,
  warningMessage,
  weeklyLimitsLine,
} from "../src/usage.ts";
import { DAY_MS } from "../src/usage.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";
import { OWNER, World } from "./world.ts";

const run = (over: Partial<Parameters<typeof addRun>[1]> = {}): Parameters<typeof addRun>[1] => ({
  now: NOW,
  subrequests: 5,
  rowsRead: 100,
  rowsWritten: 3,
  dbBytes: 2 * 1024 * 1024,
  neurons: 0,
  gapMin: 0,
  ...over,
});

const day = (over: Partial<DayUsage> = {}): DayUsage => ({ d: utcDay(NOW), runs: 100, sub: 8, rw: 1000, rr: 100_000, db: 3 * 1024 * 1024, ai: 500, gaps: 0, gap: 0, ...over });

describe("usage: перерывы между запусками", () => {
  it("первый запуск, обычная минута и пара потерянных минут — не перерыв", () => {
    expect(gapMinutes(null, NOW)).toBe(0);
    expect(gapMinutes(NOW - MINUTE, NOW)).toBe(0);
    expect(gapMinutes(NOW - 3 * MINUTE, NOW)).toBe(0);
  });

  it("от GAP_MINUTES потерянных минут — перерыв, считается число потерянных минут", () => {
    expect(gapMinutes(NOW - (GAP_MINUTES + 1) * MINUTE, NOW)).toBe(GAP_MINUTES);
    expect(gapMinutes(NOW - 20 * MINUTE, NOW)).toBe(19);
  });

  it("часы пошли назад — не перерыв", () => {
    expect(gapMinutes(NOW + MINUTE, NOW)).toBe(0);
  });
});

describe("usage: суточные записи", () => {
  it("запуски одних суток складываются: суммы строк, пик подзапросов, последний размер базы", () => {
    let days = addRun([], run({ subrequests: 5, rowsRead: 100, rowsWritten: 3 }));
    days = addRun(days, run({ now: NOW + MINUTE, subrequests: 12, rowsRead: 50, rowsWritten: 2, dbBytes: 3 * 1024 * 1024 }));
    days = addRun(days, run({ now: NOW + 2 * MINUTE, subrequests: 7, rowsRead: 10, rowsWritten: 0, dbBytes: 0 }));
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ runs: 3, sub: 12, rr: 160, rw: 5, db: 3 * 1024 * 1024 });
  });

  it("нейроны округляются, перерывы считаются числом и минутами", () => {
    let days = addRun([], run({ neurons: 6.9, gapMin: 9 }));
    days = addRun(days, run({ now: NOW + MINUTE, neurons: 7.2, gapMin: 11 }));
    expect(days[0]).toMatchObject({ ai: 14, gaps: 2, gap: 20 });
  });

  it("новые сутки UTC — новая запись; хранятся только последние 8", () => {
    let days: DayUsage[] = [];
    for (let i = 0; i < 12; i++) days = addRun(days, run({ now: NOW + i * DAY_MS }));
    expect(days).toHaveLength(8);
    expect(days[0].d).toBe(utcDay(NOW + 4 * DAY_MS));
    expect(days.at(-1)!.d).toBe(utcDay(NOW + 11 * DAY_MS));
  });

  it("parseUsage терпит мусор и чужие поля", () => {
    expect(parseUsage(undefined)).toEqual([]);
    expect(parseUsage("не json")).toEqual([]);
    expect(parseUsage('{"a":1}')).toEqual([]);
    expect(parseUsage('[{"d":"плохо"},{"d":"2026-11-07","runs":"x","sub":-5,"rw":3}]')).toEqual([
      { d: "2026-11-07", runs: 0, sub: 0, rw: 3, rr: 0, db: 0, ai: 0, gaps: 0, gap: 0 },
    ]);
    const days = addRun([], run());
    expect(parseUsage(JSON.stringify(days))).toEqual(days);
  });
});

describe("usage: нейроны модели", () => {
  it("по usage из ответа: расценка Workers AI (9 091 / 27 273 на млн токенов)", () => {
    const n = neuronsOf({ usage: { prompt_tokens: 300, completion_tokens: 100 } });
    expect(n).toBeCloseTo(300 * (9091 / 1e6) + 100 * (27273 / 1e6), 6);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(6);
  });

  it("нет usage — запасное число; мусор не ломает", () => {
    expect(neuronsOf({ response: "привет" })).toBe(7);
    expect(neuronsOf(null)).toBe(7);
    expect(neuronsOf({ usage: { prompt_tokens: "x" } })).toBe(7);
  });

  it("countedAi: успешный ответ добавляет нейроны, сбой — нет, ответ не меняется", async () => {
    const counter = { neurons: 0 };
    const ok = countedAi({ run: async () => ({ response: "ок", usage: { prompt_tokens: 1000, completion_tokens: 0 } }) }, counter)!;
    expect(await ok.run("m", {})).toEqual({ response: "ок", usage: { prompt_tokens: 1000, completion_tokens: 0 } });
    expect(counter.neurons).toBeCloseTo(9.091, 3);
    const bad = countedAi({ run: async () => Promise.reject(new Error("лимит")) }, counter)!;
    await expect(bad.run("m", {})).rejects.toThrow("лимит");
    expect(counter.neurons).toBeCloseTo(9.091, 3);
    expect(countedAi(undefined, counter)).toBeUndefined();
  });
});

describe("usage: предупреждения заранее", () => {
  it("до 70% молчим", () => {
    expect(limitWarnings([day({ sub: 34, rw: 69_000, rr: 3_400_000, db: 340 * 1024 * 1024, ai: 6900 })], NOW, TZ, {})).toEqual([]);
  });

  it("от 70%: предупреждение по каждой тесной метрике, простыми словами и с временем обнуления", () => {
    const ws = limitWarnings([day({ sub: 36, rw: 80_000, ai: 8000 })], NOW, TZ, {});
    expect(ws.map((x) => x.metric)).toEqual(["sub", "rw", "ai"]);
    const text = warningMessage(ws, OWNER)!;
    expect(text).toContain(`<@${OWNER}>`);
    expect(text).toContain("лимитов Cloudflare");
    expect(text).toContain("36 из 50");
    expect(text).toContain("80 000 из 100 000");
    expect(text).toContain(resetTime(NOW, TZ));
    expect(text).toContain("Срочно делать ничего не нужно");
  });

  it("повторно — не раньше чем через 7 суток, но от 90% — каждые сутки", () => {
    const d = day({ rw: 75_000 });
    const w1 = limitWarnings([d], NOW, TZ, {});
    expect(w1).toHaveLength(1);
    const warned = markWarned({}, w1, NOW);
    expect(limitWarnings([d], NOW + 60 * MINUTE, TZ, warned)).toEqual([]);
    const next = { ...d, d: utcDay(NOW + 3 * DAY_MS) };
    expect(limitWarnings([d, next], NOW + 3 * DAY_MS, TZ, warned)).toEqual([]);
    const week = { ...d, d: utcDay(NOW + 7 * DAY_MS) };
    expect(limitWarnings([d, week], NOW + 7 * DAY_MS, TZ, warned)).toHaveLength(1);
    const hot = { ...d, d: utcDay(NOW + DAY_MS), rw: 95_000 };
    expect(limitWarnings([d, hot], NOW + DAY_MS, TZ, warned)).toHaveLength(1);
  });

  it("смотрит только сегодняшние сутки; нет записи за сегодня — молчим", () => {
    expect(limitWarnings([day({ d: utcDay(NOW - DAY_MS), rw: 99_000 })], NOW, TZ, {})).toEqual([]);
    expect(limitWarnings([], NOW, TZ, {})).toEqual([]);
  });

  it("warningMessage без предупреждений — null; parseWarned терпит мусор", () => {
    expect(warningMessage([], OWNER)).toBeNull();
    expect(parseWarned("{")).toEqual({});
    expect(parseWarned('{"rw":"2026-11-07","zzz":"x","sub":5}')).toEqual({ rw: "2026-11-07" });
  });

  it("resetTime: 00:00 UTC по Киеву зимой — 02:00, летом — 03:00", () => {
    expect(resetTime(kyiv(2026, 11, 10, 12, 0), TZ)).toBe("02:00");
    expect(resetTime(kyiv(2026, 7, 10, 12, 0), TZ)).toBe("03:00");
  });
});

describe("usage: итог недели и status", () => {
  it("данных мало (бот только выложен) — строки нет", () => {
    expect(weeklyLimitsLine([])).toBeNull();
    expect(weeklyLimitsLine([day({ runs: 4 })])).toBeNull();
  });

  it("всё с запасом: спокойная строка с самым тесным местом и без перерывов", () => {
    const line = weeklyLimitsLine([day({ rr: 450_000, sub: 2 })])!;
    expect(line).not.toContain("⚠️");
    expect(line).toContain("с большим запасом");
    expect(line).toContain("самое тесное — чтение базы 9%");
    expect(line).toContain("обращения за запуск до 2 из 50");
    expect(line).toContain("Перерывов в работе не было.");
  });

  it("тесно: пометка ⚠️ и перерывы за неделю", () => {
    const line = weeklyLimitsLine([day({ d: utcDay(NOW - DAY_MS), sub: 42, gaps: 1, gap: 12 }), day({ gaps: 1, gap: 8 })])!;
    expect(line.startsWith("⚠️")).toBe(true);
    expect(line).toContain("тесно — обращения за один запуск 42 из 50");
    expect(line).toContain("Перерывов в работе: 2 (около 20 мин).");
  });

  it("status: без данных — подсказка, с данными — сегодня и за неделю", () => {
    expect(statusLines([], NOW)[0]).toContain("данных ещё нет");
    const lines = statusLines([day({ sub: 40 })], NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("сегодня");
    expect(lines[1]).toContain("ТЕСНО");
  });

  it("нормы совпадают с бесплатным планом Cloudflare (страницы документации 2026-11-10)", () => {
    expect(LIMITS).toEqual({ subrequests: 50, rowsWritten: 100_000, rowsRead: 5_000_000, dbBytes: 500 * 1024 * 1024, neurons: 10_000 });
  });
});

describe("usage: Counter и Repo считают строки базы по ответам D1", () => {
  it("note складывает чтения и записи, размер базы — последний ненулевой; пустое и чужое игнорирует", () => {
    const c = new Counter();
    c.note({ rows_read: 10, rows_written: 2, size_after: 1000 });
    c.note({ rows_read: 5, size_after: 0 });
    c.note(undefined);
    c.note({ rows_read: "x" });
    expect(c).toMatchObject({ rowsRead: 15, rowsWritten: 2, dbBytes: 1000 });
  });

  it("Repo.exec, all и first копят meta каждого ответа", async () => {
    const meta = { rows_read: 7, rows_written: 1, size_after: 4096 };
    const stmt = {
      bind: () => stmt,
      all: async () => ({ results: [{ a: 1 }], meta }),
    };
    const db = { prepare: () => stmt, batch: async (xs: unknown[]) => xs.map(() => ({ results: [], meta })) };
    const repo = new Repo(db as never, new Counter());
    await repo.exec([setMeta("a", "1"), setMeta("b", "2")]);
    await repo.all("SELECT 1");
    expect(await repo.first<{ a: number }>("SELECT 1")).toEqual({ a: 1 });
    expect(repo.counter).toMatchObject({ rowsRead: 7 * 4, rowsWritten: 4, dbBytes: 4096, used: 3 });
  });
});

describe("usage: запуск cron пишет запас лимитов", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });

  const usage = () => parseUsage((w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'usage'")[0] ?? {}).value);

  it("каждый запуск добавляется в сутки: число запусков и пик подзапросов", async () => {
    await w.run(NOW);
    await w.run(NOW + MINUTE);
    const d = usage();
    expect(d).toHaveLength(1);
    expect(d[0].runs).toBe(2);
    expect(d[0].sub).toBeGreaterThanOrEqual(2);
    expect(d[0].sub).toBeLessThanOrEqual(50);
    expect(d[0].gaps).toBe(0);
  });

  it("перерыв между запусками попадает в учёт (по прежней отметке «жив»)", async () => {
    await w.run(NOW);
    await w.run(NOW + 20 * MINUTE);
    expect(usage()[0]).toMatchObject({ runs: 2, gaps: 1, gap: 19 });
  });

  it("итог недели получает строку про запас лимитов", async () => {
    const w2 = new World(); // свой мир: итог недели включён по умолчанию (воскресенье 19:00)
    await w2.seed();
    await w2.repo().exec([setMeta("usage", JSON.stringify([day({ d: utcDay(kyiv(2026, 11, 8, 19, 0)), runs: 1440, rr: 450_000 })]))]);
    const r = await w2.run(kyiv(2026, 11, 8, 19, 0));
    expect(r.summaries).toContain("weekly");
    const text = w2.discord.posted.find((p) => p.body.content?.includes("Итоги недели"))!.body.content!;
    expect(text).toContain("Бесплатные лимиты Cloudflare: с большим запасом");
  });

  it("тесно по записям базы — одно предупреждение с упоминанием, повторно в тот же день нет", async () => {
    await w.repo().exec([setMeta("usage", JSON.stringify([day({ d: utcDay(NOW), rw: 85_000 })]))]);
    await w.run(NOW);
    const warn = (): string[] => w.discord.posted.map((p) => p.body.content ?? "").filter((c) => c.includes("лимитов Cloudflare"));
    expect(warn()).toHaveLength(1);
    expect(warn()[0]).toContain(`<@${OWNER}>`);
    expect(warn()[0]).toContain("Записи в базу");
    await w.run(NOW + MINUTE);
    await w.run(NOW + 2 * MINUTE);
    expect(warn()).toHaveLength(1);
    expect(w.d1.q("SELECT 1 FROM events WHERE kind = 'limit_warn'")).toHaveLength(1);
  });

  it("в тихие часы предупреждение ждёт утра, но не теряется", async () => {
    await w.seed({ settings: { quiet_enabled: "1" } }); // по умолчанию тихие часы выключены (23:00–07:00 при включении)
    await w.repo().exec([setMeta("usage", JSON.stringify([day({ d: utcDay(kyiv(2026, 11, 8, 3, 0)), rw: 85_000 })]))]);
    await w.run(kyiv(2026, 11, 8, 3, 0));
    expect(w.discord.posted.some((p) => p.body.content?.includes("лимитов Cloudflare"))).toBe(false);
    await w.run(kyiv(2026, 11, 8, 12, 0));
    expect(w.discord.posted.some((p) => p.body.content?.includes("лимитов Cloudflare"))).toBe(true);
  });
});
