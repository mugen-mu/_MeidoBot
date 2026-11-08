// Сообщения, кнопки и окна бота: тон нейтральный и короткий, всё по-русски.
import { CHARACTER_LABELS, type Character, tired } from "../flavor.ts";
import { type FirePlan, type LadderSpec, PRESET_LABELS, describeSpec } from "../ladder.ts";
import { type AppSettings } from "../settings.ts";
import { describeRecipe, formatDate, formatWhen } from "../time/format.ts";
import { QUICK_OPTIONS } from "../time/quick.ts";
import { MINUTE, civilDay, fmtHHMM, startOfDay, wallOf } from "../time/tz.ts";
import type { OccView } from "../db/types.ts";
import { type Mood } from "../personality/moodEngine.ts";
import { maidEmbed } from "../personality/look.ts";
import { styleSummary } from "../personality/styleReport.ts";
import { parseRecipe } from "../service.ts";
import type { ActionRow, Button, MessageBody } from "./types.ts";

export const cid = (...parts: (string | number)[]): string => parts.join(":");

export function fmtDuration(min: number): string {
  if (min < 90) return `${Math.max(1, Math.round(min))} мин`;
  if (min < 48 * 60) return `${Math.round(min / 60)} ч`;
  return `${Math.round(min / 1440)} дн.`;
}

const btn = (label: string, id: string, style: Button["style"] = 2): Button => ({ type: 2, style, label, custom_id: id });
const row = (...components: ActionRow["components"]): ActionRow => ({ type: 1, components });

