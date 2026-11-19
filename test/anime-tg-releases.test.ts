// Выходы серий по-русски из телеграм-каналов озвучек (src/anime/tgReleases.ts + tgReleasesRun.ts): разбор реальных кусков постов (разведка 2026-11-19,
// docs/RECON-ANIME-RELEASES.md), сопоставление названий, «молча / одно сообщение / тихо добавить озвучку», cron с честным счётчиком подзапросов.
import { beforeEach, describe, expect, it } from "vitest";
import type { Anime } from "../src/anime/core.ts";
import { handleAnimeAsk } from "../src/anime/handlers.ts";
import { parseAnimeAsk } from "../src/anime/say.ts";
import {
  type RuRow,
  type TgParsed,
  type TgRelease,
  TG_CHANNELS,
  buildIndex,
  canon,
  dueChannel,
  epsText,
  matchTitle,
  parseAniDubPost,
  parseAniLibriaPost,
  parseAniMediaPost,
  parseAnimeVostPost,
  parseTgOff,
  parseTgState,
  planReleases,
  releaseMessage,
  retryAfter,
  sameTitle,
  serializeTgState,
} from "../src/anime/tgReleases.ts";
import { listRu } from "../src/anime/tgReleasesRun.ts";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { parsePassport } from "../src/sources.ts";
import { parseTgChannel } from "../src/tgChannel.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { TZ, kyiv } from "./helpers.ts";
import { CH_REMIND, World } from "./world.ts";

// ---------- куски реальных постов (сокращены) ----------

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
const postHtml = (channel: string, id: number, iso: string, text: string): string =>
  `<div class="tgme_widget_message" data-post="${channel}/${id}"><a class="tgme_widget_message_date"><time datetime="${iso}">x</time></a><div class="tgme_widget_message_text js-message_text">${esc(text)}</div></div>`;
const pageHtml = (channel: string, posts: [number, string, string][]): string => posts.map(([id, iso, text]) => postHtml(channel, id, iso, text)).join("\n");
const P = (channel: string, id: number, iso: string, text: string) => parseTgChannel(postHtml(channel, id, iso, text))[0];

const AV_REL = "Сасаки и Пи 2 сезон — 7 серия\n\nДоступна новая серия, для просмотра онлайн и скачивания.\nЖанр: #приключения #комедия #фэнтези\nТип: ТВ\nГод выхода: 2026\nРежиссёр: Ибэ Юси\nКоличество серий: 12+ (25 мин.)";
const AV_LONG = "Я очнулся будучи пилотом сильнейшего космического корабля, а потому решил стать межгалактическим наёмником — 7 серия\n\nДоступна новая серия, для просмотра онлайн и скачивания.\nЖанр: #приключения";
const AV_SCHED = "РАСПИСАНИЕ НА СЕГОДНЯ (среда)\nДетектив уже мёртв (второй сезон) ~ (18:00)\nСасаки и Пи (второй сезон) ~ (18:30)\nСильнейшая ведьма в мире стартовала ~ (19:30)\nО моём перерождении в меч (второй сезон) ~ (20:30)\nМагия вернувшегося должна быть особенной (второй сезон) ~ (21:00)*Указанное время по МСК";
const DUB_REL = "Голубая шкатулка 2 / Ao no Hako Season 2 [06 из 12]\n\nПродолжение истории юного бадминтониста Тайки Иноматы и его соседки Тинацу Кано.\n\nЖанр: романтика, спорт\nОзвучивание: Shinjiro_san, Pimp";
const DUB_LONG = "Власть книжного червя: Приёмная дочь лорда / Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen - Ryoushu no Youjo [23 из 24]\n\nАниме-адаптация 3-й части.";
const LIB_A = 'Вышла 7-я серия аниме "Я ведьма, которую возлюбленный попросил создать любовное зелье" в закадровой озвучке от AniLibria (по заказу компании DEEP).\n\n🤲 Смотреть в онлайн-кинотеатре DEEP.\n\nСледующий эпизод выйдет в озвучке в понедельник, в 15:30 мск.';
const LIB_B = '"Не слишком ли ты сладкая, Бог соли Сато?" — в дубляже AniLibria\n\nВышла 7-я серия аниме, дублированная по заказу компании DEEP.\n\nЭпизоды выходят каждый вторник в 16:30 мск.';
const LIB_C = '"Детектив уже мёртв" в официальном дубляже AniLibria\n\nВ онлайн-кинотеатре DEEP уже можно посмотреть 7-ю серию 2-го сезона.\n\nСерии выходят каждую среду в 16:30 мск.';
const LIB_ANN = '✨ Между нежностью и тайной!\n\nВ этих объятиях слишком много невысказанного, но ждать разгадки осталось совсем недолго! 8-я серия "Монолога фармацевта 3" выйдет уже в эту пятницу в онлайн-кинотеатре DEEP в закадровой озвучке AniLibria!';
const MEDIA_A = "Вышла новая серия «Противостояние святого» [167 из 180]\n168 серия — 22 ноября";
const MEDIA_B = "Ладно, держите 😊\n\nВышла новая серия «Вечная воля 4» [20 из 46]";

