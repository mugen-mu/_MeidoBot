// Аниме в cron: ночное обновление расписания и утреннее «посмотрели?». Каждый кусок бережёт подзапросы:
// раз в сутки по метке в meta, без метки-повода в базу и в сеть не ходим.
import { BudgetExceeded, type Repo, event, setMeta } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import type { DiscordApi } from "../discord/types.ts";
import type { AppSettings } from "../settings.ts";
import { localDate } from "../time/tz.ts";
import { effective, noticeSet } from "./core.ts";
import { type FetchFn, fetchSchedules } from "./sources.ts";
import { listAnime, patchOp, scheduleOp } from "./store.ts";
import { askMessage, askPauseMessage, type AskItem } from "./ui.ts";
import { MINUTE } from "../time/tz.ts";

export interface AnimeCronArgs {
  repo: Repo;
  api: DiscordApi;
  now: number;
  s: AppSettings;
  meta: Map<string, string>;
  owner: string;
  away: boolean;
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
/** Сколько подряд неудачных обновлений (по часу) терпим, прежде чем один раз написать. */
export const FAIL_NOTICE_AT = 3;

export const FAIL_NOTICE = "Расписание аниме не обновляется уже несколько часов (Shikimori не отвечает). Показываю последние известные данные. Как только источник заработает, всё вернётся само.";

/** Выполнить аниме-часть минутного цикла: возвращает записи для общей пачки и пометки в отчёт. */
export async function runAnime(a: AnimeCronArgs): Promise<{ ops: Op[]; notes: string[]; healthy: boolean }> {
  const { repo, api, now, s, meta } = a;
  const ops: Op[] = [];
  const notes: string[] = [];
  let healthy = true;
  const today = localDate(now, s.tz);

  // ---------- ночное обновление расписания ----------
  if (a.minuteOfDay >= REFRESH_FROM && meta.get("anime_refresh") !== today && now >= (Number(meta.get("anime_next") ?? 0) || 0) && a.room(12)) {
    const rows = (await listAnime(repo)).filter((x) => x.status === "watching" || x.status === "planned");
    if (!rows.length) {
      ops.push(setMeta("anime_refresh", today));
    } else {
      a.spend(1 + Math.min(8, rows.length));
      const got = await fetchSchedules(rows.map((x) => x.mal_id), a.fetchFn);
      if (got) {
        for (const r of rows) {
          const sch = got.find((x) => x.mal === r.mal_id);
          if (sch) ops.push(scheduleOp(r, sch, now));
        }
        ops.push(setMeta("anime_refresh", today), setMeta("anime_ok_at", String(now)), setMeta("anime_fail", "0"), setMeta("anime_fail_notice", "0"));
        notes.push(`аниме: расписание обновлено (${got.length} из ${rows.length})`);
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

  // ---------- утреннее «посмотрели?»: после утренней сводки, раз в день, только если что-то вышло ----------
  if (
    s.chRemind && !a.away && (meta.get("last_morning") === today || (s.morning === null && a.minuteOfDay >= 9 * 60)) && meta.get("anime_ask") !== today &&
    meta.get("anime_ask_off") !== "1" && meta.get("anime_ask_wait") !== "1" && a.room(3)
  ) {
    const rows = await listAnime(repo);
    const items: AskItem[] = noticeSet(rows)
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
  return { ops, notes, healthy };
}
