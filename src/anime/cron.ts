// Аниме в cron: ночное обновление расписания, озвучка AniLibria, утреннее «посмотрели?», начало сезона, «между прочим» в воскресенье.
// Каждый кусок бережёт подзапросы: раз в сутки по метке в meta, без повода в базу и в сеть не ходим.
import { BudgetExceeded, type Repo, deleteMeta, event, setMeta } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import type { DiscordApi } from "../discord/types.ts";
import type { AppSettings } from "../settings.ts";
import { localDate, wallOf } from "../time/tz.ts";
import {
  type Anime,
  SEQ_AFTER_ASK,
  WEEKQ_AT,
  WEEKQ_TTL,
  WEEKQ_WINDOW,
  WEEK_DAY,
  effective,
  idleTime,
  noticeSet,
  seasonStart,
  sinceText,
  voiceAverage,
  voiceObservation,
  weekPicks,
} from "./core.ts";
import { type FetchFn, fetchSchedules, fetchSequels, fetchVoice } from "./sources.ts";
import { listAnime, patchOp, scheduleOp, seqMarkOp, voiceOp, weekMarkOp } from "./store.ts";
import { type AskItem, type WeekAsk, askMessage, askPauseMessage, seasonStartMessage, weekExpiredBody, weekQuestion } from "./ui.ts";
import { MINUTE } from "../time/tz.ts";

export interface AnimeCronArgs {
  repo: Repo;
  api: DiscordApi;
  now: number;
  s: AppSettings;
  meta: Map<string, string>;
  owner: string;
  away: boolean;
  /** тихие часы: вопросы «между прочим» и «начинается» в них не шлём */
  quiet?: boolean;
  minuteOfDay: number;
  fetchFn: FetchFn;
  rand?: () => number;
  /** хватит ли подзапросов на n действий (как room2 в cron) */
  room: (n: number) => boolean;
  spend: (n: number) => void;
}

/** С какого часа (минут от полуночи) обновляем расписание: ночью, когда в источниках уже свежие данные. */
export const REFRESH_FROM = 3 * 60;
export const REFRESH_RETRY = 60 * MINUTE;
/** Озвучку читаем отдельным запуском, через десять минут после расписания (так нагрузка на запуск Worker меньше). */
export const VOICE_FROM = REFRESH_FROM + 10;
/** Сколько подряд неудачных обновлений (по часу) терпим, прежде чем один раз написать. */
export const FAIL_NOTICE_AT = 3;
/** Озвучка необязательна: три неудачи за день — и до завтра не пробуем, сообщений об этом нет. */
export const VOICE_FAIL_MAX = 3;

export const FAIL_NOTICE = "Расписание аниме не обновляется уже несколько часов (Shikimori не отвечает). Показываю последние известные данные. Как только источник заработает, всё вернётся само.";

/** Что запомнили про висящий вопрос «между прочим»: куда отправили и когда (через сутки снимаем кнопки). */
export interface WeekMsg {
  ch: string;
  msg: string;
  at: number;
}

export function parseWeekMsg(raw: string | undefined): WeekMsg | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<WeekMsg>;
    return typeof j.ch === "string" && typeof j.msg === "string" && typeof j.at === "number" ? { ch: j.ch, msg: j.msg, at: j.at } : null;
  } catch {
    return null;
  }
}