/** Как показать реплику горничной карточкой (этап Х3): цвет по настроению и, редко, спрайт; без этого — мелкий текст под сообщением. */
export interface Look {
  mood: Mood;
  /** адрес Worker, где лежат спрайты; без него картинки нет, цвет остаётся */
  origin?: string | null;
  sprite?: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------- напоминание ----------

/** Кнопки под напоминанием: три — «Готово», «Отложить», «Изменить» (у повторяющегося «таймера» вместо «Изменить» — «Стоп»). */
export function reminderButtons(occ: OccView): Button[] {
  if (occ.kind === "lead") return [btn("Принято", cid("done", occ.id), 3), btn("Отложить", cid("snzm", occ.id))];
  if (occ.item_kind === "timer") return [btn("Готово", cid("done", occ.id), 3), btn("Отложить", cid("snzm", occ.id)), btn("Стоп", cid("stop", occ.item_id), 4)];
  return [btn("Готово", cid("done", occ.id), 3), btn("Отложить", cid("snzm", occ.id)), btn("Изменить", cid("edit", occ.id))];
}

/** Второй шаг «Отложить»: быстрые варианты вместо трёх кнопок; «Назад» возвращает прежние. */
export function snoozeChoiceRow(occId: number): ActionRow {
  return row(btn("15 мин", cid("snz", occId, 15)), btn("1 час", cid("snz", occId, 60)), btn("На…", cid("snzat", occId)), btn("◀ Назад", cid("snzb", occId)));
}

export function reminderMessage(a: {
  occ: OccView;
  plan: FirePlan;
  ownerId: string;
  tz: string;
  now: number;
  /** реплика горничной под сообщением (настроение); суть напоминания остаётся без изменений */
  flavor?: string | null;
  /** оформление реплики карточкой; суть (время, дело) остаётся обычным текстом, карточка — только реплика */
  look?: Look | null;
}): MessageBody {
  const { occ, plan, ownerId, tz, now } = a;
  const due = occ.due_at ?? now;
  const ref = `#${occ.item_id}`;
  const mention = `<@${ownerId}>`;
  let content: string;
  const buttons = reminderButtons(occ);
  if (occ.kind === "lead") {
    content = `${mention} Скоро срок: **${occ.title}** — ${formatWhen(due, now, tz)} (через ${occ.lead_days} дн.) · ${ref}`;
  } else if (occ.item_kind === "timer") {
    const r = parseRecipe(occ);
    content = `${mention} **${occ.title}**\nПовтор: ${r ? describeRecipe(r, tz) : "по расписанию"} · ${ref}`;
  } else {
    const lines: string[] = [];
    if (plan.phase === "overdue") {
      lines.push(`${mention} **${occ.title}** — висит`);
      lines.push(`Срок был: ${formatWhen(due, now, tz)}. Прошло: ${fmtDuration(plan.lateMinutes)}. · ${ref}`);
    } else {
      lines.push(`${mention} **${occ.title}**`);
      const extra = [
        plan.ordinal > 1 ? `напоминание ${plan.ordinal} из ${plan.total}` : null,
        occ.snooze_count > 0 ? `отложено ${occ.snooze_count} р.` : null,
      ].filter(Boolean);
      lines.push(`Срок: ${formatWhen(due, now, tz)}${extra.length ? ` · ${extra.join(", ")}` : ""} · ${ref}`);
    }
    content = lines.join("\n");
  }
  const body: MessageBody = { content, components: [row(...buttons)], allowed_mentions: { users: [ownerId] } };
  if (a.flavor && a.look) body.embeds = [maidEmbed({ mood: a.look.mood, text: a.flavor, origin: a.look.origin, sprite: a.look.sprite })];
  else if (a.flavor) body.content += `
${subtext(a.flavor)}`;
  return body;
}

/** Текст ответа бота плюс (если есть) мелкая реплика Хару на новой строке. */
export const withLine = (text: string, line: string | null | undefined): string => (line ? `${text}\n${subtext(line)}` : text);

/** Мелкий серый текст Discord («-# …»): каждая строка отдельно, чтобы манга-звук второй строкой тоже был мелким. */
export const subtext = (text: string): string =>
  text
    .split("\n")
    .map((l) => (l.startsWith("-# ") ? l : `-# ${l}`))
    .join("\n");

/** После закрытия кнопкой «Готово» сообщение остаётся записью, без кнопок. */
export function doneMessage(title: string, ch: Character = "neutral", seed = 0, line: string | null = null, look: Look | null = null): MessageBody {
  if (line && look) {
    return { content: `Готово: ${title}`, embeds: [maidEmbed({ mood: look.mood, text: line, origin: look.origin, sprite: look.sprite })], components: [], allowed_mentions: { parse: [] } };
  }
  const extra = line ?? tired(ch, "done", seed); // реплика настроения главнее прежнего «характера»
  return { content: `Готово: ${title}${extra ? `\n${subtext(extra)}` : ""}`, components: [], allowed_mentions: { parse: [] } };
}

/** Обычный текст плюс (для характера «горничная») короткая фраза через пробел. */
const withTired = (text: string, extra: string | null): string => (extra ? `${text} ${extra}` : text);

export function snoozedMessage(a: { occId: number; title: string; whenText: string; itemId: number; line?: string | null }): MessageBody {
  return {
    content: withLine(`Отложено: **${a.title}** — до ${a.whenText} · #${a.itemId}`, a.line),
    allowed_mentions: { parse: [] },
    components: [row(btn("Готово", cid("done", a.occId), 3), btn("Изменить", cid("edit", a.occId)))],
  };
}

export function plainMessage(content: string, ephemeral = false): MessageBody {
  return { content, allowed_mentions: { parse: [] }, components: [], ...(ephemeral ? { flags: 64 } : {}) };
}

// ---------- «Верно / Изменить» и вопросы ----------

export function confirmMessage(a: {
  occId: number;
  itemId: number;
  title: string;
  whenText: string;
  recur?: string | null;
  lead?: string | null;
  /** строка «Настойчивость» показывается, только если у дела она своя (выбор убран из подтверждения: он в «Изменить») */
  ladderText?: string;
  /** не используется (оставлен, чтобы вызовы не менялись) */
  ladderKey?: string | null;
  /** строка-пояснение под записью (например, «время поняла модель») */
  note?: string;
  /** реплика горничной (настроение): карточкой, если есть `look`, иначе мелким текстом под записью */
  line?: string | null;
  look?: Look | null;
}): MessageBody {
  const lines = [`Записано: **${a.title}** — ${a.whenText} · #${a.itemId}`];
  if (a.recur) lines.push(`Повтор: ${a.recur}`);
  if (a.lead) lines.push(`Заранее: ${a.lead}`);
  if (a.ladderText) lines.push(`Настойчивость: ${a.ladderText}`);
  if (a.note) lines.push(`-# ${a.note}`);
  if (a.line && !a.look) lines.push(subtext(a.line));
  const rows: ActionRow[] = [row(btn("Изменить", cid("edit", a.occId)), btn("Отменить", cid("rm", a.itemId), 4))];
  const embeds = a.line && a.look ? [maidEmbed({ mood: a.look.mood, text: a.line, origin: a.look.origin, sprite: a.look.sprite })] : undefined;
  return { content: lines.join("\n"), ...(embeds ? { embeds } : {}), allowed_mentions: { parse: [] }, components: rows };
}

export function confirmedMessage(a: { title: string; whenText: string; itemId: number }): MessageBody {
  return { content: `Записано: **${a.title}** — ${a.whenText} · #${a.itemId}`, components: [], allowed_mentions: { parse: [] } };
}

export function draftMessage(a: { occId: number; itemId: number; title: string; note?: string; line?: string | null }): MessageBody {
  return {
    // «#N» остаётся в конце строки с названием/пояснением: по нему находится дело при Reply; реплика — отдельной строкой ниже
    content: withLine(`**${a.title}** — когда напомнить?${a.note ? `\n${a.note}` : ""} · #${a.itemId}`, a.line),
    allowed_mentions: { parse: [] },
    components: [
      row(
        btn("Через час", cid("when", a.occId, "h1")),
        btn("Вечером", cid("when", a.occId, "eve")),
        btn("Завтра", cid("when", a.occId, "tom")),
        btn("В понедельник", cid("when", a.occId, "mon")),
        btn("На…", cid("whenat", a.occId)),
      ),
      row(btn("Без срока", cid("nosd", a.occId))),
    ],
  };
}

export function snoozeQuestionMessage(a: { occId: number; itemId: number; title: string; count: number }): MessageBody {
  return {
    content: `Откладываешь «${a.title}» в ${a.count}-й раз. Что делаем?`,
    allowed_mentions: { parse: [] },
    components: [
      row(
        btn("Сегодня", cid("tdy", a.occId), 3),
        btn("Разбить на шаги", cid("split", a.occId)),
        btn("Удалить", cid("del", a.itemId), 4),
      ),
    ],
  };
}

// ---------- списки и сводки ----------

const STATE_LABEL: Record<string, string> = {
  draft: "без срока",
  planned: "запланировано",
  snoozed: "отложено до",
  fired: "ждёт «Готово»",
  overdue: "висит",
};

function itemLine(o: OccView, now: number, tz: string): string {
  const repeat = o.rule_recipe ? " ↻" : "";
  const when = o.due_at === null ? "" : o.state === "snoozed" && o.next_fire_at ? formatWhen(o.next_fire_at, now, tz) : formatWhen(o.due_at, now, tz);
  const label = STATE_LABEL[o.state] ?? o.state;
  return `• #${o.item_id} ${clip(o.title, 80)}${repeat} — ${label}${when ? `: ${when}` : ""}`;
}

function joinLines(head: string, lines: string[], max = 1900): string {
  let out = head;
  let shown = 0;
  for (const l of lines) {
    if (out.length + l.length + 1 > max) break;
    out += `\n${l}`;
    shown++;
  }
  if (shown < lines.length) out += `\n… и ещё ${lines.length - shown}`;
  return out;
}

export function listText(items: OccView[], now: number, tz: string, ch: Character = "neutral"): string {
  if (items.length === 0) return withTired("Открытых дел нет.", tired(ch, "listEmpty", now));
  return joinLines(`Открытые дела (${items.length}):`, items.map((o) => itemLine(o, now, tz)));
}

const isBurning = (o: OccView) => o.state === "overdue" || o.state === "fired";

export function panelText(items: OccView[], now: number, tz: string, ch: Character = "neutral"): string {
  const hot = items.filter(isBurning);
  if (hot.length === 0) return withTired("**Висит**\nНичего не висит.", tired(ch, "panelEmpty", 0));
  return joinLines("**Висит**", hot.map((o) => itemLine(o, now, tz)));
}

export function weekText(items: OccView[], now: number, tz: string, ch: Character = "neutral"): string {
  const today = startOfDay(now, tz);
  const end = today + 7 * 24 * 60 * MINUTE;
  const hot = items.filter(isBurning);
  const upcoming = items
    .filter((o) => !isBurning(o) && o.state !== "draft")
    .map((o) => ({ o, at: o.state === "snoozed" && o.next_fire_at ? o.next_fire_at : o.due_at }))
    .filter((x): x is { o: OccView; at: number } => x.at !== null && x.at >= today && x.at < end)
    .sort((a, b) => a.at - b.at);
  const lines: string[] = [];
  if (hot.length) {
    lines.push("**Не закрыто:**", ...hot.map((o) => itemLine(o, now, tz)));
  }
  let lastDay = -1;
  for (const { o, at } of upcoming) {
    const w = wallOf(at, tz);
    const day = civilDay(w.y, w.mo, w.d);
    if (day !== lastDay) {
      lines.push(`**${formatDate(at, now, tz)}**`);
      lastDay = day;
    }
    lines.push(`• ${fmtHHMM(w.h * 60 + w.mi)} ${clip(o.title, 80)} (#${o.item_id})`);
  }
  if (lines.length === 0) return withTired("На ближайшие 7 дней дел нет.", tired(ch, "weekEmpty", now));
  return joinLines("Ближайшие 7 дней:", lines);
}

/** Сколько строк списка дел показывает сводка (остальное — по кнопке «Показать всё»). */
export const SUMMARY_MAX_LINES = 10;

export const summaryText = (kind: "morning" | "evening" | "return", a: SummaryArgs): string => summaryParts(kind, a).text;

type SummaryArgs = { items: OccView[]; now: number; tz: string; ownerId: string; extra?: string[]; character?: Character; /** без обрезки до 10 строк */ full?: boolean };

/** Сводка: текст и признак «список обрезан» (тогда под сообщением нужна кнопка «Показать всё»). */
export function summaryParts(kind: "morning" | "evening" | "return", a: SummaryArgs): { text: string; truncated: boolean } {
  const ch = a.character ?? "neutral";
  const day = Math.floor(a.now / (24 * 60 * MINUTE));
  const { items, now, tz } = a;
  const today = startOfDay(now, tz);
  const tomorrow = today + 24 * 60 * MINUTE;
  const dayAfter = tomorrow + 24 * 60 * MINUTE;
  const hot = items.filter(isBurning);
  const at = (o: OccView) => (o.state === "snoozed" && o.next_fire_at ? o.next_fire_at : o.due_at);
  const dueIn = (from: number, to: number) =>
    items.filter((o) => !isBurning(o) && o.state !== "draft" && at(o) !== null && (at(o) as number) >= from && (at(o) as number) < to);
  const drafts = items.filter((o) => o.state === "draft").length;
  const time = (o: OccView) => fmtHHMM(wallOf(at(o) as number, tz).h * 60 + wallOf(at(o) as number, tz).mi);
  const lines: string[] = [];
  const head =
    kind === "morning" ? "Сводка на сегодня." : kind === "evening" ? "Вечерняя сводка." : "С возвращением. Накопилось за время отъезда:";
  if (kind === "morning") {
    const t = dueIn(today, tomorrow);
    lines.push(t.length ? "**Сегодня:**" : "На сегодня дел со сроком нет.", ...t.map((o) => `• ${time(o)} ${clip(o.title, 80)} (#${o.item_id})`));
    if (hot.length) lines.push("**Висит:**", ...hot.map((o) => itemLine(o, now, tz)));
  } else if (kind === "evening") {
    lines.push(hot.length ? "**Не закрыто — закройте или перенесите на конкретное время:**" : "Незакрытого нет.", ...hot.map((o) => itemLine(o, now, tz)));
    const t = dueIn(tomorrow, dayAfter);
    if (t.length) lines.push("**Завтра:**", ...t.map((o) => `• ${time(o)} ${clip(o.title, 80)} (#${o.item_id})`));
  } else {
    lines.push(...(hot.length ? hot.map((o) => itemLine(o, now, tz)) : ["Ничего не висит."]));
    const t = dueIn(today, dayAfter);
    if (t.length) lines.push("**Скоро:**", ...t.map((o) => `• ${formatWhen(at(o) as number, now, tz)} ${clip(o.title, 80)} (#${o.item_id})`));
  }
  let truncated = false;
  if (!a.full && lines.length > SUMMARY_MAX_LINES) {
    const rest = lines.length - SUMMARY_MAX_LINES;
    lines.length = SUMMARY_MAX_LINES;
    lines.push(`… и ещё ${rest}`);
    truncated = true;
  }
  if (drafts) lines.push(`Без срока: ${drafts}. Список — /list.`);
  if (a.extra?.length) lines.push(...a.extra);
  if (kind === "morning") lines.push(tired(ch, "morningSign", day) ?? "Бот на месте.");
  if (kind === "evening") {
    const sign = tired(ch, "eveningSign", day);
    if (sign) lines.push(sign);
  }
  return { text: joinLines(`<@${a.ownerId}> ${head}`, lines), truncated };
}

/** Кнопка под обрезанной сводкой: полный список приходит отдельным сообщением «только вам». */
export const summaryMoreRow = (kind: "morning" | "evening" | "return"): ActionRow => row(btn("Показать всё", cid("sumall", kind)));

export function weeklyText(a: { doneCount: number; items: OccView[]; now: number; tz: string; ownerId: string; character?: Character }): string {
  const hot = a.items.filter(isBurning);
  const drafts = a.items.filter((o) => o.state === "draft");
  const lines = [
    `Закрыто за неделю: ${a.doneCount}. Открыто: ${a.items.length}, из них не закрыто: ${hot.length}, без срока: ${drafts.length}.`,
  ];
  if (hot.length) lines.push("**Не закрыто:**", ...hot.map((o) => itemLine(o, a.now, a.tz)));
  if (drafts.length) lines.push("**Без срока (назначьте время или удалите):**", ...drafts.map((o) => itemLine(o, a.now, a.tz)));
  const sign = tired(a.character ?? "neutral", "weeklySign", Math.floor(a.now / (7 * 24 * 60 * MINUTE)));
  if (sign) lines.push(sign);
  return joinLines(`<@${a.ownerId}> Итоги недели.`, lines);
}

// ---------- настройки ----------

const WD_NAME = ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

export function describeWeekly(s: AppSettings): string {
  return s.weekly ? `${WD_NAME[s.weekly.dow]} ${fmtHHMM(s.weekly.at)}` : "выкл";
}

export function specKey(spec: LadderSpec): string {
  return "preset" in spec ? spec.preset : "";
}

// ---------- окна ----------

interface Choice {
  value: string;
  label: string;
}

export const textLabel = (
  label: string,
  id: string,
  o: { value?: string; placeholder?: string; required?: boolean; long?: boolean; max?: number } = {},
) => ({
  type: 18,
  label,
  component: {
    type: 4,
    custom_id: id,
    style: o.long ? 2 : 1,
    required: o.required ?? true,
    ...(o.value ? { value: o.value } : {}),
    ...(o.placeholder ? { placeholder: o.placeholder } : {}),
    ...(o.max ? { max_length: o.max } : {}),
  },
});

export const radioLabel = (label: string, id: string, options: Choice[], required = false) => ({
  type: 18,
  label,
  component: { type: 21, custom_id: id, required, options: options.map((c) => ({ value: c.value, label: c.label })) },
});

export const selectLabel = (label: string, id: string, options: Choice[], required = false) => ({
  type: 18,
  label,
  component: { type: 3, custom_id: id, required, options: options.map((c) => ({ value: c.value, label: c.label })) },
});

export const modal = (customId: string, title: string, components: unknown[]) => ({
  type: 9,
  data: { custom_id: customId, title: clip(title, 45), components },
});

const WHEN_CHOICES: Choice[] = [...QUICK_OPTIONS.map((q) => ({ value: q.key, label: q.label })), { value: "custom", label: "Своё время (впишите ниже)" }];

/** Окно «На…» / «Когда напомнить?»: быстрые варианты + строка «завтра 10:30». */
export function whenModal(customId: string, title: string) {
  return modal(customId, title, [
    radioLabel("Когда", "quick", WHEN_CHOICES),
    textLabel("Своё время", "text", { required: false, placeholder: "завтра 10:30", max: 100 }),
  ]);
}

export function editModal(a: { occId: number; title: string; whenText: string | null; ladderKey: string; plain?: boolean }) {
  const comps: unknown[] = [textLabel("Название", "title", { value: a.title, max: 200 })];
  if (a.whenText !== null) comps.push(textLabel("Когда", "when", { value: a.whenText, placeholder: "завтра 10:30", required: false, max: 100 }));
  comps.push(
    selectLabel("Настойчивость", "ladder", [
      { value: "keep", label: "Не менять" },
      { value: "soft", label: "Мягко" },
      { value: "standard", label: "Стандартно" },
      { value: "strong", label: "Настойчиво" },
      { value: "custom", label: "Свои числа (впишите ниже)" },
    ]),
    textLabel("Свои числа (минуты от срока)", "nums", { required: false, placeholder: "0 10 20 40", max: 60 }),
    selectLabel("Реплики Хару", "plain", [
      { value: "keep", label: a.plain ? "Не менять (сейчас: без стиля)" : "Не менять (сейчас: со стилем)" },
      { value: "plain", label: "Без стиля: только суть" },
      { value: "styled", label: "Со стилем" },
    ]),
  );
  return modal(cid("m_edit", a.occId), "Изменить дело", comps);
}

export const splitModal = (occId: number) =>
  modal(cid("m_split", occId), "Разбить на шаги", [textLabel("Шаги, по одному в строке", "steps", { long: true, max: 1500 })]);

export const quietModal = (s: AppSettings) =>
  modal("m_quiet", "Тихие часы", [
    textLabel("Начало (ЧЧ:ММ)", "from", { value: fmtHHMM(s.quietFrom), max: 5 }),
    textLabel("Конец (ЧЧ:ММ)", "to", { value: fmtHHMM(s.quietTo), max: 5 }),
  ]);

export const summModal = (s: AppSettings) =>
  modal("m_summ", "Сводки и часовой пояс", [
    textLabel("Утренняя сводка (ЧЧ:ММ или «выкл»)", "morning", { value: s.morning === null ? "выкл" : fmtHHMM(s.morning), max: 10 }),
    textLabel("Вечерняя сводка (ЧЧ:ММ или «выкл»)", "evening", { value: s.evening === null ? "выкл" : fmtHHMM(s.evening), max: 10 }),
    textLabel("Итоги недели («воскресенье 19:00» или «выкл»)", "weekly", { value: describeWeekly(s), max: 30 }),
    textLabel("Часовой пояс", "tz", { value: s.tz, max: 40 }),
  ]);

export const lightModal = (s: AppSettings) =>
  modal("m_light", "График света", [
    textLabel("Группа (3 или 3.1; «выкл» — не показывать)", "group", { value: s.lightGroup ?? "выкл", max: 10 }),
  ]);

export const waterModal = (s: AppSettings) =>
  modal("m_water", "Вода: слова места", [
    textLabel("1–5 слов через запятую («выкл» — не следить)", "words", {
      value: s.waterWords.length ? s.waterWords.join(", ") : "",
      placeholder: "Чечелівськ, Могилевськ",
      required: false,
      max: 100,
    }),
  ]);

export const gasModal = (s: AppSettings) =>
  modal("m_gas", "Газ: слова адреса", [
    textLabel("1–5 слов через запятую («выкл» — не следить)", "words", {
      value: s.gasWords.length ? s.gasWords.join(", ") : "",
      placeholder: "Героїв 35, Козака Мамая",
      required: false,
      max: 100,
    }),
  ]);

export const awayModal = () =>
  modal("m_away", "Я в отъезде", [textLabel("На сколько дней (0 — вернуться)", "days", { placeholder: "3", max: 3 })]);

export const ladderNumsModal = () =>
  modal("m_ladn", "Свои числа лестницы", [
    textLabel("Минуты от срока, через пробел", "nums", { placeholder: "0 10 20 40", max: 60 }),
  ]);
