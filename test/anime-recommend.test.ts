// Аниме: «посоветуй» живой фразой (2026-11-18, анкета вкусов, волна 4): подбор по настроению («хочу что-то лёгкое») и «похожее на Фрирен».
// Разбор фраз, таблица «настроение → жанры», карточки как в субботней подборке, лимиты Cloudflare, сбой Shikimori, чужие фразы остаются делами.
// Все данные выдуманные; сеть — фальшивый fetch (свой, потому что World не знает адресов «рейтинг по жанру» и «похожее»).
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { weekNo } from "../src/anime/pick.ts";
import { GENRE_IDS } from "../src/anime/pickGenres.ts";
import { fetchMoodGenre, parsePickTitle } from "../src/anime/pickSources.ts";
import { MAX_MOOD_GENRES, MOODS, MOOD_ORDER, chooseSome, familyKey, isSequel, mergeMood, moodExclude, moodPlan, parseRecommend } from "../src/anime/recommend.ts";
import { REC_FETCH_CAP, REC_NEED } from "../src/anime/recommendRun.ts";
import { parseAnimeAsk, parseAnimeSay } from "../src/anime/say.ts";
import { parseAnimeDid, parseAnimeMark } from "../src/anime/mark.ts";
import { parseTasksQuestion } from "../src/tasksAsk.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

// ---------- разбор фраз ----------

describe("parseRecommend: по настроению", () => {
  it.each([
    // его формулировки
    ["хочу что-то лёгкое", ["light"]],
    ["Хочу что-то лёгкое!", ["light"]],
    ["что-нибудь лёгкое", ["light"]],
    ["что-то лёгкое", ["light"]],
    ["посоветуй что-нибудь смешное", ["funny"]],
    ["что-нибудь из романтики", ["romance"]],
    ["посоветуй комедию", ["funny"]],
    ["посоветуй фэнтези", ["fantasy"]],
    ["хочу что-то повеселее", ["funny"]],
    ["хочу что-то погрустнее", ["sad"]],
    ["хочу что-то с экшеном", ["action"]],
    // вокруг
    ["Хару, посоветуй что-нибудь лёгкое", ["light"]],
    ["бот, хочу что-то лёгкое", ["light"]],
    ["аниме хочу что-то лёгкое", ["light"]],
    ["посоветуйте что-нибудь романтичное", ["romance"]],
    ["посоветуй что-нибудь грустное", ["sad"]],
    ["хочу комедию", ["funny"]],
    ["хочу что-то лёгкое сегодня вечером", ["light"]],
    ["подскажи какое-нибудь фэнтези", ["fantasy"]],
    ["порекомендуй что-нибудь с экшеном пожалуйста", ["action"]],
    ["хочу что-то лёгкое и смешное", ["light", "funny"]],
    ["хочу что-то романтичное и грустное", ["sad", "romance"]], // порядок — как в таблице, а не как в фразе
  ])("«%s»", (text, moods) => {
    expect(parseRecommend(text)).toEqual({ kind: "mood", moods });
  });

  it.each([
    "", "   ", "лёгкое", "комедия", "посоветуй", "хочу", "хочу что-то", "что-нибудь", "посоветуй что-нибудь", "лёгкое аниме",
    // лишние слова и цифры — это обычное дело
    "хочу что-то лёгкое на ужин", "купить лёгкое одеяло", "хочу лёгкий ужин", "хочу комедию в 19:00", "что-нибудь лёгкое 2", "хочу что-то лёгкое поесть",
    "позвонить маме, хочу что-то лёгкое сказать", "хочу фэнтези-роман", "хочу что-то с экшеном\nи ещё",
    // вопросы про дела, свет и своё аниме — другие фразы
    "что у меня горит", "какие у меня дела", "что на сегодня", "что на неделю", "что со светом", "что смотреть сегодня", "что посмотреть", "что я смотрю", "что вышло нового",
  ])("«%s» — не просьба по настроению", (text) => {
    expect(parseRecommend(text)).toBeNull();
  });
});

