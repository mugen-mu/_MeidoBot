// Чтение: живые фразы хозяина без команд (волна 2–3 анкеты вкусов, 2026-11-18): чистые функции, без базы и сети.
//  Запись: «прочитал главу 120 Кауру», «прочитал Кауру» (на одну дальше), «прочитал Кауру том 5», «читаю Кауру», «бросил читать Кауру», «хочу почитать Кауру».
//  Вопросы: «что я читаю», «что вышло по чтению / новые главы», «какая глава Кауру».
// Осторожность та же, что у аниме (src/anime/say.ts): фраза про название, которого нет в его списке чтения, — это обычное дело,
// пока нет обращения («бот», «Хару») или слова «манга» / «ранобэ» (тогда незнакомое название ищем на Shikimori и записываем).
// Глаголы только от первого лица в прошедшем и настоящем: «прочитал», «читаю». «Прочитать договор до пятницы» — дело, как раньше.
import { ASK_COMMON, type AskSpec, askWords, matchAsk } from "../ask.ts";
import type { ReadKind, ReadUnit } from "./core.ts";

export interface ReadSay {
  action: "read" | "start" | "drop" | "plan";
  query: string;
  chapter: number | null;
  volume: number | null;
  /** «прочитал Х» без номера: на одну дальше, чем сейчас (в главах или томах — смотря как он считает) */
  next: boolean;
  /** «прочитал последнюю главу Х»: до последней, которую знает источник */
  last: boolean;
  /** что он назвал словом: «главу» или «том» (для «прочитал том Х» и «последнюю главу»); иначе null — берём его привычную единицу */
  unit: ReadUnit | null;
  /** слово «манга» / «ранобэ» в фразе: сужает поиск и само считается обращением */
  kind: ReadKind | null;
  /** было обращение «бот» / «Хару» или слово «манга» / «ранобэ»: тогда незнакомое название ищем на Shikimori и записываем */
  prefixed: boolean;
}

const MAX_CHARS = 100;
const MAX_QUERY = 70;

const PREFIX = /^(?:бот|хару)(?![\p{L}\p{N}])\s*[,:;.\-–—]?\s*/iu;

const READ = /^(?:прочитал[аи]?|прочёл|прочел|прочла|дочитал[аи]?|осилил[аи]?)\s+(.+)$/iu;
const START = /^(?:читаю(?:\s+сейчас)?|читаем|начал[аи]?\s+читать|стал[аи]?\s+читать|продолжаю\s+читать|продолжил[аи]?\s+читать|взялся\s+за|взялась\s+за)\s+(.+)$/iu;
const DROP = /^(?:бросил[аи]?|перестал[аи]?|забросил[аи]?|дропнул[аи]?|забил[аи]?|бросаю|забиваю)\s+(?:читать|чтение|читаю)\s+(.+)$/iu;
/** «бросил мангу Х»: без «читать», но со словом «манга» / «ранобэ» */
const DROP_KIND = /^(?:бросил[аи]?|забросил[аи]?|дропнул[аи]?|перестал[аи]?\s+читать)\s+(.+)$/iu;
const PLAN =
  /^(?:хочу\s+(?:почитать|прочитать|читать)|в\s+планах\s+(?:почитать|прочитать)|планирую\s+(?:почитать|прочитать|читать)|потом\s+(?:почитаю|прочитаю)|(?:почитаю|прочитаю)\s+потом|отложил[аи]?\s+(?:на\s+потом\s+)?(?:почитать|прочитать))\s*[:\-–—]?\s+(.+)$/iu;
/** «хочу мангу Х», «в планах ранобэ Х»: без «почитать», но со словом «манга» / «ранобэ» */
const PLAN_KIND = /^(?:хочу|в\s+планах|планирую|отложил[аи]?)\s*[:\-–—]?\s+(.+)$/iu;

const KIND_RE = /(?:^|\s)(?:(?:веб|лайт)[\s-]*)?(ранобэ|ранобе|новелл[уаые]|манг[уаие]|манхв[уаы]|маньхуа|вебтун)(?=\s|$|[,.:;])/iu;

