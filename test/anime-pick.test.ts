// Субботняя подборка «что посмотреть» от Хару: пять частей, лимиты подзапросов, сбой сайта, повтор за неделю, тихие часы, настройки.
// Все данные выдуманные; сеть — фальшивый fetch (свой, потому что World не знает адресов «похожее» и «сезон»).
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { type Anime } from "../src/anime/core.ts";
import { PICK_FETCH_CAP, PICK_TRIES, dubNote, markSeen, parseSeen, pickPlanned, weekNo } from "../src/anime/pick.ts";
import { PICK_NEED } from "../src/anime/pickCron.ts";
import { DEFAULT_AVOID, DEFAULT_LIKES, GENRE_IDS, classify, excludeParam, nextPickAt, parseGenreList } from "../src/anime/pickGenres.ts";
import { parsePickTitle, seasonOf } from "../src/anime/pickSources.ts";
import { HOUR } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const SAT = (h: number, mi = 0, d = 14) => kyiv(2026, 11, d, h, mi); // 14 ноября 2026 — суббота
const DAY = 24 * HOUR;
const DATE = "2026-11-14";

// ---------- выдуманный Shikimori ----------

const RU: Record<string, string> = { Romance: "Романтика", Fantasy: "Фэнтези", Comedy: "Комедия", Horror: "Ужасы", Mecha: "Меха", Space: "Космос", Drama: "Драма", Isekai: "Исэкай", "Slice of Life": "Повседневность", Adventure: "Приключения" };
const genres = (...names: string[]) => names.map((n) => ({ id: 1, name: n, russian: RU[n] ?? n, kind: "anime" }));
const title = (id: number, ru: string, o: Record<string, unknown> = {}) => ({
  id, russian: ru, name: `Title ${id}`, kind: "tv", status: "released", episodes: 12, episodes_aired: 12, score: "7.50", aired_on: "2024-04-05",
  image: { original: `/system/animes/original/${id}.jpg`, preview: `/system/animes/preview/${id}.jpg` }, url: `/animes/${id}-t`, ...o,
});

class Shiki {
  /** сезон по номеру жанра (запрос «жанр 22, без ужасов…»; в ответе жанров нет, как у настоящего сайта) и страница рейтинга; null — сайт не отвечает */
  season: Record<number, unknown[] | null> = {};
  ranked: unknown[] | null = [];
  similar: Record<number, unknown[] | null> = {};
  /** карточки по номеру (с жанрами); нет записи — 404 */
  detail: Record<number, unknown> = {};
  down = false;
  urls: string[] = [];
  get pickCalls(): number {
    return this.urls.length;
  }
  /** запросы про новинки сезона (адреса в обычном виде) */
  get genreUrls(): string[] {
    return this.urls.filter((u) => u.includes("order=popularity")).map((u) => decodeURIComponent(u));
  }
  fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as { url?: string })?.url);
    if (!url.includes("shikimori")) return Response.json([]);
    this.urls.push(url);
    if (this.down) return new Response("down", { status: 503 });
    const sim = /\/api\/animes\/(\d+)\/similar/.exec(url);
    if (sim) return this.similar[Number(sim[1])] === undefined ? Response.json([]) : this.similar[Number(sim[1])] === null ? new Response("x", { status: 503 }) : Response.json(this.similar[Number(sim[1])]);
    const one = /\/api\/animes\/(\d+)$/.exec(url);
    if (one) return this.detail[Number(one[1])] ? Response.json(this.detail[Number(one[1])]) : new Response("none", { status: 404 });
    if (url.includes("order=popularity")) {
      const g = Number(/genre=(\d+)/.exec(decodeURIComponent(url))?.[1]);
      return this.season[g] === null ? new Response("x", { status: 503 }) : Response.json(this.season[g] ?? []);
    }
    if (url.includes("order=ranked")) return this.ranked === null ? new Response("x", { status: 503 }) : Response.json(this.ranked);
    return Response.json([]);
  }) as unknown as typeof fetch;
}

