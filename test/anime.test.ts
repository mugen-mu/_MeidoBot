// Аниме (этап «Аниме», выкладка 1): разбор фразы, занесение, кнопки, ночное обновление, «посмотрели?», вечер, неделя.
import { beforeEach, describe, expect, it } from "vitest";
import { effective, findOwn, parseAnimePhrase, whenShort, type Anime } from "../src/anime/core.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const D0 = kyiv(2026, 11, 9, 12, 0); // понедельник
const shiki = (id: number, ru: string, name: string, o: Record<string, unknown> = {}) => ({ id, russian: ru, name, kind: "tv", status: "ongoing", episodes: 12, aired_on: "2026-10-08", ...o });
const iso = (ms: number) => new Date(ms).toISOString();

type R = { type: number; data?: any };
let w: World;
let seq = 0;
let nowCall = D0;

async function call(i: Partial<Interaction>): Promise<R> {
  const pending: Promise<unknown>[] = [];
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user: { id: OWNER } }, type: 3, message: { id: "m1" }, ...i } as Interaction,
    {
      repo: w.repo(), api: w.discord, now: nowCall, env: {}, defer: (p) => void pending.push(p),
      fetchFn: (async (u: unknown) => {
        const url = String(u);
        w.animeFetches++;
        if (url.includes("/api/calendar")) return w.shikiCalendar === null ? new Response("x", { status: 503 }) : Response.json(w.shikiCalendar);
        const one = /\/api\/animes\/(\d+)/.exec(url);
        if (one) return w.shikiById[Number(one[1])] ? Response.json(w.shikiById[Number(one[1])]) : new Response("n", { status: 404 });
        return w.shikiSearch === null ? new Response("x", { status: 503 }) : Response.json(w.shikiSearch);
      }) as unknown as typeof fetch,
    },
  );
  await Promise.all(pending);
  return r as R;
}
const click = (custom_id: string) => call({ data: { custom_id } });
const submit = (custom_id: string, fields: Record<string, string>) =>
  call({ type: 5, data: { custom_id, components: Object.entries(fields).map(([id, value]) => ({ type: 18, component: { type: 4, custom_id: id, value } })) } });
const ids = (r: R): string[] => (r.data?.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.custom_id as string));
const rows = () => w.d1.q<Anime>("SELECT * FROM anime ORDER BY id");

beforeEach(async () => {
  w = new World();
  nowCall = D0;
  await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off" } });
});

describe("аниме: разбор фразы", () => {
  it("слова статуса, серия и название", () => {
    expect(parseAnimePhrase("бот смотрю фрирен")).toEqual({ status: "watching", query: "фрирен", episode: null });
    expect(parseAnimePhrase("Аниме хочу блич")).toEqual({ status: "planned", query: "блич", episode: null });
    expect(parseAnimePhrase("бот в планах Магия вернувшегося")).toMatchObject({ status: "planned", query: "Магия вернувшегося" });
    expect(parseAnimePhrase("бот бросил ДжоДжо")).toMatchObject({ status: "dropped", query: "ДжоДжо" });
    expect(parseAnimePhrase("бот посмотрел «Блич»!")).toMatchObject({ status: "done", query: "Блич" });
    expect(parseAnimePhrase("бот смотрю фрирен серия 4")).toEqual({ status: "watching", query: "фрирен", episode: 4 });
    expect(parseAnimePhrase("бот смотрю фрирен 3")).toEqual({ status: "watching", query: "фрирен 3", episode: null });
    expect(parseAnimePhrase("бот смотрю фрирен на 7 серии")).toMatchObject({ query: "фрирен", episode: 7 });
  });

  it("обычные дела не трогаем: без слова «бот» или «аниме» — не наша фраза", () => {
    expect(parseAnimePhrase("хочу купить хлеб завтра")).toBeNull();
    expect(parseAnimePhrase("смотрю фрирен")).toBeNull();
    expect(parseAnimePhrase("бот купить хлеб")).toBeNull();
    expect(parseAnimePhrase("бот смотрю")).toBeNull();
  });
});

