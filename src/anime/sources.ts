// Источники аниме (docs/RECON-ANIME.md): Shikimori — поиск, русские названия и расписание серий (время с точностью до минуты совпадает с AniList).
// AniList из Cloudflare Worker не отвечает (403 «manually blocked», проба 2026-11-10), поэтому не используется. Любой сбой = null.
import type { Voice } from "./core.ts";

export type FetchFn = typeof fetch;

export const UA = "MeidoBot/1.0 (personal reminder bot)";
const TIMEOUT_MS = 2500;
export const SHIKI = "https://shikimori.io/api/animes";

/** Тайтл из поиска Shikimori. `status`: anons — анонс, ongoing — идёт, released — вышел. */
export interface Candidate {
  mal: number;
  ru: string;
  orig: string;
  kind: string;
  status: string;
  episodes: number;
  year: number | null;
}

/** Расписание серий. `nextAt` — миллисекунды UTC; `aired` — сколько серий уже вышло. */
export interface Schedule {
  mal: number;
  anilist: number | null;
  orig: string;
  /** RELEASING идёт, FINISHED закончилось, NOT_YET_RELEASED анонс */
  status: string;
  episodes: number | null;
  aired: number;
  nextEp: number | null;
  nextAt: number | null;
}

const KINDS = new Set(["tv", "ona", "movie", "ova", "special", "tv_special"]);

export function parseCandidate(a: unknown): Candidate | null {
  const x = a as Record<string, unknown> | null;
  if (!x || typeof x.id !== "number") return null;
  const ru = String(x.russian || x.name || "").trim();
  if (!ru) return null;
  const on = typeof x.aired_on === "string" ? Number.parseInt(x.aired_on.slice(0, 4), 10) : NaN;
  return {
    mal: x.id,
    ru,
    orig: String(x.name ?? "").trim(),
    kind: String(x.kind ?? ""),
    status: String(x.status ?? ""),
    episodes: typeof x.episodes === "number" ? x.episodes : 0,
    year: Number.isFinite(on) ? on : null,
  };
}