describe("parseRecommend: похожее на …", () => {
  it.each([
    ["похожее на Фрирен", { kind: "similar", query: "фрирен" }],
    ["Похожее на Фрирен.", { kind: "similar", query: "фрирен" }],
    ["что-нибудь похожее на Фрирен", { kind: "similar", query: "фрирен" }],
    ["посоветуй что-нибудь похожее на Фрирен", { kind: "similar", query: "фрирен" }],
    ["хочу что-то похожее на Блич", { kind: "similar", query: "блич" }],
    ["Хару, что-нибудь похожее на Блич, пожалуйста", { kind: "similar", query: "блич" }],
    ["похожее на Класс превосходства 2 сезон", { kind: "similar", query: "класс превосходства", season: 2 }],
    ["похожее на Провожающая в последний путь Фрирен", { kind: "similar", query: "провожающая в последний путь фрирен" }],
    // слабые формы: «посоветуй как X», «вроде X», «в духе X» — нужны слова просьбы, и без такого названия фраза остаётся делом
    ["посоветуй как Фрирен", { kind: "similar", query: "фрирен", weak: true }],
    ["что-нибудь вроде Фрирен", { kind: "similar", query: "фрирен", weak: true }],
    ["хочу что-то в духе Блича", { kind: "similar", query: "блича", weak: true }],
    ["посоветуй что-нибудь типа Блич", { kind: "similar", query: "блич", weak: true }],
  ])("«%s»", (text, want) => {
    expect(parseRecommend(text)).toEqual(want);
  });

  it.each([
    "похожее на", "похожее на него", "похожее на это", "как Фрирен", "вроде Фрирен", "в духе Блича", "Хару, как дела", "что у вас там как всегда",
    "купить краску похожую на эту", "сделать похожее на Фрирен завтра", "похожее на Фрирен 5 серию", "похожее на Фрирен\nещё",
    `похожее на ${"очень длинное название ".repeat(6)}`,
  ])("«%s» — не просьба «похожее»", (text) => {
    expect(parseRecommend(text)).toBeNull();
  });

  it("другие живые фразы не меняются: вопросы про дела, аниме и отметки — как раньше", () => {
    for (const t of ["что у меня горит", "какие у меня дела", "что на сегодня", "что на неделю"]) expect(parseTasksQuestion(t)).not.toBeNull();
    expect(parseAnimeAsk("что я смотрю")).toEqual({ kind: "watching" });
    expect(parseAnimeAsk("что вышло нового")).toEqual({ kind: "news" });
    expect(parseAnimeDid("смотрел ли я Фрирен")).toMatchObject({ kind: "did", query: "фрирен" });
    expect(parseAnimeMark("Фрирен в восторге")).toMatchObject({ liked: 2 });
    expect(parseAnimeSay("глянул последнюю серию Фрирен")).toMatchObject({ query: "Фрирен" });
    for (const t of ["что я смотрю", "что вышло нового", "смотрел ли я Фрирен", "Фрирен в восторге", "глянул последнюю серию Фрирен", "забил на ДжоДжо", "Фрирен 9/10"]) expect(parseRecommend(t)).toBeNull();
  });
});

// ---------- таблица «настроение → жанры» ----------

describe("таблица настроений", () => {
  it("«лёгкое» = комедия, повседневность, романтика; без ужасов, мехи, психологического и триллеров; не длиннее 13 серий", () => {
    const p = moodPlan(["light"], []);
    expect(p).toMatchObject({ label: "лёгкое", maxEp: 13, blocked: false });
    expect(p.genres.map((g) => g.id)).toEqual([GENRE_IDS.comedy[0], GENRE_IDS.slice[0], GENRE_IDS.romance[0]]);
    expect(p.genres.map((g) => g.label)).toEqual(["комедия", "повседневность", "романтика"]);
    expect(p.skip).toEqual([14, 18, 40, 41]);
    expect(moodExclude(["horror", "mecha", "space", "bl"], p.skip)).toBe("!14,!18,!29,!33,!28,!12,!539,!40,!41"); // «не предлагать» из настроек + взрослое + лишнее для «лёгкого»
    expect(moodExclude([], [])).toBe("!12,!539"); // взрослое — всегда
  });

  it("номера жанров сверены с /api/genres Shikimori: Action 1, Drama 8, Comedy 4, Slice of Life 36, Romance 22, Fantasy 10", () => {
    expect(moodPlan(["action"], []).genres).toEqual([{ id: 1, label: "экшен" }]);
    expect(moodPlan(["sad"], []).genres).toEqual([{ id: 8, label: "драма" }]);
    expect(moodPlan(["funny"], []).genres.map((g) => g.id)).toEqual([4]);
    expect(moodPlan(["romance"], []).genres.map((g) => g.id)).toEqual([22]);
    expect(moodPlan(["fantasy"], []).genres.map((g) => g.id)).toEqual([10]);
  });

  it("несколько настроений: жанры без повторов, не больше трёх запросов, самый короткий предел серий", () => {
    const p = moodPlan(["light", "funny", "romance", "action"], []);
    expect(p.genres.length).toBeLessThanOrEqual(MAX_MOOD_GENRES);
    expect(p.genres.map((g) => g.id)).toEqual([4, 36, 22]);
    expect(p.maxEp).toBe(13);
    expect(p.label).toBe("лёгкое и смешное и романтика и экшен");
  });

  it("жанр из «не предлагать» не ищем; если ничего не осталось — план «заблокирован»", () => {
    expect(moodPlan(["light"], ["comedy"]).genres.map((g) => g.id)).toEqual([36, 22]);
    expect(moodPlan(["funny"], ["comedy"])).toMatchObject({ genres: [], blocked: true });
    expect(moodPlan(["light"], []).blocked).toBe(false);
  });

  it("у каждого настроения есть слова, жанры, предел серий; затянутого нет", () => {
    for (const m of MOOD_ORDER) {
      expect(MOODS[m].genres.length).toBeGreaterThan(0);
      expect(MOODS[m].maxEp).toBeLessThanOrEqual(26);
    }
  });

  it("запрос к сайту: один жанр, вышедшие сериалы с оценкой от 7, без обходимых жанров", async () => {
    const urls: string[] = [];
    const f = (async (u: unknown) => (urls.push(decodeURIComponent(String(u))), Response.json([]))) as unknown as typeof fetch;
    await fetchMoodGenre("2010_2026", 4, "!14,!18", 2, 50, f);
    expect(urls[0]).toContain("/api/animes?");
    for (const part of ["kind=tv", "status=released", "season=2010_2026", "score=7", "order=ranked", "limit=50", "page=2", "genre=4,!14,!18"]) expect(urls[0]).toContain(part);
  });
});