const rel = (p: TgParsed | null): TgRelease => {
  if (!p || p.kind !== "release") throw new Error("не серия");
  return p;
};

describe("разбор постов каналов", () => {
  it("AnimeVost: «Название N сезон — M серия»; длинное название; чужие посты — null", () => {
    expect(rel(parseAnimeVostPost(P("animevost", 9036, "2026-11-18T13:57:10+00:00", AV_REL)))).toMatchObject({ voice: "AnimeVost", title: "Сасаки и Пи 2 сезон", orig: null, ep: 7, postId: 9036, link: "https://t.me/animevost/9036" });
    expect(rel(parseAnimeVostPost(P("animevost", 9016, "2026-11-15T15:47:02+00:00", AV_LONG))).ep).toBe(7);
    expect(parseAnimeVostPost(P("animevost", 1, "2026-11-18T13:57:10+00:00", "Сегодня финал, не пропустите!"))).toBeNull();
    expect(parseAnimeVostPost(P("animevost", 2, "2026-11-18T13:57:10+00:00", "Название — 1-2 серии\n\nДоступна новая серия."))).toBeNull();
  });

  it("AnimeVost: расписание на сегодня — время МСК переводится в UTC, хвост «*Указанное время по МСК» не мешает", () => {
    const s = parseAnimeVostPost(P("animevost", 9034, "2026-11-18T06:00:38+00:00", AV_SCHED));
    expect(s?.kind).toBe("schedule");
    if (s?.kind !== "schedule") return;
    expect(s.items.map((i) => i.title)).toEqual(["Детектив уже мёртв (второй сезон)", "Сасаки и Пи (второй сезон)", "Сильнейшая ведьма в мире стартовала", "О моём перерождении в меч (второй сезон)", "Магия вернувшегося должна быть особенной (второй сезон)"]);
    expect(s.items[0].at).toBe(Date.parse("2026-11-18T15:00:00Z")); // 18:00 МСК
    expect(s.items[4].at).toBe(Date.parse("2026-11-18T18:00:00Z")); // 21:00 МСК
  });

  it("AniDub: название по-русски и ромадзи, серия «N из M»", () => {
    expect(rel(parseAniDubPost(P("anidub", 13557, "2026-11-17T20:33:55+00:00", DUB_REL)))).toMatchObject({ voice: "AniDub", title: "Голубая шкатулка 2", orig: "Ao no Hako Season 2", ep: 6 });
    expect(rel(parseAniDubPost(P("anidub", 13550, "2026-11-14T21:31:39+00:00", DUB_LONG))).ep).toBe(23);
    expect(parseAniDubPost(P("anidub", 5, "2026-11-14T21:31:39+00:00", "Переехали на новый домен: anidub.click"))).toBeNull();
  });

  it("AniLibria: три формы про вышедшую серию; анонсы «выйдет в пятницу» и новости — null", () => {
    expect(rel(parseAniLibriaPost(P("anilibria_tv", 23437, "2026-11-16T12:30:31+00:00", LIB_A)))).toMatchObject({ voice: "AniLibria", title: "Я ведьма, которую возлюбленный попросил создать любовное зелье", ep: 7 });
    expect(rel(parseAniLibriaPost(P("anilibria_tv", 23442, "2026-11-17T13:31:25+00:00", LIB_B)))).toMatchObject({ title: "Не слишком ли ты сладкая, Бог соли Сато?", ep: 7 });
    expect(rel(parseAniLibriaPost(P("anilibria_tv", 23448, "2026-11-18T13:31:12+00:00", LIB_C)))).toMatchObject({ title: "Детектив уже мёртв 2 сезон", ep: 7 });
    expect(parseAniLibriaPost(P("anilibria_tv", 23452, "2026-11-19T09:36:49+00:00", LIB_ANN))).toBeNull();
    expect(parseAniLibriaPost(P("anilibria_tv", 23450, "2026-11-19T06:01:08+00:00", "Яблоко от волчицы недалеко падает\n\nОфициально: в январе 2027 года начнется демонстрация второго сезона аниме-ремейка."))).toBeNull();
  });

  it("AniMedia: «Вышла новая серия «…» [N из M]» в начале и в середине поста; шутки — null", () => {
    expect(rel(parseAniMediaPost(P("AnimeMediaNews", 11752, "2026-11-15T13:28:42+00:00", MEDIA_A)))).toMatchObject({ voice: "AniMedia", title: "Противостояние святого", ep: 167 });
    expect(rel(parseAniMediaPost(P("AnimeMediaNews", 11761, "2026-11-17T10:29:47+00:00", MEDIA_B)))).toMatchObject({ title: "Вечная воля 4", ep: 20 });
    expect(parseAniMediaPost(P("AnimeMediaNews", 11753, "2026-11-15T20:03:29+00:00", "Собака VS Кот\n\nВроде как похоже на правду"))).toBeNull();
  });
});

