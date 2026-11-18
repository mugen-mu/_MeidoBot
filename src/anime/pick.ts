// Субботняя подборка «что посмотреть» от Хару: чистые функции (без базы и сети): выбор тайтлов и вид сообщения.
// Пять частей (решение Ihor, волна 3, docs/DECISIONS.md): пропущенные серии, из «В планах», новинки сезона в его жанрах,
// похожее на недавнее любимое, сюрприз. Что откуда берётся и сколько запросов это стоит — в pickCron.ts.
import type { Character } from "../flavor.ts";
import { voiceText } from "../discord/ui.ts";
import type { Embed, MessageBody } from "../discord/types.ts";
import { MINUTE, wallOf } from "../time/tz.ts";
import { type Anime, clip, effective, sinceText, voiceLine, whenShort } from "./core.ts";
import { DEFAULT_AVOID, DEFAULT_LIKES, GENRE_LABEL, type GenreKey, WARN_GENRES, classify } from "./pickGenres.ts";
import type { PickTitle } from "./pickSources.ts";

// ---------- когда и сколько ----------

/** Суббота (wallOf().wd: 1 = пн … 7 = вс). */
export const PICK_DAY = 6;
/** Сколько после назначенного времени ещё можно отправить (тихие часы, нехватка запаса подзапросов): до конца этого окна, но не за полночь. */
export const PICK_WINDOW = 6 * 60;
/**
 * Не больше стольких обращений к Shikimori за один запуск Worker (в бесплатной норме 50 подзапросов на запуск, остальное делают другие части бота).
 * Худший случай по частям: карточка плана 1 + новинки (до 6 запросов, по одному на любимый жанр) + похожее (до 2 списков + 2 карточки) + сюрприз (список 1 + до 3 карточек) = 15.
 */
export const PICK_FETCH_CAP = 15;
/** Сколько раз пробуем, если Shikimori не отвечает; на последней отправляем, что есть, и честно говорим, чего нет. */
export const PICK_TRIES = 3;
export const PICK_RETRY = 15 * MINUTE;
/** Один и тот же тайтл не предлагаем повторно столько недель; опорный «любимый» тайтл для «похожего» — столько. */
export const REPEAT_WEEKS = 8;
export const BASE_WEEKS = 4;
/** Не больше стольких строк «вышло, а вы не смотрели» (остальное — «и ещё N»). */
export const MISSED_SHOWN = 10;

export interface PickConfig {
  /** любимые жанры (для «новинок»; у «сюрприза» наоборот — лучше вне них) */
  likes: GenreKey[];
  /** не предлагаем совсем */
  avoid: GenreKey[];
  /** предупреждаем, если такое попало (ужасы и меха) */
  warn: GenreKey[];
}

export const DEFAULT_PICK_CONFIG: PickConfig = { likes: DEFAULT_LIKES, avoid: DEFAULT_AVOID, warn: WARN_GENRES };

// ---------- что уже предлагали ----------

const WEEK_MS = 7 * 24 * 60 * MINUTE;
const MAX_SEEN = 80;
export const weekNo = (ms: number): number => Math.floor(ms / WEEK_MS);

/** Что предлагали: `r` — предложенные тайтлы, `b` — тайтлы, от которых искали «похожее»; значение — номер недели. */
export interface Seen {
  r: Record<number, number>;
  b: Record<number, number>;
}

export function parseSeen(raw: string | undefined): Seen {
  const out: Seen = { r: {}, b: {} };
  if (!raw) return out;
  try {
    const j = JSON.parse(raw) as Partial<Seen>;
    for (const k of ["r", "b"] as const) {
      const src = j[k];
      if (src && typeof src === "object") for (const [id, wk] of Object.entries(src)) if (Number.isFinite(Number(id)) && typeof wk === "number") out[k][Number(id)] = wk;
    }
  } catch {
    /* повреждено: начинаем заново */
  }
  return out;
}