describe("продолжения и «семьи» тайтлов", () => {
  const t = (orig: string, ru = orig) => ({ ...parsePickTitle({ id: 1, name: orig, russian: ru, kind: "tv", episodes: 12 })! });
  it("«2nd Season», «II», «Второй сезон», «… 2» — продолжения; обычные названия — нет", () => {
    for (const [orig, ru] of [["Mob Psycho 100 II", "Моб Психо 100 2"], ["Foo 2nd Season", "Фу"], ["Foo Season 3", "Фу"], ["Foo", "Фу: Второй сезон"], ["Foo Part 2", "Фу"], ["Bar III", "Бар"], ["Fruits Basket: The Final", "Корзинка фруктов: Финал"], ["Nodame Cantabile Finale", "Нодамэ"], ["Foo", "Фу: Финал"]]) {
      expect(isSequel(t(orig, ru)), orig).toBe(true);
    }
    for (const [orig, ru] of [["Sousou no Frieren", "Провожающая в последний путь Фрирен"], ["Mob Psycho 100", "Моб Психо 100"], ["86", "86"], ["Steins;Gate 0", "Врата Штейна 0"], ["Bocchi the Rock!", "Одинокий рокер!"], ["Final Fantasy Origins", "Финальная фантазия"]]) {
      expect(isSequel(t(orig, ru)), orig).toBe(false);
    }
  });
  it("«семья» одна у сезонов: «sousou no frieren 2nd season» и «sousou no frieren»", () => {
    expect(familyKey("Sousou no Frieren 2nd Season")).toBe(familyKey("Sousou no Frieren"));
    expect(familyKey("Foo Season 2 Part 2")).toBe("foo");
    expect(familyKey("Mob Psycho 100")).toBe("mob psycho 100");
    expect(familyKey("2")).toBe("2"); // название из одной цифры не стираем в пустое
  });
  it("выбор: из лучших шести «семей» по случайному числу, порядок — как в рейтинге; сезоны одного тайтла вместе не идут", () => {
    const mk = (id: number, orig: string) => ({ t: { ...t(orig), mal: id } });
    const sorted = [mk(1, "A"), mk(2, "A 2nd Season"), mk(3, "B"), mk(4, "B Season 2"), mk(5, "C"), mk(6, "D")];
    expect(chooseSome(sorted, 3, () => 0).map((c) => c.t.mal)).toEqual([1, 3, 5]); // без случайности — лучшие по порядку, вторые сезоны пропущены
    const fam = chooseSome(sorted, 5, () => 0.7).map((c) => familyKey(c.t.orig));
    expect(fam).toHaveLength(4); // «семей» всего четыре
    expect(new Set(fam).size).toBe(4);
    expect(chooseSome([], 3, () => 0.5)).toEqual([]);
  });
  it("склейка списков: известное, длинное, фильмы, старое, продолжения и недавно предлагавшееся отсеиваются; несколько жанров сразу — выше", () => {
    const plan = moodPlan(["light"], []);
    const mk = (id: number, o: Record<string, unknown> = {}) => parsePickTitle({ id, name: `Title ${id}`, russian: `Тайтл ${id}`, kind: "tv", status: "released", episodes: 12, score: "7.5", aired_on: "2020-04-05", ...o })!;
    const com = [mk(100, { score: "8.0" }), mk(101), mk(102, { episodes: 24 }), mk(103, { kind: "movie" }), mk(104, { aired_on: "2004-01-01" }), mk(105, { name: "Foo 2nd Season" }), mk(106), mk(107, { episodes: 0 })];
    const rom = [mk(100, { score: "8.0" }), mk(108, { score: "9.0" })];
    const got = mergeMood([{ genre: plan.genres[0], items: com }, { genre: plan.genres[2], items: rom }], plan, new Set([101]), { r: { 106: weekNo(kyiv(2026, 11, 9)) }, b: {} }, kyiv(2026, 11, 9), new Set());
    expect(got.map((c) => c.t.mal)).toEqual([100, 108]);
    expect(got[0].labels).toEqual(["комедия", "романтика"]);
    expect(got[1].labels).toEqual(["романтика"]);
  });
});

// ---------- в боте ----------

const D0 = kyiv(2026, 11, 9, 12, 0); // понедельник
const DATE = "2026-11-09";
let w: World;

const RU_ANIME = (id: number, ru: string, o: Record<string, unknown> = {}) => ({
  id, russian: ru, name: `Title ${id}`, kind: "tv", status: "released", episodes: 12, episodes_aired: 12, score: "7.50", aired_on: "2020-04-05",
  image: { original: `/system/animes/original/${id}.jpg`, preview: `/system/animes/preview/${id}.jpg` }, url: `/animes/${id}-t`, ...o,
});
const genres = (...names: string[]) => names.map((n) => ({ id: 1, name: n, russian: n, kind: "anime" }));

