// Аниме живыми фразами (волна 3 анкеты вкусов, 2026-11-18): запись «глянул последнюю серию Фрирен», «посмотрел s3e2 …», «забил на …»,
// вопросы «что я смотрю», «что отложено», «что вышло нового», «когда новая серия Фрирен». Без модели, без слова «бот» только про своё название.
import { beforeEach, describe, expect, it } from "vitest";
import { type Anime, findOwnSeason } from "../src/anime/core.ts";
import { parseAnimeAsk, parseAnimeSay } from "../src/anime/say.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

describe("parseAnimeSay: как он пишет про серии", () => {
  it.each([
    ["глянул последнюю серию Фрирен", { status: "watching", query: "Фрирен", episode: null, prefixed: false, latest: true }],
    ["Глянул последнюю серию фрирен", { status: "watching", query: "фрирен", episode: null, prefixed: false, latest: true }],
    ["посмотрел s3e2 класса превосходства", { status: "watching", query: "класса превосходства", episode: 2, prefixed: false, season: 3 }],
    ["посмотрел S03E12 Фрирен", { status: "watching", query: "Фрирен", episode: 12, prefixed: false, season: 3 }],
    ["посмотрел 5 серию Фрирен", { status: "watching", query: "Фрирен", episode: 5, prefixed: false }],
    ["посмотрел 5-ю серию Фрирен", { status: "watching", query: "Фрирен", episode: 5, prefixed: false }],
    ["посмотрел Фрирен серия 7", { status: "watching", query: "Фрирен", episode: 7, prefixed: false }],
    ["посмотрел серию Фрирен", { status: "watching", query: "Фрирен", episode: null, prefixed: false, next: true }],
    ["посмотрел Фрирен", { status: "done", query: "Фрирен", episode: null, prefixed: false, soft: true }],
    ["досмотрел Фрирен", { status: "done", query: "Фрирен", episode: null, prefixed: false }],
    ["смотрю фрирен 2 сезон", { status: "watching", query: "фрирен", episode: null, prefixed: false, season: 2 }],
    ["начал смотреть Блич", { status: "watching", query: "Блич", episode: null, prefixed: false }],
    ["забил на ДжоДжо", { status: "dropped", query: "ДжоДжо", episode: null, prefixed: false }],
    ["перестал смотреть ДжоДжо", { status: "dropped", query: "ДжоДжо", episode: null, prefixed: false }],
    ["бросил ДжоДжо", { status: "dropped", query: "ДжоДжо", episode: null, prefixed: false }],
    ["Фрирен надоело", { status: "dropped", query: "Фрирен", episode: null, prefixed: false }],
    ["ДжоДжо фигня", { status: "dropped", query: "ДжоДжо", episode: null, prefixed: false }],
    ["потом посмотрю Блич", { status: "planned", query: "Блич", episode: null, prefixed: false }],
    ["отложил Блич", { status: "planned", query: "Блич", episode: null, prefixed: false }],
    ["Блич потом", { status: "planned", query: "Блич", episode: null, prefixed: false }],
    ["бот глянул последнюю серию Фрирен", { status: "watching", query: "Фрирен", episode: null, prefixed: true, latest: true }],
    ["Хару, забил на ДжоДжо", { status: "dropped", query: "ДжоДжо", episode: null, prefixed: true }],
    ["бот посмотрел Блич", { status: "done", query: "Блич", episode: null, prefixed: true }], // с обращением — как раньше: весь тайтл
    ["бот смотрю фрирен серия 4", { status: "watching", query: "фрирен", episode: 4, prefixed: true }],
    ["аниме хочу блич", { status: "planned", query: "блич", episode: null, prefixed: true }],
  ])("«%s»", (text, want) => {
    expect(parseAnimeSay(text)).toEqual(want);
  });

  it.each(["", "   ", "купить хлеб", "позвонить маме завтра", "бот", "бот купить хлеб", "потом посмотрю", "забил на", "ботинки купить", "харуки смотрю блич",
    "посмотрел\nФрирен", `посмотрел ${"очень длинное название ".repeat(6)}`])("«%s» — не фраза про аниме", (text) => {
    expect(parseAnimeSay(text)).toBeNull();
  });
});

describe("parseAnimeAsk: вопросы про своё аниме", () => {
  it.each([
    ["что я смотрю", { kind: "watching" }],
    ["Что я сейчас смотрю?", { kind: "watching" }],
    ["что смотрю", { kind: "watching" }],
    ["покажи что я смотрю", { kind: "watching" }],
    ["мои онгоинги", { kind: "watching" }],
    ["что отложено", { kind: "planned" }],
    ["что я отложил", { kind: "planned" }],
    ["что у меня отложено?", { kind: "planned" }],
    ["что на потом", { kind: "planned" }],
    ["что вышло нового", { kind: "news" }],
    ["Что вышло нового?", { kind: "news" }],
    ["что нового вышло", { kind: "news" }],
    ["что новенького", { kind: "news" }],
    ["новые серии", { kind: "news" }],
    ["когда новая серия", { kind: "next", query: null }],
    ["Когда новая серия Фрирен?", { kind: "next", query: "фрирен" }],
    ["когда выйдет следующая серия фрирен", { kind: "next", query: "фрирен" }],
    ["Хару, когда следующая серия", { kind: "next", query: null }],
  ])("«%s»", (text, want) => {
    expect(parseAnimeAsk(text)).toEqual(want);
  });

  it.each([
    "что смотреть", "что посмотреть сегодня", "как дела", "купить хлеб", "что нового", "что вышло из этой затеи", "когда новая работа",
    "что у меня горит", "какие у меня дела", "что в планах", "", "когда серия", "завтра в 10 отложено",
  ])("«%s» — не вопрос про аниме", (text) => {
    expect(parseAnimeAsk(text)).toBeNull();
  });
});

