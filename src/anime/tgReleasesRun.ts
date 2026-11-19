// Выходы серий по-русски: чтение Telegram-каналов в минутном цикле и хранение в `anime_ru` (миграция 0015). Чистая логика — `tgReleases.ts`.
// Бережём бесплатный план: за запуск читаем не больше одного канала (одна страница = один подзапрос), без единого тайтла в «Смотрю» / «В планах»
// не читаем вовсе, в базу идём только когда в ленте появилось новое по нашим тайтлам. Сбой канала — молча, виден на экране «Состояние».
import { BudgetExceeded, type Repo, op, setMeta } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import { fetchTgChannel } from "../tgChannel.ts";
import { HOUR } from "../time/tz.ts";
import type { AnimeCronArgs } from "./cron.ts";
import { type Anime, noticeSet } from "./core.ts";
import {
  type RuRow,
  type TgParsed,
  TG_CHANNELS,
  buildIndex,
  dueChannel,
  parseTgOff,
  parseTgState,
  planReleases,
  releaseMessage,
  retryAfter,
  serializeTgState,
} from "./tgReleases.ts";

export const TG_STATE_KEY = "anime_tg";
export const TG_OFF_KEY = "anime_tg_off";

/** Что известно про выходы по-русски. null — таблицы нет (миграция 0015 не применена): вызывающий молча обходится без этого. */
export async function listRu(repo: Repo): Promise<Map<number, RuRow> | null> {
  try {
    const rows = await repo.all<RuRow>("SELECT * FROM anime_ru LIMIT 1000");
    return new Map(rows.map((r) => [r.anime_id, r]));
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    return null;
  }
}

const UPSERT = `INSERT INTO anime_ru (anime_id, ep, at, voices, link, next_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** Новая серия по-русски: заменяет прежнюю и снимает «ждём сегодня». */
export const ruSetOp = (id: number, ep: number, at: number, voices: string[], link: string, now: number): Op =>
  op(`${UPSERT} ON CONFLICT(anime_id) DO UPDATE SET ep = excluded.ep, at = excluded.at, voices = excluded.voices, link = excluded.link, next_at = NULL, updated_at = excluded.updated_at`, id, ep, at, voices.join(", "), link, null, now);

/** Та же серия, добавилась озвучка. */
export const ruVoicesOp = (id: number, ep: number, voices: string[], now: number): Op => op("UPDATE anime_ru SET voices = ?, updated_at = ? WHERE anime_id = ? AND ep = ?", voices.join(", "), now, id, ep);

/** AnimeVost назвал время выхода на сегодня. */
export const ruNextOp = (id: number, at: number, now: number): Op =>
  op(`${UPSERT} ON CONFLICT(anime_id) DO UPDATE SET next_at = excluded.next_at, updated_at = excluded.updated_at`, id, 0, 0, "", "", at, now);

const NONE = { ops: [] as Op[], notes: [] as string[], healthy: true };

/**
 * Одна проверка канала за запуск. Первое чтение канала — молча (запоминаем, до какого поста дошли, и что уже вышло); дальше — сообщение
 * «🎧 Вышла серия N «Название» в озвучке X». В тихие часы и в отъезде не читаем (посты подождут в ленте, а старше 12 часов всё равно не пересылаются).
 */
export async function runTgReleases(a: AnimeCronArgs, rows: () => Promise<Anime[]>): Promise<{ ops: Op[]; notes: string[]; healthy: boolean }> {
  const { now, meta } = a;
  const off = parseTgOff(meta.get(TG_OFF_KEY));
  if (off.all || !a.s.chRemind || a.away || a.quiet) return NONE;
  const state = parseTgState(meta.get(TG_STATE_KEY));
  const spec = dueChannel(TG_CHANNELS.filter((c) => !off.set.has(c.channel.toLowerCase())), state, now);
  if (!spec || !a.room(6)) return NONE;
  const all = await rows();
  if (!all.some((x) => x.status === "watching" || x.status === "planned")) return NONE;

  const ops: Op[] = [];
  const notes: string[] = [];
  let healthy = true;
  const cur = state[spec.channel] ?? { last: null, next: 0, fails: 0 };
  const save = (s: { last: number | null; next: number; fails: number }): void => {
    state[spec.channel] = s;
    ops.push(setMeta(TG_STATE_KEY, serializeTgState(state)));
  };

  a.spend(1);
  const posts = await fetchTgChannel(spec.channel, a.fetchFn);
  a.note?.("animetg", posts !== null);
  if (!posts) {
    save({ ...cur, next: now + retryAfter(spec.every, cur.fails + 1), fails: cur.fails + 1 });
    notes.push(`аниме: лента ${spec.channel} не прочиталась (подряд ${cur.fails + 1})`);
    return { ops, notes, healthy };
  }

  const first = cur.last === null;
  const maxId = Math.max(cur.last ?? 0, ...posts.map((p) => p.id));
  const parsed = posts
    .filter((p) => first || p.id > (cur.last as number))
    .map((p) => spec.parse(p))
    .filter((p): p is TgParsed => p !== null)
    .filter((p) => p.kind === "release" || now - p.at < 24 * HOUR);
  const done = { last: maxId, next: now + spec.every, fails: 0 };
  if (!parsed.length) {
    save(done); // ничего нового про серии: только запоминаем, до какого поста дошли, и срок следующего чтения
    return { ops, notes, healthy };
  }

  const index = buildIndex(all);
  if (!a.room(4)) return { ops, notes, healthy };
  const known = await listRu(a.repo);
  if (known === null) {
    // миграция 0015 ещё не применена: ничего не пишем, повторим через час
    save({ ...cur, next: now + HOUR });
    notes.push("аниме: таблицы anime_ru нет (нужна миграция 0015), выходы по-русски не читаю");
    return { ops, notes, healthy };
  }
  const plan = planReleases({ index, noticeIds: new Set(noticeSet(all).map((x) => x.id)), known, parsed, now, silent: first });

  if (plan.notices.length) {
    if (!a.room(3)) return { ops, notes, healthy }; // не успеваем: не двигаем «дошли до», повторим в следующий раз
    try {
      await a.api.postMessage(a.s.chRemind, { content: releaseMessage(plan.notices, a.s.character, a.rand), allowed_mentions: { parse: [] } });
      notes.push(`аниме: вышли по-русски (${plan.notices.length}) — ${spec.voice}`);
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) healthy = false;
      return { ops, notes, healthy }; // Discord не принял: ничего не записываем, посты разберём заново
    }
  }
  for (const n of plan.nexts) ops.push(ruNextOp(n.a.id, n.at, now));
  for (const w of plan.writes) ops.push(w.voicesOnly ? ruVoicesOp(w.a.id, w.ep, w.voices, now) : ruSetOp(w.a.id, w.ep, w.at, w.voices, w.link, now));
  save(done);
  if (first) notes.push(`аниме: канал ${spec.channel} прочитан впервые (молча), тайтлов с сериями: ${plan.writes.length}`);
  return { ops, notes, healthy };
}