/** Набор «как у Ihor, только выдуманный»: из каких тайтлов что выйдет, видно в тестах ниже. */
function fullShiki(): Shiki {
  const s = new Shiki();
  s.detail[20] = title(20, "Лавка зелий", { status: "ongoing", episodes: 12, episodes_aired: 4, score: "7.90", genres: genres("Romance", "Fantasy") });
  const nov = (id: number, o: Record<string, unknown> = {}) => title(id, `Новинка ${id}`, { status: "ongoing", episodes: 12, episodes_aired: 6, score: "7.40", aired_on: "2026-10-04", ...o });
  s.season = {
    22: [nov(103), nov(108, { score: "0.00" })], // романтика
    10: [nov(106, { score: "7.10" }), nov(103)], // фэнтези
    4: [nov(103), nov(107, { score: "6.90" })], // комедия
    36: [], // повседневность
    9: [nov(108, { score: "0.00" })], // этти
    35: [], // гарем
  };
  s.similar[30] = [
    title(31, "Кофейня (уже в списке)", { score: "8.9" }),
    title(203, "Старое", { score: "8.5", aired_on: "2005-04-01" }),
    title(204, "Бесконечное", { score: "8.4", episodes: 100 }),
    title(202, "Похожее с ужасами", { score: "7.9" }),
    title(201, "Похожее хорошее", { score: "8.2" }),
  ];
  s.detail[201] = title(201, "Похожее хорошее", { score: "8.2", episodes: 24, franchise: "good_one", genres: genres("Fantasy", "Romance") });
  s.detail[202] = title(202, "Похожее с ужасами", { score: "7.9", genres: genres("Horror", "Fantasy") });
  s.ranked = [301, 302, 303].map((id) => title(id, `Рейтинг ${id}`, { score: "8.60", aired_on: "2018-04-01", episodes: 13 }));
  s.detail[301] = title(301, "Рейтинг 301", { score: "8.60", genres: genres("Horror") });
  s.detail[302] = title(302, "Рейтинг 302", { score: "8.60", episodes: 13, franchise: "other_one", genres: genres("Adventure", "Drama") });
  s.detail[303] = title(303, "Рейтинг 303", { score: "8.60", genres: genres("Romance") });
  return s;
}

// ---------- мир ----------

let w: World;
type RowIn = { mal: number; name: string; status: "watching" | "planned" | "done" | "dropped"; watched?: number; aired?: number; airedAt?: number | null; episodes?: number; src?: "RELEASING" | "FINISHED"; liked?: number; notify?: number; lag?: number | null; added?: number; updated?: number };

function add(o: RowIn): void {
  w.d1.sqlite.exec(
    `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, aired_ep, aired_at, asked_ep, notify, liked, voice_lag, added_at, updated_at, last_move_at)
     VALUES (${o.mal}, '${o.name}', '${o.status}', ${o.watched ?? 0}, ${o.episodes ?? 12}, '${o.src ?? "FINISHED"}', ${o.aired ?? 0}, ${o.airedAt ?? "NULL"}, ${o.aired ?? 0}, ${o.notify ?? 1}, ${o.liked ?? 0}, ${o.lag ?? "NULL"}, ${o.added ?? SAT(0, 0, 1)}, ${o.updated ?? SAT(0, 0, 1)}, ${o.updated ?? SAT(0, 0, 1)})`,
  );
}

/** Тот же набор, что у Ihor по смыслу: смотрю, в планах, любимое и просто просмотренное (все названия выдуманные). */
function seedTable(): void {
  add({ mal: 10, name: "Меч и тень", status: "watching", watched: 5, aired: 7, airedAt: kyiv(2026, 11, 13, 19), episodes: 24, src: "RELEASING", lag: 150 });
  add({ mal: 11, name: "Чайная лавка", status: "watching", watched: 3, aired: 4, airedAt: SAT(10), episodes: 12, src: "RELEASING", lag: 300 });
  add({ mal: 12, name: "Тихая гавань", status: "watching", watched: 6, aired: 6, episodes: 12, src: "RELEASING" });
  add({ mal: 13, name: "Без звука", status: "watching", watched: 1, aired: 5, airedAt: SAT(9), episodes: 12, src: "RELEASING", notify: 0 });
  add({ mal: 20, name: "Лавка зелий", status: "planned", aired: 4, episodes: 12, src: "RELEASING", added: SAT(0, 0, 2) });
  add({ mal: 21, name: "Давний план", status: "planned", episodes: 12, src: "FINISHED", added: SAT(0, 0, 3) });
  add({ mal: 30, name: "Невеста дракона", status: "done", watched: 12, liked: 2, updated: SAT(0, 0, 10) });
  add({ mal: 31, name: "Кофейня", status: "done", watched: 12, liked: 1, updated: SAT(0, 0, 5) });
  add({ mal: 40, name: "Бросил давно", status: "dropped", watched: 2 });
}

/** Метки «уже сделано сегодня» для остальных аниме-дел, чтобы в канале были только сообщения подборки. */
const quietAnime = (date: string) => [setMeta("anime_refresh", date), setMeta("anime_voice", date), setMeta("anime_ask", date), setMeta("anime_start", date)];

async function run(now: number, shiki: Shiki, limit = 50) {
  const repo = w.repo(limit);
  const api = countedApi(w.discord, repo.counter);
  return runCron({ repo, api, now, env: {}, fetchFn: shiki.fetch, rand: () => 0.25, ping: async () => {}, log: () => {} });
}
const picks = () => w.discord.posted.filter((p) => p.channel === CH_REMIND && p.body.content?.includes("Подборка на субботу"));
const meta = (k: string) => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const embedTitles = (p: { body: { embeds?: { title?: string }[] } }) => (p.body.embeds ?? []).map((e) => e.title);

beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off", anime_pick: "12:00" } });
  await w.repo().exec(quietAnime(DATE));
});