describe("название: сезон и совпадение с тайтлом из списка", () => {
  it("сезон из «2 сезон», «(второй сезон)», «2nd Season», «Season 2», «2-го сезона», числа в конце", () => {
    expect(canon("Сасаки и Пи 2 сезон").season).toBe(2);
    expect(canon("Сасаки и Пи (второй сезон)").season).toBe(2);
    expect(canon("Sasaki to Pii-chan Season 2").season).toBe(2);
    expect(canon("Kikansha no Mahou wa Tokubetsu desu 2nd Season").season).toBe(2);
    expect(canon("Голубая шкатулка 2").season).toBe(2);
    expect(canon("Ранма ½ (2024) 3").season).toBe(3);
    expect(canon("Вечная воля 4 сезон").season).toBe(4);
    expect(canon("Сасаки и Пи").season).toBeNull();
    expect(canon("Моб Психо 100").season).toBeNull(); // 100 — не сезон
  });

  it("одно и то же название: сезон совпал, слова совпали; другой сезон и другое название — нет", () => {
    expect(sameTitle(canon("Сасаки и Пи 2 сезон"), canon("Сасаки и Пи-тян 2"))).toBe(true);
    expect(sameTitle(canon("Сасаки и Пи (второй сезон)"), canon("Сасаки и Пи 2 сезон"))).toBe(true);
    expect(sameTitle(canon("Сасаки и Пи 3 сезон"), canon("Сасаки и Пи-тян 2"))).toBe(false);
    expect(sameTitle(canon("Сасаки и Пи"), canon("Сасаки и Пи-тян 2"))).toBe(false); // первый сезон ≠ второй
    expect(sameTitle(canon("Магия вернувшегося должна быть особенной"), canon("Магия и мускулы"))).toBe(false);
    // подзаголовок из нескольких слов — другая часть
    expect(sameTitle(canon("Власть книжного червя"), canon("Власть книжного червя: Приёмная дочь лорда"))).toBe(false);
  });

  const row = (o: Partial<Anime>): Anime =>
    ({ id: 1, mal_id: 1, anilist_id: null, title_ru: "Т", title_orig: null, status: "watching", watched: 0, liked: 0, notify: 1, episodes: 12, src_status: "RELEASING", next_ep: null, next_at: null, aired_ep: 0, aired_at: null, asked_ep: 0, added_at: 0, updated_at: 0, drop_reason: null, last_move_at: null, voice_lag: null, voice_n: 0, voice_ep: 0, weekq_at: null, seq_at: null, start_asked: 0, ...o }) as Anime;

  it("matchTitle: по русскому и по ромадзи, учитывает число серий; законченные и брошенные не берёт", () => {
    const rows = [
      row({ id: 1, title_ru: "Сасаки и Пи-тян 2", title_orig: "Sasaki to Pii-chan Season 2" }),
      row({ id: 2, title_ru: "Голубая шкатулка 2", title_orig: "Ao no Hako Season 2", status: "planned" }),
      row({ id: 3, title_ru: "Детектив уже мёртв 2", status: "done" }),
      row({ id: 4, title_ru: "Магия вернувшегося должна быть особенной 2", episodes: 12 }),
    ];
    const ix = buildIndex(rows);
    expect(matchTitle(ix, "Сасаки и Пи 2 сезон", null, 7)?.id).toBe(1);
    expect(matchTitle(ix, "Голубая шкатулка 2", "Ao no Hako Season 2", 6)?.id).toBe(2);
    expect(matchTitle(ix, "Детектив уже мёртв 2 сезон", null, 7)).toBeNull(); // просмотрено — молча пропускаем
    expect(matchTitle(ix, "Магия вернувшегося должна быть особенной 2 сезон", null, 13)).toBeNull(); // серия больше известного числа
    expect(matchTitle(ix, "Магия вернувшегося должна быть особенной (второй сезон)", null, 7)?.id).toBe(4);
    expect(matchTitle(ix, "Вечная воля 4", null, 20)).toBeNull(); // чужой тайтл
  });

  it("matchTitle: два совпадения — «Смотрю» важнее «В планах», иначе никому", () => {
    const a = row({ id: 1, title_ru: "Тайтл Один", status: "watching" });
    const b = row({ id: 2, title_ru: "Тайтл Один", status: "planned" });
    expect(matchTitle(buildIndex([a, b]), "Тайтл Один", null, 1)?.id).toBe(1);
    expect(matchTitle(buildIndex([a, row({ id: 3, title_ru: "Тайтл Один", status: "watching" })]), "Тайтл Один", null, 1)).toBeNull();
  });
});

