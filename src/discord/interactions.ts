// Обработчик взаимодействий Discord: команды, кнопки, меню и окна. Всё, что бот делает по нажатию пользователя.
// Ответ нужен за 3 секунды: быстрые действия отвечают сразу, долгие (/setup) — «отложенным» ответом и правкой потом.
import { type Repo, deleteMeta, setMeta, setSetting, updateOcc } from "../db/repo.ts";
import { parseWaterWords } from "../water.ts";
import type { OccView, Op, Source } from "../db/types.ts";
import type { AiBinding } from "../llm.ts";
import { EMPTY_REPLY, EMPTY_SERIES_REPLY, NOT_RECURRING_REPLY, SECRET_REPLY, createFromText } from "../intake.ts";
import { tired } from "../flavor.ts";
import { MoodSession, makeCtx, reactionLine, recordDone, recordedLine, resetOps } from "../personality/director.ts";
import { QUIET_META_KEY, isQuietNow } from "../personality/day.ts";
import type { Situation } from "../personality/phrases.ts";
import { LIVE_TIMEOUT_INTERACTION_MS } from "../personality/liveLines.ts";
import { MOODS, type Mood, isMood } from "../personality/moodEngine.ts";
import { MOOD_CONFIG } from "../personality/config.ts";
import { moodReport } from "../personality/report.ts";
import { maidEmbed, wantSprite } from "../personality/look.ts";
import { parseStyle, styleToSettings } from "../personality/animeStyle.ts";
import { glossaryReport, styleReport } from "../personality/styleReport.ts";
import { SNOOZE_TEASE_AT, describeSpec, needsSnoozeQuestion, parseCustomSteps, parseSpec, type LadderSpec } from "../ladder.ts";
import { fetchYasno, lightFullText, normalizeGroup } from "../light.ts";
import { newPowerKey, readPower } from "../power.ts";
import { type AnimeCtx, handleAddModal, handleAnimeButton, handleEpModal } from "../anime/handlers.ts";
import { listAnime } from "../anime/store.ts";
import { animeListMessage, weekAnimeText } from "../anime/ui.ts";
import { detectSecret } from "../secrets.ts";
import { META_KEY as PASSPORT_KEY, SILENT_BOT_TEXT, parsePassport, statusText } from "../sources.ts";
import {
  cancelItemOps,
  doneOps,
  newItemOps,
  notNeededOps,
  parseRecipe,
  rescheduleOps,
  setLadderOps,
  setPlainOps,
  setTitleOps,
  snoozeOps,
  stopSeriesOps,
  touchOps,
  unfreezeOps,
} from "../service.ts";
import { type AppSettings, timeOpts } from "../settings.ts";
import { describeLead, describeRecipe, formatWhen } from "../time/format.ts";
import { normalizeEvery, parseInput, parseWhen } from "../time/parse.ts";
import { quickDue } from "../time/quick.ts";
import { DAY, MINUTE, fmtHHMM, nextTimeOfDay, parseHHMM, wallOf } from "../time/tz.ts";
import { LIGHT_ASK_BUTTON_PREFIX } from "../lightAsk.ts";
import {
  type ListFilter,
  type Section,
  addModal,
  recentMessage,
  cardMessage,
  confirmDeleteMessage,
  confirmResetMessage,
  homeMessage,
  homeStats,
  infoMessage,
  isFilter,
  isSection,
  listMessage,
  menuPhrase,
  moreMessage,
  nextKaomoji,
  nextSfx,
  panelMessage,
  resultMessage,
  sectionMessage,
  settingsHomeMessage,
  statusMessage,
  withNav,
} from "./menu.ts";
import type { DiscordApi, MessageBody } from "./types.ts";
import {
  awayModal,
  confirmMessage,
  confirmedMessage,
  doneMessage,
  editModal,
  ladderNumsModal,
  dayWordsModal,
  lightModal,
  waterModal,
  gasModal,
  listText,
  plainMessage,
  withLine,
  quietModal,
  reminderButtons,
  snoozeChoiceRow,
  snoozeQuestionMessage,
  snoozedMessage,
  specKey,
  splitModal,
  subtext,
  summModal,
  summaryParts,
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
  /** привязка Workers AI (env.AI) для понимания фраз; необязательна */
  ai?: AiBinding;
}

type Reply = Record<string, unknown>;

/** Реплика Хару к короткому ответу бота; без «Настроения» или на серьёзных/«Без стиля» делах — null. */
const react = (c: { s: AppSettings; mood: MoodSession }, sit: Situation, o: { title: string; critical?: number | boolean; plain?: number | boolean; item_id?: number; id?: number }): Promise<string | null> =>
  c.s.moodOn ? reactionLine(c.mood, sit, { ...o, itemId: o.item_id ?? o.id }) : Promise.resolve(null);
const msg = (body: MessageBody): Reply => ({ type: 4, data: body });
const eph = (text: string): Reply => msg({ ...plainMessage(text, true) });
/** Ответ-обновление сообщения: прежняя карточка горничной (embed) убирается, если новый текст её не задаёт. */
const update = (body: MessageBody): Reply => ({ type: 7, data: { embeds: [], ...body } });

/** «Тихий день» идёт: до какого времени (для /mood); иначе null. */
const quietText = (c: { meta: Map<string, string>; now: number; s: AppSettings }): string | null =>
  isQuietNow(c.meta.get(QUIET_META_KEY), c.now) ? formatWhen(Number(c.meta.get(QUIET_META_KEY)), c.now, c.s.tz) : null;

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
  if (ctx.env.origin && meta.get("public_origin") !== ctx.env.origin) {
    await ctx.repo.exec([setMeta("public_origin", ctx.env.origin)]);
    meta.set("public_origin", ctx.env.origin);
  }

  // настроение: любое действие хозяина (команда, кнопка, окно) — активность; состояние читаем, только если включено
  const mood = new MoodSession({
    repo: ctx.repo, userId: owner, ctx: makeCtx(ctx.now, s), rand: ctx.rand, style: s.style,
    live: s.liveOn && ctx.ai ? { ai: ctx.ai, tz: s.tz, timeoutMs: LIVE_TIMEOUT_INTERACTION_MS } : null,
  });
  if (isQuietNow(meta.get(QUIET_META_KEY), ctx.now)) mood.silent = true; // «тихий день»: Хару молчит совсем (приписки характера — ниже, в `c`)
  let returnLine: string | null = null;
  if (s.moodOn && (i.type === 2 || i.type === 3 || i.type === 5)) {
    await mood.load();
    if (mood.apply({ type: "activity" }).returned) returnLine = await mood.sayLive("return_after_pause");
  }
  // «тихий день»: приписки «уставшей горничной» тоже молчат (как нейтральный характер); настоящее значение нужно только кнопке переключения
  const quiet = isQuietNow(meta.get(QUIET_META_KEY), ctx.now);
  const c: C = { ...ctx, s: quiet && s.character !== "neutral" ? { ...s, character: "neutral" } : s, realCharacter: s.character, meta, owner, i, mood };
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
  /** характер, записанный в настройках (на «тихий день» `s.character` временно нейтральный) */
  realCharacter: AppSettings["character"];
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