const row = (id: number, ru: string, o: Partial<Anime> = {}): Anime => ({
  id, mal_id: id, anilist_id: null, title_ru: ru, title_orig: null, status: "done", watched: 0, liked: 0, notify: 1, episodes: 12, src_status: "FINISHED",
  next_ep: null, next_at: null, aired_ep: 0, aired_at: null, asked_ep: 0, added_at: 0, updated_at: 0, drop_reason: null, last_move_at: null, voice_lag: null,
  voice_n: 0, voice_ep: 0, weekq_at: null, seq_at: null, start_asked: 0, ...o,
});

describe("findOwnSeason: сезоны одного тайтла", () => {
  const s1 = row(1, "Класс превосходства");
  const s2 = row(2, "Класс превосходства 2");
  const s3 = row(3, "Класс превосходства 3", { status: "watching" });
  it("сезон из фразы выбирает нужную запись", () => {
    expect(findOwnSeason([s1, s2, s3], "класс превосходства", 3)?.id).toBe(3);
    expect(findOwnSeason([s1, s2, s3], "класс превосходства", 2)?.id).toBe(2);
    expect(findOwnSeason([s1, s2, s3], "класс превосходства", 1)?.id).toBe(1);
  });
  it("без сезона: единственный из «Смотрю», затем точное совпадение; иначе null", () => {
    expect(findOwnSeason([s1, s2, s3], "класс превосходства", null)?.id).toBe(3);
    expect(findOwnSeason([s1, s2, { ...s3, status: "done" }], "класс превосходства", null)?.id).toBe(1); // точное название первого сезона
    expect(findOwnSeason([s1, s2, { ...s3, status: "done" }], "превосходства", null)).toBeNull();
    expect(findOwnSeason([{ ...s1, status: "watching" }, s2, s3], "превосходства", null)).toBeNull(); // «Смотрю» сразу два
  });
  it("единственная запись другого сезона не подходит под «s3e2»", () => {
    expect(findOwnSeason([s2], "класс превосходства", 3)).toBeNull();
    expect(findOwnSeason([s1], "класс превосходства", 3)?.id).toBe(1); // в названии сезона нет — считаем это тот самый тайтл
  });
});

const D0 = kyiv(2026, 11, 9, 12, 0);
const T = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);
let w: World;
const anime = () => w.d1.q<Anime>("SELECT * FROM anime ORDER BY id");
const items = () => w.d1.q("SELECT 1 FROM items").length;
const replies = () => w.discord.posted.filter((p) => p.channel === CH_BOT);

async function say(text: string, at = D0 + MINUTE): Promise<void> {
  w.discord.say(CH_BOT, OWNER, text);
  await w.run(at);
}

beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  w.d1.sqlite.exec(
    `INSERT INTO anime (mal_id, title_ru, title_orig, status, watched, episodes, src_status, next_ep, next_at, aired_ep, asked_ep, added_at, updated_at, voice_lag)
       VALUES (1, 'Провожающая в последний путь Фрирен', 'Sousou no Frieren', 'watching', 4, 28, 'RELEASING', 7, ${T(9, 19)}, 6, 6, 0, 0, 120),
              (2, 'Блич', 'Bleach', 'planned', 0, 12, 'FINISHED', NULL, NULL, 12, 0, 0, 0, NULL),
              (3, 'ДжоДжо', 'JoJo', 'watching', 3, 12, 'FINISHED', NULL, NULL, 12, 3, 0, 0, NULL)`,
  );
  await w.run(D0); // первый запуск запоминает конец канала
});

