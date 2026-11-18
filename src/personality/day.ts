// Этап 2 ретроспективы 2 «Хару ожила»: чистая логика без базы и Discord.
//  • «Случайность» от даты и номера дела (D1, D2): детерминированная — повторный запуск той же минуты не меняет реплику.
//    Она касается ТОЛЬКО слов Хару. Время напоминаний, их число и текст дела она не трогает никогда: «напомни мне когда-то»
//    приходит строго по времени (сквозное правило плана).
//  • Образ дня (пакет «оживление», 2026-11-15): усталая или гордая Хару в этот день говорит ворчливо, мягко или одним из трёх образов (озорная, чопорная,
//    бодрая); у отдельных дел — «щепотка» другого образа. Настроение из-за пропусков и ночи образ не перебивает.
//  • Яндере-уровень — только в подколках при пропуске (D8); в остальных ситуациях Хару говорит как цундере.
//  • «Тихий день» словом на сутки (D3): в этот день Хару молчит совсем (D5).
//  • Память реплик на 14 дней (D6) и счётчики серии суток и достижений (D2, D9).
import type { StyleState } from "./animeStyle.ts";
import type { Mood } from "./moodEngine.ts";
import { type Persona, type Voice, isPersona } from "./persona.ts";
import type { Situation } from "./phrases.ts";

const DAY_MS = 86_400_000;