async function createReply(
  c: C,
  text: string,
  source: Source,
  extra: { body?: string; requireRecurring?: boolean; /** как показать готовую запись (по умолчанию — как команду) */ wrap?: (b: MessageBody) => Reply } = {},
): Promise<Reply> {
  const r = await createFromText(
    {
      repo: c.repo,
      settings: c.s,
      now: c.now,
      ai: c.ai,
      aiTimeoutMs: 1500,
      drafted: (title, critical) => react(c, "draft", { title, critical }),
      recorded: async (title, critical) => {
        const line = c.s.moodOn ? await recordedLine(c.mood, title, critical) : null;
        return line && c.mood.state ? { line, look: { mood: c.mood.state.mood, origin: spriteOrigin(c), sprite: wantSprite(c.mood.rand, c.mood.cinema) } } : null;
      },
    },
    text,
    source,
    { body: extra.body, requireRecurring: extra.requireRecurring },
  );
  switch (r.kind) {
    case "created":
      return extra.wrap ? extra.wrap(r.message) : out(c, r.message);
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
    case "list": {
      const open = await c.repo.openMain(50);
      // пустой список: реплика Хару (моделью или готовой фразой) вместо старой «усталой» приписки, чтобы не было двух подряд
      if (open.length === 0 && c.s.moodOn && c.mood.loaded && c.mood.rand() < 0.8) {
        const line = await c.mood.sayLive("empty_list", { facts: "список дел пуст" });
        if (line) return eph(`${listText(open, c.now, c.s.tz, "neutral")}\n${line}`);
      }
      return eph(listText(open, c.now, c.s.tz, c.s.character));
    }
    case "week":
      return eph(await weekWithAnime(c));
    case "cancel": {
      const item = await c.repo.getItem(Number(opt(c, "id")));
      if (!item || item.archived_at) return eph("Такого дела нет (или оно уже закрыто). Номера — в /list.");
      await c.repo.exec(cancelItemOps(item.id, c.now));
      return eph(withLine(`Отменено: ${item.title}`, await react(c, "cancelled", item)));
    }
    case "snooze":
      return slashSnooze(c);
    case "settings":
      return settingsReply(c);
    case "away": {
      const days = opt(c, "days");
      if (days === undefined) {
        return eph(c.s.awayUntil > c.now ? `Вы в отъезде до ${formatWhen(c.s.awayUntil, c.now, c.s.tz)}. Вернуться сейчас: ⚙ Настройки → Тишина → «Я в отъезде…» (0).` : "Вы не в отъезде. Включить: ⚙ Настройки → Тишина → «Я в отъезде…».");
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
    case "menu":
      return menuCommand(c);
    default:
      return eph("Такой команды бот не знает.");
  }
}

/** /power: ссылки для телефона. Видны только хозяину («только вам»); ключ не попадает ни в журнал, ни в чат. */
/** /light: график отключений на сегодня и завтра для группы из настроек и «что сейчас». Запрос к Yasno — после ответа Discord (до 5 секунд). */
async function lightCommand(c: C): Promise<Reply> {
  if (!c.s.lightGroup) return eph("Группа света не задана: /settings → «Свет: группа…» → впишите номер (например, 3).");
  return lightReply(c, (t) => plainMessage(t, true), { type: 5, data: { flags: 64 } });
}

/** График света: сразу `first` (ответ-ожидание), потом правка исходного сообщения готовым видом `wrap(текст)`. */
function lightReply(c: C, wrap: (text: string) => MessageBody, first: Reply): Reply {
  const group = c.s.lightGroup as string;
  c.defer(
    (async () => {
      const data = await fetchYasno(c.fetchFn ?? fetch);
      const text = lightFullText(c.now, c.s.tz, group, data);
      if (c.i.application_id) await c.api.editInteractionOriginal(c.i.application_id, c.i.token, wrap(text)).catch(() => undefined);
    })(),
  );
  return first;
}

/** «Только вам» (64) и без предпросмотра ссылок (4): Discord не должен сам открывать ссылки с ключом. */
const powerReply = (text: string): Reply => msg({ ...plainMessage(text, true), flags: 68 });

async function powerCommand(c: C, forceReset = false): Promise<Reply> {
  const reset = forceReset || (opt(c, "reset") as unknown) === true;
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
      "Ключ в ссылках — как пароль: никому не показывайте и не пересылайте. Если ссылка утекла — ⚙ Настройки → Сводки и свет → «Новый ключ», и впишите новые в приложение.",
      state,
    ].join("\n"),
  );
}

