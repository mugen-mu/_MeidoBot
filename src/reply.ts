// Ответ (Reply) пользователя на сообщение-напоминание обычным текстом:
// «через 2 мин», «на час», «завтра в 10», «готово». Действует на то дело, к чьему сообщению привязан ответ.
// Просьба «перенеси на завтра», «отложи на вечер» работает и без ответа: тогда переносится последнее напоминание бота (см. handleReply).
import type { Repo } from "./db/repo.ts";
import { OPEN_STATES, type OccView, type Op } from "./db/types.ts";
import type { DiscordApi, IncomingMessage, MessageBody } from "./discord/types.ts";
import { messageTime } from "./intake.ts";
import { doneMessage, factTail, plainMessage, snoozedMessage, voice } from "./discord/ui.ts";
import { SNOOZE_TEASE_AT } from "./ladder.ts";
import { type MoodSession, reactionLine, recordDone } from "./personality/director.ts";
import type { Situation } from "./personality/phrases.ts";
import { detectSecret } from "./secrets.ts";
import { cancelItemOps, doneOps, nextSeriesOps, rescheduleOps, snoozeOps } from "./service.ts";
import { type AppSettings, timeOpts } from "./settings.ts";
import { formatMoveTarget, formatWhen } from "./time/format.ts";
import { parseInput, parseWhen } from "./time/parse.ts";
import { DAY } from "./time/tz.ts";

export type ReplyAction = { kind: "done" } | { kind: "cancel" } | { kind: "snooze"; due: number } | { kind: "past" } | { kind: "ask" } | { kind: "unknown" };

type TimeCtx = { at: number; tz: string; defaultTime: number; morningTime?: number; eveningTime?: number };

const DONE_RX = /^(?:напомни\s+)?(?:готово|сделано|сделал[аи]?|выполнено|закрыть|закрой|done)$/u;
const CANCEL_RX = /^(?:отмени(?:ть|те)?|отмена|удали(?:ть|те)?|не\s+надо|не\s+нужно|cancel)(?:\s+(?:это|дело|его|её))?$/u;
// «на час», «на 15 минут», «отложи на полчаса» -> «через …» (время «на 18:30» сюда не попадает)
const ON_DURATION_RX = /^(?:(?:отложи(?:ть)?|перенеси(?:ть)?|напомни)\s+)?на\s+((?:\d+(?:[.,]\d+)?|час|полчаса|полтора\s+часа|неделю|день|сутки|месяц)(?:\s*(?:мин\S*|час\S*|ч|дн\S*|день|сутки|нед\S*))?)$/u;

function normalize(raw: string): string {
  let t = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!…]+$/u, "");
  const m = ON_DURATION_RX.exec(t);
  if (m) t = `через ${m[1]}`;
  return t.replace(/\bполчаса\b/u, "30 минут").replace(/\bполтора\s+часа\b/u, "90 минут");
}

/** Что хотел сказать ответ. `at` — время отправки сообщения (от него считается «через 2 мин»). */
export function parseReply(text: string, ctx: TimeCtx): ReplyAction {
  const t = normalize(text);
  if (DONE_RX.test(t)) return { kind: "done" };
  if (CANCEL_RX.test(t)) return { kind: "cancel" };
  const w = parseWhen(t, { now: ctx.at, tz: ctx.tz, defaultTime: ctx.defaultTime, morningTime: ctx.morningTime, eveningTime: ctx.eveningTime });
  if (!w) return { kind: "unknown" };
  return w.past ? { kind: "past" } : { kind: "snooze", due: w.due };
}

// ---------- перенос фразой: «перенеси на завтра», «перенеси напоминание на пятницу в 18:00», «отложи на вечер» ----------
// Строго: всё сообщение — глагол, (необязательно) «это / напоминание / дело» и только время. Любое другое слово — это обычное дело,
// а не просьба: «перенеси файл на диск D», «отложи деньги на отпуск», «перенеси встречу на пятницу» остаются делами (как раньше).

export type MoveAction = { kind: "move"; due: number } | { kind: "past" } | { kind: "ask" };

