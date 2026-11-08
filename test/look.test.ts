// Х3 «внешний вид»: цвет карточки, спрайты, реакции, «кино-моменты», ответы на слова хозяина. Чистая логика + проводка.
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { op } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { STYLE_DEFAULT, emptyStyleState, parseStyleState } from "../src/personality/animeStyle.ts";
import { CINEMA, MONOLOGUES, cinemaMoment } from "../src/personality/cinema.ts";
import { SFX } from "../src/personality/lexicon.ts";
import { LOOK, MOOD_COLOR, MOOD_REACTIONS, embedText, maidEmbed, pickReaction, spriteUrl, wantSprite } from "../src/personality/look.ts";
import { MOODS } from "../src/personality/moodEngine.ts";
import { WORD_REPLIES, detectUserWord, wordReply } from "../src/personality/userWords.ts";
import { MINUTE } from "../src/time/tz.ts";
import { existsSync, statSync } from "node:fs";
import { NOW } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const ORIGIN = "https://meido.example.workers.dev";
const min = (n: number) => NOW + n * MINUTE;

describe("карточка: цвет, спрайт, текст", () => {
  it("у шести настроений шесть разных цветов, по ТЗ (tired серо-синий, tsundere оранжевый, yandere тёмно-красный, proud розовый)", () => {
    expect(new Set(Object.values(MOOD_COLOR)).size).toBe(6);
    expect(MOOD_COLOR.tsundere).toBe(0xf28c28);
    expect(MOOD_COLOR.yandere).toBe(0x8b0000);
    const r = (c: number) => (c >> 16) & 255;
    const b = (c: number) => c & 255;
    expect(b(MOOD_COLOR.tired)).toBeGreaterThan(r(MOOD_COLOR.tired)); // синего больше красного
    expect(r(MOOD_COLOR.proud)).toBeGreaterThan(200); // розовый
  });

  it("адрес спрайта только для https; без него в карточке только цвет", () => {
    expect(spriteUrl(ORIGIN, "tired")).toBe(`${ORIGIN}/sprites/tired.jpg`);
    expect(spriteUrl(`${ORIGIN}/`, "sleepy")).toBe(`${ORIGIN}/sprites/sleepy.jpg`);
    expect(spriteUrl(null, "tired")).toBeNull();
    expect(spriteUrl("http://localhost:8787", "tired")).toBeNull();
    expect(maidEmbed({ mood: "proud", text: "ура", origin: ORIGIN, sprite: true }).thumbnail?.url).toBe(`${ORIGIN}/sprites/proud.jpg`);
    expect(maidEmbed({ mood: "proud", text: "ура", origin: ORIGIN, sprite: false }).thumbnail).toBeUndefined();
    expect(maidEmbed({ mood: "proud", text: "ура", origin: null, sprite: true }).thumbnail).toBeUndefined();
    expect(maidEmbed({ mood: "proud", text: "ура" }).color).toBe(MOOD_COLOR.proud);
  });

  it("файлы спрайтов на месте для всех настроений: маленькие jpg", () => {
    for (const m of MODS) {
      const f = `public/sprites/${m}.jpg`;
      expect(existsSync(f), f).toBe(true);
      expect(statSync(f).size).toBeLessThan(40_000);
    }
    for (const m of MODS) expect(existsSync(`assets/sprites/${m}.jpg`)).toBe(true); // оригиналы целы
  });

  it("манга-звук в карточке — курсивом, мелкий текст «-# » теряет метку, длина ограничена", () => {
    expect(embedText(`Фраза.\n${SFX.sigh.kana}`)).toBe("Фраза.\n*ハァ…*");
    expect(embedText(`Фраза.\n${SFX.heart.cyrillic}`)).toBe("Фраза.\n*доки-доки…*");
    expect(embedText("-# шёпот")).toBe("шёпот");
    expect(embedText("я".repeat(9000)).length).toBeLessThanOrEqual(4000);
  });

  it("спрайт — редко (по шансу), по требованию — всегда; реакция — редко, на «спасибо» — всегда", () => {
    expect(wantSprite(() => 0)).toBe(true);
    expect(wantSprite(() => LOOK.spriteChance)).toBe(false);
    expect(wantSprite(() => 0.99, true)).toBe(true);
    let sp = 0;
    let re = 0;
    for (let i = 0; i < 2000; i++) {
      const r = rng(i);
      if (wantSprite(r)) sp++;
      if (pickReaction("tired", rng(i + 5000))) re++;
    }
    expect(sp / 2000).toBeGreaterThan(0.08);
    expect(sp / 2000).toBeLessThan(0.17);
    expect(re / 2000).toBeGreaterThan(0.2);
    expect(re / 2000).toBeLessThan(0.3);
    for (const m of MODS) {
      for (const e of MOOD_REACTIONS[m]) expect(e).not.toMatch(/️|‍/); // без модификаторов
      expect(MOOD_REACTIONS[m]).toContain(pickReaction(m, () => 0.99, true)!);
    }
  });
});