describe("подборка: пять частей одним сообщением", () => {
  it("серии, из «В планах», две новинки в его жанрах, похожее и сюрприз; красные линии и нелюбимое не попадают", async () => {
    seedTable();
    const s = fullShiki();
    const r = await run(SAT(12), s);
    const p = picks();
    expect(p).toHaveLength(1);
    const text = p[0].body.content as string;

    // 1. серии: только «Смотрю» с колокольчиком; озвучка (русская), а не оригинал
    expect(text).toContain("Вышло, а вы ещё не смотрели** (2)");
    expect(text).toContain("**Меч и тень** — вышла 7-я (вчера 19:00), вы на 5-й, пропущено 2 · 🎙 в озвучке по обычной задержке уже есть");
    expect(text).toMatch(/\*\*Чайная лавка\*\* — вышла 4-я \(сегодня 10:00\), вы на 3-й · ⏳ озвучка AniLibria примерно сегодня 15:00/);
    expect(text).not.toContain("Тихая гавань");
    expect(text).not.toContain("Без звука");

    // 2–5: карточки по одной на рекомендацию, порядок как в просьбе
    const titles = embedTitles(p[0]);
    expect(titles).toEqual([
      "Из «В планах»: Лавка зелий",
      "Новинка сезона: Новинка 103",
      "Новинка сезона: Новинка 108",
      "Похожее: Похожее хорошее",
      "Сюрприз: Рейтинг 302",
    ]);
    const all = (p[0].body.embeds ?? []).map((e) => `${e.title}\n${e.description}`).join("\n");
    expect(all).not.toMatch(/Новинка (106|107)|Рейтинг (301|303)|ужас|Кофейня \(уже/); // выбрано лучшее по числу совпавших жанров; ужасы и уже известное — нет

    // формат: почему подойдёт, сколько серий, оценка на сайте; обложка; ссылка в заголовке
    const planned = (p[0].body.embeds ?? [])[0];
    expect(planned.description).toContain("Сейчас выходит, уже вышло 4 серии");
    expect(planned.description).toContain("идёт, вышло 4 из 12 · оценка на Shikimori 7,9");
    expect(planned.thumbnail?.url).toBe("https://shikimori.io/system/animes/preview/20.jpg");
    expect(planned.url).toBe("https://shikimori.io/animes/20-t");
    const fresh = (p[0].body.embeds ?? [])[1];
    expect(fresh.description).toContain("Новинка сезона, ваши жанры: романтика, фэнтези, комедия."); // нашлась в трёх запросах — выше всех
    expect(fresh.description).toContain("идёт, вышло 6 из 12 · оценка на Shikimori 7,4");
    expect((p[0].body.embeds ?? [])[2].description).toContain("Новинка сезона, ваши жанры: романтика, этти.");
    expect((p[0].body.embeds ?? [])[2].description).toContain("оценки пока нет"); // у новинки без оценки так и пишем
    expect((p[0].body.embeds ?? [])[3].description).toContain("Похоже на «Невеста дракона», от которого вы были в восторге.");
    expect((p[0].body.embeds ?? [])[4].description).toContain("Сюрприз: не из ваших обычных жанров, но высоко оценён.");
    for (const e of p[0].body.embeds ?? []) expect((e.description ?? "").split("\n").length).toBeLessThanOrEqual(3); // 2–3 строки на рекомендацию
    expect(text).not.toMatch(/где смотреть/i);

    // новинки: по одному запросу на любимый жанр (у исэкая на сайте нет жанра), в каждом «без ужасов, мехи, космоса, BL и взрослого»
    expect(s.genreUrls).toHaveLength(6);
    expect(s.genreUrls.every((u) => /genre=\d+,!14,!18,!29,!33,!28,!12,!539/.test(u) && u.includes("season=fall_2026") && u.includes("kind=tv"))).toBe(true);
    expect(s.genreUrls.map((u) => /genre=(\d+)/.exec(u)?.[1])).toEqual(["22", "10", "4", "36", "9", "35"]);

    // запись и лимит
    expect(meta("anime_pick")).toBe(DATE);
    expect(s.pickCalls).toBeLessThanOrEqual(PICK_FETCH_CAP);
    expect(r.subrequests).toBeLessThanOrEqual(50);
    expect(JSON.parse(meta("anime_pick_seen") as string)).toEqual({ r: { 20: weekNo(SAT(12)), 103: weekNo(SAT(12)), 108: weekNo(SAT(12)), 201: weekNo(SAT(12)), 302: weekNo(SAT(12)) }, b: { 30: weekNo(SAT(12)) } });
  });

  it("с характером «горничная» в каждой карточке третья строка — реплика Хару и она одна; нейтральный — без неё", async () => {
    seedTable();
    await w.repo().exec([setSetting("character", "maid"), setSetting("mood_on", "1")]);
    await run(SAT(12), fullShiki());
    const p = picks()[0];
    for (const e of p.body.embeds ?? []) expect((e.description ?? "").split("\n").length).toBe(3);
    expect(p.body.content?.split("\n")[1]).toMatch(/Хару|подборка|Суббота|собрала/i);
  });

  it("очень много пропущенного и длинные названия: текст не длиннее лимита Discord, лишнее — «и ещё N»", async () => {
    for (let i = 0; i < 18; i++) add({ mal: 500 + i, name: `Очень длинное название тайтла номер ${i} и ещё много слов для проверки длины строки`, status: "watching", watched: 1, aired: 9, airedAt: SAT(8), episodes: 24, src: "RELEASING", lag: 400 });
    await run(SAT(12), fullShiki());
    const p = picks()[0];
    expect(p.body.content?.length).toBeLessThanOrEqual(2000);
    expect(p.body.content).toContain("Вышло, а вы ещё не смотрели** (18)");
    expect(p.body.content).toMatch(/…и ещё \d+: список — «что вышло нового»\./);
    expect((p.body.embeds ?? []).reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0), 0)).toBeLessThan(6000);
  });

  it("нет данных у хозяина: серий нет, «из планов» и «похожего» нет, но новинки и сюрприз приходят; честная строка о том, чего нет", async () => {
    const r = await run(SAT(12), fullShiki());
    const p = picks()[0];
    expect(p.body.content).toContain("Серии:** пропущенных нет");
    expect(p.body.content).toContain("В этот раз не нашла подходящего: из «В планах», похожее.");
    expect(embedTitles(p)).toEqual(["Новинка сезона: Новинка 103", "Новинка сезона: Новинка 108", "Сюрприз: Рейтинг 302"]);
    expect(r.subrequests).toBeLessThanOrEqual(50);
  });

  it("сайт ответил пустыми списками и серий нет: одна короткая честная строка, без карточек", async () => {
    const s = new Shiki();
    await run(SAT(12), s);
    const p = picks();
    expect(p).toHaveLength(1);
    expect(p[0].body.embeds).toBeUndefined();
    expect(p[0].body.content).toContain("пропущенных нет");
    expect(p[0].body.content).toContain("В этот раз не нашла подходящего: из «В планах», новинки сезона, похожее, сюрприз.");
  });
});

