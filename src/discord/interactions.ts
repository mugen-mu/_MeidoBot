// Обработчик взаимодействий Discord: команды, кнопки, меню и окна. Всё, что бот делает по нажатию пользователя.
// Ответ нужен за 3 секунды: быстрые действия отвечают сразу, долгие (/setup) — «отложенным» ответом и правкой потом.
import { type Repo, setMeta, setSetting, updateOcc } from "../db/repo.ts";
import type { OccView, Op } from "../db/types.ts";
import { EMPTY_REPLY, EMPTY_SERIES_REPLY, NOT_RECURRING_REPLY, SECRET_REPLY, createFromText } from "../intake.ts";
import { tired } from "../flavor.ts";
import { MoodSession, makeCtx, recordDone, resetOps } from "../personality/director.ts";
import { MOODS, type Mood, isMood } from "../personality/moodEngine.ts";
import { MOOD_CONFIG } from "../personality/config.ts";
import { moodReport } from "../personality/report.ts";
import { parseStyle, styleToSettings } from "../personality/animeStyle.ts";
import { glossaryReport, styleReport } from "../personality/styleReport.ts";
import { describeSpec, needsSnoozeQuestion, parseCustomSteps, parseSpec, type LadderSpec } from "../ladder.ts";
import { fetchYasno, lightLines, normalizeGroup, nowLine } from "../light.ts";
import { newPowerKey, readPower } from "../power.ts";
import { detectSecret } from "../secrets.ts";
import {
  cancelItemOps,
  doneOps,
  newItemOps,
  parseRecipe,
  rescheduleOps,
  setLadderOps,
  setTitleOps,
  snoozeOps,
  stopSeriesOps,
} from "../service.ts";
import type { AppSettings } from "../settings.ts";
import { describeLead, describeRecipe, formatWhen } from "../time/format.ts";
import { normalizeEvery, parseInput, parseWhen } from "../time/parse.ts";
import { quickDue } from "../time/quick.ts";
import { DAY, MINUTE, addDaysWall, fmtHHMM, localDate, nextTimeOfDay, parseHHMM, wallOf } from "../time/tz.ts";
import type { DiscordApi, MessageBody } from "./types.ts";
import {
  awayModal,
  confirmMessage,
  confirmedMessage,
  doneMessage,
  editModal,
  ladderNumsModal,
  lightModal,
  listText,
  plainMessage,
  quietModal,
  settingsMessage,
  snoozeQuestionMessage,
  snoozedMessage,
  specKey,
  splitModal,
  subtext,
  summModal,
  weekText,
  whenModal,
} from "./ui.ts";

export interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string } };
  user?: { id: string };
  data?: Record<string, any>;
  message?: { id: string; channel_id?: string };
}

export interface HandlerCtx {
  repo: Repo;
  api: DiscordApi;
  now: number;
  env: { ownerId?: string; origin?: string };
  /** фоновая работа после ответа (в Worker — ctx.waitUntil) */
  defer: (p: Promise<unknown>) => void;
  /** для запроса графика света; по умолчанию fetch */
  fetchFn?: typeof fetch;
  /** случайность для фраз настроения; по умолчанию Math.random */
  rand?: () => number;
}

type Reply = Record<string, unknown>;
const msg = (body: MessageBody): Reply => ({ type: 4, data: body });
const eph = (text: string): Reply => msg({ ...plainMessage(text, true) });
const update = (body: MessageBody): Reply => ({ type: 7, data: body });

const WD_BY_NAME: Record<string, number> = { понедельник: 1, вторник: 2, среда: 3, четверг: 4, пятница: 5, суббота: 6, воскресенье: 7 };

