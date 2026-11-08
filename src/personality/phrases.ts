// Фразы горничной: ТОЛЬКО ДАННЫЕ. Структура: настроение → ситуация → список фраз.
// Данные лежат в двух файлах: phrases.generated.ts (основной пул из Gemini, создаётся scripts/import-phrases.ts)
// и phrases.base.ts (свои запасные фразы). Здесь они сводятся в один набор PHRASES.
//
// Ситуации (ТЗ, раздел 8):
//   reminder          — само напоминание, первое сообщение
//   reminder_repeat   — повтор напоминания (лестница настойчивости)
//   missed_first      — первый пропуск подряд: вздох без упрёков (необязательная ситуация)
//   missed            — дело просрочено (второй пропуск и далее)
//   done              — нажато «Готово» вовремя
//   done_late         — нажато «Готово» с опозданием
//   streak_praise     — серия выполненных подряд (3, 7, 14, 30)
//   relief            — «наконец-то»: дело выполнено после пропусков (необязательная)
//   greeting          — приветствие (в /mood и первых сообщениях дня)
//   return_after_pause— пользователь вернулся после долгой паузы
//   idle_ping         — «вас давно нет» (на потом, ТЗ: молчание)
//   chat_fallback     — когда бот не поняла, что от неё хотят
//   thanks            — в ответ на «спасибо», «молодец» (вежливость)
//
// Подстановки: {user} — как она зовёт пользователя, {task} — название дела, {miss_count} — пропусков подряд,
// {done_streak} — выполнено подряд, {name} — её имя.
// Правила: фраза — одна-две короткие строки; суть напоминания (время, дело) в сообщении остаётся по-русски и без изменений,
// фраза лишь добавляется под ним. Действия — в звёздочках. Яндере только комедийная, без угроз и давления.
export type Situation =
  | "reminder"
  | "reminder_repeat"
  | "missed_first"
  | "missed"
  | "done"
  | "done_late"
  | "streak_praise"
  | "relief"
  | "greeting"
  | "return_after_pause"
  | "idle_ping"
  | "chat_fallback"
  | "thanks"
  /** дело записано (подтверждение «Записано …») */
  | "recorded";

export const SITUATIONS: Situation[] = [
  "reminder", "reminder_repeat", "missed_first", "missed", "done", "done_late", "streak_praise", "relief",
  "greeting", "return_after_pause", "idle_ping", "chat_fallback", "thanks", "recorded",
];

/** Если у настроения нет фраз для ситуации, берём ближайшую «родственную» из того же настроения. */
export const FALLBACK_SITUATION: Partial<Record<Situation, Situation>> = {
  missed_first: "missed",
  done_late: "done",
  relief: "done",
  streak_praise: "done",
  reminder_repeat: "reminder",
  return_after_pause: "greeting",
  idle_ping: "greeting",
};

export type Phrases = Record<string, Partial<Record<Situation, string[]>>>;

import { BASE_PHRASES } from "./phrases.base.ts";
import { GENERATED } from "./phrases.generated.ts";

const key = (t: string): string => t.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();

/**
 * Свести основной пул и запасной: там, где в основном пуле для ситуации не меньше `minPrimary` фраз,
 * берём только их; иначе к ним добавляются запасные (без дублей). Ситуации, которых в основном пуле нет, — запасные.
 */
export function mergePools(primary: Phrases, fallback: Phrases, minPrimary = 8): Phrases {
  const out: Phrases = {};
  for (const mood of new Set([...Object.keys(primary), ...Object.keys(fallback)])) {
    out[mood] = {};
    const sits = new Set([...Object.keys(primary[mood] ?? {}), ...Object.keys(fallback[mood] ?? {})]) as Set<Situation>;
    for (const sit of sits) {
      const seen = new Set<string>();
      const list: string[] = [];
      const put = (t: string) => {
        if (t.trim() && !seen.has(key(t))) {
          seen.add(key(t));
          list.push(t);
        }
      };
      for (const t of primary[mood]?.[sit] ?? []) put(t);
      if (list.length < minPrimary) for (const t of fallback[mood]?.[sit] ?? []) put(t);
      if (list.length) out[mood][sit] = list;
    }
  }
  return out;
}

export const PHRASES: Phrases = mergePools(GENERATED, BASE_PHRASES);