describe("подборка: жанры и красные линии — настройки", () => {
  it("«не предлагать» берётся из настроек и уходит в запрос к сайту; если снять — ужасы и меха приходят с предупреждением (предупреждаем только о них)", async () => {
    seedTable();
    const s = fullShiki();
    s.similar[30] = [title(202, "Похожее с ужасами", { score: "7.9" })];
    await run(SAT(12), s);
    expect(embedTitles(picks()[0]).some((t) => t?.startsWith("Похожее"))).toBe(false); // ужасы обходим
    expect(s.genreUrls[0]).toContain("genre=22,!14,!18,!29,!33,!28,!12,!539");

    const w2 = new World();
    w = w2;
    await w.seed({ intake: true, settings: { summary_morning: "09:00", weekly: "off", anime_pick: "12:00", pick_avoid: "space, bl" } });
    await w.repo().exec(quietAnime(DATE));
    seedTable();
    const s2 = fullShiki();
    s2.similar[30] = [title(202, "Похожее с ужасами", { score: "7.9" })];
    await run(SAT(12), s2);
    expect(s2.genreUrls[0]).toContain("genre=22,!29,!33,!28,!12,!539"); // горрор и меха в запросе больше не исключены; взрослое — всегда
    const sim = (picks()[0].body.embeds ?? []).find((e) => e.title === "Похожее: Похожее с ужасами");
    expect(sim?.description).toContain("⚠️ Есть: ужасы.");
    expect((picks()[0].body.embeds ?? []).filter((e) => e.description?.includes("⚠️"))).toHaveLength(1); // обычное — без предупреждений
  });

  it("свои любимые жанры меняют запросы и выбор новинок; у «исэкая» на сайте жанра нет, он идёт через «фэнтези»", async () => {
    seedTable();
    const s = fullShiki();
    await w.repo().exec([setSetting("pick_genres", "comedy")]);
    await run(SAT(12), s);
    expect(s.genreUrls).toHaveLength(1);
    expect(s.genreUrls[0]).toContain("genre=4,");
    const fresh = (picks()[0].body.embeds ?? []).filter((e) => e.title?.startsWith("Новинка сезона")).map((e) => e.title);
    expect(fresh).toEqual(["Новинка сезона: Новинка 103", "Новинка сезона: Новинка 107"]);

    const w2 = new World();
    w = w2;
    await w.seed({ intake: true, settings: { summary_morning: "09:00", weekly: "off", anime_pick: "12:00", pick_genres: "isekai" } });
    await w.repo().exec(quietAnime(DATE));
    const s2 = fullShiki();
    await run(SAT(12), s2);
    expect(s2.genreUrls).toHaveLength(0); // запрашивать нечего
    expect((picks()[0].body.content ?? "")).toContain("новинки сезона");
  });

  it("жанры сопоставляются по названию (русскому и английскому), «сёнэн» — не BL, этти — не хентай", () => {
    expect([...classify(["Исэкай", "Fantasy", "Комедия"]).keys].sort()).toEqual(["comedy", "fantasy", "isekai"]);
    expect([...classify(["Shounen Ai"]).keys]).toEqual(["bl"]);
    expect([...classify(["Сёнэн-ай"]).keys]).toEqual(["bl"]);
    expect(classify(["Shounen", "Сёнэн"]).keys.size).toBe(0);
    expect(classify(["Ecchi", "Этти"])).toEqual({ keys: new Set(["ecchi"]), adult: false });
    expect(classify(["Hentai"]).adult).toBe(true);
    expect([...classify(["Ужасы", "Меха", "Космос"]).keys].sort()).toEqual(["horror", "mecha", "space"]);
    expect(parseGenreList(undefined, DEFAULT_LIKES)).toEqual(DEFAULT_LIKES);
    expect(parseGenreList("romance, isekai, ,nope", DEFAULT_LIKES)).toEqual(["romance", "isekai"]);
    expect(parseGenreList("off", DEFAULT_AVOID)).toEqual([]);
    expect(parseGenreList("мусор", DEFAULT_AVOID)).toEqual(DEFAULT_AVOID);
  });
});

