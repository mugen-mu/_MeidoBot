// Этап 3 ретроспективы 2: хвост «Висит» и автозаморозка. Чистая логика без базы, Discord и «сейчас» (всё приходит аргументами).
//  • «давнее» — «висит» больше 7 дней (B6); «давность» считаем от последнего касания: срока (или времени после «отложить») и нажатий хозяина;
//  • заморозка (B7): 30 дней без единого нажатия; критичные дела (пробивают тихие часы) не замораживаются;
//  • «сколько висит» по будням — раз в 1–3 дня, интервал зависит от даты (B8).
// Случайность здесь только в тексте сводок: времени самих напоминаний она не касается.
import type { OccView } from "./db/types.ts";
import { hash01 } from "./personality/day.ts";

const DAY_MS = 86_400_000;

/** «Давнее» — висит больше стольких суток (B6). */
export const TAIL_DAYS = 7;
/** Заморозка — столько суток без единого нажатия по делу (B7). */
export const FREEZE_DAYS = 30;
/** Предупреждение в субботнем разборе: дела, которые заморозятся до следующей субботы (30 − 7). */
export const WARN_FROM_DAYS = FREEZE_DAYS - 7;

type Hang = Pick<OccView, "kind" | "state" | "item_kind" | "critical" | "due_at" | "base_at" | "touched_at" | "created_at">;

/** Сколько суток дело ничего не получало: с последнего из — срок (после «отложить» — новое время), нажатие хозяина. Без срока — от создания. */
export function idleDays(o: Hang, now: number): number {
  const last = Math.max(o.touched_at ?? 0, o.base_at ?? o.due_at ?? o.created_at);
  return Math.max(0, (now - last) / DAY_MS);
}

/** Висящее главное дело-напоминание: просрочено (таймеры, «заранее» и отложенное — нет). */
const hanging = (o: Hang): boolean => o.kind === "main" && o.state === "overdue" && o.item_kind === "reminder";

/** «Давнее»: висит больше 7 суток. */
export const isTail = (o: Hang, now: number): boolean => hanging(o) && idleDays(o, now) > TAIL_DAYS;

/** Можно замораживать: давнее, 30+ суток без касаний, не критичное. */
export const isFreezable = (o: Hang, now: number): boolean => hanging(o) && !o.critical && idleDays(o, now) >= FREEZE_DAYS;

export const freezeCandidates = <T extends Hang>(items: T[], now: number): T[] => items.filter((o) => isFreezable(o, now));

/** Заморозятся до следующей субботы (23–30 суток без касаний): про них субботний разбор предупреждает. */
export const soonFrozen = <T extends Hang>(items: T[], now: number): T[] =>
  items.filter((o) => hanging(o) && !o.critical && idleDays(o, now) >= WARN_FROM_DAYS && idleDays(o, now) < FREEZE_DAYS);

/** Интервал «сколько висит» по будням: от 1 до 3 суток, зависит от даты — повторный запуск того же дня даёт то же. */
export const tailInterval = (dayKey: string): number => 1 + Math.floor(hash01("tail", dayKey) * 3);

/** Пора ли сегодня сказать «сколько висит давнего»: прошло не меньше интервала с прошлого раза (или раньше не говорили). */
export function shouldNoteTail(dayKey: string, lastDay: string | undefined): boolean {
  if (!lastDay) return true;
  const gap = (Date.parse(`${dayKey}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`)) / DAY_MS;
  return Number.isFinite(gap) && gap >= tailInterval(dayKey);
}