async function slashSnooze(c: C): Promise<Reply> {
  const occ = await c.repo.openMainOfItem(Number(opt(c, "id")));
  if (!occ) return eph("Открытого дела с таким номером нет. Номера — в /list.");
  const text = opt(c, "when");
  const when = text ? parseWhen(String(text), { now: c.now, ...timeOpts(c.s) }) : { due: c.now + 60 * MINUTE, past: false };
  if (!when) return eph("Не понял время. Пример: «завтра 10:30» или «через 2 часа».");
  if (when.past) return eph("Это время уже прошло.");
  await c.repo.exec(occ.state === "draft" ? rescheduleOps(occ, when.due, c.now) : snoozeOps(occ, when.due, c.now));
  if (occ.last_message_id && occ.last_channel_id) {
    const body = snoozedMessage({ occId: occ.id, title: occ.title, whenText: formatWhen(when.due, c.now, c.s.tz), itemId: occ.item_id });
    c.defer(c.api.editMessage(occ.last_channel_id, occ.last_message_id, body).catch(() => undefined));
  }
  return eph(withLine(`Отложено: ${occ.title} — до ${formatWhen(when.due, c.now, c.s.tz)}`, await react(c, "snoozed", occ)));
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
        for (const name of ["почта", "бот", "сегодня"]) {
          // канал напоминаний с 2026-11-08 называется «почта»; прежнее имя «напоминания» тоже узнаём (чтобы не заводить второй)
          const names = name === "почта" ? ["почта", "напоминания"] : [name];
          const found = names.map((n) => existing.find((ch) => ch.type === 0 && ch.name === n)).find(Boolean);
          if (found) ids[name] = found.id;
          else {
            ids[name] = (await c.api.createChannel(guildId, { name, type: 0 })).id;
            created.push(name);
          }
        }
        const intake = new Set(c.s.intake);
        intake.add(ids["бот"]);
        await c.repo.exec([
          setSetting("ch_remind", ids["почта"]),
          setSetting("ch_bot", ids["бот"]),
          setSetting("ch_today", ids["сегодня"]),
          setSetting("intake", JSON.stringify([...intake])),
          setMeta("guild_id", guildId),
        ]);
        text = `Готово. Каналы: <#${ids["почта"]}> (почта: напоминания и сводки), <#${ids["бот"]}> (пишите сюда обычным текстом), <#${ids["сегодня"]}> (панель «Горит»).${created.length ? ` Создано: ${created.join(", ")}.` : " Все каналы уже были."}${tired(c.s.character, "setupDone") ? `\n-# ${tired(c.s.character, "setupDone")}` : ""}`;
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

/** Ответ командой /mood: карточка цвета настроения со спрайтом (видна только хозяину). */
function moodCard(c: C, text: string, header?: string): Reply {
  return msg({ ...moodBody(c, text, header), flags: 64 });
}

function moodBody(c: C, text: string, header?: string): MessageBody {
  return {
    ...(header ? { content: header } : {}),
    embeds: [maidEmbed({ mood: c.mood.state!.mood, text, origin: spriteOrigin(c), sprite: true })],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

async function moodCommand(c: C): Promise<Reply> {
  const set = opt(c, "set");
  await c.mood.load();
  if (opt(c, "show") === "cinema") {
    const text = c.mood.forceCinema("reminder", { task: "позвонить маме" });
    return moodCard(c, text, "Пример «кино-момента». Настоящие бывают редко: на уровне 3 примерно в каждом 60-м напоминании и не чаще раза в сутки.");
  }
  if (set !== undefined) {
    if (!isMood(set)) return eph(`Такого настроения нет. Бывают: ${MOODS.join(", ")}.`);
    c.mood.force(set as Mood);
    return moodCard(c, moodReport({ state: c.mood.state!, enabled: c.s.moodOn, quietUntil: quietText(c) }), `Настроение задано вручную: ${set}. Оно сменится само, когда числа и время скажут иначе.`);
  }
  return moodCard(c, moodReport({ state: c.mood.state!, enabled: c.s.moodOn, greeting: c.mood.say("greeting"), quietUntil: quietText(c) }));
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
  if (mode === undefined) return eph(`Подсказки перевода: ${c.s.style.hints ? "включены" : "выключены"}. Они показываются первые 2 раза у каждого слова. Менять: ⚙ Настройки → Характер → Стиль речи.`);
  await c.repo.exec([setSetting("hints_on", mode === "on" ? "1" : "0")]);
  return eph(mode === "on" ? "Подсказки перевода включены: новые слова будут с переводом в скобках (первые 2 раза)." : "Подсказки перевода выключены. Слова остаются в ⚙ Настройки → Ещё → «Слова Хару».");
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
  return `Горничная на выходном до ${formatWhen(until, c.now, c.s.tz)}: напоминаний не будет, дела сохранятся. Вернуться раньше: ⚙ Настройки → Тишина → «Я в отъезде…» (0).`;
}

async function settingsReply(c: C): Promise<Reply> {
  return msg({ ...settingsHomeMessage(c.s, c.now), flags: 64 });
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
    ladderText: occ.item_ladder ? (timer ? undefined : describeSpec(spec)) : undefined,
  });
}

/** «Сегодня»: сегодня вечером (по часам хозяина, по умолчанию 19:00), а если уже позже — через час. */
function todayTarget(now: number, tz: string, evening = 19 * 60): number {
  const t = nextTimeOfDay(now, evening, tz);
  return t - now < DAY - 30 * MINUTE ? t : now + 60 * MINUTE;
}

const asOcc = async (c: C, id: string): Promise<OccView | null> => c.repo.getOcc(Number(id));
/** Адрес Worker для спрайтов: из запроса или из записанного прежде. */
const spriteOrigin = (c: C): string | null => c.env.origin ?? c.meta.get("public_origin") ?? null;

const gone = (): Reply => update(plainMessage("Это дело уже закрыто или удалено."));

async function onComponent(c: C): Promise<Reply> {
  const parts = String(c.i.data?.custom_id ?? "").split(":");
  const [kind, a, b] = parts;
  const values = (c.i.data?.values as string[] | undefined) ?? [];
  if (kind === "mn" || kind === "pn") return onMenu(c, parts, values);
  if (kind === "an") return (await handleAnimeButton(animeCtx(c), parts)) ?? eph("Эта кнопка устарела.");
  switch (kind) {
    case "done": {
      const occ = await asOcc(c, a);
      if (!occ || occ.state === "done" || occ.state === "cancelled") return gone();
      let line: string | null = null;
      if (c.s.moodOn) line = await recordDone(c.mood, occ);
      await c.repo.exec(doneOps(occ, c.now));
      const look = line && c.mood.state ? { mood: c.mood.state.mood, origin: spriteOrigin(c), sprite: wantSprite(c.mood.rand, c.mood.cinema) } : null;
      return update(doneMessage(occ.title, c.s.character, occ.id, line, look));
    }
    case "snz": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      if (needsSnoozeQuestion(occ.snooze_count)) {
        const line = occ.snooze_count + 1 >= SNOOZE_TEASE_AT ? await react(c, "snooze_5", occ) : null;
        return update(snoozeQuestionMessage({ occId: occ.id, itemId: occ.item_id, title: occ.title, count: occ.snooze_count + 1, line }));
      }
      return snoozeTo(c, occ, c.now + Number(b) * MINUTE);
    }
    case "snzm": {
      // «Отложить»: вместо трёх кнопок — быстрые варианты (текст и карточку Discord оставляет как есть)
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      return { type: 7, data: { components: [snoozeChoiceRow(occ.id)] } };
    }
    case "snzb": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      return { type: 7, data: { components: [{ type: 1, components: reminderButtons(occ) }] } };
    }
    case "sumall": {
      // «Показать всё» под сводкой: полный список отдельным сообщением «только вам» (свет и прочее остаются в самой сводке)
      const kind = a === "evening" || a === "return" ? a : "morning";
      const items = await c.repo.openMain(100);
      const parts = summaryParts(kind, { items, now: c.now, tz: c.s.tz, ownerId: c.owner ?? "", character: c.s.character, full: true });
      return eph(parts.text);
    }
    case "snzat":
      return { type: 9, data: whenModal(`m_snz:${a}`, "Отложить на…").data };
    case "edit": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      const w = occ.due_at !== null && occ.kind === "main" && occ.item_kind !== "timer" && !occ.rule_recipe ? wallOf(occ.due_at, c.s.tz) : null;
      const whenText = w ? `${String(w.mo).padStart(2, "0")}.${String(w.d).padStart(2, "0")} ${fmtHHMM(w.h * 60 + w.mi)}` : null;
      return { type: 9, data: editModal({ occId: occ.id, title: occ.title, whenText, ladderKey: "", plain: occ.plain === 1 }).data };
    }
    case "stop": {
      const item = await c.repo.getItem(Number(a));
      await c.repo.exec(stopSeriesOps(Number(a), c.now));
      return update(plainMessage(withLine(`Остановлено: ${item?.title ?? "таймер"}`, item ? await react(c, "stopped", item) : null)));
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
        await c.repo.exec([setLadderOps(occ.item_id, { preset }), touchOps(occ.item_id, c.now)]);
        return update(confirmFor(c, { ...occ, item_ladder: JSON.stringify({ preset }) }));
      }
      return update(confirmFor(c, occ));
    }
    case "rm":
    case "del": {
      const item = await c.repo.getItem(Number(a));
      await c.repo.exec(cancelItemOps(Number(a), c.now, kind === "del" ? "delete" : "cancel"));
      const sayLine = item ? await react(c, kind === "del" ? "deleted" : "cancelled", item) : null;
      return update(plainMessage(withLine(`${kind === "del" ? "Удалено" : "Отменено"}: ${item?.title ?? "дело"}`, sayLine)));
    }
    case "when": {
      const occ = await asOcc(c, a);
      if (!occ || occ.state !== "draft") return gone();
      const due = quickDue(b, c.now, c.s.tz, c.s.wordMorning, c.s.wordEvening);
      if (due === null) return eph("Не понял вариант времени.");
      await c.repo.exec(rescheduleOps(occ, due, c.now));
      return update(confirmFor(c, { ...occ, due_at: due }));
    }
    case "whenat":
      return { type: 9, data: whenModal(`m_when:${a}`, "Когда напомнить?").data };
    case "nosd": {
      const occ = await asOcc(c, a);
      if (!occ) return gone();
      return update(plainMessage(`Сохранено без срока: **${occ.title}** · #${occ.item_id}. Назначить время позже: /menu → Все дела → дело → «На…».`));
    }
    case "tdy": {
      const occ = await asOcc(c, a);
      if (!occ || !isOpen(occ)) return gone();
      const r = await snoozeTo(c, occ, todayTarget(c.now, c.s.tz, c.s.wordEvening), true);
      return r;
    }
    case "split":
      return { type: 9, data: splitModal(Number(a)).data };
    case "ldo": {
      // «Это было дело»: фразу, которую приняли за вопрос про свет, записываем как обычное дело (текст — в самой кнопке)
      const text = String(c.i.data?.custom_id ?? "").slice(LIGHT_ASK_BUTTON_PREFIX.length).trim();
      if (!text) return gone();
      return createReply(c, text, "channel", { wrap: (b) => update(b) });
    }
    default:
      return eph("Это действие бот не знает.");
  }
}

