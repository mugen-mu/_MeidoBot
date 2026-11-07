export type OccState = "draft" | "planned" | "fired" | "snoozed" | "overdue" | "done" | "cancelled";
export type ItemKind = "reminder" | "timer" | "note" | "link" | "file";
export type Source = "slash" | "menu" | "dm" | "inbox" | "channel" | "siri" | "share";

/** Состояния «дело ещё открыто». */
export const OPEN_STATES: OccState[] = ["draft", "planned", "fired", "snoozed", "overdue"];
/** Состояния, в которых cron берёт запись в работу. */
export const FIRING_STATES: OccState[] = ["planned", "fired", "snoozed", "overdue"];

export interface Item {
  id: number;
  kind: ItemKind;
  title: string;
  body: string | null;
  category: string | null;
  tags: string | null;
  created_at: number;
  source: Source;
  secret_flag: number;
  secret_note: string | null;
  ladder: string | null;
  critical: number;
  archived_at: number | null;
  scrubbed_at: number | null;
}

export interface Occurrence {
  id: number;
  item_id: number;
  kind: "main" | "lead";
  lead_days: number | null;
  due_at: number | null;
  base_at: number | null;
  state: OccState;
  fire_count: number;
  next_fire_at: number | null;
  snooze_count: number;
  last_message_id: string | null;
  last_channel_id: string | null;
  lock_until: number | null;
  lock_token: string | null;
  created_at: number;
  closed_at: number | null;
  closed_reason: string | null;
}

/** Срабатывание вместе с делом и правилом — то, что нужно cron и обработчику кнопок. */
export interface OccView extends Occurrence {
  title: string;
  item_kind: ItemKind;
  item_body: string | null;
  item_ladder: string | null;
  critical: number;
  secret_flag: number;
  rule_recipe: string | null;
  rule_tz: string | null;
  rule_leads: string | null;
}

export interface Op {
  sql: string;
  params: unknown[];
}
