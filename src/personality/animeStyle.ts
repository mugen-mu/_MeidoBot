// Аниме-слой («Характер 2», этап Х2): отдельный слой ПОВЕРХ фразы. Чистая функция renderStyled без базы и Discord:
// случайность и состояние приходят аргументами, поэтому её легко проверять тестами (ТЗ, раздел 6).
//
// Что делает: раскрывает токены словаря, вставляет междометия (в начало) и слова-закрывашки (в конец) с лимитами и паузами,
// применяет манеру речи настроения, добавляет шёпот в спойлере, каомодзи, манга-звук отдельной строкой и подсказки перевода.
// Чего не делает: не трогает время, название дела и другие подстановки ({task}, {miss_count}…) — «суть по-русски» (ТЗ, раздел 8).
// Серьёзные темы и критичные дела отсекаются выше (director.canStyle): сюда такие фразы не попадают.
import { MOOD_CONFIG, type MoodConfig } from "./config.ts";
import { ADDRESS, KAOMOJI, MOOD_SFX, SFX, type SfxId, WHISPERS, WORDS, WORD_BY_ID, type Word, isSfx } from "./lexicon.ts";
import type { Mood } from "./moodEngine.ts";
import type { Situation } from "./phrases.ts";
import { type PhraseVars, fill } from "./speech.ts";

export type StyleLevel = 0 | 1 | 2 | 3;
export type Script = "cyrillic" | "latin" | "mixed";
export type SfxMode = "kana" | "cyrillic" | "off";
export type KaomojiMode = "auto" | "on" | "off";

export interface StyleConfig {
  /** 0 — обычный русский, 1 — лёгкие вставки, 2 — фансаб-стиль, 3 — полный отаку */
  level: StyleLevel;
  script: Script;
  sfx: SfxMode;
  /** обращения по настроению (-сама), заикание, «никак не называет» */
  honorifics: boolean;
  /** auto — только на уровне 3 */
  kaomoji: KaomojiMode;
  /** подсказки перевода в скобках */
  hints: boolean;
}

/** Умолчания ТЗ (раздел 2): уровень 2, кириллица, манга-звуки кана, подсказки вкл. */
export const STYLE_DEFAULT: StyleConfig = { level: 2, script: "cyrillic", sfx: "kana", honorifics: true, kaomoji: "auto", hints: false };

/** Настройки стиля из таблицы settings (ключи style_level, style_script, style_sfx, style_honorifics, style_kaomoji, hints_on). */
export function parseStyle(m: Map<string, string>): StyleConfig {
  const lv = Number(m.get("style_level"));
  const pickOf = <T extends string>(v: string | undefined, ok: readonly T[], d: T): T => (ok as readonly string[]).includes(v ?? "") ? (v as T) : d;
  return {
    level: lv === 0 || lv === 1 || lv === 2 || lv === 3 ? lv : STYLE_DEFAULT.level,
    script: pickOf(m.get("style_script"), ["cyrillic", "latin", "mixed"], STYLE_DEFAULT.script),
    sfx: pickOf(m.get("style_sfx"), ["kana", "cyrillic", "off"], STYLE_DEFAULT.sfx),
    honorifics: m.has("style_honorifics") ? m.get("style_honorifics") === "1" : STYLE_DEFAULT.honorifics,
    kaomoji: pickOf(m.get("style_kaomoji"), ["auto", "on", "off"], STYLE_DEFAULT.kaomoji),
    hints: m.has("hints_on") ? m.get("hints_on") === "1" : STYLE_DEFAULT.hints,
  };
}

/** Обратное к parseStyle: значения для таблицы settings (чтобы наложить изменения и разобрать заново). */
export function styleToSettings(s: StyleConfig): Map<string, string> {
  return new Map([
    ["style_level", String(s.level)],
    ["style_script", s.script],
    ["style_sfx", s.sfx],
    ["style_honorifics", s.honorifics ? "1" : "0"],
    ["style_kaomoji", s.kaomoji],
    ["hints_on", s.hints ? "1" : "0"],
  ]);
}

/** Числа слоя в одном месте (ТЗ, раздел 2). */
export const STYLE_LIMITS = {
  /** сколько японских слов не больше в одном сообщении */
  maxInterjections: 2,
  /** одно слово не чаще раза в столько сообщений */
  wordCooldown: 5,
  /** первые N использований слова идут с переводом в скобках */
  hintsFirstN: 2,
  /** шанс манга-звука на сообщение на уровне 3 (на уровне 2 — вдвое реже) */
  sfxChance: 0.35,
  kaomojiChance: 0.5,
  /** шанс слова в начале сообщения по уровню 0..3 */
  leadChance: [0, 1, 0.7, 0.85] as number[],
  /** шанс слова в конце сообщения по уровню 0..3 (на уровне 1 только одно слово) */
  tailChance: [0, 0, 0.35, 0.5] as number[],
  whisperChance: 0.3,
  /** шанс особого обращения (заикание цундере, редкие «аната», «-кун… то есть сама») */
  stutterChance: 0.5,
};
export type StyleLimits = typeof STYLE_LIMITS;