export async function getJson(fetchFn: FetchFn, url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Поиск по названию (по-русски или по-английски): до 6 тайтлов, в порядке популярности. null — Shikimori не ответил. */
export async function searchShiki(query: string, fetchFn: FetchFn): Promise<Candidate[] | null> {
  const q = new URLSearchParams({ search: query, limit: "8", order: "popularity" });
  const j = await getJson(fetchFn, `${SHIKI}?${q}`, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!Array.isArray(j)) return null;
  return j.map(parseCandidate).filter((c): c is Candidate => !!c && KINDS.has(c.kind)).slice(0, 6);
}


const STATUS: Record<string, string> = { ongoing: "RELEASING", released: "FINISHED", anons: "NOT_YET_RELEASED" };

/** Расписание из ответа Shikimori: `/api/animes/{id}` (номер следующей серии считаем сами) или элемент `/api/calendar`. */
export function scheduleFrom(raw: unknown, nextEpisode?: number): Schedule | null {
  const x = raw as Record<string, unknown> | null;
  if (!x || typeof x.id !== "number") return null;
  const aired = typeof x.episodes_aired === "number" ? x.episodes_aired : 0;
  const at = typeof x.next_episode_at === "string" ? Date.parse(x.next_episode_at) : NaN;
  const hasNext = Number.isFinite(at);
  return {
    mal: x.id,
    anilist: null,
    orig: String(x.name ?? ""),
    status: STATUS[String(x.status)] ?? "",
    episodes: typeof x.episodes === "number" && x.episodes > 0 ? x.episodes : null,
    aired,
    nextEp: hasNext ? (nextEpisode ?? aired + 1) : null,
    nextAt: hasNext ? at : null,
  };
}

/** Тайтл целиком: название и расписание из одного запроса. */
export async function getShikiFull(mal: number, fetchFn: FetchFn): Promise<{ cand: Candidate; sch: Schedule } | null> {
  const j = await getJson(fetchFn, `${SHIKI}/${mal}`, { headers: { "User-Agent": UA }, redirect: "follow" });
  const cand = parseCandidate(j);
  const sch = scheduleFrom(j);
  return cand && sch ? { cand, sch } : null;
}

/** Календарь Shikimori: то, что выходит в ближайшие дни, одним запросом. */
export async function fetchCalendar(fetchFn: FetchFn): Promise<Schedule[] | null> {
  const j = await getJson(fetchFn, "https://shikimori.io/api/calendar", { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!Array.isArray(j)) return null;
  const out: Schedule[] = [];
  for (const it of j as Record<string, any>[]) {
    const s = scheduleFrom(it?.anime ? { ...it.anime, next_episode_at: it.next_episode_at } : null, typeof it?.next_episode === "number" ? it.next_episode : undefined);
    if (s) out.push(s);
  }
  return out;
}

// ---------- озвучка AniLibria ----------

/** Расписание недели у AniLibria. `include` оставляет только нужные поля: 5 КБ вместо 270 (Worker не парсит лишнее). */
const VOICE_URL =
  "https://anilibria.top/api/v1/anime/schedule/week?include=release.mal.id,release.fresh_at,release.is_ongoing,release.publish_day.value,next_release_episode_number";

const asTime = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Разбор ответа AniLibria: по тайтлу — когда вышла последняя озвученная серия и какая следующая. Склейка — по номеру MyAnimeList. */
export function parseVoice(j: unknown): Voice[] | null {
  if (!Array.isArray(j)) return null;
  const out: Voice[] = [];
  for (const it of j as Record<string, any>[]) {
    const r = it?.release;
    const mal = r?.mal?.id;
    if (typeof mal !== "number") continue;
    out.push({
      mal,
      freshAt: asTime(r.fresh_at),
      nextEp: typeof it.next_release_episode_number === "number" ? it.next_release_episode_number : null,
      ongoing: r.is_ongoing === true,
    });
  }
  return out;
}

/** null — AniLibria не ответил (озвучка необязательна: молчим, повторим). */
export async function fetchVoice(fetchFn: FetchFn): Promise<Voice[] | null> {
  return parseVoice(await getJson(fetchFn, VOICE_URL, { headers: { "User-Agent": UA }, redirect: "follow" }));
}

// ---------- продолжение сезона ----------

/** Продолжение, которое анонсировано или уже идёт. */
export interface Sequel {
  mal: number;
  ru: string;
  orig: string;
  status: string;
}

/** Связанные тайтлы Shikimori: продолжения (relation «Sequel»), которые ещё не закончились. null — не ответил. */
export async function fetchSequels(mal: number, fetchFn: FetchFn): Promise<Sequel[] | null> {
  const j = await getJson(fetchFn, `${SHIKI}/${mal}/related`, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!Array.isArray(j)) return null;
  const out: Sequel[] = [];
  for (const it of j as Record<string, any>[]) {
    const x = it?.anime;
    if (String(it?.relation) !== "Sequel" || !x || typeof x.id !== "number" || !KINDS.has(String(x.kind))) continue;
    const status = String(x.status ?? "");
    const ru = String(x.russian || x.name || "").trim();
    if ((status === "anons" || status === "ongoing") && ru) out.push({ mal: x.id, ru, orig: String(x.name ?? ""), status });
  }
  return out;
}

/**
 * Ночное обновление: календарь одним запросом, для тайтлов, которых в нём нет (закончились, анонсы, перерыв), — отдельные запросы
 * по номеру, не больше `extra`. null — Shikimori не ответил совсем. Какие не успели — доберём следующей ночью.
 */
export async function fetchSchedules(mals: number[], fetchFn: FetchFn, extra = 8): Promise<Schedule[] | null> {
  if (!mals.length) return [];
  const cal = await fetchCalendar(fetchFn);
  if (cal === null) return null;
  const out = cal.filter((c) => mals.includes(c.mal));
  const missing = mals.filter((m) => !out.some((c) => c.mal === m)).slice(0, extra);
  for (const m of missing) {
    const full = await getShikiFull(m, fetchFn);
    if (full) out.push(full.sch);
  }
  return out;
}
