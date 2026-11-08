// Ответ (Reply) пользователя на сообщение-напоминание обычным текстом:
// «через 2 мин», «на час», «завтра в 10», «готово». Действует на то дело, к чьему сообщению привязан ответ.
import type { Repo } from "./db/repo.ts";
import { OPEN_STATES, type OccView, type Op } from "./db/types.ts";
import type { DiscordApi, IncomingMessage, MessageBody } from "./discord/types.ts";
import { messageTime } from "./intake.ts";
import { doneMessage, plainMessage, snoozedMessage } from "./discord/ui.ts";
import { type MoodSession, recordDone } from "./personality/director.ts";
import { cancelItemOps, doneOps, rescheduleOps, snoozeOps } from "./service.ts";
import type { AppSettings } from "./settings.ts";
import { formatWhen } from "./time/format.ts";
import { parseWhen } from "./time/parse.ts";

export type ReplyAction = { kind: "done" } | { kind: "cancel" } | { kind: "snooze"; due: number } | { kind: "past" } | { kind: "unknown" };

const DONE_RX = /^(?:напомни\s+)?(?:готово|сделано|сделал[аи]?|выполнено|закрыть|закрой|done)$/u;
const CANCEL_RX = /^(?:отмени(?:ть|те)?|отмена|удали(?:ть|те)?|не\s+надо|не\s+нужно|cancel)(?:\s+(?:это|дело|его|её))?$/u;
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
  if (CANCEL_RX.test(t)) return { kind: "cancel" };
  const w = parseWhen(t, { now: ctx.at, tz: ctx.tz, defaultTime: ctx.defaultTime });
  if (!w) return { kind: "unknown" };
  return w.past ? { kind: "past" } : { kind: "snooze", due: w.due };
}

export const REPLY_UNKNOWN = "Не понял. Ответьте, например, «через 15 минут», «на час», «завтра 10:30», «готово» или «отмени».";
export const REPLY_PAST = "Это время уже прошло. Ответьте, например, «через 15 минут» или «завтра 10:30».";
export const REPLY_CLOSED = "Это дело уже закрыто.";

export interface ReplyResult {
  ops: Op[];
  /** во что превратить живое сообщение дела (как после нажатия кнопки) */
  edit: MessageBody | null;
  /** короткий ответ боту в канал */
  text: string;
}

export function applyReply(occ: OccView, action: ReplyAction, s: AppSettings, now: number, doneLine: string | null = null): ReplyResult {
  if (!OPEN_STATES.includes(occ.state)) return { ops: [], edit: null, text: REPLY_CLOSED };
  switch (action.kind) {
    case "done":
      return { ops: doneOps(occ, now), edit: doneMessage(occ.title, s.character, occ.id, doneLine), text: `Готово: **${occ.title}**.` };
    case "cancel":
      return { ops: cancelItemOps(occ.item_id, now), edit: plainMessage(`Отменено: ${occ.title}`), text: `Отменено: **${occ.title}**.` };
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
 * на сообщение, которое не от дела) — молча пропускаем. Тратит до 5 подзапросов.
 */
export async function handleReply(
  d: { repo: Repo; api: DiscordApi; s: AppSettings; now: number; mood?: MoodSession | null },
  m: IncomingMessage,
  channelId: string,
): Promise<"handled" | "ignored"> {
  const refId = m.message_reference?.message_id;
  if (!refId || !m.content.trim()) return "ignored";
  // сначала по запомненному сообщению; иначе — по номеру «#9» в тексте сообщения бота (старые «Записано», ответы на команды)
  let occ = await d.repo.occByMessageId(refId);
  if (!occ) {
    const ref = m.referenced_message;
    const nums = ref?.author?.bot ? [...(ref.content ?? "").matchAll(/#(\d+)/g)] : [];
    const itemId = nums.length ? Number(nums[nums.length - 1][1]) : null;
    if (itemId !== null) occ = await d.repo.openMainOfItem(itemId);
  }
  if (!occ) return "ignored";
  const action = parseReply(m.content, { at: messageTime(m, d.now), tz: d.s.tz, defaultTime: d.s.defaultTime });
  // настроение: любой ответ — активность; «готово» — выполнено (вовремя или с опозданием)
  let doneLine: string | null = null;
  if (d.mood && OPEN_STATES.includes(occ.state)) {
    await d.mood.load();
    if (action.kind === "done") doneLine = await recordDone(d.mood, occ);
    else d.mood.apply({ type: "activity" });
  }
  const res = applyReply(occ, action, d.s, d.now, doneLine);
  if (res.ops.length) await d.repo.exec(res.ops);
  // живое сообщение дела и то, на которое ответили (например, «Записано …» в канале приёма): обоим — новый вид без старых кнопок
  if (res.edit) {
    const targets: { ch: string; id: string }[] = [];
    if (occ.last_message_id && occ.last_channel_id) targets.push({ ch: occ.last_channel_id, id: occ.last_message_id });
    if (!targets.some((t) => t.id === refId)) targets.push({ ch: channelId, id: refId });
    for (const t of targets) {
      try {
        await d.api.editMessage(t.ch, t.id, res.edit);
      } catch {
        /* сообщения уже нет: не страшно */
      }
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
