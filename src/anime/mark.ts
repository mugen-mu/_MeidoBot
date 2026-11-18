// Аниме: отметка живой фразой и вопрос «смотрел ли я» (решение Ihor по анкете вкусов, 2026-11-18): чистые функции, без базы и сети.
//  Отметка: «Фрирен в восторге», «поставил Фрирен понравилось», «Фрирен не зашло», «мне понравился Блич», «досмотрел Фрирен, в восторге».
//  Оценка числом (его «Да» в анкете, волна 4): «Фрирен 9/10», «Фрирен 8 из 10», «оценил Фрирен на 9», «оценка Фрирен 7», «поставил Фрирен 5».
//  Вопросы: «смотрел ли я Фрирен», «что я поставил Фрирен», «оценка Фрирен», «на какой серии Фрирен».
// Осторожность та же, что у остальных живых фраз (say.ts): без «бот» / «аниме» / «Хару» в начале срабатывает, только если название
// уже есть в его списке (это проверяет вызывающий, см. handleMark / handleAnimeAsk); иначе фраза остаётся обычным делом.
import { askWords } from "../ask.ts";
import { MAX_CHARS, MAX_QUERY, PREFIX, takeMarks } from "./say.ts";

/** 2 в восторге, 1 понравилось, -1 так себе, -2 не зашло (колонка anime.liked; миграция не нужна, CHECK на колонке нет). */
export type Liked = 2 | 1 | -1 | -2;

export interface MarkPhrase {
  liked: Liked;
  query: string;
  /** Было обращение «бот» / «аниме» / «Хару»: тогда про неизвестное название отвечаем «в списке нет». */
  prefixed: boolean;
  /** Сезон из «2 сезон»: выбирает нужный из нескольких сезонов одного тайтла. */
  season?: number;
  /** «досмотрел Х, в восторге»: тайтл закончен, значит «Просмотрено». «Посмотрел» статус не трогает. */
  finished?: true;
  /** Оценка числом из «Фрирен 9/10» (0–10): `liked` из неё уже посчитан, само число не хранится (колонки под него нет), только для ответа. */
  score?: number;
}

/** «9», «8,5» — как показать число в ответе. */
export const scoreLabel = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ","));

/** Шкала из 10: 9–10 в восторге, 7–8 понравилось, 5–6 так себе, 4 и ниже не зашло (слова Ihor, анкета вкусов, волна 4). */
export const likedFromScore = (n: number): Liked => (n >= 9 ? 2 : n >= 7 ? 1 : n >= 5 ? -1 : -2);

const fold = (s: string): string => s.toLowerCase().replace(/ё/g, "е");

/** Слова отметки. Порядок важен только внутри одной строки: сначала проверяются самые длинные хвосты (до трёх слов). */
const MARKS: { re: RegExp; liked: Liked }[] = [
  { re: /^(?:не\s+(?:понравил(?:ось|ся|ась|ись)|зашл[оаи]|зашел|нравится|нравятся)|ненавижу)$/u, liked: -2 },
  { re: /^(?:так\s+себе|средне|посредственно|не\s+очень|не\s+впечатлил[оаи]?)$/u, liked: -1 },
  { re: /^(?:в\s+(?:полном\s+)?восторге|восторг|обожаю|шедевр|огонь)$/u, liked: 2 },
  { re: /^(?:понравил(?:ось|ся|ась|ись)|зашл[оаи]|зашел|нравится|нравятся)$/u, liked: 1 },
];

const markOf = (words: string[]): Liked | null => {
  const s = fold(words.join(" "));
  for (const m of MARKS) if (m.re.test(s)) return m.liked;
  return null;
};

/** Отметка в конце: «Фрирен в восторге», «Фрирен — не зашло». Название — всё, что слева (хотя бы одно слово). */
function tailMark(s: string): { liked: Liked; title: string } | null {
  const w = s.split(/\s+/).filter(Boolean);
  for (let k = Math.min(3, w.length - 1); k >= 1; k--) {
    const liked = markOf(w.slice(-k));
    if (liked !== null) return { liked, title: w.slice(0, -k).join(" ") };
  }
  return null;
}

