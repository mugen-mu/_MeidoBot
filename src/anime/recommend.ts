// Аниме: «посоветуй» живой фразой (решение Ihor, анкета вкусов, волна 4, 2026-11-18): чистые функции, без базы и сети.
//  По настроению: «хочу что-то лёгкое», «что-нибудь лёгкое», «посоветуй что-нибудь смешное», «что-нибудь из романтики», «посоветуй комедию»,
//  «хочу что-то повеселее / погрустнее / с экшеном».
//  Похожее: «похожее на Фрирен», «что-нибудь похожее на Фрирен», «посоветуй как Фрирен».
// Осторожность та же, что у вопросов (ask.ts): всё сообщение состоит из слов просьбы и хотя бы одного слова настроения, лишнее слово или цифра — обычное дело.
// Что откуда берётся (Shikimori) и сколько обращений на фразу — в recommendRun.ts.
import { type AskSpec, askWords, matchAsk } from "../ask.ts";
import { norm } from "./core.ts";
import { type Seen, preCheck } from "./pick.ts";
import { GENRE_IDS, GENRE_LABEL, type GenreKey, excludeParam } from "./pickGenres.ts";
import type { PickTitle } from "./pickSources.ts";
import { MAX_CHARS, MAX_QUERY, takeMarks } from "./say.ts";

// ---------- таблица «настроение → жанры» ----------

export type MoodKey = "light" | "funny" | "sad" | "romance" | "fantasy" | "action";

/** Жанр Shikimori: номер для запроса и слово для сообщения. */
export interface MoodGenre {
  id: number;
  label: string;
}

export interface MoodSpec {
  /** как назвать в ответе: «Подбор: лёгкое» */
  label: string;
  /** слова, которыми это просят (слово целиком, начало; «ё» = «е») */
  words: RegExp;
  /** какие жанры спрашиваем у сайта: по одному запросу на жанр (несколько жанров в одном запросе сайт понимает как «и», а не «или») */
  genres: MoodGenre[];
  /** не длиннее стольких серий (затянутое Ihor не любит) */
  maxEp: number;
  /** сверх «не предлагать» из настроек: эти жанры (номера Shikimori) тоже не берём */
  skip: number[];
}

const gk = (k: GenreKey): MoodGenre => ({ id: GENRE_IDS[k][0], label: GENRE_LABEL[k] });
// номера жанров, которых нет в pickGenres.ts (сверено с /api/genres 2026-11-18): Action 1, Drama 8, Horror 14, Mecha 18, Psychological 40, Thriller 41
const ACTION: MoodGenre = { id: 1, label: "экшен" };
const DRAMA: MoodGenre = { id: 8, label: "драма" };
const NOT_LIGHT = [14, 18, 40, 41];

/** Порядок важен: в ответе и при нескольких настроениях сразу (первые жанры берутся раньше). */
export const MOODS: Record<MoodKey, MoodSpec> = {
  // «лёгкое»: комедия, повседневность и романтика, без ужасов, мехи, психологического и триллеров, недлинное (слова Ihor и анкета вкусов, docs/DECISIONS.md)
  light: { label: "лёгкое", words: /^(?:легк|легоньк|легеньк|расслабл|ненапряж|несложн)/u, genres: [gk("comedy"), gk("slice"), gk("romance")], maxEp: 13, skip: NOT_LIGHT },
  funny: { label: "смешное", words: /^(?:смешн|весел|повесел|посмешн|юмор|комеди|угарн)/u, genres: [gk("comedy")], maxEp: 26, skip: [] },
  sad: { label: "грустное", words: /^(?:грустн|погрустн|печальн|трогательн|слезн|драм)/u, genres: [DRAMA], maxEp: 26, skip: [] },
  romance: { label: "романтика", words: /^(?:романт|любовн|любов)/u, genres: [gk("romance")], maxEp: 26, skip: [] },
  fantasy: { label: "фэнтези", words: /^(?:фэнтез|фентез|фэнтэз)/u, genres: [gk("fantasy")], maxEp: 26, skip: [] },
  // боевое — не длиннее одного-двух кура: затянутые бои Ihor не любит
  action: { label: "экшен", words: /^(?:экшен|экшн|боевик|динамичн|драйв)/u, genres: [ACTION], maxEp: 26, skip: [] },
};
export const MOOD_ORDER = Object.keys(MOODS) as MoodKey[];

/** Не больше стольких запросов по жанрам на одну просьбу (в бюджет ~8 обращений укладывается и вторая страница). */
export const MAX_MOOD_GENRES = 3;

export interface MoodPlan {
  /** «лёгкое», «лёгкое и смешное» */
  label: string;
  genres: MoodGenre[];
  maxEp: number;
  /** жанры, которые тоже не берём (номера) */
  skip: number[];
  /** все нужные жанры стоят в «не предлагать» из настроек: искать нечего */
  blocked: boolean;
}

