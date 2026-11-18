// Чтение: запросы к базе (таблица reading, миграция 0011). Все записи — через Op, как в остальном проекте.
import { type Repo, op } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import { type ReadKind, type ReadStatus, type ReadUnit, type Reading, availOf } from "./core.ts";

export async function listReading(repo: Repo): Promise<Reading[]> {
  return repo.all<Reading>("SELECT * FROM reading ORDER BY id LIMIT 300");
}

export async function getReading(repo: Repo, id: number): Promise<Reading | null> {
  return repo.first<Reading>("SELECT * FROM reading WHERE id = ?", id);
}

/** Новый тайтл целиком: что известно из Shikimori, MangaDex или MangaUpdates на момент добавления. */
export interface NewReading {
  mal: number;
  kind: ReadKind;
  ru: string;
  orig: string | null;
  status: ReadStatus;
  unit: ReadUnit;
  readCh: number | null;
  readVol: number | null;
  totalCh: number | null;
  totalVol: number | null;
  srcStatus: string | null;
  srcCh: number;
  srcVol: number;
  /** по-русски: null — не смотрела, 0 — смотрела, перевода нет (манга: MangaDex; ранобэ: RanobeHub, справочно) */
  ruCh: number | null;
  ruVol: number | null;
  srcUrl: string | null;
  mdId: string | null;
  muId: number | null;
  rhId: number | null;
  /** искала ли тайтл в источнике (успешно): метка времени, иначе NULL — ночью попробую снова */
  mapAt: number | null;
  rhMapAt: number | null;
  now: number;
}

/**
 * Добавить тайтл или, если он уже есть (по номеру MyAnimeList), поменять статус, единицу и прочитанное.
 * Про уже вышедшее не пишем: «про что уже сообщала» (told_*) при добавлении равно тому, что у источника сейчас (у манги — что есть по-русски,
 * у ранобэ — счётчик MangaUpdates), а про завершение уже закончившегося тайтла (end_told) — тем более: новость — это когда тайтл закончится, пока он у хозяина.
 */
/** «Про что уже писала» при добавлении: манга — по-русски (если ещё не смотрели, 0: первая цифра станет отправной точкой), ранобэ — счётчик источника. */
const told = (n: NewReading): [number, number] => (n.kind === "manga" ? [n.ruCh ?? 0, n.ruVol ?? 0] : [n.srcCh, n.srcVol]);

export function insertOp(n: NewReading): Op {
  return op(
    `INSERT INTO reading (mal_id, kind, title_ru, title_orig, status, unit, read_ch, read_vol, total_ch, total_vol, src_status, src_ch, src_vol, ru_ch, ru_vol, src_url,
       md_id, mu_id, rh_id, map_at, rh_map_at, checked_at, told_ch, told_vol, end_told, last_move_at, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mal_id) DO UPDATE SET status = excluded.status, unit = excluded.unit,
       read_ch = COALESCE(excluded.read_ch, reading.read_ch), read_vol = COALESCE(excluded.read_vol, reading.read_vol),
       title_ru = excluded.title_ru, title_orig = COALESCE(excluded.title_orig, reading.title_orig),
       last_move_at = excluded.last_move_at, updated_at = excluded.updated_at`,
    n.mal, n.kind, n.ru, n.orig, n.status, n.unit, n.readCh, n.readVol, n.totalCh, n.totalVol, n.srcStatus, n.srcCh, n.srcVol, n.ruCh, n.ruVol, n.srcUrl,
    n.mdId, n.muId, n.rhId, n.mapAt, n.rhMapAt, n.now, ...told(n), n.srcStatus === "finished" ? 1 : 0, n.now, n.now, n.now,
  );
}

export type Patch = Partial<Omit<Reading, "id" | "mal_id" | "added_at" | "updated_at">>;

/** Поменять поля тайтла. Прочитанное, статус или единица — это «хозяин двигал»: заодно запоминаем время (для вопроса «давно не двигается»). */
export function patchOp(id: number, patch: Patch, now: number): Op {
  const moved = "read_ch" in patch || "read_vol" in patch || "status" in patch || "unit" in patch;
  const full: Patch = moved && !("last_move_at" in patch) ? { last_move_at: now, ...patch } : patch;
  const keys = Object.keys(full);
  return op(`UPDATE reading SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...Object.values(full), now, id);
}

/** Субботнее сообщение ушло: про эти главы и тома (по-русски у манги) больше не пишем как про новые; о завершении и об аниме — один раз. */
export function toldOp(r: Reading, patch: { end?: boolean; adapt?: string | null; weekq?: number }, now: number): Op {
  const p: Patch = { told_ch: availOf(r, "ch"), told_vol: availOf(r, "vol") };
  if (patch.end) p.end_told = 1;
  if (patch.adapt) p.adapt_told = patch.adapt;
  if (patch.weekq !== undefined) p.weekq_at = patch.weekq;
  return patchOp(r.id, p, now);
}
