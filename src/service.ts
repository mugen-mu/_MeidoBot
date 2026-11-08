// Действия над делами как наборы операций для базы (одна пачка = один подзапрос).
// Здесь нет Discord и нет времени «сейчас»: всё получает аргументами, поэтому легко проверять тестами.
import { type Ladder, type LadderSpec, SINGLE, ladderFromSpec, parseSpec } from "./ladder.ts";
import { type Recipe, leadTime, nextOccurrence } from "./recur.ts";
import type { AppSettings } from "./settings.ts";
import {
  event,
  insertOccurrence,
  insertOccurrenceOnce,
  op,
  updateOcc,
} from "./db/repo.ts";
import { OPEN_STATES, type OccView, type Op, type Source } from "./db/types.ts";
import type { Parsed } from "./time/parse.ts";
import { MINUTE } from "./time/tz.ts";

const OPEN = OPEN_STATES.map((s) => `'${s}'`).join(",");

export interface NewItemInput {
  parsed: Parsed;
  source: Source;
  settings: AppSettings;
  now: number;
  ladder?: LadderSpec | null;
  body?: string | null;
}

/**
 * Создание дела: само дело, правило, главное срабатывание и «заранее».
 * Результаты batch: [0].meta.last_row_id — id дела, [mainIndex].meta.last_row_id — id срабатывания.
 */
