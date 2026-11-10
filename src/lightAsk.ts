// Вопрос про свет обычным текстом в канале «бот» («дай график света», «что со светом»): отвечаем графиком, а не заводим дело.
// Правило до разбора напоминания, без языковой модели (решение пользователя 2026-11-10, этап 1 «C-lite»).
// Осторожность важнее смелости: всё сообщение должно состоять из слов вопроса (список ниже) и содержать слово «свет».
// Любое лишнее слово или цифра (время, дата) — это обычное дело, а не вопрос. Для промаха под ответом есть кнопка «Это было дело».
import type { MessageBody } from "./discord/types.ts";

/** Самая длинная фраза-вопрос, символов (длиннее — это уже дело или рассказ). */
export const LIGHT_ASK_MAX_CHARS = 60;
const MAX_WORDS = 8;

/** Слова, которые допустимы в вопросе рядом со словом «свет». */
const FILLER = new Set([
  "бот", "хару", "дай", "дайте", "покажи", "покажите", "скажи", "скажите", "пришли", "пришлите", "узнай", "проверь", "глянь", "посмотри",
  "какой", "какая", "какие", "что", "как", "там", "с", "со", "у", "нас", "на", "в", "сегодня", "завтра", "сейчас", "график", "графики", "графика",
  "отключений", "отключения", "отключение", "пожалуйста", "мне", "есть", "ли", "когда", "будет", "выключат", "отключат", "включат", "дела", "опять", "уже",
]);

/** «свет» в любой форме: свет, света, свету, светом, свете; и «электричество». */
const KEY = /^(?:свет(?:а|у|ом|е)?|электричеств(?:о|а|у|ом|е))$/u;

/** Слова сообщения: строчные, «ё» = «е», только буквы. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Похоже ли сообщение на вопрос «покажи график света». */
export function isLightQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > LIGHT_ASK_MAX_CHARS || /\d/.test(t)) return false;
  const ws = words(t);
  if (ws.length === 0 || ws.length > MAX_WORDS) return false;
  let key = false;
  for (const w of ws) {
    if (KEY.test(w)) key = true;
    else if (!FILLER.has(w)) return false;
  }
  return key;
}

/** Кнопка под ответом: «Это было дело» — исходная фраза записывается как обычное дело (custom_id `ldo:<фраза>`, до 100 знаков в сумме). */
export const LIGHT_ASK_BUTTON_PREFIX = "ldo:";

export function lightAskMessage(text: string, original: string): MessageBody {
  return {
    content: text,
    components: [{ type: 1, components: [{ type: 2, style: 2, label: "Это было дело", custom_id: `${LIGHT_ASK_BUTTON_PREFIX}${original.trim().slice(0, LIGHT_ASK_MAX_CHARS)}` }] }],
    allowed_mentions: { parse: [] },
  };
}
