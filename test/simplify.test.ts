// Этап «Упрощение» (2026-11-08): три кнопки под напоминанием, «Отложить» в два шага, сводка до 10 строк + «Показать всё»,
// отдельные выключатели сводок, пути из меню к тому, что убрано из списка команд, слово «Висит».
import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/discord/commands.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

type R = { type: number; data?: any };

let w: World;
let pending: Promise<unknown>[];
let seq = 0;
const min = (n: number) => NOW + n * MINUTE;

async function call(i: Partial<Interaction>, now = NOW): Promise<R> {
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
    { repo: w.repo(), api: w.discord, now, env: {}, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r as R;
}
const click = (custom_id: string, values?: string[], now = NOW) => call({ type: 3, data: { custom_id, values }, message: { id: "m1" } }, now);
const ids = (r: R): string[] => (r.data?.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.custom_id as string));
const labels = (r: R): string[] => (r.data?.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.label as string));

beforeEach(async () => {
  w = new World();
  pending = [];
  await w.seed({ intake: true, settings: { weekly: "off" } });
});

describe("команды на виду", () => {
  it("пять команд: remind, list, week, menu, settings (и редкая /setup только для сервера)", () => {
    const slash = COMMANDS.filter((c) => c.type === 1).map((c) => c.name);
    expect(slash).toEqual(["remind", "list", "week", "menu", "settings", "setup"]);
    expect(COMMANDS.find((c) => c.name === "setup")!.description).toMatch(/^Редко/);
  });
});

describe("напоминание: три кнопки", () => {
  it("«Готово», «Отложить», «Изменить»; «Отложить» открывает быстрые варианты, «Назад» возвращает кнопки", async () => {
    const { occId } = await w.create("через 5 минут позвонить маме");
    await w.run(min(5));
    const msgs = w.discord.live(CH_REMIND);
    expect(msgs[0].body.components![0].components.map((c) => (c as { label?: string }).label)).toEqual(["Готово", "Отложить", "Изменить"]);

    const choice = await click(`snzm:${occId}`);
    expect(choice.type).toBe(7);
    expect(choice.data.content).toBeUndefined(); // текст и карточку Discord оставляет как есть
    expect(ids(choice)).toEqual([`snz:${occId}:15`, `snz:${occId}:60`, `snzat:${occId}`, `snzb:${occId}`]);

    const back = await click(`snzb:${occId}`);
    expect(ids(back)).toEqual([`done:${occId}`, `snzm:${occId}`, `edit:${occId}`]);

    const snoozed = await click(`snz:${occId}:15`);
    expect(snoozed.data.content).toContain("Отложено");
    expect(w.occ(occId).state).toBe("snoozed");
  });

  it("в окне «Отложить на…» есть «Через 15 минут»", async () => {
    const { occId } = await w.create("через 5 минут позвонить маме");
    await w.run(min(5));
    const m = await click(`snzat:${occId}`);
    expect(m.type).toBe(9);
    expect(JSON.stringify(m.data)).toContain("Через 15 минут");
    const r = await call(
      { type: 5, data: { custom_id: `m_snz:${occId}`, components: [{ type: 18, component: { type: 3, custom_id: "quick", values: ["m15"] } }, { type: 18, component: { type: 4, custom_id: "text", value: "" } }] } },
      min(6),
    );
    expect(r.data.content).toContain("Отложено");
    expect(w.occ(occId).next_fire_at).toBe(min(6) + 15 * MINUTE);
  });

  it("просрочка в напоминании называется «висит»", async () => {
    await w.create("через 5 минут оплатить счёт");
    for (const m of [5, 15, 25, 45, 125]) await w.run(min(m));
    const last = w.discord.live(CH_REMIND).at(-1)!.body.content!;
    expect(last).toContain("висит");
    expect(last).not.toContain("просрочено");
  });
});

describe("главный экран и «Висит»", () => {
  it("цифры «Сегодня» и «Висит» на кнопках", async () => {
    await w.create("через 5 минут оплатить счёт");
    await w.run(min(125)); // дело «горит» — висит
    const r = await call({ type: 3, data: { custom_id: "mn:home" }, message: { id: "m1" } }, min(125));
    expect(r.data.content).toContain("висит **1**");
    expect(labels(r)).toContain("⏳ Висит 1");
  });

  it("в списке фильтр называется «Висит», состояние дела — «висит»", async () => {
    await w.create("через 5 минут оплатить счёт");
    await w.run(min(125));
    const r = await click("mn:ls:h:0", undefined, min(125));
    expect(r.data.content).toContain("**Висит**");
    expect(r.data.content).toContain("висит");
    expect(r.data.content).not.toContain("просрочено");
  });
});