describe("подборка: когда отправлять", () => {
  it("раз в неделю: после отправки до следующей субботы ничего, даже при перезапусках и позднем времени", async () => {
    seedTable();
    const s = fullShiki();
    await run(SAT(12), s);
    const calls = s.pickCalls;
    for (const t of [SAT(12, 1), SAT(12, 30), SAT(15), SAT(17, 59)]) await run(t, s);
    expect(picks()).toHaveLength(1);
    expect(s.pickCalls).toBe(calls); // и сеть зря не трогали
  });

  it("только в субботу, не раньше своего времени и не позже окна (шесть часов)", async () => {
    seedTable();
    const s = fullShiki();
    await w.repo().exec(quietAnime("2026-11-13")); // ночное обновление расписания в эти дни — не про подборку
    await run(SAT(12, 0, 13), s); // пятница
    await w.repo().exec(quietAnime("2026-11-15"));
    await run(SAT(12, 0, 15), s); // воскресенье
    await w.repo().exec(quietAnime(DATE)); // дальше суббота: те же метки «уже сделано сегодня»
    await run(SAT(11, 59), s); // рано
    await run(SAT(18, 0), s); // окно закрыто
    expect(picks()).toHaveLength(0);
    expect(s.pickCalls).toBe(0);
    expect(meta("anime_pick")).toBeUndefined();
    await run(SAT(17, 59), s); // последняя минута окна
    expect(picks()).toHaveLength(1);
  });

  it("время и «выкл» — в настройках: другое время сдвигает подборку, «выкл» отключает совсем", async () => {
    seedTable();
    const s = fullShiki();
    await w.repo().exec([setSetting("anime_pick", "18:00")]);
    await run(SAT(12), s);
    await run(SAT(17, 59), s);
    expect(picks()).toHaveLength(0);
    await run(SAT(18), s);
    expect(picks()).toHaveLength(1);

    const w2 = new World();
    w = w2;
    await w.seed({ intake: true, settings: { summary_morning: "09:00", weekly: "off", anime_pick: "off" } });
    await w.repo().exec(quietAnime(DATE));
    seedTable();
    const s2 = fullShiki();
    await run(SAT(12), s2);
    await run(SAT(13), s2);
    expect(picks()).toHaveLength(0);
    expect(s2.pickCalls).toBe(0);
  });

  it("по умолчанию включена, суббота 12:00 (пока в настройках нет записи)", async () => {
    w.d1.sqlite.exec("DELETE FROM settings WHERE key = 'anime_pick'");
    expect((await w.settings()).animePick).toBe(12 * 60);
    await w.repo().exec([setSetting("anime_pick", "off")]);
    expect((await w.settings()).animePick).toBeNull();
  });

  it("тихие часы переносят подборку, а не отменяют; «я в отъезде» пропускает неделю", async () => {
    seedTable();
    const s = fullShiki();
    await w.repo().exec([setSetting("quiet_enabled", "1"), setSetting("quiet_from", "11:00"), setSetting("quiet_to", "12:30")]);
    await run(SAT(12), s);
    await run(SAT(12, 29), s);
    expect(picks()).toHaveLength(0);
    expect(s.pickCalls).toBe(0);
    await run(SAT(12, 30), s); // тихие часы кончились, окно ещё открыто
    expect(picks()).toHaveLength(1);

    const w2 = new World();
    w = w2;
    await w.seed({ intake: true, settings: { summary_morning: "09:00", weekly: "off", anime_pick: "12:00", away_until: String(SAT(12) + 5 * DAY) } });
    await w.repo().exec(quietAnime(DATE));
    seedTable();
    await run(SAT(12), s);
    await run(SAT(14), s);
    expect(picks()).toHaveLength(0);
  });
});