const isOpen = (o: OccView) => ["draft", "planned", "fired", "snoozed", "overdue"].includes(o.state);
const isFrozen = (o: OccView) => o.state === "cancelled" && o.closed_reason === "frozen";

async function snoozeTo(c: C, occ: OccView, target: number, resetCount = false): Promise<Reply> {
  const ops: Op[] = [...snoozeOps(occ, target, c.now)];
  if (resetCount) ops.push(updateOcc(occ.id, { snooze_count: 0 }));
  await c.repo.exec(ops);
  return update(snoozedMessage({ occId: occ.id, title: occ.title, whenText: formatWhen(target, c.now, c.s.tz), itemId: occ.item_id, line: await react(c, occ.snooze_count + 1 >= SNOOZE_TEASE_AT ? "snooze_5" : "snoozed", occ) }));
}

/** Включить или выключить приём дел в личке: какие записи сделать и каким станет состояние. */
async function dmToggle(c: C): Promise<{ ops: Op[]; on: boolean }> {
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
  return { ops, on: !on };
}

// ---------- кнопочное меню (экраны — menu.ts) ----------

/** /menu: главный экран «только вам»; с panel:True — закреплённая панель в канале «бот» (правится, если уже есть). */
async function menuCommand(c: C): Promise<Reply> {
  if ((opt(c, "panel") as unknown) !== true) return msg({ ...homeMessage(homeStats(await c.repo.openMain(100), c.now, c.s.tz)), flags: 64 });
  const ch = c.s.chBot;
  if (!ch) return eph("Канала «бот» ещё нет: выполните /setup на сервере.");
  const oldId = c.meta.get("menu_panel_id");
  if (oldId) {
    try {
      await c.api.editMessage(ch, oldId, panelMessage());
      return eph("Панель в канале «бот» обновлена.");
    } catch {
      /* сообщения нет (удалено) — пошлём новое */
    }
  }
  let sent: { id: string };
  try {
    sent = await c.api.postMessage(ch, panelMessage());
  } catch {
    return eph("Не получилось поставить панель в канал «бот». Проверьте, что у бота есть право писать туда.");
  }
  await c.repo.exec([setMeta("menu_panel_id", sent.id)]);
  let pinned = true;
  try {
    await c.api.pinMessage(ch, sent.id);
  } catch {
    pinned = false;
  }
  return eph(pinned ? "Панель поставлена в канал «бот» и закреплена." : "Панель поставлена в канал «бот». Закрепить не вышло (нет права «Закреплять сообщения») — закрепите вручную: ••• → Закрепить.");
}