const MODS = MOODS;
/** простая предсказуемая «случайность» из номера */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

describe("кино-моменты", () => {
  const L3 = { ...STYLE_DEFAULT, level: 3 as const };
  const base = { mood: "tired" as const, situation: "reminder" as const, style: L3, state: emptyStyleState(), now: NOW, vars: { task: "оплатить счёт" } };

  it("только уровень 3: на уровнях 0–2 нет ни при каком шансе", () => {
    for (const level of [0, 1, 2] as const) expect(cinemaMoment({ ...base, style: { ...L3, level }, rand: () => 0 })).toBeNull();
    expect(cinemaMoment({ ...base, rand: () => 0 })).not.toBeNull();
  });

  it("шанс 1–2%: на тысячах семян выпадает в этих пределах; остальное — обычные фразы", () => {
    let n = 0;
    for (let i = 0; i < 5000; i++) if (cinemaMoment({ ...base, rand: rng(i + 1) })) n++;
    expect(n / 5000).toBeGreaterThan(0.008);
    expect(n / 5000).toBeLessThan(0.025);
    expect(CINEMA.chance).toBeGreaterThanOrEqual(0.01);
    expect(CINEMA.chance).toBeLessThanOrEqual(0.02);
  });

  it("пауза: не чаще раза в 24 часа; отметка времени пишется в состояние", () => {
    const first = cinemaMoment({ ...base, rand: () => 0 })!;
    expect(first.state.cin).toBe(NOW);
    expect(cinemaMoment({ ...base, state: first.state, now: NOW + 23 * 60 * MINUTE, rand: () => 0 })).toBeNull();
    expect(cinemaMoment({ ...base, state: first.state, now: NOW + 25 * 60 * MINUTE, rand: () => 0 })).not.toBeNull();
  });

  it("только в подходящих ситуациях (напоминание, радость), не в «спасибо», «просрочено» и т.п.", () => {
    for (const situation of ["thanks", "missed", "greeting", "idle_ping", "reminder_repeat", "chat_fallback"] as const) {
      expect(cinemaMoment({ ...base, situation, rand: () => 0 })).toBeNull();
    }
    for (const situation of ["reminder", "missed_first", "done", "streak_praise", "relief"] as const) {
      expect(cinemaMoment({ ...base, situation, rand: () => 0 })).not.toBeNull();
    }
  });

  it("все монологи: в каждом настроении не меньше двух на вид; один манга-звук; подстановки раскрыты; длина умеренная", () => {
    for (const m of MODS) {
      for (const kind of ["remind", "done"] as const) {
        expect(MONOLOGUES[m][kind].length).toBeGreaterThanOrEqual(2);
        for (let k = 0; k < MONOLOGUES[m][kind].length; k++) {
          const r = cinemaMoment({ ...base, mood: m, situation: kind === "remind" ? "reminder" : "done", rand: () => k / MONOLOGUES[m][kind].length, force: true })!;
          expect(r.text, `${m}/${kind}/${k}`).not.toMatch(/[{}\[\]]/);
          expect(r.text.length).toBeLessThan(600);
          expect(r.text.split("\n").length).toBeGreaterThanOrEqual(3);
          const sfxLines = r.text.split("\n").filter((l) => Object.values(SFX).some((s) => s.kana === l || s.cyrillic === l));
          expect(sfxLines.length).toBe(1);
        }
      }
    }
  });

  it("настройка манга-звуков: кириллицей и выключено", () => {
    const cyr = cinemaMoment({ ...base, style: { ...L3, sfx: "cyrillic" }, rand: () => 0 })!;
    expect(cyr.text).toContain("ха-а…");
    const off = cinemaMoment({ ...base, style: { ...L3, sfx: "off" }, rand: () => 0 })!;
    expect(off.text).not.toMatch(/ハ|ха-а/);
  });

  it("принудительно (/mood show:cinema): обходит уровень, шанс и паузу", () => {
    const r = cinemaMoment({ ...base, style: { ...L3, level: 0 }, state: { ...emptyStyleState(), cin: NOW }, rand: () => 0.99, force: true });
    expect(r).not.toBeNull();
  });

  it("состояние стиля помнит cin и bon, повреждённое — нет", () => {
    expect(parseStyleState(JSON.stringify({ n: 3, words: {}, cin: 5, bon: 7 }))).toEqual({ n: 3, words: {}, cin: 5, bon: 7 });
    expect(parseStyleState(JSON.stringify({ n: 3, words: {} }))).toEqual({ n: 3, words: {} });
    expect(parseStyleState("{плохо")).toEqual({ n: 0, words: {} });
  });
});