const MOVE_VERB = "(?:перенеси(?:те)?|отложи(?:те)?|сдвинь(?:те)?|передвинь(?:те)?)";
const MOVE_THING = "(?:(?:это|эту|его|её|ее|моё|мое|мою|последнее|текущее)\\s+)*(?:напоминани[ея]|напоминалк[ауи]|дело|задач[ауи])|это|эту|его|её|ее";
const MOVE_RX = new RegExp(`^(?:(?:бот|хару)[,:]?\\s+)?(?:пожалуйста[,]?\\s+)?${MOVE_VERB}(?:\\s+мне)?(?:\\s+(${MOVE_THING})(?![\\p{L}\\p{N}]))?(?:\\s+(.+))?$`, "u");
/** «на потом», «на позже»: просят перенести, но время не назвали — уточняем, а не заводим дело */
const MOVE_VAGUE_RX = /^(?:на|до)\s+(?:потом|позже|попозже|когда-?нибудь)$/u;

function cleanMove(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!…]+$/u, "")
    .replace(/[,\s]*(?:пожалуйста|плиз)$/u, "")
    .replace(/[.!…]+$/u, "");
}

/** Начинается ли сообщение как просьба перенести (дёшево, без времени и базы): стоит ли вообще звать полный разбор. */
export function looksLikeMove(text: string): boolean {
  return MOVE_RX.test(cleanMove(text));
}

/** Хвост фразы в обычную для разбора форму: «до пятницы» → «пятницы», «на вечер» → «вечером», «на час» → «через час». */
function moveTail(rest: string): string {
  const t = normalize(rest).replace(/^до\s+/u, "");
  const core = t.replace(/^на\s+/u, "");
  if (/^(?:вечер|вечера)$/u.test(core)) return "вечером";
  if (/^(?:утро|утра)$/u.test(core)) return "утром";
  if (/^(?:обед|обеда)$/u.test(core)) return "в обед";
  if (/^следующ\p{L}*\s+недел\p{L}*$/u.test(core)) return "в следующий понедельник";
  // «на 9 утра», «на 6 вечера» — время суток, а не длительность
  const clock = /^(\d{1,2}(?:\s*час(?:а|ов)?)?\s*(?:утра|вечера|дня|ночи))$/u.exec(core);
  if (clock) return `в ${clock[1]}`;
  return t;
}

/**
 * Просьба перенести напоминание или null, если сообщение — не она. Время считается от `ctx.at` (когда отправили сообщение).
 * `ask` — просят перенести, а «на когда» не понято: спрашиваем одной строкой, ничего не меняя.
 */
export function parseMovePhrase(text: string, ctx: TimeCtx): MoveAction | null {
  const t = cleanMove(text);
  const m = MOVE_RX.exec(t);
  if (!m) return null;
  const thing = m[1] !== undefined;
  const rest = (m[2] ?? "").trim();
  if (rest === "") return { kind: "ask" };
  const p = parseInput(moveTail(rest), { now: ctx.at, tz: ctx.tz, defaultTime: ctx.defaultTime, morningTime: ctx.morningTime, eveningTime: ctx.eveningTime });
  if (!p.recipe && p.due !== null) {
    if (p.title) return null; // кроме времени есть ещё слова: это обычное дело
    return p.past ? { kind: "past" } : { kind: "move", due: p.due };
  }
  // время не поняли: уточняем, только если ясно, что речь о напоминании («перенеси это …», «отложи на потом»)
  return thing || MOVE_VAGUE_RX.test(rest) ? { kind: "ask" } : null;
}

/** В какое окно «последнее напоминание» ещё считается тем, о котором речь (решение: сутки). */
export const MOVE_TARGET_AGE = DAY;
export const MOVE_NO_TARGET = "Не вижу, какое перенести: ответьте на нужное напоминание.";
export const MOVE_ASK = "На когда перенести? Например: «на завтра», «на час», «на пятницу в 18:00».";
export const MOVE_PAST = "Это время уже прошло. Скажите, например, «на час» или «на завтра».";