export async function handleInteraction(i: Interaction, ctx: HandlerCtx): Promise<Reply> {
  if (i.type === 1) return { type: 1 };
  const userId = i.member?.user.id ?? i.user?.id ?? "";
  const { settings: s, meta } = await ctx.repo.loadConfig();
  let owner = meta.get("owner_id") ?? ctx.env.ownerId ?? null;
  const isSetup = i.type === 2 && i.data?.name === "setup";
  if (owner === null && isSetup) {
    owner = userId; // хозяин — тот, кто первым выполнил /setup
    await ctx.repo.exec([setMeta("owner_id", owner)]);
  }
  if (owner === null) return i.type === 4 ? { type: 8, data: { choices: [] } } : eph("Бот ещё не настроен. Выполните /setup на своём сервере.");
  if (userId !== owner) return i.type === 4 ? { type: 8, data: { choices: [] } } : eph("Этот бот личный.");

  // настроение: любое действие хозяина (команда, кнопка, окно) — активность; состояние читаем, только если включено
  const mood = new MoodSession({ repo: ctx.repo, userId: owner, ctx: makeCtx(ctx.now, s), rand: ctx.rand, style: s.style });
  let returnLine: string | null = null;
  if (s.moodOn && (i.type === 2 || i.type === 3 || i.type === 5)) {
    await mood.load();
    if (mood.apply({ type: "activity" }).returned) returnLine = mood.say("return_after_pause");
  }
  const c: C = { ...ctx, s, meta, owner, i, mood };
  let reply: Reply;
  switch (i.type) {
    case 2:
      reply = i.data?.type === 3 ? await onMessageCommand(c) : await onCommand(c);
      break;
    case 3:
      reply = await onComponent(c);
      break;
    case 4:
      return onAutocomplete(c);
    case 5:
      reply = await onModal(c);
      break;
    default:
      return eph("Это действие бот не поддерживает.");
  }
  if (mood.loaded) {
    const ops = mood.ops();
    if (ops.length) await ctx.repo.exec(ops);
  }
  const data = reply.data as { content?: string } | undefined;
  if (returnLine && data && typeof data.content === "string" && (reply.type === 4 || reply.type === 7)) data.content += `
${subtext(returnLine)}`;
  return reply;
}

interface C extends HandlerCtx {
  s: AppSettings;
  meta: Map<string, string>;
  owner: string;
  i: Interaction;
  /** настроение горничной; load() сделан, только если оно включено (или нужно команде /mood) */
  mood: MoodSession;
}

const opt = (c: C, name: string): string | number | undefined =>
  (c.i.data?.options as { name: string; value: string | number }[] | undefined)?.find((o) => o.name === name)?.value;

/** В канале «бот» отвечаем всем видимо, в остальных местах — только хозяину. */
const publicHere = (c: C) => c.i.channel_id !== undefined && c.i.channel_id === c.s.chBot;
const out = (c: C, body: MessageBody): Reply => msg(publicHere(c) ? body : { ...body, flags: 64 });

async function createReply(c: C, text: string, source: "slash" | "menu", extra: { body?: string; requireRecurring?: boolean } = {}): Promise<Reply> {
  const r = await createFromText({ repo: c.repo, settings: c.s, now: c.now }, text, source, extra);
  switch (r.kind) {
    case "created":
      return out(c, r.message);
    case "secret":
      return eph(SECRET_REPLY);
    case "empty":
      return eph(EMPTY_REPLY);
    case "not_recurring":
      return eph(NOT_RECURRING_REPLY);
    default:
      return eph(EMPTY_SERIES_REPLY);
  }
}

// ---------- команды ----------

async function onCommand(c: C): Promise<Reply> {
  const name = c.i.data?.name as string;
  switch (name) {
    case "remind":
      return createReply(c, String(opt(c, "text") ?? ""), "slash");
    case "every":
      return createReply(c, normalizeEvery(String(opt(c, "text") ?? "")), "slash", { requireRecurring: true });
    case "list":
      return eph(listText(await c.repo.openMain(50), c.now, c.s.tz, c.s.character));
    case "week":
      return eph(weekText(await c.repo.openMain(100), c.now, c.s.tz, c.s.character));
    case "cancel": {
      const item = await c.repo.getItem(Number(opt(c, "id")));
      if (!item || item.archived_at) return eph("Такого дела нет (или оно уже закрыто). Номера — в /list.");
      await c.repo.exec(cancelItemOps(item.id, c.now));
      return eph(`Отменено: ${item.title}`);
    }
    case "snooze":
      return slashSnooze(c);
    case "settings":
      return settingsReply(c);
    case "away": {
      const days = opt(c, "days");
      if (days === undefined) {
        return eph(c.s.awayUntil > c.now ? `Вы в отъезде до ${formatWhen(c.s.awayUntil, c.now, c.s.tz)}. Вернуться сейчас: /away days:0` : "Вы не в отъезде. Включить: /away days:3");
      }
      return eph(await setAway(c, Number(days)));
    }
    case "mood":
      return moodCommand(c);
    case "reset_mood": {
      await c.repo.exec(resetOps(c.owner));
      c.mood.state = null; // состояние сброшено: сессия больше ничего не пишет
      return eph("Готово: настроение, отношение и серии сброшены к начальным. Хару начинает с чистого листа.");
    }
    case "style":
      return styleCommand(c);
    case "hints":
      return hintsCommand(c);
    case "glossary": {
      await c.mood.load();
      return eph(glossaryReport({ state: c.mood.styleState, style: c.s.style }));
    }
    case "quiet":
      return eph(await quiet(c, opt(c, "hours")));
    case "setup":
      return setup(c);
    case "power":
      return powerCommand(c);
    case "light":
      return lightCommand(c);
    default:
      return eph("Такой команды бот не знает.");
  }
}

