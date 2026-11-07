// Движок настроения: чистая логика без базы, Discord и «сейчас» (всё приходит аргументами).
// Принимает событие и возвращает новое состояние: так его легко проверять тестами (ТЗ, раздел 11).
// Спад раздражения и симпатии считается при следующем событии, cron для этого не нужен.
import { MOOD_CONFIG, type MoodConfig } from "./config.ts";

export type Mood = "tired" | "tsundere" | "yandere" | "sulking" | "proud" | "sleepy";
export const MOODS: Mood[] = ["tired", "tsundere", "yandere", "sulking", "proud", "sleepy"];
export const isMood = (v: unknown): v is Mood => typeof v === "string" && (MOODS as string[]).includes(v);

const HOUR = 3_600_000;
const MINUTE = 60_000;

export interface MoodState {
  affection: number;
  irritation: number;
  missStreak: number;
  doneStreak: number;
  /** последнее действие пользователя, мс */
  lastActivity: number;
  mood: Mood;
  moodSince: number;
  /** до какого момента посчитан спад чисел, мс */
  updatedAt: number;
  /** сколько раздражения уже набежало за молчание (сбрасывается при активности) */
  idlePenalty: number;
  /** отпечатки последних фраз (не повторять) */
  recent: string[];
  lastDramaAt: number | null;
  /** после яндере выполнено дело: выходить можно, но через tsundere */
  yandereCleared: boolean;
}

/** Окружение момента: время и «ночь ли в этот миг» (зависит от пояса пользователя и его настроек). */
export interface MoodCtx {
  now: number;
  isNight: (ms: number) => boolean;
}

export type MoodEvent =
  | { type: "done"; onTime: boolean }
  | { type: "miss" }
  | { type: "activity"; polite?: boolean; /** прибавка симпатии за аниме-слово хозяина (решает вызывающий: раз в час) */ bonus?: number }
  | { type: "tick" };

export interface MoodChange {
  from: Mood;
  to: Mood;
  reason: string;
}

export interface StepResult {
  state: MoodState;
  change: MoodChange | null;
  /** пользователь вернулся после паузы дольше returnAfterHours (один раз) */
  returned: boolean;
  /** серия выполненных подряд достигла отметки для особой похвалы */
  milestone: number | null;
  /** дело выполнено, и настроение сменилось с яндере/tsundere (похвала «ну наконец-то») */
  relief: boolean;
}

export const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));

export function initialState(now: number, cfg: MoodConfig = MOOD_CONFIG): MoodState {
  return {
    affection: cfg.start.affection,
    irritation: cfg.start.irritation,
    missStreak: 0,
    doneStreak: 0,
    lastActivity: now,
    mood: "tired",
    moodSince: now - cfg.minHoldMinutes * MINUTE, // у нового состояния «удержания» нет: первое же событие может сменить настроение
    updatedAt: now,
    idlePenalty: 0,
    recent: [],
    lastDramaAt: null,
    yandereCleared: false,
  };
}

/** Сколько ДНЕВНЫХ часов (не ночных) прошло между двумя моментами: ночь молчанием не считается. */
export function daytimeHours(from: number, to: number, isNight: (ms: number) => boolean): number {
  if (to <= from) return 0;
  const maxSteps = 24 * 21; // три недели молчания дальше не считаем: всё равно потолок
  let n = 0;
  let steps = 0;
  for (let t = from; t < to && steps < maxSteps; t += HOUR, steps++) {
    const slice = Math.min(HOUR, to - t);
    if (!isNight(t)) n += slice / HOUR;
  }
  return n;
}

/** Спад со временем и набежавшее за молчание раздражение. Новое состояние, старое не меняется. */
export function settle(st: MoodState, ctx: MoodCtx, cfg: MoodConfig = MOOD_CONFIG): MoodState {
  const s = { ...st, recent: [...st.recent] };
  const dt = Math.max(0, ctx.now - s.updatedAt) / HOUR;
  if (dt > 0) {
    s.irritation = clamp(s.irritation - cfg.irritationDecayPerHour * dt);
    const toNeutral = cfg.neutralAffection - s.affection;
    const drift = Math.min(Math.abs(toNeutral), cfg.affectionDriftPerHour * dt);
    s.affection = clamp(s.affection + Math.sign(toNeutral) * drift);
    s.updatedAt = ctx.now;
  }
  const quietH = daytimeHours(s.lastActivity, ctx.now, ctx.isNight);
  const target = Math.min(cfg.idleCap, Math.floor(quietH / cfg.idleStepHours) * cfg.idleIrritation);
  if (target > s.idlePenalty) {
    s.irritation = clamp(s.irritation + (target - s.idlePenalty));
    s.idlePenalty = target;
  }
  // яндере само успокаивается, если давно не было новых пропусков: снимаем потолок «пропусков и раздражения», дальше выход через tsundere
  if (s.mood === "yandere" && ctx.now - s.moodSince >= cfg.yandereCalmHours * HOUR) {
    s.missStreak = Math.min(s.missStreak, cfg.thresholds.yandereMiss - 1);
    s.irritation = Math.min(s.irritation, cfg.thresholds.yandereIrritation - 1);
  }
  return s;
}