const LAST_RE = /(?:^|\s)(?:последн(?:юю|яя)|свежую|свежая|новую|новая)\s+(?:главу|глава)(?=\s|$)/iu;
const CH_A = /(?:^|\s)(?:главу|глава|главы|гл\.?)\s*(\d{1,4})(?=\s|$|[.,])/iu;
const CH_B = /(?:^|\s)(\d{1,4})(?:-?(?:ю|я|й|е))?\s+(?:главу|глава|гл\.?)(?=\s|$)/iu;
const VOL_A = /(?:^|\s)(?:том|тома|томе|т\.)\s*(\d{1,3})(?=\s|$|[.,])/iu;
const VOL_B = /(?:^|\s)(\d{1,3})(?:-?(?:й|ой|го))?\s+(?:том|тома)(?=\s|$)/iu;
const CH_BARE = /(?:^|\s)(?:главу|глава|главы)(?=\s|$)/iu;
const VOL_BARE = /(?:^|\s)том(?=\s|$)/iu;

interface Marks {
  rest: string;
  chapter: number | null;
  volume: number | null;
  last: boolean;
  unit: ReadUnit | null;
  kind: ReadKind | null;
  kindWord: boolean;
}

/** Вынуть из остатка фразы главу, том, слова «последнюю главу» и слово «манга / ранобэ»; остаток — название. */
function takeMarks(input: string): Marks {
  let rest = ` ${input} `;
  let chapter: number | null = null;
  let volume: number | null = null;
  let last = false;
  let unit: ReadUnit | null = null;
  let kind: ReadKind | null = null;
  let kindWord = false;
  const cut = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  const km = cut(KIND_RE);
  if (km) {
    kindWord = true;
    kind = /ранобэ|ранобе|новелл/i.test(km[1]) ? "ranobe" : "manga";
  }
  if (cut(LAST_RE)) {
    last = true;
    unit = "ch";
  }
  const c = cut(CH_A) ?? cut(CH_B);
  if (c) {
    chapter = Number.parseInt(c[1], 10);
    unit = "ch";
  }
  const v = cut(VOL_A) ?? cut(VOL_B);
  if (v) {
    volume = Number.parseInt(v[1], 10);
    unit = unit ?? "vol";
  }
  if (chapter === null && !last && cut(CH_BARE)) unit = "ch";
  else if (volume === null && cut(VOL_BARE)) unit = unit ?? "vol";
  let query = rest.replace(/\s+/g, " ").trim().replace(/^[«"“]|[»"”]$/gu, "").trim();
  for (let i = 0; i < 2; i++) query = query.replace(/^(?:из|в|у|по|про|с|к|на|во)\s+/iu, "").replace(/\s+(?:из|в|на|по)$/iu, "").trim();
  query = query.replace(/^[«"“]|[»"”]$/gu, "").replace(/[,;:\-–—]+$/u, "").trim();
  return { rest: query, chapter, volume, last, unit, kind, kindWord };
}

/** Разобрать живую фразу про чтение; null — это не она. */
export function parseReadSay(text: string): ReadSay | null {
  const raw = text.trim();
  if (!raw || raw.length > MAX_CHARS || /[\r\n]/.test(raw)) return null;
  const pm = PREFIX.exec(raw);
  const addressed = !!pm && pm[0].trim().length > 0 && raw.length > pm[0].length;
  const body = (addressed ? raw.slice(pm![0].length) : raw).trim().replace(/[.!?…]+$/u, "").replace(/\s+/g, " ").trim();
  if (!body) return null;
  const build = (action: ReadSay["action"], rest: string): ReadSay | null => {
    const k = takeMarks(rest);
    if (!k.rest || k.rest.length > MAX_QUERY) return null;
    if (/^(?:в|на|у|с|к|по|для|про)$/iu.test(k.rest)) return null;
    const marked = k.chapter !== null || k.volume !== null || k.last;
    return {
      action,
      query: k.rest,
      chapter: k.chapter,
      volume: k.volume,
      next: action === "read" && !marked,
      last: k.last,
      unit: k.unit,
      kind: k.kind,
      prefixed: addressed || k.kindWord,
    };
  };
  const hasKind = KIND_RE.test(body);
  let m: RegExpExecArray | null;
  if ((m = DROP.exec(body))) return build("drop", m[1]);
  if (hasKind && (m = DROP_KIND.exec(body))) return build("drop", m[1]);
  if ((m = READ.exec(body))) return build("read", m[1]);
  if ((m = START.exec(body))) return build("start", m[1]);
  if ((m = PLAN.exec(body))) return build("plan", m[1]);
  if (hasKind && (m = PLAN_KIND.exec(body))) return build("plan", m[1]);
  return null;
}

