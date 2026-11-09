// Аниме: чистые функции без базы и сети — состояние серий, разбор фразы, показ времени, реплики Хару.
import type { Character } from "../flavor.ts";
import { fmtHHMM, startOfDay, wallOf } from "../time/tz.ts";
import { MINUTE } from "../time/tz.ts";

export type AnimeStatus = "watching" | "planned" | "done" | "dropped";

export interface Anime {
  id: number;
  mal_id: number;
  anilist_id: number | null;
  title_ru: string;
  title_orig: string | null;
  status: AnimeStatus;
  watched: number;
  liked: number;
  notify: number;
  episodes: number | null;
  src_status: string | null;
  next_ep: number | null;
  next_at: number | null;
  aired_ep: number;
  aired_at: number | null;
  asked_ep: number;
  added_at: number;
  updated_at: number;
}

/** До скольких тайтлов в «Смотрю» бот присылает уведомления (решение Ihor: «можно больше, но уведомления только по первым 5»). */
export const NOTICE_LIMIT = 5;

export const STATUS_CODE: Record<AnimeStatus, string> = { watching: "w", planned: "p", done: "d", dropped: "x" };
export const CODE_STATUS: Record<string, AnimeStatus> = { w: "watching", p: "planned", d: "done", x: "dropped" };
export const STATUS_LABEL: Record<AnimeStatus, string> = { watching: "Смотрю", planned: "В планах", done: "Просмотрено", dropped: "Бросил" };
export const STATUS_ORDER: AnimeStatus[] = ["watching", "planned", "done", "dropped"];

/** Состояние серий на момент `now`: что уже вышло и что дальше. Опирается на сохранённое «ближайшая серия выйдет тогда-то». */
export function effective(a: Anime, now: number): { airedEp: number; airedAt: number | null; upcoming: { ep: number; at: number } | null } {
  const passed = a.next_ep !== null && a.next_at !== null && a.next_at <= now;
  const airedEp = passed ? Math.max(a.aired_ep, a.next_ep as number) : a.aired_ep;
  const airedAt = passed && (a.next_ep as number) >= a.aired_ep ? a.next_at : a.aired_at;
  const upcoming = a.next_ep !== null && a.next_at !== null && a.next_at > now ? { ep: a.next_ep, at: a.next_at } : null;
  return { airedEp, airedAt, upcoming };
}

/** Тайтлы «Смотрю», по которым идут уведомления: с включённым колокольчиком, первые 5 по порядку добавления. */
export function noticeSet(rows: Anime[]): Anime[] {
  return rows.filter((a) => a.status === "watching" && a.notify === 1).sort((x, y) => x.id - y.id).slice(0, NOTICE_LIMIT);
}

// ---------- время ----------

const WD = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** «сегодня 19:30», «завтра 02:30», «пт 19:30», дальше недели — «5 дек 19:30». */
export function whenShort(ms: number, now: number, tz: string): string {
  const w = wallOf(ms, tz);
  const hhmm = fmtHHMM(w.h * 60 + w.mi);
  const days = Math.round((startOfDay(ms, tz) - startOfDay(now, tz)) / (24 * 60 * MINUTE));
  if (days === 0) return `сегодня ${hhmm}`;
  if (days === 1) return `завтра ${hhmm}`;
  if (days === -1) return `вчера ${hhmm}`;
  if (days > 1 && days < 7) return `${WD[w.wd]} ${hhmm}`;
  return `${w.d} ${MONTHS[w.mo]} ${hhmm}`;
}

/** Только день: «сегодня», «пт», «5 дек». */
export function dayShort(ms: number, now: number, tz: string): string {
  const w = wallOf(ms, tz);
  const days = Math.round((startOfDay(ms, tz) - startOfDay(now, tz)) / (24 * 60 * MINUTE));
  if (days === 0) return "сегодня";
  if (days === 1) return "завтра";
  if (days > 1 && days < 7) return WD[w.wd];
  return `${w.d} ${MONTHS[w.mo]}`;
}

// ---------- показ ----------

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const likeMark = (a: Anime): string => (a.liked === 2 ? "🔥 " : a.liked === 1 ? "❤ " : "");

/** Хвост строки списка про серии: на какой я и что дальше. */
export function progressText(a: Anime, now: number, tz: string): string {
  const e = effective(a, now);
  if (a.status === "planned") {
    if (e.upcoming) return `${e.upcoming.ep === 1 ? "старт" : `${e.upcoming.ep}-я`}: ${whenShort(e.upcoming.at, now, tz)}`;
    return a.src_status === "FINISHED" || a.src_status === "RELEASING" ? "уже вышло" : "дата не объявлена";
  }
  if (a.status === "done") return a.episodes ? `${a.episodes} сер.` : `серия ${a.watched}`;
  if (a.status === "dropped") return `остановился на ${a.watched}`;
  const parts = [`серия ${a.watched}`];
  if (e.airedEp > a.watched) parts.push(`вышла ${e.airedEp}-я`);
  if (e.upcoming) parts.push(`${e.upcoming.ep}-я: ${whenShort(e.upcoming.at, now, tz)}`);
  else if (a.src_status === "FINISHED") parts.push("всё вышло");
  else parts.push("дата не объявлена");
  return parts.join(" · ");
}