/** /power: ссылки для телефона. Видны только хозяину («только вам»); ключ не попадает ни в журнал, ни в чат. */
/** /light: график отключений на сегодня и завтра для группы из настроек и «что сейчас». Запрос к Yasno — после ответа Discord (до 5 секунд). */
async function lightCommand(c: C): Promise<Reply> {
  const group = c.s.lightGroup;
  if (!group) return eph("Группа света не задана: /settings → «Свет: группа…» → впишите номер (например, 3).");
  c.defer(
    (async () => {
      const data = await fetchYasno(c.fetchFn ?? fetch);
      const today = localDate(c.now, c.s.tz);
      const tomorrow = localDate(addDaysWall(c.now, 1, c.s.tz), c.s.tz);
      const text = data
        ? [...lightLines("today", group, data, today), nowLine(c.now, group, data, c.s.tz), ...lightLines("tomorrow", group, data, tomorrow)].filter(Boolean).join("\n")
        : "Не удалось получить график: Yasno не отвечает. Попробуйте позже.";
      if (c.i.application_id) await c.api.editInteractionOriginal(c.i.application_id, c.i.token, plainMessage(text, true)).catch(() => undefined);
    })(),
  );
  return { type: 5, data: { flags: 64 } };
}

/** «Только вам» (64) и без предпросмотра ссылок (4): Discord не должен сам открывать ссылки с ключом. */
const powerReply = (text: string): Reply => msg({ ...plainMessage(text, true), flags: 68 });

async function powerCommand(c: C): Promise<Reply> {
  const reset = (opt(c, "reset") as unknown) === true;
  let key = c.meta.get("power_key");
  if (!key || reset) {
    key = newPowerKey();
    await c.repo.exec([setMeta("power_key", key)]);
  }
  const base = c.env.origin ?? "https://<адрес бота>";
  const p = readPower(c.meta);
  const state =
    p.state === "off"
      ? `Сейчас: света нет с ${formatWhen(p.since, c.now, c.s.tz)}.`
      : p.state === "on"
        ? `Сейчас: свет есть (с ${formatWhen(p.since, c.now, c.s.tz)}).`
        : "Сигналов от телефона ещё не было.";
  return powerReply(
    [
      reset ? "Ключ заменён: старые ссылки больше не работают." : "Ссылки для приложения на телефоне (инструкция — docs/POWER-SENSOR.md).",
      "Свет пропал (зарядка отключилась):",
      `${base}/power/${key}/off`,
      "Свет появился (зарядка подключилась):",
      `${base}/power/${key}/on`,
      "Ключ в ссылках — как пароль: никому не показывайте и не пересылайте. Если ссылка утекла — /power reset:True, и впишите новые в приложение.",
      state,
    ].join("\n"),
  );
}

async function slashSnooze(c: C): Promise<Reply> {
  const occ = await c.repo.openMainOfItem(Number(opt(c, "id")));
  if (!occ) return eph("Открытого дела с таким номером нет. Номера — в /list.");
  const text = opt(c, "when");
  const when = text ? parseWhen(String(text), { now: c.now, tz: c.s.tz, defaultTime: c.s.defaultTime }) : { due: c.now + 60 * MINUTE, past: false };
  if (!when) return eph("Не понял время. Пример: «завтра 10:30» или «через 2 часа».");
  if (when.past) return eph("Это время уже прошло.");
  await c.repo.exec(occ.state === "draft" ? rescheduleOps(occ, when.due, c.now) : snoozeOps(occ, when.due, c.now));
  if (occ.last_message_id && occ.last_channel_id) {
    const body = snoozedMessage({ occId: occ.id, title: occ.title, whenText: formatWhen(when.due, c.now, c.s.tz), itemId: occ.item_id });
    c.defer(c.api.editMessage(occ.last_channel_id, occ.last_message_id, body).catch(() => undefined));
  }
  return eph(`Отложено: ${occ.title} — до ${formatWhen(when.due, c.now, c.s.tz)}`);
}

async function onMessageCommand(c: C): Promise<Reply> {
  const targetId = String(c.i.data?.target_id ?? "");
  const m = c.i.data?.resolved?.messages?.[targetId] as { content?: string } | undefined;
  const text = (m?.content ?? "").trim();
  if (!text) return eph("В этом сообщении нет текста.");
  const link = `https://discord.com/channels/${c.i.guild_id ?? "@me"}/${c.i.channel_id}/${targetId}`;
  return createReply(c, text, "menu", { body: link });
}