/** Что запомнено про пользователя: номер сообщения со стилем и по каждому слову — сколько раз и когда использовано. */
export interface StyleState {
  n: number;
  words: Record<string, { u: number; l: number }>;
  /** когда в последний раз был «кино-момент», мс (пауза между ними) */
  cin?: number;
  /** когда в последний раз засчитана симпатия за «ара-ара»/«ганбатте» хозяина, мс (раз в час) */
  bon?: number;
  /** вызовы модели для живых реплик за текущие сутки UTC: d — номер суток, n — сколько вызовов (дневной потолок) */
  lv?: { d: number; n: number };
  /** этап 2: отпечаток реплики → номер суток, когда она звучала в последний раз (не повторять 14 дней) */
  rl?: Record<string, number>;
  /** этап 2: серия суток подряд, когда «Готово» нажато вовремя: d — последние сутки, n — сколько суток подряд */
  ot?: { d: number; n: number };
  /** этап 2: с каких суток нет «Висит» (последнее просроченное дело или наблюдение «висит»); от него считается «неделя без «Висит»» */
  cl?: number;
  /** этап 2: когда показывалась особая реплика (номера суток): any — любая, gs — заметка о серии, wk — «7 дней вовремя», wc — начало отсчёта, за который дали «неделю без «Висит»» */
  ac?: { any?: number; gs?: number; wk?: number; wc?: number };
}
export const emptyStyleState = (): StyleState => ({ n: 0, words: {} });

const posNum = (x: unknown): number | undefined => (Number.isFinite(Number(x)) && Number(x) > 0 && x !== null && x !== "" ? Number(x) : undefined);

export function parseStyleState(json: string | null | undefined): StyleState {
  try {
    const v = JSON.parse(json ?? "{}");
    const words: StyleState["words"] = {};
    for (const [id, e] of Object.entries((v?.words ?? {}) as Record<string, { u?: unknown; l?: unknown }>)) {
      if (WORD_BY_ID.has(id) && Number.isFinite(Number(e?.u)) && Number.isFinite(Number(e?.l))) words[id] = { u: Number(e.u), l: Number(e.l) };
    }
    const out: StyleState = { n: Number.isFinite(Number(v?.n)) ? Number(v.n) : 0, words };
    if (Number(v?.cin) > 0) out.cin = Number(v.cin);
    if (Number(v?.bon) > 0) out.bon = Number(v.bon);
    if (Number(v?.lv?.d) > 0 && Number(v?.lv?.n) >= 0) out.lv = { d: Number(v.lv.d), n: Number(v.lv.n) };
    const rl: Record<string, number> = {};
    for (const [k, d] of Object.entries((v?.rl ?? {}) as Record<string, unknown>)) {
      const n = posNum(d);
      if (n !== undefined) rl[k] = n;
    }
    if (Object.keys(rl).length) out.rl = rl;
    const od = posNum(v?.ot?.d);
    const on = posNum(v?.ot?.n);
    if (od !== undefined && on !== undefined) out.ot = { d: od, n: on };
    const cl = posNum(v?.cl);
    if (cl !== undefined) out.cl = cl;
    const ac: NonNullable<StyleState["ac"]> = {};
    for (const k of ["any", "gs", "wk", "wc"] as const) {
      const n = posNum(v?.ac?.[k]);
      if (n !== undefined) ac[k] = n;
    }
    if (Object.keys(ac).length) out.ac = ac;
    return out;
  } catch {
    return emptyStyleState();
  }
}