/** Отметка в начале: «мне понравился Блич», «обожаю Блич», «в восторге от Блича». */
function headMark(s: string): { liked: Liked; title: string } | null {
  const w = s.replace(/^мне\s+/iu, "").split(/\s+/).filter(Boolean);
  for (let k = Math.min(3, w.length - 1); k >= 1; k--) {
    const liked = markOf(w.slice(0, k));
    if (liked !== null) return { liked, title: w.slice(k).join(" ").replace(/^от\s+/iu, "") };
  }
  return null;
}

const SEP_EDGE = /^[\s,:;\-–—]+|[\s,:;\-–—]+$/gu;
const cleanTitle = (t: string): string => t.replace(SEP_EDGE, "").replace(/\s+(?:мне|как|оценку|отметку)$/iu, "").replace(SEP_EDGE, "");

// ---------- оценка числом ----------
// Только явные формы: «Х 9/10», «Х 8 из 10», «оценка Х 7», «Х — оценка 8», а после «поставил / оценил»: «оценил Х на 9», «поставил Х 5».
// Голое число после названия («Фрирен 8») оценкой не считаем: это может быть сезон или номер серии.
const NUM = "(?<![\\d.,])(\\d{1,2}(?:[.,]\\d)?)";
const SEP = "[\\s,:;\\-–—]*";
const OF_TEN = "\\s*(?:/|из)\\s*10";
/** «Фрирен 9/10», «Фрирен — 8 из 10», «оценил Фрирен на 9 из 10». */
const SCALE_TAIL = new RegExp(`^(.+?)${SEP}${NUM}${OF_TEN}$`, "iu");
/** «оценка Фрирен 7», «моя оценка у Фрирен: 7/10». */
const HEAD_ESTIM = new RegExp(`^(?:моя\\s+)?оценка\\s+(?:у\\s+|для\\s+)?(.+?)${SEP}${NUM}(?:${OF_TEN})?$`, "iu");
/** «Фрирен — оценка 8», «Фрирен, оценка: 8/10». */
const TAIL_ESTIM = new RegExp(`^(.+?)${SEP}оценка[\\s:;\\-–—]*${NUM}(?:${OF_TEN})?$`, "iu");
/** После «оценил / поставил»: «Фрирен на 9», «Фрирен 5», «Фрирен — 7». */
const BARE_TAIL = new RegExp(`^(.+?)${SEP}(?:(?:на|в)\\s+)?${NUM}$`, "iu");

/** Оценка числом в хвосте или начале; `viaVerb` — перед ней стоял глагол «поставил / оценил» (тогда годится и голое число). */
function scoreMark(body: string, viaVerb: boolean): { liked: Liked; title: string; score: number } | null {
  // слова «оценка» разбираем раньше шкалы: иначе «моя оценка Блич 6/10» целиком ушла бы в название
  for (const re of viaVerb ? [HEAD_ESTIM, TAIL_ESTIM, SCALE_TAIL, BARE_TAIL] : [HEAD_ESTIM, TAIL_ESTIM, SCALE_TAIL]) {
    const m = re.exec(body);
    if (!m) continue;
    const score = Number.parseFloat(m[2].replace(",", "."));
    if (!Number.isFinite(score) || score < 0 || score > 10) return null;
    return { liked: likedFromScore(score), title: m[1].replace(/\s+(?:на|в|по)$/iu, ""), score };
  }
  return null;
}

const RATE_VERB = /^(?:поставил[аи]?|ставлю|поставлю|оценил[аи]?|оцениваю|оценю|отметил[аи]?|отмечаю|отмечу)\s+(?:оценку\s+|отметку\s+)?(.+)$/iu;
const SEEN_VERB = /^(?:посмотрел[аи]?|глянул[аи]?|просмотрел[аи]?|досмотрел[аи]?)\s+(.+)$/iu;