class Shiki {
  /** рейтинг по номеру жанра (запрос «жанр, без …»); null — сайт не отвечает */
  genre: Record<number, unknown[] | null> = {};
  similar: Record<number, unknown[] | null> = {};
  detail: Record<number, unknown> = {};
  /** ответ на поиск по названию */
  search: unknown[] | null = [];
  down = false;
  urls: string[] = [];
  get calls(): number {
    return this.urls.length;
  }
  get rankedUrls(): string[] {
    return this.urls.filter((u) => u.includes("order=ranked")).map((u) => decodeURIComponent(u));
  }
  fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as { url?: string })?.url);
    if (!url.includes("shikimori")) return Response.json([]);
    this.urls.push(url);
    if (this.down) return new Response("down", { status: 503 });
    const dec = decodeURIComponent(url);
    const sim = /\/api\/animes\/(\d+)\/similar/.exec(url);
    if (sim) return this.similar[Number(sim[1])] === null ? new Response("x", { status: 503 }) : Response.json(this.similar[Number(sim[1])] ?? []);
    const one = /\/api\/animes\/(\d+)$/.exec(url);
    if (one) return this.detail[Number(one[1])] ? Response.json(this.detail[Number(one[1])]) : new Response("none", { status: 404 });
    if (dec.includes("search=")) return this.search === null ? new Response("x", { status: 503 }) : Response.json(this.search);
    if (dec.includes("order=ranked")) {
      const g = Number(/genre=(\d+)/.exec(dec)?.[1]);
      return this.genre[g] === null ? new Response("x", { status: 503 }) : Response.json(this.genre[g] ?? []);
    }
    return Response.json([]);
  }) as unknown as typeof fetch;
}

/** Набор для «хочу что-то лёгкое»: из каких тайтлов что выйдет, видно по названиям. */
function lightShiki(): Shiki {
  const s = new Shiki();
  s.genre[4] = [
    RU_ANIME(101, "Тайтл 101", { score: "8.00" }), // комедия и романтика сразу
    RU_ANIME(102, "Длинный 102", { episodes: 24, score: "8.50" }), // длиннее 13 серий
    RU_ANIME(103, "Тайтл 103", { score: "7.50" }), // комедия и повседневность
    RU_ANIME(104, "Продолжение 104", { name: "Title 104 2nd Season", score: "8.80" }), // второй сезон
    RU_ANIME(105, "Известное 105", { score: "8.90" }), // уже в его списке
    RU_ANIME(106, "Старое 106", { aired_on: "2005-04-05", score: "8.40" }), // до 2010
    RU_ANIME(107, "Фильм 107", { kind: "movie", score: "8.60" }),
    RU_ANIME(108, "Недавнее 108", { score: "8.30" }), // уже предлагала на этой неделе
  ];
  s.genre[36] = [RU_ANIME(103, "Тайтл 103", { score: "7.50" }), RU_ANIME(109, "Тайтл 109", { episodes: 13, score: "7.90" })];
  s.genre[22] = [RU_ANIME(110, "Тайтл 110", { score: "7.20" }), RU_ANIME(101, "Тайтл 101", { score: "8.00" })];
  return s;
}

async function run(now: number, shiki: Shiki, limit = 50) {
  const repo = w.repo(limit);
  const api = countedApi(w.discord, repo.counter);
  return runCron({ repo, api, now, env: {}, fetchFn: shiki.fetch, rand: () => 0.25, ping: async () => {}, log: () => {} });
}
const anime = () => w.d1.q<{ mal_id: number; title_ru: string; liked: number; status: string }>("SELECT * FROM anime ORDER BY id");
const items = () => w.d1.q("SELECT 1 FROM items").length;
const replies = () => w.discord.posted.filter((p) => p.channel === CH_BOT);
const last = () => replies().at(-1);
const lastText = () => (last()?.body.content as string | undefined) ?? "";
const embeds = () => last()?.body.embeds ?? [];
const embedTitles = () => embeds().map((e) => e.title);
const meta = (k: string) => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const quietAnime = (date: string) => [setMeta("anime_refresh", date), setMeta("anime_voice", date), setMeta("anime_ask", date), setMeta("anime_start", date)];

async function ask(text: string, shiki: Shiki, at = D0 + MINUTE, limit = 50) {
  w.discord.say(CH_BOT, OWNER, text);
  return run(at, shiki, limit);
}

beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  await w.repo().exec(quietAnime(DATE));
  w.d1.sqlite.exec(
    `INSERT INTO anime (mal_id, title_ru, title_orig, status, watched, episodes, src_status, added_at, updated_at, liked)
       VALUES (2, 'Блич', 'Bleach', 'done', 12, 12, 'FINISHED', 0, 0, 2),
              (3, 'Кофейня', 'Cafe', 'done', 12, 12, 'FINISHED', 0, 0, 1),
              (105, 'Известное 105', 'Title 105', 'planned', 0, 12, 'FINISHED', 0, 0, 0)`,
  );
  await run(D0, new Shiki()); // первый запуск запоминает конец канала
});