async function setup(c: C): Promise<Reply> {
  const guildId = c.i.guild_id;
  if (!guildId) return eph("Выполните /setup на сервере, где есть бот.");
  c.defer(
    (async () => {
      let text: string;
      try {
        const existing = await c.api.listGuildChannels(guildId);
        const ids: Record<string, string> = {};
        const created: string[] = [];
        for (const name of ["напоминания", "бот", "сегодня"]) {
          const found = existing.find((ch) => ch.type === 0 && ch.name === name);
          if (found) ids[name] = found.id;
          else {
            ids[name] = (await c.api.createChannel(guildId, { name, type: 0 })).id;
            created.push(name);
          }
        }
        const intake = new Set(c.s.intake);
        intake.add(ids["бот"]);
        await c.repo.exec([
          setSetting("ch_remind", ids["напоминания"]),
          setSetting("ch_bot", ids["бот"]),
          setSetting("ch_today", ids["сегодня"]),
          setSetting("intake", JSON.stringify([...intake])),
          setMeta("guild_id", guildId),
        ]);
        text = `Готово. Каналы: <#${ids["напоминания"]}> (напоминания), <#${ids["бот"]}> (пишите сюда обычным текстом), <#${ids["сегодня"]}> (панель «Горит»).${created.length ? ` Создано: ${created.join(", ")}.` : " Все каналы уже были."}${tired(c.s.character, "setupDone") ? `\n-# ${tired(c.s.character, "setupDone")}` : ""}`;
      } catch {
        text = "Не получилось создать каналы. Проверьте, что у бота есть право «Управлять каналами», и повторите /setup.";
      }
      if (c.i.application_id) await c.api.editInteractionOriginal(c.i.application_id, c.i.token, plainMessage(text));
    })(),
  );
  return { type: 5, data: { flags: 64 } };
}

async function setAway(c: C, days: number): Promise<string> {
  if (days <= 0) {
    await c.repo.exec([setSetting("away_until", "0")]);
    return "Режим «я в отъезде» выключен.";
  }
  const until = c.now + days * DAY;
  await c.repo.exec([setSetting("away_until", String(until))]);
  return `Бот молчит до ${formatWhen(until, c.now, c.s.tz)}. При возвращении придёт одна сводка.`;
}

// ---------- настроение горничной (Характер 2, этап Х1) ----------

async function moodCommand(c: C): Promise<Reply> {
  const set = opt(c, "set");
  await c.mood.load();
  if (set !== undefined) {
    if (!isMood(set)) return eph(`Такого настроения нет. Бывают: ${MOODS.join(", ")}.`);
    c.mood.force(set as Mood);
    return eph(`Настроение задано вручную: ${set}. Оно сменится само, когда числа и время скажут иначе.

${moodReport({ state: c.mood.state!, enabled: c.s.moodOn })}`);
  }
  return eph(moodReport({ state: c.mood.state!, enabled: c.s.moodOn, greeting: c.mood.say("greeting") }));
}

/** /style: показать стиль речи или изменить (уровень, письмо, манга-звуки, обращения, каомодзи); в ответе — живые примеры. */
async function styleCommand(c: C): Promise<Reply> {
  const updates = new Map<string, string>();
  const changed: string[] = [];
  const set = (key: string, value: string, label: string) => {
    updates.set(key, value);
    changed.push(label);
  };
  const level = opt(c, "level");
  if (level !== undefined) set("style_level", String(level), `уровень ${level}`);
  const script = opt(c, "script");
  if (script !== undefined) set("style_script", String(script), "письмо");
  const sfx = opt(c, "sfx");
  if (sfx !== undefined) set("style_sfx", String(sfx), "манга-звуки");
  const honorifics = opt(c, "honorifics");
  if (honorifics !== undefined) set("style_honorifics", honorifics ? "1" : "0", `обращения ${honorifics ? "вкл" : "выкл"}`);
  const kaomoji = opt(c, "kaomoji");
  if (kaomoji !== undefined) set("style_kaomoji", String(kaomoji), "каомодзи");
  let style = c.s.style;
  if (updates.size) {
    await c.repo.exec([...updates].map(([k, v]) => setSetting(k, v)));
    style = parseStyle(new Map([...styleToSettings(c.s.style), ...updates]));
  }
  return eph(styleReport({ style, rand: c.rand ?? Math.random, changed }));
}