describe("слова хозяина: «ара-ара», «ганбатте»…", () => {
  it("узнаёт слово целиком (знаки, регистр, имя горничной), но не слово внутри обычной записи", () => {
    for (const t of ["Ара-ара~", "ара ара", "ARA-ARA!", "ганбатте", "Ганбатте, Хару!", "ganbatte", "окаэри", "яре яре...", "кавай!!!"]) expect(detectUserWord(t), t).not.toBeNull();
    expect(detectUserWord("Ара-ара~")).toBe("ara_ara");
    expect(detectUserWord("ганбатте хару")).toBe("ganbatte");
    for (const t of ["напомни завтра ганбатте", "завтра в 10 купить хлеб", "ара-ара-ара-ара-ара-ара-ара-ара-ара-ара-ара-ара", "спасибо", "", "!!!"]) expect(detectUserWord(t), t).toBeNull();
  });

  it("ответы есть для каждого слова и настроения; без неизвестных подстановок", () => {
    for (const id of Object.keys(WORD_REPLIES) as (keyof typeof WORD_REPLIES)[]) {
      for (const m of MODS) {
        expect(WORD_REPLIES[id][m].length).toBeGreaterThanOrEqual(2);
        for (const line of WORD_REPLIES[id][m]) expect(line.replace(/\{user\}/g, "")).not.toMatch(/[{}]/);
        expect(wordReply(id, m, () => 0)).toBe(WORD_REPLIES[id][m][0]);
      }
    }
  });
});

// ---------------- проводка: cron и команды ----------------

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