/** План по настроениям: жанры без повторов (и без тех, что у него в «не предлагать»), самый короткий предел серий, общие исключения. */
export function moodPlan(moods: MoodKey[], avoid: GenreKey[]): MoodPlan {
  const banned = new Set(avoid.flatMap((k) => GENRE_IDS[k]));
  const all: MoodGenre[] = [];
  for (const m of moods) for (const g of MOODS[m].genres) if (!all.some((x) => x.id === g.id)) all.push(g);
  const genres = all.filter((g) => !banned.has(g.id)).slice(0, MAX_MOOD_GENRES);
  return {
    label: moods.map((m) => MOODS[m].label).join(" и "),
    genres,
    maxEp: Math.min(...moods.map((m) => MOODS[m].maxEp)),
    skip: [...new Set(moods.flatMap((m) => MOODS[m].skip))],
    blocked: all.length > 0 && genres.length === 0,
  };
}

/** Часть запроса «без таких-то жанров»: «не предлагать» из настроек, взрослое и жанры, лишние именно для этого настроения. */
export const moodExclude = (avoid: GenreKey[], skip: number[]): string => [...new Set([...excludeParam(avoid).split(",").filter(Boolean), ...skip.map((id) => `!${id}`)])].join(",");

// ---------- разбор фразы ----------

export type Recommend =
  | { kind: "mood"; moods: MoodKey[] }
  /** `weak` — «посоветуй как X», «вроде X»: если такого названия нет ни в списке, ни на сайте, это не про аниме и фраза остаётся делом */
  | { kind: "similar"; query: string; season?: number; weak?: true };

/** Слова самой просьбы: без одного из них «комедия» или «лёгкое» — просто слово, а не вопрос. */
const REQUEST = new Set([
  "хочу", "хочется", "хотелось", "хотел", "хотела", "посоветуй", "посоветуйте", "подскажи", "подскажите", "порекомендуй", "порекомендуйте", "предложи", "предложите",
  "нибудь", // «что-нибудь», «какое-нибудь»
]);
/** «что-то» после разбора на слова — «что», «то»: просьба, если эти два слова рядом. */
const hasRequest = (ws: string[]): boolean => ws.some((w) => REQUEST.has(w)) || ws.some((w, i) => w === "что" && ws[i + 1] === "то");

const MOOD_FILLER = new Set([
  ...REQUEST, "бот", "хару", "аниме", "анимешку", "анимешки", "мне", "нам", "пожалуйста", "а", "ну", "и", "что", "то", "какое", "какой", "какую", "какие",
  "из", "про", "с", "со", "на", "для", "бы", "посмотреть", "глянуть", "посмотрим", "глянем", "сегодня", "вечер", "вечером", "сейчас", "немного", "чуть", "такое",
]);
const MOOD_SPEC: AskSpec = { key: new RegExp(MOOD_ORDER.map((m) => MOODS[m].words.source).join("|"), "u"), filler: MOOD_FILLER };

function parseMood(t: string): Recommend | null {
  if (!matchAsk(t, MOOD_SPEC)) return null;
  const ws = askWords(t);
  if (!hasRequest(ws)) return null;
  const moods = MOOD_ORDER.filter((m) => ws.some((w) => MOODS[m].words.test(w)));
  return moods.length ? { kind: "mood", moods } : null;
}

const SIM_PRE = new Set([...MOOD_FILLER, "ещё", "еще", "есть", "у", "тебя", "вас", "меня"]);
const SIM_WORD = /^похож(?:ее|ий|ую|ие|его|им|ая)$/u;
/** Название, которое на самом деле местоимение («похожее на него»). */
const TITLE_STOP = new Set(["это", "то", "него", "нее", "ее", "его", "их", "этого", "того", "меня", "мне", "тебя", "нас", "все", "всё", "другое", "что", "чего", "что-то"]);

/** Где в фразе начинается название и нужна ли в начале слова просьбы («похожее на X» — не нужна, «как X» — нужна). */
function titleStart(ws: string[]): { at: number; needRequest: boolean; pre: string[] } | null {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (SIM_WORD.test(w) && ws[i + 1] === "на") return { at: i + 2, needRequest: false, pre: ws.slice(0, i) };
    if (["вроде", "навроде", "типа", "наподобие", "как"].includes(w)) return { at: i + 1, needRequest: true, pre: ws.slice(0, i) };
    if (w === "в" && (ws[i + 1] === "духе" || ws[i + 1] === "стиле")) return { at: i + 2, needRequest: true, pre: ws.slice(0, i) };
  }
  return null;
}

