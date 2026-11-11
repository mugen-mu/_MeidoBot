// Вопросы про свои дела обычным текстом («что у меня горит», «какие у меня дела», «что на сегодня», «что на неделю»):
// отвечаем списком, а не заводим дело «Что у меня горит». Правило до разбора напоминания, без языковой модели
// (решение пользователя 2026-11-11: панели «Горит» нет, спрашиваю текстом).
// Осторожность — как у вопросов про свет и погоду (`ask.ts`): всё сообщение из слов вопроса и хотя бы одно ключевое слово;
// лишнее слово или цифра — это обычное дело. Для промаха под ответом есть кнопка «Это было дело».
import { ASK_COMMON, type AskSpec, askWords, matchAsk } from "./ask.ts";
import type { Character } from "./flavor.ts";
import type { OccView } from "./db/types.ts";
import { hotText, listText, todayText, weekText } from "./discord/ui.ts";
import { weekAnimeText } from "./anime/ui.ts";
import type { Anime } from "./anime/core.ts";

/** Что спросили: висит/горит, все открытые дела, сегодня, ближайшие 7 дней. */
export type TasksAsk = "hot" | "all" | "today" | "week";

/** Слова вопроса. «как» убрано: «как дела» — приветствие, а не просьба показать список. */
const FILLER = new Set([
  ...ASK_COMMON.filter((w) => w !== "как"),
  "меня", "мои", "моё", "мое", "мой", "все", "всё", "ещё", "еще", "мне", "этой", "эту", "ближайшую", "ближайшие", "ближайший", "дни", "день", "открытые", "текущие",
  "расскажи", "не", "закрыто",
]);

const HOT = /^(?:гор(?:ит|ят|ело|ели)|горящ(?:ее|ие|их)|виси(?:т|ят)|висящ(?:ее|ие|их)|просрочен(?:о|ы|ное|ные|ных)|просрочк(?:а|и)|срочн(?:ое|ые|ых)|незакрыт(?:ое|ые|ых))$/u;
const ALL = /^(?:дел(?:а|о|ам|ами|ах)?|задач(?:а|и|у|ам|ами|ах)?|списо(?:к|чек)|списк(?:а|и|ов)|план(?:ы|ов|ах)?|напоминани(?:я|й|ями|ях|е)|напоминалк(?:и|ам|ах))$/u;
const WEEK = /^(?:недел(?:я|ю|и|е|ей)|недельн(?:ый|ая|ое|ые)|завтра|послезавтра)$/u;
/** «что у меня?», «что там у меня?» — вопрос без слова про дела; не больше четырёх слов. */
const ME = { rx: /^меня$/u, maxWords: 4 };

/** «сегодня» — слабое слово: само по себе («бот, сегодня») это ещё не вопрос, нужно хотя бы одно слово рядом. */
const TODAY_WORD = /^(?:сегодня|сегодняшние)$/u;

const SPEC: AskSpec = { key: new RegExp(`(?:${HOT.source})|(?:${ALL.source})|(?:${WEEK.source})`, "u"), weakKey: TODAY_WORD, filler: FILLER, shortKey: ME };

/** Что именно спросили, или null — это не вопрос про дела. Порядок важности: висит, неделя/завтра, сегодня, все. */
export function parseTasksQuestion(text: string): TasksAsk | null {
  if (!matchAsk(text, SPEC)) return null;
  const ws = askWords(text);
  if (ws.some((w) => HOT.test(w))) return "hot";
  if (ws.some((w) => WEEK.test(w))) return "week";
  if (ws.some((w) => TODAY_WORD.test(w))) return "today";
  return "all";
}

/** Текст ответа на вопрос про дела; `anime` — строка «что выходит на неделе» (только к неделе). */
export function tasksAnswer(kind: TasksAsk, items: OccView[], now: number, tz: string, ch: Character, anime: Anime[] = []): string {
  switch (kind) {
    case "hot":
      return hotText(items, now, tz, ch);
    case "today":
      return todayText(items, now, tz, ch);
    case "week": {
      const base = weekText(items, now, tz, ch);
      const extra = weekAnimeText(anime, now, tz);
      return extra ? `${base}\n\n${extra}` : base;
    }
    default:
      return listText(items, now, tz, ch);
  }
}
