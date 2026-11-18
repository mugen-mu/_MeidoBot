// Чтение: привязка тайтла к источникам и проверка счётчиков (при добавлении и ночью). Честность: «вышла глава N» говорим только по росту счётчика
// между двумя проверками; первая цифра по тайтлу — отправная точка, а не новость.
import { DAY } from "../time/tz.ts";
import type { ReadCand } from "./sources.ts";
import {
  type FetchFn,
  fetchAdaptations,
  findMangaDex,
  findMangaUpdates,
  findRanobeHub,
  mdLatestLink,
  mdProgress,
  mdRussian,
  mdTitleUrl,
  muVolumes,
  pickAdapt,
  rhRefresh,
  rhTitleUrl,
  shikiOne,
} from "./sources.ts";
import type { Reading } from "./core.ts";
import type { Patch } from "./store.ts";

const WEEK = 7 * DAY;
/** Скачок счётчика больше этого за одну проверку считаем мусорной загрузкой в источнике и не принимаем. */
export const JUMP_MAX = 100;

// ---------- при добавлении ----------

/** Что узнали об источниках для нового тайтла. `search`: ok — искала и нашла, none — искала, такого там нет, fail — источник не ответил. */
export interface SourceInfo {
  search: "ok" | "none" | "fail";
  mdId: string | null;
  muId: number | null;
  ch: number;
  vol: number;
  /** по-русски: null — не смотрела (источник не ответил), 0 — смотрела, перевода нет */
  ruCh: number | null;
  ruVol: number | null;
  url: string | null;
  /** цифры прочитались (а не только найден тайтл) */
  counted: boolean;
  /** ранобэ: RanobeHub — номер книги и что с поиском (ok нашла, none нет, fail не ответил; пусто — не искала) */
  rhId: number | null;
  rhSearch: "ok" | "none" | "fail" | null;
}

/**
 * Найти тайтл в источнике счётчиков и прочитать первые цифры. Манга — MangaDex (главы и тома, отдельно русские), ранобэ — MangaUpdates (тома)
 * и RanobeHub (русский перевод: справочно).
 */
export async function lookupSource(cand: ReadCand, f: FetchFn): Promise<SourceInfo> {
  const info: SourceInfo = { search: "none", mdId: null, muId: null, ch: 0, vol: 0, ruCh: null, ruVol: null, url: null, counted: false, rhId: null, rhSearch: null };
  if (cand.kind === "manga") {
    const m = await findMangaDex(cand.mal, cand.orig, f);
    if (m === null) return { ...info, search: "fail" };
    if (m === "none") return info;
    info.search = "ok";
    info.mdId = m.id;
    info.url = mdTitleUrl(m.id);
    const p = await mdProgress(m.id, f);
    if (p) {
      info.ch = p.ch;
      info.vol = p.vol;
      info.counted = true;
    }
    if (!m.langs.includes("ru")) {
      // MangaDex сам говорит, что русских глав у тайтла нет: это ответ, а не «не знаю»
      info.ruCh = 0;
      info.ruVol = 0;
    } else if (info.counted) {
      const ru = await mdRussian(m.id, f);
      if (ru) {
        info.ruCh = ru.ch;
        info.ruVol = ru.vol;
      }
    }
    return info;
  }
  const id = await findMangaUpdates(cand.orig, f);
  if (id === null) info.search = "fail";
  else if (id !== "none") {
    info.search = "ok";
    info.muId = id;
    const v = await muVolumes(id, f);
    if (v) {
      info.vol = v.vol;
      info.counted = v.vol > 0;
    }
  }
  const rh = await findRanobeHub(cand.orig, cand.ru, f);
  if (rh === null) info.rhSearch = "fail";
  else if (rh === "none") info.rhSearch = "none";
  else {
    info.rhSearch = "ok";
    info.rhId = rh.id;
    info.ruCh = rh.ch;
    info.ruVol = rh.vol;
    info.url = rhTitleUrl(rh.id);
  }
  return info;
}