/** /hints: подсказки перевода в скобках — включить, выключить или показать. */
async function hintsCommand(c: C): Promise<Reply> {
  const mode = opt(c, "mode");
  if (mode === undefined) return eph(`Подсказки перевода: ${c.s.style.hints ? "включены" : "выключены"}. Они показываются первые 2 раза у каждого слова. Менять: /hints mode:выключить.`);
  await c.repo.exec([setSetting("hints_on", mode === "on" ? "1" : "0")]);
  return eph(mode === "on" ? "Подсказки перевода включены: новые слова будут с переводом в скобках (первые 2 раза)." : "Подсказки перевода выключены. Слова остаются в /glossary.");
}

/** /quiet: «горничная на выходном» — тот же режим, что «я в отъезде», но в часах. */
async function quiet(c: C, hours: string | number | undefined): Promise<string> {
  const h = hours === undefined ? MOOD_CONFIG.quietDefaultHours : Number(hours);
  if (h <= 0) {
    await c.repo.exec([setSetting("away_until", "0")]);
    return "Горничная вышла с выходного: напоминания снова идут.";
  }
  const until = c.now + h * 60 * MINUTE;
  await c.repo.exec([setSetting("away_until", String(until))]);
  return `Горничная на выходном до ${formatWhen(until, c.now, c.s.tz)}: напоминаний не будет, дела сохранятся. Вернуться раньше: /quiet hours:0`;
}

async function settingsReply(c: C): Promise<Reply> {
  return msg(settingsMessage(c.s, c.now, await dmOn(c)));
}

const dmOn = async (c: C): Promise<boolean> => {
  const dm = c.meta.get("dm_channel_id");
  return !!dm && c.s.intake.includes(dm);
};

// ---------- автодополнение номера дела ----------

async function onAutocomplete(c: C): Promise<Reply> {
  const items = await c.repo.openMain(25);
  const seen = new Set<number>();
  const choices = items
    .filter((o) => !seen.has(o.item_id) && seen.add(o.item_id))
    .map((o) => ({ name: `#${o.item_id} ${o.title}`.slice(0, 100), value: o.item_id }));
  return { type: 8, data: { choices } };
}

// ---------- кнопки и меню ----------

/** Заново собрать сообщение «Записано …» по данным из базы. */
function confirmFor(c: C, occ: OccView): MessageBody {
  const recipe = parseRecipe(occ);
  const leads = occ.rule_leads ? (JSON.parse(occ.rule_leads) as number[]) : [];
  const spec = parseSpec(occ.item_ladder) ?? c.s.defaultLadder;
  const timer = occ.item_kind === "timer";
  return confirmMessage({
    occId: occ.id,
    itemId: occ.item_id,
    title: occ.title,
    whenText: occ.due_at ? formatWhen(occ.due_at, c.now, c.s.tz) : "без срока",
    recur: recipe ? describeRecipe(recipe, c.s.tz) : null,
    lead: leads.length ? describeLead(leads) : null,
    ladderText: timer ? "один раз на срабатывание" : describeSpec(spec),
    ladderKey: timer ? null : specKey(spec),
  });
}

/** «Сегодня»: сегодня в 19:00, а если уже позже — через час. */
function todayTarget(now: number, tz: string): number {
  const t = nextTimeOfDay(now, 19 * 60, tz);
  return t - now < DAY - 30 * MINUTE ? t : now + 60 * MINUTE;
}

const asOcc = async (c: C, id: string): Promise<OccView | null> => c.repo.getOcc(Number(id));
const gone = (): Reply => update(plainMessage("Это дело уже закрыто или удалено."));