describe("аниме: состояние серий и показ", () => {
  const base: Anime = { id: 1, mal_id: 1, anilist_id: 2, title_ru: "Т", title_orig: null, status: "watching", watched: 3, liked: 0, notify: 1, episodes: 12, src_status: "RELEASING", next_ep: 5, next_at: D0 + 3 * HOUR, aired_ep: 4, aired_at: null, asked_ep: 4, added_at: 0, updated_at: 0 };
  it("пока серия не вышла — она «ближайшая», после срока — вышедшая", () => {
    expect(effective(base, D0)).toMatchObject({ airedEp: 4, upcoming: { ep: 5 } });
    expect(effective(base, D0 + 4 * HOUR)).toMatchObject({ airedEp: 5, airedAt: D0 + 3 * HOUR, upcoming: null });
  });
  it("время по Киеву: сегодня, завтра, день недели", () => {
    expect(whenShort(kyiv(2026, 11, 9, 19, 30), D0, "Europe/Kyiv")).toBe("сегодня 19:30");
    expect(whenShort(kyiv(2026, 11, 10, 2, 30), D0, "Europe/Kyiv")).toBe("завтра 02:30");
    expect(whenShort(kyiv(2026, 11, 13, 19, 0), D0, "Europe/Kyiv")).toBe("пт 19:00");
  });
  it("поиск в своём списке: одно совпадение — да, несколько — нет", () => {
    const a = { ...base, title_ru: "Провожающая в последний путь Фрирен" };
    const b = { ...base, id: 2, mal_id: 2, title_ru: "Провожающая в последний путь Фрирен 2" };
    expect(findOwn([a], "фрирен")?.id).toBe(1);
    expect(findOwn([a, b], "фрирен")).toBeNull();
    expect(findOwn([a, b], "Провожающая в последний путь Фрирен")?.id).toBe(1);
  });
});

describe("аниме: занесение фразой в канале «бот»", () => {
  it("один вариант — записали сразу, расписание от Shikimori", async () => {
    w.shikiSearch = [shiki(57612, "Магия вернувшегося должна быть особенной", "Kikansha no Mahou")];
    w.shikiById[57612] = shiki(57612, "Магия вернувшегося должна быть особенной", "Kikansha no Mahou", { next_episode_at: iso(D0 + 2 * HOUR), episodes_aired: 5 });
    await w.run(D0);
    w.discord.say(CH_BOT, OWNER, "бот смотрю магия вернувшегося серия 5");
    await w.run(D0 + MINUTE);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ mal_id: 57612, status: "watching", watched: 5, next_ep: 6, aired_ep: 5, asked_ep: 5, episodes: 12 });
    const reply = w.discord.posted.find((p) => p.channel === CH_BOT && p.body.content?.includes("Записала"));
    expect(reply?.body.content).toContain("Магия вернувшегося должна быть особенной");
    expect(reply?.body.content).toContain("6-я");
    expect(w.d1.q("SELECT * FROM items")).toHaveLength(0); // это не дело
  });

  it("несколько вариантов — кнопки, выбор записывает; повторный выбор не дублирует", async () => {
    w.shikiSearch = [shiki(63816, "Фрирен: Золотая земля", "Ougonkyou", { status: "anons", episodes: 0, aired_on: "2027-10-01" }), shiki(59978, "Фрирен 2", "Frieren 2", { status: "released", aired_on: "2026-01-16" }), shiki(52991, "Провожающая в последний путь Фрирен", "Frieren", { status: "released", episodes: 28 })];
    w.shikiById[59978] = w.shikiSearch[1];
    await w.run(D0);
    w.discord.say(CH_BOT, OWNER, "аниме хочу фрирен");
    await w.run(D0 + MINUTE);
    const msg = w.discord.posted.find((p) => p.channel === CH_BOT && p.body.components?.length);
    const buttons = (msg?.body.components ?? []).flatMap((r) => r.components.map((c) => c.custom_id));
    expect(buttons).toEqual(["an:pk:63816:p:0", "an:pk:59978:p:0", "an:pk:52991:p:0", "an:no"]);
    expect(rows()).toHaveLength(0);
    const r = await click("an:pk:59978:p:0");
    expect(r.type).toBe(7);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ mal_id: 59978, status: "planned" });
    await click("an:pk:59978:p:0");
    expect(rows()).toHaveLength(1);
  });

  it("Shikimori не ответил — ничего не записали, сказали об этом", async () => {
    w.shikiSearch = null;
    await w.run(D0);
    w.discord.say(CH_BOT, OWNER, "бот смотрю фрирен");
    await w.run(D0 + MINUTE);
    expect(rows()).toHaveLength(0);
    expect(w.discord.posted.some((p) => p.body.content?.includes("не отвечает"))).toBe(true);
  });

  it("своё название находим без сети: «бросил» меняет статус", async () => {
    w.shikiSearch = [shiki(1, "Блич", "Bleach")];
    await w.run(D0);
    w.discord.say(CH_BOT, OWNER, "бот смотрю блич");
    await w.run(D0 + MINUTE);
    const before = w.animeFetches;
    w.discord.say(CH_BOT, OWNER, "бот бросил блич");
    await w.run(D0 + 2 * MINUTE);
    expect(w.animeFetches).toBe(before);
    expect(rows()[0].status).toBe("dropped");
  });
});

