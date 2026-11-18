// Источники чтения (разведка 2026-11-18, подробности — docs/RECON-READING.md):
//  • Shikimori (`/api/mangas`, `/api/ranobe`) — поиск, русские названия, состояние, итоговые цифры закончившихся тайтлов и аниме по манге (`related`).
//    У ИДУЩИХ тайтлов Shikimori отдаёт chapters = 0 и volumes = 0 (проверено: «Ван-Пис», «Фрирен», «SAO»): живого счётчика у него нет.
//  • MangaDex (`api.mangadex.org`, без ключа) — главы и тома манги: `aggregate` отдаёт все главы по томам; у многих глав есть ссылка на официальное чтение.
//    Склейка с Shikimori — по номеру MyAnimeList (`attributes.links.mal`). Есть русские переводы (`ru`), но отстают от английских.
//  • MangaUpdates (`api.mangaupdates.com/v1`, без ключа) — тома ранобэ: «28 Volumes (Ongoing)» в поле `status`. Номера MAL там нет, склейка по названию.
//  • RanobeHub (`ranobehub.org/api/search`, без ключа; robots.txt разрешает, закрыты только /api/user и /api/admin) — русские переводы ранобэ: в ответе поиска
//    у каждой книги `volumes` и `chapters` (сколько есть по-русски). Номера MAL нет, склейка по названию. Разведка 2026-11-18 — docs/RECON-READING-RU.md.
// AniList из Cloudflare Worker не отвечает (src/anime/sources.ts), поэтому не используется. Любой сбой = null: проверка повторится, ничего не ломаем.
import type { ReadKind } from "./core.ts";

export type FetchFn = typeof fetch;

const UA = "MeidoBot/1.0 (personal reminder bot)";
const TIMEOUT_MS = 3500;
const SHIKI = "https://shikimori.io/api";
const MD = "https://api.mangadex.org";
const MU = "https://api.mangaupdates.com/v1";
const RH = "https://ranobehub.org";