describe("planReleases: что записать и о чём сказать", () => {
  const NOW = Date.parse("2026-11-18T17:00:00Z");
  const row = (o: Partial<Anime>): Anime =>
    ({ id: 1, mal_id: 1, anilist_id: null, title_ru: "Сасаки и Пи-тян 2", title_orig: null, status: "watching", watched: 6, liked: 0, notify: 1, episodes: 12, src_status: "RELEASING", next_ep: null, next_at: null, aired_ep: 7, aired_at: null, asked_ep: 7, added_at: 0, updated_at: 0, drop_reason: null, last_move_at: null, voice_lag: null, voice_n: 0, voice_ep: 0, weekq_at: null, seq_at: null, start_asked: 0, ...o }) as Anime;
  const mk = (title: string, ep: number, voice: string, at: number, id = 100): TgRelease => ({ kind: "release", channel: "c", postId: id, at, link: `https://t.me/c/${id}`, voice, title, orig: null, ep });
  const known = (anime: Anime, ep: number, voices: string, at = NOW - 3 * HOUR, next: number | null = null): Map<number, RuRow> =>
    new Map([[anime.id, { anime_id: anime.id, ep, at, voices, link: "https://t.me/c/1", next_at: next, updated_at: 0 }]]);
  const run = (rows: Anime[], parsed: TgParsed[], k = new Map<number, RuRow>(), silent = false) =>
    planReleases({ index: buildIndex(rows), noticeIds: new Set(rows.filter((r) => r.status === "watching" && r.notify === 1).map((r) => r.id)), known: k, parsed, now: NOW, silent });

  it("новая серия: одно сообщение и запись", () => {
    const a = row({});
    const p = run([a], [mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - 10 * MINUTE)]);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]).toMatchObject({ eps: [7], voices: ["AnimeVost"], link: "https://t.me/c/100" });
    expect(p.writes).toEqual([expect.objectContaining({ ep: 7, voicesOnly: false, voices: ["AnimeVost"] })]);
  });

  it("первое чтение канала: записываем, но молчим", () => {
    const p = run([row({})], [mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - 10 * MINUTE)], new Map(), true);
    expect(p.notices).toEqual([]);
    expect(p.writes).toHaveLength(1);
  });

  it("та же серия в другой озвучке — тихо добавляем озвучку; серия старее известной — игнорируем", () => {
    const a = row({});
    const k = known(a, 7, "AnimeVost");
    const p = run([a], [mk("Сасаки и Пи 2 сезон", 7, "AniDub", NOW - 5 * MINUTE)], k);
    expect(p.notices).toEqual([]);
    expect(p.writes).toEqual([expect.objectContaining({ ep: 7, voicesOnly: true, voices: ["AnimeVost", "AniDub"] })]);
    expect(run([a], [mk("Сасаки и Пи 2 сезон", 6, "AniDub", NOW - 5 * MINUTE)], k)).toEqual({ notices: [], writes: [], nexts: [] });
    // та же озвучка второй раз — ничего нового
    expect(run([a], [mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - 5 * MINUTE)], k).writes).toEqual([]);
  });

  it("две озвучки одной серии в одном чтении — одно сообщение со списком озвучек", () => {
    const p = run([row({})], [mk("Сасаки и Пи 2 сезон", 7, "AniDub", NOW - 30 * MINUTE, 1), mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - 20 * MINUTE, 2)]);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0].voices).toEqual(["AniDub", "AnimeVost"]); // по порядку выхода
  });

  it("не говорим: пост старше 12 часов; серию уже отметили; колокольчик выключен; чужое", () => {
    expect(run([row({})], [mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - 13 * HOUR)]).notices).toEqual([]);
    expect(run([row({ watched: 7 })], [mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - HOUR)]).notices).toEqual([]);
    expect(run([row({ notify: 0 })], [mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - HOUR)]).notices).toEqual([]);
    expect(run([row({})], [mk("Вечная воля 4", 20, "AniMedia", NOW - HOUR)])).toEqual({ notices: [], writes: [], nexts: [] });
    // запись при этом идёт (чтобы «когда новая серия» знала)
    expect(run([row({ notify: 0 })], [mk("Сасаки и Пи 2 сезон", 7, "AnimeVost", NOW - HOUR)]).writes).toHaveLength(1);
  });

  it("«В планах»: говорим только про первую серию, с пометкой", () => {
    const planned = row({ id: 2, title_ru: "Голубая шкатулка 2", status: "planned", watched: 0 });
    const p1 = run([planned], [mk("Голубая шкатулка 2", 1, "AniDub", NOW - HOUR)]);
    expect(p1.notices).toHaveLength(1);
    expect(releaseMessage(p1.notices, "neutral")).toContain("(из ваших планов)");
    expect(run([planned], [mk("Голубая шкатулка 2", 5, "AniDub", NOW - HOUR)]).notices).toEqual([]);
  });

  it("расписание AnimeVost: время «сегодня» запоминаем, если серия сегодня ещё не вышла", () => {
    const a = row({});
    const sched: TgParsed = { kind: "schedule", channel: "animevost", postId: 9, at: NOW - 11 * HOUR, voice: "AnimeVost", items: [{ title: "Сасаки и Пи (второй сезон)", at: NOW + HOUR }, { title: "Чужое", at: NOW + HOUR }] };
    expect(run([a], [sched]).nexts).toEqual([{ a, at: NOW + HOUR }]);
    // прошлая серия вышла вчера (до утреннего расписания) — ждём сегодняшнюю
    expect(run([a], [sched], known(a, 7, "AnimeVost", NOW - 20 * HOUR)).nexts).toEqual([{ a, at: NOW + HOUR }]);
    // сегодняшняя уже вышла после расписания — «ждём» не пишем
    expect(run([a], [sched], known(a, 8, "AnimeVost", NOW - 2 * HOUR)).nexts).toEqual([]);
    // время, которое прошло больше двух часов назад, ждать уже не имеет смысла
    const old: TgParsed = { ...sched, items: [{ title: "Сасаки и Пи (второй сезон)", at: NOW - 3 * HOUR }] } as TgParsed;
    expect(run([a], [old]).nexts).toEqual([]);
  });
});