describe("аниме: экраны и кнопки", () => {
  beforeEach(async () => {
    w.shikiSearch = [shiki(10, "Меч", "Ken", { episodes: 12 })];
    w.shikiById[10] = shiki(10, "Меч", "Ken", { episodes: 12, next_episode_at: iso(D0 + 2 * HOUR), episodes_aired: 6 });
    await w.run(D0);
    w.discord.say(CH_BOT, OWNER, "бот смотрю меч серия 6");
    await w.run(D0 + MINUTE);
  });

  it("главный экран: кнопка «Аниме», список открывается", async () => {
    const home = await click("mn:home");
    expect(ids(home)).toContain("mn:an");
    const r = await click("mn:an");
    expect(r.data.content).toContain("Аниме · Смотрю");
    expect(r.data.content).toContain("Меч");
    expect(r.data.content).toContain("серия 6");
    expect(ids(r)).toEqual(expect.arrayContaining(["an:it:1:w:0", "an:ls:p:0", "an:ls:d:0", "an:ls:x:0", "an:ad"]));
  });

  it("карточка: Серия +1, отметки, статус, уведомления, удаление", async () => {
    const card = await click("an:it:1:w:0");
    expect(card.data.content).toContain("Статус: Смотрю · серия 6 из 12");
    expect(card.data.content).toContain("Следующая: 7-я");
    await click("an:ep:1:w:0");
    expect(rows()[0].watched).toBe(7);
    await click("an:lk:1:2:w:0");
    expect(rows()[0].liked).toBe(2);
    await click("an:lk:1:2:w:0");
    expect(rows()[0].liked).toBe(0);
    await click("an:nt:1:w:0");
    expect(rows()[0].notify).toBe(0);
    await click("an:st:1:d:w:0");
    expect(rows()[0]).toMatchObject({ status: "done", watched: 12 });
    const del = await click("an:dl:1:d:0");
    expect(del.data.content).toContain("Убрать");
    await click("an:dy:1:d:0");
    expect(rows()).toHaveLength(0);
  });

  it("окна: «Указать номер» и «＋ Добавить»", async () => {
    const m = await click("an:epm:1:w:0");
    expect(m.type).toBe(9);
    await submit("m_anep:1:w:0", { ep: "9" });
    expect(rows()[0].watched).toBe(9);
    await submit("m_anep:1:w:0", { ep: "abc" });
    expect(rows()[0].watched).toBe(9);
    const add = await click("an:ad");
    expect(add.type).toBe(9);
    w.shikiSearch = [shiki(20, "Небеса", "Heaven", { episodes: 0 })];
    await submit("m_anadd", { name: "небеса", st: "planned", ep: "" });
    expect(rows().map((r) => r.mal_id)).toEqual([10, 20]);
    expect(rows()[1].status).toBe("planned");
  });

  it("последняя серия законченного сериала переводит в «Просмотрено»", async () => {
    w.d1.sqlite.exec("UPDATE anime SET episodes = 7, src_status = 'FINISHED', next_ep = NULL, next_at = NULL, aired_ep = 7 WHERE id = 1");
    const r = await click("an:ep:1:w:0");
    expect(rows()[0].status).toBe("done");
    expect(r.data.content).toContain("Понравилось?");
  });

  it("/week: строка про аниме", async () => {
    const r = await call({ type: 2, data: { name: "week", type: 1 } });
    expect(r.data.content).toContain("🎬 Аниме:");
    expect(r.data.content).toContain("Меч");
    expect(r.data.content).toContain("7-я");
  });
});

