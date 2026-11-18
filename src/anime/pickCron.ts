// Субботняя подборка в cron: когда пора, как собрать из Shikimori за ограниченное число обращений и как отправить.
// Подборка — отдельное сообщение раз в неделю. Один запуск Worker делает до PICK_FETCH_CAP обращений к Shikimori, по одному
// (у сайта лимит 5 запросов в секунду); не хватает запаса подзапросов — не начинаем и пробуем в следующую минуту окна.
import { BudgetExceeded, deleteMeta, event, setMeta } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import { MINUTE, localDate, wallOf } from "../time/tz.ts";
import type { AnimeCronArgs } from "./cron.ts";
import { type Anime, effective } from "./core.ts";
import {
  type PickConfig,
  type PickParts,
  type Rec,
  PICK_DAY,
  PICK_FETCH_CAP,
  PICK_RETRY,
  PICK_TRIES,
  PICK_WINDOW,
  hasContent,
  judge,
  likedBases,
  markSeen,
  mergeNovelties,
  missedEpisodes,
  newWhy,
  orderCandidates,
  parseSeen,
  pickMessage,
  pickPlanned,
  plannedWhy,
  preCheck,
  seasonNow,
  similarWhy,
  surpriseWhy,
} from "./pick.ts";
import { GENRE_IDS, type GenreKey, excludeParam } from "./pickGenres.ts";
import { SITE, type PickTitle, fetchDetail, fetchRanked, fetchSeasonGenre, fetchSimilarTo, seasonOf } from "./pickSources.ts";

/** Сколько подзапросов должно быть свободно, чтобы начать: все обращения к сайту плюс отправка и записи в базу. */
export const PICK_NEED = PICK_FETCH_CAP + 4;

type PickArgs = Pick<AnimeCronArgs, "api" | "now" | "s" | "meta" | "away" | "quiet" | "minuteOfDay" | "fetchFn" | "rand" | "room" | "spend" | "note">;

/** Пора ли собирать подборку: суббота, время и окно, не в тихие часы и не «в отъезде», на этой неделе ещё не отправляли, хватает запаса. */
export function pickDue(a: PickArgs): boolean {
  const { s, meta, now } = a;
  if (!s.chRemind || s.animePick === null || a.away || a.quiet) return false;
  if (wallOf(now, s.tz).wd !== PICK_DAY) return false;
  if (a.minuteOfDay < s.animePick || a.minuteOfDay >= Math.min(s.animePick + PICK_WINDOW, 24 * 60)) return false;
  if (meta.get("anime_pick") === localDate(now, s.tz)) return false;
  if (now < (Number(meta.get("anime_pick_next") ?? 0) || 0)) return false;
  return a.room(PICK_NEED);
}

/** Тайтл из своей таблицы вместо карточки сайта (если сайт не ответил): без обложки и оценки, но название и серии честные. */
function stubOf(a: Anime, now: number): PickTitle {
  return {
    mal: a.mal_id,
    ru: a.title_ru,
    orig: a.title_orig ?? "",
    kind: "tv",
    status: a.src_status === "RELEASING" ? "ongoing" : a.src_status === "FINISHED" ? "released" : "anons",
    episodes: a.episodes ?? 0,
    epsAired: effective(a, now).airedEp,
    score: null,
    year: null,
    genres: [],
    image: null,
    url: `${SITE}/animes/${a.mal_id}`,
    franchise: null,
  };
}

/** Обращения к Shikimori под счётчиком: не больше PICK_FETCH_CAP, только если есть запас; два сбоя подряд — считаем, что сайт лёг, и больше не зовём. */
class Net {
  used = 0;
  misses = 0;
  down = false;
  dry = false;
  private a: PickArgs;
  constructor(a: PickArgs) {
    this.a = a;
  }
  async call<T>(f: () => Promise<T | null>): Promise<T | null> {
    if (this.down) return null;
    if (this.used >= PICK_FETCH_CAP || !this.a.room(3)) {
      this.dry = true;
      return null;
    }
    this.a.spend(1);
    this.used++;
    const r = await f();
    if (r === null) {
      if (++this.misses >= 2) this.down = true;
    } else this.misses = 0;
    return r;
  }
}