/** Выполнить аниме-часть минутного цикла: возвращает записи для общей пачки и пометки в отчёт. */
export async function runAnime(a: AnimeCronArgs): Promise<{ ops: Op[]; notes: string[]; healthy: boolean }> {
  const { repo, api, now, s, meta } = a;
  const ops: Op[] = [];
  const notes: string[] = [];
  let healthy = true;
  const today = localDate(now, s.tz);
  // таблицу читаем не больше раза за запуск (записи накапливаются в ops и применяются в конце цикла, так что повторное чтение ничего бы не дало)
  let cache: Anime[] | null = null;
  const rows = async (): Promise<Anime[]> => (cache ??= await listAnime(repo));
  const morningDone = meta.get("last_morning") === today || (s.morning === null && a.minuteOfDay >= 9 * 60);

  // ---------- ночное обновление расписания ----------
  if (a.minuteOfDay >= REFRESH_FROM && meta.get("anime_refresh") !== today && now >= (Number(meta.get("anime_next") ?? 0) || 0) && a.room(12)) {
    const tracked = (await rows()).filter((x) => x.status === "watching" || x.status === "planned");
    if (!tracked.length) {
      ops.push(setMeta("anime_refresh", today));
    } else {
      a.spend(1 + Math.min(8, tracked.length));
      const got = await fetchSchedules(tracked.map((x) => x.mal_id), a.fetchFn);
      if (got) {
        for (const r of tracked) {
          const sch = got.find((x) => x.mal === r.mal_id);
          if (sch) ops.push(scheduleOp(r, sch, now));
        }
        ops.push(setMeta("anime_refresh", today), setMeta("anime_ok_at", String(now)), setMeta("anime_fail", "0"), setMeta("anime_fail_notice", "0"));
        notes.push(`аниме: расписание обновлено (${got.length} из ${tracked.length})`);
      } else {
        const fails = (Number(meta.get("anime_fail") ?? 0) || 0) + 1;
        ops.push(setMeta("anime_fail", String(fails)), setMeta("anime_next", String(now + REFRESH_RETRY)));
        notes.push("аниме: расписание не прочиталось");
        if (fails >= FAIL_NOTICE_AT && meta.get("anime_fail_notice") !== "1" && a.s.chRemind && a.room(2)) {
          try {
            await api.postMessage(a.s.chRemind, { content: FAIL_NOTICE, allowed_mentions: { parse: [] } });
            ops.push(setMeta("anime_fail_notice", "1"));
          } catch (e) {
            if (!(e instanceof BudgetExceeded)) healthy = false;
          }
        }
      }
    }
  }

  // ---------- озвучка AniLibria: раз в сутки, после расписания, отдельным запуском; сбой — молча ----------
  if (a.minuteOfDay >= VOICE_FROM && meta.get("anime_refresh") === today && meta.get("anime_voice") !== today && now >= (Number(meta.get("anime_voice_next") ?? 0) || 0) && a.room(4)) {
    const tracked = (await rows()).filter((x) => x.status === "watching" || x.status === "planned");
    if (!tracked.length) {
      ops.push(setMeta("anime_voice", today));
    } else {
      a.spend(1);
      const got = await fetchVoice(a.fetchFn);
      if (got) {
        let n = 0;
        for (const r of tracked) {
          const v = got.find((x) => x.mal === r.mal_id);
          const obs = v ? voiceObservation(r, v, now) : null;
          if (v && obs !== null && v.nextEp !== null) {
            ops.push(voiceOp(r.id, voiceAverage(r.voice_lag, r.voice_n, obs), r.voice_n + 1, v.nextEp - 1));
            n++;
          }
        }
        ops.push(setMeta("anime_voice", today), setMeta("anime_voice_fail", "0"));
        notes.push(`аниме: озвучка AniLibria (замеров: ${n}, тайтлов в расписании: ${got.length})`);
      } else {
        const fails = (Number(meta.get("anime_voice_fail") ?? 0) || 0) + 1;
        ops.push(setMeta("anime_voice_fail", String(fails)), fails >= VOICE_FAIL_MAX ? setMeta("anime_voice", today) : setMeta("anime_voice_next", String(now + REFRESH_RETRY)));
        notes.push("аниме: озвучка AniLibria не прочиталась");
      }
    }
  }

  // ---------- утреннее «посмотрели?»: после утренней сводки, раз в день, только если что-то вышло ----------
  if (s.chRemind && !a.away && morningDone && meta.get("anime_ask") !== today && meta.get("anime_ask_off") !== "1" && meta.get("anime_ask_wait") !== "1" && a.room(3)) {
    const items: AskItem[] = noticeSet(await rows())
      .map((x) => ({ a: x, ...effective(x, now) }))
      .filter((x) => x.airedEp > Math.max(x.a.watched, x.a.asked_ep))
      .map((x) => ({ a: x.a, airedEp: x.airedEp, airedAt: x.airedAt }));
    const unanswered = Number(meta.get("anime_unanswered") ?? 0) || 0;
    if (!items.length) {
      ops.push(setMeta("anime_ask", today));
    } else if (unanswered >= 3) {
      try {
        await api.postMessage(s.chRemind, askPauseMessage());
        ops.push(setMeta("anime_ask", today), setMeta("anime_ask_wait", "1"), setMeta("anime_unanswered", "0"), event(now, "anime_pause_asked"));
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) healthy = false;
      }
    } else {
      try {
        await api.postMessage(s.chRemind, askMessage(items, now, s.tz, s.character, a.rand));
        ops.push(
          ...items.map((x) => patchOp(x.a.id, { asked_ep: x.airedEp }, now)),
          setMeta("anime_ask", today),
          setMeta("anime_unanswered", String(unanswered + 1)),
          event(now, "anime_asked", null, `n=${items.length}`),
        );
        notes.push("аниме: спросила про вышедшие серии");
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) healthy = false;
      }
    }
  }

  // ---------- начало сезона: утром в день старта тайтла из «В планах», отдельным сообщением ----------
  if (s.chRemind && !a.away && !a.quiet && morningDone && meta.get("anime_start") !== today && a.room(4)) {
    const due = (await rows())
      .map((x) => ({ a: x, at: seasonStart(x, now, s.tz) }))
      .filter((x): x is { a: Anime; at: number } => x.at !== null)
      .sort((x, y) => x.at - y.at)
      .slice(0, 2);
    let sent = 0;
    for (const x of due) {
      if (!a.room(3)) break;
      try {
        await api.postMessage(s.chRemind, seasonStartMessage(x.a, x.at, now, s.tz, s.character, a.rand));
        ops.push(patchOp(x.a.id, { start_asked: 1 }, now), event(now, "anime_season_start"));
        sent++;
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) healthy = false;
        break;
      }
    }
    if (sent === due.length && due.length < 2) ops.push(setMeta("anime_start", today));
    if (sent) notes.push(`аниме: начало сезона (${sent})`);
  }

  // ---------- «между прочим»: снять вопрос без ответа через сутки ----------
  const hang = parseWeekMsg(meta.get("anime_weekq"));
  if (hang && now >= hang.at + WEEKQ_TTL && a.room(2)) {
    try {
      await api.editMessage(hang.ch, hang.msg, weekExpiredBody());
      ops.push(deleteMeta("anime_weekq"));
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) ops.push(deleteMeta("anime_weekq")); // сообщение уже удалено — снимать нечего
    }
  }

  // ---------- «между прочим»: воскресенье вечером, один вопрос в неделю ----------
  if (
    s.chRemind && !a.away && !a.quiet && wallOf(now, s.tz).wd === WEEK_DAY && a.minuteOfDay >= WEEKQ_AT && a.minuteOfDay < WEEKQ_AT + WEEKQ_WINDOW &&
    meta.get("anime_week") !== today && a.room(8)
  ) {
    const all = await rows();
    const p = weekPicks(all, now);
    let q: WeekAsk | null = p.cont ? { kind: "cont", a: p.cont, idle: idleTime(p.cont, now) } : p.ep ? { kind: "ep", a: p.ep } : null;
    let seqAsked: Op | null = null;
    if (!q) {
      // продолжение закончившегося сезона: до трёх запросов в Shikimori, только если вопросов поважнее нет
      const known = new Set(all.map((r) => r.mal_id));
      for (const x of p.seq) {
        if (!a.room(6)) break;
        a.spend(1);
        const sq = await fetchSequels(x.mal_id, a.fetchFn);
        if (sq === null) continue;
        const fresh = sq.find((z) => !known.has(z.mal));
        if (fresh) {
          q = { kind: "seq", a: x, sequel: fresh };
          seqAsked = seqMarkOp(x.id, now + SEQ_AFTER_ASK);
          break;
        }
        ops.push(seqMarkOp(x.id, now));
      }
    }
    if (!q && p.planned) q = { kind: "planned", a: p.planned, since: sinceText(p.planned, s.tz) };
    if (!q && p.liked) q = { kind: "liked", a: p.liked };
    if (!q) {
      ops.push(setMeta("anime_week", today));
    } else {
      try {
        const sent = await api.postMessage(s.chRemind, weekQuestion(q, now, s.character, a.rand));
        ops.push(
          setMeta("anime_week", today),
          setMeta("anime_weekq", JSON.stringify({ ch: s.chRemind, msg: sent.id, at: now } satisfies WeekMsg)),
          seqAsked ?? weekMarkOp(q.a.id, now),
          event(now, "anime_week_asked", null, q.kind),
        );
        notes.push(`аниме: между прочим (${q.kind})`);
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) healthy = false;
      }
    }
  }
  return { ops, notes, healthy };
}