/** Отметить предложенное и опорные тайтлы; старое (давнее REPEAT_WEEKS) забываем, всего не больше MAX_SEEN самых свежих. */
export function markSeen(seen: Seen, recs: number[], bases: number[], now: number): Seen {
  const wk = weekNo(now);
  const trim = (m: Record<number, number>, add: number[]): Record<number, number> => {
    const all = { ...m };
    for (const id of add) all[id] = wk;
    return Object.fromEntries(
      Object.entries(all)
        .filter(([, v]) => wk - v < REPEAT_WEEKS)
        .sort((x, y) => y[1] - x[1])
        .slice(0, MAX_SEEN),
    ) as Record<number, number>;
  };
  return { r: trim(seen.r, recs), b: trim(seen.b, bases) };
}

const recent = (m: Record<number, number>, mal: number, now: number, weeks: number): boolean => m[mal] !== undefined && weekNo(now) - m[mal] < weeks;

// ---------- 1. пропущенные серии ----------

export interface Missed {
  a: Anime;
  airedEp: number;
  airedAt: number | null;
  /** сколько серий вы не посмотрели */
  behind: number;
}

/** «Смотрю» с включённым колокольчиком: вышло больше, чем вы отметили. Сначала самые свежие. */
export function missedEpisodes(rows: Anime[], now: number): Missed[] {
  return rows
    .filter((a) => a.status === "watching" && a.notify === 1)
    .map((a) => ({ a, e: effective(a, now) }))
    .filter((x) => x.e.airedEp > x.a.watched)
    .map((x) => ({ a: x.a, airedEp: x.e.airedEp, airedAt: x.e.airedAt, behind: x.e.airedEp - x.a.watched }))
    .sort((x, y) => (y.airedAt ?? 0) - (x.airedAt ?? 0) || x.a.id - y.a.id);
}

/** Про озвучку (Ihor смотрит в русской озвучке, AniLibria): когда она, по обычной задержке, появится. null — тайтла нет у AniLibria. */
export function dubNote(a: Anime, airedAt: number | null, now: number, tz: string): { text: string; ready: boolean } | null {
  if (a.voice_lag === null) return null;
  if (airedAt === null) return { text: voiceLine(a) ?? "", ready: true };
  const at = airedAt + a.voice_lag * MINUTE;
  return at <= now ? { text: "🎙 в озвучке по обычной задержке уже есть", ready: true } : { text: `⏳ озвучка AniLibria примерно ${whenShort(at, now, tz)}`, ready: false };
}

export function missedLine(m: Missed, now: number, tz: string): string {
  const me = m.a.watched ? `вы на ${m.a.watched}-й` : "вы ещё не начинали";
  const miss = m.behind > 1 && m.a.watched ? `, пропущено ${m.behind}` : "";
  const dub = dubNote(m.a, m.airedAt, now, tz);
  return `• **${clip(m.a.title_ru, 50)}** — вышла ${m.airedEp}-я${m.airedAt !== null ? ` (${whenShort(m.airedAt, now, tz)})` : ""}, ${me}${miss}${dub ? ` · ${dub.text}` : ""}`;
}

// ---------- 2. из «В планах» ----------

/** Почему именно это: airing — сейчас идёт и уже есть что смотреть; short — короткое; waiting — давно лежит. */
export type PlannedWhy = "airing" | "short" | "waiting";

export function pickPlanned(rows: Anime[], now: number, seen: Seen, rand: () => number): { a: Anime; why: PlannedWhy } | null {
  const ok = rows.filter((a) => a.status === "planned" && !recent(seen.r, a.mal_id, now, REPEAT_WEEKS) && (effective(a, now).airedEp >= 1 || a.src_status === "FINISHED"));
  const tiers: [PlannedWhy, Anime[]][] = [
    ["airing", ok.filter((a) => a.src_status === "RELEASING" && effective(a, now).airedEp >= 1)],
    ["short", ok.filter((a) => a.src_status === "FINISHED" && (a.episodes ?? 0) > 0 && (a.episodes ?? 0) <= 13)],
    ["waiting", ok],
  ];
  for (const [why, list] of tiers) {
    if (!list.length) continue;
    const sorted = [...list].sort((x, y) => x.added_at - y.added_at || x.id - y.id); // давно лежащие первыми
    return { a: sorted[Math.floor(rand() * Math.min(3, sorted.length)) % sorted.length], why };
  }
  return null;
}

