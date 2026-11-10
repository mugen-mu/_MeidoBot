// Слой базы под Cloudflare D1. Каждый вызов Repo = один подзапрос (batch из нескольких операторов тоже один):
// на бесплатном плане за один запуск Worker можно сделать всего 50 подзапросов, считаем их счётчиком.
import { type AppSettings, readSettings } from "../settings.ts";
import { FIRING_STATES, type Item, type OccView, OPEN_STATES, type Op } from "./types.ts";

export class BudgetExceeded extends Error {
  constructor() {
    super("лимит подзапросов за запуск исчерпан");
  }
}

export class Counter {
  used = 0;
  readonly limit: number;
  constructor(limit = 1000) {
    this.limit = limit;
  }
  remaining(): number {
    return this.limit - this.used;
  }
  can(n = 1): boolean {
    return this.used + n <= this.limit;
  }
  spend(n = 1): void {
    if (!this.can(n)) throw new BudgetExceeded();
    this.used += n;
  }
}

export const op = (sql: string, ...params: unknown[]): Op => ({ sql, params });

const inList = (xs: string[]) => xs.map((s) => `'${s}'`).join(",");
const OPEN = inList(OPEN_STATES);
const FIRING = inList(FIRING_STATES);

const OCC_VIEW_SELECT = `
  SELECT o.*, i.title AS title, i.kind AS item_kind, i.body AS item_body, i.ladder AS item_ladder,
         i.critical AS critical, i.plain AS plain, i.secret_flag AS secret_flag,
         r.recipe AS rule_recipe, r.tz AS rule_tz, r.lead_days AS rule_leads
  FROM occurrences o
  JOIN items i ON i.id = o.item_id
  LEFT JOIN rules r ON r.item_id = o.item_id`;

export interface Prelude {
  settings: AppSettings;
  meta: Map<string, string>;
  claimed: OccView[];
  /** открытые срабатывания таймеров с сообщением: при новом срабатывании их сообщения удаляем */
  timerOpen: { id: number; item_id: number; last_message_id: string; last_channel_id: string }[];
}

export class Repo {
  readonly db: D1Database;
  readonly counter: Counter;
  constructor(db: D1Database, counter = new Counter()) {
    this.db = db;
    this.counter = counter;
  }

  /** Одна пачка операций (один подзапрос). Результаты — в порядке операторов. */
  async exec(ops: Op[]): Promise<D1Result[]> {
    if (ops.length === 0) return [];
    this.counter.spend(1);
    return this.db.batch(ops.map((o) => this.db.prepare(o.sql).bind(...o.params.map(norm))));
  }

  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    this.counter.spend(1);
    const r = await this.db.prepare(sql).bind(...params.map(norm)).all<T>();
    return r.results ?? [];
  }

  async first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    this.counter.spend(1);
    return (await this.db.prepare(sql).bind(...params.map(norm)).first<T>()) ?? null;
  }

  // ---------- чтение для обработчиков ----------

  getOcc(id: number): Promise<OccView | null> {
    return this.first<OccView>(`${OCC_VIEW_SELECT} WHERE o.id = ?`, id);
  }

  /** Дело по id сообщения-напоминания: актуальному или одной из прежних копий (ответ мог прийти на удалённую). */
  occByMessageId(messageId: string): Promise<OccView | null> {
    return this.first<OccView>(
      `${OCC_VIEW_SELECT} WHERE o.id = COALESCE(
         (SELECT occ_id FROM occ_messages WHERE message_id = ?),
         (SELECT id FROM occurrences WHERE last_message_id = ? LIMIT 1))`,
      messageId, messageId,
    );
  }

  getItem(id: number): Promise<Item | null> {
    return this.first<Item>("SELECT * FROM items WHERE id = ?", id);
  }

  /**
   * Последние разные по названию дела (для «Добавить» с кнопками недавних, этап 1 ретроспективы 2): без удалённых,
   * без стёртых (старше 90 дней), без таймеров; повтор названия показываем один раз — самым свежим делом.
   */
  async recentItems(n: number): Promise<{ id: number; title: string }[]> {
    const rows = await this.all<{ id: number; title: string }>(
      "SELECT id, title FROM items WHERE archived_at IS NULL AND scrubbed_at IS NULL AND secret_flag = 0 AND kind = 'reminder' ORDER BY id DESC LIMIT 40",
    );
    const seen = new Set<string>();
    const out: { id: number; title: string }[] = [];
    for (const r of rows) {
      const key = r.title.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: r.id, title: r.title });
      if (out.length >= n) break;
    }
    return out;
  }

  /** Главное срабатывание дела, которое ещё открыто (для /snooze и /cancel по номеру дела). */
  openMainOfItem(itemId: number): Promise<OccView | null> {
    return this.first<OccView>(
      `${OCC_VIEW_SELECT} WHERE o.item_id = ? AND o.kind = 'main' AND o.state IN (${OPEN})
       ORDER BY CASE o.state WHEN 'overdue' THEN 0 WHEN 'fired' THEN 1 ELSE 2 END, o.due_at LIMIT 1`,
      itemId,
    );
  }

  /** Открытые дела для /list, панели «Горит» и сводок (только главные срабатывания). */
  async openMain(limit = 50): Promise<OccView[]> {
    return this.all<OccView>(
      `${OCC_VIEW_SELECT} WHERE o.kind = 'main' AND o.state IN (${OPEN}) AND i.archived_at IS NULL
       ORDER BY CASE o.state WHEN 'overdue' THEN 0 WHEN 'fired' THEN 1 WHEN 'snoozed' THEN 2 WHEN 'planned' THEN 3 ELSE 4 END,
                o.due_at IS NULL, o.due_at LIMIT ?`,
      limit,
    );
  }

  /** Настройки и служебные значения одним подзапросом. */
  async loadConfig(): Promise<{ settings: AppSettings; meta: Map<string, string> }> {
    const [s, m] = await this.exec([op("SELECT key, value FROM settings"), op("SELECT key, value FROM meta")]);
    return {
      settings: readSettings((s.results ?? []) as { key: string; value: string }[]),
      meta: new Map(((m.results ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value])),
    };
  }

  /**
   * Начало запуска cron одним подзапросом: отметка «жив», настройки, служебные значения,
   * захват созревших срабатываний замком и открытые срабатывания таймеров.
   */
  async prelude(now: number, limit: number, token: string, lockMs = 120_000): Promise<Prelude> {
    const res = await this.exec([
      op("INSERT INTO meta (key, value) VALUES ('alive_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(now)),
      op("SELECT key, value FROM settings"),
      op("SELECT key, value FROM meta"),
      op(
        `UPDATE occurrences SET lock_until = ?, lock_token = ?
         WHERE id IN (
           SELECT o.id FROM occurrences o JOIN items i ON i.id = o.item_id
           WHERE o.next_fire_at IS NOT NULL AND o.next_fire_at <= ? AND o.state IN (${FIRING})
             AND (o.lock_until IS NULL OR o.lock_until <= ?)
           ORDER BY i.critical DESC, o.next_fire_at ASC LIMIT ?)`,
        now + lockMs, token, now, now, limit,
      ),
      op(`${OCC_VIEW_SELECT} WHERE o.lock_token = ? AND o.lock_until > ? ORDER BY critical DESC, o.next_fire_at ASC`, token, now),
      op(
        `SELECT o.id, o.item_id, o.last_message_id, o.last_channel_id FROM occurrences o JOIN items i ON i.id = o.item_id
         WHERE i.kind = 'timer' AND o.state = 'fired' AND o.last_message_id IS NOT NULL`,
      ),
    ]);
    return {
      settings: readSettings((res[1].results ?? []) as { key: string; value: string }[]),
      meta: new Map(((res[2].results ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value])),
      claimed: (res[4].results ?? []) as OccView[],
      timerOpen: (res[5].results ?? []) as Prelude["timerOpen"],
    };
  }
}