// ---------- фраза ----------

export interface AnimePhrase {
  status: AnimeStatus;
  query: string;
  episode: number | null;
}

const VERB: [RegExp, AnimeStatus][] = [
  [/^(смотрю|смотрела)$/i, "watching"],
  [/^(хочу|в планах|запланировал|запланировала|планирую)$/i, "planned"],
  [/^(посмотрел|посмотрела|досмотрел|досмотрела)$/i, "done"],
  [/^(бросил|бросила|дропнул|дропнула)$/i, "dropped"],
];

const EP_TAIL = /\s+(?:на\s+)?(?:сери[яюи]\s+(\d{1,4})|(\d{1,4})(?:-?[яйюе])?\s+сери[яюи])\s*$/i;

/**
 * Фраза «бот смотрю фрирен», «аниме хочу блич», «бот бросил ДжоДжо», «бот смотрю фрирен серия 4».
 * Без слова «бот» или «аниме» в начале — не наша фраза (обычные дела вроде «хочу купить хлеб» остаются делами).
 */
export function parseAnimePhrase(text: string): AnimePhrase | null {
  const m = /^\s*(?:бот|аниме)\s*[,:;.\-–—]?\s*(?:аниме\s*[,:;.\-–—]?\s*)?(в планах|[а-яё]+)\s*[:\-–—]?\s*(.+?)\s*$/is.exec(text);
  if (!m) return null;
  const verb = m[1].trim();
  const hit = VERB.find(([re]) => re.test(verb));
  if (!hit) return null;
  let query = m[2].trim().replace(/[.!?…]+$/u, "").trim();
  let episode: number | null = null;
  const e = EP_TAIL.exec(query);
  if (e) {
    episode = Number.parseInt(e[1] ?? e[2], 10);
    query = query.slice(0, e.index).trim();
  }
  query = query.replace(/^[«"“]|[»"”]$/gu, "").trim();
  if (!query) return null;
  return { status: hit[1], query, episode };
}

export const norm = (s: string): string => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();

/** Единственное совпадение в своём списке (по русскому или оригинальному названию); несколько или ни одного — null. */
export function findOwn(rows: Anime[], query: string): Anime | null {
  const q = norm(query);
  if (!q) return null;
  const exact = rows.filter((a) => norm(a.title_ru) === q || norm(a.title_orig ?? "") === q);
  if (exact.length === 1) return exact[0];
  const part = rows.filter((a) => norm(a.title_ru).includes(q) || norm(a.title_orig ?? "").includes(q));
  return part.length === 1 ? part[0] : null;
}

// ---------- реплики Хару ----------

type LineKind = "list" | "listEmpty" | "listPlanned" | "listDone" | "listDropped" | "card" | "ep" | "liked" | "dropped" | "added" | "ask" | "tonight" | "unclear";

const LINES: Record<LineKind, string[]> = {
  list: ["Всё записано. Я ничего не пропускаю, даже когда очень хочется.", "Вот. Не благодарите, я просто стою рядом.", "Список у меня. Вы смотрите, а я помню."],
  listEmpty: ["Здесь пусто. Добавьте что-нибудь, пока я не заскучала. Я не скучаю, я просто сказала."],
  listPlanned: ["«Потом» тоже записано. Я напомню, когда оно наступит."],
  listDone: ["Всё это вы уже пережили. Я горжусь. Немного."],
  listDropped: ["Бросили, и ладно. Я не осуждаю. Почти."],
  card: ["Это всё, что я знаю. А я знаю много."],
  ep: ["Принято. Следующую я тоже запомню.", "Серия отмечена. Чай остыл, но это ничего."],
  liked: ["Рада, что понравилось. Я тоже… нет, не скажу.", "Записала. У вас хороший вкус, хозяин."],
  dropped: ["Понимаю. Не всё стоит времени."],
  added: ["Записала. Положила в нужный ящик.", "Готово. Я запомнила, вам не нужно."],
  ask: ["Спрашиваю один раз в день. Больше не буду. Наверное."],
  tonight: ["Хорошо, что вы всё ещё смотрите. Чай заварила.", "Не забудьте. Я не напоминаю, я констатирую."],
  unclear: ["Тут есть варианты. Выберите, я не телепат."],
};

/** Короткая реплика Хару: только при характере «горничная», без перебора (одна на сообщение). */
export function haru(kind: LineKind, character: Character, rand: () => number = Math.random): string | null {
  if (character !== "maid") return null;
  const pool = LINES[kind];
  return pool[Math.floor(rand() * pool.length) % pool.length];
}