// ---------- 3–5. кандидаты с сайта ----------

/** От каких тайтлов искать «похожее»: «в восторге» раньше «понравилось», свежие раньше давних; недавно использованные пропускаем. До двух. */
export function likedBases(rows: Anime[], now: number, seen: Seen): Anime[] {
  const stamp = (a: Anime) => a.last_move_at ?? a.updated_at;
  return rows
    .filter((a) => (a.status === "done" || a.status === "watching") && a.liked >= 1 && !recent(seen.b, a.mal_id, now, BASE_WEEKS))
    .sort((x, y) => y.liked - x.liked || stamp(y) - stamp(x) || y.id - x.id)
    .slice(0, 2);
}

export type CandKind = "new" | "similar" | "surprise";
const MIN_YEAR = 2010; // старое (до 2000-х) не смотрит, берём 2010-е и 2020-е

/** Дешёвая проверка по строке списка (без запроса карточки): стоит ли тратить обращение на жанры. */
export function preCheck(t: PickTitle, kind: CandKind, known: Set<number>, seen: Seen, now: number, taken: Set<number>): boolean {
  if (known.has(t.mal) || taken.has(t.mal) || recent(seen.r, t.mal, now, REPEAT_WEEKS)) return false;
  if (t.kind !== "tv" && t.kind !== "ona") return false; // фильмы смотрит редко, короткое и спецвыпуски — не то
  if (t.year !== null && t.year < MIN_YEAR) return false;
  if (kind === "new") return t.status !== "anons";
  if (t.episodes > 30) return false; // затянутое не любит
  if (kind === "similar") return t.score === null || t.score >= 7;
  return t.score !== null && t.score >= 8 && t.episodes > 0 && t.episodes <= 26;
}

