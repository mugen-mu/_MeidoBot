// Цикл cron раз в минуту (DESIGN §8). Worker без памяти: всё состояние в базе, любой сбой подхватит следующий запуск.
// На бесплатном плане за запуск можно сделать 50 подзапросов (D1 и Discord вместе): считаем их и оставляем запас
// на запись результата и пинг сторожу.
import { BudgetExceeded, type Repo, event, releaseLocks, rememberMessage, setMeta, setSetting, updateOcc } from "./db/repo.ts";
import type { OccView, Op } from "./db/types.ts";
import { type DiscordApi, DiscordError } from "./discord/types.ts";
import {
  type Look,
  panelText,
  reminderMessage,
  summaryText,
  weeklyText,
} from "./discord/ui.ts";
import type { AiBinding } from "./llm.ts";
import { createFromText, EMPTY_REPLY, EMPTY_SERIES_REPLY, messageTime, SECRET_REPLY } from "./intake.ts";
import { MoodSession, canStyle, makeCtx } from "./personality/director.ts";
import { maidEmbed, pickReaction, wantSprite } from "./personality/look.ts";
import { isPolite, isSeriousTopic } from "./personality/moodEngine.ts";
import { detectUserWord } from "./personality/userWords.ts";
import { announceOutage } from "./power.ts";
import { handleReply } from "./reply.ts";
import { fetchYasno, lightLines, publishedFor, tomorrowDigest, type LightData } from "./light.ts";
import { MOOD_CONFIG } from "./personality/config.ts";
import { planFire } from "./ladder.ts";
import { ladderFor, nextSeriesOps, scrubOps } from "./service.ts";
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
}

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
  const { repo, api, now } = d;
  const token = d.token ?? crypto.randomUUID();
  const report: CronReport = { claimed: 0, sent: 0, deferred: 0, failed: 0, summaries: [], panel: false, intake: 0, ping: "skip", subrequests: 0, notes: [] };
  const pre = await repo.prelude(now, d.maxSends ?? MAX_SENDS, token);
  const s = pre.settings;
  const meta = pre.meta;
  const owner = meta.get("owner_id") ?? d.env.ownerId ?? null;
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
    s.moodOn && owner ? new MoodSession({ repo, userId: owner, ctx: makeCtx(now, s), rand: d.rand, style: s.style }) : null;

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
          if (becameOverdue) mood.apply({ type: "miss" });
          if (canStyle(occ.title, occ.critical)) {
            const situation = becameOverdue
              ? mood.state!.missStreak === 1 ? "missed_first" : "missed"
              : plan.phase === "overdue" ? "missed" : occ.fire_count === 0 && occ.state === "planned" ? "reminder" : "reminder_repeat";
            // повторное «просрочено» не должно каждый раз грозить: драма — с паузой, внутри say()
            flavor = mood.say(situation, { task: occ.title });
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
  /** Реакция-эмодзи по настроению на сообщение хозяина (этап Х3): редко, на серьёзные темы — никогда; сбой реакции не страшен. */
  const react = async (ch: string, messageId: string, always: boolean, text = ""): Promise<void> => {
    if (!mood?.loaded || !room2(1) || isSeriousTopic(text)) return;
    const e = pickReaction(mood.state!.mood, mood.rand, always);
    if (!e) return;
    try {
      await api.addReaction(ch, messageId, e);
    } catch {
      /* нет права или сообщения уже нет: не страшно */
    }
  };
  try {
    let items: OccView[] | null = null;
    const getItems = async () => (items ??= await repo.openMain(100));
    const today = localDate(now, s.tz);

    // 2а. обычный текст из каналов приёма: основной путь записи дел;
    // канал напоминаний читаем только ради ответов (Reply) на сообщения-напоминания
    if (owner) {
      const channels = s.intake.map((ch) => ({ ch, replies: false }));
      if (s.chRemind && !s.intake.includes(s.chRemind)) channels.push({ ch: s.chRemind, replies: true });
      for (const { ch, replies } of channels) {
        if (!room2(2)) break;
        const lastKey = `intake_last:${ch}`;
        const last = meta.get(lastKey);
        if (last === undefined) {
          const latest = await api.listMessages(ch, null, 1);
          ops2.push(setMeta(lastKey, latest.length ? latest[latest.length - 1].id : "0"));
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
          // настроение: любое сообщение хозяина — активность; «спасибо» горничной — вежливость, дело из этого не создаём
          if (mood && room2(3)) {
            await mood.load();
            // «ара-ара», «ганбатте» и т.п. от хозяина: ответ в тон, симпатия +1 (раз в час); делом это не записываем
            const word = s.style.level >= 1 ? detectUserWord(m.content) : null;
            if (word) {
              const line = mood.hearWord(word);
              report.intake++;
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
              const line = mood.say("thanks");
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
          const r = await createFromText({ repo, settings: s, now, ai: d.ai }, m.content, "channel", { at: messageTime(m, now) });
          report.intake++;
          const reply =
            r.kind === "created"
              ? r.message
              : { content: r.kind === "secret" ? SECRET_REPLY : r.kind === "empty" ? EMPTY_REPLY : EMPTY_SERIES_REPLY, allowed_mentions: { parse: [] } };
          if (r.kind === "secret") ops2.push(event(now, "secret_seen", null, "intake"));
          try {
            await api.postMessage(ch, reply);
          } catch (e) {
            if (e instanceof BudgetExceeded) break;
            report.notes.push("не удалось ответить на сообщение в канале приёма");
          }
          if (r.kind === "created") await react(ch, m.id, false, m.content);
        }
        if (lastId !== last) ops2.push(setMeta(lastKey, lastId));
        if (blind > 0) {
          ops2.push(event(now, "intake_blind", null, `n=${blind}`));
          if (meta.get("intake_blind_notice") !== today && room2(1)) {
            try {
              await api.postMessage(ch, {
                content:
                  "Не вижу текст сообщений в этом канале. Включите Message Content Intent в настройках приложения в Discord Developer Portal или пишите боту в личные сообщения.",
                allowed_mentions: { parse: [] },
              });
              ops2.push(setMeta("intake_blind_notice", today));
            } catch {
              /* повторим завтра */
            }
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
      if (kind === "weekly") {
        const row = await repo.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'done' AND closed_reason = 'done' AND closed_at >= ?",
          now - 7 * 24 * 60 * MINUTE,
        );
        content = weeklyText({ doneCount: row?.n ?? 0, items: list, now, tz: s.tz, ownerId: owner as string, character: s.character });
      } else {
        let extra: string[] = [];
        if (s.lightGroup && room2(3)) {
          if (light === undefined) {
            repo.counter.spend(1);
            light = await fetchYasno(d.fetchFn ?? fetch);
          }
          extra = light
            ? lightLines(kind === "evening" ? "tomorrow" : "today", s.lightGroup, light, localDate(kind === "evening" ? addDaysWall(now, 1, s.tz) : now, s.tz))
            : ["График света: не удалось получить данные (Yasno не отвечает)."];
          if (kind === "evening" && light && publishedFor("tomorrow", s.lightGroup, light, localDate(addDaysWall(now, 1, s.tz), s.tz))) {
            ops2.push(setMeta("light_tmr", localDate(addDaysWall(now, 1, s.tz), s.tz)));
          }
        }
        content = summaryText(kind, { items: list, now, tz: s.tz, ownerId: owner as string, extra, character: s.character });
      }
      try {
        await api.postMessage(s.chRemind as string, { content, allowed_mentions: { users: [owner as string] } });
        report.summaries.push(kind);
        if (kind !== "return") ops2.push(setMeta(`last_${kind}`, today));
        if (kind === "morning") ops2.push(...scrubOps(now));
      } catch (e) {
        if (e instanceof BudgetExceeded) break;
        healthy = false;
        ops2.push(event(now, "summary_failed", null, kind));
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
        repo.counter.spend(1);
        const data = await fetchYasno(d.fetchFn ?? fetch);
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
  if (ops2.length) await repo.exec(ops2);

  // ---------- 3. пинг сторожу: раз в 10 минут ----------
  if (d.env.watchdogUrl && Math.floor(now / MINUTE) % 10 === 0 && repo.counter.can(1)) {
    repo.counter.spend(1);
    const url = healthy ? d.env.watchdogUrl : `${d.env.watchdogUrl.replace(/\/$/, "")}/fail`;
    try {
      await (d.ping ?? defaultPing)(url);
      report.ping = healthy ? "ok" : "fail";
    } catch {
      report.ping = "fail";
    }
  }
  report.subrequests = repo.counter.used;
  return report;
}

async function defaultPing(url: string): Promise<void> {
  await fetch(url, { method: "GET" });
}

export type { AppSettings };