/** Слова, которые сами по себе — не название (и местоимения: «Хару, ты мне не понравилась» — не про аниме). */
const NOT_TITLE = new Set([
  "я", "ты", "вы", "мы", "он", "она", "оно", "они", "мне", "тебе", "меня", "тебя", "вас", "нас", "вам", "нам", "это", "этот", "эта", "эти", "его", "её", "ее", "их",
  "все", "всё", "там", "тут", "здесь", "сегодня", "вчера", "сейчас", "вообще", "очень", "тоже", "ничего", "что", "как", "так", "бот", "хару", "аниме", "тайтл",
  "сериал", "сериалы", "фильм", "кино", "серия", "серию", "сезон", "в", "на", "у", "с", "к", "по", "для", "про", "от", "из",
]);
const PRONOUNS = new Set(["я", "ты", "вы", "мы", "он", "она", "оно", "они", "мне", "тебе", "меня", "тебя", "вас", "нас", "вам", "нам", "это", "этот", "эта", "эти"]);

/** Годится ли остаток как название. С обращением («Хару, …») местоимения в нём — это разговор, а не тайтл. */
function junkQuery(q: string, prefixed: boolean): boolean {
  const ws = askWords(q);
  if (!ws.length || ws.join(" ").length < 3) return true;
  if (ws.every((w) => NOT_TITLE.has(w))) return true; // «это», «мне это»: одни служебные слова
  return prefixed && ws.some((w) => PRONOUNS.has(w));
}

/** Разобрать отметку фразой про своё аниме; null — это не она. */
export function parseAnimeMark(text: string): MarkPhrase | null {
  const raw = text.trim();
  if (!raw || raw.length > MAX_CHARS || /[\r\n]/.test(raw)) return null;
  const pm = PREFIX.exec(raw);
  const prefixed = !!pm && pm[0].trim().length > 0 && raw.length > pm[0].length;
  let body = (prefixed ? raw.slice(pm![0].length) : raw).trim().replace(/[.!?…]+$/u, "").replace(/\s+/g, " ").trim();
  if (!body) return null;
  let finished = false;
  let viaVerb = false;
  let m: RegExpExecArray | null;
  if ((m = RATE_VERB.exec(body))) {
    body = m[1];
    viaVerb = true;
  } else if ((m = SEEN_VERB.exec(body))) {
    finished = /^досмотрел/iu.test(body);
    body = m[1];
  }
  const num = scoreMark(body, viaVerb);
  const hit = num ?? tailMark(body) ?? headMark(body);
  if (!hit) return null;
  const k = takeMarks(cleanTitle(hit.title));
  // номер серии в такой фразе не поддерживаем: молча потерять его хуже, чем оставить фразу обычным делом
  if (k.marked || !k.rest || k.rest.length > MAX_QUERY || junkQuery(k.rest, prefixed)) return null;
  const out: MarkPhrase = { liked: hit.liked, query: k.rest, prefixed };
  if (k.season !== null) out.season = k.season;
  if (finished) out.finished = true;
  if (num) out.score = num.score;
  return out;
}

// ---------- «смотрел ли я», «что я поставил» ----------

export interface AnimeDid {
  kind: "did";
  query: string;
  season?: number;
  /**
   * Фраза однозначно про просмотр («смотрел ли я», «понравился ли мне», «на какой серии») или было обращение к боту:
   * про неизвестное название честно отвечаем «в списке нет». Иначе («оценка Х», «что я поставил Х») без названия из списка это обычное дело.
   */
  sure: boolean;
}

const WATCH_PAST = new Set(["смотрел", "смотрела", "видел", "видела"]);
const RATE_PAST = new Set(["поставил", "поставила", "ставил", "ставила", "оценил", "оценила"]);
const LEAD = new Set(["а", "ну", "и", "скажи", "подскажи", "напомни", "покажи"]);
const LIKE_PAST = /^понравил(?:ось|ся|ась|ись)$/u;
const MARK_NOUN = new Set(["оценка", "оценку", "отметка", "отметку"]);
const FILL_HEAD = new Set(["я", "мы", "мне", "нам", "у", "в", "на", "по", "для", "про", "из", "аниме", "тайтл", "сериал"]);
const FILL_TAIL = new Set(["ли", "я", "мы", "мне", "нам"]);