async function onComponent(c: C): Promise<Reply> {
  const [kind, a, b] = String(c.i.data?.custom_id ?? "").split(":");
  const values = (c.i.data?.values as string[] | undefined) ?? [];
  switch (kind) {
    case "done": {
      const occ = await asOcc(c, a);
      if (!occ || occ.state === "done" || occ.state === "cancelled") return gone();
      let line: string | null = null;
      if (c.s.moodOn) line = recordDone(c.mood, occ);
      await c.repo.exec(doneOps(occ, c.now));
      return update(doneMessage(occ.title, c.s.character, occ.id, line));
    }
    case "snz": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      if (needsSnoozeQuestion(occ.snooze_count)) {
        return update(snoozeQuestionMessage({ occId: occ.id, itemId: occ.item_id, title: occ.title, count: occ.snooze_count + 1 }));
      }
      return snoozeTo(c, occ, c.now + Number(b) * MINUTE);
    }
    case "snzat":
      return { type: 9, data: whenModal(`m_snz:${a}`, "Отложить на…").data };
    case "edit": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      const w = occ.due_at !== null && occ.kind === "main" && occ.item_kind !== "timer" && !occ.rule_recipe ? wallOf(occ.due_at, c.s.tz) : null;
      const whenText = w ? `${w.d}.${String(w.mo).padStart(2, "0")} ${fmtHHMM(w.h * 60 + w.mi)}` : null;
      return { type: 9, data: editModal({ occId: occ.id, title: occ.title, whenText, ladderKey: "" }).data };
    }
    case "stop": {
      const item = await c.repo.getItem(Number(a));
      await c.repo.exec(stopSeriesOps(Number(a), c.now));
      return update(plainMessage(`Остановлено: ${item?.title ?? "таймер"}`));
    }
    case "ok": {
      const occ = await asOcc(c, a);
      if (!occ) return gone();
      return update(confirmedMessage({ title: occ.title, whenText: occ.due_at ? formatWhen(occ.due_at, c.now, c.s.tz) : "без срока", itemId: occ.item_id }));
    }
    case "lad": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      const preset = values[0];
      if (preset === "soft" || preset === "standard" || preset === "strong") {
        await c.repo.exec([setLadderOps(occ.item_id, { preset })]);
        return update(confirmFor(c, { ...occ, item_ladder: JSON.stringify({ preset }) }));
      }
      return update(confirmFor(c, occ));
    }
    case "rm":
    case "del": {
      const item = await c.repo.getItem(Number(a));
      await c.repo.exec(cancelItemOps(Number(a), c.now, kind === "del" ? "delete" : "cancel"));
      return update(plainMessage(`${kind === "del" ? "Удалено" : "Отменено"}: ${item?.title ?? "дело"}`));
    }
    case "when": {
      const occ = await asOcc(c, a);
      if (!occ || occ.state !== "draft") return gone();
      const due = quickDue(b, c.now, c.s.tz, c.s.defaultTime);
      if (due === null) return eph("Не понял вариант времени.");
      await c.repo.exec(rescheduleOps(occ, due, c.now));
      return update(confirmFor(c, { ...occ, due_at: due }));
    }
    case "whenat":
      return { type: 9, data: whenModal(`m_when:${a}`, "Когда напомнить?").data };
    case "nosd": {
      const occ = await asOcc(c, a);
      if (!occ) return gone();
      return update(plainMessage(`Сохранено без срока: **${occ.title}** · #${occ.item_id}. Назначить время позже: /snooze ${occ.item_id} завтра 10:00`));
    }
    case "tdy": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      const r = await snoozeTo(c, occ, todayTarget(c.now, c.s.tz), true);
      return r;
    }
    case "split":
      return { type: 9, data: splitModal(Number(a)).data };
    default:
      return onSettingsComponent(c, kind, values);
  }
}

const isOpen = (o: OccView) => ["draft", "planned", "fired", "snoozed", "overdue"].includes(o.state);

async function snoozeTo(c: C, occ: OccView, target: number, resetCount = false): Promise<Reply> {
  const ops: Op[] = [...snoozeOps(occ, target, c.now)];
  if (resetCount) ops.push(updateOcc(occ.id, { snooze_count: 0 }));
  await c.repo.exec(ops);
  return update(snoozedMessage({ occId: occ.id, title: occ.title, whenText: formatWhen(target, c.now, c.s.tz), itemId: occ.item_id }));
}

async function onSettingsComponent(c: C, kind: string, values: string[]): Promise<Reply> {
  const redo = async (ops: Op[], dm?: boolean): Promise<Reply> => {
    if (ops.length) await c.repo.exec(ops);
    const cfg = await c.repo.loadConfig();
    const cc = { ...c, s: cfg.settings, meta: cfg.meta };
    return update(settingsMessage(cfg.settings, c.now, dm ?? (await dmOn(cc))));
  };
  switch (kind) {
    case "s_lad": {
      const p = values[0];
      if (p !== "soft" && p !== "standard" && p !== "strong") return redo([]);
      return redo([setSetting("default_ladder", JSON.stringify({ preset: p }))]);
    }
    case "s_q":
      return redo([setSetting("quiet_enabled", c.s.quietEnabled ? "0" : "1")]);
    case "s_qt":
      return { type: 9, data: quietModal(c.s).data };
    case "s_away":
      return { type: 9, data: awayModal().data };
    case "s_summ":
      return { type: 9, data: summModal(c.s).data };
    case "s_ladn":
      return { type: 9, data: ladderNumsModal().data };
    case "s_light":
      return { type: 9, data: lightModal(c.s).data };
    case "s_char":
      return redo([setSetting("character", c.s.character === "maid" ? "neutral" : "maid")]);
    case "s_mood":
      return redo([setSetting("mood_on", c.s.moodOn ? "0" : "1")]);
    case "s_dm": {
      const on = await dmOn(c);
      let dm = c.meta.get("dm_channel_id");
      const intake = new Set(c.s.intake);
      const ops: Op[] = [];
      if (on && dm) intake.delete(dm);
      else {
        if (!dm) {
          dm = (await c.api.createDm(c.owner)).id;
          ops.push(setMeta("dm_channel_id", dm));
        }
        intake.add(dm);
      }
      ops.push(setSetting("intake", JSON.stringify([...intake])));
      return redo(ops, !on);
    }
    default:
      return eph("Это действие бот не знает.");
  }
}