describe("подборка: бесплатные лимиты Cloudflare", () => {
  it("запас на запуск мал — не начинаем (сайт не трогаем), хватает — отправляем; обращений не больше PICK_FETCH_CAP, подзапросов не больше 50", async () => {
    seedTable();
    const s = fullShiki();
    const r0 = await run(SAT(12), s, PICK_NEED); // на запуск осталось меньше нужного
    expect(picks()).toHaveLength(0);
    expect(s.pickCalls).toBe(0);
    expect(meta("anime_pick")).toBeUndefined();
    expect(r0.subrequests).toBeLessThanOrEqual(PICK_NEED);
    const r1 = await run(SAT(12, 1), s, 50); // в следующую минуту запас есть
    expect(picks()).toHaveLength(1);
    expect(s.pickCalls).toBeLessThanOrEqual(PICK_FETCH_CAP);
    expect(r1.subrequests).toBeLessThanOrEqual(50);
  });

  it("при любом запасе запуск не выходит за свой лимит: либо вся подборка, либо ничего и повтор (без полупустого сообщения)", async () => {
    for (let limit = 16; limit <= 40; limit++) {
      w = new World();
      await w.seed({ intake: true, settings: { summary_morning: "09:00", weekly: "off", anime_pick: "12:00" } });
      await w.repo().exec(quietAnime(DATE));
      seedTable();
      const s = fullShiki();
      const r = await run(SAT(12), s, limit);
      expect(r.subrequests, `запас ${limit}`).toBeLessThanOrEqual(limit);
      expect(picks().length, `запас ${limit}`).toBeLessThanOrEqual(1);
      if (picks().length) expect(embedTitles(picks()[0]), `запас ${limit}`).toHaveLength(5);
      else expect(meta("anime_pick"), `запас ${limit}`).toBeUndefined();
    }
  });
});

describe("подборка: Shikimori не отвечает", () => {
  it("две неудачи подряд — сайт больше не зовём; три попытки с паузой; на последней уходит то, что есть, с честной строкой", async () => {
    seedTable();
    const s = fullShiki();
    s.down = true;
    await run(SAT(12), s);
    expect(s.pickCalls).toBe(2); // карточка плана и список сезона: два сбоя подряд — хватит
    expect(picks()).toHaveLength(0);
    expect(meta("anime_pick_try")).toBe(`${DATE}:1`);
    expect(meta("anime_pick")).toBeUndefined();
    await run(SAT(12, 5), s); // рано: пауза 15 минут
    expect(s.pickCalls).toBe(2);
    await run(SAT(12, 15), s);
    expect(s.pickCalls).toBe(4);
    expect(picks()).toHaveLength(0);
    expect(meta("anime_pick_try")).toBe(`${DATE}:2`);
    await run(SAT(12, 30), s); // третья попытка: отправляем что есть
    expect(PICK_TRIES).toBe(3);
    const p = picks();
    expect(p).toHaveLength(1);
    expect(p[0].body.content).toContain("Вышло, а вы ещё не смотрели** (2)"); // серии берутся из своей таблицы, сайт не нужен
    expect(p[0].body.content).toContain("Не получилось собрать: новинки сезона, похожее, сюрприз (Shikimori не отвечает). В следующую субботу попробую снова.");
    expect(embedTitles(p[0])).toEqual(["Из «В планах»: Лавка зелий"]); // свой план — без обложки и оценки, но название и серии честные
    expect(p[0].body.embeds?.[0].thumbnail).toBeUndefined();
    expect(p[0].body.embeds?.[0].description).toContain("идёт, вышло 4 из 12 · оценки пока нет");
    expect(meta("anime_pick")).toBe(DATE);
    expect(meta("anime_pick_try")).toBeUndefined();
  });

  it("сайт ожил на второй попытке: приходит полная подборка", async () => {
    seedTable();
    const s = fullShiki();
    s.down = true;
    await run(SAT(12), s);
    s.down = false;
    await run(SAT(12, 15), s);
    expect(picks()).toHaveLength(1);
    expect(embedTitles(picks()[0])).toHaveLength(5);
    expect(meta("anime_pick_try")).toBeUndefined();
  });

  it("пропавшая карточка (404) — не «сайт не отвечает»: часть без неё, без повторов и без паузы", async () => {
    seedTable();
    const s = fullShiki();
    delete s.detail[201]; // у лучшего «похожего» карточки нет, а второй — с ужасами
    await run(SAT(12), s);
    const titles = embedTitles(picks()[0]);
    expect(titles.some((t) => t?.startsWith("Похожее"))).toBe(false);
    expect(titles).toContain("Новинка сезона: Новинка 103");
    expect(picks()[0].body.content).toContain("В этот раз не нашла подходящего: похожее.");
    expect(meta("anime_pick_try")).toBeUndefined();
    expect(meta("anime_pick")).toBe(DATE);
  });

  it("один тайтл из одной «семьи» (сезоны и спин-оффы) в подборке дважды не бывает", async () => {
    seedTable();
    const s = fullShiki();
    s.detail[302] = title(302, "Рейтинг 302", { score: "8.60", episodes: 13, franchise: "good_one", genres: genres("Adventure", "Drama") }); // та же семья, что у «похожего»
    await run(SAT(12), s);
    const titles = embedTitles(picks()[0]);
    expect(titles).toContain("Похожее: Похожее хорошее");
    expect(titles).not.toContain("Сюрприз: Рейтинг 302");
    expect(titles).toContain("Сюрприз: Рейтинг 303");
  });

  it("Discord не принял сообщение: пауза, три попытки, потом неделю пропускаем (сайт не долбим каждую минуту)", async () => {
    seedTable();
    const s = fullShiki();
    w.discord.failPost = { status: 500, times: 99 };
    await run(SAT(12), s);
    const calls = s.pickCalls;
    expect(meta("anime_pick_try")).toBe(`${DATE}:1`);
    await run(SAT(12, 5), s);
    expect(s.pickCalls).toBe(calls);
    await run(SAT(12, 15), s);
    await run(SAT(12, 30), s);
    expect(meta("anime_pick")).toBe(DATE);
    expect(picks()).toHaveLength(0);
  });
});

