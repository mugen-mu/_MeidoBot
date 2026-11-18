// Источник субботней подборки: только Shikimori (AniList из Cloudflare закрыт, см. sources.ts). Любой сбой = null.
// Запросы идут по одному (у Shikimori лимит 5 запросов в секунду), а сколько их всего — решает вызывающий (pickCron.ts).
import { type FetchFn, SHIKI, UA, getJson } from "./sources.ts";

export const SITE = "https://shikimori.io";

/** Тайтл Shikimori для подборки: из списка (жанров нет) или из карточки (жанры есть). */
export interface PickTitle {
  mal: number;
  ru: string;
  orig: string;
  /** tv, ona, movie, ova … */
  kind: string;
  /** anons — анонс, ongoing — идёт, released — вышел */
  status: string;
  /** сколько серий всего (0 — неизвестно) */
  episodes: number;
  /** сколько уже вышло */
  epsAired: number;
  /** оценка на сайте (0 — ещё нет → null) */
  score: number | null;
  year: number | null;
  /** названия жанров, русские и английские вперемешку; в списках пусто */
  genres: string[];
  /** обложка (полный адрес) */
  image: string | null;
  url: string;
  /** «семья» тайтла у сайта (все сезоны и спин-оффы под одним словом); есть только в карточке */
  franchise: string | null;
}

/** Адрес с сайта целиком; заглушка «обложки нет» (missing_preview.jpg) — это не обложка. */
const abs = (p: unknown): string | null => {
  if (typeof p !== "string" || p.includes("missing_")) return null;
  return p.startsWith("/") ? `${SITE}${p}` : p.startsWith("http") ? p : null;
};

function genreNames(x: Record<string, any>): string[] {
  const out: string[] = [];
  for (const list of [x.genres, x.genres_v2]) {
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      if (typeof g?.name === "string") out.push(g.name);
      if (typeof g?.russian === "string") out.push(g.russian);
    }
  }
  return out;
}

export function parsePickTitle(raw: unknown): PickTitle | null {
  const x = raw as Record<string, any> | null;
  if (!x || typeof x.id !== "number") return null;
  const ru = String(x.russian || x.name || "").trim();
  if (!ru) return null;
  const sc = Number(x.score);
  const on = typeof x.aired_on === "string" ? Number.parseInt(x.aired_on.slice(0, 4), 10) : NaN;
  return {
    mal: x.id,
    ru,
    orig: String(x.name ?? "").trim(),
    kind: String(x.kind ?? ""),
    status: String(x.status ?? ""),
    episodes: typeof x.episodes === "number" ? x.episodes : 0,
    epsAired: typeof x.episodes_aired === "number" ? x.episodes_aired : 0,
    score: Number.isFinite(sc) && sc > 0 ? sc : null,
    year: Number.isFinite(on) ? on : null,
    genres: genreNames(x),
    image: abs(x.image?.preview) ?? abs(x.image?.original),
    url: abs(x.url) ?? `${SITE}/animes/${x.id}`,
    franchise: typeof x.franchise === "string" && x.franchise ? x.franchise : null,
  };
}

const query = (o: Record<string, string | number>): string => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

async function getList(url: string, fetchFn: FetchFn): Promise<PickTitle[] | null> {
  const j = await getJson(fetchFn, url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!Array.isArray(j)) return null;
  return j.map(parsePickTitle).filter((t): t is PickTitle => !!t);
}

/** Сезон по месяцу (как у Shikimori и MyAnimeList: зима — январь–март и т. д.): «fall_2026». */
export function seasonOf(year: number, month: number): string {
  return `${month <= 3 ? "winter" : month <= 6 ? "spring" : month <= 9 ? "summer" : "fall"}_${year}`;
}

/**
 * Сериалы сезона в одном жанре (по популярности), без жанров из `exclude` («!14,!18»): запрос «жанр и без таких-то» сайт понимает сам.
 * Жанры у новых тайтлов в списке не видны, поэтому спрашиваем по одному жанру за раз и знаем, какой жанр совпал.
 */
export const fetchSeasonGenre = (season: string, genre: number, exclude: string, limit: number, fetchFn: FetchFn): Promise<PickTitle[] | null> =>
  getList(`${SHIKI}?${query({ season, kind: "tv", order: "popularity", limit, genre: [genre, exclude].filter(Boolean).join(",") })}`, fetchFn);

/** «Похожее» у Shikimori для одного тайтла. */
export const fetchSimilarTo = (mal: number, fetchFn: FetchFn): Promise<PickTitle[] | null> => getList(`${SHIKI}/${mal}/similar`, fetchFn);

/** Страница рейтинга: вышедшие сериалы с высокой оценкой за период (например, «2010_2026»), по рейтингу, без жанров из `exclude`. */
export const fetchRanked = (era: string, page: number, limit: number, exclude: string, fetchFn: FetchFn): Promise<PickTitle[] | null> =>
  getList(`${SHIKI}?${query({ kind: "tv", status: "released", season: era, score: 8, order: "ranked", limit, page, ...(exclude ? { genre: exclude } : {}) })}`, fetchFn);

/**
 * Подбор по настроению («хочу что-то лёгкое»): вышедшие сериалы одного жанра с оценкой от 7 за период (например, «2010_2026»), по рейтингу,
 * сразу «без таких-то жанров» (`exclude` — «!14,!18»). Жанров в ответе нет: какой жанр совпал, видно по тому, о каком жанре спрашивали.
 */
export const fetchMoodGenre = (era: string, genre: number, exclude: string, page: number, limit: number, fetchFn: FetchFn): Promise<PickTitle[] | null> =>
  getList(`${SHIKI}?${query({ kind: "tv", status: "released", season: era, score: 7, order: "ranked", limit, page, genre: [genre, exclude].filter(Boolean).join(",") })}`, fetchFn);

/** Карточка одного тайтла (с жанрами). */
export async function fetchDetail(mal: number, fetchFn: FetchFn): Promise<PickTitle | null> {
  return parsePickTitle(await getJson(fetchFn, `${SHIKI}/${mal}`, { headers: { "User-Agent": UA }, redirect: "follow" }));
}
