// Ответ (Reply) пользователя на сообщение-напоминание обычным текстом:
// «через 2 мин», «на час», «завтра в 10», «готово». Действует на то дело, к чьему сообщению привязан ответ.
import type { Repo } from "./db/repo.ts";
import { OPEN_STATES, type OccView, type Op } from "./db/types.ts";
import type { DiscordApi, IncomingMessage, MessageBody } from "./discord/types.ts";
import { messageTime } from "./intake.ts";
import { doneMessage, snoozedMessage } from "./discord/ui.ts";
import { doneOps, rescheduleOps, snoozeOps } from "./service.ts";
import type { AppSettings } from "./settings.ts";
import { formatWhen } from "./time/format.ts";
import { parseWhen } from "./time/parse.ts";

export type ReplyAction = { kind: "done" } | { kind: "snooze"; due: number } | { kind: "past" } | { kind: "unknown" };

const DONE_RX = /^(?:напомни\s+)?(?:готово|сделано|сделал[аи]?|выполнено|закрыть|закрой|done)$/u;
// «на час», «на 15 минут», «отложи на полчаса» -> «через …» (время «на 18:30» сюда не попадает)
const ON_DURATION_RX = /^(?:(?:отложи(?:ть)?|перенеси(?:ть)?|напомни)\s+)?на\s+((?:\d+(?:[.,]\d+)?|час|полчаса|полтора\s+часа)(?:\s*(?:мин\S*|час\S*|ч|дн\S*|день|сутки|нед\S*))?)$/u;

function normalize(raw: string): string {
  let t = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!…]+$/u, "");
  const m = ON_DURATION_RX.exec(t);
  if (m) t = `через ${m[1]}`;
  return t.replace(/\bполчаса\b/u, "30 минут").replace(/\bполтора\s+часа\b/u, "90 минут");
}

/** Что хотел сказать ответ. `at` — время отправки сообщения (от него считается «через 2 мин»). */
export function parseReply(text: string, ctx: { at: number; tz: string; defaultTime: number }): ReplyAction {
  const t = normalize(text);
  if (DONE_RX.test(t)) return { kind: "done" };
  const w = parseWhen(t, { now: ctx.at, tz: ctx.tz, defaultTime: ctx.defaultTime });
  if (!w) return { kind: "unknown" };
  return w.past ? { kind: "past" } : { kind: "snooze", due: w.due };
}

export const REPLY_UNKNOWN = "Не понял. Ответьте, например, «через 15 минут», «на час», «завтра 10:30» или «готово».";
export const REPLY_PAST = "Это время уже прошло. Ответьте, например, «через 15 минут» или «завтра 10:30».";
export const REPLY_CLOSED = "Это дело уже закрыто.";

export interface ReplyResult {
  ops: Op[];
  /** во что превратить живое сообщение дела (как после нажатия кнопки) */
  edit: MessageBody | null;
  /** короткий ответ боту в канал */
  text: string;
}

export function applyReply(occ: OccView, action: ReplyAction, s: AppSettings, now: number): ReplyResult {
  if (!OPEN_STATES.includes(occ.state)) return { ops: [], edit: null, text: REPLY_CLOSED };
  switch (action.kind) {
    case "done":
      return { ops: doneOps(occ, now), edit: doneMessage(occ.title, s.character, occ.id), text: `Готово: **${occ.title}**.` };
    case "snooze": {
      const whenText = formatWhen(action.due, now, s.tz);
      const draft = occ.state === "draft";
      return {
        ops: draft ? rescheduleOps(occ, action.due, now) : snoozeOps(occ, action.due, now),
        edit: draft ? null : snoozedMessage({ occId: occ.id, title: occ.title, whenText, itemId: occ.item_id }),
        text: `Отложено: **${occ.title}**. Напомню: ${whenText}.`,
      };
    }
    case "past":
      return { ops: [], edit: null, text: REPLY_PAST };
    default:
      return { ops: [], edit: null, text: REPLY_UNKNOWN };
  }
}

/**
 * Обработать сообщение хозяина из канала напоминаний. Ответ не на напоминание (нет ссылки или ссылка
 * на сообщение, которое не от дела) — молча пропускаем. Тратит до 4 подзапросов.
 */
export async function handleReply(
  d: { repo: Repo; api: DiscordApi; s: AppSettings; now: number },
  m: IncomingMessage,
  channelId: string,
): Promise<"handled" | "ignored"> {
  const refId = m.message_reference?.message_id;
  if (!refId || !m.content.trim()) return "ignored";
  const occ = await d.repo.occByMessageId(refId);
  if (!occ) return "ignored";
  const action = parseReply(m.content, { at: messageTime(m, d.now), tz: d.s.tz, defaultTime: d.s.defaultTime });
  const res = applyReply(occ, action, d.s, d.now);
  if (res.ops.length) await d.repo.exec(res.ops);
  if (res.edit && occ.last_message_id && occ.last_channel_id) {
    try {
      await d.api.editMessage(occ.last_channel_id, occ.last_message_id, res.edit);
    } catch {
      /* сообщения уже нет: не страшно */
    }
  }
  try {
    await d.api.postMessage(channelId, {
      content: res.text,
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: m.id, fail_if_not_exists: false },
    });
  } catch {
    /* не вышло ответить: дело всё равно обновлено */
  }
  return "handled";
}