/** Детерминированное «случайное» число в [0, 1) от любых частей (дата, номер дела, соль). */
export function hash01(...parts: (string | number)[]): number {
  const s = parts.join("|");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Номер суток с 1970-01-01 по ключу «ГГГГ-ММ-ДД». */
export function dayNumber(dayKey: string): number {
  const t = Date.parse(`${dayKey}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : 0;
}

/** Голоса, которыми Хару может говорить «в этот день»: усталая, ворчливая (цундере), мягкая (гордая) и три образа (persona.ts). */
export type DayVoice = "tired" | "tsundere" | "proud" | Persona;

/**
 * Веса образов дня (пакет «оживление»): усталая остаётся любимым фоном, но не чаще чем в трети дней; остальное — ворчливая, мягкая и три образа.
 * Один образ на весь день (по дате), как и раньше окраска дня; у отдельных дел — «щепотка» другого.
 */
export const DAY_VOICE_WEIGHTS: ReadonlyArray<readonly [DayVoice, number]> = [
  ["tired", 0.3], ["tsundere", 0.15], ["proud", 0.15], ["playful", 0.15], ["prim", 0.12], ["bright", 0.13],
];

/** Взвешенный выбор по числу r в [0, 1); skip — голос, который выбирать нельзя (для «щепотки»: другой, чем у дня). */
export function pickDayVoice(r: number, skip?: DayVoice): DayVoice {
  const list = DAY_VOICE_WEIGHTS.filter(([v]) => v !== skip);
  const total = list.reduce((sum, [, w]) => sum + w, 0);
  let x = r * total;
  for (const [v, w] of list) {
    x -= w;
    if (x < 0) return v;
  }
  return list[list.length - 1][0];
}

/** Образ дня: один на сутки хозяина (по дате). */
export const dayVoice = (dayKey: string): DayVoice => pickDayVoice(hash01("voice", dayKey));

/** «Щепотка»: выпала ли случайность p для этой даты, дела и соли; для одного дела в один день ответ всегда один. */
export const pinch = (dayKey: string, itemId: number, salt: string, p: number): boolean => hash01(dayKey, itemId, salt) < p;

/** Яндере-уровень разрешён только здесь (подколки при пропуске, D8). */
export const YANDERE_SITUATIONS: ReadonlySet<Situation> = new Set<Situation>(["missed_first", "missed", "missed_major"]);

/** В ворчливый день усталая Хару ворчит на этом (цундере). */
const GRUMPY_SITUATIONS: ReadonlySet<Situation> = new Set<Situation>([
  "reminder", "reminder_repeat", "snoozed", "draft", "recorded", "summary_morning", "summary_evening", "empty_list", "empty_today", "cancelled", "deleted", "reply_unknown",
]);
/** В мягкий день усталая Хару теплее на этом (гордится). */
const SOFT_SITUATIONS: ReadonlySet<Situation> = new Set<Situation>([
  "done", "done_late", "done_major", "heavy_day", "recorded", "greeting", "summary_morning", "summary_evening", "summary_weekly", "empty_list", "empty_today", "thanks",
]);

/** Шанс, что у отдельного дела образ дня «не сработал» (щепотка), и шанс яндере-подколки на пропуске. */
export const PINCH_CHANCE = 0.15;
export const YANDERE_TEASE_CHANCE = 0.2;

/**
 * Образ спокойного дня. Накладывается только на «спокойные» настроения: усталую и гордую; ворчливая, обиженная, сонная и яндере остаются как есть:
 * их выбрали числа и время, образ дня их не перебивает. Усталая может стать ворчливой (на «ворчливых» ситуациях) или мягкой (на «мягких»);
 * образы (озорная, чопорная, бодрая) говорят везде, где у них есть фразы; гордая меняется только на образы (не на усталую и не на ворчливую).
 * Нет фраз у образа для этой ситуации — остаётся настроение.
 */
function calmVoice(a: { mood: Mood; situation: Situation; dayKey: string; id: number; has: (m: Voice, s: Situation) => boolean }): Voice {
  const { mood, situation, dayKey, id, has } = a;
  if (mood !== "tired" && mood !== "proud") return mood;
  let voice = dayVoice(dayKey);
  if (pinch(dayKey, id, `tint:${situation}`, PINCH_CHANCE)) voice = pickDayVoice(hash01(dayKey, id, `flip:${situation}`), voice);
  if (voice === mood) return mood;
  if (isPersona(voice)) return has(voice, situation) ? voice : mood;
  if (mood === "tired") {
    if (voice === "tsundere" && GRUMPY_SITUATIONS.has(situation) && has("tsundere", situation)) return "tsundere";
    if (voice === "proud" && SOFT_SITUATIONS.has(situation) && has("proud", situation)) return "proud";
  }
  return mood;
}

/**
 * Голос, которым говорить сейчас. Настоящее настроение (из чисел) — основа; поверх:
 *  1. яндере вне пропусков → цундере (яндере-уровень только в подколках, D8);
 *  2. на пропуске усталая, цундере и обиженная в части случаев подкалывают яндере-голосом;
 *  3. усталая и гордая окрашиваются образом дня (`calmVoice`).
 * Если у нужного голоса нет фраз для ситуации (`has`), остаётся прежний.
 */
export function effectiveMood(a: { mood: Mood; situation: Situation; dayKey: string; itemId?: number; has: (m: Voice, s: Situation) => boolean }): Voice {
  const { mood, situation, dayKey, has } = a;
  const id = a.itemId ?? 0;
  const pick = (...cands: Mood[]): Mood => cands.find((m) => m === mood || has(m, situation)) ?? mood;
  if (mood === "yandere" && !YANDERE_SITUATIONS.has(situation)) return pick("tsundere", "tired");
  if (YANDERE_SITUATIONS.has(situation) && (mood === "tired" || mood === "tsundere" || mood === "sulking") && pinch(dayKey, id, "yd", YANDERE_TEASE_CHANCE) && has("yandere", situation)) return "yandere";
  return calmVoice({ mood, situation, dayKey, id, has });
}

// ---------- «тихий день» ----------

export const QUIET_DAY_MS = DAY_MS;
export const QUIET_ON_REPLY = "Хорошо. Сегодня потише.";
export const QUIET_OFF_REPLY = "Хорошо. Хару снова в роли.";
export const QUIET_META_KEY = "quiet_day_until";

const QUIET_ON = /^(?:бот[,\s]+)?тихий день(?:[\s,]+(?:пожалуйста|сегодня))?[\s.!]*$/iu;
const QUIET_OFF = /^(?:бот[,\s]+)?(?:тихий день[\s,]+(?:отмена|отбой|выкл(?:ючи)?|хватит)|хватит (?:тишины|тихого дня)|отмени тихий день)[\s.!]*$/iu;

/** Слово хозяина про тихий день: «on» — включить на сутки, «off» — снять; иначе null. Сообщение целиком из этих слов, иначе это обычное дело. */
export function parseQuietDay(text: string): "on" | "off" | null {
  const t = text.trim().replace(/ё/giu, "е");
  if (t.length === 0 || t.length > 60) return null;
  if (QUIET_OFF.test(t)) return "off";
  if (QUIET_ON.test(t)) return "on";
  return null;
}

/** Тихий день ещё идёт? meta.quiet_day_until — момент окончания, мс. */
export const isQuietNow = (raw: string | undefined | null, now: number): boolean => Number(raw ?? 0) > now;

// ---------- серия суток и достижения ----------

export type Achievement = "tail" | "week_ontime" | "good_streak" | "week_clean";
/** Ситуация фразы для каждого достижения. */
export const ACHIEVEMENT_SITUATION: Record<Achievement, Situation> = {
  tail: "achieve_tail",
  week_ontime: "achieve_week_ontime",
  good_streak: "good_streak",
  week_clean: "achieve_week_clean",
};

/** «Давнее» = висело больше 7 суток (B6). */
export const TAIL_DAYS = 7;
/** Заметка о хорошей серии — на третьи сутки подряд вовремя; следующая не раньше чем через 7 суток. */
export const GOOD_STREAK_DAYS = 3;
export const GOOD_STREAK_GAP = 7;
export const WEEK_DAYS = 7;

const withAc = (st: StyleState, patch: NonNullable<StyleState["ac"]>): StyleState => ({ ...st, ac: { ...st.ac, ...patch } });

/**
 * «Готово» по главному напоминанию. day — номер суток по поясу хозяина; ageDays — сколько суток дело висело просроченным (0, если вовремя).
 * Возвращает новое состояние и достижение, если оно есть. Особая реплика — не чаще одной в сутки; счётчики при этом всё равно считаются.
 */
export function noteDone(st: StyleState, a: { day: number; onTime: boolean; ageDays: number }): { state: StyleState; achievement: Achievement | null } {
  let s: StyleState = { ...st };
  let grew = false; // серия суток выросла именно сейчас (второе «Готово» за те же сутки её не растит)
  if (a.onTime && st.ot?.d !== a.day) {
    s = { ...s, ot: { d: a.day, n: st.ot && st.ot.d === a.day - 1 ? st.ot.n + 1 : 1 } };
    grew = true;
  }
  const n = s.ot?.n ?? 0;
  const cands: Achievement[] = [];
  if (a.ageDays >= TAIL_DAYS) cands.push("tail");
  if (grew && n === WEEK_DAYS) cands.push("week_ontime");
  if (grew && n === GOOD_STREAK_DAYS && !(s.ac?.gs !== undefined && a.day - s.ac.gs < GOOD_STREAK_GAP)) cands.push("good_streak");
  if (s.ac?.any === a.day) return { state: s, achievement: null };
  const ach = cands[0] ?? null;
  if (!ach) return { state: s, achievement: null };
  const patch: NonNullable<StyleState["ac"]> = { any: a.day };
  if (ach === "good_streak") patch.gs = a.day;
  if (ach === "week_ontime") patch.wk = a.day;
  return { state: withAc(s, patch), achievement: ach };
}

/** Пропуск (дело стало «просрочено»): серия суток обнуляется, «неделя без «Висит»» отсчитывается заново с этого дня. */
export function noteMiss(st: StyleState, day: number): StyleState {
  const { ot: _ot, ...rest } = st;
  return { ...rest, cl: day };
}

/**
 * Наблюдение за «Висит» (утренняя сводка): hot — сколько дел сейчас просрочено. Первое наблюдение — точка отсчёта;
 * «висит» сбрасывает её на сегодня; семь суток чисто — достижение, один раз за такую полосу.
 */
export function observeHot(st: StyleState, a: { day: number; hot: number }): { state: StyleState; achievement: Achievement | null } {
  if (a.hot > 0) return { state: { ...st, cl: a.day }, achievement: null };
  if (st.cl === undefined) return { state: { ...st, cl: a.day }, achievement: null };
  if (a.day - st.cl < WEEK_DAYS || st.ac?.wc === st.cl || st.ac?.any === a.day) return { state: st, achievement: null };
  return { state: withAc(st, { any: a.day, wc: st.cl }), achievement: "week_clean" };
}

// ---------- тяжёлый день: подбодрить цитатой (анкета вкусов, 2026-11-18) ----------

/** «Тяжёлый день»: висит три дела и больше, или в списке двенадцать и больше, или подряд три пропуска и больше. Числа здесь же, чтобы их было видно. */
export const HEAVY = { hot: 3, open: 12, miss: 3 } as const;
/** Подбадривание не чаще одного раза в столько суток: если тяжело долго, цитата не должна стать привычной. */
export const HEAVY_GAP_DAYS = 3;

export function isHeavyDay(a: { open: number; hot?: number; missStreak: number }): boolean {
  return (a.hot ?? 0) >= HEAVY.hot || a.open >= HEAVY.open || a.missStreak >= HEAVY.miss;
}

/** Пора ли подбодрить: прошло ли `HEAVY_GAP_DAYS` суток с прошлого раза (`ac.hd`). */
export const heavyReady = (st: StyleState, day: number): boolean => st.ac?.hd === undefined || day - st.ac.hd >= HEAVY_GAP_DAYS;

/** Запомнить, что подбодрили в сутки day. */
export const markHeavy = (st: StyleState, day: number): StyleState => withAc(st, { hd: day });

// ---------- память реплик: 14 дней ----------

export const RECENT_DAYS = 14;
const RL_MAX = 300;

/** Запомнить, что реплика с отпечатком key прозвучала в сутки day; старше 14 суток и сверх 300 штук забываем. */
export function rememberLine(rl: Record<string, number> | undefined, key: string, day: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, d] of Object.entries(rl ?? {})) if (day - d < RECENT_DAYS) out[k] = d;
  out[key] = day;
  const keys = Object.keys(out);
  if (keys.length > RL_MAX) {
    keys.sort((x, y) => out[x] - out[y]);
    for (const k of keys.slice(0, keys.length - RL_MAX)) delete out[k];
  }
  return out;
}
