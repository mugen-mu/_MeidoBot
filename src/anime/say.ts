// Аниме: живые фразы хозяина без команд (решение Ihor по анкете вкусов, волна 3, 2026-11-18): чистые функции, без базы и сети.
//  Запись: «глянул последнюю серию Фрирен», «посмотрел s3e2 класса превосходства», «забил на ДжоДжо», «Фрирен надоело», «потом посмотрю Блич».
//  Вопросы: «что я смотрю», «что отложено», «что вышло нового», «когда новая серия Фрирен».
// Осторожность: фраза без слова «бот»/«аниме»/«Хару» в начале срабатывает, только если название уже есть в его списке
// (это проверяет вызывающий, см. handleSay); иначе это обычное дело, как раньше.
import { ASK_COMMON, type AskSpec, askWords, matchAsk } from "../ask.ts";
import type { AnimePhrase } from "./core.ts";

export interface SayPhrase extends AnimePhrase {
  /** Было обращение «бот» / «аниме» / «Хару»: тогда незнакомое название ищем на Shikimori и записываем. */
  prefixed: boolean;
  /** «последняя серия»: берём последнюю вышедшую (номер знает бот, не хозяин). */
  latest?: true;
  /** «посмотрел серию» без номера: на одну дальше, чем сейчас. */
  next?: true;
  /** Сезон из «s3e2», «2 сезон»: помогает выбрать нужный из нескольких сезонов одного тайтла. */
  season?: number;
  /** «посмотрел / глянул Х» без слов о серии: для сериала, который смотрит сейчас, это следующая серия, иначе «просмотрено». Только без обращения. */
  soft?: true;
}

const MAX_CHARS = 90;
const MAX_QUERY = 70;

const PREFIX = /^(?:бот|аниме|хару)(?![\p{L}\p{N}])\s*[,:;.\-–—]?\s*(?:аниме(?![\p{L}\p{N}])\s*[,:;.\-–—]?\s*)?/iu;

const SEEN = /^(?:посмотрел[аи]?|глянул[аи]?|просмотрел[аи]?|досмотрел[аи]?)\s+(.+)$/iu;
const DROP = /^(?:бросил[аи]?|бросаю|дропнул[аи]?|дропаю|забил[аи]?(?:\s+на)?|забиваю(?:\s+на)?|перестал[аи]?(?:\s+смотреть)?)\s+(.+)$/iu;
const WATCH = /^(?:смотрю(?:\s+сейчас)?|смотрим|продолжаю(?:\s+смотреть)?|начал[аи]?(?:\s+смотреть)?|стал[аи]?\s+смотреть)\s+(.+)$/iu;
const PLAN = /^(?:потом\s+посмотрю|посмотрю\s+потом|отложил[аи]?|отложу|закину\s+в\s+планы|запланировал[аи]?|планирую|хочу\s+посмотреть|хочу|в\s+планах)\s*[:\-–—]?\s+(.+)$/iu;
/** «Фрирен надоело», «ДжоДжо фигня»: название слева, слово справа. */
const DROP_TAIL = /^(.+?)\s+(?:надоел[оаи]?|фигня|бросил[аи]?|забил[аи]?)$/iu;
const PLAN_TAIL = /^(.+?)\s+(?:потом|на\s+потом|в\s+планах)$/iu;

const S_E = /(?:^|\s)s(\d{1,2})\s*e(\d{1,4})(?=\s|$)/iu;
const SEASON_A = /(?:^|\s)(\d{1,2})(?:-?(?:й|го|ой))?\s+сезон(?:а|е)?(?=\s|$)/iu;
const SEASON_B = /(?:^|\s)сезон\s+(\d{1,2})(?=\s|$)/iu;
const SEASON_C = /(?:^|\s)(\d{1,2})(?:st|nd|rd|th)\s+season(?=\s|$)/iu;
const LATEST = /(?:^|\s)(?:последн(?:юю|яя|ей)|новую|новая|свежую|свежая|очередную)\s+(?:серию|серия|серии|эпизод)(?=\s|$)/iu;
const EP_NUM = /(?:^|\s)(?:на\s+)?(?:(\d{1,4})(?:-?(?:ю|я|й|е))?\s+(?:серию|серия|серии|эпизод)|(?:серию|серия|серии|эпизод)\s+(\d{1,4}))(?=\s|$)/iu;
const EP_BARE = /(?:^|\s)(?:серию|серия|серии|эпизод)(?=\s|$)/iu;

interface Marks {
  rest: string;
  episode: number | null;
  latest: boolean;
  next: boolean;
  season: number | null;
  marked: boolean;
}

/** Вынуть из остатка фразы серию, сезон и слова «последняя серия»; остаток — название. */
function takeMarks(input: string): Marks {
  let rest = ` ${input} `;
  let episode: number | null = null;
  let season: number | null = null;
  let latest = false;
  let next = false;
  const cut = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  const se = cut(S_E);
  if (se) {
    season = Number.parseInt(se[1], 10);
    episode = Number.parseInt(se[2], 10);
  }
  const sn = cut(SEASON_A) ?? cut(SEASON_B) ?? cut(SEASON_C);
  if (sn) season = Number.parseInt(sn[1], 10);
  if (cut(LATEST)) latest = true;
  const en = cut(EP_NUM);
  if (en) episode = Number.parseInt(en[1] ?? en[2], 10);
  if (cut(EP_BARE) && episode === null && !latest) next = true;
  const query = rest.replace(/\s+/g, " ").trim().replace(/^[«"“]|[»"”]$/gu, "").trim();
  return { rest: query, episode, latest, next, season, marked: episode !== null || latest || next };
}

