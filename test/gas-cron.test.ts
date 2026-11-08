// Газ в cron: раз в час главная газовиков, файл только когда ссылка новая, «нашли», накануне вечером и утром в день работ, сбои.
import { beforeEach, describe, expect, it } from "vitest";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";
import { GAS_HOME, GAS_PARAS, makeDocx } from "./gasFixtures.ts";

const NOW = kyiv(2026, 11, 1, 12, 0);
let w: World;
beforeEach(async () => {
  w = new World();
  w.gasHome = GAS_HOME;
  w.gasDocx = makeDocx(GAS_PARAS);
  await w.seed({ settings: { gas: "героїв 35", summary_morning: "off", summary_evening: "off", weekly: "off" } });
});
const gas = () => w.discord.posted.filter((p) => p.body.content?.includes("🔥"));

describe("cron: газ", () => {
  it("слова не заданы — в сеть не ходим", async () => {
    await w.seed({ settings: { gas: "off" } });
    await w.run(NOW);
    expect(w.gasFetches).toBe(0);
  });

  it("первая проверка: главная + файл, одно сообщение с упоминанием; через минуту и через полчаса — ни запросов, ни повторов; через час — только главная", async () => {
    await w.run(NOW);
    expect(w.gasFetches).toBe(2);
    expect(gas()).toHaveLength(1);
    expect(gas()[0].channel).toBe(CH_REMIND);
    expect(gas()[0].body.content).toContain(`<@${OWNER}>`);
    expect(gas()[0].body.content).toContain("Героїв, 35");
    await w.run(NOW + MINUTE);
    await w.run(NOW + 30 * MINUTE);
    expect(w.gasFetches).toBe(2);
    await w.run(NOW + 61 * MINUTE);
    expect(w.gasFetches).toBe(3);
    expect(gas()).toHaveLength(1);
  });

  it("накануне вечером и утром в день работ — по одному разу; в вечерней сводке «Коммуналка»", async () => {
    await w.seed({ settings: { summary_evening: "20:00" } });
    await w.run(NOW);
    await w.run(kyiv(2026, 11, 9, 20, 5));
    const eve = gas().filter((p) => p.body.content!.includes("Завтра газ"));
    expect(eve).toHaveLength(1);
    expect(eve[0].body.allowed_mentions).toEqual({ parse: [] });
    const summary = w.discord.posted.find((p) => p.body.content?.includes("Вечерняя сводка"));
    expect(summary?.body.content).toContain("🏠 Коммуналка:");
    expect(summary?.body.content).toContain("Газ завтра");
    await w.run(kyiv(2026, 11, 9, 21, 0));
    await w.run(kyiv(2026, 11, 10, 8, 5));
    const morn = gas().filter((p) => p.body.content!.includes("Сегодня газ"));
    expect(morn).toHaveLength(1);
    expect(morn[0].body.content).toContain(`<@${OWNER}>`);
    await w.run(kyiv(2026, 11, 10, 9, 0));
    expect(gas().filter((p) => p.body.content!.includes("Сегодня газ"))).toHaveLength(1);
  });

  it("Discord не принял сообщение — оно ждёт в очереди и уходит один раз", async () => {
    w.discord.failPost = { status: 500, times: 1 };
    await w.run(NOW);
    expect(gas()).toHaveLength(0);
    await w.run(NOW + MINUTE);
    expect(gas()).toHaveLength(1);
    await w.run(NOW + 2 * MINUTE);
    expect(gas()).toHaveLength(1);
  });

  it("сайт не отвечает: повтор через 15 минут, после третьей неудачи — одно сообщение", async () => {
    w.gasHome = null;
    await w.run(NOW);
    await w.run(NOW + 5 * MINUTE);
    expect(w.gasFetches).toBe(1);
    await w.run(NOW + 15 * MINUTE);
    await w.run(NOW + 30 * MINUTE);
    expect(gas()).toHaveLength(1);
    expect(gas()[0].body.content).toContain("Не могу прочитать график газа");
    await w.run(NOW + 45 * MINUTE);
    expect(gas()).toHaveLength(1);
  });

  it("файл повреждён (не zip) — это сбой источника, а не «нет отключений»", async () => {
    w.gasDocx = new TextEncoder().encode("<html>ошибка</html>");
    await w.run(NOW);
    await w.run(NOW + 15 * MINUTE);
    await w.run(NOW + 30 * MINUTE);
    expect(gas()[0].body.content).toContain("Не могу прочитать");
  });

  it("моего адреса в графике нет — тишина", async () => {
    await w.seed({ settings: { gas: "сугака 99" } });
    await w.run(NOW);
    expect(gas()).toHaveLength(0);
  });
});