describe("подборка: не повторять прежнее", () => {
  it("через неделю те же тайтлы и тот же «любимый» для «похожего» не берём; серии — всегда свежие", async () => {
    seedTable();
    const s = fullShiki();
    await run(SAT(12), s);
    const first = embedTitles(picks()[0]);

    // следующая суббота: источники те же, но из них выбрано другое
    await w.repo().exec(quietAnime("2026-11-21"));
    s.similar[31] = [title(205, "Похожее на кофейню", { score: "8.0" })];
    s.detail[205] = title(205, "Похожее на кофейню", { score: "8.0", genres: genres("Romance") });
    await run(SAT(12, 0, 21), s);
    const p = w.discord.posted.filter((x) => x.body.content?.includes("Подборка на субботу"));
    expect(p).toHaveLength(2);
    const second = embedTitles(p[1]);
    expect(second).not.toContain("Из «В планах»: Лавка зелий");
    expect(second).toContain("Из «В планах»: Давний план");
    expect(second).not.toContain("Новинка сезона: Новинка 103");
    expect(second).not.toContain("Новинка сезона: Новинка 108");
    expect(second).toContain("Новинка сезона: Новинка 106");
    expect(second).toContain("Новинка сезона: Новинка 107");
    expect(second).toContain("Похожее: Похожее на кофейню"); // основа сменилась: 30 уже использован, берём 31
    expect(second).not.toContain("Сюрприз: Рейтинг 302");
    expect(first).toContain("Сюрприз: Рейтинг 302");
  });

  it("память: недели, обрезка старого и повреждённая запись", () => {
    const now = SAT(12);
    const old = markSeen({ r: {}, b: {} }, [1, 2], [9], now - 20 * 7 * DAY);
    const s = markSeen(old, [3], [], now);
    expect(Object.keys(s.r).map(Number)).toEqual([3]); // двадцатинедельное забыто
    expect(parseSeen("{oops")).toEqual({ r: {}, b: {} });
    expect(parseSeen(undefined)).toEqual({ r: {}, b: {} });
    expect(parseSeen(JSON.stringify({ r: { "5": 7, "x": 1 }, b: "?" }))).toEqual({ r: { 5: 7 }, b: {} });
  });
});