function parseSimilar(t: string): Recommend | null {
  const ws = askWords(t);
  const st = titleStart(ws);
  if (!st || !st.pre.every((w) => SIM_PRE.has(w)) || (st.needRequest && !hasRequest(st.pre))) return null;
  let tail = ws.slice(st.at);
  while (tail.length && tail[tail.length - 1] === "пожалуйста") tail = tail.slice(0, -1);
  if (!tail.length || tail.length > 10 || tail.every((w) => TITLE_STOP.has(w))) return null;
  const k = takeMarks(tail.join(" "));
  // номер серии здесь не к месту: «похожее на Фрирен 5 серию» — это не просьба
  if (k.marked || !k.rest || k.rest.length > MAX_QUERY || k.rest.length < 2) return null;
  const out: Recommend = { kind: "similar", query: k.rest };
  if (k.season !== null) out.season = k.season;
  if (st.needRequest) out.weak = true;
  return out;
}

/** Разобрать просьбу «посоветуй»; null — это не она (останется делом или другой фразой). */
export function parseRecommend(text: string): Recommend | null {
  const t = text.trim();
  if (!t || t.length > MAX_CHARS || /[\r\n]/.test(t)) return null;
  return parseSimilar(t) ?? parseMood(t);
}

// ---------- кандидаты ----------

/** Вид названия «второй сезон / продолжение» («2nd Season», «II», «Моб Психо 100 2», «The Final», «Финал»): начинать с продолжения нельзя, а Shikimori такие в рейтинге любит. */
const SEQUEL_TAIL = /(?:\s(?:\d+(?:st|nd|rd|th)\s+season|season\s+\d+|(?:second|third|fourth|fifth|final)\s+season|(?:the\s+)?finale?|part\s+\d+|ii|iii|iv|[2-9]|финал|(?:[2-9]|второй|третий|четвертый|пятый)\s+сезон|сезон\s+[2-9]|часть\s+[2-9]))+$/u;

/** Название без номера сезона: «sousou no frieren 2nd season» и «sousou no frieren» — одна «семья». */
export const familyKey = (name: string): string => {
  const n = norm(name);
  return n.replace(SEQUEL_TAIL, "").trim() || n;
};
export const isSequel = (t: PickTitle): boolean => [t.orig, t.ru].some((n) => n && norm(n) !== familyKey(n));

export interface MoodCand {
  t: PickTitle;
  /** какие из жанров настроения нашли этот тайтл */
  labels: string[];
}

/**
 * Склеить ответы по жанрам: известное, недавно предлагавшееся, длинное, продолжения и неподходящее по `preCheck` отсеиваем;
 * тайтлы, подошедшие под несколько жанров сразу, выше (комедия и романтика лучше, чем одно из двух), дальше по оценке.
 */
export function mergeMood(lists: { genre: MoodGenre; items: PickTitle[] }[], plan: MoodPlan, known: Set<number>, seen: Seen, now: number, taken: Set<number>): MoodCand[] {
  const by = new Map<number, { c: MoodCand; at: number }>();
  let at = 0;
  for (const { genre, items } of lists) {
    for (const t of items) {
      at++;
      if (!preCheck(t, "similar", known, seen, now, taken)) continue;
      if (t.episodes < 1 || t.episodes > plan.maxEp || isSequel(t)) continue;
      const cur = by.get(t.mal);
      if (cur) {
        if (!cur.c.labels.includes(genre.label)) cur.c.labels.push(genre.label);
      } else by.set(t.mal, { c: { t, labels: [genre.label] }, at });
    }
  }
  return [...by.values()].sort((x, y) => y.c.labels.length - x.c.labels.length || (y.c.t.score ?? 0) - (x.c.t.score ?? 0) || x.at - y.at).map((x) => x.c);
}

/** Сколько карточек показываем: 2–3 (честно меньше, если больше не нашлось). */
export const REC_SHOWN = 3;
/** Из скольких лучших «семей» тайтлов выбираем (чтобы просьба, повторённая подряд, не давала одно и то же). */
const POOL = 6;

/** Выбрать до `n` карточек: из лучших POOL разных «семей» (сезоны одного тайтла вместе не берём), по `rand`; порядок — как в рейтинге. */
export function chooseSome<T extends { t: PickTitle }>(sorted: T[], n: number, rand: () => number): T[] {
  const pool: T[] = [];
  const fam = new Set<string>();
  for (const c of sorted) {
    const f = familyKey(c.t.orig || c.t.ru);
    if (fam.has(f)) continue;
    fam.add(f);
    pool.push(c);
    if (pool.length >= POOL) break;
  }
  const rest = [...pool];
  const out: T[] = [];
  while (out.length < n && rest.length) out.push(...rest.splice(Math.floor(rand() * rest.length) % rest.length, 1));
  return out.sort((x, y) => pool.indexOf(x) - pool.indexOf(y));
}

export const moodWhy = (plan: MoodPlan, labels: string[]): string => `Под настроение «${plan.label}»: ${labels.join(", ")}.`;
