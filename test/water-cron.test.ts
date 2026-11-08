// Вода в cron: раз в час лента, сразу сообщение с упоминанием, накануне вечером и за 2 часа, очередь при сбое Discord, сбой источника, «Коммуналка» в сводке.
import { beforeEach, describe, expect, it } from "vitest";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";
import { TEXTS, post } from "./waterFixtures.ts";

// NOW = 7 ноября 12:00 по Киеву. Отключение 8 ноября 22:00 — 9 ноября 22:00, напор к 10 ноября 12:00.
const TEXT = TEXTS.nov2.replace("4.11.2026", "8.11.2026").replace("6.11.2026", "9.11.2026").replace("07. 11.2026", "10. 11.2026");
const feed = (...extra: Record<string, unknown>[]) => [post("Аварійно-відновлювальні роботи на правобережжі", TEXT, "2026-11-07T09:00:00", { id: 7001 }), ...extra];

let w: World;
beforeEach(async () => {
  w = new World();
  w.water = feed();
  await w.seed({ settings: { water: "чечелівськ", summary_morning: "off", summary_evening: "20:00", weekly: "off" } });
});
const water = () => w.discord.posted.filter((p) => p.body.content?.includes("💧"));

describe("cron: вода", () => {
  it("слова не заданы — в сеть не ходим", async () => {
    await w.seed({ settings: { water: "off" } });
    await w.run(NOW);
    expect(w.waterFetches).toBe(0);
  });

  it("первая проверка: одно сообщение с упоминанием, ссылка и время; дальше раз в час, повтора нет", async () => {
    await w.run(NOW);
    expect(w.waterFetches).toBe(1);
    const m = water();
    expect(m).toHaveLength(1);
    expect(m[0].channel).toBe(CH_REMIND);
    expect(m[0].body.content).toContain(`<@${OWNER}>`);
    expect(m[0].body.content).toContain("Воды не будет");
    expect(m[0].body.content).toContain("Начало: завтра, 22:00");
    expect(m[0].body.allowed_mentions).toEqual({ users: [OWNER] });
    await w.run(NOW + MINUTE);
    await w.run(NOW + 30 * MINUTE);
    expect(w.waterFetches).toBe(1);
    await w.run(NOW + 61 * MINUTE);
    expect(w.waterFetches).toBe(2);
    expect(water()).toHaveLength(1);
  });

  it("накануне вечером (по времени вечерней сводки) и за 2 часа — по одному разу, второе с упоминанием; в сводке блок «Коммуналка»", async () => {
    await w.run(NOW);
    await w.run(kyiv(2026, 11, 7, 20, 5));
    const eve = water().filter((p) => p.body.content!.includes("Завтра вода"));
    expect(eve).toHaveLength(1);
    expect(eve[0].body.allowed_mentions).toEqual({ parse: [] });
    const summary = w.discord.posted.find((p) => p.body.content?.includes("Вечерняя сводка"));
    expect(summary?.body.content).toContain("🏠 Коммуналка:");
    expect(summary?.body.content).toContain("Вода:");
    await w.run(kyiv(2026, 11, 7, 20, 30));
    expect(water().filter((p) => p.body.content!.includes("Завтра вода"))).toHaveLength(1);
    await w.run(kyiv(2026, 11, 8, 20, 10));
    const soon = water().filter((p) => p.body.content!.includes("Через 2 часа"));
    expect(soon).toHaveLength(1);
    expect(soon[0].body.content).toContain(`<@${OWNER}>`);
    await w.run(kyiv(2026, 11, 8, 20, 20));
    expect(water().filter((p) => p.body.content!.includes("Через 2 часа"))).toHaveLength(1);
  });

  it("Discord не принял сообщение — оно ждёт в очереди и уходит в следующую минуту ровно один раз", async () => {
    w.discord.failPost = { status: 500, times: 1 };
    await w.run(NOW);
    expect(water()).toHaveLength(0);
    await w.run(NOW + MINUTE);
    expect(water()).toHaveLength(1);
    await w.run(NOW + 2 * MINUTE);
    expect(water()).toHaveLength(1);
  });

  it("сайт не отвечает: повтор через 15 минут, после третьей неудачи — одно сообщение «не могу прочитать»", async () => {
    w.water = null;
    await w.run(NOW);
    await w.run(NOW + 5 * MINUTE);
    expect(w.waterFetches).toBe(1);
    await w.run(NOW + 15 * MINUTE);
    expect(water()).toHaveLength(0);
    await w.run(NOW + 30 * MINUTE);
    expect(water()).toHaveLength(1);
    expect(water()[0].body.content).toContain("Не могу прочитать");
    expect(water()[0].body.allowed_mentions).toEqual({ parse: [] });
    await w.run(NOW + 45 * MINUTE);
    await w.run(NOW + 60 * MINUTE);
    expect(water()).toHaveLength(1);
  });

  it("отмена после объявления — одно сообщение; потом тишина", async () => {
    await w.run(NOW);
    w.water = feed(post("Скасування робіт на правобережжі", TEXTS.cancel, "2026-11-07T11:30:00", { id: 7002 }));
    await w.run(NOW + 61 * MINUTE);
    expect(water().map((p) => p.body.content!.slice(0, 60))).toHaveLength(2);
    expect(water()[1].body.content).toContain("отменил");
    await w.run(kyiv(2026, 11, 8, 20, 10));
    expect(water().filter((p) => p.body.content!.includes("Через 2 часа"))).toHaveLength(0);
  });

  it("я в отъезде: напоминания по времени не шлём, срочное объявление приходит", async () => {
    await w.seed({ settings: { away_until: String(kyiv(2026, 11, 20)) } });
    await w.run(NOW);
    expect(water()).toHaveLength(1);
    await w.run(kyiv(2026, 11, 8, 20, 10));
    expect(water()).toHaveLength(1);
  });
});