/** Какое настроение подходит числам (раздел 5, сверху вниз; защиту от дёргания добавляет resolveMood). */
export function candidateMood(st: MoodState, ctx: MoodCtx, cfg: MoodConfig = MOOD_CONFIG): Mood {
  const t = cfg.thresholds;
  if (st.missStreak >= t.yandereMiss || st.irritation >= t.yandereIrritation) return "yandere";
  if (st.missStreak >= t.tsundereMiss || st.irritation >= t.tsundereIrritation) return "tsundere";
  if (daytimeHours(st.lastActivity, ctx.now, ctx.isNight) > t.sulkingSilenceHours && !ctx.isNight(ctx.now)) return "sulking";
  if (st.doneStreak >= t.proudDoneStreak && st.affection >= t.proudAffection) return "proud";
  if (ctx.isNight(ctx.now)) return "sleepy";
  return "tired";
}

/** Настроение с защитой от дёргания: 30 минут держим новое, в яндере — сразу, из яндере — только после «Готово» и через tsundere. */
export function resolveMood(st: MoodState, ctx: MoodCtx, cfg: MoodConfig = MOOD_CONFIG): { mood: Mood; reason: string | null } {
  const cand = candidateMood(st, ctx, cfg);
  if (cand === st.mood) return { mood: st.mood, reason: null };
  if (cand === "yandere") return { mood: "yandere", reason: "пропусков или раздражения достаточно" };
  if (st.mood === "yandere") {
    if (st.yandereCleared) return { mood: "tsundere", reason: "дело выполнено: из яндере через tsundere" };
    if (ctx.now - st.moodSince >= cfg.yandereCalmHours * HOUR) return { mood: "tsundere", reason: "яндере успокоилась сама" };
    return { mood: "yandere", reason: null };
  }
  if (ctx.now - st.moodSince < cfg.minHoldMinutes * MINUTE) return { mood: st.mood, reason: null };
  return { mood: cand, reason: "числа и время подходят новому настроению" };
}

/** Применить событие: спад → изменение чисел → выбор настроения. */
export function step(prev: MoodState, ev: MoodEvent, ctx: MoodCtx, cfg: MoodConfig = MOOD_CONFIG): StepResult {
  const gap = ctx.now - prev.lastActivity; // до settle: молчание, которое было до этого события
  const s = settle(prev, ctx, cfg);
  let returned = false;
  let milestone: number | null = null;
  let clearedNow = false;

  const bump = (d: { affection?: number; irritation?: number }) => {
    s.affection = clamp(s.affection + (d.affection ?? 0));
    s.irritation = clamp(s.irritation + (d.irritation ?? 0));
  };
  const touch = () => {
    if (gap > cfg.returnAfterHours * HOUR) {
      returned = true;
      bump({ affection: cfg.events.returnAfterPause.affection });
    }
    s.lastActivity = ctx.now;
    s.idlePenalty = 0;
  };

  switch (ev.type) {
    case "miss":
      s.missStreak += 1;
      s.doneStreak = 0;
      s.yandereCleared = false;
      if (s.mood === "yandere") s.moodSince = ctx.now; // новый пропуск продлевает яндере: «успокоиться» она сможет через сутки после последнего
      bump(cfg.events.miss);
      break;
    case "done":
      touch();
      if (ev.onTime) {
        s.doneStreak += 1;
        bump(cfg.events.doneOnTime);
        if (cfg.praiseStreaks.includes(s.doneStreak)) milestone = s.doneStreak;
      } else {
        bump(cfg.events.doneLate);
      }
      s.missStreak = 0;
      if (s.mood === "yandere") {
        s.yandereCleared = true;
        clearedNow = true;
      }
      break;
    case "activity":
      touch();
      if (ev.polite) bump(cfg.events.polite);
      if (ev.bonus) bump({ affection: ev.bonus });
      break;
    case "tick":
      break;
  }

  const r = resolveMood(s, ctx, cfg);
  let change: MoodChange | null = null;
  if (r.mood !== s.mood) {
    change = { from: s.mood, to: r.mood, reason: `${r.reason ?? "?"} [${ev.type}]` };
    s.mood = r.mood;
    s.moodSince = ctx.now;
    if (r.mood !== "yandere") s.yandereCleared = false;
  }
  const relief =
    ev.type === "done" && (clearedNow || (change !== null && (change.from === "yandere" || change.from === "tsundere"))) && s.mood !== "yandere";
  return { state: s, change, returned, milestone, relief };
}

