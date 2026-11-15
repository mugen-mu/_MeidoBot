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
  | "recorded"
  // этап 2 «Характер»: сообщения, где раньше реплики не было
  | "summary_morning"
  | "summary_evening"
  | "summary_weekly"
  | "empty_list"
  | "empty_today"
  | "holiday"
  | "birthday_soon"
  // этап 2б: короткие ответы бота (черновик, отмена, откладывание, удаление, «не поняла» в Reply)
  | "draft"
  | "cancelled"
  | "stopped"
  | "snoozed"
  | "deleted"
  | "reply_unknown"
  | "reply_past"
  | "reply_closed"
  // этап 2 ретроспективы 2 «Хару ожила»: пятое откладывание, хорошая серия, достижения
  | "snooze_5"
  | "good_streak"
  | "achieve_tail"
  | "achieve_week_clean"
  | "achieve_week_ontime"
  // этап 3: «Висит» = 0 раз в неделю и подпись под субботним разбором
  | "tail_clear"
  | "tail_review"
  // этап 4: источник замолчал (сразу) и всё ещё молчит (раз в неделю в итоге)
  | "source_down"
  | "source_week"
  // этап 5: календарь сюрпризов — сезонное «между прочим» и «Год с Хару» (фразы берутся у родственных ситуаций, пока своего пула нет)
  | "seasonal"
  | "year_with"
  // объявления про свет («Света нет с …», «Свет вернулся в …»): фраза Хару первой
  | "power_off"
  | "power_on"
  // пакет «оживление» (2026-11-15): вес дела — пустяк или важное; дождь; ответ про погоду
  | "missed_minor"
  | "done_minor"
  | "missed_major"
  | "done_major"
  | "rain_start"
  | "rain_end"
  | "rain_early"
  | "weather_ask";

export const SITUATIONS: Situation[] = [
  "reminder", "reminder_repeat", "missed_first", "missed", "done", "done_late", "streak_praise", "relief",
  "greeting", "return_after_pause", "idle_ping", "chat_fallback", "thanks", "recorded",
  "summary_morning", "summary_evening", "summary_weekly", "empty_list", "empty_today", "holiday", "birthday_soon",
  "draft", "cancelled", "stopped", "snoozed", "deleted", "reply_unknown", "reply_past", "reply_closed",
  "snooze_5", "good_streak", "achieve_tail", "achieve_week_clean", "achieve_week_ontime",
  "tail_clear", "tail_review", "source_down", "source_week", "seasonal", "year_with", "power_off", "power_on",
  "missed_minor", "done_minor", "missed_major", "done_major", "rain_start", "rain_end", "rain_early", "weather_ask",
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
  summary_weekly: "summary_evening",
  empty_today: "empty_list",
  birthday_soon: "holiday",
  stopped: "cancelled",
  reply_past: "reply_unknown",
  reply_closed: "reply_unknown",
  snooze_5: "snoozed",
  good_streak: "done",
  achieve_tail: "done",
  achieve_week_clean: "summary_weekly",
  achieve_week_ontime: "done",
  tail_clear: "empty_list",
  tail_review: "summary_weekly",
  source_down: "summary_weekly",
  source_week: "summary_weekly",
  seasonal: "greeting",
  year_with: "summary_weekly",
  power_off: "reminder",
  power_on: "done",
  missed_minor: "missed_first",
  done_minor: "done",
  missed_major: "missed",
  done_major: "done",
};

export type Phrases = Record<string, Partial<Record<Situation, string[]>>>;

import { BASE_PHRASES } from "./phrases.base.ts";
import { EXTRA_PHRASES } from "./phrases.extra.ts";
import { GENERATED } from "./phrases.generated.ts";
import { REACTION_PHRASES } from "./phrases.reactions.ts";
import { STAGE2_PHRASES } from "./phrases.stage2.ts";
import { STAGE3_PHRASES } from "./phrases.stage3.ts";
import { STAGE4_PHRASES } from "./phrases.stage4.ts";
import { POWER_PHRASES } from "./phrases.stage5.ts";
import { PERSONA_BRIGHT } from "./phrases.persona.bright.ts";
import { PERSONA_PLAYFUL } from "./phrases.persona.playful.ts";
import { PERSONA_PRIM } from "./phrases.persona.prim.ts";
import { POLISH_PROUD } from "./phrases.polish.proud.ts";
import { POLISH_TIRED } from "./phrases.polish.tired.ts";
import { POLISH_TSUNDERE } from "./phrases.polish.tsundere.ts";
import { RAIN_PHRASES } from "./phrases.rain.ts";
import { WEIGHT_PHRASES } from "./phrases.weight.ts";

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

/** Запасной набор: свои фразы и фразы для сводок/пустого списка/праздников (у них основного пула нет). */
const FALLBACK_BANK: Phrases = Object.fromEntries(
  [...new Set([...Object.keys(BASE_PHRASES), ...Object.keys(EXTRA_PHRASES), ...Object.keys(REACTION_PHRASES), ...Object.keys(STAGE2_PHRASES), ...Object.keys(STAGE3_PHRASES), ...Object.keys(STAGE4_PHRASES), ...Object.keys(POWER_PHRASES)])].map((m) => [
    m,
    { ...BASE_PHRASES[m], ...EXTRA_PHRASES[m], ...REACTION_PHRASES[m], ...STAGE2_PHRASES[m], ...STAGE3_PHRASES[m], ...STAGE4_PHRASES[m], ...POWER_PHRASES[m] },
  ]),
);

/**
 * Добавить фразы к готовому набору: к каждому списку (настроение или образ → ситуация) дописываются новые, без дублей по тексту.
 * Так короткие пулы (3–4 фразы) дорастают до 10+, а новые ситуации и образы появляются, не трогая старые файлы с данными.
 */
export function addPools(base: Phrases, extra: Phrases): Phrases {
  const out: Phrases = {};
  for (const voice of new Set([...Object.keys(base), ...Object.keys(extra)])) {
    out[voice] = { ...base[voice] };
    for (const [sit, add] of Object.entries(extra[voice] ?? {}) as [Situation, string[]][]) {
      const list = [...(out[voice][sit] ?? [])];
      const seen = new Set(list.map(key));
      for (const t of add) {
        if (t.trim() && !seen.has(key(t))) {
          seen.add(key(t));
          list.push(t);
        }
      }
      if (list.length) out[voice][sit] = list;
    }
  }
  return out;
}

/** Файлы пакета «оживление» по именам: по ним работают scripts/lint-phrases.ts и тесты (poolSpec.ts). */
export const ADDITION_GROUPS: Record<string, Phrases> = {
  "persona.playful": PERSONA_PLAYFUL,
  "persona.prim": PERSONA_PRIM,
  "persona.bright": PERSONA_BRIGHT,
  weight: WEIGHT_PHRASES,
  rain: RAIN_PHRASES,
  "polish.tired": POLISH_TIRED,
  "polish.tsundere": POLISH_TSUNDERE,
  "polish.proud": POLISH_PROUD,
};

/** Набор до дополнений (для линтера: сколько фраз было до новых). */
export const PHRASES_BASE: Phrases = mergePools(GENERATED, FALLBACK_BANK);

export const PHRASES: Phrases = Object.values(ADDITION_GROUPS).reduce((acc, g) => addPools(acc, g), PHRASES_BASE);