// ---------- ночная проверка ----------

/** Что увидели у источников за одну проверку. */
export interface Obs {
  ch?: number;
  vol?: number;
  /** по-русски (манга: MangaDex `ru`; ранобэ: RanobeHub); не передано — не смотрели */
  ruCh?: number;
  ruVol?: number;
  url?: string | null;
  status?: string;
  totalCh?: number | null;
  totalVol?: number | null;
}

/**
 * Применить увиденное: что записать в строку. Счётчики только растут; первая цифра — отправная точка (told = счётчик), рост — новость (src_at).
 * Манга: «про что писала» (told_*) идёт по русскому счётчику (решение 2026-11-18), общий счётчик MangaDex (src_*) остаётся для итогов и фразы «прочитал последнюю главу».
 * Ранобэ: told_* по счётчику источника (MangaUpdates), русская строка с RanobeHub только справочная.
 */
export function applyObs(r: Reading, o: Obs, now: number): Patch {
  const p: Patch = {};
  const manga = r.kind === "manga";
  const ch = Math.max(o.ch ?? 0, o.totalCh ?? 0);
  const vol = Math.max(o.vol ?? 0, o.totalVol ?? 0);
  let grew = false;
  if (ch > r.src_ch) {
    if (r.src_ch === 0) {
      p.src_ch = ch;
      if (!manga) p.told_ch = Math.max(r.told_ch, ch);
    } else if (ch - r.src_ch <= JUMP_MAX) {
      p.src_ch = ch;
      if (!manga) grew = true;
    }
  }
  if (vol > r.src_vol) {
    if (r.src_vol === 0) {
      p.src_vol = vol;
      if (!manga) p.told_vol = Math.max(r.told_vol, vol);
    } else if (vol - r.src_vol <= JUMP_MAX) {
      p.src_vol = vol;
      if (!manga) grew = true;
    }
  }
  // русский счётчик: у манги растёт только вверх и ведёт «про что писала»; у ранобэ — просто последние цифры RanobeHub
  for (const [seen, key, told, was] of [
    [o.ruCh, "ru_ch", "told_ch", r.ru_ch],
    [o.ruVol, "ru_vol", "told_vol", r.ru_vol],
  ] as const) {
    if (seen === undefined) continue;
    if (!manga) {
      p[key] = seen;
      continue;
    }
    const v = Math.max(was ?? 0, seen);
    p[key] = v;
    if (was === null) p[told] = v; // первая цифра по-русски — отправная точка, про неё не пишем
    else if (v - was > JUMP_MAX) p[told] = Math.max(r[told], v); // залили разом, как чужую заливку: не новость (накопилось всё равно покажется)
    else if (v > was) grew = true;
  }
  if (grew) p.src_at = now;
  if (o.url && (grew || r.src_url === null)) p.src_url = o.url;
  if (o.status) p.src_status = o.status;
  if (o.totalCh) p.total_ch = o.totalCh;
  if (o.totalVol) p.total_vol = o.totalVol;
  return p;
}

export interface Refreshed {
  patch: Patch;
  /** первый запрос, без которого проверка не имеет смысла, не удался */
  ok: boolean;
  /** к источнику счётчиков действительно обращались и он ответил */
  reached: boolean;
}

/**
 * Проверить один тайтл: привязка к источнику (раз в неделю, пока не найден), счётчики (каждую ночь), состояние и итоги у Shikimori (раз в неделю),
 * аниме по тайтлу (раз в неделю, если оно идёт или анонсировано, иначе раз в месяц). Любой сбой счётчиков = ok:false, ничего не записываем про цифры.
 */