/** Разобрать живую фразу про своё аниме; null — это не она. */
export function parseAnimeSay(text: string): SayPhrase | null {
  const raw = text.trim();
  if (!raw || raw.length > MAX_CHARS || /[\r\n]/.test(raw)) return null;
  const pm = PREFIX.exec(raw);
  const prefixed = !!pm && pm[0].trim().length > 0 && raw.length > pm[0].length;
  const body = (prefixed ? raw.slice(pm![0].length) : raw).trim().replace(/[.!?…]+$/u, "").replace(/\s+/g, " ").trim();
  if (!body) return null;
  const build = (status: SayPhrase["status"], rest: string, extra: { soft?: boolean } = {}): SayPhrase | null => {
    const k = takeMarks(rest);
    if (!k.rest || k.rest.length > MAX_QUERY) return null;
    if (/^(?:в|на|у|с|к|по|для|про)$/iu.test(k.rest)) return null;
    let st = status;
    if (status === "done" && k.marked) st = "watching"; // «посмотрел 5 серию» — это не «всё просмотрено»
    const out: SayPhrase = { status: st, query: k.rest, episode: k.episode, prefixed };
    if (k.latest) out.latest = true;
    if (k.next && (status === "done" || status === "watching")) out.next = true;
    if (k.season !== null) out.season = k.season;
    if (extra.soft && !k.marked && !prefixed) out.soft = true;
    return out;
  };
  let m: RegExpExecArray | null;
  if ((m = DROP.exec(body))) return build("dropped", m[1]);
  if ((m = SEEN.exec(body))) {
    const finished = /^досмотрел/iu.test(body);
    return build("done", m[1], { soft: !finished });
  }
  if ((m = WATCH.exec(body))) return build("watching", m[1]);
  if ((m = PLAN.exec(body))) return build("planned", m[1]);
  if ((m = DROP_TAIL.exec(body))) return build("dropped", m[1]);
  if ((m = PLAN_TAIL.exec(body))) return build("planned", m[1]);
  return null;
}

// ---------- вопросы про своё аниме ----------

export type AnimeAsk = { kind: "watching" } | { kind: "planned" } | { kind: "news" } | { kind: "next"; query: string | null };

const FILLER = new Set([
  ...ASK_COMMON.filter((w) => w !== "как"),
  "я", "меня", "мои", "мой", "моё", "мое", "все", "всё", "ещё", "еще", "текущие", "текущее", "аниме", "тайтлы", "тайтл", "список", "из", "нового", "новое",
  "серии", "серия", "серий", "новинки",
]);

const WATCHING: AskSpec = { key: /^(?:смотрю|смотрим|онгоинг(?:и|ов)?)$/u, filler: FILLER };
const PLANNED: AskSpec = { key: /^(?:отложено|отложенное|отложенные|отложенных|отложил|отложила)$/u, weakKey: /^потом$/u, filler: FILLER };
const NEWS: AskSpec = { key: /^(?:вышло|вышли|вышла|новенького|новые|новых|свежие|свежего)$/u, filler: FILLER };

const NEXT_WORDS = new Set(["следующая", "следующую", "новая", "новую", "очередная", "очередную", "ближайшая", "ближайшую"]);
const NEXT_NOISE = new Set(["там", "будет", "выйдет", "выходит", "ожидается", "у", "в", "для", "по", "про", "примерно", "хоть"]);

/** Вопрос про своё аниме, или null — это не вопрос. */
export function parseAnimeAsk(text: string): AnimeAsk | null {
  const t = text.trim();
  if (!t || t.length > MAX_CHARS || /[\r\n]/.test(t)) return null;
  const next = parseNext(t);
  if (next) return next;
  if (matchAsk(t, WATCHING)) return { kind: "watching" };
  if (matchAsk(t, PLANNED)) return { kind: "planned" };
  if (matchAsk(t, NEWS)) return { kind: "news" };
  return null;
}

/** «когда новая серия», «когда выйдет следующая серия фрирен»: название — всё после слова «серия». */
function parseNext(t: string): AnimeAsk | null {
  const ws = askWords(t);
  const w0 = ws[0] === "бот" || ws[0] === "хару" ? 1 : 0;
  if (ws[w0] !== "когда") return null;
  let i = w0 + 1;
  while (i < ws.length && NEXT_NOISE.has(ws[i])) i++;
  if (i >= ws.length || !NEXT_WORDS.has(ws[i])) return null;
  i++;
  if (!["серия", "серию", "серии", "эпизод"].includes(ws[i])) return null;
  i++;
  while (i < ws.length && NEXT_NOISE.has(ws[i])) i++;
  const query = ws.slice(i).join(" ").trim();
  if (query.length > MAX_QUERY) return null;
  return { kind: "next", query: query || null };
}