export const REPLY_UNKNOWN = "Не поняла. Ответьте, например, «через 15 минут», «на час», «завтра 10:30», «готово» или «отмени».";
// с фразой Хару «Не поняла.» не повторяем: она уже сказала это своими словами, остаётся подсказка
export const REPLY_UNKNOWN_HINT = "Ответьте, например, «через 15 минут», «на час», «завтра 10:30», «готово» или «отмени».";
export const REPLY_PAST_HINT = "Время уже прошло. Ответьте, например, «через 15 минут» или «завтра 10:30».";
export const REPLY_PAST = "Это время уже прошло. Ответьте, например, «через 15 минут» или «завтра 10:30».";
export const REPLY_CLOSED = "Это дело уже закрыто.";

export interface ReplyResult {
  ops: Op[];
  /** во что превратить живое сообщение дела (как после нажатия кнопки) */
  edit: MessageBody | null;
  /** короткий ответ боту в канал */
  text: string;
}

/**
 * `doneLine` — реплика Хару: для «готово» она идёт в карточку «Готово», для остального — мелкой строкой под ответом бота
 * (и под правкой сообщения «Отменено»/«Отложено»). `moved` — это просьба словами «перенеси / отложи»: ответ «Перенесла …».
 */
export function applyReply(occ: OccView, action: ReplyAction, s: AppSettings, now: number, doneLine: string | null = null, moved = false): ReplyResult {
  if (!OPEN_STATES.includes(occ.state)) return { ops: [], edit: null, text: voice(REPLY_CLOSED, doneLine, "Это дело уже закрыто.") };
  switch (action.kind) {
    case "done":
      return { ops: doneOps(occ, now), edit: doneMessage(occ.title, s.character, occ.id, doneLine), text: `Готово: **${occ.title}**.` };
    case "cancel":
      return { ops: cancelItemOps(occ.item_id, now), edit: plainMessage(voice(`Отменено: ${occ.title}`, doneLine, factTail(occ.title, "отменено"))), text: voice(`Отменено: **${occ.title}**.`, doneLine, `${factTail(occ.title, "отменено")}.`) };
    case "snooze": {
      const whenText = formatWhen(action.due, now, s.tz);
      const draft = occ.state === "draft";
      const ops = draft ? rescheduleOps(occ, action.due, now) : snoozeOps(occ, action.due, now);
      // не начавшееся дело ряда уходит из «запланировано»: следующее повторение создаём сразу (при первом срабатывании его бы уже не создали); повтор записи безвреден
      if (occ.state === "planned" && occ.kind === "main") ops.push(...nextSeriesOps(occ, now));
      const on = formatMoveTarget(action.due, now, s.tz);
      return {
        ops,
        edit: draft ? null : snoozedMessage({ occId: occ.id, title: occ.title, whenText, itemId: occ.item_id, line: doneLine }),
        text: moved
          ? voice(`Перенесла «${occ.title}» ${on}.`, doneLine, `${factTail(occ.title, `перенесено ${on}`)}.`)
          : voice(`Отложено: **${occ.title}**. Напомню: ${whenText}.`, doneLine, `${factTail(occ.title, `отложено, напомню: ${whenText}`)}.`),
      };
    }
    case "past":
      return { ops: [], edit: null, text: moved ? voice(MOVE_PAST, doneLine, MOVE_PAST) : voice(REPLY_PAST, doneLine, REPLY_PAST_HINT) };
    case "ask":
      return { ops: [], edit: null, text: voice(MOVE_ASK, doneLine, MOVE_ASK) };
    default:
      return { ops: [], edit: null, text: voice(REPLY_UNKNOWN, doneLine, REPLY_UNKNOWN_HINT) };
  }
}

/**
 * Обработать сообщение хозяина из канала напоминаний или приёма. Работает в двух случаях:
 *  • ответ (Reply) на сообщение бота: «готово», «на час», «перенеси на завтра» — действует то дело, к чьему сообщению привязан ответ;
 *  • просьба перенести без ответа («перенеси на завтра», «отложи на вечер»): переносится последнее напоминание, которое бот отправил
 *    (не старше суток) и которое ещё открыто. Нет такого — честно «не вижу, какое перенести»; наугад ничего не переносим.
 * Остальное (обычный текст, ответ на постороннее сообщение) — молча пропускаем. Тратит до 5 подзапросов.
 */
