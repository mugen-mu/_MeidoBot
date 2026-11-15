// Что должно лежать в файлах пакета «оживление» (2026-11-15): по группам, голосам и ситуациям — сколько фраз минимум в ИТОГОВОМ пуле.
// Только данные: по ним работают scripts/lint-phrases.ts и test/polish-phrases.test.ts. Итоговый пул = старые фразы + новые из группы.
import type { Situation } from "./phrases.ts";

type Need = Partial<Record<Situation, number>>;

/** Образ дня (озорная, чопорная, бодрая) говорит там, где у неё есть фразы; нужен костяк повседневных ситуаций. */
export const PERSONA_NEED: Need = {
  reminder: 8, reminder_repeat: 8, missed: 8, missed_first: 5, done: 8, done_late: 6, streak_praise: 6, relief: 4,
  greeting: 6, return_after_pause: 5, idle_ping: 5, chat_fallback: 5, thanks: 4,
  recorded: 6, draft: 4, cancelled: 4, snoozed: 5, deleted: 4, summary_morning: 5, summary_evening: 5, empty_list: 4, reply_unknown: 4, snooze_5: 4,
};

/** Короткие пулы настроений (было 2–4 фразы): довести до 10+, чтобы не крутились по кругу. */
const POLISH_SITUATIONS: Situation[] = [
  "recorded", "summary_morning", "summary_evening", "empty_list", "draft", "cancelled", "snoozed", "deleted", "reply_unknown", "snooze_5", "thanks", "missed_first", "good_streak",
];
export const POLISH_NEED: Need = Object.fromEntries(POLISH_SITUATIONS.map((s) => [s, 10]));

/** Вес дела: у каждого голоса свои реплики на пустяк и на важное. Яндере говорит только при важном пропуске (яндере-подколки при пропуске). */
export const WEIGHT_NEED: Need = { missed_minor: 5, done_minor: 5, missed_major: 5, done_major: 5 };
/** Дождь: реплика рядом с сообщением («начался», «закончился», «скоро») и перед честным ответом про погоду. Яндере в этих ситуациях не говорит (как цундере). */
export const RAIN_NEED: Need = { rain_start: 5, rain_end: 5, rain_early: 5, weather_ask: 4 };

export type GroupSpec = Record<string, Need>;

/** Группа → какие голоса и сколько фраз по ситуациям в ней ожидается. Имя группы = ключ в ADDITION_GROUPS (phrases.ts). */
export const GROUP_SPEC: Record<string, GroupSpec> = {
  "persona.playful": { playful: PERSONA_NEED },
  "persona.prim": { prim: PERSONA_NEED },
  "persona.bright": { bright: PERSONA_NEED },
  weight: {
    tired: WEIGHT_NEED, tsundere: WEIGHT_NEED, sulking: WEIGHT_NEED, proud: WEIGHT_NEED, sleepy: WEIGHT_NEED,
    playful: WEIGHT_NEED, prim: WEIGHT_NEED, bright: WEIGHT_NEED,
    yandere: { missed_major: 5 },
  },
  rain: {
    tired: RAIN_NEED, tsundere: RAIN_NEED, sulking: RAIN_NEED, proud: RAIN_NEED, sleepy: RAIN_NEED,
    playful: RAIN_NEED, prim: RAIN_NEED, bright: RAIN_NEED,
  },
  "polish.tired": { tired: POLISH_NEED, sleepy: POLISH_NEED, yandere: { missed_first: 5 } },
  "polish.tsundere": { tsundere: POLISH_NEED, sulking: POLISH_NEED },
  "polish.proud": { proud: POLISH_NEED },
};

/** Ситуации, где фраза не должна называть вид осадков: рядом стоит факт «начался дождь/снег», вид в нём. */
export const RAIN_KIND_FREE: ReadonlySet<Situation> = new Set<Situation>(["rain_start", "rain_end", "rain_early"]);