export interface PickResult {
  ops: Op[];
  notes: string[];
  healthy: boolean;
}

/** Собрать и отправить подборку (или отложить на несколько минут, если сайт не отвечает). */
export async function runSaturdayPick(a: PickArgs, all: Anime[], cfg: PickConfig): Promise<PickResult> {
  const { api, now, s, meta } = a;
  const f = a.fetchFn;
  const rand = a.rand ?? Math.random;
  const today = localDate(now, s.tz);
  const ops: Op[] = [];
  const notes: string[] = [];
  let healthy = true;
  const net = new Net(a);
  const seen = parseSeen(meta.get("anime_pick_seen"));
  const known = new Set(all.map((r) => r.mal_id));
  const taken = new Set<number>(); // уже в этой подборке
  const season = seasonNow(now, s.tz);

  // 1. пропущенные серии — только из своей таблицы, без обращений к сайту
  const missed = missedEpisodes(all, now);

  // 2. из «В планах»: выбор из своей таблицы; карточка сайта нужна только ради обложки и оценки
  const franchises = new Set<string>(); // семьи тайтлов, уже попавшие в подборку: другой сезон того же в другой части не берём
  const fits = (d: PickTitle): boolean => d.franchise === null || !franchises.has(d.franchise);
  let planned: Rec | null = null;
  const pp = pickPlanned(all, now, seen, rand);
  if (pp) {
    taken.add(pp.a.mal_id);
    const d = await net.call(() => fetchDetail(pp.a.mal_id, f));
    if (d?.franchise) franchises.add(d.franchise);
    const v = d ? judge(d, cfg) : null;
    planned = { kind: "planned", t: d ?? stubOf(pp.a, now), why: plannedWhy(pp.a, pp.why, now, s.tz), warn: v?.warn ?? [] };
  }

  // 3. новинки сезона в любимых жанрах: у новых тайтлов жанры в списке не видны (а часто и не заполнены), поэтому просим у сайта по одному
  // любимому жанру за раз, сразу «без ужасов, мехи, космоса и BL» (то, что обходим, и взрослое); какой жанр совпал — видно по запросу
  const fresh: Rec[] = [];
  const sSeason = seasonOf(season.year, season.month);
  const exclude = excludeParam(cfg.avoid);
  const byGenre: { key: GenreKey; items: PickTitle[] }[] = [];
  for (const key of cfg.likes.filter((k) => GENRE_IDS[k].length).slice(0, 6)) {
    const items = await net.call(() => fetchSeasonGenre(sSeason, GENRE_IDS[key][0], exclude, 10, f));
    if (items) byGenre.push({ key, items });
    else if (net.down) break;
  }
  for (const n of mergeNovelties(byGenre, known, seen, now, taken).slice(0, 2)) {
    taken.add(n.t.mal);
    fresh.push({ kind: "new", t: n.t, why: newWhy(n.matched), warn: [] });
  }

  // 4. похожее на недавнее любимое: «похожее» у сайта для одного-двух тайтлов, потом карточки лучших по оценке
  let similar: Rec | null = null;
  let baseUsed: number | null = null;
  const pool: { t: PickTitle; base: Anime }[] = [];
  for (const base of likedBases(all, now, seen)) {
    const l = await net.call(() => fetchSimilarTo(base.mal_id, f));
    if (!l) {
      if (net.down) break;
      continue;
    }
    for (const t of orderCandidates(l.filter((x) => preCheck(x, "similar", known, seen, now, taken)), "similar", rand).slice(0, 2)) pool.push({ t, base });
    if (pool.length >= 2) break;
  }
  pool.sort((x, y) => (y.t.score ?? 0) - (x.t.score ?? 0));
  for (const c of pool.slice(0, 2)) {
    const d = await net.call(() => fetchDetail(c.t.mal, f));
    if (!d) {
      if (net.down) break;
      continue;
    }
    const v = judge(d, cfg);
    if (v && fits(d)) {
      taken.add(d.mal);
      if (d.franchise) franchises.add(d.franchise);
      baseUsed = c.base.mal_id;
      similar = { kind: "similar", t: d, why: similarWhy(c.base), warn: v.warn };
      break;
    }
  }

  // 5. сюрприз: случайная страница рейтинга; лучше то, что вне любимых жанров
  let surprise: Rec | null = null;
  const page = 1 + (Math.floor(rand() * 5) % 5);
  const top = await net.call(() => fetchRanked(`2010_${season.year}`, page, 20, exclude, f));
  if (top) {
    let fallback: Rec | null = null;
    for (const t of orderCandidates(top.filter((x) => preCheck(x, "surprise", known, seen, now, taken)), "surprise", rand).slice(0, 3)) {
      const d = await net.call(() => fetchDetail(t.mal, f));
      if (!d) {
        if (net.down) break;
        continue;
      }
      const v = judge(d, cfg);
      if (!v || !fits(d)) continue;
      const rec: Rec = { kind: "surprise", t: d, why: surpriseWhy(v), warn: v.warn };
      if (!v.matched.length) {
        surprise = rec;
        break;
      }
      fallback ??= rec;
    }
    surprise ??= fallback;
    if (surprise) taken.add(surprise.t.mal);
  }

  if (net.used > 0) a.note?.("shikimori", !net.down);

  const parts: PickParts = { missed, planned, fresh, similar, surprise, sourceDown: net.down };
  const tryKey = meta.get("anime_pick_try") ?? "";
  const tries = (tryKey.startsWith(`${today}:`) ? Number(tryKey.slice(today.length + 1)) || 0 : 0) + 1;

  // сайт не ответил или запас кончился посреди сбора — не отправляем полупустое, пробуем ещё (на последней попытке отправим, что есть, и скажем честно)
  if ((net.down || net.dry) && tries < PICK_TRIES) {
    ops.push(setMeta("anime_pick_try", `${today}:${tries}`), setMeta("anime_pick_next", String(now + PICK_RETRY)));
    notes.push(`аниме: подборка недели отложена (${net.down ? "Shikimori не ответил" : "не хватило запаса обращений"}), попытка ${tries} из ${PICK_TRIES}`);
    return { ops, notes, healthy };
  }

  try {
    await api.postMessage(s.chRemind as string, pickMessage(parts, now, s.tz, s.character, rand));
    const recs = [planned, ...fresh, similar, surprise].filter((r): r is Rec => !!r);
    ops.push(
      setMeta("anime_pick", today),
      setMeta("anime_pick_seen", JSON.stringify(markSeen(seen, recs.map((r) => r.t.mal), baseUsed !== null ? [baseUsed] : [], now))),
      deleteMeta("anime_pick_try"),
      deleteMeta("anime_pick_next"),
      event(now, "anime_pick", null, `m=${missed.length},p=${planned ? 1 : 0},n=${fresh.length},s=${similar ? 1 : 0},x=${surprise ? 1 : 0}${hasContent(parts) ? "" : ",empty"}`),
    );
    notes.push(`аниме: субботняя подборка (серий: ${missed.length}, планов: ${planned ? 1 : 0}, новинок: ${fresh.length}, похожих: ${similar ? 1 : 0}, сюрприз: ${surprise ? 1 : 0}; обращений к сайту: ${net.used})`);
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      // запас кончился на отправке: попытку не тратим, подождём несколько минут (чтобы не собирать заново каждую минуту)
      ops.push(setMeta("anime_pick_next", String(now + 5 * MINUTE)));
    } else {
      // Discord не принял: три попытки с паузой, потом эту неделю пропускаем
      healthy = false;
      ops.push(tries >= PICK_TRIES ? setMeta("anime_pick", today) : setMeta("anime_pick_try", `${today}:${tries}`), setMeta("anime_pick_next", String(now + PICK_RETRY)));
    }
    notes.push("аниме: подборка недели не отправилась");
  }
  return { ops, notes, healthy };
}