describe("сообщение и состояние", () => {
  const row = (title: string, status: Anime["status"] = "watching"): Anime => ({ id: 1, title_ru: title, status }) as Anime;
  it("одна серия — одно предложение со ссылкой без предпросмотра; несколько тайтлов — список; Хару — только горничная", () => {
    const n = { a: row("Сасаки и Пи-тян 2"), eps: [7], voices: ["AnimeVost", "AniDub"], link: "https://t.me/animevost/9042", at: 0 };
    expect(releaseMessage([n], "neutral")).toBe("🎧 Вышла 7-я серия «Сасаки и Пи-тян 2» в озвучке AnimeVost и AniDub\n<https://t.me/animevost/9042>");
    expect(releaseMessage([n], "maid", () => 0)).toMatch(/^🎧 Вышла 7-я серия .*\n<https:\/\/t\.me\/animevost\/9042>\nСвежая серия/);
    const two = releaseMessage([n, { ...n, a: { ...row("Голубая шкатулка 2"), id: 2 } as Anime, eps: [6, 7], voices: ["AniDub"], link: "https://t.me/anidub/13557" }], "neutral");
    expect(two).toBe("🎧 **Вышло по-русски**\n• **Сасаки и Пи-тян 2** — 7-я серия, озвучка AnimeVost и AniDub <https://t.me/animevost/9042>\n• **Голубая шкатулка 2** — серии 6, 7, озвучка AniDub <https://t.me/anidub/13557>");
    expect(epsText([7, 8])).toBe("Вышли 7-я и 8-я серии");
  });

  it("состояние чтения каналов: туда и обратно, повреждённое — пусто; выключатель каналов; кто следующий", () => {
    const st = { animevost: { last: 9042, next: 5, fails: 0 }, anidub: { last: null, next: 0, fails: 2 } };
    expect(parseTgState(serializeTgState(st))).toEqual(st);
    expect(parseTgState("не json")).toEqual({});
    expect(parseTgOff("AniDub, anilibria_tv").set).toEqual(new Set(["anidub", "anilibria_tv"]));
    expect(parseTgOff("all").all).toBe(true);
    expect(parseTgOff(undefined)).toEqual({ all: false, set: new Set() });
    expect(dueChannel(TG_CHANNELS, {}, 1000)?.channel).toBe("animevost");
    expect(dueChannel(TG_CHANNELS, { animevost: { last: 1, next: 5000, fails: 0 } }, 1000)?.channel).toBe("anidub");
    expect(dueChannel(TG_CHANNELS, Object.fromEntries(TG_CHANNELS.map((c) => [c.channel, { last: 1, next: 5000, fails: 0 }])), 1000)).toBeNull();
    expect(retryAfter(15 * MINUTE, 1)).toBe(30 * MINUTE);
    expect(retryAfter(15 * MINUTE, 20)).toBe(6 * HOUR);
  });
});

