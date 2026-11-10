// Цикл cron раз в минуту (DESIGN §8). Worker без памяти: всё состояние в базе, любой сбой подхватит следующий запуск.
// На бесплатном плане за запуск можно сделать 50 подзапросов (D1 и Discord вместе): считаем их и оставляем запас
// на запись результата и пинг сторожу.
import { BudgetExceeded, type Repo, deleteMeta, event, op, releaseLocks, rememberMessage, setMeta, setSetting, updateOcc } from "./db/repo.ts";
import type { OccView, Op } from "./db/types.ts";
import { type DiscordApi, DiscordError } from "./discord/types.ts";
import {
  type Look,
  panelText,
  reminderMessage,
  summaryMoreRow,
  summaryParts,
  weeklyText,
} from "./discord/ui.ts";
import { type AiBinding, countedAi } from "./llm.ts";
import { addRun, gapMinutes, limitWarnings, markWarned, parseUsage, parseWarned, warningMessage, weeklyLimitsLine } from "./usage.ts";
import { createFromText, EMPTY_REPLY, EMPTY_SERIES_REPLY, messageTime, SECRET_REPLY } from "./intake.ts";
import { GAS_CHECK_EVERY, GAS_RETRY_AFTER, dueGas, failGas, fetchGas, gasSummaryLines, parseGasState, planGas } from "./gas.ts";
import { WATER_CHECK_EVERY, WATER_RETRY_AFTER, dueWater, failWater, fetchWater, parseWaterState, planWater, waterSummaryLines } from "./water.ts";
import { MoodSession, canStyle, makeCtx, reactionLine, recordedLine, summaryLine } from "./personality/director.ts";
import { QUIET_DAY_MS, QUIET_META_KEY, QUIET_OFF_REPLY, QUIET_ON_REPLY, isQuietNow, parseQuietDay } from "./personality/day.ts";
import { LIVE_TIMEOUT_CRON_MS } from "./personality/liveLines.ts";
import { maidEmbed, pickReaction, wantSprite } from "./personality/look.ts";
import { isPolite, isSeriousTopic } from "./personality/moodEngine.ts";
import { detectUserWord } from "./personality/userWords.ts";
import { announceOutage } from "./power.ts";
import { parseAnimePhrase } from "./anime/core.ts";
import { runAnime } from "./anime/cron.ts";
import { handlePhrase } from "./anime/handlers.ts";
import { listAnime } from "./anime/store.ts";
import { eveningLines } from "./anime/ui.ts";
import { handleReply } from "./reply.ts";
import { YASNO_ATTEMPTS, fetchYasno, groupsFor, lightFullText, lightLines, publishedFor, tomorrowDigest, type LightData } from "./light.ts";
import { isLightQuestion, lightAskMessage } from "./lightAsk.ts";
import { isWeatherQuestion, weatherAskMessage } from "./weatherAsk.ts";
import {
  type Annual, CAL_HOUR, SEASON_TEXT, addedReply, calendarListText, dstItem, dstWarning, dueStage, isYearReviewDay, markValue, parseCalendarMessage,
  seasonKey, seasonStarting, stageItem, yearBounds, yearReviewText, ymdText,
} from "./calendar.ts";
import { detectSecret } from "./secrets.ts";
import { withSound } from "./sound.ts";
import { choreMetaKey, choreParsed, choresDue, periodKey } from "./chores.ts";
import {
  META_KEY as PASSPORT_KEY,
  type SourceId,
  isBroken,
  lastKnownLightLines,
  lightLastOf,
  lightNoticeDue,
  markSaid,
  parseLightLast,
  parsePassport,
  recordSource,
  staleStamp,
  weekSourceLines,
} from "./sources.ts";
import { OPEN_STATES } from "./db/types.ts";

/** Повторная проверка света после сбоя Yasno в сводке: через сколько минут и сколько раз. */
const LIGHT_RETRY_MIN = 30;
/** первые LIGHT_RETRY_FAST проверок — раз в LIGHT_RETRY_MIN минут, дальше раз в час, пока не получится (или не кончатся сутки) */
const LIGHT_RETRY_FAST = 3;
const LIGHT_RETRY_SLOW_MIN = 60;
interface LightRetry { kind: "morning" | "evening"; date: string; at: number; n: number }
function parseLightRetry(raw: string | undefined): LightRetry | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LightRetry>;
    return (v.kind === "morning" || v.kind === "evening") && typeof v.date === "string" && Number.isFinite(v.at) && Number.isFinite(v.n) ? (v as LightRetry) : null;
  } catch {
    return null;
  }
}
import { MOOD_CONFIG } from "./personality/config.ts";
import { planFire } from "./ladder.ts";
import { freezeOps, ladderFor, newItemOps, nextSeriesOps, scrubOps } from "./service.ts";
import { calmMessage, headVoice, reviewMessage } from "./discord/ui.ts";
import { freezeCandidates, isTail, shouldNoteTail, soonFrozen } from "./tail.ts";
import { type AppSettings, inQuietHours } from "./settings.ts";
import { MINUTE, addDaysWall, localDate, nextTimeOfDay, wallOf } from "./time/tz.ts";

export const RESERVE = 3;
export const MAX_SENDS = 35;

export interface CronEnv {
  ownerId?: string;
  watchdogUrl?: string;
}

export interface CronDeps {
  repo: Repo;
  api: DiscordApi;
  now: number;
  env: CronEnv;
  /** пинг сторожу; по умолчанию fetch */
  ping?: (url: string) => Promise<void>;
  token?: string;
  maxSends?: number;
  /** для запроса графика света; по умолчанию fetch */
  fetchFn?: typeof fetch;
  /** привязка Workers AI (env.AI) для понимания фраз; необязательна */
  ai?: AiBinding;
  /** случайность для фраз настроения; по умолчанию Math.random */
  rand?: () => number;
  /** быстрый опрос приёма внутри минуты (шаг 4); без него — как раньше, раз в минуту */
  fastPoll?: FastPoll;
}

/**
 * Быстрый опрос каналов приёма: после обычной работы запуск ещё `rounds` раз с шагом `everyMs` читает каналы
 * (обычная проверка стоит в начале минуты) — ответ на текст приходит за ~everyMs, а не за минуту. Ожидание между опросами
 * процессорное время не тратит; пустой опрос — один подзапрос на канал и ни одного обращения к базе.
 * `maxMs` — последний срок начала опроса от начала запуска (следующий запуск стартует через 60 с, наползать на него нельзя).
 */