// ---------- окна ----------

/** Значения полей окна: custom_id -> строка или список (радио и выпадающий список). */
export function modalValues(components: unknown): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node.custom_id === "string") {
      if (typeof node.value === "string") out.set(node.custom_id, node.value);
      else if (Array.isArray(node.values)) out.set(node.custom_id, node.values.map(String));
    }
    if (node.component) walk(node.component);
    if (node.components) walk(node.components);
  };
  walk(components);
  return out;
}

const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

/** Время из окна «На…»: строка важнее быстрого варианта. */
function whenFromModal(c: C, v: Map<string, string | string[]>): { due: number; past: boolean } | "none" | "bad" {
  const text = str(v.get("text"));
  if (text) return parseWhen(text, { now: c.now, tz: c.s.tz, defaultTime: c.s.defaultTime }) ?? "bad";
  const key = str(v.get("quick"));
  if (key && key !== "custom") {
    const due = quickDue(key, c.now, c.s.tz, c.s.defaultTime);
    return due === null ? "bad" : { due, past: false };
  }
  return "none";
}

async function onModal(c: C): Promise<Reply> {
  const [kind, id] = String(c.i.data?.custom_id ?? "").split(":");
  const v = modalValues(c.i.data?.components);
  switch (kind) {
    case "m_snz":
    case "m_when": {
      const occ = await asOcc(c, id);
      if (!occ || !isOpen(occ)) return gone();
      const w = whenFromModal(c, v);
      if (w === "none") return eph("Выберите вариант или впишите время, например «завтра 10:30».");
      if (w === "bad") return eph("Не понял время. Пример: «завтра 10:30» или «через 2 часа».");
      if (w.past) return eph("Это время уже прошло.");
      if (kind === "m_snz" && occ.state !== "draft") return snoozeTo(c, occ, w.due);
      await c.repo.exec(rescheduleOps(occ, w.due, c.now));
      return update(confirmFor(c, { ...occ, due_at: w.due }));
    }
    case "m_edit":
      return editSubmit(c, id, v);
    case "m_split":
      return splitSubmit(c, id, v);
    case "m_quiet": {
      const from = parseHHMM(str(v.get("from")));
      const to = parseHHMM(str(v.get("to")));
      if (from === null || to === null) return eph("Время нужно в виде ЧЧ:ММ, например 23:00.");
      return settingsUpdate(c, [setSetting("quiet_from", fmtHHMM(from)), setSetting("quiet_to", fmtHHMM(to))]);
    }
    case "m_summ":
      return summSubmit(c, v);
    case "m_away": {
      const days = Number(str(v.get("days")));
      if (!Number.isInteger(days) || days < 0 || days > 90) return eph("Нужно число дней от 0 до 90.");
      await setAway(c, days);
      return settingsUpdate(c, []);
    }
    case "m_light": {
      const t = str(v.get("group")).toLowerCase();
      if (t === "" || t === "выкл" || t === "off") return settingsUpdate(c, [setSetting("light", "off")]);
      const g = normalizeGroup(t);
      if (!g) return eph("Нужна группа вроде 3 или 3.1 (от 1 до 6) или слово «выкл».");
      return settingsUpdate(c, [setSetting("light", g)]);
    }
    case "m_ladn": {
      const steps = parseCustomSteps(str(v.get("nums")));
      if (!steps) return eph("Нужны числа (минуты от срока) через пробел, например: 0 10 20 40.");
      const spec: LadderSpec = { custom: steps };
      return settingsUpdate(c, [setSetting("default_ladder", JSON.stringify(spec))]);
    }
    default:
      return eph("Это окно бот не знает.");
  }
}

async function settingsUpdate(c: C, ops: Op[]): Promise<Reply> {
  if (ops.length) await c.repo.exec(ops);
  const cfg = await c.repo.loadConfig();
  const dm = cfg.meta.get("dm_channel_id");
  return update(settingsMessage(cfg.settings, c.now, !!dm && cfg.settings.intake.includes(dm)));
}