describe("cron: подбор по настроению", () => {
  it("«хочу что-то лёгкое»: три запроса по жанрам, 3 карточки как в субботней подборке; известное, длинное, продолжения и недавнее — мимо", async () => {
    await w.repo().exec([setMeta("anime_pick_seen", JSON.stringify({ r: { 108: weekNo(D0) }, b: {} }))]);
    const s = lightShiki();
    await ask("хочу что-то лёгкое", s);
    expect(items()).toBe(0);
    expect(anime()).toHaveLength(3); // в список ничего не добавлено
    expect(embedTitles()).toEqual(["Подбор: Тайтл 101", "Подбор: Тайтл 103", "Подбор: Тайтл 109"]);
    expect(lastText()).toContain("Подбор: лёгкое");
    expect(lastText()).toContain("Искала: комедия, повседневность, романтика · не длиннее 13 серий.");
    expect(last()?.body.components ?? []).toEqual([]); // кнопок не прибавилось
    // форма карточки: почему подойдёт, сколько серий и оценка, обложка, ссылка
    const [a, b, c] = embeds();
    expect(a.description).toBe("Под настроение «лёгкое»: комедия, романтика.\n12 серий · оценка на Shikimori 8,0");
    expect(b.description).toContain("комедия, повседневность.");
    expect(c.description).toContain("13 серий · оценка на Shikimori 7,9");
    expect(a.thumbnail?.url).toBe("https://shikimori.io/system/animes/preview/101.jpg");
    expect(a.url).toBe("https://shikimori.io/animes/101-t");
    for (const e of embeds()) expect((e.description ?? "").split("\n").length).toBeLessThanOrEqual(3);
    // обращения: по одному на жанр (комедия 4, повседневность 36, романтика 22), в каждом «без ужасов, мехи, космоса, BL, взрослого, психологического и триллеров»
    expect(s.calls).toBe(3);
    expect(s.rankedUrls.map((u) => /genre=(\d+)/.exec(u)?.[1])).toEqual(["4", "36", "22"]);
    for (const u of s.rankedUrls) {
      expect(u).toContain("genre=");
      expect(u).toMatch(/,!14,!18,!29,!33,!28,!12,!539,!40,!41/);
      expect(u).toContain("season=2010_2026");
      expect(u).toContain("status=released");
    }
    expect(s.calls).toBeLessThanOrEqual(REC_FETCH_CAP);
    // что предложили — в общую память с субботней подборкой
    const seen = JSON.parse(meta("anime_pick_seen") as string) as { r: Record<string, number> };
    expect(Object.keys(seen.r).map(Number).sort()).toEqual([101, 103, 108, 109]);
  });

  it("повторная просьба даёт другое: уже показанного нет, а если больше нечего — честно «больше подходящего не нашла»", async () => {
    await w.repo().exec([setMeta("anime_pick_seen", JSON.stringify({ r: { 108: weekNo(D0) }, b: {} }))]);
    const s = lightShiki();
    await ask("что-нибудь лёгкое", s);
    expect(embedTitles()).toHaveLength(3);
    await ask("что-нибудь лёгкое", s, D0 + 2 * MINUTE);
    expect(embedTitles()).toEqual(["Подбор: Тайтл 110"]); // остался один: Тайтл 101, 103, 109 показаны, остальные не подходят
    expect(lastText()).toContain("Больше подходящего не нашла");
    await ask("что-нибудь лёгкое", s, D0 + 3 * MINUTE);
    expect(lastText()).toContain("ничего нового не нашла");
    expect(embeds()).toEqual([]);
    expect(items()).toBe(0);
    expect(s.calls).toBeLessThanOrEqual(3 * REC_FETCH_CAP);
  });

  it("с характером «горничная» у каждой карточки третья строка — реплика Хару (одна); нейтральный — две строки", async () => {
    await w.repo().exec([setSetting("character", "maid"), setSetting("mood_on", "1")]);
    await ask("хочу что-то лёгкое", lightShiki());
    expect(embeds()).toHaveLength(3);
    for (const e of embeds()) {
      expect((e.description ?? "").split("\n")).toHaveLength(3);
      expect((e.description ?? "").split("\n")[2]).toMatch(/настроение|Выбирала/);
    }
  });

  it.each([
    ["что-нибудь из романтики", 22, "Подбор: романтика", "Искала: романтика · не длиннее 26 серий."],
    ["посоветуй комедию", 4, "Подбор: смешное", "Искала: комедия"],
    ["хочу что-то погрустнее", 8, "Подбор: грустное", "Искала: драма"],
    ["хочу что-то с экшеном", 1, "Подбор: экшен", "Искала: экшен"],
    ["посоветуй фэнтези", 10, "Подбор: фэнтези", "Искала: фэнтези"],
  ])("«%s»: один запрос по жанру %s, предел 26 серий", async (text, id, head, line) => {
    const s = new Shiki();
    s.genre[id] = [RU_ANIME(201, "Тайтл 201", { episodes: 26 }), RU_ANIME(202, "Тайтл 202", { episodes: 27 }), RU_ANIME(203, "Тайтл 203")];
    await ask(text, s);
    expect(lastText()).toContain(head);
    expect(lastText()).toContain(line);
    expect(embedTitles()).toEqual(["Подбор: Тайтл 201", "Подбор: Тайтл 203"]); // 27 серий — длиннее предела
    expect(s.rankedUrls.every((u) => new RegExp(`genre=${id},`).test(u))).toBe(true);
    expect(s.rankedUrls.length).toBeGreaterThanOrEqual(1);
    expect(s.rankedUrls.length).toBeLessThanOrEqual(2); // вторая страница, если карточек меньше трёх
  });

  it("«не предлагать» и жанры берутся из настроек: комедия в «не предлагать» — «лёгкое» ищет без неё, «смешное» не ищет вовсе", async () => {
    await w.repo().exec([setSetting("pick_avoid", "horror, mecha, comedy")]);
    const s = lightShiki();
    await ask("хочу что-то лёгкое", s);
    expect(s.rankedUrls.map((u) => /genre=(\d+)/.exec(u)?.[1])).toEqual(["36", "22"]);
    expect(s.rankedUrls.every((u) => u.includes("!14,!18,!4,!12,!539,!40,!41"))).toBe(true); // «не предлагать» из настроек, взрослое, лишнее для «лёгкого»
    const calls = s.calls;
    await ask("посоветуй комедию", s, D0 + 2 * MINUTE);
    expect(lastText()).toContain("«смешное» у вас в списке «не предлагать»");
    expect(s.calls).toBe(calls); // сайт зря не трогали
  });

  it("если вторая страница нужна, а запросов за раз не больше REC_FETCH_CAP", async () => {
    const s = new Shiki();
    s.genre[4] = [RU_ANIME(301, "Тайтл 301")];
    s.genre[36] = [];
    s.genre[22] = [];
    await ask("хочу что-то лёгкое", s);
    expect(embedTitles()).toEqual(["Подбор: Тайтл 301"]);
    expect(s.calls).toBe(6); // три жанра на первой странице и ещё раз на другой: карточек меньше трёх
    expect(s.calls).toBeLessThanOrEqual(REC_FETCH_CAP);
  });
});