describe("аниме: ночное обновление, «посмотрели?», вечер", () => {
  const T = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);
  beforeEach(async () => {
    // тайтл с известной ближайшей серией: 7-я выйдет 9 ноября в 19:00 по Киеву
    w.d1.sqlite.exec(
      `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, next_ep, next_at, aired_ep, asked_ep, added_at, updated_at)
       VALUES (10, 'Меч', 'watching', 6, 12, 'RELEASING', 7, ${T(9, 19)}, 6, 6, 0, 0)`,
    );
  });

  it("вечером в сводке: «сегодня выходит»", async () => {
    w.d1.sqlite.exec(`UPDATE anime SET next_at = ${T(9, 21)}`);
    await w.run(T(9, 20, 5));
    const s = w.discord.posted.find((p) => p.body.content?.includes("Вечерняя сводка"));
    expect(s?.body.content).toContain("🎬 Аниме — сегодня выходит:");
    expect(s?.body.content).toContain("21:00 Меч — 7-я серия");
  });

  it("ночью обновляем расписание раз в сутки; утром — один вопрос с кнопками", async () => {
    w.shikiCalendar = [{ next_episode: 8, next_episode_at: iso(T(16, 19)), anime: shiki(10, "Меч", "Ken", { episodes_aired: 7 }) }];
    const before = w.animeFetches;
    await w.run(T(10, 3, 5));
    expect(w.animeFetches).toBe(before + 1);
    expect(rows()[0]).toMatchObject({ aired_ep: 7, next_ep: 8, asked_ep: 6 });
    await w.run(T(10, 3, 30));
    expect(w.animeFetches).toBe(before + 1);
    await w.run(T(10, 9, 5)); // утренняя сводка
    await w.run(T(10, 9, 6));
    const ask = w.discord.posted.filter((p) => p.channel === CH_REMIND && p.body.content?.includes("Новые серии"));
    expect(ask).toHaveLength(1);
    expect(ask[0].body.content).toContain("**Меч** — 7-я");
    const btn = ask[0].body.components![0].components.map((c) => c.custom_id);
    expect(btn).toEqual(["an:sn:all:1", "an:sn:no:1"]);
    expect(rows()[0].asked_ep).toBe(7);
    await w.run(T(10, 10, 0));
    expect(w.discord.posted.filter((p) => p.body.content?.includes("Новые серии"))).toHaveLength(1);
    nowCall = T(10, 9, 10);
    const r = await click("an:sn:all:1");
    expect(r.data.content).toContain("Отмечено");
    expect(rows()[0].watched).toBe(7);
  });

  it("источник не отвечает: повтор раз в час, через три часа одно сообщение", async () => {
    w.shikiCalendar = null;
    await w.run(T(10, 3, 5));
    expect(rows()[0].next_ep).toBe(7);
    await w.run(T(10, 3, 30));
    await w.run(T(10, 4, 10));
    await w.run(T(10, 5, 15));
    await w.run(T(10, 6, 20));
    const n = w.discord.posted.filter((p) => p.body.content?.includes("Расписание аниме не обновляется"));
    expect(n).toHaveLength(1);
  });

  it("три утра без ответа — один вопрос «продолжать ли?», потом молчим", async () => {
    for (const d of [10, 11, 12]) {
      w.d1.sqlite.exec(`UPDATE anime SET next_ep = ${d - 2 + 7}, next_at = ${T(d - 1, 19)}, aired_ep = ${d - 3 + 7}, asked_ep = ${d - 3 + 7}`);
      await w.run(T(d, 9, 5));
      await w.run(T(d, 9, 6));
    }
    expect(w.discord.posted.filter((p) => p.body.content?.includes("Новые серии"))).toHaveLength(3);
    w.d1.sqlite.exec(`UPDATE anime SET next_ep = 20, next_at = ${T(12, 19)}, aired_ep = 17, asked_ep = 17`);
    await w.run(T(13, 9, 5));
    await w.run(T(13, 9, 6));
    expect(w.discord.posted.filter((p) => p.body.content?.includes("Записывать дальше"))).toHaveLength(1);
    expect(w.discord.posted.filter((p) => p.body.content?.includes("Новые серии"))).toHaveLength(3);
    nowCall = T(13, 9, 10);
    await click("an:pz:off");
    w.d1.sqlite.exec(`UPDATE anime SET next_ep = 21, next_at = ${T(13, 19)}, aired_ep = 20, asked_ep = 20`);
    await w.run(T(14, 9, 5));
    await w.run(T(14, 9, 6));
    expect(w.discord.posted.filter((p) => p.body.content?.includes("Новые серии"))).toHaveLength(3);
  });
});