export async function handleReply(
  d: { repo: Repo; api: DiscordApi; s: AppSettings; now: number; mood?: MoodSession | null },
  m: IncomingMessage,
  channelId: string,
): Promise<"handled" | "ignored"> {
  const refId = m.message_reference?.message_id;
  if (!m.content.trim()) return "ignored";
  const ctx = { at: messageTime(m, d.now), ...timeOpts(d.s) };
  // просьба перенести; на пароль и ключ не реагируем (их разбирает обычный приём), текст сообщения нигде не сохраняется
  const move = detectSecret(m.content).secret ? null : parseMovePhrase(m.content, ctx);
  if (!refId && !move) return "ignored";
  const post = async (text: string): Promise<void> => {
    try {
      await d.api.postMessage(channelId, {
        content: text,
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: m.id, fail_if_not_exists: false },
      });
    } catch {
      /* не вышло ответить: дело всё равно обновлено */
    }
  };
  let occ: OccView | null = null;
  if (refId) {
    // сначала по запомненному сообщению; иначе — по номеру «#9» в тексте сообщения бота (старые «Записано», ответы на команды)
    occ = await d.repo.occByMessageId(refId);
    if (!occ) {
      const ref = m.referenced_message;
      const nums = ref?.author?.bot ? [...(ref.content ?? "").matchAll(/#(\d+)/g)] : [];
      const itemId = nums.length ? Number(nums[nums.length - 1][1]) : null;
      if (itemId !== null) occ = await d.repo.openMainOfItem(itemId);
    }
  } else {
    occ = await d.repo.lastReminded(d.now - MOVE_TARGET_AGE);
  }
  // перенос: не нашли дело (или без ответа последнее уже закрыто) — не угадываем другое, а просим ответить на нужное напоминание
  if (move && (!occ || (!refId && !OPEN_STATES.includes(occ.state)))) {
    await post(MOVE_NO_TARGET);
    return "handled";
  }
  if (!occ) return "ignored";
  const action: ReplyAction = move ? (move.kind === "move" ? { kind: "snooze", due: move.due } : move) : parseReply(m.content, ctx);
  // настроение: любой ответ — активность; «готово» — выполнено (вовремя или с опозданием)
  let doneLine: string | null = null;
  if (d.mood && OPEN_STATES.includes(occ.state)) {
    await d.mood.load();
    if (action.kind === "done") doneLine = await recordDone(d.mood, occ);
    else d.mood.apply({ type: "activity" });
  }
  // реплика Хару к остальным ответам (этап 2б): отмена, откладывание, «не поняла», «время прошло», «уже закрыто»
  if (d.mood && action.kind !== "done") {
    const sit: Situation = !OPEN_STATES.includes(occ.state)
      ? "reply_closed"
      : action.kind === "cancel" ? "cancelled" : action.kind === "snooze" ? (occ.snooze_count + 1 >= SNOOZE_TEASE_AT ? "snooze_5" : "snoozed") : action.kind === "past" ? "reply_past" : "reply_unknown";
    doneLine = await reactionLine(d.mood, sit, { title: occ.title, critical: occ.critical, plain: occ.plain, itemId: occ.item_id });
  }
  const res = applyReply(occ, action, d.s, d.now, doneLine, move !== null);
  if (res.ops.length) await d.repo.exec(res.ops);
  // живое сообщение дела и то, на которое ответили (например, «Записано …» в канале приёма): обоим — новый вид без старых кнопок
  if (res.edit) {
    const targets: { ch: string; id: string }[] = [];
    if (occ.last_message_id && occ.last_channel_id) targets.push({ ch: occ.last_channel_id, id: occ.last_message_id });
    if (refId && !targets.some((t) => t.id === refId)) targets.push({ ch: channelId, id: refId });
    for (const t of targets) {
      try {
        await d.api.editMessage(t.ch, t.id, res.edit);
      } catch {
        /* сообщения уже нет: не страшно */
      }
    }
  }
  await post(res.text);
  return "handled";
}