/** Принудительно задать настроение (для /mood set): числа подгоняются, чтобы настроение не слетело при первом же событии. */
export function forceMood(st: MoodState, mood: Mood, now: number, cfg: MoodConfig = MOOD_CONFIG): MoodState {
  const s = { ...st, recent: [...st.recent], mood, moodSince: now, updatedAt: now, yandereCleared: false };
  const t = cfg.thresholds;
  switch (mood) {
    case "yandere":
      s.missStreak = Math.max(s.missStreak, t.yandereMiss);
      break;
    case "tsundere":
      s.missStreak = Math.min(Math.max(s.missStreak, t.tsundereMiss), t.yandereMiss - 1);
      s.irritation = Math.min(s.irritation, t.yandereIrritation - 1);
      break;
    case "sulking":
      s.missStreak = 0;
      s.irritation = Math.min(s.irritation, t.tsundereIrritation - 1);
      s.lastActivity = now - (t.sulkingSilenceHours + 1) * HOUR * 2; // дневные часы считаются, ночь нет
      break;
    case "proud":
      s.missStreak = 0;
      s.irritation = Math.min(s.irritation, t.tsundereIrritation - 1);
      s.doneStreak = Math.max(s.doneStreak, t.proudDoneStreak);
      s.affection = Math.max(s.affection, t.proudAffection);
      break;
    default:
      s.missStreak = 0;
      s.irritation = Math.min(s.irritation, t.tsundereIrritation - 1);
      s.doneStreak = Math.min(s.doneStreak, t.proudDoneStreak - 1);
  }
  return s;
}

/** Состояние к моменту now без события: спад и пересчёт настроения (для /mood и перед выбором фразы). */
export function peek(prev: MoodState, ctx: MoodCtx, cfg: MoodConfig = MOOD_CONFIG): StepResult {
  return step(prev, { type: "tick" }, ctx, cfg);
}

// ---------- вежливость ----------

const POLITE = /(спасибо|благодарю|молодец|умница|умничка|красава|хорошая работа|good bot|thanks|thank you)/i;

/** Короткое вежливое сообщение горничной («спасибо», «молодец»). Длинный текст про дело вежливостью не считаем. */
export function isPolite(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 60 && POLITE.test(t);
}

// ---------- серьёзные темы ----------

const SERIOUS = /(врач|доктор|лекарств|таблетк|больниц|поликлиник|анализ|давлени|скор(ая|ую) помощ|похорон|операци|диагноз|лечени|терапевт|стоматолог|прививк|укол|реанимац|онколог|кардиолог|психолог|психиатр)/i;

/** Серьёзная тема: стиль выключается, остаётся обычный нейтральный текст. */
export function isSeriousTopic(title: string): boolean {
  return SERIOUS.test(title);
}

// ---------- описание для /mood ----------

export const MOOD_LABELS: Record<Mood, string> = {
  tired: "устала (обычный рабочий день)",
  tsundere: "цундере (ворчит, но заботится)",
  yandere: "яндере (приторно-жуткая, понарошку)",
  sulking: "обижена (долго не было вестей)",
  proud: "гордится вами (редкая мягкость)",
  sleepy: "сонная (ночь)",
};

export function affectionLabel(a: number): string {
  if (a >= 85) return "обожает (и сама этого стесняется)";
  if (a >= 70) return "хорошее, но она этого не скажет";
  if (a >= 55) return "тёплое, почти";
  if (a >= 45) return "ровное, рабочее";
  if (a >= 30) return "прохладное";
  if (a >= 15) return "ниже плинтуса";
  return "глубоко под плинтусом";
}

export function irritationLabel(i: number): string {
  if (i >= 80) return "кипит (тихо, с улыбкой)";
  if (i >= 60) return "сильно раздражена";
  if (i >= 40) return "ворчит";
  if (i >= 20) return "слегка недовольна";
  return "спокойна";
}