describe("cron: подбор по настроению — лимиты и сбои", () => {
  it("при любом запасе запуск не выходит за свой лимит, обращений к сайту не больше REC_FETCH_CAP: либо карточки, либо честное «сейчас не получится»", async () => {
    let noRoom = 0;
    let full = 0;
    for (let limit = 8; limit <= 40; limit++) {
      w = new World();
      await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
      await w.repo().exec(quietAnime(DATE));
      await run(D0, new Shiki());
      const s = lightShiki();
      const r = await ask("хочу что-то лёгкое", s, D0 + MINUTE, limit);
      expect(r.subrequests, `запас ${limit}`).toBeLessThanOrEqual(limit);
      expect(s.calls, `запас ${limit}`).toBeLessThanOrEqual(REC_FETCH_CAP);
      expect(items(), `запас ${limit}`).toBe(0);
      if (lastText().includes("Сейчас не получится")) {
        noRoom++;
        expect(s.calls, `запас ${limit}`).toBe(0); // не начинали: сайт не трогали
        expect(embeds(), `запас ${limit}`).toEqual([]);
      } else if (embeds().length) {
        full++;
        expect(embeds().length, `запас ${limit}`).toBeGreaterThanOrEqual(1);
      }
    }
    expect(noRoom).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
    expect(REC_NEED).toBeGreaterThan(REC_FETCH_CAP);
  });

  it("Shikimori не отвечает: честное сообщение, два сбоя подряд — больше не зовём, в память «предлагала» ничего, дело не заводится", async () => {
    const s = lightShiki();
    s.down = true;
    await ask("хочу что-то лёгкое", s);
    expect(lastText()).toContain("Shikimori сейчас не отвечает");
    expect(s.calls).toBe(2);
    expect(embeds()).toEqual([]);
    expect(meta("anime_pick_seen")).toBeUndefined();
    expect(items()).toBe(0);
  });

  it("один жанр не ответил, остальные да — карточки есть", async () => {
    const s = lightShiki();
    s.genre[4] = null;
    await ask("хочу что-то лёгкое", s);
    expect(embedTitles()).toEqual(["Подбор: Тайтл 101", "Подбор: Тайтл 109", "Подбор: Тайтл 103"]);
    expect(lastText()).toContain("Подбор: лёгкое");
    expect(s.calls).toBe(3);
  });

  it("сайт ответил, но ничего подходящего нет: честная строка, а не пустой ответ", async () => {
    await ask("хочу что-то лёгкое", new Shiki());
    expect(lastText()).toContain("ничего нового не нашла");
    expect(embeds()).toEqual([]);
    expect(items()).toBe(0);
  });
});