async function editSubmit(c: C, id: string, v: Map<string, string | string[]>): Promise<Reply> {
  const occ = await asOcc(c, id);
  if (!occ || !isOpen(occ)) return gone();
  const title = str(v.get("title"));
  if (!title) return eph("Название не может быть пустым.");
  if (detectSecret(title).secret) return eph(SECRET_REPLY);
  const ops: Op[] = [];
  if (title !== occ.title) ops.push(setTitleOps(occ.item_id, title));
  const whenText = str(v.get("when"));
  let due = occ.due_at;
  if (whenText && !occ.rule_recipe && occ.kind === "main") {
    const w = parseWhen(whenText, { now: c.now, tz: c.s.tz, defaultTime: c.s.defaultTime });
    if (!w) return eph("Не понял время. Пример: «завтра 10:30».");
    if (w.past) return eph("Это время уже прошло.");
    ops.push(...rescheduleOps(occ, w.due, c.now));
    due = w.due;
  }
  const ladder = str(v.get("ladder"));
  let spec = parseSpec(occ.item_ladder);
  if (ladder === "soft" || ladder === "standard" || ladder === "strong") spec = { preset: ladder };
  else if (ladder === "custom") {
    const steps = parseCustomSteps(str(v.get("nums")));
    if (!steps) return eph("Для «свои числа» впишите минуты от срока через пробел, например: 0 10 20 40.");
    spec = { custom: steps };
  }
  if (ladder && ladder !== "keep") ops.push(setLadderOps(occ.item_id, spec));
  if (ops.length) await c.repo.exec(ops);
  return update(confirmFor(c, { ...occ, title, due_at: due, item_ladder: spec ? JSON.stringify(spec) : occ.item_ladder }));
}

async function splitSubmit(c: C, id: string, v: Map<string, string | string[]>): Promise<Reply> {
  const occ = await asOcc(c, id);
  if (!occ || !isOpen(occ)) return gone();
  const lines = str(v.get("steps"))
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (lines.length === 0) return eph("Впишите хотя бы один шаг.");
  if (lines.some((l) => detectSecret(l).secret)) return eph(SECRET_REPLY);
  const target = todayTarget(c.now, c.s.tz);
  const ops: Op[] = [];
  const titles: string[] = [];
  for (const line of lines) {
    const parsed = parseInput(line, { now: c.now, tz: c.s.tz, defaultTime: c.s.defaultTime });
    if (!parsed.title) continue;
    if (parsed.due === null || parsed.past) parsed.due = target;
    ops.push(...newItemOps({ parsed, source: "slash", settings: c.s, now: c.now }).ops);
    titles.push(parsed.title);
  }
  if (titles.length === 0) return eph("Не нашёл ни одного шага.");
  ops.push(...cancelItemOps(occ.item_id, c.now, "split"));
  await c.repo.exec(ops);
  return update(plainMessage(`Разбито на шаги (${titles.length}): ${titles.join("; ")}. Время — ${formatWhen(target, c.now, c.s.tz)}, поменять: /snooze.`));
}

async function summSubmit(c: C, v: Map<string, string | string[]>): Promise<Reply> {
  const ops: Op[] = [];
  const errors: string[] = [];
  const timeOrOff = (raw: string, label: string, key: string) => {
    const t = raw.toLowerCase();
    if (t === "" || t === "выкл" || t === "off") return void ops.push(setSetting(key, "off"));
    const m = parseHHMM(raw);
    if (m === null) return void errors.push(`${label}: нужно ЧЧ:ММ или «выкл»`);
    ops.push(setSetting(key, fmtHHMM(m)));
  };
  timeOrOff(str(v.get("morning")), "Утренняя сводка", "summary_morning");
  timeOrOff(str(v.get("evening")), "Вечерняя сводка", "summary_evening");
  const weekly = str(v.get("weekly")).toLowerCase();
  if (weekly === "" || weekly === "выкл" || weekly === "off") ops.push(setSetting("weekly", "off"));
  else {
    const m = /^(\S+)\s+(\d{1,2}[:.]\d{2})$/.exec(weekly);
    const dow = m ? WD_BY_NAME[m[1]] : undefined;
    const at = m ? parseHHMM(m[2]) : null;
    if (dow && at !== null) ops.push(setSetting("weekly", `${dow}@${fmtHHMM(at)}`));
    else errors.push("Итоги недели: например «воскресенье 19:00» или «выкл»");
  }
  const tz = str(v.get("tz"));
  if (tz) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      ops.push(setSetting("tz", tz));
    } catch {
      errors.push("Часовой пояс: нужно название вроде Europe/Kyiv");
    }
  }
  if (errors.length) return eph(errors.join("\n"));
  return settingsUpdate(c, ops);
}

