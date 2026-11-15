// Журнал отключений света по датчику (вариант A): промежутки из событий и строка «за сутки» в утренней и вечерней сводках.
import { beforeEach, describe, expect, it } from "vitest";
import { event, setMeta } from "../src/db/repo.ts";
import { buildSpans, outageSummaryLines } from "../src/outages.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { OWNER, World } from "./world.ts";

const TZ = "Europe/Kyiv";
const NOW = kyiv(2026, 11, 15, 8, 5);
const t = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);

describe("журнал отключений: промежутки", () => {
  it("«появился» с ms= — промежуток; метка sched= берётся из «света нет» внутри него; моргание короче минуты не считается", () => {
    const rows = [
      { at: t(15, 3, 12), kind: "power_announced", detail: "sched=no" },
      { at: t(15, 4, 30), kind: "power_on", detail: `ms=${90 * MINUTE}` },
      { at: t(15, 5, 0), kind: "power_on", detail: "ms=30000" },
      { at: t(15, 6, 0), kind: "power_on", detail: null },
    ];
    expect(buildSpans(rows, null, NOW)).toEqual([{ start: t(15, 3, 0), end: t(15, 4, 30), sched: "no" }]);
  });

  it("не объявлено (вернулось раньше, чем бот проснулся) — «unknown»; идущее сейчас — с пометкой ongoing и меткой последнего объявления", () => {
    const rows = [
      { at: t(14, 20, 0), kind: "power_on", detail: `ms=${5 * MINUTE}` },
      { at: t(15, 7, 5), kind: "power_announced", detail: "sched=emergency" },
    ];
    expect(buildSpans(rows, t(15, 7, 0), NOW)).toEqual([
      { start: t(14, 19, 55), end: t(14, 20, 0), sched: "unknown" },
      { start: t(15, 7, 0), end: NOW, sched: "emergency", ongoing: true },
    ]);
    expect(buildSpans([], NOW - 30_000, NOW)).toEqual([]); // идёт меньше минуты — ещё моргание
  });
});

describe("журнал отключений: строка сводки", () => {
  it("нет отключений в окне — строки нет", () => {
    expect(outageSummaryLines([], NOW - 24 * HOUR, NOW, TZ, "за сутки")).toEqual([]);
    expect(outageSummaryLines([{ start: NOW - 3 * 24 * HOUR, end: NOW - 3 * 24 * HOUR + HOUR, sched: "no" }], NOW - 24 * HOUR, NOW, TZ, "за сутки")).toEqual([]);
  });

  it("итог, «вне графика», по графику и «вчера»; идущее — «с … (идёт)»", () => {
    const spans = [
      { start: t(14, 22, 10), end: t(14, 23, 40), sched: "no" },
      { start: t(15, 3, 10), end: t(15, 4, 45), sched: "yes" },
      { start: t(15, 7, 40), end: NOW, sched: "emergency", ongoing: true },
    ];
    expect(outageSummaryLines(spans, NOW - 24 * HOUR, NOW, TZ, "за сутки")).toEqual([
      "Свет по датчику: за сутки не было 3 ч 30 мин (вне графика 1 ч 55 мин): вчера 22:10–23:40 вне графика, 03:10–04:45 по графику, с 07:40 (идёт) вне графика.",
    ]);
  });

  it("окно обрезает промежуток, начавшийся раньше; больше пяти — «ещё N раньше»", () => {
    const edge = [{ start: t(14, 6, 0), end: t(14, 9, 0), sched: "unknown" }];
    expect(outageSummaryLines(edge, t(14, 8, 0), NOW, TZ, "за сутки")).toEqual(["Свет по датчику: за сутки не было 1 ч: вчера 08:00–09:00."]);
    const seven = Array.from({ length: 7 }, (_, i) => ({ start: t(15, i, 0), end: t(15, i, 20), sched: "no" }));
    const [line] = outageSummaryLines(seven, t(15, 0, 0), NOW, TZ, "сегодня");
    expect(line).toContain("сегодня не было 2 ч 20 мин");
    expect(line).toContain("ещё 2 раньше");
    expect(line.match(/вне графика/g)).toHaveLength(6); // пять в списке и одна в итоге
  });
});

describe("журнал отключений: сводки в cron", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: { summary_morning: "08:00", summary_evening: "20:00", weekly: "off" } });
    await w.repo().exec([
      setMeta("power_key", "k"),
      event(t(15, 3, 0), "power_off"),
      event(t(15, 3, 2), "power_announced", null, "sched=no"),
      event(t(15, 4, 30), "power_on", null, `ms=${90 * MINUTE}`),
    ]);
  });
  const summary = (kind: string) => w.discord.posted.find((p) => p.body.content?.includes(kind))?.body.content ?? "";

  it("утренняя сводка: «за сутки» в блоке «Коммуналка»", async () => {
    await w.run(NOW);
    const text = summary("Сводка на сегодня");
    expect(text).toContain("🏠 Коммуналка:");
    expect(text).toContain("Свет по датчику: за сутки не было 1 ч 30 мин (вне графика 1 ч 30 мин): 03:00–04:30 вне графика.");
  });

  it("вечерняя сводка: только сегодняшнее, «сегодня»; в сводке без отключений строки нет", async () => {
    await w.run(t(15, 20, 5));
    expect(summary("Вечерняя сводка")).toContain("Свет по датчику: сегодня не было 1 ч 30 мин");
    const quiet = new World();
    await quiet.seed({ settings: { summary_morning: "08:00", summary_evening: "off", weekly: "off" } });
    await quiet.repo().exec([setMeta("power_key", "k")]);
    await quiet.run(NOW);
    expect(quiet.discord.posted.some((p) => p.body.content?.includes("Свет по датчику"))).toBe(false);
  });

  it("датчик не настроен (нет ключа) — строки нет и в базу за ней не ходим", async () => {
    await w.repo().exec([{ sql: "DELETE FROM meta WHERE key = 'power_key'", params: [] }]);
    await w.run(NOW);
    expect(summary("Сводка на сегодня")).not.toContain("Свет по датчику");
    expect(OWNER).toBeTruthy();
  });
});