describe("cron: «похожее на …»", () => {
  const similarSet = (): Shiki => {
    const s = new Shiki();
    s.similar[2] = [
      RU_ANIME(401, "Похожее хорошее 401", { score: "8.20" }),
      RU_ANIME(402, "Похожее с ужасами 402", { score: "8.10" }),
      RU_ANIME(3, "Кофейня", { score: "8.90" }), // уже в списке
      RU_ANIME(404, "Старое 404", { score: "8.50", aired_on: "2005-01-01" }),
      RU_ANIME(405, "Бесконечное 405", { score: "8.40", episodes: 100 }),
      RU_ANIME(406, "Второй сезон 406", { name: "Other Show 2nd Season", score: "8.30" }),
      RU_ANIME(407, "Похожее 407", { score: "7.90" }),
      RU_ANIME(408, "Похожее 408", { score: "7.80" }),
      RU_ANIME(409, "Похожее 409", { score: "7.70" }),
      RU_ANIME(410, "Лишнее 410", { score: "7.60" }),
    ];
    s.detail[401] = RU_ANIME(401, "Похожее хорошее 401", { score: "8.20", franchise: "good", genres: genres("Fantasy", "Romance") });
    s.detail[402] = RU_ANIME(402, "Похожее с ужасами 402", { score: "8.10", genres: genres("Horror", "Fantasy") });
    s.detail[407] = RU_ANIME(407, "Похожее 407", { score: "7.90", genres: genres("Comedy") });
    s.detail[408] = RU_ANIME(408, "Похожее 408", { score: "7.80", franchise: "good", genres: genres("Comedy") }); // та же «семья» у сайта, что и у 401
    s.detail[409] = RU_ANIME(409, "Похожее 409", { score: "7.70", genres: genres("Romance") });
    s.detail[410] = RU_ANIME(410, "Лишнее 410", { score: "7.60", genres: genres("Comedy") });
    return s;
  };

  it("название из его списка: поиска на сайте нет; «Похоже на …, от которого вы были в восторге»; ужасы, известное, старое, длинное, продолжения — мимо", async () => {
    const s = similarSet();
    await ask("похожее на Блич", s);
    expect(items()).toBe(0);
    expect(lastText()).toContain("Похожее на «Блич»");
    expect(embedTitles()).toEqual(["Похожее: Похожее хорошее 401", "Похожее: Похожее 407", "Похожее: Похожее 409"]); // 402 — ужасы, 408 — одна «семья» с 401
    for (const e of embeds()) expect(e.description).toContain("Похоже на «Блич», от которого вы были в восторге.");
    expect(embeds()[0].description).toContain("12 серий · оценка на Shikimori 8,2");
    expect(embeds()[0].thumbnail?.url).toBe("https://shikimori.io/system/animes/preview/401.jpg");
    expect(last()?.body.components ?? []).toEqual([]);
    expect(s.urls.some((u) => decodeURIComponent(u).includes("search="))).toBe(false);
    expect(s.calls).toBeLessThanOrEqual(REC_FETCH_CAP); // «похожее» 1 + карточки не больше 5
    expect(s.urls[0]).toContain("/api/animes/2/similar");
    expect(JSON.parse(meta("anime_pick_seen") as string).r).toEqual({ 401: weekNo(D0 + MINUTE), 407: weekNo(D0 + MINUTE), 409: weekNo(D0 + MINUTE) });
  });

  it("«что-нибудь похожее на …» и «посоветуй как …» работают так же; у названия с оценкой «понравилось» своя строка «почему»", async () => {
    const s = similarSet();
    s.similar[3] = s.similar[2];
    await ask("посоветуй как Кофейня", s);
    expect(lastText()).toContain("Похожее на «Кофейня»");
    expect(embeds()[0].description).toContain("Похоже на «Кофейня», которое вам понравилось.");
    await ask("что-нибудь похожее на Кофейня", s, D0 + 2 * MINUTE);
    expect(lastText()).toContain("Похожее на «Кофейня»");
  });

  it("название не из списка: поиск на сайте (одно совпадение берём), дальше «похожее»; имя в списке не появляется", async () => {
    const s = similarSet();
    s.search = [{ id: 7, russian: "Новинка Седьмая", name: "Shichi", kind: "tv", status: "released", episodes: 12, aired_on: "2023-01-01" }];
    s.similar[7] = s.similar[2];
    await ask("что-нибудь похожее на Новинка", s);
    expect(s.urls.filter((u) => decodeURIComponent(u).includes("search=")).length).toBe(1);
    expect(lastText()).toContain("Похожее на «Новинка Седьмая»");
    expect(embeds()[0].description).toContain("Похоже на «Новинка Седьмая».");
    expect(anime()).toHaveLength(3);
    expect(items()).toBe(0);
  });

  it("несколько совпадений — короткий список «какое из них» обычным текстом, без кнопок и без «похожего»", async () => {
    const s = similarSet();
    s.search = [
      { id: 7, russian: "Новинка Седьмая", name: "Shichi", kind: "tv", status: "released", episodes: 12, aired_on: "2023-01-01" },
      { id: 8, russian: "Новинка Восьмая", name: "Hachi", kind: "tv", status: "released", episodes: 24, aired_on: "2021-01-01" },
    ];
    await ask("похожее на Новинка", s);
    expect(lastText()).toContain("Нашла несколько");
    expect(lastText()).toContain("• Новинка Седьмая (2023, 12 сер.)");
    expect(lastText()).toContain("• Новинка Восьмая (2021, 24 сер.)");
    expect(lastText()).toContain("«похожее на Новинка Седьмая»");
    expect(last()?.body.components ?? []).toEqual([]);
    expect(embeds()).toEqual([]);
    expect(s.urls.some((u) => u.includes("/similar"))).toBe(false);
    expect(items()).toBe(0);
  });

  it("совпадение по названию целиком из нескольких — берём его без списка", async () => {
    const s = similarSet();
    s.search = [
      { id: 7, russian: "Новинка", name: "Shichi", kind: "tv", status: "released", episodes: 12, aired_on: "2023-01-01" },
      { id: 8, russian: "Новинка: фильм", name: "Hachi", kind: "movie", status: "released", episodes: 1, aired_on: "2021-01-01" },
    ];
    s.similar[7] = s.similar[2];
    await ask("похожее на Новинка", s);
    expect(lastText()).toContain("Похожее на «Новинка»");
    expect(s.urls.some((u) => u.includes("/animes/7/similar"))).toBe(true);
  });

  it("«похожее на Нетакого» — честно «не нашла на Shikimori», дело не заводится", async () => {
    await ask("похожее на Нетакого", similarSet());
    expect(lastText()).toContain("Не нашла «нетакого» на Shikimori");
    expect(items()).toBe(0);
  });

  it("слабая форма с названием, которого нет ни в списке, ни на сайте, остаётся делом: «посоветуй как приготовить борщ»", async () => {
    const s = similarSet();
    await ask("посоветуй как приготовить борщ", s);
    expect(items()).toBe(1);
    expect(s.calls).toBe(1); // одна проверка на сайте, больше ничего
    expect(embeds()).toEqual([]);
  });

  it("у сайта нет похожих — честно; сайт не отвечает — честно; ничего подходящего — честно", async () => {
    const s = new Shiki();
    await ask("похожее на Блич", s);
    expect(lastText()).toContain("У Shikimori нет похожих на «Блич»");
    s.similar[2] = null;
    await ask("похожее на Блич", s, D0 + 2 * MINUTE);
    expect(lastText()).toContain("Shikimori сейчас не отвечает");
    const s2 = new Shiki();
    s2.similar[2] = [RU_ANIME(3, "Кофейня"), RU_ANIME(402, "Ужасы 402")];
    s2.detail[402] = RU_ANIME(402, "Ужасы 402", { genres: genres("Horror") });
    await ask("похожее на Блич", s2, D0 + 3 * MINUTE);
    expect(lastText()).toContain("Похожего на «Блич» подходящего не нашла");
    expect(embeds()).toEqual([]);
    expect(items()).toBe(0);
  });

  it("лимит: запаса мало — «сейчас не получится», сайт не трогали; при любом запасе подзапросов не больше лимита", async () => {
    for (let limit = 8; limit <= 36; limit++) {
      w = new World();
      await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
      await w.repo().exec(quietAnime(DATE));
      w.d1.sqlite.exec(`INSERT INTO anime (mal_id, title_ru, status, added_at, updated_at, liked) VALUES (2, 'Блич', 'done', 0, 0, 2)`);
      await run(D0, new Shiki());
      const s = similarSet();
      const r = await ask("похожее на Блич", s, D0 + MINUTE, limit);
      expect(r.subrequests, `запас ${limit}`).toBeLessThanOrEqual(limit);
      expect(s.calls, `запас ${limit}`).toBeLessThanOrEqual(REC_FETCH_CAP);
      if (lastText().includes("Сейчас не получится")) expect(s.calls, `запас ${limit}`).toBe(0);
    }
  });
});