describe("сводка: до 10 строк и «Показать всё»", () => {
  const day = (h: number, m = 0) => kyiv(2026, 11, 8, h, m);

  it("короткая сводка идёт без кнопки", async () => {
    await w.create("завтра в 10 купить хлеб");
    await w.run(day(8, 0));
    const p = w.discord.posted.find((x) => x.body.content?.includes("Сводка на сегодня"))!;
    expect(p.body.components ?? []).toHaveLength(0);
  });

  it("много дел сегодня: 10 строк, «… и ещё N» и кнопка; кнопка отдаёт полный список «только вам»", async () => {
    for (let i = 1; i <= 14; i++) await w.create(`завтра в ${String(9 + (i % 12)).padStart(2, "0")}:${String(10 + i)} дело ${i}`);
    await w.run(day(8, 0));
    const p = w.discord.posted.find((x) => x.body.content?.includes("Сводка на сегодня"))!;
    expect(p.body.content).toMatch(/… и ещё \d+/);
    expect(p.body.components![0].components.map((c) => c.custom_id)).toEqual(["sumall:morning"]);
    const full = await click("sumall:morning", undefined, day(8, 5));
    expect(full.type).toBe(4);
    expect(full.data.flags).toBe(64);
    expect(full.data.content).not.toMatch(/… и ещё/);
    for (let i = 1; i <= 14; i++) expect(full.data.content).toContain(`Дело ${i}`);
  });
});

describe("настройки: выключатели сводок и «Ещё»", () => {
  it("утро и вечер включаются и выключаются отдельно", async () => {
    expect((await w.settings()).morning).not.toBeNull();
    const off = await click("mn:tg:sa:m");
    expect(off.data.content).toContain("Утренняя сводка: выкл");
    expect((await w.settings()).morning).toBeNull();
    expect((await w.settings()).evening).not.toBeNull(); // вечерняя не тронута
    await click("mn:tg:se:m");
    expect((await w.settings()).evening).toBeNull();
    const on = await click("mn:tg:sa:m");
    expect(on.data.content).toContain("Утренняя сводка: 08:00");
    expect((await w.settings()).morning).toBe(8 * 60);
  });

  it("«Выходной на 4 ч» (бывшая /quiet) включает молчание, «Я в отъезде…» — окно", async () => {
    const r = await click("mn:tg:qh:q");
    expect(r.data.content).toContain("Бот молчит");
    expect((await w.settings()).awayUntil).toBeGreaterThan(NOW);
  });

  it("раздел «Ещё»: слова Хару, сброс настроения с подтверждением, ссылки для телефона", async () => {
    const more = await click("mn:s:a");
    expect(ids(more)).toEqual(expect.arrayContaining(["mn:tg:llm:a", "mn:tg:dm:a", "mn:gl", "mn:rs"]));
    const gl = await click("mn:gl");
    expect(gl.type).toBe(7);
    expect(gl.data.content).toContain("Хару");
    const ask = await click("mn:rs");
    expect(ids(ask)).toEqual(["mn:ry", "mn:s:a"]);
    const done = await click("mn:ry");
    expect(done.data.content).toContain("сброшены");
    const pw = await click("mn:pw");
    expect(pw.type).toBe(4);
    expect(pw.data.flags & 64).toBe(64);
    const sm = await click("mn:s:m");
    expect(ids(sm)).toContain("mn:pw");
  });

  it("главный экран настроек: пять разделов, «Как часто напоминать» вместо «Настойчивости»", async () => {
    const r = await click("mn:st");
    expect(labels(r)).toEqual(["🌙 Тишина", "📰 Сводки и коммуналка", "🔁 Как часто напоминать", "🎭 Характер", "⋯ Ещё", "🏠 Меню"]);
    expect(r.data.content).not.toContain("Настойчивость");
  });
});

describe("подсказки перевода по умолчанию скрыты", () => {
  it("новая установка: hints выкл", async () => {
    expect((await w.settings()).style.hints).toBe(false);
  });
});

describe("панель в канале бота остаётся доступной", () => {
  it("кнопка панели «Ещё» открывает экран «только вам»", async () => {
    const r = await call({ type: 3, data: { custom_id: "pn:more" }, channel_id: CH_BOT, message: { id: "m2" } });
    expect(r.type).toBe(4);
    expect(r.data.flags).toBe(64);
  });
});
