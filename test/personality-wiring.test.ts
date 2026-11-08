// Настроение в боте: cron (пропуск, реплики), кнопка «Готово», /mood, /reset_mood, /quiet, переключатель в /settings.
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const min = (n: number) => NOW + n * MINUTE;
const STYLE = /\n-# /;
/** реплика горничной: с этапа Х3 лежит в карточке (embed), а не в тексте сообщения */
const card = (b: { embeds?: { description?: string; color?: number }[] }): string => b.embeds?.[0]?.description ?? "";

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

/** cron с фиксированной «случайностью», чтобы фразы были предсказуемыми */
async function run(now: number) {
  const repo = w.repo(100);
  return runCron({
    repo,
    api: countedApi(w.discord, repo.counter),
    now,
    env: {},
    rand: () => 0,
    fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
  });
}

async function call(i: Partial<Interaction>, now = NOW): Promise<any> {
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
    { repo: w.repo(100), api: w.discord, now, env: {}, rand: () => 0, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r;
}
const click = (custom_id: string, now = NOW) => call({ type: 3, data: { custom_id }, message: { id: "m1" } }, now);
const cmd = (name: string, options: { name: string; value: string | number }[] = [], now = NOW) =>
  call({ type: 2, data: { name, type: 1, options } }, now);
const mood = () => w.d1.q<Record<string, any>>("SELECT * FROM mood_state WHERE user_id = ?", OWNER)[0];

beforeEach(async () => {
  w = new World();
  pending = [];
  await w.seed({ today: true, intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

describe("настроение: выключено по умолчанию", () => {
  it("без включения напоминание как раньше: без реплики и без записи в базу", async () => {
    await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const p = w.discord.live(CH_REMIND)[0];
    expect(p.body.content).not.toMatch(STYLE);
    expect(w.d1.q("SELECT 1 FROM mood_state")).toHaveLength(0);
  });

  it("переключатель в /settings включает и выключает; в окне видна строка", async () => {
    expect((await cmd("settings")).data.content).toContain("настроение выкл");
    expect((await click("mn:tg:mo:c")).data.content).toContain("Настроение горничной: вкл");
    expect((await w.settings()).moodOn).toBe(true);
    expect((await click("mn:tg:mo:c")).data.content).toContain("Настроение горничной: выкл");
  });
});

describe("настроение: cron", () => {
  beforeEach(async () => {
    await w.repo().exec([]);
    await click("mn:tg:mo:c");
  });

  it("реплика под напоминанием; суть (название, срок) без изменений и читаема", async () => {
    await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const body = w.discord.live(CH_REMIND)[0].body;
    const c = body.content as string;
    expect(c).toContain("**Оплатить счёт**");
    expect(c).toContain("Срок:");
    expect(c).not.toMatch(STYLE); // реплика не под текстом, а в цветной карточке
    expect(body.embeds).toHaveLength(1);
    expect(typeof body.embeds![0].color).toBe("number");
    expect(card(body).length).toBeGreaterThan(3);
    expect(body.components).toHaveLength(1); // кнопки как были
  });

  it("серьёзная тема и критичное дело — без реплики, но серия считается", async () => {
    await w.create("через 5 минут записаться к врачу");
    await run(min(5));
    expect(w.discord.live(CH_REMIND)[0].body.embeds).toBeUndefined();
  });

  it("дело стало «просрочено» = пропуск: tsundere, серия 1; повтор «просрочено» второй пропуск не создаёт", async () => {
    const { occId } = await w.create("через 5 минут оплатить счёт");
    for (const m of [0, 10, 20, 40, 120]) await run(min(5 + m));
    expect(w.occ(occId).state).toBe("overdue");
    expect(mood().miss_streak).toBe(1);
    expect(mood().current_mood).toBe("tsundere");
    const lastBody = w.discord.live(CH_REMIND)[0].body;
    expect(lastBody.content as string).toContain("висит");
    expect(card(lastBody).length).toBeGreaterThan(3);
    await run(min(5 + 240)); // повтор «просрочено» — тот же пропуск
    expect(mood().miss_streak).toBe(1);
  });

  it("три разных дела просрочены подряд → yandere; журнал событий хранит переходы", async () => {
    for (const t of ["оплатить счёт", "позвонить маме", "купить хлеб"]) await w.create(`через 5 минут ${t}`);
    for (const m of [0, 10, 20, 40, 120]) await run(min(5 + m));
    expect(mood().miss_streak).toBe(3);
    expect(mood().current_mood).toBe("yandere");
    const log = w.d1.q<{ detail: string }>("SELECT detail FROM events WHERE kind = 'mood'");
    expect(log.some((r) => r.detail.includes(">yandere"))).toBe(true);
  });

  it("«Готово» вовремя: серия +1, в ответе реплика; потом «Готово» после просрочки — с опозданием", async () => {
    const a = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const r = await click(`done:${a.occId}`, min(6));
    expect(String(r.data.content).startsWith("Готово: Оплатить счёт")).toBe(true);
    expect(card(r.data).length).toBeGreaterThan(3);
    expect(mood().done_streak).toBe(1);

    const b = await w.create("через 5 минут позвонить", min(10));
    for (const m of [0, 10, 20, 40, 120]) await run(min(15 + m));
    expect(mood().miss_streak).toBe(1);
    await click(`done:${b.occId}`, min(200));
    expect(mood().miss_streak).toBe(0);
    expect(mood().done_streak).toBe(0); // с опозданием серию выполненных вовремя не растит
  });

  it("при сбое отправки пропуск не засчитывается дважды", async () => {
    const { occId } = await w.create("через 5 минут оплатить счёт");
    for (const m of [0, 10, 20, 40]) await run(min(5 + m));
    w.discord.failPost = { status: 500, times: 1 };
    await run(min(125));
    expect(w.occ(occId).state).not.toBe("overdue");
    expect(mood()?.miss_streak ?? 0).toBe(0);
    await run(min(126));
    expect(w.occ(occId).state).toBe("overdue");
    expect(mood().miss_streak).toBe(1);
  });

  it("«спасибо» в канале «бот»: ответ-благодарность, дела не создаётся, симпатия растёт", async () => {
    await run(min(0)); // первый запуск запоминает конец канала
    w.discord.say(CH_BOT, OWNER, "спасибо");
    await run(min(1));
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    expect(mood().affection).toBeGreaterThan(50);
    expect(w.discord.live(CH_BOT).length).toBe(1);
  });
});

describe("настроение: команды", () => {
  it("/mood показывает имя, настроение и серии; работает и при выключенном настроении", async () => {
    const r = await cmd("mood");
    const c = card(r.data);
    expect(c).toContain("Хару");
    expect(c).toContain("Подряд выполнено: 0, пропущено: 0");
    expect(c).toContain("Настроение выключено");
    expect(r.data.flags).toBe(64);
  });

  it("/mood set задаёт настроение, /reset_mood сбрасывает всё", async () => {
    await cmd("mood", [{ name: "set", value: "yandere" }]);
    expect(mood().current_mood).toBe("yandere");
    expect(card((await cmd("mood")).data)).toContain("яндере");
    const r = await cmd("reset_mood");
    expect(r.data.content).toContain("сброшены");
    expect(mood()).toBeUndefined();
    expect(card((await cmd("mood")).data)).toContain("устала");
  });

  it("/quiet: по умолчанию 4 часа «на выходном» (как отъезд), hours:0 возвращает", async () => {
    const r = await cmd("quiet");
    expect(r.data.content).toContain("на выходном");
    expect((await w.settings()).awayUntil).toBe(NOW + 4 * 60 * MINUTE);
    await cmd("quiet", [{ name: "hours", value: 1 }]);
    expect((await w.settings()).awayUntil).toBe(NOW + 60 * MINUTE);
    await cmd("quiet", [{ name: "hours", value: 0 }]);
    expect((await w.settings()).awayUntil).toBe(0);
  });

  it("возвращение после паузы больше суток: одна реплика к ответу и симпатия +2", async () => {
    await click("mn:tg:mo:c");
    await cmd("list"); // создаёт состояние
    const later = NOW + 30 * 60 * MINUTE;
    const r = await cmd("list", [], later);
    expect(String(r.data.content)).toMatch(STYLE);
    expect(mood().affection).toBeGreaterThan(50 - 1); // спад к 50 + 2
    const r2 = await cmd("list", [], later + MINUTE);
    expect(String(r2.data.content)).not.toMatch(STYLE);
  });
});