describe("cron: живые фразы про аниме", () => {
  it("«глянул последнюю серию Фрирен» — отмечена последняя вышедшая (6-я); дело не заводится", async () => {
    await say("глянул последнюю серию Фрирен");
    expect(anime()[0]).toMatchObject({ status: "watching", watched: 6 });
    expect(replies().some((p) => p.body.content?.includes("Записала") && p.body.content.includes("серия 6"))).toBe(true);
    expect(items()).toBe(0);
  });

  it("«посмотрел 5 серию Фрирен» и «посмотрел s1e5 sousou no frieren» (название по-английски) — серия 5", async () => {
    await say("посмотрел 5 серию Фрирен");
    expect(anime()[0].watched).toBe(5);
    await say("посмотрел s1e6 sousou no frieren", D0 + 2 * MINUTE);
    expect(anime()[0].watched).toBe(6);
  });

  it("«посмотрел Фрирен» у сериала в «Смотрю» — следующая серия; у «В планах» — просмотрено целиком", async () => {
    await say("посмотрел Фрирен");
    expect(anime()[0]).toMatchObject({ status: "watching", watched: 5 });
    await say("посмотрел Блич", D0 + 2 * MINUTE);
    expect(anime()[1]).toMatchObject({ status: "done", watched: 12 });
  });

  it("«забил на ДжоДжо», «Фрирен надоело», «потом посмотрю Блич» меняют статус", async () => {
    await say("забил на ДжоДжо");
    expect(anime()[2].status).toBe("dropped");
    await say("Фрирен надоело", D0 + 2 * MINUTE);
    expect(anime()[0].status).toBe("dropped");
    await say("потом посмотрю ДжоДжо", D0 + 3 * MINUTE);
    expect(anime()[2].status).toBe("planned");
    expect(items()).toBe(0);
  });

  it("чужое название без «бот» — обычное дело, как раньше: аниме не тронуто", async () => {
    const before = JSON.stringify(anime());
    const fetches = w.animeFetches;
    await say("забил на уроки");
    expect(JSON.stringify(anime())).toBe(before);
    expect(items()).toBe(1);
    expect(w.animeFetches).toBe(fetches); // на Shikimori не ходили
  });

  it("«серия 3, 5, 7 новая» не ломает: фраза без глагола остаётся делом", async () => {
    await say("посмотреть серию завтра в 19:00");
    expect(items()).toBe(1);
  });

  it("с обращением незнакомое название ищется на Shikimori: «Хару, смотрю Магия»", async () => {
    w.shikiSearch = [{ id: 57612, russian: "Магия вернувшегося", name: "Kikansha no Mahou", kind: "tv", status: "ongoing", episodes: 12, aired_on: "2026-10-08" }];
    w.shikiById[57612] = w.shikiSearch[0];
    await say("Хару, смотрю магия вернувшегося");
    expect(anime().map((a) => a.mal_id)).toEqual([1, 2, 3, 57612]);
    expect(items()).toBe(0);
  });
});

describe("cron: вопросы про своё аниме", () => {
  it("«что я смотрю» — список «Смотрю» с кнопками, дело не заводится", async () => {
    await say("что я смотрю");
    const r = replies().find((p) => p.body.content?.includes("Аниме · Смотрю"));
    expect(r?.body.content).toContain("Провожающая в последний путь Фрирен");
    expect(r?.body.content).toContain("ДжоДжо");
    expect(items()).toBe(0);
  });

  it("«что отложено» — список «В планах»", async () => {
    await say("что отложено");
    const r = replies().find((p) => p.body.content?.includes("Аниме · В планах"));
    expect(r?.body.content).toContain("Блич");
    expect(r?.body.content).not.toContain("ДжоДжо");
  });

  it("«когда новая серия Фрирен» — серия, время и озвучка; «когда новая серия» без названия — ближайшие", async () => {
    await say("когда новая серия Фрирен");
    const one = replies().at(-1)?.body.content as string;
    expect(one).toContain("7-я серия: сегодня 19:00");
    expect(one).toContain("Озвучка AniLibria обычно через ~2 часа");
    await say("когда новая серия", D0 + 2 * MINUTE);
    const all = replies().at(-1)?.body.content as string;
    expect(all).toContain("Ближайшие серии");
    expect(all).toContain("7-я");
  });

  it("«когда новая серия Нетакого» — честно: такого нет в списке", async () => {
    await say("когда новая серия Нетакого");
    expect(replies().at(-1)?.body.content).toContain("в вашем списке нет");
  });

  it("«что вышло нового» — вышло, а он не смотрел (6-я, он на 4-й, пропущено 2)", async () => {
    await say("что вышло нового");
    const text = replies().at(-1)?.body.content as string;
    expect(text).toContain("Вышло, а вы ещё не смотрели");
    expect(text).toContain("вышла 6-я");
    expect(text).toContain("вы на 4-й");
    expect(text).toContain("пропущено 2");
  });

  it("«что вышло нового», когда всё досмотрено — «всё досмотрено» и ближайшая", async () => {
    w.d1.sqlite.exec("UPDATE anime SET watched = 6 WHERE id = 1; UPDATE anime SET watched = 12 WHERE id = 3");
    await say("что вышло нового");
    const text = replies().at(-1)?.body.content as string;
    expect(text).toContain("всё досмотрено");
    expect(text).toContain("Ближайшая");
    expect(text).toContain("7-я");
  });

  it("вопросы про дела остаются вопросами про дела: «что у меня горит»", async () => {
    await say("что у меня горит");
    expect(replies().some((p) => p.body.content?.includes("Ничего не висит"))).toBe(true);
    expect(replies().some((p) => p.body.content?.includes("Аниме"))).toBe(false);
  });
});