/** D1 не принимает undefined и boolean. */
function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

// ---------- построители операций (чистые функции) ----------

export const setSetting = (key: string, value: string): Op =>
  op("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);

export const setMeta = (key: string, value: string): Op =>
  op("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);

export const deleteMeta = (key: string): Op => op("DELETE FROM meta WHERE key = ?", key);

/** Запомнить id отправленной копии напоминания: ответ (Reply) на неё найдёт дело, даже когда копию заменят новой. */
export const rememberMessage = (messageId: string, channelId: string, occId: number, now: number): Op =>
  op("INSERT OR REPLACE INTO occ_messages (message_id, channel_id, occ_id, sent_at) VALUES (?, ?, ?, ?)", messageId, channelId, occId, now);

/** Событие в журнал: только служебные подробности, никогда текст дела. */
export const event = (now: number, kind: string, occId: number | null = null, detail: string | null = null): Op =>
  op("INSERT INTO events (at, kind, occ_id, detail) VALUES (?, ?, ?, ?)", now, kind, occId, detail);

const OCC_COLUMNS = new Set([
  "due_at", "base_at", "state", "fire_count", "next_fire_at", "snooze_count", "last_message_id", "last_channel_id",
  "lock_until", "lock_token", "closed_at", "closed_reason",
]);

export function updateOcc(id: number, patch: Record<string, unknown>): Op {
  const keys = Object.keys(patch);
  for (const k of keys) if (!OCC_COLUMNS.has(k)) throw new Error(`updateOcc: неизвестная колонка ${k}`);
  return op(`UPDATE occurrences SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
}

export const releaseLocks = (token: string): Op =>
  op("UPDATE occurrences SET lock_until = NULL, lock_token = NULL WHERE lock_token = ?", token);

export interface NewOccurrence {
  kind: "main" | "lead";
  leadDays?: number | null;
  dueAt: number | null;
  baseAt: number | null;
  state: "draft" | "planned";
  nextFireAt: number | null;
  createdAt: number;
}

/** itemId = null: берём последнее добавленное дело (для пачки «создать дело и его срабатывания»). */
export function insertOccurrence(itemId: number | null, o: NewOccurrence): Op {
  const ref = itemId === null ? "(SELECT MAX(id) FROM items)" : "?";
  return op(
    `INSERT INTO occurrences (item_id, kind, lead_days, due_at, base_at, state, next_fire_at, created_at)
     VALUES (${ref}, ?, ?, ?, ?, ?, ?, ?)`,
    ...(itemId === null ? [] : [itemId]),
    o.kind, o.leadDays ?? null, o.dueAt, o.baseAt, o.state, o.nextFireAt, o.createdAt,
  );
}

/** Следующее срабатывание ряда, если такого (дело, срок) ещё нет. */
export function insertOccurrenceOnce(itemId: number, o: NewOccurrence): Op {
  return op(
    `INSERT INTO occurrences (item_id, kind, lead_days, due_at, base_at, state, next_fire_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM occurrences WHERE item_id = ? AND kind = ? AND due_at = ? AND COALESCE(lead_days, 0) = ?)`,
    itemId, o.kind, o.leadDays ?? null, o.dueAt, o.baseAt, o.state, o.nextFireAt, o.createdAt,
    itemId, o.kind, o.dueAt, o.leadDays ?? 0,
  );
}
