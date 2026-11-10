// Общий разбор коротких вопросов к боту обычным текстом («что со светом», «какой прогноз на завтра»): без языковой модели, по ключевым словам.
// Осторожность важнее смелости: всё сообщение состоит из слов вопроса (список служебных слов) и содержит ключевое слово.
// Любое лишнее слово или цифра (время, дата) — это обычное дело, а не вопрос; для промаха под ответом есть кнопка «Это было дело».

/** Самая длинная фраза-вопрос, символов (длиннее — это уже дело или рассказ). */
export const ASK_MAX_CHARS = 60;
export const ASK_MAX_WORDS = 8;

/** Слова сообщения: строчные, «ё» = «е», только буквы и цифры. */
export function askWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Слова-обращения и просьбы, общие для всех вопросов. */
export const ASK_COMMON = [
  "бот", "хару", "дай", "дайте", "покажи", "покажите", "скажи", "скажите", "пришли", "пришлите", "узнай", "проверь", "глянь", "посмотри",
  "какой", "какая", "какие", "какое", "что", "как", "там", "с", "со", "у", "нас", "на", "в", "во", "по", "сегодня", "завтра", "послезавтра", "сейчас",
  "утром", "вечером", "днем", "ночью", "пожалуйста", "мне", "есть", "ли", "когда", "будет", "будут", "опять", "уже", "дела", "нет", "нету", "скоро",
];

export interface AskSpec {
  /** слова, без которых это не вопрос (хотя бы одно из ключевых; полное слово) */
  key: RegExp;
  /** «слабые» ключи (дождь, зонт): считаются, только если слов в сообщении не меньше двух */
  weakKey?: RegExp;
  /** слова, допустимые рядом с ключевым */
  filler: Set<string>;
  /** ключи, которым нужно ≤ N слов всего («какой график», «дай график») */
  shortKey?: { rx: RegExp; maxWords: number };
}

/** Похоже ли сообщение на короткий вопрос по описанию `spec`. */
export function matchAsk(text: string, spec: AskSpec): boolean {
  const t = text.trim();
  if (!t || t.length > ASK_MAX_CHARS || /\d/.test(t)) return false;
  const ws = askWords(t);
  if (ws.length === 0 || ws.length > ASK_MAX_WORDS) return false;
  let key = false;
  for (const w of ws) {
    if (spec.key.test(w)) key = true;
    else if (spec.weakKey?.test(w) && ws.length >= 2) key = true;
    else if (spec.shortKey?.rx.test(w) && ws.length <= spec.shortKey.maxWords) key = true;
    else if (!spec.filler.has(w)) return false;
  }
  return key;
}
