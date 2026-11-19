// Чтение в cron: ночная проверка источников (понемногу, по паре тайтлов за запуск) и субботнее сообщение раз в неделю.
// Каждый кусок бережёт подзапросы: пока в чтении нет ни одного тайтла (метки `reading_on` нет), в базу и в сеть не ходим вообще.
import { BudgetExceeded, type Repo, event, setMeta } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import type { DiscordApi } from "../discord/types.ts";
import type { AppSettings } from "../settings.ts";
import type { ReadingSourceId } from "../sources.ts";
import { MINUTE, localDate, startOfDay, wallOf } from "../time/tz.ts";
import { type Reading, WEEK_SHOWN, adaptKey, adaptNew, idleTitle, rankWeek, siteLed, trackedSet, weekItems, weekKey } from "./core.ts";
import { refreshTitle } from "./refresh.ts";
import { siteById } from "./siteIds.ts";
import type { FetchFn } from "./sources.ts";
import { listReading, patchOp, toldOp } from "./store.ts";
import { weekMessage } from "./ui.ts";

export interface ReadingCronArgs {
  repo: Repo;
  api: DiscordApi;
  now: number;
  s: AppSettings;
  meta: Map<string, string>;
  away: boolean;
  /** тихие часы: субботнее сообщение в них не шлём (уйдёт, как только они кончатся, в тот же день) */
  quiet?: boolean;
  minuteOfDay: number;
  fetchFn: FetchFn;
  rand?: () => number;
  /** хватит ли подзапросов на n действий (как room2 в cron) */
  room: (n: number) => boolean;
  spend: (n: number) => void;
  /** записать итог чтения сайта в «Паспорт источников» (экран «Состояние»); без него — не пишем (тесты) */
  note?: (id: ReadingSourceId, ok: boolean) => void;
}

/** С какого часа (минут от полуночи) проверяем источники: после ночных проверок аниме (03:00 и 03:10), когда у источников уже свежие данные. */
export const REFRESH_FROM = 3 * 60 + 30;
export const REFRESH_RETRY = 60 * MINUTE;
/** Сколько тайтлов проверяем за один запуск (по 2–7 запросов каждый): так нагрузка на запуск Worker мала, а 10 тайтлов проверяются за 5 минут. */
export const BATCH = 2;
/** Сколько раз подряд не удалась проверка тайтла, прежде чем отложить её на следующую ночь. */
export const GIVE_UP_AT = 3;
/** С скольких неудач подряд источник считаем «давно не отвечающим» и один раз честно говорим об этом в субботнем сообщении (это минимум две ночи). */
export const STALE_AT = 4;

/** Выполнить часть про чтение минутного цикла: записи для общей пачки и пометки в отчёт. */
export async function runReading(a: ReadingCronArgs): Promise<{ ops: Op[]; notes: string[]; healthy: boolean }> {
  const { repo, api, now, s, meta } = a;
  const ops: Op[] = [];
  const notes: string[] = [];
  let healthy = true;
  if (meta.get("reading_on") !== "1") return { ops, notes, healthy };
  const today = localDate(now, s.tz);
  let cache: Reading[] | null = null;
  const rows = async (): Promise<Reading[]> => (cache ??= await listReading(repo));
  const f: FetchFn = ((input: unknown, init?: RequestInit) => (a.spend(1), a.fetchFn(input as RequestInfo, init))) as unknown as FetchFn;

  // ---------- ночная проверка: понемногу, пока не пройдём всех ----------
  if (a.minuteOfDay >= REFRESH_FROM && meta.get("reading_refresh") !== today && now >= (Number(meta.get("reading_next") ?? 0) || 0) && a.room(10)) {
    const t0 = startOfDay(now, s.tz);
    const due = trackedSet(await rows()).filter((r) => r.checked_at === null || r.checked_at < t0);
    if (!due.length) {
      ops.push(setMeta("reading_refresh", today));
    } else {
      let handled = 0;
      for (const r of due.slice(0, BATCH)) {
        if (!a.room(9)) break;
        let res: Awaited<ReturnType<typeof refreshTitle>>;
        try {
          res = await refreshTitle(r, f, now);
        } catch (e) {
          if (e instanceof BudgetExceeded) break;
          throw e;
        }
        // сайт по ссылке (Senkuro, ReManga, ReNovels, RanobeHub): итог чтения — в паспорт источников, чтобы поломку было видно
        const sid = siteLed(r) ? siteById(r.site)?.source : null;
        if (sid) a.note?.(sid, res.ok);
        if (res.ok) {
          ops.push(patchOp(r.id, { ...res.patch, checked_at: now, chk_fail: 0 }, now));
          handled++;
          continue;
        }
        const fails = r.chk_fail + 1;
        if (fails >= GIVE_UP_AT) {
          ops.push(patchOp(r.id, { checked_at: now, chk_fail: fails }, now));
          handled++;
        } else {
          ops.push(patchOp(r.id, { chk_fail: fails }, now), setMeta("reading_next", String(now + REFRESH_RETRY)));
        }
        notes.push(`чтение: источник не ответил по «${r.title_ru.slice(0, 30)}»`);
        break;
      }
      if (handled) notes.push(`чтение: проверено ${handled} из ${due.length}`);
      if (handled >= due.length) ops.push(setMeta("reading_refresh", today));
    }
  }

  // ---------- субботнее сообщение: раз в неделю, не в тихие часы и не в отъезде ----------
  const wk = s.reading;
  const key = weekKey(now, s.tz);
  if (wk && s.chRemind && !a.away && !a.quiet && wallOf(now, s.tz).wd === wk.dow && a.minuteOfDay >= wk.at && meta.get("reading_week") !== key && a.room(6)) {
    const tracked = trackedSet(await rows());
    const items = rankWeek(weekItems(tracked));
    const shown = items.slice(0, WEEK_SHOWN);
    const adapt = tracked.filter(adaptNew).slice(0, 2);
    const idle = idleTitle(tracked, now);
    const stale = tracked.some((r) => (r.md_id || r.mu_id || siteLed(r)) && r.chk_fail >= STALE_AT);
    const body = weekMessage({ shown, rest: items.slice(WEEK_SHOWN), adapt, idle: idle ? { r: idle, ms: now - (idle.last_move_at ?? idle.added_at) } : null, stale }, s.character, a.rand);
    if (!body) {
      ops.push(setMeta("reading_week", key));
    } else {
      try {
        await api.postMessage(s.chRemind, body);
        ops.push(setMeta("reading_week", key), event(now, "reading_week", null, `n=${shown.length}`));
        for (const it of shown) ops.push(toldOp(it.r, { end: it.ended, adapt: adaptNew(it.r) && adapt.includes(it.r) ? adaptKey(it.r) : null }, now));
        for (const r of adapt) if (!shown.some((it) => it.r.id === r.id)) ops.push(patchOp(r.id, { adapt_told: adaptKey(r) }, now));
        if (idle) ops.push(patchOp(idle.id, { weekq_at: now }, now));
        notes.push(`чтение: субботнее сообщение (${shown.length})`);
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) healthy = false;
      }
    }
  }
  return { ops, notes, healthy };
}