// ---------- cron целиком ----------

const T0 = kyiv(2026, 11, 18, 19, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
let w: World;

const addRow = (o: { mal: number; ru: string; orig?: string; status?: string; watched?: number; notify?: number; episodes?: number }): void => {
  w.d1.sqlite
    .prepare(`INSERT INTO anime (mal_id, title_ru, title_orig, status, watched, episodes, src_status, aired_ep, asked_ep, notify, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'RELEASING', ?, ?, ?, 0, 0)`)
    .run(o.mal, o.ru, o.orig ?? null, o.status ?? "watching", o.watched ?? 0, o.episodes ?? 12, o.watched ?? 0, o.watched ?? 0, o.notify ?? 1);
};
const meta = (k: string): string | undefined => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const ruRows = (): RuRow[] => w.d1.q<RuRow>("SELECT * FROM anime_ru ORDER BY anime_id");
const heard = () => w.discord.posted.filter((p) => p.channel === CH_REMIND && p.body.content?.includes("🎧"));

beforeEach(async () => {
  w = new World();
  await w.seed({ settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off", anime_pick: "off" } });
  addRow({ mal: 1, ru: "Сасаки и Пи-тян 2", orig: "Sasaki to Pii-chan Season 2", watched: 6 });
  addRow({ mal: 2, ru: "Голубая шкатулка 2", orig: "Ao no Hako Season 2", watched: 5 });
  addRow({ mal: 3, ru: "Детектив уже мёртв 2", status: "done", watched: 12 });
});

describe("cron: чтение каналов", () => {
  const vost = (...posts: [number, string, string][]): string => pageHtml("animevost", posts);
  const dub = (...posts: [number, string, string][]): string => pageHtml("anidub", posts);

  it("первое чтение — молча (но серии запоминаются), следующее — одно сообщение; за запуск не больше 50 подзапросов", async () => {
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL]);
    const r1 = await w.run(T0);
    expect(w.tgFetches).toEqual(["animevost"]);
    expect(heard()).toEqual([]);
    expect(ruRows()).toEqual([expect.objectContaining({ anime_id: 1, ep: 7, voices: "AnimeVost", link: "https://t.me/animevost/9036" })]);
    expect(r1.notes.join("\n")).toContain("прочитан впервые");
    expect(r1.subrequests).toBeLessThanOrEqual(50);

    // 15 минут спустя — новая серия 8 (пост 10 минут назад)
    const t1 = T0 + 16 * MINUTE;
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL], [9042, iso(t1 - 10 * MINUTE), AV_REL.replace("— 7 серия", "— 8 серия")]);
    w.tgFetches.length = 0;
    // сначала читаются каналы, до которых очередь ещё не дошла (anidub, anilibria_tv, AnimeMediaNews — первые чтения), animevost — когда срок выйдет
    for (let i = 0; i < 6 && !heard().length; i++) await w.run(t1 + i * MINUTE);
    expect(heard()).toHaveLength(1);
    expect(heard()[0].body.content).toBe("🎧 Вышла 8-я серия «Сасаки и Пи-тян 2» в озвучке AnimeVost\n<https://t.me/animevost/9042>");
    expect(heard()[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(ruRows().find((x) => x.anime_id === 1)).toMatchObject({ ep: 8, voices: "AnimeVost", next_at: null });
    // повторное чтение той же страницы ничего не добавляет
    for (let i = 0; i < 20; i++) await w.run(t1 + 20 * MINUTE + i * MINUTE);
    expect(heard()).toHaveLength(1);
  });

  it("одна страница за запуск: четыре канала читаются по очереди, а не все сразу; паспорт «animetg»", async () => {
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL]);
    w.tg.anidub = dub([13557, "2026-11-17T20:33:55+00:00", DUB_REL]);
    w.tg.anilibria_tv = pageHtml("anilibria_tv", [[23448, "2026-11-18T13:31:12+00:00", LIB_C]]);
    w.tg.AnimeMediaNews = pageHtml("AnimeMediaNews", [[11761, "2026-11-17T10:29:47+00:00", MEDIA_B]]);
    for (let i = 0; i < 4; i++) {
      const before = w.tgFetches.length;
      await w.run(T0 + i * MINUTE);
      expect(w.tgFetches.length - before).toBe(1);
    }
    expect(w.tgFetches).toEqual(["animevost", "anidub", "anilibria_tv", "AnimeMediaNews"]);
    await w.run(T0 + 4 * MINUTE); // все четыре ещё не «созрели» (15–30 минут)
    expect(w.tgFetches).toHaveLength(4);
    expect(parsePassport(meta("src_passport") ?? "").animetg).toMatchObject({ ok: T0 + 3 * MINUTE, fails: 0 });
    expect(ruRows().map((x) => [x.anime_id, x.ep, x.voices])).toEqual([[1, 7, "AnimeVost"], [2, 6, "AniDub"]]);
  });

  it("другая озвучка той же серии — тихо: сообщения нет, озвучка добавлена", async () => {
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL]);
    await w.run(T0);
    w.tg.anidub = dub([13557, iso(T0), DUB_REL.replace("Голубая шкатулка 2 / Ao no Hako Season 2 [06", "Сасаки и Пи-тян 2 / Sasaki to Pii-chan Season 2 [07")]);
    await w.run(T0 + MINUTE); // anidub: первое чтение
    w.tg.anidub = dub([13557, iso(T0), "x"], [13570, iso(T0 + 20 * MINUTE), DUB_REL.replace("Голубая шкатулка 2 / Ao no Hako Season 2 [06", "Сасаки и Пи-тян 2 / Sasaki to Pii-chan Season 2 [07")]);
    for (let i = 0; i < 20; i++) await w.run(T0 + 20 * MINUTE + i * MINUTE);
    expect(heard()).toEqual([]);
    expect(ruRows().find((x) => x.anime_id === 1)).toMatchObject({ ep: 7, voices: "AnimeVost, AniDub" });
  });

  it("нет тайтлов в «Смотрю» и «В планах» — страницы не читаются вовсе", async () => {
    w.d1.sqlite.exec("UPDATE anime SET status = 'done'");
    await w.run(T0);
    expect(w.tgFetches).toEqual([]);
  });

  it("тихие часы и «я в отъезде» — не читаем; meta anime_tg_off выключает канал или всё", async () => {
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL]);
    await w.repo().exec([setSetting("quiet_enabled", "1")]);
    await w.run(kyiv(2026, 11, 18, 23, 30));
    expect(w.tgFetches).toEqual([]);
    await w.repo().exec([setSetting("quiet_enabled", "0"), setMeta("anime_tg_off", "animevost,anidub")]);
    await w.run(T0);
    expect(w.tgFetches).toEqual(["anilibria_tv"]);
    await w.repo().exec([setMeta("anime_tg_off", "all")]);
    await w.run(T0 + 40 * MINUTE);
    expect(w.tgFetches).toEqual(["anilibria_tv"]);
  });

  it("канал не ответил — молчим, паспорт копит неудачи, повтор позже и реже", async () => {
    w.tg.animevost = null;
    await w.run(T0);
    expect(parsePassport(meta("src_passport") ?? "").animetg).toMatchObject({ fails: 1 });
    expect(heard()).toEqual([]);
    expect(parseTgState(meta("anime_tg")).animevost).toMatchObject({ fails: 1, next: T0 + 30 * MINUTE });
    expect(w.discord.posted.filter((p) => p.body.content?.includes("не отвечает"))).toEqual([]);
  });

  it("Discord не принял сообщение — страницу разберём заново, серия не потеряется", async () => {
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL]);
    await w.run(T0);
    const t1 = T0 + 16 * MINUTE;
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL], [9042, iso(t1 - 5 * MINUTE), AV_REL.replace("— 7 серия", "— 8 серия")]);
    const send = w.discord.postMessage.bind(w.discord);
    let down = true;
    w.discord.postMessage = (async (...a: Parameters<typeof send>) => {
      if (down && String(a[1].content).includes("🎧")) throw new Error("Discord недоступен");
      return send(...a);
    }) as typeof send;
    for (let i = 0; i < 5; i++) await w.run(t1 + i * MINUTE);
    expect(heard()).toEqual([]);
    expect(ruRows().find((x) => x.anime_id === 1)?.ep).toBe(7); // не записали: повторим
    down = false;
    for (let i = 0; i < 3 && !heard().length; i++) await w.run(t1 + 6 * MINUTE + i * MINUTE);
    expect(heard()).toHaveLength(1);
  });

  it("расписание AnimeVost: «сегодня ждите в …» попадает в ответ «когда новая серия X»", async () => {
    const sched = "РАСПИСАНИЕ НА СЕГОДНЯ (среда)\nСасаки и Пи (второй сезон) ~ (21:30)*Указанное время по МСК";
    w.tg.animevost = vost([9034, "2026-11-18T06:00:38+00:00", sched]);
    await w.run(T0);
    expect(ruRows().find((x) => x.anime_id === 1)).toMatchObject({ ep: 0, next_at: Date.parse("2026-11-18T18:30:00Z") });
    const ru = await listRu(w.repo());
    const reply = await handleAnimeAsk({ repo: w.repo(), now: T0, tz: TZ, character: "neutral", fetchFn: fetch }, parseAnimeAsk("когда новая серия сасаки и пи")!);
    expect(reply?.content).toContain("🎧 По расписанию AnimeVost следующая: сегодня 20:30.");
    expect(ru?.get(1)?.next_at).toBe(Date.parse("2026-11-18T18:30:00Z"));
  });

  it("нет таблицы anime_ru (миграция не применена) — ничего не пишем, остальное работает", async () => {
    w.d1.sqlite.exec("DROP TABLE anime_ru");
    w.tg.animevost = vost([9036, "2026-11-18T13:57:10+00:00", AV_REL]);
    const r = await w.run(T0);
    expect(r.notes.join("\n")).toContain("миграция 0015");
    expect(heard()).toEqual([]);
    expect(await listRu(w.repo())).toBeNull();
    // ответы про аниме работают как раньше
    const reply = await handleAnimeAsk({ repo: w.repo(), now: T0, tz: TZ, character: "neutral", fetchFn: fetch }, parseAnimeAsk("что вышло нового")!);
    expect(reply?.content).toBeTruthy();
  });
});

