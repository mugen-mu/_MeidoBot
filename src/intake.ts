// Приём дела из текста: общий путь для /remind, /every, меню сообщения и обычного текста в канале «бот».
import type { Repo } from "./db/repo.ts";
import type { Source } from "./db/types.ts";
import { type Look, confirmMessage, draftMessage } from "./discord/ui.ts";
import type { MessageBody } from "./discord/types.ts";
import { describeSpec } from "./ladder.ts";
import { newItemOps } from "./service.ts";
import { detectSecret } from "./secrets.ts";
import type { AppSettings } from "./settings.ts";
import { type AiBinding, understandPhrase } from "./llm.ts";
import { describeLead, describeRecipe, formatWhen } from "./time/format.ts";
import { parseInput } from "./time/parse.ts";

export interface CreateCtx {
  repo: Repo;
  settings: AppSettings;
  now: number;
  /** привязка Workers AI (env.AI); без неё и при выключенной настройке модель не зовём */
  ai?: AiBinding;
  /** сколько ждать модель, мс (по умолчанию 2 с) */
  aiTimeoutMs?: number;
  /** реплика горничной к подтверждению: вызывается с названием и «критично»; null — без реплики */
  recorded?: (title: string, critical: boolean) => Promise<{ line: string; look: Look | null } | null> | { line: string; look: Look | null } | null;
}

export type CreateResult =
  | { kind: "created"; itemId: number; occId: number; draft: boolean; message: MessageBody }
  | { kind: "secret" }
  | { kind: "empty" }
  | { kind: "empty_series" }
  | { kind: "not_recurring" };

/**
 * Время отправки сообщения по часам Discord: от него считаем «через 2 минуты», а не от того, когда бот
 * прочитал сообщение (бот просыпается раз в минуту). Нет метки или она из будущего — берём `now`.
 */
export function messageTime(m: { timestamp?: string }, now: number): number {
  const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(t) ? Math.min(t, now) : now;
}

export async function createFromText(
  ctx: CreateCtx,
  text: string,
  source: Source,
  opts: { body?: string | null; requireRecurring?: boolean; /** время отправки сообщения: от него считаются «через N минут» и «сегодня» */ at?: number } = {},
): Promise<CreateResult> {
  const { repo, settings, now } = ctx;
  // Секрет не сохраняем, не разбираем и не пишем в журнал (DESIGN §10).
  if (detectSecret(text).secret) return { kind: "secret" };
  const at = opts.at ?? now;
  let parsed = parseInput(text, { now: at, tz: settings.tz, defaultTime: settings.defaultTime });
  // Запасной путь: обычный разбор не нашёл время и повтор — спрашиваем модель (если включена); любой сбой = как раньше.
  let viaModel = false;
  if (settings.llmOn && ctx.ai && parsed.title && parsed.due === null && !parsed.recipe && !parsed.timer && !opts.requireRecurring && !parsed.seriesEmpty) {
    const u = await understandPhrase(ctx.ai, text, { now: at, tz: settings.tz, defaultTime: settings.defaultTime, timeoutMs: ctx.aiTimeoutMs });
    if (u) {
      parsed = u;
      viaModel = true;
    }
  }
  if (parsed.seriesEmpty) return { kind: "empty_series" };
  if (!parsed.title) return { kind: "empty" };
  if (opts.requireRecurring && !parsed.recipe) return { kind: "not_recurring" };
  const wasPast = parsed.past;
  if (parsed.past) parsed.due = null; // прошедшее время не годится: спросим, когда

  const { ops, mainIndex } = newItemOps({ parsed, source, settings, now, body: opts.body ?? null });
  const res = await repo.exec(ops);
  const itemId = Number(res[0].meta.last_row_id);
  const occId = Number(res[mainIndex].meta.last_row_id);

  if (parsed.due === null) {
    const note = wasPast ? "Названное время уже прошло." : undefined;
    return { kind: "created", itemId, occId, draft: true, message: draftMessage({ occId, itemId, title: parsed.title, note }) };
  }
  const rec = (await ctx.recorded?.(parsed.title, parsed.critical)) ?? null;
  return {
    kind: "created",
    itemId,
    occId,
    draft: false,
    message: confirmMessage({
      occId,
      itemId,
      title: parsed.title,
      whenText: formatWhen(parsed.due, now, settings.tz),
      recur: parsed.recipe ? describeRecipe(parsed.recipe, settings.tz) : null,
      lead: parsed.leadDays.length ? describeLead(parsed.leadDays) : null,
      line: rec?.line ?? null,
      look: rec?.look ?? null,
      note: viaModel ? MODEL_NOTE : undefined,
    }),
  };
}

/** Подпись под записью, понятой моделью: просьба проверить время. */
export const MODEL_NOTE = "Время поняла по смыслу (языковая модель). Если не так — «Изменить».";
export const SECRET_REPLY =
  "Похоже на пароль, ключ или номер карты. Бот такое не сохраняет и не записывает. Храните в менеджере паролей (например, Bitwarden), а здесь напишите без значения.";
export const EMPTY_REPLY = "О чём напомнить? Например: «завтра в 10 купить хлеб».";
export const NOT_RECURRING_REPLY = "Не понял повтор. Пример: «каждые 20 минут проверить плиту до 23:00» или «каждый месяц 20-го оплатить ФОП».";
export const EMPTY_SERIES_REPLY = "Этот повтор уже закончился до первого срабатывания (проверьте «до …»).";