async function getJson(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<unknown | null> {
  try {
    const r = await fetchFn(url, { ...init, headers: { "User-Agent": UA, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ---------- Shikimori ----------

/** Тайтл Shikimori. `status`: наш словарь (ongoing идёт, finished закончен, anons анонс, paused перерыв, dropped прекращён); цифры — только у закончившихся. */
export interface ReadCand {
  mal: number;
  ru: string;
  orig: string;
  kind: ReadKind;
  status: string;
  volumes: number;
  chapters: number;
  year: number | null;
}

const MANGA_KINDS = new Set(["manga", "manhwa", "manhua", "one_shot"]);
const RANOBE_KINDS = new Set(["light_novel", "novel"]);
const SHIKI_STATUS: Record<string, string> = { ongoing: "ongoing", released: "finished", anons: "anons", paused: "paused", discontinued: "dropped" };

export function parseReadCand(a: unknown): ReadCand | null {
  const x = a as Record<string, unknown> | null;
  if (!x || typeof x.id !== "number") return null;
  const kind = String(x.kind ?? "");
  const rk: ReadKind | null = MANGA_KINDS.has(kind) ? "manga" : RANOBE_KINDS.has(kind) ? "ranobe" : null;
  if (!rk) return null;
  const ru = String(x.russian || x.name || "").trim();
  if (!ru) return null;
  const on = typeof x.aired_on === "string" ? Number.parseInt(x.aired_on.slice(0, 4), 10) : Number.NaN;
  return {
    mal: x.id,
    ru,
    orig: String(x.name ?? "").trim(),
    kind: rk,
    status: SHIKI_STATUS[String(x.status ?? "")] ?? "",
    volumes: typeof x.volumes === "number" && x.volumes > 0 ? x.volumes : 0,
    chapters: typeof x.chapters === "number" && x.chapters > 0 ? x.chapters : 0,
    year: Number.isFinite(on) ? on : null,
  };
}

/**
 * Поиск по названию: манга — `/mangas`, ранобэ — `/ranobe`; без подсказки смотрим оба (в порядке популярности внутри каждого).
 * null — Shikimori не ответил совсем; пустой список — ничего не нашлось.
 */
export async function searchRead(query: string, hint: ReadKind | null, fetchFn: FetchFn): Promise<ReadCand[] | null> {
  const q = new URLSearchParams({ search: query, limit: "8", order: "popularity" });
  const parts: ReadCand[][] = [];
  let answered = false;
  for (const [kind, path] of [["manga", "mangas"], ["ranobe", "ranobe"]] as const) {
    if (hint && hint !== kind) continue;
    const j = await getJson(fetchFn, `${SHIKI}/${path}?${q}`);
    if (!Array.isArray(j)) continue;
    answered = true;
    parts.push(j.map(parseReadCand).filter((c): c is ReadCand => !!c && c.kind === kind).slice(0, 4));
  }
  return answered ? parts.flat().slice(0, 6) : null;
}

/** Тайтл по номеру MAL: название, состояние и (у закончившихся) итоговое число глав и томов. Номера общие для манги и ранобэ. */
export async function shikiOne(mal: number, fetchFn: FetchFn): Promise<ReadCand | null> {
  return parseReadCand(await getJson(fetchFn, `${SHIKI}/mangas/${mal}`));
}

/** Аниме по этому тайтлу (relation «Adaptation»). */
export interface Adapt {
  mal: number;
  ru: string;
  /** anons анонс, ongoing идёт, released вышло */
  status: string;
}

/** Все аниме-адаптации тайтла (Shikimori `related`). null — не ответил. */
export async function fetchAdaptations(mal: number, fetchFn: FetchFn): Promise<Adapt[] | null> {
  const j = await getJson(fetchFn, `${SHIKI}/mangas/${mal}/related`);
  if (!Array.isArray(j)) return null;
  const out: Adapt[] = [];
  for (const it of j as Record<string, any>[]) {
    const x = it?.anime;
    if (String(it?.relation) !== "Adaptation" || !x || typeof x.id !== "number") continue;
    const ru = String(x.russian || x.name || "").trim();
    if (ru) out.push({ mal: x.id, ru, status: String(x.status ?? "") });
  }
  return out;
}

/** Из адаптаций — та, о которой стоит сказать: идёт сейчас, иначе анонсированная. Всё вышедшее — не новость (null). */
export function pickAdapt(list: Adapt[]): Adapt | null {
  return list.find((a) => a.status === "ongoing") ?? list.find((a) => a.status === "anons") ?? null;
}

// ---------- MangaDex ----------

const RATINGS = ["safe", "suggestive", "erotica", "pornographic"];

/** Тайтл MangaDex, найденный по номеру MAL. */
export interface MdTitle {
  id: string;
  langs: string[];
}

/**
 * Найти тайтл на MangaDex: поиск по оригинальному названию, выбор — только запись, у которой `links.mal` совпал с номером Shikimori.
 * Из нескольких (например «цветная версия») берём ту, где больше языков. "none" — поиск прошёл, такой записи нет; null — MangaDex не ответил.
 */
export async function findMangaDex(mal: number, orig: string, fetchFn: FetchFn): Promise<MdTitle | "none" | null> {
  if (!orig.trim()) return "none";
  const q = new URLSearchParams({ title: orig.trim(), limit: "10" });
  for (const r of RATINGS) q.append("contentRating[]", r);
  const j = (await getJson(fetchFn, `${MD}/manga?${q}`)) as { data?: unknown } | null;
  if (!j || !Array.isArray(j.data)) return null;
  let best: MdTitle | null = null;
  for (const m of j.data as Record<string, any>[]) {
    if (m?.type !== "manga" || String(m?.attributes?.links?.mal ?? "") !== String(mal) || typeof m.id !== "string") continue;
    const langs: string[] = Array.isArray(m.attributes.availableTranslatedLanguages) ? m.attributes.availableTranslatedLanguages.map(String) : [];
    if (!best || langs.length > best.langs.length) best = { id: m.id, langs };
  }
  return best ?? "none";
}

/** Последние глава и том по ответу `aggregate`: наибольшие целые номера (дробные, «12.5», считаем за их целую часть: бонусные главы Ihor не любит). */
export function parseAggregate(j: unknown): { ch: number; vol: number } | null {
  const x = j as { result?: unknown; volumes?: unknown } | null;
  if (!x || x.result !== "ok" || !x.volumes || typeof x.volumes !== "object") return null;
  let ch = 0;
  let vol = 0;
  for (const [vk, v] of Object.entries(x.volumes as Record<string, any>)) {
    const vn = Math.floor(Number.parseFloat(vk));
    if (vk !== "none" && Number.isFinite(vn) && vn > vol) vol = vn;
    for (const ck of Object.keys(v?.chapters ?? {})) {
      const cn = Math.floor(Number.parseFloat(ck));
      if (ck !== "none" && Number.isFinite(cn) && cn > ch && cn < 10_000) ch = cn;
    }
  }
  return { ch, vol };
}

const aggregateUrl = (id: string, langs: string[]): string => {
  const q = new URLSearchParams();
  for (const l of langs) q.append("translatedLanguage[]", l);
  return `${MD}/manga/${id}/aggregate?${q}`;
};

/** Последние глава и том по всем переводам (русский и английский). null — MangaDex не ответил. */
export async function mdProgress(id: string, fetchFn: FetchFn): Promise<{ ch: number; vol: number } | null> {
  return parseAggregate(await getJson(fetchFn, aggregateUrl(id, ["ru", "en"])));
}

/** Последние глава и том на русском ({0, 0} — русского перевода нет). null — не ответил. */
export async function mdRussian(id: string, fetchFn: FetchFn): Promise<{ ch: number; vol: number } | null> {
  return parseAggregate(await getJson(fetchFn, aggregateUrl(id, ["ru"])));
}

/** Ссылка на последнюю главу по-русски: официальная (`externalUrl`) или страница главы на MangaDex. null — не ответил или русских глав нет. */
export async function mdLatestLink(id: string, fetchFn: FetchFn): Promise<string | null> {
  const q = new URLSearchParams({ limit: "1", includeFutureUpdates: "0" });
  q.append("order[chapter]", "desc");
  q.append("translatedLanguage[]", "ru");
  for (const r of RATINGS) q.append("contentRating[]", r);
  const j = (await getJson(fetchFn, `${MD}/manga/${id}/feed?${q}`)) as { data?: unknown } | null;
  const c = Array.isArray(j?.data) ? (j?.data[0] as Record<string, any> | undefined) : undefined;
  if (!c || typeof c.id !== "string") return null;
  const ext = c.attributes?.externalUrl;
  return typeof ext === "string" && /^https:\/\//.test(ext) ? ext : `https://mangadex.org/chapter/${c.id}`;
}

/** Страница тайтла на MangaDex (запасная ссылка). */
export const mdTitleUrl = (id: string): string => `https://mangadex.org/title/${id}`;

// ---------- MangaUpdates (тома ранобэ) ----------

const stripNovel = (t: string): string => t.replace(/\s*\((?:novel|light novel|web novel)\)\s*$/i, "");
const lc = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Найти ранобэ на MangaUpdates: заголовок после снятия «(Novel)» должен совпасть с оригинальным названием целиком. "none" — нет; null — не ответил. */
export async function findMangaUpdates(orig: string, fetchFn: FetchFn): Promise<number | "none" | null> {
  const want = lc(orig);
  if (!want) return "none";
  const j = (await getJson(fetchFn, `${MU}/series/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ search: orig, perpage: 10, type: ["Novel"] }) })) as { results?: unknown } | null;
  if (!j || !Array.isArray(j.results)) return null;
  for (const it of j.results as Record<string, any>[]) {
    const rec = it?.record;
    if (rec && typeof rec.series_id === "number" && lc(stripNovel(String(rec.title ?? ""))) === want) return rec.series_id;
  }
  return "none";
}

/** Тома по строке состояния MangaUpdates: «28 Volumes (Ongoing)», «26 LN Volumes (Complete)\n24 Web Volumes (Complete)». Веб-тома не считаем. */
export function parseMuStatus(s: string): { vol: number; finished: boolean } | null {
  if (typeof s !== "string") return null;
  let best: { vol: number; finished: boolean } | null = null;
  for (const m of s.matchAll(/(\d{1,4})\s+(Web\s+|LN\s+)?Volumes?\s*\((Ongoing|Complete|Hiatus|Cancelled)\)/gi)) {
    if (/^web/i.test(m[2] ?? "")) continue;
    const vol = Number.parseInt(m[1], 10);
    if (!best || vol > best.vol) best = { vol, finished: /complete/i.test(m[3]) };
  }
  return best;
}

/** Тома ранобэ по MangaUpdates. {vol: 0} — строка не разобралась. null — не ответил. */
export async function muVolumes(id: number, fetchFn: FetchFn): Promise<{ vol: number; finished: boolean } | null> {
  const j = (await getJson(fetchFn, `${MU}/series/${id}`)) as { status?: unknown } | null;
  if (!j) return null;
  return parseMuStatus(String(j.status ?? "")) ?? { vol: 0, finished: false };
}

// ---------- RanobeHub (русские переводы ранобэ) ----------

/** Книга из ответа поиска RanobeHub: сколько томов и глав есть по-русски. */
export interface RhBook {
  id: number;
  /** название по-русски */
  ru: string;
  /** оригинальное название (английское, японское — как заведено на сайте) */
  orig: string;
  vol: number;
  ch: number;
}

/** Ссылка на страницу тайтла (сайт сам перенаправит на «…-название»). */
export const rhTitleUrl = (id: number): string => `${RH}/ranobe/${id}`;

export function parseRhBooks(j: unknown): RhBook[] {
  const list = (j as { books?: unknown } | null)?.books;
  if (!Array.isArray(list)) return [];
  const out: RhBook[] = [];
  for (const b of list as Record<string, unknown>[]) {
    if (!b || typeof b.id !== "number") continue;
    const nn = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 10_000 ? Math.floor(v) : 0);
    out.push({ id: b.id, ru: String(b.title ?? ""), orig: String(b.originalTitle ?? ""), vol: nn(b.volumes), ch: nn(b.chapters) });
  }
  return out;
}

/** Поиск по названию (до шести книг, самые подходящие первыми). null — не ответил. */
export async function rhSearch(q: string, fetchFn: FetchFn): Promise<RhBook[] | null> {
  const j = await getJson(fetchFn, `${RH}/api/search?${new URLSearchParams({ q })}`);
  return j && typeof j === "object" && Array.isArray((j as { books?: unknown }).books) ? parseRhBooks(j) : null;
}

/** Название без пометок вида «(LN)», «(Новелла)», «[перевод …]» и без регистра, ё и знаков: для точного сравнения. */
const rhCore = (t: string): string =>
  t
    .replace(/\[[^\]]*\]|\((?:ln|лн|novel|новелла|light novel|web novel|ранобэ)\)/giu, " ")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Книги с пометкой другого языка («[Украинский]») не берём: это не русский перевод. */
const OTHER_LANG = /\[\s*(?:украинск|белорусск|английск|польск|немецк|французск)[^\]]*\]/iu;

/**
 * Из ответа поиска выбрать нужную книгу: название по-русски или оригинальное совпало целиком (после снятия пометок вроде «(LN)»).
 * Несколько совпадений — берём ту, где больше томов (у веб-версии обычно один «том»), потом больше глав, потом меньший номер. Похожее не берём: лучше «нет», чем чужая книга.
 */
export function pickRh(books: RhBook[], orig: string, ru: string): RhBook | null {
  const o = rhCore(orig);
  const r = rhCore(ru);
  const ok = books.filter((b) => !OTHER_LANG.test(b.ru) && ((o !== "" && rhCore(b.orig) === o) || (r !== "" && rhCore(b.ru) === r)));
  return [...ok].sort((x, y) => y.vol - x.vol || y.ch - x.ch || x.id - y.id)[0] ?? null;
}

/** Найти ранобэ на RanobeHub по оригинальному, потом по русскому названию. "none" — нет; null — сайт не ответил. */
export async function findRanobeHub(orig: string, ru: string, fetchFn: FetchFn): Promise<RhBook | "none" | null> {
  const queries = [...new Set([orig.trim(), ru.trim()].filter(Boolean))];
  for (const q of queries) {
    const books = await rhSearch(q, fetchFn);
    if (books === null) return null;
    const b = pickRh(books, orig, ru);
    if (b) return b;
  }
  return "none";
}

/** Свежие цифры уже найденной книги (повторный поиск по названию и выбор по номеру). null — сайт не ответил или книги в выдаче нет: прежние цифры остаются. */
export async function rhRefresh(id: number, orig: string, ru: string, fetchFn: FetchFn): Promise<RhBook | null> {
  for (const q of [...new Set([orig.trim(), ru.trim()].filter(Boolean))]) {
    const books = await rhSearch(q, fetchFn);
    if (books === null) return null;
    const b = books.find((x) => x.id === id);
    if (b) return b;
  }
  return null;
}