/** Порядок просмотра кандидатов: новинки — как есть (по популярности), похожее — по оценке, сюрприз — вперемешку. */
export function orderCandidates(list: PickTitle[], kind: CandKind, rand: () => number): PickTitle[] {
  if (kind === "new") return list;
  if (kind === "similar") return [...list].sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface Verdict {
  /** какие из любимых жанров совпали */
  matched: GenreKey[];
  /** о чём предупредить */
  warn: GenreKey[];
}

/** По карточке (с жанрами): подходит ли. null — нет (взрослое или обходимый жанр). Пустые жанры у нового тайтла — не повод отказать: нечего проверять. */
export function judge(t: PickTitle, cfg: PickConfig): Verdict | null {
  const { keys, adult } = classify(t.genres);
  if (adult || cfg.avoid.some((k) => keys.has(k))) return null;
  return { matched: cfg.likes.filter((k) => keys.has(k)), warn: cfg.warn.filter((k) => keys.has(k)) };
}

/** Новинка сезона: тайтл и какие из любимых жанров совпали (по тому, в каких запросах он нашёлся). */
export interface Novelty {
  t: PickTitle;
  matched: GenreKey[];
}

/**
 * Склеить ответы по жанрам в один список новинок: тайтлы, подошедшие под несколько любимых жанров, выше (романтика и комедия лучше, чем одно из двух);
 * при равенстве — в порядке запросов и популярности. Известное, уже предлагавшееся и неподходящее по `preCheck` отсеиваем.
 */
export function mergeNovelties(lists: { key: GenreKey; items: PickTitle[] }[], known: Set<number>, seen: Seen, now: number, taken: Set<number>): Novelty[] {
  const by = new Map<number, { n: Novelty; at: number }>();
  let at = 0;
  for (const { key, items } of lists) {
    for (const t of items) {
      at++;
      if (!preCheck(t, "new", known, seen, now, taken)) continue;
      const cur = by.get(t.mal);
      if (cur) cur.n.matched.push(key);
      else by.set(t.mal, { n: { t, matched: [key] }, at });
    }
  }
  return [...by.values()].sort((x, y) => y.n.matched.length - x.n.matched.length || x.at - y.at).map((x) => x.n);
}

// ---------- рекомендация и текст ----------

export type RecKind = "planned" | "new" | "similar" | "surprise";

export interface Rec {
  kind: RecKind;
  t: PickTitle;
  /** строка «почему подойдёт» */
  why: string;
  warn: GenreKey[];
}

const epsWord = (n: number): string => {
  const t = n % 100;
  const u = n % 10;
  return t >= 11 && t <= 14 ? "серий" : u === 1 ? "серия" : u >= 2 && u <= 4 ? "серии" : "серий";
};

export const scoreText = (s: number | null): string => (s === null ? "оценки пока нет" : `оценка на Shikimori ${s.toFixed(1).replace(".", ",")}`);

/** «12 серий» / «идёт, вышло 5 из 12». */
export function epsText(t: PickTitle): string {
  if (t.status === "ongoing") return t.episodes > 0 ? `идёт, вышло ${t.epsAired} из ${t.episodes}` : `идёт, вышло ${t.epsAired} ${epsWord(t.epsAired)}`;
  if (t.status === "anons") return "анонс";
  return t.episodes > 0 ? `${t.episodes} ${epsWord(t.episodes)}` : "серий пока неизвестно";
}

const genreWords = (keys: GenreKey[]): string => keys.map((k) => GENRE_LABEL[k]).join(", ");

export function plannedWhy(a: Anime, why: PlannedWhy, now: number, tz: string): string {
  const aired = effective(a, now).airedEp;
  if (why === "airing") return `Сейчас выходит, уже вышло ${aired} ${epsWord(aired)}: можно начать и идти вровень с эфиром.`;
  if (why === "short") return `Короткое (${a.episodes} ${epsWord(a.episodes ?? 0)}): хватит пары вечеров.`;
  return `Лежит в «В планах» с ${sinceText(a, tz)}.`;
}

export const newWhy = (matched: GenreKey[]): string => `Новинка сезона${matched.length ? `, ваши жанры: ${genreWords(matched.slice(0, 3))}` : ""}.`;

export const similarWhy = (base: Anime): string => (base.liked === 2 ? `Похоже на «${clip(base.title_ru, 50)}», от которого вы были в восторге.` : `Похоже на «${clip(base.title_ru, 50)}», которое вам понравилось.`);

export const surpriseWhy = (v: Verdict): string =>
  v.matched.length ? `Сюрприз из высоко оценённых (${genreWords(v.matched.slice(0, 2))}): выбрала наугад.` : "Сюрприз: не из ваших обычных жанров, но высоко оценён.";

const WARN_TEXT: Record<string, string> = { horror: "ужасы", mecha: "меха" };
const warnLine = (w: GenreKey[]): string => `⚠️ Есть: ${w.map((k) => WARN_TEXT[k] ?? GENRE_LABEL[k]).join(", ")}.`;

// ---------- реплики Хару (только при характере «горничная»; по одной на рекомендацию) ----------

const HARU: Record<RecKind | "head" | "empty", string[]> = {
  head: ["Я собрала всю неделю в одном месте. Не благодарите.", "Суббота, господин. Всё приготовила, вам остаётся выбрать.", "Подборка готова. Я старалась. Совсем чуть-чуть."],
  planned: ["Из ящика «потом». Может, сегодня то самое «потом»?", "Оно лежит давно. Я не напоминаю, я достаю."],
  new: ["Свежее из сезона. Обложка мне понравилась, это не оценка.", "Новенькое. Вдруг это ваше."],
  similar: ["Вы любите такое. Я заметила, я ведь слежу.", "Похоже на то, что вам зашло. Не гарантирую, но стараюсь."],
  surprise: ["Это вне ваших жанров. Мне просто кажется, что зайдёт.", "Сюрприз. Не спойлерю, хозяин."],
  empty: ["Сегодня подборка пустая. Я не виновата, я честно искала."],
};

function line(kind: keyof typeof HARU, character: Character, rand: () => number): string | null {
  if (character !== "maid") return null;
  const pool = HARU[kind];
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

const COLOR = 0xf4a6c0;
const LABEL: Record<RecKind, string> = { planned: "Из «В планах»", new: "Новинка сезона", similar: "Похожее", surprise: "Сюрприз" };

/** Карточка рекомендации: 2–3 строки (почему, сколько серий и оценка, реплика Хару), обложка справа. */
export function recEmbed(r: Rec, character: Character, rand: () => number): Embed {
  const facts = `${epsText(r.t)} · ${scoreText(r.t.score)}`;
  const lines = [r.why, facts];
  if (r.warn.length) lines.push(warnLine(r.warn));
  const l = line(r.kind, character, rand);
  if (l) lines.push(voiceText(l));
  return { title: clip(`${LABEL[r.kind]}: ${r.t.ru}`, 100), url: r.t.url, description: lines.join("\n"), color: COLOR, ...(r.t.image ? { thumbnail: { url: r.t.image } } : {}) };
}

/** Что собрано за неделю. */
export interface PickParts {
  missed: Missed[];
  planned: Rec | null;
  fresh: Rec[];
  similar: Rec | null;
  surprise: Rec | null;
  /** Shikimori не ответил (хотя бы часть подборки не собрана из-за этого) */
  sourceDown: boolean;
}

export const hasContent = (p: PickParts): boolean => p.missed.length > 0 || !!p.planned || p.fresh.length > 0 || !!p.similar || !!p.surprise;

/** Чего нет в подборке (для честной строки в конце). Серии — не «нет», а «всё посмотрено». */
export function missingParts(p: PickParts): string[] {
  const out: string[] = [];
  if (!p.planned) out.push("из «В планах»");
  if (!p.fresh.length) out.push("новинки сезона");
  if (!p.similar) out.push("похожее");
  if (!p.surprise) out.push("сюрприз");
  return out;
}

/** Сообщение Discord — до 2000 знаков; берём с запасом. */
const CONTENT_MAX = 1900;

export function pickMessage(p: PickParts, now: number, tz: string, character: Character, rand: () => number): MessageBody {
  const head = line("head", character, rand);
  const recs = [p.planned, ...p.fresh, p.similar, p.surprise].filter((r): r is Rec => !!r);
  const miss = missingParts(p);
  const tail: string[] = [];
  if (miss.length) {
    tail.push(p.sourceDown ? `Не получилось собрать: ${miss.join(", ")} (Shikimori не отвечает). В следующую субботу попробую снова.` : `В этот раз не нашла подходящего: ${miss.join(", ")}.`);
  }
  if (!recs.length && !p.missed.length) {
    const e = line("empty", character, rand);
    if (e) tail.push(voiceText(e));
  }
  const build = (shown: number): string => {
    const out = ["**🎬 Подборка на субботу**"];
    if (head) out.push(voiceText(head));
    if (p.missed.length) {
      out.push(`**Вышло, а вы ещё не смотрели** (${p.missed.length})`);
      out.push(...p.missed.slice(0, shown).map((m) => missedLine(m, now, tz)));
      if (p.missed.length > shown) out.push(`…и ещё ${p.missed.length - shown}: список — «что вышло нового».`);
    } else {
      out.push("**Серии:** пропущенных нет, всё, что вышло, вы уже посмотрели.");
    }
    return [...out, ...tail].join("\n");
  };
  let shown = Math.min(MISSED_SHOWN, p.missed.length);
  let content = build(shown);
  while (content.length > CONTENT_MAX && shown > 1) content = build(--shown); // длинные названия: показываем меньше строк, остальное — «и ещё N»
  return { content, ...(recs.length ? { embeds: recs.map((r) => recEmbed(r, character, rand)) } : {}), allowed_mentions: { parse: [] } };
}

/** Какой сейчас сезон и год по часам пользователя. */
export const seasonNow = (now: number, tz: string): { year: number; month: number } => {
  const w = wallOf(now, tz);
  return { year: w.y, month: w.mo };
};