async function run(now: number, rand: () => number = () => 0) {
  const repo = w.repo(100);
  return runCron({ repo, api: countedApi(w.discord, repo.counter), now, env: {}, rand, fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
}
async function call(i: Partial<Interaction>, now = NOW, env: { origin?: string } = { origin: ORIGIN }): Promise<any> {
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
    { repo: w.repo(100), api: w.discord, now, env, rand: () => 0, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r;
}
const click = (custom_id: string, now = NOW) => call({ type: 3, data: { custom_id }, message: { id: "m1" } }, now);
const cmd = (name: string, options: { name: string; value: string | number }[] = [], now = NOW) => call({ type: 2, data: { name, type: 1, options } }, now);
const mood = () => w.d1.q<Record<string, any>>("SELECT * FROM mood_state WHERE user_id = ?", OWNER)[0];
const card = (b: any): any => b.embeds?.[0];

beforeEach(async () => {
  w = new World();
  pending = [];
  await w.seed({ today: true, intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

describe("Х3: напоминание карточкой", () => {
  beforeEach(async () => {
    await click("mn:tg:mo:c");
  });

  it("суть остаётся обычным текстом с упоминанием и кнопками; реплика — в цветной карточке со спрайтом", async () => {
    await call({ type: 2, data: { name: "list", type: 1, options: [] } }); // любой вызов запоминает адрес Worker
    expect(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'public_origin'")[0].value).toBe(ORIGIN);
    await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const body = w.discord.live(CH_REMIND)[0].body;
    expect(body.content).toContain(`<@${OWNER}>`); // уведомление идёт из текста, не из карточки
    expect(body.content).toContain("**Оплатить счёт**");
    expect(body.content).toContain("Срок:");
    expect(body.allowed_mentions).toEqual({ users: [OWNER] });
    const e = card(body);
    expect(e.color).toBe(MOOD_COLOR[mood().current_mood as keyof typeof MOOD_COLOR]);
    expect(e.thumbnail.url).toBe(`${ORIGIN}/sprites/${mood().current_mood}.jpg`);
    expect(e.description.length).toBeGreaterThan(3);
    const ids = body.components![0].components.map((c: any) => c.custom_id);
    expect(ids.some((i: string) => i.startsWith("done:"))).toBe(true);
  });

  it("спрайт редкий: при «неудачной» случайности карточка без картинки, но с цветом", async () => {
    await call({ type: 2, data: { name: "list", type: 1, options: [] } });
    await w.create("через 5 минут оплатить счёт");
    await run(min(5), () => 0.5);
    const e = card(w.discord.live(CH_REMIND)[0].body);
    expect(e).toBeDefined();
    expect(e.thumbnail).toBeUndefined();
    expect(typeof e.color).toBe("number");
  });

  it("без записанного адреса Worker (cron раньше любой команды) — цвет есть, картинки нет", async () => {
    await w.repo().exec([op("DELETE FROM meta WHERE key = 'public_origin'")]);
    await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const e = card(w.discord.live(CH_REMIND)[0].body);
    expect(e.thumbnail).toBeUndefined();
    expect(typeof e.color).toBe("number");
  });

  it("серьёзная тема и критичное дело: без карточки (обычный нейтральный текст)", async () => {
    await w.create("через 5 минут записаться к врачу");
    await run(min(5));
    expect(w.discord.live(CH_REMIND)[0].body.embeds).toBeUndefined();
  });

  it("настроение выключено: карточек нет, текст как раньше", async () => {
    await click("mn:tg:mo:c"); // выкл
    await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    expect(w.discord.live(CH_REMIND)[0].body.embeds).toBeUndefined();
  });

  it("«Готово»: реплика в карточке, текст «Готово: …» остаётся; прежняя карточка при обновлении убирается", async () => {
    const a = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const r = await click(`done:${a.occId}`, min(6));
    expect(String(r.data.content).startsWith("Готово: Оплатить счёт")).toBe(true);
    expect(r.data.embeds).toHaveLength(1);
    expect(r.data.components).toEqual([]);
    const gone = await click("done:99999");
    expect(gone.type).toBe(7);
    expect(gone.data.embeds).toEqual([]); // обновление без карточки: прежняя исчезает
  });
});

describe("Х3: /mood", () => {
  it("карточка цвета настроения со спрайтом, видна только хозяину", async () => {
    const r = await cmd("mood");
    expect(r.data.flags).toBe(64);
    const e = card(r.data);
    expect(e.description).toContain("Хару");
    expect(e.color).toBe(MOOD_COLOR.tired);
    expect(e.thumbnail.url).toBe(`${ORIGIN}/sprites/tired.jpg`);
    const r2 = await cmd("mood", [{ name: "set", value: "yandere" }]);
    expect(card(r2.data).color).toBe(MOOD_COLOR.yandere);
    expect(r2.data.content).toContain("yandere");
  });

  it("/mood show:cinema показывает пример редкой сцены независимо от уровня и не заводит паузу", async () => {
    const r = await cmd("mood", [{ name: "show", value: "cinema" }]);
    expect(r.data.content).toContain("кино-момента");
    expect(r.data.flags).toBe(64);
    expect(card(r.data).description.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(card(r.data).thumbnail).toBeDefined();
    expect(JSON.parse(mood().style_data).cin).toBeUndefined();
  });
});

describe("Х3: реакции эмодзи на сообщения хозяина", () => {
  beforeEach(async () => {
    await click("mn:tg:mo:c");
    await run(min(0)); // первый запуск запоминает конец канала
  });

  it("на записанное дело — реакция по настроению (tired: из своего списка); бот не реагирует, когда настроение выключено", async () => {
    const m = w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб");
    await run(min(1));
    expect(w.discord.reactions).toHaveLength(1);
    expect(w.discord.reactions[0]).toMatchObject({ channel: CH_BOT, id: m.id });
    expect(MOOD_REACTIONS.tired).toContain(w.discord.reactions[0].emoji);
  });

  it("реакция — редко: при «неудачной» случайности её нет; дело записано всё равно", async () => {
    w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб");
    await run(min(1), () => 0.9);
    expect(w.discord.reactions).toHaveLength(0);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(1);
  });

  it("серьёзная тема и секрет — без реакции", async () => {
    w.discord.say(CH_BOT, OWNER, "завтра в 10 записаться к врачу");
    w.discord.say(CH_BOT, OWNER, "пароль от почты qwerty123456");
    await run(min(1));
    expect(w.discord.reactions).toHaveLength(0);
  });

  it("«спасибо»: ответ карточкой и реакция всегда", async () => {
    const m = w.discord.say(CH_BOT, OWNER, "спасибо");
    await run(min(1), () => 0.9);
    expect(w.discord.reactions.map((r) => r.id)).toEqual([m.id]);
    const reply = w.discord.live(CH_BOT)[0].body;
    expect(reply.embeds).toHaveLength(1);
    expect(reply.allowed_mentions).toEqual({ parse: [] });
  });

  it("настроение выключено: реакций нет", async () => {
    await click("mn:tg:mo:c"); // выкл
    w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб");
    await run(min(1));
    expect(w.discord.reactions).toHaveLength(0);
  });

  it("сбой права добавлять реакции не ломает приём", async () => {
    w.discord.addReaction = async () => {
      throw new Error("403");
    };
    w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб");
    const r = await run(min(1));
    expect(r.intake).toBe(1);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(1);
  });
});

describe("Х3: «ара-ара», «ганбатте» от хозяина", () => {
  beforeEach(async () => {
    await click("mn:tg:mo:c");
    await run(min(0));
  });

  it("ответ в тон карточкой, дела не создаётся, симпатия +1 и реакция", async () => {
    await cmd("list"); // заводит состояние: симпатия 50
    const m = w.discord.say(CH_BOT, OWNER, "Ара-ара~");
    const r = await run(min(1));
    expect(r.intake).toBe(1);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    const reply = w.discord.live(CH_BOT)[0].body;
    expect(reply.embeds![0].description).toContain("ара-ара".slice(0, 3)); // Ара-ара в ответе
    expect(reply.content).toBeUndefined();
    expect(mood().affection).toBeCloseTo(51, 0);
    expect(w.discord.reactions[0].id).toBe(m.id);
  });

  it("симпатия +1 не чаще раза в час; через час — снова; ответ при этом приходит всегда", async () => {
    await cmd("list");
    w.discord.say(CH_BOT, OWNER, "ганбатте");
    await run(min(1));
    const a1 = mood().affection;
    w.discord.say(CH_BOT, OWNER, "ганбатте, Хару!");
    await run(min(2));
    expect(w.discord.live(CH_BOT)).toHaveLength(2); // два ответа
    expect(mood().affection).toBeLessThanOrEqual(a1); // второй раз не добавил (спад только вниз к 50)
    expect(JSON.parse(mood().style_data).bon).toBe(min(1));
    w.discord.say(CH_BOT, OWNER, "окаэри");
    await run(min(1 + 61));
    expect(mood().affection).toBeGreaterThan(a1 - 0.5);
    expect(JSON.parse(mood().style_data).bon).toBe(min(62));
  });

  it("на уровне 0 (без аниме) слово — обычное сообщение: карточкой-ответом бот не отвечает", async () => {
    await cmd("style", [{ name: "level", value: 0 }]);
    w.discord.say(CH_BOT, OWNER, "ара-ара");
    await run(min(1));
    expect(w.discord.live(CH_BOT)[0].body.embeds).toBeUndefined(); // обычный ответ про запись, а не карточка горничной
  });
});

describe("Х3: кино-момент в напоминании", () => {
  beforeEach(async () => {
    await click("mn:tg:mo:c");
    await cmd("style", [{ name: "level", value: 3 }]);
    await cmd("list");
  });

  it("при выпавшем шансе: длинная реплика со спрайтом; второй раз в те же сутки — обычная фраза", async () => {
    await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const first = card(w.discord.live(CH_REMIND)[0].body);
    expect(first.description.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(first.thumbnail).toBeDefined();
    const cin = JSON.parse(mood().style_data).cin;
    expect(cin).toBe(min(5));

    await w.create("через 10 минут позвонить маме", min(6));
    await run(min(16));
    expect(JSON.parse(mood().style_data).cin).toBe(cin); // пауза: нового момента нет
  });

  it("на уровне 2 кино-моментов не бывает", async () => {
    await cmd("style", [{ name: "level", value: 2 }]);
    await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    expect(JSON.parse(mood().style_data).cin).toBeUndefined();
  });
});

describe("Х3: клиент Discord", () => {
  it("реакция — PUT на адрес с эмодзи в процентной записи; 404 (сообщения уже нет) не ошибка; карточка уходит в теле сообщения как есть", async () => {
    const { createDiscordApi } = await import("../src/discord/api.ts");
    const calls: { url: string; method: string; body?: string }[] = [];
    let status = 204;
    const api = createDiscordApi("tok", (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body as string | undefined });
      return new Response(status === 204 ? null : "{}", { status });
    }) as unknown as typeof fetch);
    await api.addReaction("123", "456", "😴");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(`https://discord.com/api/v10/channels/123/messages/456/reactions/${encodeURIComponent("😴")}/@me`);
    status = 404;
    await expect(api.addReaction("123", "456", "☕")).resolves.toBeUndefined();
    status = 200;
    await api.postMessage("123", { content: "x", embeds: [maidEmbed({ mood: "tired", text: "т", origin: ORIGIN, sprite: true })] });
    const sent = JSON.parse(calls[2].body!);
    expect(sent.embeds[0]).toEqual({ color: MOOD_COLOR.tired, description: "т", thumbnail: { url: `${ORIGIN}/sprites/tired.jpg` } });
  });
});