describe("ответы «что вышло нового» и «когда новая серия X» учитывают выходы по-русски", () => {
  const ctx = (now: number) => ({ repo: w.repo(), now, tz: TZ, character: "neutral" as const, fetchFn: fetch });
  const setRu = (id: number, ep: number, voices: string, at: number, next: number | null = null): void => {
    w.d1.sqlite.prepare("INSERT INTO anime_ru (anime_id, ep, at, voices, link, next_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0)").run(id, ep, at, voices, "https://t.me/animevost/9042", next);
  };

  it("«что вышло нового»: по-русски впереди расписания Shikimori — верим телеграму; позади — пометка «пока 7-я»", async () => {
    setRu(1, 8, "AnimeVost, AniDub", T0 - 2 * HOUR); // Shikimori знает про 7 серий (aired_ep = 6 в базе), по-русски уже 8
    setRu(2, 3, "AniDub", T0 - 5 * HOUR);
    w.d1.sqlite.exec("UPDATE anime SET aired_ep = 7 WHERE id = 2"); // Shikimori: 7 вышла, по-русски пока 3
    const reply = await handleAnimeAsk(ctx(T0), parseAnimeAsk("что вышло нового")!);
    expect(reply?.content).toContain("• **Сасаки и Пи-тян 2** — вышла 8-я (сегодня 17:00), вы на 6-й · пропущено 2 · 🎧 AnimeVost и AniDub");
    expect(reply?.content).toContain("• **Голубая шкатулка 2** — вышла 7-я");
    expect(reply?.content).toContain("🎧 по-русски пока 3-я");
  });

  it("«когда новая серия X»: расписание Shikimori остаётся, добавляются строки про русскую озвучку; без данных — ответ как раньше", async () => {
    const before = await handleAnimeAsk(ctx(T0), parseAnimeAsk("когда новая серия сасаки и пи")!);
    setRu(1, 7, "AnimeVost", T0 - 3 * HOUR, T0 + 2 * HOUR);
    const after = await handleAnimeAsk(ctx(T0), parseAnimeAsk("когда новая серия сасаки и пи")!);
    expect(after?.content?.startsWith(before?.content ?? "?")).toBe(true);
    expect(after?.content).toContain("🎧 По-русски вышла 7-я: AnimeVost, сегодня 16:00.");
    expect(after?.content).toContain("🎧 По расписанию AnimeVost следующая: сегодня 21:00.");
  });
});

describe("сводки не получили лишних строк", () => {
  it("вечерняя сводка и итог недели не говорят про русские выходы (они — только отдельное сообщение и ответы на вопросы)", async () => {
    w.d1.sqlite.prepare("INSERT INTO anime_ru (anime_id, ep, at, voices, link, next_at, updated_at) VALUES (1, 8, ?, 'AnimeVost', 'https://t.me/animevost/9042', ?, 0)").run(T0 - HOUR, T0 + HOUR);
    w.d1.sqlite.exec(`UPDATE anime SET next_ep = 9, next_at = ${T0 + HOUR}, aired_ep = 8, aired_at = ${T0 - HOUR} WHERE id = 1`);
    for (const t of [kyiv(2026, 11, 18, 20, 0), kyiv(2026, 11, 15, 20, 0)]) await w.run(t);
    const all = w.discord.posted.map((p) => p.body.content ?? "").join("\n");
    expect(all).not.toContain("🎧");
    expect(all).not.toContain("по-русски");
  });
});
