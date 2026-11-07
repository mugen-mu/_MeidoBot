// Лестница настойчивости: когда бот повторяет напоминание, пока не нажато «Готово».
// Значения по умолчанию — только стартовые; пользователь меняет их в /settings и у каждого дела.
import { MINUTE } from "./time/tz.ts";

export type LadderPreset = "soft" | "standard" | "strong";

/** Хранится в базе (items.ladder, settings.default_ladder). */
export type LadderSpec = { preset: LadderPreset } | { custom: number[] };

export interface Ladder {
  /** минуты от базового времени (срока или времени после откладывания): моменты обычных отправок */
  steps: number[];
  /** через сколько минут от базы наступает «просрочено» */
  overdueAfter: number;
  /** как часто повторять «просрочено» и сколько раз; после этого — только сводки */
  overdueRepeat: number;
  overdueRepeats: number;
}

export const PRESETS: Record<LadderPreset, Ladder> = {
  soft: { steps: [0, 30, 120], overdueAfter: 360, overdueRepeat: 360, overdueRepeats: 2 },
  standard: { steps: [0, 10, 20, 40], overdueAfter: 120, overdueRepeat: 120, overdueRepeats: 3 },
  strong: {
    steps: [0, 5, 10, 15, 20, 30, 45, 60],
    overdueAfter: 90,
    overdueRepeat: 60,
    overdueRepeats: 5,
  },
};

export const PRESET_LABELS: Record<LadderPreset, string> = {
  soft: "мягко",
  standard: "стандартно",
  strong: "настойчиво",
};

/** Один раз, без повторов: интервальные таймеры и «заранее». */
export const SINGLE: Ladder = { steps: [0], overdueAfter: 0, overdueRepeat: 0, overdueRepeats: 0 };

export const DEFAULT_SPEC: LadderSpec = { preset: "standard" };

export function isPreset(s: string): s is LadderPreset {
  return s === "soft" || s === "standard" || s === "strong";
}

/** «0 10 20 40» / «0, 10, 20» -> числа по возрастанию; null, если не годится. */
export function parseCustomSteps(text: string): number[] | null {
  const nums = text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((x) => Number(x));
  if (nums.length === 0 || nums.length > 12) return null;
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 24 * 60)) return null;
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  if (sorted[0] !== 0) sorted.unshift(0); // первое напоминание всегда в срок
  return sorted;
}

export function ladderFromSpec(spec: LadderSpec): Ladder {
  if ("preset" in spec) return PRESETS[spec.preset];
  const steps = spec.custom.length ? spec.custom : PRESETS.standard.steps;
  const last = steps[steps.length - 1];
  return { steps, overdueAfter: last + 60, overdueRepeat: 120, overdueRepeats: 3 };
}

export function parseSpec(json: string | null | undefined): LadderSpec | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object") {
      if (typeof v.preset === "string" && isPreset(v.preset)) return { preset: v.preset };
      if (Array.isArray(v.custom) && v.custom.every((n: unknown) => Number.isFinite(n))) {
        return { custom: v.custom.map(Number) };
      }
    }
  } catch {
    /* повреждённое значение: берём настройку по умолчанию */
  }
  return null;
}

export function describeSpec(spec: LadderSpec): string {
  if ("preset" in spec) return PRESET_LABELS[spec.preset];
  return `свои числа: ${spec.custom.join(", ")} мин`;
}

/** Полное расписание отправок: обычные шаги, затем «просрочено» с повторами (минуты от базы). */
export function schedule(l: Ladder): number[] {
  const out = [...l.steps];
  for (let i = 0; i < l.overdueRepeats; i++) out.push(l.overdueAfter + i * l.overdueRepeat);
  return out;
}

export interface FirePlan {
  /** индекс записи расписания, которую отправляем сейчас */
  index: number;
  phase: "ladder" | "overdue";
  /** какое по счёту обычное напоминание (с 1) или какое «просрочено» (с 1) */
  ordinal: number;
  /** сколько всего обычных шагов */
  total: number;
  /** когда следующая отправка (UTC, мс) или null: дальше только сводки */
  nextAt: number | null;
  /** минут просрочки на момент отправки (для текста) */
  lateMinutes: number;
}

/**
 * Что отправить сейчас. Догонялка: если бот молчал и несколько шагов уже позади,
 * отправляем одно сообщение за самый поздний наступивший шаг, а не серию подряд.
 * `fireCount` — сколько записей расписания уже пройдено.
 */
export function planFire(
  l: Ladder,
  baseAt: number,
  fireCount: number,
  now: number,
): FirePlan | null {
  const sched = schedule(l);
  if (fireCount >= sched.length) return null;
  let j = fireCount;
  while (j + 1 < sched.length && baseAt + sched[j + 1] * MINUTE <= now) j++;
  const phase = j < l.steps.length ? "ladder" : "overdue";
  const next = j + 1 < sched.length ? baseAt + sched[j + 1] * MINUTE : null;
  return {
    index: j,
    phase,
    ordinal: phase === "ladder" ? j + 1 : j - l.steps.length + 1,
    total: l.steps.length,
    nextAt: next,
    lateMinutes: Math.max(0, Math.round((now - baseAt) / MINUTE)),
  };
}

/** Когда в первый раз сработает лестница (для next_fire_at). */
export function firstFireAt(l: Ladder, baseAt: number): number {
  return baseAt + schedule(l)[0] * MINUTE;
}

/** После 3-го откладывания бот спрашивает «сегодня / разбить на шаги / удалить». */
export const SNOOZE_LIMIT = 3;
export function needsSnoozeQuestion(snoozeCountBefore: number): boolean {
  return snoozeCountBefore + 1 >= SNOOZE_LIMIT;
}