export interface FastPoll {
  rounds: number;
  everyMs: number;
  maxMs: number;
  /** для тестов: подмена ожидания и часов */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/** Рабочие числа для Worker: 4 опроса через 12, 24, 36 и 48 с — вместе с проверкой в начале минуты выходит раз в 12 с. */
export const FAST_POLL: FastPoll = { rounds: 4, everyMs: 12_000, maxMs: 50_000 };

export interface CronReport {
  claimed: number;
  sent: number;
  deferred: number;
  failed: number;
  summaries: string[];
  panel: boolean;
  intake: number;
  ping: "ok" | "fail" | "skip";
  subrequests: number;
  notes: string[];
}

export { localDate };

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

const defer = (id: number, at: number): Op => updateOcc(id, { next_fire_at: at, lock_until: null, lock_token: null });

export async function runCron(d: CronDeps): Promise<CronReport> {
  const { repo, now } = d;
  const startedAt = (d.fastPoll?.clock ?? Date.now)();
  /** привязка модели с подсчётом нейронов: расход виден в итоге недели и в предупреждениях (usage.ts) */
  const ai = countedAi(d.ai, repo.counter);
  const token = d.token ?? crypto.randomUUID();
  const report: CronReport = { claimed: 0, sent: 0, deferred: 0, failed: 0, summaries: [], panel: false, intake: 0, ping: "skip", subrequests: 0, notes: [] };
  const pre = await repo.prelude(now, d.maxSends ?? MAX_SENDS, token);
  const meta = pre.meta;
  // «тихий день»: старые приписки «уставшей горничной» (сводки, пустые списки, аниме) тоже молчат — как нейтральный характер
  const quietNow = isQuietNow(meta.get(QUIET_META_KEY), now);
  const s: AppSettings = quietNow && pre.settings.character !== "neutral" ? { ...pre.settings, character: "neutral" } : pre.settings;
  const owner = meta.get("owner_id") ?? d.env.ownerId ?? null;
  // «Всё со звуком» (D7): по галочке каждое новое сообщение бота в канал упоминает хозяина; личка и так со звуком
  const api = withSound(d.api, owner ?? undefined, s.soundAll, [meta.get("dm_channel_id")].filter((x): x is string => !!x));
  /** адрес Worker (его записывает обработчик команд): отсюда берутся спрайты для карточек */
  const origin = meta.get("public_origin") ?? null;
  report.claimed = pre.claimed.length;
  let healthy = true;

  const away = s.awayUntil > now;
  const awayEnded = s.awayUntil > 0 && !away;
  const minuteOfDay = (() => {
    const w = wallOf(now, s.tz);
    return w.h * 60 + w.mi;
  })();

  // настроение горничной (если включено в /settings): состояние читаем лениво, только когда оно понадобится
  const mood =
    s.moodOn && owner ? new MoodSession({
          repo, userId: owner, ctx: makeCtx(now, s), rand: d.rand, style: s.style,
          live: s.liveOn && ai ? { ai, tz: s.tz, timeoutMs: LIVE_TIMEOUT_CRON_MS, gate: () => repo.counter.can(4 + RESERVE), spend: () => repo.counter.spend(1) } : null,
        })
      : null;

  // «тихий день» (этап 2, D3, D5): сутки Хару молчит совсем — ни реплик, ни карточек, ни реакций; напоминания и сводки идут как всегда
  if (mood && quietNow) mood.silent = true;

  // ---------- 1. созревшие срабатывания ----------
  const ops: Op[] = [];
  try {
    const room = (n = 1) => repo.counter.can(n + RESERVE);
    const quiet = inQuietHours(s, minuteOfDay);
    const quietEnd = quiet ? nextTimeOfDay(now, s.quietTo, s.tz) : 0;
    if (pre.claimed.length && (!s.chRemind || !owner)) {
      report.notes.push("нет канала напоминаний или хозяина: выполните /setup");
    } else {
      for (const occ of pre.claimed) {
        if (!room(2)) {
          report.notes.push("лимит подзапросов: остальное в следующую минуту");
          break;
        }
        if (away) {
          ops.push(defer(occ.id, s.awayUntil));
          report.deferred++;
          continue;
        }
        if (quiet && !occ.critical) {
          ops.push(defer(occ.id, quietEnd));
          report.deferred++;
          continue;
        }
        const ladder = ladderFor(occ, s);
        const base = occ.base_at ?? occ.due_at ?? now;
        const plan = planFire(ladder, base, occ.fire_count, now);
        if (!plan) {
          ops.push(updateOcc(occ.id, { next_fire_at: null, lock_until: null, lock_token: null }));
          continue;
        }
        // настроение: пропуск (дело стало «просрочено») и реплика под напоминанием; при сбое отправки откатываем
        const snap = mood?.snapshot();
        let flavor: string | null = null;
        let look: Look | null = null;
        if (mood && occ.kind === "main" && occ.item_kind === "reminder" && room(3)) {
          await mood.load();
          const becameOverdue = plan.phase === "overdue" && occ.state !== "overdue";
          if (becameOverdue) {
            mood.apply({ type: "miss" });
            mood.noteMiss();
          }
          if (canStyle(occ.title, occ.critical, occ.plain)) {
            const situation = becameOverdue
              ? mood.state!.missStreak === 1 ? "missed_first" : "missed"
              : plan.phase === "overdue" ? "missed" : occ.fire_count === 0 && occ.state === "planned" ? "reminder" : "reminder_repeat";
            // повторное «просрочено» не должно каждый раз грозить: драма — с паузой, внутри say()
            flavor = await mood.sayLive(situation, { task: occ.title, itemId: occ.item_id });
            // карточка с цветом настроения; спрайт — редко, а в «кино-моменте» и при затяжных пропусках — всегда
            if (flavor) look = { mood: mood.state!.mood, origin, sprite: wantSprite(mood.rand, mood.cinema || (situation === "missed" && mood.state!.missStreak >= 3)) };
          }
        }
        const body = reminderMessage({ occ, plan, ownerId: owner as string, tz: s.tz, now, flavor, look });
        let sent;
        try {
          sent = await api.postMessage(s.chRemind as string, body);
        } catch (e) {
          if (mood && snap) mood.restore(snap);
          if (e instanceof BudgetExceeded) break;
          healthy = false;
          report.failed++;
          const status = e instanceof DiscordError ? e.status : 0;
          ops.push(event(now, status === 429 ? "rate_limited" : "send_failed", occ.id, `status=${status}`));
          if (status === 429) break; // Discord просит подождать: остальное в следующую минуту
          if (status >= 400 && status < 500) ops.push(defer(occ.id, now + 10 * MINUTE)); // канал недоступен: реже
          continue;
        }
        // прежнее сообщение этого дела (и у таймера — сообщения его прошлых срабатываний) убираем: канал остаётся чистым
        const stale: { ch: string; id: string }[] = [];
        if (occ.last_message_id && occ.last_channel_id) stale.push({ ch: occ.last_channel_id, id: occ.last_message_id });
        if (occ.item_kind === "timer") {
          for (const t of pre.timerOpen) {
            if (t.item_id === occ.item_id && t.id !== occ.id) {
              stale.push({ ch: t.last_channel_id, id: t.last_message_id });
              ops.push(updateOcc(t.id, { state: "done", closed_at: now, closed_reason: "next", next_fire_at: null }));
            }
          }
        }
        for (const m of stale) {
          if (!room(1)) break;
          try {
            await api.deleteMessage(m.ch, m.id);
          } catch {
            /* не вышло удалить старое: не страшно */
          }
        }
        ops.push(
          updateOcc(occ.id, {
            state: plan.phase === "overdue" ? "overdue" : "fired",
            fire_count: plan.index + 1,
            next_fire_at: plan.nextAt,
            last_message_id: sent.id,
            last_channel_id: sent.channel_id,
            lock_until: null,
            lock_token: null,
          }),
          event(now, "sent", occ.id, `i=${plan.index};${plan.phase}`),
          rememberMessage(sent.id, sent.channel_id, occ.id, now),
        );
        if (occ.state === "planned" && occ.kind === "main") ops.push(...nextSeriesOps(occ, now));
        report.sent++;
      }
    }
  } catch (e) {
    healthy = false;
    report.notes.push(`ошибка: ${(e as Error).message}`);
    ops.push(event(now, "cron_error", null, String((e as Error).message).slice(0, 200)));
  }
  if (mood?.loaded) ops.push(...mood.ops());
  ops.push(releaseLocks(token));
  await repo.exec(ops); // результат фиксируем всегда: запас подзапросов на это есть

  // ---------- 2. остальное: приём текста, сводки, панель, сторож ----------
  const ops2: Op[] = [];
  const room2 = (n = 1) => repo.counter.can(n + 2); // ещё нужны: запись ops2 и пинг сторожу
  // паспорт источников (этап 4): итоги чтений копим в памяти, одной записью пишем в конце запуска — подзапросов не добавляет
  let passport = parsePassport(meta.get(PASSPORT_KEY));
  let passportDirty = false;
  const note = (id: SourceId, ok: boolean): void => {
    passport = recordSource(passport, id, ok, now);
    passportDirty = true;
  };
  /** Чтение Yasno с учётом подзапросов и записью в паспорт. */
  const readYasno = async (): Promise<LightData | null> => {
    repo.counter.spend(YASNO_ATTEMPTS);
    const r = await fetchYasno(d.fetchFn ?? fetch);
    note("light", r !== null);
    return r;
  };
  /** Строка Хару перед сообщением о сломанном источнике (A5): только если характер включён и не «тихий день»; из готовых фраз, без модели. */
  const haruLine = async (sit: "source_down" | "source_week"): Promise<string | null> => {
    if (!mood || mood.silent || !room2(3)) return null;
    try {
      await mood.load();
      return mood.say(sit);
    } catch (e) {
      if (e instanceof BudgetExceeded) return null;
      throw e;
    }
  };
  const voiced = async <T extends { text: string }>(n: T): Promise<T> => {
    const line = await haruLine("source_down");
    return line ? { ...n, text: `${line}
${n.text}` } : n;
  };
  const enabledSources = { light: !!s.lightGroup, water: s.waterWords.length > 0, gas: s.gasWords.length > 0 };
  /** Реакция-эмодзи по настроению на сообщение хозяина (этап Х3): редко, на серьёзные темы — никогда; сбой реакции не страшен. */
  const react = async (ch: string, messageId: string, always: boolean, text = ""): Promise<void> => {
    if (!mood?.loaded || mood.silent || !room2(1) || isSeriousTopic(text)) return;
    const e = pickReaction(mood.state!.mood, mood.rand, always);
    if (!e) return;
    try {
      await api.addReaction(ch, messageId, e);
    } catch {
      /* нет права или сообщения уже нет: не страшно */
    }
  };
  const today = localDate(now, s.tz);
  /** последнее прочитанное сообщение канала в памяти запуска: быстрые опросы (шаг 4) не ждут записи в базу и не читают её */
  const lastSeen = new Map<string, string>();
  let blindNoticed = false;
  let intakeOn = false;
  let intakeRound: (ops2: Op[], now: number) => Promise<void> = async () => {};
  try {
    let items: OccView[] | null = null;
    const getItems = async () => (items ??= await repo.openMain(100));

    // 2а. обычный текст из каналов приёма: основной путь записи дел;
    // канал напоминаний читаем только ради ответов (Reply) на сообщения-напоминания.
    // Один «круг» приёма — функция: в начале минуты она идёт здесь, потом её же гоняет быстрый опрос (шаг 4); внутри `ops2` и `now` — свои.
    if (owner) {
      intakeOn = true;
      intakeRound = async (ops2, now) => {
      const channels = s.intake.map((ch) => ({ ch, replies: false }));
      if (s.chRemind && !s.intake.includes(s.chRemind)) channels.push({ ch: s.chRemind, replies: true });
      for (const { ch, replies } of channels) {
        if (!room2(2)) break;
        const lastKey = `intake_last:${ch}`;
        const last = lastSeen.get(ch) ?? meta.get(lastKey);
        if (last === undefined) {
          const latest = await api.listMessages(ch, null, 1);
          const first = latest.length ? latest[latest.length - 1].id : "0";
          lastSeen.set(ch, first);
          ops2.push(setMeta(lastKey, first));
          continue;
        }
        const msgs = await api.listMessages(ch, last, 20);
        let lastId = last;
        let blind = 0;
        for (const m of msgs) {
          if (!room2(replies ? 5 : 3)) break;
          lastId = m.id;
          if (m.author.bot || m.author.id !== owner) continue;
          if (replies) {
            if ((await handleReply({ repo, api, s, now, mood }, m, ch)) === "handled") report.intake++;
            continue;
          }
          if (!m.content.trim()) {
            if (!m.attachments?.length) blind++;
            continue;
          }
          // Reply на сообщение бота, привязанное к делу (в том числе «Записано …»): «готово», «отмени», «на час» — действие над делом
          if (m.message_reference?.message_id && room2(5)) {
            if ((await handleReply({ repo, api, s, now, mood }, m, ch)) === "handled") {
              report.intake++;
              continue;
            }
          }
          // «тихий день» словом (этап 2, D3): «тихий день» — сутки без реплик Хару; «хватит тихого дня» — досрочно снять. Сообщение целиком из этих слов, иначе это дело.
          const quietWord = parseQuietDay(m.content);
          if (quietWord && room2(3)) {
            report.intake++;
            if (quietWord === "on") ops2.push(setMeta(QUIET_META_KEY, String(now + QUIET_DAY_MS)));
            else ops2.push(deleteMeta(QUIET_META_KEY));
            if (mood) mood.silent = quietWord === "on";
            try {
              await api.postMessage(ch, { content: quietWord === "on" ? QUIET_ON_REPLY : QUIET_OFF_REPLY, allowed_mentions: { parse: [] } });
            } catch (e) {
              if (e instanceof BudgetExceeded) break;
            }
            continue;
          }
          // календарь сюрпризов (этап 5, F3): «календарь» — список, «календарь» + строки — внести списком одним сообщением, «календарь убрать Имя»
          const cal = parseCalendarMessage(m.content);
          if (cal && room2(6)) {
            report.intake++;
            let text: string;
            const LIST_SQL = "SELECT id, kind, name, month AS mo, day AS d, year, marked FROM annuals ORDER BY id";
            try {
              const wc = wallOf(now, s.tz);
              const t = { y: wc.y, mo: wc.mo, d: wc.d };
              if (cal.kind === "secret") text = SECRET_REPLY;
              else if (cal.kind === "list") text = calendarListText(await repo.all<Annual>(LIST_SQL), t);
              else if (cal.kind === "remove") {
                const all = await repo.all<Annual>(LIST_SQL);
                const hit = all.filter((a) => a.name.toLowerCase() === cal.name.toLowerCase());
                if (hit.length) await repo.exec(hit.map((a) => op("DELETE FROM annuals WHERE id = ?", a.id)));
                text = hit.length ? `Убрала из календаря: ${hit.length}.` : "Такой записи в календаре нет. Список — «⋯ Ещё» → «📆 Календарь».";
              } else if (!cal.entries.length) text = addedReply(0, 0, cal.bad);
              else {
                const res = await repo.exec(
                  cal.entries.map((e) => op("INSERT OR IGNORE INTO annuals (kind, name, month, day, year, created_at) VALUES (?, ?, ?, ?, ?, ?)", e.kind, e.name, e.mo, e.d, e.year, now)),
                );
                const added = res.filter((r) => Number((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0).length;
                text = addedReply(added, cal.entries.length - added, cal.bad);
                ops2.push(deleteMeta("cal_day")); // новые записи: сегодняшний шаг пересчитаем сразу, а не завтра
                meta.delete("cal_day");
              }
            } catch (e) {
              if (e instanceof BudgetExceeded) break;
              text = "Не получилось обратиться к календарю. Если сообщение повторится — применена ли миграция 0009 (README, «Выкладка»)?";
            }
            try {
              await api.postMessage(ch, { content: text, allowed_mentions: { parse: [] } });
            } catch (e) {
              if (e instanceof BudgetExceeded) break;
              report.notes.push("календарь: не удалось ответить в канале");
            }
            continue;
          }
          // свет текстом: «дай график света», «что со светом» — график, а не дело (этап 1 ретроспективы 2); без модели.
          // Слово «свет» в обычном деле («оплатить свет», «в 18:00 свет») сюда не попадает; промах поправит кнопка «Это было дело».
          if (isLightQuestion(m.content) && !detectSecret(m.content).secret && room2(YASNO_ATTEMPTS + 4)) {
            report.intake++;
            let text: string;
            if (!s.lightGroup) text = "Группа света не задана: /settings → «Свет: группа…» → впишите номер (например, 3).";
            else {
              text = lightFullText(now, s.tz, s.lightGroup, await readYasno());
            }
            try {
              await api.postMessage(ch, lightAskMessage(text, m.content));
            } catch (e) {
              if (e instanceof BudgetExceeded) break;
              report.notes.push("свет: не удалось ответить на вопрос в канале");
            }
            continue;
          }
          // погода текстом: «какой прогноз на завтра» — честный ответ «погоду пока не читаю», а не дело (живая проверка 2026-11-10); без модели
          if (isWeatherQuestion(m.content) && !detectSecret(m.content).secret && room2(3)) {
            report.intake++;
            try {
              await api.postMessage(ch, weatherAskMessage(m.content));
            } catch (e) {
              if (e instanceof BudgetExceeded) break;
              report.notes.push("погода: не удалось ответить на вопрос в канале");
            }
            continue;
          }
          // настроение: любое сообщение хозяина — активность; «спасибо» горничной — вежливость, дело из этого не создаём
          if (mood && room2(3)) {
            await mood.load();
            // «ара-ара», «ганбатте» и т.п. от хозяина: ответ в тон, симпатия +1 (раз в час); делом это не записываем
            const word = s.style.level >= 1 ? detectUserWord(m.content) : null;
            if (word) {
              const line = mood.hearWord(word);
              report.intake++;
              if (mood.silent) continue; // тихий день: симпатия засчитана, ответа нет
              try {
                await api.postMessage(ch, {
                  embeds: [maidEmbed({ mood: mood.state!.mood, text: line, origin, sprite: wantSprite(mood.rand) })],
                  allowed_mentions: { parse: [] },
                });
              } catch (e) {
                if (e instanceof BudgetExceeded) break;
              }
              await react(ch, m.id, true);
              continue;
            }
            const polite = isPolite(m.content);
            mood.apply({ type: "activity", polite });
            if (polite) {
              report.intake++;
              if (mood.silent) continue; // тихий день: «спасибо» без ответа
              const line = await mood.sayLive("thanks");
              try {
                await api.postMessage(
                  ch,
                  line
                    ? { embeds: [maidEmbed({ mood: mood.state!.mood, text: line, origin, sprite: wantSprite(mood.rand) })], allowed_mentions: { parse: [] } }
                    : { content: "Пожалуйста.", allowed_mentions: { parse: [] } },
                );
              } catch (e) {
                if (e instanceof BudgetExceeded) break;
              }
              await react(ch, m.id, true);
              continue;
            }
          }
          // аниме: «бот смотрю фрирен», «аниме хочу блич», «бот бросил ДжоДжо» — коллекция, а не дело
          const animePhrase = parseAnimePhrase(m.content);
          if (animePhrase && room2(6)) {
            repo.counter.spend(2);
            report.intake++;
            try {
              const reply = await handlePhrase({ repo, now, tz: s.tz, character: s.character, fetchFn: d.fetchFn ?? fetch, rand: d.rand }, animePhrase);
              await api.postMessage(ch, reply);
            } catch (e) {
              if (e instanceof BudgetExceeded) break;
              report.notes.push("аниме: не удалось ответить на фразу");
            }
            continue;
          }
          const recordedFor = async (title: string, critical: boolean) => {
            if (!mood?.loaded) return null;
            const line = await recordedLine(mood, title, critical);
            return line ? { line, look: { mood: mood.state!.mood, origin, sprite: wantSprite(mood.rand) } } : null;
          };
          const r = await createFromText({ repo, settings: s, now, ai, recorded: (title, critical) => recordedFor(title, critical), drafted: (title, critical) => (mood?.loaded ? reactionLine(mood, "draft", { title, critical }) : null) }, m.content, "channel", { at: messageTime(m, now) });
          report.intake++;
          const reply =
            r.kind === "created"
              ? r.message
              : { content: r.kind === "secret" ? SECRET_REPLY : r.kind === "empty" ? EMPTY_REPLY : EMPTY_SERIES_REPLY, allowed_mentions: { parse: [] } };
          if (r.kind === "secret") ops2.push(event(now, "secret_seen", null, "intake"));
          try {
            const sent = await api.postMessage(ch, reply);
            // запомнить сообщение: ответ (Reply) на него будет действовать на это дело
            if (r.kind === "created") ops2.push(rememberMessage(sent.id, sent.channel_id, r.occId, now));
          } catch (e) {
            if (e instanceof BudgetExceeded) break;
            report.notes.push("не удалось ответить на сообщение в канале приёма");
          }
          if (r.kind === "created") await react(ch, m.id, false, m.content);
        }
        if (lastId !== last) {
          lastSeen.set(ch, lastId);
          ops2.push(setMeta(lastKey, lastId));
        }
        if (blind > 0) {
          ops2.push(event(now, "intake_blind", null, `n=${blind}`));
          if (meta.get("intake_blind_notice") !== today && !blindNoticed && room2(1)) {
            try {
              await api.postMessage(ch, {
                content:
                  "Не вижу текст сообщений в этом канале. Включите Message Content Intent в настройках приложения в Discord Developer Portal или пишите боту в личные сообщения.",
                allowed_mentions: { parse: [] },
              });
              blindNoticed = true;
              ops2.push(setMeta("intake_blind_notice", today));
            } catch {
              /* повторим завтра */
            }
          }
        }
      }
      };
      await intakeRound(ops2, now);
    }

    // 2а1. автозаморозка (этап 3, B7): раз в день после 06:00 дело, которое «висит» 30 суток без единого нажатия, замораживается.
    // Замороженное остаётся в базе целым, не напоминает и возвращается кнопкой «Вернуть» (⋯ Ещё → Заморожено). В отъезде не замораживаем.
    if (owner && !away && minuteOfDay >= 6 * 60 && meta.get("last_freeze") !== today && room2(3)) {
      const list = await getItems();
      const frozen = freezeCandidates(list, now);
      for (const o of frozen) ops2.push(...freezeOps(o, now));
      if (frozen.length) {
        const ids = new Set(frozen.map((o) => o.id));
        items = list.filter((o) => !ids.has(o.id));
        report.notes.push(`заморожено дел: ${frozen.length}`);
      }
      ops2.push(setMeta("last_freeze", today));
    }

    // 2а2. дела-сопровождение (этап 4, A9, A10): копия базы раз в месяц, зависимости и модели раз в квартал, ключи раз в год.
    // Обычные дела: приходят в «почту» вечером, не исчезают без «Готово». Прежнее такое же дело ещё открыто — новое не копится.
    if (owner && s.choresOn && !away && minuteOfDay >= 10 * 60 && meta.get("chores_day") !== today && room2(5)) {
      let all = true;
      const openSql = OPEN_STATES.map((x) => `'${x}'`).join(",");
      for (const c of choresDue(now, s.tz, (k) => meta.get(k))) {
        if (!room2(4)) {
          all = false;
          break;
        }
        const open = await repo.first<{ x: number }>(
          `SELECT 1 AS x FROM occurrences o JOIN items i ON i.id = o.item_id WHERE i.title = ? AND o.kind = 'main' AND o.state IN (${openSql}) LIMIT 1`,
          c.title,
        );
        if (!open) {
          ops2.push(...newItemOps({ parsed: choreParsed(c, now, s.tz), source: "menu", settings: s, now, body: c.body }).ops, event(now, "chore_created", null, c.id));
          report.notes.push(`дело-сопровождение: ${c.id}`);
        }
        ops2.push(setMeta(choreMetaKey(c.id), periodKey(now, s.tz)));
      }
      if (all) ops2.push(setMeta("chores_day", today));
    }

    // 2а3. календарь сюрпризов (этап 5, группа F): раз в сутки после 10:00 годовые даты → дела-предупреждения (за месяц, неделю, день; в день рождения — сам день),
    // каждое — отдельное обычное дело с «Готово»; плюс предупреждение о переводе часов (за день). Имена и даты в события и журнал не пишем.
    // Таблицы `annuals` ещё может не быть (миграция 0009 не применена): тогда тихо пропускаем сутки и пишем событие, а не падаем каждую минуту.
    if (owner && !away && minuteOfDay >= CAL_HOUR * 60 && meta.get("cal_day") !== today && room2(8)) {
      try {
        const wc = wallOf(now, s.tz);
        const t = { y: wc.y, mo: wc.mo, d: wc.d };
        const list = await repo.all<Annual>("SELECT id, kind, name, month AS mo, day AS d, year, marked FROM annuals ORDER BY id");
        for (const a of list) {
          const due = dueStage(a, t);
          if (!due) continue;
          const it = stageItem(a, due, now, s.tz);
          ops2.push(
            ...newItemOps({ parsed: it.parsed, source: "menu", settings: s, now, body: it.body }).ops,
            op("UPDATE annuals SET marked = ? WHERE id = ?", markValue(due), a.id),
            event(now, "calendar_item", null, `stage=${due.stage}`),
          );
          report.notes.push(`календарь: предупреждение (${due.stage})`);
        }
        // разовые сроки, которые уже прошли, из таблицы убираем (годовые остаются)
        ops2.push(op("DELETE FROM annuals WHERE year IS NOT NULL AND year * 10000 + month * 100 + day < ?", t.y * 10000 + t.mo * 100 + t.d));
        const dst = dstWarning(now, s.tz);
        if (dst && meta.get("dst_warned") !== ymdText(dst.tomorrow)) {
          ops2.push(...newItemOps({ parsed: dstItem(dst, now, s.tz), source: "menu", settings: s, now, body: null }).ops, setMeta("dst_warned", ymdText(dst.tomorrow)), event(now, "calendar_dst", null, `dir=${dst.direction}`));
          report.notes.push("календарь: перевод часов");
        }
        ops2.push(setMeta("cal_day", today));
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) {
          ops2.push(setMeta("cal_day", today), event(now, "calendar_failed"));
          report.notes.push("календарь: не удалось прочитать таблицу (миграция 0009 применена?)");
        }
      }
    }

    // 2а4. сезонное «между прочим» (F8, раз в сезон, пока нет вопроса важнее — вопроса про аниме) и «Год с Хару» (F9, одно сообщение в конце декабря).
    // Только днём (12:00–20:00) и не в отъезде; каждое отправляется один раз.
    if (owner && s.chRemind && !away && minuteOfDay >= 12 * 60 && minuteOfDay < 20 * 60 && room2(5)) {
      const wc = wallOf(now, s.tz);
      const t = { y: wc.y, mo: wc.mo, d: wc.d };
      const season = seasonStarting(t);
      const sKey = season ? seasonKey(season, t.y) : null;
      const sendSeason = !!season && !!sKey && meta.get("season_sent") !== sKey && !meta.get("anime_weekq");
      const sendYear = isYearReviewDay(t) && meta.get("year_review") !== String(t.y);
      if (sendSeason || sendYear) {
        try {
          if (sendSeason && season && sKey) {
            let line: string | null = null;
            if (mood) {
              await mood.load();
              line = await mood.sayLive("seasonal", { facts: "началось новое время года" });
            }
            await api.postMessage(s.chRemind, { content: headVoice(line, SEASON_TEXT[season]), allowed_mentions: { parse: [] } });
            ops2.push(setMeta("season_sent", sKey), event(now, "calendar_season", null, season));
            report.notes.push(`календарь: между прочим (${season})`);
          } else if (sendYear) {
            const { from, to } = yearBounds(t.y, s.tz);
            const row = await repo.first<{ done: number; created: number; open: number; frozen: number }>(
              `SELECT (SELECT COUNT(*) FROM occurrences WHERE kind = 'main' AND state = 'done' AND closed_at >= ? AND closed_at < ?) AS done,
                      (SELECT COUNT(*) FROM items WHERE created_at >= ? AND created_at < ?) AS created,
                      (SELECT COUNT(*) FROM occurrences WHERE kind = 'main' AND state IN ('draft','planned','fired','snoozed','overdue')) AS open,
                      (SELECT COUNT(*) FROM occurrences WHERE state = 'cancelled' AND closed_reason = 'frozen') AS frozen`,
              from, to, from, to,
            );
            let line: string | null = null;
            if (mood) {
              await mood.load();
              line = await mood.sayLive("year_with", { facts: `закрыто дел за год: ${row?.done ?? 0}` });
            }
            await api.postMessage(s.chRemind, { content: headVoice(line, yearReviewText({ year: t.y, done: row?.done ?? 0, created: row?.created ?? 0, open: row?.open ?? 0, frozen: row?.frozen ?? 0 })), allowed_mentions: { parse: [] } });
            ops2.push(setMeta("year_review", String(t.y)), event(now, "calendar_year", null, String(t.y)));
            report.notes.push("календарь: «Год с Хару»");
          }
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) {
            healthy = false;
            ops2.push(event(now, "calendar_post_failed"));
          }
        }
      }
    }

    // 2б. возвращение из отъезда и сводки
    if (awayEnded) ops2.push(setSetting("away_until", "0"));
    const summaries: ("morning" | "evening" | "weekly" | "return")[] = [];
    if (!away && s.chRemind && owner) {
      if (awayEnded) summaries.push("return");
      else {
        if (s.morning !== null && minuteOfDay >= s.morning && minuteOfDay < s.morning + 240 && meta.get("last_morning") !== today) summaries.push("morning");
        if (s.evening !== null && minuteOfDay >= s.evening && minuteOfDay < s.evening + 240 && meta.get("last_evening") !== today) summaries.push("evening");
        if (s.weekly && wallOf(now, s.tz).wd === s.weekly.dow && minuteOfDay >= s.weekly.at && minuteOfDay < s.weekly.at + 240 && meta.get("last_weekly") !== today) summaries.push("weekly");
      }
    }
    let light: LightData | null | undefined;
    for (const kind of summaries) {
      if (!room2(3)) break;
      const list = await getItems();
      let content: string;
      let more: ReturnType<typeof summaryMoreRow> | undefined;
      let weeklyDone = 0;
      // «сколько висит» по будням: строка о давнем хвосте раз в 1–3 дня (B8); в субботу этим занимается разбор ниже
      const tailNote = kind === "morning" && wallOf(now, s.tz).wd !== 6 && list.some((o) => isTail(o, now)) && shouldNoteTail(today, meta.get("tail_note_day"));
      if (kind === "weekly") {
        const row = await repo.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'done' AND closed_reason = 'done' AND closed_at >= ?",
          now - 7 * 24 * 60 * MINUTE,
        );
        weeklyDone = row?.n ?? 0;
        const broken = weekSourceLines(passport, now, s.tz, enabledSources);
        const brokenLine = broken.length ? await haruLine("source_week") : null;
        content = weeklyText({ doneCount: row?.n ?? 0, items: list, now, tz: s.tz, ownerId: owner as string, character: s.character, limitsLine: weeklyLimitsLine(parseUsage(meta.get("usage"))), sources: broken, sourcesLine: brokenLine });
      } else {
        let extra: string[] = [];
        if (s.lightGroup && room2(3)) {
          if (light === undefined) {
            light = await readYasno();
          }
          const which = kind === "evening" ? "tomorrow" : "today";
          const forDate = localDate(kind === "evening" ? addDaysWall(now, 1, s.tz) : now, s.tz);
          if (light) extra = lightLines(which, s.lightGroup, light, forDate);
          else {
            // Yasno молчит: если знаем график с прошлого чтения — показываем его с пометкой «данные от …» (A7), иначе честно «не удалось»
            const last = parseLightLast(meta.get("light_last"));
            const known = lastKnownLightLines(last, which, s.lightGroup, forDate);
            extra = known && last
              ? [`💡 Yasno не отвечает, показываю последнее известное (${staleStamp(last.at, now, s.tz)}). Проверю ещё раз через ${LIGHT_RETRY_MIN} минут.`, ...known]
              : [`График света: не удалось получить данные (Yasno не отвечает). Проверю ещё раз через ${LIGHT_RETRY_MIN} минут.`];
          }
          if (light) ops2.push(setMeta("light_last", JSON.stringify(lightLastOf(light, s.lightGroup, now))));
          // сбой — не конец: перепроверяем через полчаса (потом раз в час, пока не получится) и пишем отдельным сообщением
          if (!light) ops2.push(setMeta("light_retry", JSON.stringify({ kind, date: today, at: now + LIGHT_RETRY_MIN * MINUTE, n: 1 })));
          else if (parseLightRetry(meta.get("light_retry"))) ops2.push(deleteMeta("light_retry"));
          // утром график на сегодня ещё не вышел: следим и пишем отдельным сообщением, когда появится (шаг 2б5)
          if (kind === "morning" && light && groupsFor(s.lightGroup, light).length > 0 && !publishedFor("today", s.lightGroup, light, today)) {
            ops2.push(setMeta("light_today_wait", today));
          }
          if (kind === "evening" && light && publishedFor("tomorrow", s.lightGroup, light, localDate(addDaysWall(now, 1, s.tz), s.tz))) {
            ops2.push(setMeta("light_tmr", localDate(addDaysWall(now, 1, s.tz), s.tz)));
          }
        }
        // «Коммуналка»: свет, вода (газ — позже) одним блоком; про воду — только если что-то идёт или скоро будет
        if (s.waterWords.length) extra = [...extra, ...waterSummaryLines(parseWaterState(meta.get("water_state")), now, s.tz)];
        if (s.gasWords.length) extra = [...extra, ...gasSummaryLines(parseGasState(meta.get("gas_state")), now, s.tz)];
        // источник давно молчит: сводка не делает вид, что всё тихо, а называет возраст данных (A7)
        const stale = (id: "water" | "gas", label: string): string => `${label}: источник не отвечает, ${passport[id]?.ok !== undefined ? staleStamp(passport[id]!.ok!, now, s.tz) : "данных пока нет"}.`;
        if (s.waterWords.length && isBroken(passport.water)) extra.push(stale("water", "Вода"));
        if (s.gasWords.length && isBroken(passport.gas)) extra.push(stale("gas", "Газ"));
        if (extra.length) extra = ["🏠 Коммуналка:", ...extra];
        // аниме: вечером — что выходит сегодня (реплику Хару даёт общая реплика сводки)
        if (kind === "evening" && room2(2)) {
          const lines = eveningLines(await listAnime(repo), now, s.tz, "neutral");
          if (lines.length) extra = [...extra, ...lines];
          if (isBroken(passport.shikimori)) extra = [...extra, `🎬 Расписание аниме: Shikimori не отвечает, ${passport.shikimori?.ok !== undefined ? staleStamp(passport.shikimori.ok, now, s.tz) : "данных пока нет"}.`];
        }
        const parts = summaryParts(kind, { items: list, now, tz: s.tz, ownerId: owner as string, extra, character: s.character, tailNote });
        content = parts.text;
        if (parts.truncated) more = summaryMoreRow(kind);
      }
      // реплика Хару под сводкой (этап 2): моделью или готовой фразой; не ставится на «возвращение», при сбое сводка уходит без неё
      if (mood && kind !== "return" && room2(3)) {
        try {
          await mood.load();
          const line = await summaryLine(mood, {
            kind,
            open: list.length,
            done: kind === "weekly" ? weeklyDone : undefined,
            wall: wallOf(now, s.tz),
            birthday: s.birthday,
            hot: kind === "morning" ? list.filter((o) => o.state === "overdue").length : undefined,
          });
          if (line) content = `${content}\n\n${line}`;
        } catch (e) {
          if (e instanceof BudgetExceeded) break;
        }
      }
      try {
        await api.postMessage(s.chRemind as string, { content, allowed_mentions: { users: [owner as string] }, ...(more ? { components: [more] } : {}) });
        report.summaries.push(kind);
        if (kind !== "return") ops2.push(setMeta(`last_${kind}`, today));
        if (tailNote) ops2.push(setMeta("tail_note_day", today));
        if (kind === "morning") ops2.push(...scrubOps(now));
      } catch (e) {
        if (e instanceof BudgetExceeded) break;
        healthy = false;
        ops2.push(event(now, "summary_failed", null, kind));
      }
    }

    // 2б1. субботний разбор давнего хвоста (этап 3, B2, B3, B6, B9): отдельное сообщение после утренней сводки, без упоминания.
    // Давнее = «висит» больше 7 суток; все сразу списком; предупреждение о заморозке до следующей субботы; «Висит» = 0 — одна тёплая строка.
    if (owner && s.chRemind && !away && wallOf(now, s.tz).wd === 6 && meta.get("last_review") !== today) {
      // разбор идёт сразу после утренней сводки (выключена утренняя сводка — разбора нет, замораживается всё равно)
      const base = s.morning;
      const summaryDone = meta.get("last_morning") === today || report.summaries.includes("morning");
      if (base !== null && summaryDone && minuteOfDay >= base && minuteOfDay < base + 240 && room2(6)) {
        try {
          const list = await getItems();
          const tail = list.filter((o) => isTail(o, now));
          const hot = list.filter((o) => o.state === "overdue" || o.state === "fired").length;
          if (tail.length === 0 && hot > 0) {
            ops2.push(setMeta("last_review", today)); // висит только свежее: оно в сводках, разбор не нужен
          } else {
            let line: string | null = null;
            if (mood) {
              await mood.load();
              line = await mood.sayLive(tail.length ? "tail_review" : "tail_clear", { facts: tail.length ? `давних дел: ${tail.length}` : "ничего не висит" });
            }
            let body;
            if (tail.length === 0) body = calmMessage(line);
            else {
              const fz = await repo.frozenCount(now - 7 * 24 * 60 * MINUTE);
              body = reviewMessage({ tail, soon: soonFrozen(list, now), frozenRecent: fz.recent, frozenTotal: fz.total, now, tz: s.tz, line });
            }
            await api.postMessage(s.chRemind, body);
            ops2.push(setMeta("last_review", today), event(now, "review", null, `n=${tail.length}`));
            report.notes.push(tail.length ? `разбор давнего: ${tail.length}` : "«Висит» = 0: тёплая строка");
          }
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) {
            healthy = false;
            ops2.push(event(now, "review_failed"));
          }
        }
      }
    }

