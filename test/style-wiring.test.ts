// Аниме-слой в боте (Х2): /style, /hints, /glossary, настройки, слова копятся в базе, манга-звук отдельной мелкой строкой.
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { countedApi } from "../src/discord/api.ts";
import { COMMANDS } from "../src/discord/commands.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const min = (n: number) => NOW + n * MINUTE;

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

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
const click = (custom_id: string, now = NOW, values?: string[]) => call({ type: 3, data: { custom_id, ...(values ? { values } : {}) }, message: { id: "m1" } }, now);
const cmd = (name: string, options: { name: string; value: string | number | boolean }[] = [], now = NOW) =>
  call({ type: 2, data: { name, type: 1, options } }, now);
const row = () => w.d1.q<Record<string, any>>("SELECT * FROM mood_state WHERE user_id = ?", OWNER)[0];

beforeEach(async () => {
  w = new World();
  pending = [];
  await w.seed({ today: true, intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

describe("команды стиля", () => {
  it("/style, /hints, /glossary убраны из подсказки Discord (всё это — в ⚙ Настройки → Характер)", () => {
    for (const n of ["style", "hints", "glossary"]) expect(COMMANDS.find((c) => c.name === n)).toBeUndefined();
    expect(COMMANDS.length).toBeLessThanOrEqual(100);
  });

  it("/style без параметров: показывает умолчания ТЗ и живые примеры, видно только владельцу", async () => {
    const r = await cmd("style");
    expect(r.data.flags).toBe(64);
    const c = r.data.content as string;
    expect(c).toContain("Уровень: 2 — фансаб-стиль");
    expect(c).toContain("кириллица");
    expect(c).toContain("Так это звучит сейчас:");
    expect(c.split("\n").filter((l) => l.startsWith("• ")).length).toBe(3);
  });

  it("/style level:3 script:latin sfx:off: сохраняется в настройки и сразу видно в ответе", async () => {
    const r = await cmd("style", [
      { name: "level", value: 3 },
      { name: "script", value: "latin" },
      { name: "sfx", value: "off" },
    ]);
    expect(r.data.content).toContain("Изменено: уровень 3, письмо, манга-звуки");
    expect(r.data.content).toContain("Уровень: 3 — полный отаку");
    const s = (await w.settings()).style;
    expect(s).toMatchObject({ level: 3, script: "latin", sfx: "off", hints: false });
    expect((await click("mn:s:c")).data.content).toContain("Стиль речи: уровень 3, письмо: латиница");
  });

  it("/style honorifics:false kaomoji:on", async () => {
    await cmd("style", [{ name: "honorifics", value: false }, { name: "kaomoji", value: "on" }]);
    expect((await w.settings()).style).toMatchObject({ honorifics: false, kaomoji: "on" });
  });

  it("/hints: показать, выключить, включить", async () => {
    expect((await cmd("hints")).data.content).toContain("выключены"); // по умолчанию подсказки скрыты
    expect((await w.settings()).style.hints).toBe(false);
    await cmd("hints", [{ name: "mode", value: "on" }]);
    expect((await w.settings()).style.hints).toBe(true);
    expect((await cmd("hints", [{ name: "mode", value: "off" }])).data.content).toContain("выключены");
    expect((await w.settings()).style.hints).toBe(false);
  });

  it("подсказки перевода включаются кнопкой в Настройки → Характер → Стиль речи", async () => {
    const s = await click("mn:s:s");
    expect(s.data.content).toContain("подсказки перевода: выкл");
    const on = await click("mn:tg:hi:s");
    expect(on.data.content).toContain("подсказки перевода: вкл");
    expect((await w.settings()).style.hints).toBe(true);
  });

  it("уровень и письмо — выпадающими списками, манга-звуки и каомодзи — кнопками по кругу", async () => {
    await click("mn:sv", NOW, ["3"]);
    await click("mn:sw", NOW, ["latin"]);
    await click("mn:tg:sx:s");
    await click("mn:tg:km:s");
    await click("mn:tg:ho:s");
    expect((await w.settings()).style).toMatchObject({ level: 3, script: "latin", sfx: "cyrillic", kaomoji: "on", honorifics: false });
  });

  it("/glossary пуст, пока слов не было", async () => {
    const r = await cmd("glossary");
    expect(r.data.flags).toBe(64);
    expect(r.data.content).toContain("Пока ни одного слова");
  });
});

describe("слой в работе: cron и словарь", () => {
  beforeEach(async () => {
    await click("mn:tg:mo:c");
    // настроение, на которое «образ дня» не накладывается: проводка слоя не зависит от жребия этой даты (иначе «чопорная» дня говорила бы без японских слов)
    await cmd("mood", [{ name: "set", value: "tsundere" }]);
  });

  it("напоминание со стилем: слова копятся в базе, /glossary их показывает, суть по-русски", async () => {
    await w.create("через 5 минут разобрать почту");
    await run(min(5));
    const c = w.discord.live(CH_REMIND)[0].body.content as string;
    expect(c).toContain("**Разобрать почту**");
    expect(c).toContain("Срок:");
    const words = JSON.parse(row().style_data).words as Record<string, { u: number; l: number }>;
    expect(Object.keys(words).length).toBeGreaterThan(0);
    const g = (await cmd("glossary")).data.content as string;
    expect(g).toContain("Слова Хару");
    for (const id of Object.keys(words)) expect(words[id].u).toBe(1);
    expect(g).toMatch(/• \*\*[^*]+\*\* — /u);
  });

  it("манга-звук идёт в той же строке, что и фраза, курсивом (один слой, без мелкой строки «-# »)", async () => {
    await w.create("через 5 минут разобрать почту");
    await run(min(5));
    const content = w.discord.live(CH_REMIND)[0].body.content as string;
    expect(content).not.toMatch(/\n-# /);
    // фраза и манга-звук (rand=0: звук выпал) — в первой строке; звук курсивом; какой именно — зависит от настроения дня (этап 2: усталая в «ворчливый» день звучит как цундере)
    expect(content.split("\n")[0]).toMatch(/\*[ぁ-ヿー…!！?？~]+\*/u);
  });

  it("уровень 0: в напоминании ни японских слов, ни манга-звука, слов в словаре нет", async () => {
    await cmd("style", [{ name: "level", value: 0 }]);
    await w.create("через 5 минут разобрать почту");
    await run(min(5));
    const body = w.discord.live(CH_REMIND)[0].body;
    expect(body.content as string).not.toMatch(/[぀-ヿ]/u);
    expect(body.embeds).toBeUndefined();
    expect((body.content as string).split("\n")[0]).not.toMatch(/\*[^*]+\*(?!\*)/u); // без манга-звука
    expect(body.content as string).toContain("**Разобрать почту**");
    expect(JSON.parse(row().style_data).words).toEqual({});
  });

  it("серьёзная тема: стиль не применяется вовсе", async () => {
    await w.create("через 5 минут записаться к врачу");
    await run(min(5));
    const body = w.discord.live(CH_REMIND)[0].body;
    expect(body.content as string).not.toMatch(/\n-# /);
    expect(body.embeds).toBeUndefined();
    expect(row()?.style_data ?? "{}").not.toContain("u");
  });

  it("/reset_mood сбрасывает и выученные слова", async () => {
    await w.create("через 5 минут разобрать почту");
    await run(min(5));
    expect(Object.keys(JSON.parse(row().style_data).words).length).toBeGreaterThan(0);
    await cmd("reset_mood");
    expect((await cmd("glossary")).data.content).toContain("Пока ни одного слова");
  });
});