/** Экранирование спецсимволов Markdown Discord (каомодзи содержат «_», «*», «~», «\»). */
export function escapeMd(s: string): string {
  return s.replace(/[\\_*~`|]/g, "\\$&");
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** Подсказка — первое значение до запятой («ну и ну», а не «ну и ну, усталый вздох»). */
const hintOf = (w: Word): string => w.meaning.split(",")[0].trim();

/** Знак после слова в начале и в конце сообщения по настроению (ТЗ, 5Б: паузы, тильды, восклицания). */
const LEAD_PUNCT: Record<Mood, string> = { tired: "...", tsundere: "!", yandere: "~", sulking: "...", proud: "...", sleepy: "..." };
const TAIL_PUNCT: Record<Mood, string> = { tired: "...", tsundere: "!", yandere: "~", sulking: "...", proud: ".", sleepy: "..." };

/** Подстановки самой фразы (не словаря): их рендерер не трогает, раскрывает fill(). */
const PLAIN_VARS = new Set(["user", "task", "miss_count", "done_streak", "name"]);

/** Убрать обращение {user} (sulking «говорит в пустоту»): «{user}, пора» → «Пора»; «пора, {user}.» → «пора.». */
export function removeAddress(text: string): string {
  let out = text.replace(/,\s*\{user\}(?=[.!?…~]|\s*$)/gu, "");
  const re = /(^|(?<=[.!?…*]\s))\{user\}(?:,|\.\.\.|…)?\s*/u;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const at = m.index + m[0].length;
    out = out.slice(0, m.index) + out.charAt(at).toUpperCase() + out.slice(at + 1);
  }
  return out;
}

export interface RenderArgs {
  /** фраза из пула как есть: с {user}, {task} и, возможно, токенами словаря */
  template: string;
  mood: Mood;
  situation: Situation;
  style: StyleConfig;
  state: StyleState;
  rand: () => number;
  vars?: PhraseVars;
  cfg?: MoodConfig;
  limits?: StyleLimits;
}

export interface RenderResult {
  /** готовый текст; манга-звук — отдельной строкой после основного (вывод оформляет вызывающий) */
  text: string;
  state: StyleState;
  /** какие слова словаря использованы (для журнала и теста лимитов) */
  used: string[];
}

export function renderStyled(a: RenderArgs): RenderResult {
  const cfg = a.cfg ?? MOOD_CONFIG;
  const L = a.limits ?? STYLE_LIMITS;
  const st = a.style;
  const lvl = st.level;
  const rand = a.rand;
  const n = a.state.n + 1;
  const words: StyleState["words"] = {};
  for (const [k, v] of Object.entries(a.state.words)) words[k] = { ...v };
  const used: string[] = [];
  let budget = L.maxInterjections;
  let forcedSfx: SfxId | null = null;
  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

  const scriptNow = (): "cyrillic" | "latin" => (st.script === "mixed" ? (rand() < 0.5 ? "cyrillic" : "latin") : st.script);

  /** Слово в нужной письменности, с суффиксом (уровень 2+) и подсказкой, пока слово «новое». Записывает использование. */
  const show = (w: Word): string => {
    const sc = scriptNow();
    let s = sc === "latin" ? w.latin : w.cyrillic;
    if (w.suffix && lvl >= 2 && st.honorifics) s += sc === "latin" ? w.suffix.latin : w.suffix.cyrillic;
    const before = words[w.id]?.u ?? 0;
    if (st.hints && lvl >= 1 && before < L.hintsFirstN) s += ` (${hintOf(w)})`;
    used.push(w.id);
    words[w.id] = { u: before + 1, l: n };
    budget--;
    return s;
  };

  // 1. Манера речи настроения (уровень 2+): мягкие правки концовки и растяжка «ну-у»; потом токены словаря в тексте фразы (если авторы фраз их пишут). Уровень 0 и исчерпанный лимит — русский эквивалент.
  let tokenTouched = false;
  // манера речи — на исходной фразе, до вставок: слова словаря и подсказки перевода она не трогает
  const source = lvl >= 2 ? manner(a.template, a.mood, rand) : a.template;
  let text = source.replace(/\{([^{}]+)\}/g, (m: string, inner: string, offset: number) => {
    if (PLAIN_VARS.has(inner)) return m;
    tokenTouched = true;
    const atStart = offset === 0 || /(?:[.!?…]|\*)\s+$/u.test(source.slice(0, offset));
    if (inner === "honorific") return "{user}";
    if (inner === "sigh") return lvl >= 2 ? `${st.sfx === "kana" ? `${SFX.sigh.kana} ` : ""}ха-а...` : "*вздох*";
    if (inner.startsWith("sfx:")) {
      const id = inner.slice(4);
      if (isSfx(id) && lvl >= 2 && st.sfx !== "off") forcedSfx = id;
      return "";
    }
    if (inner.startsWith("whisper:")) {
      const t = inner.slice(8);
      return lvl >= 3 ? `||${t}||` : `(тихо: ${t})`;
    }
    if (inner.startsWith("stutter:")) {
      const t = inner.slice(8);
      return lvl >= 2 ? t : t.replace(/^(\p{L})-(?=\p{L})/u, "");
    }
    const w = WORD_BY_ID.get(inner);
    if (!w) return ""; // неизвестная подстановка: пусто, предложение не ломается
    const s = lvl === 0 || budget <= 0 ? w.ru : show(w);
    return atStart ? cap(s) : s;
  });
  if (tokenTouched) text = text.replace(/\s{2,}/g, " ").replace(/\s+([,.!?…~])/g, "$1").replace(/^\s*[,.]\s*/, "").trim();

  const next: StyleState = { ...a.state, n, words };
  if (lvl === 0) return { text: fill(text, { ...a.vars, user: a.vars?.user ?? cfg.address }, cfg), state: next, used };

  // 3. Междометие в начало (уровень 1+), слово в конец (уровень 2+); лимиты: на сообщение и паузы между повторами
  const free = (slot: Word["slot"]): Word[] =>
    WORDS.filter(
      (w) =>
        w.slot === slot &&
        w.moods.includes(a.mood) &&
        (!w.situations || w.situations.includes(a.situation)) &&
        !used.includes(w.id) &&
        !(words[w.id] && n - words[w.id].l < L.wordCooldown),
    );
  const wrap = (w: Word, punctTable: Record<Mood, string>): string => `${cap(show(w))}${w.punct ?? punctTable[a.mood]}`;
  if (budget > 0 && rand() < L.leadChance[lvl]) {
    const c = free("lead");
    if (c.length) {
      text = `${wrap(pick(c), LEAD_PUNCT)} ${text}`;
    }
  }
  if (budget > 0 && lvl >= 2 && rand() < L.tailChance[lvl]) {
    const c = free("tail");
    if (c.length) text = `${text} ${wrap(pick(c), TAIL_PUNCT)}`;
  }

  // 4. Шёпот цундере в спойлере (уровень 3)
  const wh = WHISPERS[a.mood];
  if (lvl >= 3 && wh && wh.situations.includes(a.situation) && rand() < L.whisperChance) text += ` ||${pick(wh.lines)}||`;

  // 5. Обращение по настроению (уровень 2+): «госюдзин-сама», заикание «х-хозяин», sulking не называет вовсе
  let userVoc: string | undefined;
  if (lvl >= 2 && st.honorifics) {
    if (a.mood === "tsundere") {
      if (rand() < L.stutterChance) userVoc = `${cfg.address.charAt(0)}-${cfg.address}`;
    } else {
      const addr = ADDRESS[a.mood];
      if (addr === null) text = removeAddress(text);
      else {
        const sc = scriptNow();
        userVoc = pick(sc === "latin" ? addr.latin : addr.cyrillic);
      }
    }
  }

  // 6. Каомодзи: уровень 3 или по настройке; один на сообщение, с экранированием Markdown
  const kao = KAOMOJI[a.mood];
  if (kao && (st.kaomoji === "on" || (st.kaomoji === "auto" && lvl >= 3)) && rand() < L.kaomojiChance) text += ` ${escapeMd(kao)}`;

  let out = fill(text, { ...a.vars, user: a.vars?.user ?? cfg.address, userVoc }, cfg).replace(/~([,.])/g, "~");

  // 7. Манга-звук отдельной строкой (уровень 2+, один на сообщение); на «вернулись» бывает «ハッ！»
  if (lvl >= 2 && st.sfx !== "off") {
    let id: SfxId | null = forcedSfx;
    if (!id && rand() < (lvl >= 3 ? L.sfxChance : L.sfxChance / 2)) {
      const ids: SfxId[] = a.situation === "return_after_pause" ? ["startle", ...MOOD_SFX[a.mood]] : MOOD_SFX[a.mood];
      id = pick(ids);
    }
    if (id) out += `\n${SFX[id][st.sfx]}`;
  }
  return { text: out, state: next, used };
}

/** Мягкие правки манеры речи (ТЗ, 5Б) для текста без затрагивания подстановок. */
function manner(text: string, mood: Mood, rand: () => number): string {
  let t = text;
  const last = t.charAt(t.length - 1);
  const prev = t.charAt(t.length - 2);
  if ((mood === "tired" || mood === "sulking" || mood === "sleepy") && last === "." && prev !== "." && rand() < 0.4) t = `${t.slice(0, -1)}...`;
  else if (mood === "yandere" && (last === "." || last === "!") && prev !== "." && rand() < 0.5) t = `${t.slice(0, -1)}~`;
  if (mood === "tired" && rand() < 0.5) t = t.replace(/(?<![\p{L}-])([Нн])у(?![\p{L}-])/u, "$1у-у");
  return t;
}

/** Все слова, которые встречались у пользователя: для /glossary. Самые частые сверху. */
export function glossaryEntries(state: StyleState, script: Script = "cyrillic"): { id: string; word: string; meaning: string; uses: number }[] {
  return WORDS.filter((w) => (state.words[w.id]?.u ?? 0) > 0)
    .map((w) => ({
      id: w.id,
      word: script === "latin" ? w.latin : w.cyrillic,
      meaning: w.meaning,
      uses: state.words[w.id].u,
    }))
    .sort((x, y) => y.uses - x.uses || x.word.localeCompare(y.word, "ru"));
}