    // 2б2. свет пропал дольше минуты: одно сообщение с упоминанием (не зависит от тихих часов и отъезда)
    if (room2(4)) {
      try {
        const o = await announceOutage({
          repo, api, now, ownerId: owner, meta, s, fetchFn: d.fetchFn, spend: () => repo.counter.spend(1),
        });
        if (o) {
          ops2.push(...o);
          report.notes.push("свет: отправлено «света нет»");
        }
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) {
          healthy = false;
          ops2.push(event(now, "power_failed"));
        }
      }
    }

    // 2б3. вечерняя сводка была, а график на завтра тогда ещё не вышел: проверяем раз в 10 минут и пишем один раз, когда появится
    {
      const tmr = localDate(addDaysWall(now, 1, s.tz), s.tz);
      if (
        s.lightGroup && owner && s.chRemind && !away && meta.get("last_evening") === today && meta.get("light_tmr") !== tmr &&
        Math.floor(now / MINUTE) % 10 === 0 && room2(4)
      ) {
        const data = await readYasno();
        if (data && publishedFor("tomorrow", s.lightGroup, data, tmr)) {
          try {
            await api.postMessage(s.chRemind, {
              content: `<@${owner}> ${tomorrowDigest(s.lightGroup, data, tmr, MOOD_CONFIG.address)}`,
              allowed_mentions: { users: [owner] },
            });
            ops2.push(setMeta("light_tmr", tmr), event(now, "light_tomorrow"));
            report.notes.push("свет: график на завтра отправлен");
          } catch (e) {
            if (!(e instanceof BudgetExceeded)) report.notes.push("свет: не удалось отправить график на завтра");
          }
        }
      }
    }

    // 2б4. сводка вышла без света (Yasno не ответил): проверяем снова: первые разы раз в полчаса, потом раз в час, пока не получится (или не кончатся сутки)
    {
      const retry = parseLightRetry(meta.get("light_retry"));
      if (retry && s.lightGroup && owner && s.chRemind && now >= retry.at && room2(4)) {
        const stale = retry.date !== today || away;
        if (stale) {
          ops2.push(deleteMeta("light_retry"));
        } else {
          const data = await readYasno();
          const tmr = localDate(addDaysWall(now, 1, s.tz), s.tz);
          const text = data
            ? ["Yasno снова отвечает.", ...lightLines(retry.kind === "evening" ? "tomorrow" : "today", s.lightGroup, data, retry.kind === "evening" ? tmr : today)].join("\n")
            : null;
          if (text) {
            try {
              await api.postMessage(s.chRemind, { content: `<@${owner}> ${text}`, allowed_mentions: { users: [owner] } });
              ops2.push(deleteMeta("light_retry"));
              if (data && retry.kind === "evening" && publishedFor("tomorrow", s.lightGroup, data, tmr)) ops2.push(setMeta("light_tmr", tmr));
              if (data && retry.kind === "morning" && groupsFor(s.lightGroup, data).length > 0 && !publishedFor("today", s.lightGroup, data, today)) ops2.push(setMeta("light_today_wait", today));
              report.notes.push("свет: повторная проверка удалась");
            } catch (e) {
              if (!(e instanceof BudgetExceeded)) report.notes.push("свет: не удалось отправить повторную проверку");
            }
          } else {
            ops2.push(setMeta("light_retry", JSON.stringify({ ...retry, at: now + (retry.n < LIGHT_RETRY_FAST ? LIGHT_RETRY_MIN : LIGHT_RETRY_SLOW_MIN) * MINUTE, n: retry.n + 1 })));
          }
        }
      }
    }

    // 2б5. утренняя сводка вышла, а график на сегодня тогда ещё не был опубликован: проверяем раз в 10 минут до конца суток и пишем один раз, когда появится
    if (
      s.lightGroup && owner && s.chRemind && !away && meta.get("light_today_wait") === today &&
      Math.floor(now / MINUTE) % 10 === 5 && room2(4)
    ) {
      const data = await readYasno();
      if (data && publishedFor("today", s.lightGroup, data, today)) {
        try {
          await api.postMessage(s.chRemind, {
            content: `<@${owner}> ${tomorrowDigest(s.lightGroup, data, today, MOOD_CONFIG.address, "today")}`,
            allowed_mentions: { users: [owner] },
          });
          ops2.push(deleteMeta("light_today_wait"), event(now, "light_today"));
          report.notes.push("свет: график на сегодня отправлен");
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) report.notes.push("свет: не удалось отправить график на сегодня");
        }
      }
    }

    // 2б5а. свет не читается давно (этап 4, A4): одно сообщение сразу (голосом Хару), дальше раз в неделю в итоге
    if (owner && s.chRemind && !away && s.lightGroup && lightNoticeDue(passport.light, now) && room2(5)) {
      const line = await haruLine("source_down");
      const facts = "💡 Yasno не отвечает уже несколько часов, поэтому не могу прочитать график света. В сводках показываю последний известный с пометкой «данные от…», а как только Yasno заработает, пришлю свежий. Проверить самим: app.yasno.ua.";
      try {
        await api.postMessage(s.chRemind, { content: line ? `${line}\n${facts}` : facts, allowed_mentions: { parse: [] } });
        passport = markSaid(passport, "light");
        passportDirty = true;
        ops2.push(event(now, "source_down", null, "light"));
        report.notes.push("свет: сообщение о долгом сбое Yasno");
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) report.notes.push("свет: не удалось сообщить о долгом сбое");
      }
    }

    /** Отправить очередь сообщений коммуналки в «почту»; что не ушло (сбой Discord, лимит) — остаётся на следующую минуту. */
    const flushOutbox = async (outbox: { text: string; mention: boolean }[], what: string) => {
      while (outbox.length && room2(2)) {
        const m = outbox[0];
        try {
          await api.postMessage(s.chRemind as string, {
            content: m.mention ? `<@${owner}> ${m.text}` : m.text,
            allowed_mentions: m.mention ? { users: [owner as string] } : { parse: [] },
          });
          outbox.shift();
          report.notes.push(`${what}: сообщение отправлено`);
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) {
            healthy = false;
            ops2.push(event(now, `${what}_send_failed`));
          }
          break;
        }
      }
      return outbox;
    };

    // 2б4. вода: раз в час читаем ленту водоканала; предупреждения по времени (накануне вечером, за 2 часа) — каждую минуту без запросов.
    // Сообщения сначала кладём в очередь (meta water_outbox) и только потом отправляем: сбой Discord не теряет предупреждение.
    if (s.waterWords.length && owner && s.chRemind) {
      let st = parseWaterState(meta.get("water_state"));
      let outbox: { text: string; mention: boolean }[] = [];
      try {
        const v = JSON.parse(meta.get("water_outbox") ?? "[]");
        if (Array.isArray(v)) outbox = v;
      } catch {
        /* повреждено: пусто */
      }
      const before = JSON.stringify(st) + JSON.stringify(outbox);
      let next: string | null = null;
      if (now >= (Number(meta.get("water_next") ?? 0) || 0) && room2(5)) {
        repo.counter.spend(1);
        const posts = await fetchWater(d.fetchFn ?? fetch);
        if (posts) {
          const r = planWater(st, posts, s.waterWords, now, s.tz);
          st = r.state;
          outbox.push(...r.notices);
          next = String(now + WATER_CHECK_EVERY);
          note("water", true);
        } else {
          note("water", false);
          const r = failWater(st);
          st = r.state;
          if (r.notice) outbox.push(await voiced(r.notice));
          next = String(now + WATER_RETRY_AFTER);
          report.notes.push("вода: лента водоканала не прочиталась");
        }
      }
      if (!away) {
        const r = dueWater(st, now, s.tz, s.evening ?? 20 * 60);
        st = r.state;
        outbox.push(...r.notices);
      }
      // отправка: срочное (с упоминанием) не ждёт тихих часов; при сбое остаток остаётся в очереди до следующей минуты
      outbox = await flushOutbox(outbox, "water");
      outbox = outbox.slice(-6);
      if (next) ops2.push(setMeta("water_next", next));
      if (JSON.stringify(st) + JSON.stringify(outbox) !== before) {
        ops2.push(setMeta("water_state", JSON.stringify(st)), outbox.length ? setMeta("water_outbox", JSON.stringify(outbox)) : deleteMeta("water_outbox"));
      }
    }

    // 2б5. газ: раз в час главная страница газовиков (файл с графиком — только когда ссылка новая и раз в сутки);
    // напоминания «накануне вечером» и «утром в день работ» — каждую минуту без запросов; очередь как у воды
    if (s.gasWords.length && owner && s.chRemind) {
      let st = parseGasState(meta.get("gas_state"));
      let outbox: { text: string; mention: boolean }[] = [];
      try {
        const v = JSON.parse(meta.get("gas_outbox") ?? "[]");
        if (Array.isArray(v)) outbox = v;
      } catch {
        /* повреждено: пусто */
      }
      const before = JSON.stringify(st) + JSON.stringify(outbox);
      let next: string | null = null;
      if (now >= (Number(meta.get("gas_next") ?? 0) || 0) && room2(6)) {
        repo.counter.spend(2);
        const got = await fetchGas(st, now, d.fetchFn ?? fetch);
        if (got) {
          const r = planGas(st, got.link, got.schedule, s.gasWords, now, s.tz);
          st = r.state;
          outbox.push(...r.notices);
          next = String(now + GAS_CHECK_EVERY);
          note("gas", true);
        } else {
          note("gas", false);
          const r = failGas(st);
          st = r.state;
          if (r.notice) outbox.push(await voiced(r.notice));
          next = String(now + GAS_RETRY_AFTER);
          report.notes.push("газ: график не прочитался");
        }
      }
      if (!away) {
        const r = dueGas(st, now, s.tz, s.evening ?? 20 * 60, s.morning ?? 8 * 60);
        st = r.state;
        outbox.push(...r.notices);
      }
      outbox = (await flushOutbox(outbox, "gas")).slice(-6);
      if (next) ops2.push(setMeta("gas_next", next));
      if (JSON.stringify(st) + JSON.stringify(outbox) !== before) {
        ops2.push(setMeta("gas_state", JSON.stringify(st)), outbox.length ? setMeta("gas_outbox", JSON.stringify(outbox)) : deleteMeta("gas_outbox"));
      }
    }

    // 2б6. аниме: ночное обновление расписания и утреннее «посмотрели?»
    if (owner && s.chRemind) {
      const r = await runAnime({
        repo, api, now, s, meta, owner, away, quiet: inQuietHours(s, minuteOfDay), minuteOfDay, fetchFn: d.fetchFn ?? fetch, rand: d.rand,
        room: room2, spend: (n) => repo.counter.spend(n), note, voice: () => haruLine("source_down"),
      });
      ops2.push(...r.ops);
      report.notes.push(...r.notes);
      if (!r.healthy) healthy = false;
    }

    // 2в. панель «Горит»: правим одно сообщение, раз в 5 минут и только если изменилась
    if (!away && s.chToday && Math.floor(now / MINUTE) % 5 === 0 && room2(3)) {
      const text = panelText(await getItems(), now, s.tz, s.character);
      const h = hash(text);
      if (meta.get("panel_hash") !== h) {
        const body = { content: text, allowed_mentions: { parse: [] } };
        const id = meta.get("panel_msg_id");
        try {
          let msgId = id;
          let done = false;
          if (id) {
            try {
              await api.editMessage(s.chToday, id, body);
              done = true;
            } catch (e) {
              if (!(e instanceof DiscordError && e.status === 404)) throw e;
            }
          }
          if (!done) msgId = (await api.postMessage(s.chToday, body)).id;
          ops2.push(setMeta("panel_msg_id", msgId as string), setMeta("panel_hash", h));
          report.panel = true;
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) {
            healthy = false;
            ops2.push(event(now, "panel_failed"));
          }
        }
      }
    }
  } catch (e) {
    healthy = false;
    report.notes.push(`ошибка: ${(e as Error).message}`);
    ops2.push(event(now, "cron_error", null, String((e as Error).message).slice(0, 200)));
  }
  if (mood?.loaded) ops2.push(...mood.ops());
  if (passportDirty) ops2.push(setMeta(PASSPORT_KEY, JSON.stringify(passport)));
  if (ops2.length) await repo.exec(ops2);

  // ---------- 3. пинг сторожу: раз в 10 минут ----------
  // can(2): один подзапрос всегда остаётся на запись запаса лимитов (шаг 5), иначе самый тесный запуск остался бы невидимым
  if (d.env.watchdogUrl && Math.floor(now / MINUTE) % 10 === 0 && repo.counter.can(2)) {
    repo.counter.spend(1);
    const url = healthy ? d.env.watchdogUrl : `${d.env.watchdogUrl.replace(/\/$/, "")}/fail`;
    try {
      await (d.ping ?? defaultPing)(url);
      report.ping = healthy ? "ok" : "fail";
    } catch {
      report.ping = "fail";
    }
  }

  // ---------- 4. быстрый опрос приёма ----------
  // Текст, написанный в канал, обычная проверка в начале минуты подхватывает до 60 с спустя. Поэтому запуск не заканчивается:
  // ещё несколько раз с паузой читает те же каналы тем же кругом приёма (шаг 2а). Состояние (что прочитано) — в памяти запуска и в базе.
  const fp = d.fastPoll;
  if (fp && intakeOn) {
    const clock = fp.clock ?? Date.now;
    const sleep = fp.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let i = 1; i <= fp.rounds; i++) {
      const due = i * fp.everyMs;
      if (due > fp.maxMs) break;
      const wait = startedAt + due - clock();
      if (wait > 0) await sleep(wait);
      if (!repo.counter.can(6)) break; // нужны: опрос (до двух каналов), запись прочитанного и запись запаса лимитов
      const out: Op[] = [];
      try {
        await intakeRound(out, now + (clock() - startedAt));
        if (mood?.loaded) out.push(...mood.ops());
        if (out.length) await repo.exec(out);
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) report.notes.push(`быстрый опрос: ${(e as Error).message}`);
        break;
      }
    }
  }

  // ---------- 5. запас бесплатных лимитов (usage.ts): считаем итог запуска, при тесноте предупреждаем заранее ----------
  if (repo.counter.can(1)) {
    const days = addRun(parseUsage(meta.get("usage")), {
      now,
      subrequests: repo.counter.used + 1, // +1 — сама запись ниже
      rowsRead: repo.counter.rowsRead,
      rowsWritten: repo.counter.rowsWritten,
      dbBytes: repo.counter.dbBytes,
      neurons: repo.counter.neurons,
      gapMin: gapMinutes(pre.prevAliveAt, now),
    });
    const uops: Op[] = [setMeta("usage", JSON.stringify(days))];
    if (owner && s.chRemind && !away && !inQuietHours(s, minuteOfDay) && repo.counter.can(3)) {
      const warned = parseWarned(meta.get("limit_warned"));
      const ws = limitWarnings(days, now, s.tz, warned);
      const text = warningMessage(ws, owner);
      if (text) {
        try {
          await api.postMessage(s.chRemind, { content: text, allowed_mentions: { users: [owner] } });
          uops.push(setMeta("limit_warned", JSON.stringify(markWarned(warned, ws, now))), event(now, "limit_warn", null, ws.map((w) => w.metric).join(",")));
          report.notes.push(`лимиты: предупреждение (${ws.map((w) => w.metric).join(", ")})`);
        } catch {
          /* не вышло отправить: повторим в следующую минуту */
        }
      }
    }
    try {
      await repo.exec(uops);
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) report.notes.push(`лимиты: не записались (${(e as Error).message})`);
    }
  }
  report.subrequests = repo.counter.used;
  return report;
}

async function defaultPing(url: string): Promise<void> {
  await fetch(url, { method: "GET" });
}

export type { AppSettings };