export function newItemOps(i: NewItemInput): { ops: Op[]; mainIndex: number } {
  const { parsed, now, settings } = i;
  const ops: Op[] = [
    op(
      `INSERT INTO items (kind, title, body, created_at, source, ladder, critical) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      parsed.timer ? "timer" : "reminder",
      parsed.title,
      i.body ?? null,
      now,
      i.source,
      i.ladder ? JSON.stringify(i.ladder) : null,
      parsed.critical ? 1 : 0,
    ),
  ];
  if (parsed.recipe) {
    ops.push(
      op(
        `INSERT INTO rules (item_id, recipe, tz, lead_days, until_at) VALUES ((SELECT MAX(id) FROM items), ?, ?, ?, ?)`,
        JSON.stringify(parsed.recipe),
        settings.tz,
        parsed.leadDays.length ? JSON.stringify(parsed.leadDays) : null,
        parsed.recipe.until ?? null,
      ),
    );
  }
  const mainIndex = ops.length;
  if (parsed.due === null) {
    ops.push(insertOccurrence(null, { kind: "main", dueAt: null, baseAt: null, state: "draft", nextFireAt: null, createdAt: now }));
  } else {
    ops.push(
      insertOccurrence(null, { kind: "main", dueAt: parsed.due, baseAt: parsed.due, state: "planned", nextFireAt: parsed.due, createdAt: now }),
    );
    ops.push(...leadOps(null, parsed.due, parsed.leadDays, settings.tz, now));
  }
  return { ops, mainIndex };
}

/** Предупреждения «заранее»: только те, чьё время ещё не прошло. */
export function leadOps(itemId: number | null, due: number, leadDays: number[], tz: string, now: number): Op[] {
  const out: Op[] = [];
  for (const n of leadDays) {
    const at = leadTime(due, n, tz);
    if (at <= now) continue;
    const o = { kind: "lead" as const, leadDays: n, dueAt: due, baseAt: at, state: "planned" as const, nextFireAt: at, createdAt: now };
    out.push(itemId === null ? insertOccurrence(null, o) : insertOccurrenceOnce(itemId, o));
  }
  return out;
}

export function ladderFor(occ: OccView, settings: AppSettings): Ladder {
  if (occ.kind === "lead" || occ.item_kind === "timer") return SINGLE;
  return ladderFromSpec(parseSpec(occ.item_ladder) ?? settings.defaultLadder);
}

export function parseRecipe(occ: OccView): Recipe | null {
  if (!occ.rule_recipe) return null;
  try {
    return JSON.parse(occ.rule_recipe) as Recipe;
  } catch {
    return null;
  }
}

/** Следующее срабатывание ряда и его «заранее» — создаётся, когда текущее сработало в первый раз. */
export function nextSeriesOps(occ: OccView, now: number): Op[] {
  if (occ.kind !== "main" || occ.due_at === null) return [];
  const recipe = parseRecipe(occ);
  if (!recipe) return [];
  const tz = occ.rule_tz ?? "Europe/Kyiv";
  const from = occ.item_kind === "timer" ? Math.max(occ.due_at, now) : occ.due_at;
  const next = nextOccurrence(recipe, from, tz);
  if (next === null) return [];
  const ops: Op[] = [
    insertOccurrenceOnce(occ.item_id, { kind: "main", dueAt: next, baseAt: next, state: "planned", nextFireAt: next, createdAt: now }),
  ];
  const leads = occ.rule_leads ? (JSON.parse(occ.rule_leads) as number[]) : [];
  ops.push(...leadOps(occ.item_id, next, leads, tz, now));
  return ops;
}

/** «Готово»: закрывает срабатывание и его «заранее». */
export function doneOps(occ: OccView, now: number, reason = "done"): Op[] {
  const ops = [
    updateOcc(occ.id, { state: "done", closed_at: now, closed_reason: reason, next_fire_at: null, lock_until: null, lock_token: null }),
    event(now, reason === "done" ? "done" : `closed_${reason}`, occ.id),
  ];
  if (occ.kind === "main" && occ.due_at !== null) {
    ops.push(
      op(
        `UPDATE occurrences SET state = 'done', closed_at = ?, closed_reason = 'main_done', next_fire_at = NULL
         WHERE item_id = ? AND kind = 'lead' AND due_at = ? AND state IN (${OPEN})`,
        now, occ.item_id, occ.due_at,
      ),
    );
  }
  return ops;
}

/** Остановить таймер целиком: все открытые срабатывания закрыты, ряд обрывается (новых не будет). */
export function stopSeriesOps(itemId: number, now: number): Op[] {
  return cancelItemOps(itemId, now, "stop");
}

/** Отмена дела целиком (повторяющегося — всей серии). */
export function cancelItemOps(itemId: number, now: number, reason = "cancel"): Op[] {
  return [
    op(
      `UPDATE occurrences SET state = 'cancelled', closed_at = ?, closed_reason = ?, next_fire_at = NULL, lock_until = NULL, lock_token = NULL
       WHERE item_id = ? AND state IN (${OPEN})`,
      now, reason, itemId,
    ),
    op("UPDATE items SET archived_at = ? WHERE id = ?", now, itemId),
    event(now, reason),
  ];
}

/** Отложить на время `target`: лестница считается заново от него, счётчик откладываний растёт. */
export function snoozeOps(occ: OccView, target: number, now: number): Op[] {
  return [
    updateOcc(occ.id, {
      state: "snoozed",
      base_at: target,
      next_fire_at: target,
      fire_count: 0,
      snooze_count: occ.snooze_count + 1,
      lock_until: null,
      lock_token: null,
    }),
    event(now, "snooze", occ.id, `n=${occ.snooze_count + 1}`),
  ];
}

/** Задать (или поменять) срок: черновик становится запланированным, лестница начинается с нуля. */
export function rescheduleOps(occ: OccView, due: number, now: number): Op[] {
  return [
    updateOcc(occ.id, {
      state: "planned",
      due_at: due,
      base_at: due,
      next_fire_at: due,
      fire_count: 0,
      lock_until: null,
      lock_token: null,
    }),
    event(now, "reschedule", occ.id),
  ];
}

export function setLadderOps(itemId: number, spec: LadderSpec | null): Op {
  return op("UPDATE items SET ladder = ? WHERE id = ?", spec ? JSON.stringify(spec) : null, itemId);
}

export function setPlainOps(itemId: number, plain: boolean): Op {
  return op("UPDATE items SET plain = ? WHERE id = ?", plain ? 1 : 0, itemId);
}

export function setTitleOps(itemId: number, title: string): Op {
  return op("UPDATE items SET title = ? WHERE id = ?", title, itemId);
}

/** Стереть текст закрытых дел старше 90 дней: остаются счётчики и даты. */
export function scrubOps(now: number): Op[] {
  const cutoff = now - 90 * 24 * 60 * MINUTE;
  return [
    op(
      `UPDATE items SET title = '(стёрто)', body = NULL, scrubbed_at = ?
       WHERE scrubbed_at IS NULL AND id IN (
         SELECT i.id FROM items i WHERE NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.item_id = i.id AND o.state IN (${OPEN}))
           AND COALESCE((SELECT MAX(closed_at) FROM occurrences o WHERE o.item_id = i.id), i.archived_at, i.created_at) < ?)`,
      now, cutoff,
    ),
    // id прежних копий напоминаний нужны для ответов (Reply) только пока копии могут быть у пользователя на виду
    op("DELETE FROM occ_messages WHERE sent_at < ?", now - 30 * 24 * 60 * MINUTE),
  ];
}