export async function refreshTitle(r: Reading, f: FetchFn, now: number): Promise<Refreshed> {
  const patch: Patch = {};
  const obs: Obs = {};
  let mdId = r.md_id;
  let muId = r.mu_id;
  let reached = false;
  const mapDue = r.map_at === null || now - r.map_at >= WEEK;

  if (r.kind === "manga" && !mdId && mapDue) {
    const m = await findMangaDex(r.mal_id, r.title_orig ?? "", f);
    if (m === null) return { patch: {}, ok: false, reached };
    reached = true;
    patch.map_at = now;
    if (m !== "none") {
      mdId = m.id;
      patch.md_id = m.id;
      if (!r.src_url) obs.url = mdTitleUrl(m.id);
    }
  } else if (r.kind === "ranobe" && !muId && mapDue) {
    const id = await findMangaUpdates(r.title_orig ?? "", f);
    if (id === null) return { patch: {}, ok: false, reached };
    reached = true;
    patch.map_at = now;
    if (id !== "none") {
      muId = id;
      patch.mu_id = id;
    }
  }

  if (mdId) {
    const p = await mdProgress(mdId, f);
    if (!p) return { patch: {}, ok: false, reached };
    reached = true;
    obs.ch = p.ch;
    obs.vol = p.vol;
    const ru = await mdRussian(mdId, f); // русский счётчик ведёт «вышла» и «накопилось»; не вышло — оставляем прежний
    if (ru !== null) {
      obs.ruCh = ru.ch;
      obs.ruVol = ru.vol;
    }
    // ссылка — на последнюю главу по-русски, и только когда русский счётчик вырос (а не английский)
    if (ru && r.ru_ch !== null && ru.ch > r.ru_ch) obs.url = (await mdLatestLink(mdId, f)) ?? mdTitleUrl(mdId);
  }
  if (muId) {
    const v = await muVolumes(muId, f);
    if (!v) return { patch: {}, ok: false, reached };
    reached = true;
    if (v.vol > 0) obs.vol = v.vol; // состояние (идёт / закончен) берём только у Shikimori: иначе два источника переключали бы его туда-сюда
  }

  // русский перевод ранобэ — RanobeHub, справочно и необязательно: сайт не ответил — ничего не меняем и не считаем это сбоем проверки
  if (r.kind === "ranobe") {
    const orig = r.title_orig ?? "";
    if (r.rh_id) {
      const b = await rhRefresh(r.rh_id, orig, r.title_ru, f);
      if (b) {
        obs.ruCh = b.ch;
        obs.ruVol = b.vol;
        if (!r.src_url) obs.url = rhTitleUrl(b.id);
      }
    } else if (r.rh_map_at === null || now - r.rh_map_at >= WEEK) {
      const b = await findRanobeHub(orig, r.title_ru, f);
      if (b !== null) {
        patch.rh_map_at = now;
        if (b !== "none") {
          patch.rh_id = b.id;
          obs.ruCh = b.ch;
          obs.ruVol = b.vol;
          if (!r.src_url) obs.url = rhTitleUrl(b.id);
        }
      }
    }
  }

  if (r.shiki_at === null || now - r.shiki_at >= WEEK) {
    const c = await shikiOne(r.mal_id, f);
    if (c) {
      patch.shiki_at = now;
      if (c.status) obs.status = c.status;
      if (c.status === "finished") {
        obs.totalCh = c.chapters || null;
        obs.totalVol = c.volumes || null;
      }
    }
  }

  const adaptEvery = r.adapt_status === "ongoing" || r.adapt_status === "anons" ? WEEK : 30 * DAY;
  if (r.adapt_at === null || now - r.adapt_at >= adaptEvery) {
    const list = await fetchAdaptations(r.mal_id, f);
    if (list) {
      const a = pickAdapt(list);
      patch.adapt_at = now;
      patch.adapt_mal = a?.mal ?? null;
      patch.adapt_ru = a?.ru ?? null;
      patch.adapt_status = a?.status ?? null;
    }
  }

  return { patch: { ...patch, ...applyObs(r, obs, now) }, ok: true, reached };
}