// ---------- вопросы про чтение ----------

export type ReadAsk = { kind: "list" } | { kind: "news" } | { kind: "where"; query: string };

const FILLER = new Set([
  ...ASK_COMMON.filter((w) => w !== "как"),
  "я", "меня", "мои", "моя", "мой", "моё", "мое", "все", "всё", "ещё", "еще", "текущие", "текущее", "список", "из", "и", "полка", "полке", "моей",
  "манга", "манги", "манге", "мангу", "ранобэ", "ранобе", "новелла", "новеллы", "новеллах", "глава", "главы", "глав", "главе", "главу", "том", "тома", "томов", "томе",
  "чтению", "чтение", "чтения", "чтении", "почитать", "читать", "новое", "нового", "новые", "новых",
]);

/** Слова про чтение: без них «что вышло нового» — это вопрос про аниме, а не про чтение. */
const READ_WORD = /^(?:глава|главы|глав|главе|главу|том|тома|томов|томе|чтение|чтению|чтения|чтении|манга|манги|манге|мангу|ранобэ|ранобе|новелла|новеллы|новеллах|читаю|читаем|читал|читали|почитать|читать)$/u;

const LIST: AskSpec = { key: /^(?:читаю|читаем|читал|читали)$/u, weakKey: /^(?:чтение|чтения|чтении|манга|манги|ранобэ|ранобе)$/u, filler: FILLER };
const NEWS: AskSpec = { key: /^(?:вышло|вышли|вышла|новые|новых|новое|нового|новенького|свежие|свежих|накопилось|накопились|появилось|появились)$/u, filler: FILLER };

const WHERE_NOISE = new Set([
  "я", "сейчас", "у", "в", "по", "читаю", "читал", "прочитал", "дочитал", "остановился", "последняя", "последний", "свежая", "новая", "вышла", "номер", "там", "мы", "уже", "на", "какая", "какой", "каком",
  "какого", "какую", "до", "что", "за", "дальше", "из",
]);
const WHERE_UNIT = /^(?:глава|главе|главу|главы|том|томе|тома)$/u;

/** Вопрос про своё чтение, или null — это не вопрос. */
export function parseReadAsk(text: string): ReadAsk | null {
  const t = text.trim();
  if (!t || t.length > MAX_CHARS || /[\r\n]/.test(t)) return null;
  const where = parseWhere(t);
  if (where) return where;
  const ws = askWords(t);
  if (!ws.some((w) => READ_WORD.test(w))) return null;
  if (matchAsk(t, NEWS)) return { kind: "news" };
  if (matchAsk(t, LIST)) return { kind: "list" };
  return null;
}

/** «какая глава Кауру», «на какой я главе Кауру», «до какого тома дочитал Кауру»: название — всё, что осталось после слов вопроса. */
function parseWhere(t: string): ReadAsk | null {
  const ws = askWords(t);
  const w0 = ws[0] === "бот" || ws[0] === "хару" ? 1 : 0;
  if (!["какая", "какой", "какую", "на", "до", "что"].includes(ws[w0] ?? "")) return null;
  if (!ws.some((w, i) => i >= w0 && i <= w0 + 4 && WHERE_UNIT.test(w))) return null;
  // слова вопроса — это всё до первого слова названия; название идёт целиком, как написано
  let i = w0;
  while (i < ws.length && (WHERE_NOISE.has(ws[i]) || WHERE_UNIT.test(ws[i]))) i++;
  const query = ws.slice(i).join(" ").trim();
  if (!query || query.length > MAX_QUERY || query.split(" ").length > 7) return null;
  return { kind: "where", query };
}