describe("подборка: мелкие правила выбора", () => {
  const row = (o: Partial<Anime>): Anime => ({ id: 1, mal_id: 1, anilist_id: null, title_ru: "Т", title_orig: null, status: "planned", watched: 0, liked: 0, notify: 1, episodes: 12, src_status: "FINISHED", next_ep: null, next_at: null, aired_ep: 0, aired_at: null, asked_ep: 0, added_at: 0, updated_at: 0, drop_reason: null, last_move_at: null, voice_lag: null, voice_n: 0, voice_ep: 0, weekq_at: null, seq_at: null, start_asked: 0, ...o });
  const first = () => 0;

  it("из «В планах»: идущее сейчас важнее короткого, короткое важнее давнего; ещё не вышедшее не предлагаем", () => {
    const rows = [
      row({ id: 1, mal_id: 1, src_status: "FINISHED", episodes: 40, added_at: 1 }),
      row({ id: 2, mal_id: 2, src_status: "FINISHED", episodes: 12, added_at: 2 }),
      row({ id: 3, mal_id: 3, src_status: "RELEASING", aired_ep: 3, added_at: 3 }),
      row({ id: 4, mal_id: 4, src_status: "NOT_YET_RELEASED", aired_ep: 0, added_at: 0 }),
    ];
    const seen = { r: {}, b: {} };
    expect(pickPlanned(rows, SAT(12), seen, first)).toMatchObject({ why: "airing", a: { id: 3 } });
    expect(pickPlanned(rows.filter((r) => r.id !== 3), SAT(12), seen, first)).toMatchObject({ why: "short", a: { id: 2 } });
    expect(pickPlanned(rows.filter((r) => r.id === 1 || r.id === 4), SAT(12), seen, first)).toMatchObject({ why: "waiting", a: { id: 1 } });
    expect(pickPlanned(rows.filter((r) => r.id === 4), SAT(12), seen, first)).toBeNull();
    expect(pickPlanned(rows, SAT(12), { r: { 3: weekNo(SAT(12)) }, b: {} }, first)).toMatchObject({ a: { id: 2 } }); // 3-й уже предлагали
  });

  it("озвучка: после выхода серии — «уже должна быть» или «примерно в …»; без AniLibria — ничего", () => {
    const a = row({ voice_lag: 120 });
    expect(dubNote(a, SAT(10), SAT(13), "Europe/Kyiv")).toEqual({ text: "🎙 в озвучке по обычной задержке уже есть", ready: true });
    expect(dubNote(a, SAT(11), SAT(12), "Europe/Kyiv")).toEqual({ text: "⏳ озвучка AniLibria примерно сегодня 13:00", ready: false });
    expect(dubNote(a, null, SAT(12), "Europe/Kyiv")?.text).toContain("озвучка AniLibria обычно через ~2 часа");
    expect(dubNote(row({}), SAT(10), SAT(12), "Europe/Kyiv")).toBeNull();
  });

  it("разбор карточки и сезон", () => {
    const t = parsePickTitle({ id: 7, russian: "", name: "Seven", kind: "tv", status: "ongoing", episodes: 12, episodes_aired: 3, score: "0.00", aired_on: "2026-10-05", image: { preview: "/p.jpg" }, genres: [{ name: "Comedy", russian: "Комедия" }] });
    expect(t).toMatchObject({ mal: 7, ru: "Seven", score: null, year: 2026, image: "https://shikimori.io/p.jpg", url: "https://shikimori.io/animes/7", genres: ["Comedy", "Комедия"] });
    expect(parsePickTitle({ id: "x" })).toBeNull();
    expect(parsePickTitle({ id: 8, name: "Eight", image: { preview: "/assets/globals/missing_preview.jpg", original: "/assets/globals/missing_original.jpg" } })?.image).toBeNull(); // заглушка — не обложка
    expect(parsePickTitle({ id: 9, name: "Nine", franchise: "nine_f" })?.franchise).toBe("nine_f");
    expect(excludeParam(["horror", "mecha"])).toBe("!14,!18,!12,!539");
    expect(excludeParam([])).toBe("!12,!539");
    expect(GENRE_IDS.isekai).toEqual([]);
    expect([seasonOf(2026, 1), seasonOf(2026, 4), seasonOf(2026, 7), seasonOf(2026, 11), seasonOf(2026, 12)]).toEqual(["winter_2026", "spring_2026", "summer_2026", "fall_2026", "fall_2026"]);
    expect([nextPickAt(null), nextPickAt(12 * 60), nextPickAt(18 * 60), nextPickAt(15 * 60)]).toEqual([12 * 60, 18 * 60, null, 12 * 60]);
  });
});

describe("подборка: кнопка в «⋯ Ещё»", () => {
  let seq = 0;
  const call = async (custom_id: string) => {
    const r = await handleInteraction(
      { id: String(++seq), token: "t", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 3, message: { id: "m1" }, data: { custom_id } } as Interaction,
      { repo: w.repo(), api: w.discord, now: SAT(10), env: {}, defer: () => {}, fetchFn: fetch },
    );
    return r as { type: number; data: { content: string; components: { components: { custom_id: string; label: string }[] }[] } };
  };

  it("кнопка перебирает 12:00 → 18:00 → выкл → 12:00; экран «Ещё» рассказывает про подборку; в ряду не больше пяти кнопок", async () => {
    const seen: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call("mn:tg:pk:a");
      seen.push((await w.settings()).animePick);
      const btns = r.data.components.flatMap((row) => row.components);
      expect(btns.some((b) => b.custom_id === "mn:tg:pk:a")).toBe(true);
      for (const row of r.data.components) expect(row.components.length).toBeLessThanOrEqual(5);
      expect(r.data.content).toContain("Подборка аниме по субботам:");
      expect(r.data.content.length).toBeLessThanOrEqual(2000); // предел Discord для одного сообщения
    }
    expect(seen).toEqual([18 * 60, null, 12 * 60, 18 * 60]); // стартовое значение в этом тесте — 12:00
    const off = await call("mn:tg:pk:a");
    expect(off.data.content).toContain("Подборка аниме по субботам: выкл");
    expect(off.data.components.flatMap((r) => r.components).find((b) => b.custom_id === "mn:tg:pk:a")?.label).toBe("Подборка аниме: выкл");
  });
});