/** Аниме: общий контекст для кнопок и окон. */
const animeCtx = (c: C): AnimeCtx => ({ repo: c.repo, now: c.now, tz: c.s.tz, character: c.s.character, fetchFn: c.fetchFn ?? fetch, rand: c.rand });

/** Неделя: дела и строка про аниме (что выходит). */
async function weekWithAnime(c: C): Promise<string> {
  const base = weekText(await c.repo.openMain(100), c.now, c.s.tz, c.s.character);
  const anime = weekAnimeText(await listAnime(c.repo), c.now, c.s.tz);
  return anime ? `${base}

${anime}` : base;
}

/** Добавить строку навигации к ответу-обновлению (если это обновление сообщения). */
function navReply(r: Reply): Reply {
  if (r.type !== 7) return r;
  const data = r.data as MessageBody;
  return { ...r, data: withNav(data) };
}

/**
 * Кнопки меню. `mn:…` — внутри сообщения «только вам» (обновляем его), `pn:…` — закреплённая панель (каждый экран — новое
 * сообщение «только вам», сама панель не меняется). Маршруты и аргументы — как в menu.ts.
 */
async function onMenu(c: C, parts: string[], values: string[]): Promise<Reply> {
  const panel = parts[0] === "pn";
  const route = parts[1] ?? "home";
  const arg = parts.slice(2);
  const show = (b: MessageBody): Reply => (panel ? msg({ ...b, flags: 64 }) : update(b));
  const filterOf = (x: string | undefined): ListFilter => (x !== undefined && isFilter(x) ? x : "a");
  const pageOf = (x: string | undefined): number => Math.max(0, Number.parseInt(x ?? "0", 10) || 0);
  const gonePage = (f: ListFilter, p: number): Reply => show(resultMessage("Это дело уже закрыто или удалено.", f, p));
  const sectionScreen = async (sec: Section, cfg?: { settings: AppSettings; meta: Map<string, string> }): Promise<Reply> => {
    const s = cfg?.settings ?? c.s;
    const dm = cfg ? (() => { const id = cfg.meta.get("dm_channel_id"); return !!id && s.intake.includes(id); })() : await dmOn(c);
    return show(sectionMessage(s, sec, c.now, dm));
  };

  switch (route) {
    case "home":
      return show(homeMessage(homeStats(await c.repo.openMain(100), c.now, c.s.tz)));
    case "ls": {
      const f = filterOf(arg[0]);
      // «Заморожено» (этап 3) — замороженные дела; остальные экраны — открытые
      return show(listMessage(f === "z" ? await c.repo.frozenMain(100) : await c.repo.openMain(100), f, pageOf(arg[1]), c.now, c.s.tz));
    }
    case "it": {
      const f = filterOf(arg[1]);
      const p = pageOf(arg[2]);
      const occ = await asOcc(c, arg[0]);
      if (!occ || !(f === "z" ? isFrozen(occ) : isOpen(occ))) return gonePage(f, p);
      return show(cardMessage(occ, f, p, c.now, c.s.tz, describeSpec(parseSpec(occ.item_ladder) ?? c.s.defaultLadder)));
    }
    case "dn": {
      const f = filterOf(arg[1]);
      const p = pageOf(arg[2]);
      const occ = await asOcc(c, arg[0]);
      if (!occ || !isOpen(occ)) return gonePage(f, p);
      const line = c.s.moodOn ? await recordDone(c.mood, occ) : null;
      await c.repo.exec(doneOps(occ, c.now));
      const look = line && c.mood.state ? { mood: c.mood.state.mood, origin: spriteOrigin(c), sprite: wantSprite(c.mood.rand, c.mood.cinema) } : null;
      const done = doneMessage(occ.title, c.s.character, occ.id, line, look);
      return show({ ...done, components: [resultMessage("", f, p).components![0]] });
    }
    case "nn": {
      // «Не нужно» в разборе давнего (этап 3): закрывает это срабатывание; повторяющееся дело живёт дальше
      const f = filterOf(arg[1]);
      const p = pageOf(arg[2]);
      const occ = await asOcc(c, arg[0]);
      if (!occ || !isOpen(occ)) return gonePage(f, p);
      await c.repo.exec(notNeededOps(occ, c.now));
      return show(resultMessage(`Закрыто как ненужное: **${occ.title}**${occ.rule_recipe ? ". Повтор остаётся, следующие повторения придут." : "."}`, f, p));
    }
    case "fv": {
      // «Вернуть» замороженное (этап 3): дело снова «висит» как было
      const f = filterOf(arg[1]);
      const p = pageOf(arg[2]);
      const occ = await asOcc(c, arg[0]);
      if (!occ || !isFrozen(occ)) return gonePage(f, p);
      await c.repo.exec(unfreezeOps(occ, c.now));
      return show(resultMessage(`Вернула: **${occ.title}**. Оно снова в «Висит», как было.`, f, p));
    }
    case "sz": {
      const f = filterOf(arg[2]);
      const p = pageOf(arg[3]);
      const occ = await asOcc(c, arg[0]);
      if (!occ || !isOpen(occ)) return gonePage(f, p);
      const due = quickDue(arg[1] ?? "", c.now, c.s.tz, c.s.wordMorning, c.s.wordEvening);
      if (due === null) return eph("Не понял вариант времени.");
      await c.repo.exec(occ.state === "draft" ? rescheduleOps(occ, due, c.now) : snoozeOps(occ, due, c.now));
      return show(resultMessage(withLine(`Отложено: **${occ.title}** — до ${formatWhen(due, c.now, c.s.tz)}`, await react(c, "snoozed", occ)), f, p));
    }
    case "sa": {
      const occ = await asOcc(c, arg[0]);
      if (!occ || !isOpen(occ)) return gonePage(filterOf(arg[1]), pageOf(arg[2]));
      const m = whenModal(`m_snz:${occ.id}:mn`, "Отложить на…");
      return { type: 9, data: m.data };
    }
    case "ed": {
      const occ = await asOcc(c, arg[0]);
      if (!occ || !isOpen(occ)) return gonePage(filterOf(arg[1]), pageOf(arg[2]));
      const w = occ.due_at !== null && occ.kind === "main" && occ.item_kind !== "timer" && !occ.rule_recipe ? wallOf(occ.due_at, c.s.tz) : null;
      const whenText = w ? `${String(w.mo).padStart(2, "0")}.${String(w.d).padStart(2, "0")} ${fmtHHMM(w.h * 60 + w.mi)}` : null;
      const m = editModal({ occId: occ.id, title: occ.title, whenText, ladderKey: "", plain: occ.plain === 1 });
      return { type: 9, data: { ...m.data, custom_id: `m_edit:${occ.id}:mn` } };
    }
    case "sp": {
      const item = await c.repo.getItem(Number(arg[0]));
      if (!item || item.archived_at) return gonePage(filterOf(arg[1]), pageOf(arg[2]));
      await c.repo.exec(stopSeriesOps(item.id, c.now));
      return show(resultMessage(withLine(`Повтор остановлен: **${item.title}**`, await react(c, "stopped", item)), filterOf(arg[1]), pageOf(arg[2])));
    }
    case "dl": {
      const item = await c.repo.getItem(Number(arg[0]));
      const f = filterOf(arg[2]);
      const p = pageOf(arg[3]);
      if (!item || item.archived_at) return gonePage(f, p);
      return show(confirmDeleteMessage(item.title, item.id, Number(arg[1]), f, p));
    }
    case "dy": {
      const item = await c.repo.getItem(Number(arg[0]));
      const f = filterOf(arg[1]);
      const p = pageOf(arg[2]);
      if (!item || item.archived_at) return gonePage(f, p);
      await c.repo.exec(cancelItemOps(item.id, c.now, "delete"));
      return show(resultMessage(withLine(`Удалено: **${item.title}**`, await react(c, "deleted", item)), f, p));
    }
    case "add": {
      // галочка «Недавние дела» (C5): сначала три последних кнопками, окно — по «Новое…»
      if (c.s.recentOn) {
        const recent = await c.repo.recentItems(3);
        if (recent.length) return show(recentMessage(recent, panel ? "pn" : "mn"));
      }
      return { type: 9, data: addModal(panel ? "pn" : "mn").data };
    }
    case "addnew":
      return { type: 9, data: addModal(panel ? "pn" : "mn").data };
    case "rc": {
      const item = await c.repo.getItem(Number(arg[0]));
      if (!item || item.archived_at || item.scrubbed_at) return show(resultMessage("Этого дела уже нет в истории: нажмите «Добавить» ещё раз."));
      return createReply(c, item.title, "menu", { wrap: (b) => show(withNav(b)) });
    }
    case "wk":
      return show(resultMessage(await weekWithAnime(c)));
    case "an":
      return show(animeListMessage(await listAnime(c.repo), "watching", 0, c.now, c.s.tz, c.s.character, c.rand));
    case "lt": {
      if (!c.s.lightGroup) return show(resultMessage("Группа света не задана: ⚙ Настройки → 📰 Сводки и свет → «Свет: группа…»."));
      // долгий запрос к Yasno: сначала «ждём», потом правка этого же сообщения
      return lightReply(c, (t) => resultMessage(t), panel ? { type: 5, data: { flags: 64 } } : { type: 6 });
    }
    case "mo": {
      await c.mood.load();
      const text = moodReport({ state: c.mood.state!, enabled: c.s.moodOn, greeting: c.mood.say("greeting"), quietUntil: quietText(c) });
      return show({ ...moodBody(c, text), components: resultMessage("").components });
    }
    case "more":
      return show(moreMessage(panel ? "pn" : "mn", (await c.repo.frozenCount(0)).total));
    case "ss": {
      // «Состояние» (этап 4): паспорт источников; всё берём из меты, которая уже прочитана, — лишних подзапросов нет
      const text = statusText(parsePassport(c.meta.get(PASSPORT_KEY)), { light: !!c.s.lightGroup, water: c.s.waterWords.length > 0, gas: c.s.gasWords.length > 0 }, c.now, c.s.tz);
      return show(statusMessage(text, panel ? "pn" : "mn"));
    }
    case "sq": {
      // текст «если бот молчит» в канал «бот» (A8): один раз пишем и пробуем закрепить; повторное нажатие правит то же сообщение
      const pfx = panel ? "pn" : "mn";
      const back = (t: string): Reply => show(infoMessage(t, `${pfx}:ss`, "◀ К состоянию"));
      const ch = c.s.chBot;
      if (!ch) return back("Канала «бот» ещё нет: выполните /setup на сервере.");
      const body = { content: SILENT_BOT_TEXT, allowed_mentions: { parse: [] as string[] } };
      const oldId = c.meta.get("silent_msg_id");
      if (oldId) {
        try {
          await c.api.editMessage(ch, oldId, body);
          return back("Текст в канале «бот» обновлён. Если он закреплён, закреплённым и останется.");
        } catch {
          /* сообщения нет (удалено) — напишем заново */
        }
      }
      let sent: { id: string };
      try {
        sent = await c.api.postMessage(ch, body);
      } catch {
        return back("Не получилось написать в канал «бот»: проверьте, что у бота есть право писать туда.");
      }
      await c.repo.exec([setMeta("silent_msg_id", sent.id)]);
      let pinned = true;
      try {
        await c.api.pinMessage(ch, sent.id);
      } catch {
        pinned = false;
      }
      return back(pinned ? "Текст поставлен в канал «бот» и закреплён." : "Текст поставлен в канал «бот». Закрепить не вышло (нет права «Закреплять сообщения»): закрепите вручную — ••• → Закрепить.");
    }
    case "pw":
      return powerCommand(c, arg[0] === "new");
    case "gl": {
      await c.mood.load();
      return show(infoMessage(glossaryReport({ state: c.mood.styleState, style: c.s.style }), "mn:s:a"));
    }
    case "rs":
      return show(confirmResetMessage());
    case "ry": {
      await c.repo.exec(resetOps(c.owner));
      c.mood.state = null; // состояние сброшено: сессия больше ничего не пишет
      return show(infoMessage("Готово: настроение, отношение, серии и выученные слова сброшены. Хару начинает с чистого листа.", "mn:s:a"));
    }
    case "sv":
    case "sw": {
      const v = values[0] ?? "";
      const ok = route === "sv" ? ["0", "1", "2", "3"].includes(v) : ["cyrillic", "latin", "mixed"].includes(v);
      if (ok) await c.repo.exec([setSetting(route === "sv" ? "style_level" : "style_script", v)]);
      return sectionScreen("s", await c.repo.loadConfig());
    }
    case "st":
      return show(settingsHomeMessage(c.s, c.now));
    case "s":
      return sectionScreen(isSection(arg[0] ?? "") ? (arg[0] as Section) : "q");
    case "tg": {
      const sec = isSection(arg[1] ?? "") ? (arg[1] as Section) : "q";
      const ops: Op[] = [];
      switch (arg[0]) {
        case "q":
          ops.push(setSetting("quiet_enabled", c.s.quietEnabled ? "0" : "1"));
          break;
        case "ch":
          ops.push(setSetting("character", c.realCharacter === "maid" ? "neutral" : "maid"));
          break;
        case "mo":
          ops.push(setSetting("mood_on", c.s.moodOn ? "0" : "1"));
          break;
        case "llm":
          ops.push(setSetting("llm_on", c.s.llmOn ? "0" : "1"));
          break;
        case "lv":
          ops.push(setSetting("live_on", c.s.liveOn ? "0" : "1"));
          break;
        case "sa":
          ops.push(setSetting("summary_morning", c.s.morning === null ? "08:00" : "off"));
          break;
        case "se":
          ops.push(setSetting("summary_evening", c.s.evening === null ? "20:00" : "off"));
          break;
        case "qh":
          await quiet(c, undefined);
          break;
        case "ho":
          ops.push(setSetting("style_honorifics", c.s.style.honorifics ? "0" : "1"));
          break;
        case "hi":
          ops.push(setSetting("hints_on", c.s.style.hints ? "0" : "1"));
          break;
        case "sx":
          ops.push(setSetting("style_sfx", nextSfx(c.s.style.sfx)));
          break;
        case "km":
          ops.push(setSetting("style_kaomoji", nextKaomoji(c.s.style.kaomoji)));
          break;
        case "dm":
          ops.push(...(await dmToggle(c)).ops);
          break;
        case "rc":
          ops.push(setSetting("recent_on", c.s.recentOn ? "0" : "1"));
          break;
        case "snd":
          ops.push(setSetting("sound_all", c.s.soundAll ? "0" : "1"));
          break;
        default:
          return eph("Это действие бот не знает.");
      }
      await c.repo.exec(ops);
      return sectionScreen(sec, await c.repo.loadConfig());
    }
    case "ld": {
      const p = values[0];
      if (p === "soft" || p === "standard" || p === "strong") await c.repo.exec([setSetting("default_ladder", JSON.stringify({ preset: p }))]);
      return sectionScreen("l", await c.repo.loadConfig());
    }
    case "md": {
      const sec = isSection(arg[1] ?? "") ? (arg[1] as Section) : "q";
      const tagged = (id: string, m: { data: Record<string, unknown> }): Reply => ({ type: 9, data: { ...m.data, custom_id: `${id}:mn:${sec}` } });
      switch (arg[0]) {
        case "qt":
          return tagged("m_quiet", quietModal(c.s));
        case "aw":
          return tagged("m_away", awayModal());
        case "sm":
          return tagged("m_summ", summModal(c.s));
        case "lt":
          return tagged("m_light", lightModal(c.s));
        case "dw":
          return tagged("m_dw", dayWordsModal(c.s));
        case "wt":
          return tagged("m_water", waterModal(c.s));
        case "gs":
          return tagged("m_gas", gasModal(c.s));
        case "ln":
          return tagged("m_ladn", ladderNumsModal());
        default:
          return eph("Это окно бот не знает.");
      }
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
  if (text) return parseWhen(text, { now: c.now, ...timeOpts(c.s) }) ?? "bad";
  const key = str(v.get("quick"));
  if (key && key !== "custom") {
    const due = quickDue(key, c.now, c.s.tz, c.s.wordMorning, c.s.wordEvening);
    return due === null ? "bad" : { due, past: false };
  }
  return "none";
}

async function onModal(c: C): Promise<Reply> {
  const parts = String(c.i.data?.custom_id ?? "").split(":");
  const [kind, id] = parts;
  // окна из меню: `…:mn` (дела — добавить строку навигации) или `…:mn:<раздел>` (настройки — вернуть экран раздела)
  const fromMenu = parts[2] === "mn";
  const sec: Section | undefined = parts[1] === "mn" && isSection(parts[2] ?? "") ? (parts[2] as Section) : undefined;
  const nav = (r: Reply): Reply => (fromMenu ? navReply(r) : r);
  const v = modalValues(c.i.data?.components);
  switch (kind) {
    case "m_add": {
      const panel = id === "pn";
      const what = str(v.get("what"));
      if (!what) return eph("Напишите, что нужно сделать.");
      const m = menuPhrase({ what, when: str(v.get("when")), repeat: str(v.get("repeat")) });
      const wrap = (b: MessageBody): Reply => (panel ? msg({ ...withNav(b), flags: 64 }) : update(withNav(b)));
      return createReply(c, m.recurring ? normalizeEvery(m.text) : m.text, "menu", { requireRecurring: m.recurring, wrap });
    }
    case "m_snz":
    case "m_when": {
      const occ = await asOcc(c, id);
      if (!occ || !isOpen(occ)) return gone();
      const w = whenFromModal(c, v);
      if (w === "none") return eph("Выберите вариант или впишите время, например «завтра 10:30».");
      if (w === "bad") return eph("Не понял время. Пример: «завтра 10:30» или «через 2 часа».");
      if (w.past) return eph("Это время уже прошло.");
      if (kind === "m_snz" && occ.state !== "draft") return nav(await snoozeTo(c, occ, w.due));
      await c.repo.exec(rescheduleOps(occ, w.due, c.now));
      return nav(update(confirmFor(c, { ...occ, due_at: w.due })));
    }
    case "m_anadd":
      return handleAddModal(animeCtx(c), { name: str(v.get("name")), st: str(v.get("st")), ep: str(v.get("ep")) });
    case "m_anep":
      return handleEpModal(animeCtx(c), Number(id), parts[2] ?? "w", Math.max(0, Number.parseInt(parts[3] ?? "0", 10) || 0), str(v.get("ep")));
    case "m_edit":
      return nav(await editSubmit(c, id, v));
    case "m_split":
      return nav(await splitSubmit(c, id, v));
    case "m_quiet": {
      const from = parseHHMM(str(v.get("from")));
      const to = parseHHMM(str(v.get("to")));
      if (from === null || to === null) return eph("Время нужно в виде ЧЧ:ММ, например 23:00.");
      return settingsUpdate(c, [setSetting("quiet_from", fmtHHMM(from)), setSetting("quiet_to", fmtHHMM(to))], sec);
    }
    case "m_summ":
      return summSubmit(c, v, sec);
    case "m_away": {
      const days = Number(str(v.get("days")));
      if (!Number.isInteger(days) || days < 0 || days > 90) return eph("Нужно число дней от 0 до 90.");
      await setAway(c, days);
      return settingsUpdate(c, [], sec);
    }
    case "m_dw": {
      // «утром» и «вечером» хозяина (C4): пусто = по умолчанию; ошибка ввода — ничего не записываем
      const ops: Op[] = [];
      for (const [field, key, label] of [["morning", "time_morning", "Утром"], ["evening", "time_evening", "Вечером"]] as const) {
        const raw = str(v.get(field));
        if (!raw) {
          ops.push(setSetting(key, ""));
          continue;
        }
        const t = parseHHMM(raw);
        if (t === null) return eph(`${label}: время нужно в виде ЧЧ:ММ, например 07:30.`);
        ops.push(setSetting(key, fmtHHMM(t)));
      }
      return settingsUpdate(c, ops, sec);
    }
    case "m_light": {
      const t = str(v.get("group")).toLowerCase();
      if (t === "" || t === "выкл" || t === "off") return settingsUpdate(c, [setSetting("light", "off")], sec);
      const g = normalizeGroup(t);
      if (!g) return eph("Нужна группа вроде 3 или 3.1 (от 1 до 6) или слово «выкл».");
      return settingsUpdate(c, [setSetting("light", g)], sec);
    }
    case "m_water": {
      const t = str(v.get("words")).trim();
      if (t === "" || /^(выкл|off)$/i.test(t)) return settingsUpdate(c, [setSetting("water", "off"), deleteMeta("water_state"), deleteMeta("water_outbox")], sec);
      const words = parseWaterWords(t);
      if (!words.length) return eph("Нужны слова от трёх букв через запятую, например: Чечелівськ, Могилевськ. Или «выкл».");
      // новые слова — заново читаем ленту (сразу, а не через час) и забываем прежние объявления
      return settingsUpdate(c, [setSetting("water", words.join(", ")), deleteMeta("water_state"), deleteMeta("water_outbox"), setMeta("water_next", "0")], sec);
    }
    case "m_gas": {
      const t = str(v.get("words")).trim();
      if (t === "" || /^(выкл|off)$/i.test(t)) return settingsUpdate(c, [setSetting("gas", "off"), deleteMeta("gas_state"), deleteMeta("gas_outbox")], sec);
      const words = parseWaterWords(t);
      if (!words.length) return eph("Нужны слова от трёх букв через запятую, например: Героїв 35, Козака Мамая. Или «выкл».");
      return settingsUpdate(c, [setSetting("gas", words.join(", ")), deleteMeta("gas_state"), deleteMeta("gas_outbox"), setMeta("gas_next", "0")], sec);
    }
    case "m_ladn": {
      const steps = parseCustomSteps(str(v.get("nums")));
      if (!steps) return eph("Нужны числа (минуты от срока) через пробел, например: 0 10 20 40.");
      const spec: LadderSpec = { custom: steps };
      return settingsUpdate(c, [setSetting("default_ladder", JSON.stringify(spec))], sec);
    }
    default:
      return eph("Это окно бот не знает.");
  }
}

async function settingsUpdate(c: C, ops: Op[], sec?: Section): Promise<Reply> {
  if (ops.length) await c.repo.exec(ops);
  const cfg = await c.repo.loadConfig();
  const dm = cfg.meta.get("dm_channel_id");
  const dmOnNow = !!dm && cfg.settings.intake.includes(dm);
  return update(sec ? sectionMessage(cfg.settings, sec, c.now, dmOnNow) : settingsHomeMessage(cfg.settings, c.now));
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
    const w = parseWhen(whenText, { now: c.now, ...timeOpts(c.s) });
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
  const plainSel = str(v.get("plain"));
  if (plainSel === "plain" || plainSel === "styled") ops.push(setPlainOps(occ.item_id, plainSel === "plain"));
  if (ops.length) ops.push(touchOps(occ.item_id, c.now)); // хозяин тронул дело: не «давнее» и не заморозится ещё 30 дней
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
  const target = todayTarget(c.now, c.s.tz, c.s.wordEvening);
  const ops: Op[] = [];
  const titles: string[] = [];
  for (const line of lines) {
    const parsed = parseInput(line, { now: c.now, ...timeOpts(c.s) });
    if (!parsed.title) continue;
    if (parsed.due === null || parsed.past) parsed.due = target;
    ops.push(...newItemOps({ parsed, source: "slash", settings: c.s, now: c.now }).ops);
    titles.push(parsed.title);
  }
  if (titles.length === 0) return eph("Не нашёл ни одного шага.");
  ops.push(...cancelItemOps(occ.item_id, c.now, "split"));
  await c.repo.exec(ops);
  return update(plainMessage(`Разбито на шаги (${titles.length}): ${titles.join("; ")}. Время — ${formatWhen(target, c.now, c.s.tz)}, поменять: /menu → Все дела → дело.`));
}

async function summSubmit(c: C, v: Map<string, string | string[]>, sec?: Section): Promise<Reply> {
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
  return settingsUpdate(c, ops, sec);
}