describe("cron: чужие фразы остаются делами, вопросы — вопросами", () => {
  it("«хочу что-то лёгкое на ужин», «купить лёгкое одеяло», «что смотреть сегодня», «позвонить как Фрирен» — обычные дела; на сайт не ходили", async () => {
    const s = lightShiki();
    await ask("хочу что-то лёгкое на ужин", s);
    await ask("купить лёгкое одеяло", s, D0 + 2 * MINUTE);
    await ask("что смотреть сегодня", s, D0 + 3 * MINUTE);
    expect(items()).toBe(3);
    expect(s.calls).toBe(0);
  });

  it("«что у меня горит» и «что на сегодня» — вопросы про дела, а не подбор", async () => {
    const s = lightShiki();
    await ask("что у меня горит", s);
    expect(replies().some((p) => p.body.content?.includes("Ничего не висит"))).toBe(true);
    await ask("что на сегодня", s, D0 + 2 * MINUTE);
    expect(embeds()).toEqual([]);
    expect(s.calls).toBe(0);
    expect(items()).toBe(0);
  });

  it("с «аниме» впереди «хочу что-то лёгкое» — подбор, а не «в планах» с названием «что-то лёгкое»; без обращения то же", async () => {
    const s = lightShiki();
    await ask("аниме хочу что-то лёгкое", s);
    expect(embedTitles().length).toBeGreaterThan(0);
    expect(anime()).toHaveLength(3);
    await ask("хочу что-то лёгкое", s, D0 + 2 * MINUTE);
    expect(anime()).toHaveLength(3);
    expect(items()).toBe(0);
  });

  it("отметки и оценки числом работают рядом с подбором", async () => {
    const s = lightShiki();
    await ask("Блич 3 из 10", s);
    expect(anime()[0].liked).toBe(-2);
    await ask("хочу что-то лёгкое", s, D0 + 2 * MINUTE);
    expect(embedTitles().length).toBeGreaterThan(0);
    await ask("Блич 10/10", s, D0 + 3 * MINUTE);
    expect(anime()[0].liked).toBe(2);
  });
});