/** Вопрос «смотрел ли я / что поставил» про одно название; null — это не он. Название — слова после ключевой части вопроса. */
export function parseAnimeDid(text: string): AnimeDid | null {
  const raw = text.trim();
  if (!raw || raw.length > MAX_CHARS || /[\r\n]/.test(raw)) return null;
  if (parseAnimeMark(raw)?.score !== undefined) return null; // «оценка Фрирен 7» — это не вопрос, а оценка числом
  const ws = askWords(raw);
  let i = 0;
  let prefixed = false;
  while (i < ws.length && (ws[i] === "бот" || ws[i] === "хару" || ws[i] === "аниме")) {
    prefixed = true;
    i++;
  }
  while (i < ws.length && LEAD.has(ws[i])) i++;
  const r = ws.slice(i);
  const at = (n: number, ...vs: string[]): boolean => vs.includes(r[n]);
  let title: string[] | null = null;
  let sure = prefixed;
  const skip = (n: number, ...vs: string[]): number => (at(n, ...vs) ? n + 1 : n);

  if (r.length >= 3 && WATCH_PAST.has(r[0]) && r[1] === "ли") {
    // «смотрел ли я Фрирен»
    title = r.slice(2);
    sure = true;
  } else if (r.length >= 3 && LIKE_PAST.test(r[0]) && r[1] === "ли") {
    // «понравился ли мне Блич»
    title = r.slice(2);
    sure = true;
  } else if (r.length >= 4 && at(0, "на") && at(1, "какой") && (at(2, "серии") || (at(2, "я") && at(3, "серии")))) {
    // «на какой серии Фрирен», «на какой я серии Фрирен»
    title = r.slice(at(2, "серии") ? 3 : 4);
    sure = true;
  } else if (r.length >= 3 && (at(0, "где") || (at(0, "на") && at(1, "чем")))) {
    // «где я остановился в Фрирен», «на чём остановился Фрирен»
    const j = skip(at(0, "где") ? 1 : 2, "я");
    if (at(j, "остановился", "остановилась")) title = r.slice(j + 1);
  } else if (at(0, "что") && r.length >= 3) {
    // «что я поставил Фрирен», «что поставил на Фрирен»
    const j = skip(1, "я");
    if (RATE_PAST.has(r[j] ?? "")) title = r.slice(j + 1);
  } else if (at(0, "какую", "какой") && MARK_NOUN.has(r[1] ?? "") && r.length >= 3) {
    // «какую оценку я поставил Фрирен»
    let j = 2;
    j = skip(j, "я");
    if (RATE_PAST.has(r[j] ?? "")) j++;
    title = r.slice(j);
  } else if (at(0, "какая") && r.length >= 3) {
    // «какая у меня оценка у Фрирен», «какая оценка Фрирен»
    let j = 1;
    if (at(j, "у") && at(j + 1, "меня", "нас")) j += 2;
    if (MARK_NOUN.has(r[j] ?? "")) title = r.slice(j + 1);
  } else if (at(0, "как") && r.length >= 3) {
    // «как я оценил Фрирен»
    const j = skip(1, "я");
    if (RATE_PAST.has(r[j] ?? "")) title = r.slice(j + 1);
  } else if (MARK_NOUN.has(r[0] ?? "") && r.length >= 2) {
    // «оценка Фрирен», «моя оценка Фрирен»
    title = r.slice(1);
  } else if (at(0, "моя") && MARK_NOUN.has(r[1] ?? "") && r.length >= 3) {
    title = r.slice(2);
  } else if (/\?\s*$/.test(raw) && r.length >= 2 && WATCH_PAST.has(r[r.length - 1])) {
    // «Фрирен я смотрел?»
    title = r.slice(0, -1);
    if (title.length && title[title.length - 1] === "я") title = title.slice(0, -1);
  }
  if (!title) return null;
  let a = 0;
  let b = title.length;
  while (a < b && FILL_HEAD.has(title[a])) a++;
  while (b > a && FILL_TAIL.has(title[b - 1])) b--;
  const k = takeMarks(title.slice(a, b).join(" "));
  if (!k.rest || k.rest.length > MAX_QUERY || junkQuery(k.rest, prefixed)) return null;
  const out: AnimeDid = { kind: "did", query: k.rest, sure };
  if (k.season !== null) out.season = k.season;
  return out;
}
