// Аниме: запросы к базе (таблица anime, миграция 0006). Все записи — через Op, как в остальном проекте.
import { type Repo, op } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import type { Anime, AnimeStatus } from "./core.ts";
import type { Candidate, Schedule } from "./sources.ts";

export async function listAnime(repo: Repo): Promise<Anime[]> {
  return repo.all<Anime>("SELECT * FROM anime ORDER BY id LIMIT 400");
}

export async function getAnime(repo: Repo, id: number): Promise<Anime | null> {
  return repo.first<Anime>("SELECT * FROM anime WHERE id = ?", id);
}

/**
 * Добавить тайтл или, если он уже есть (по номеру MyAnimeList), поменять статус и серию.
 * Про уже вышедшие серии не спрашиваем: asked_ep при добавлении равен вышедшему.
 */
export function upsertOp(a: { cand: Candidate; sch: Schedule | null; status: AnimeStatus; episode: number | null; now: number }): Op {
  const { cand, sch, status, episode, now } = a;
  const aired = sch ? Math.max(sch.aired, sch.nextEp !== null ? sch.nextEp - 1 : 0, sch.status === "FINISHED" ? (sch.episodes ?? 0) : 0) : 0;
  const watched = episode ?? (status === "done" ? (sch?.episodes ?? cand.episodes ?? 0) : 0);
  return op(
    `INSERT INTO anime (mal_id, anilist_id, title_ru, title_orig, status, watched, episodes, src_status, next_ep, next_at, aired_ep, asked_ep, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mal_id) DO UPDATE SET status = excluded.status,
       watched = CASE WHEN ? THEN excluded.watched ELSE anime.watched END,
       title_ru = excluded.title_ru, title_orig = excluded.title_orig,
       anilist_id = COALESCE(excluded.anilist_id, anime.anilist_id),
       episodes = COALESCE(excluded.episodes, anime.episodes),
       src_status = COALESCE(excluded.src_status, anime.src_status),
       next_ep = excluded.next_ep, next_at = excluded.next_at,
       aired_ep = MAX(anime.aired_ep, excluded.aired_ep),
       updated_at = excluded.updated_at`,
    cand.mal,
    sch?.anilist ?? null,
    cand.ru,
    sch?.orig || cand.orig || null,
    status,
    watched,
    sch?.episodes ?? (cand.episodes || null),
    sch?.status ?? null,
    sch?.nextEp ?? null,
    sch?.nextAt ?? null,
    aired,
    aired,
    now,
    now,
    episode !== null || status === "done" ? 1 : 0,
  );
}

export const patchOp = (id: number, patch: Partial<Pick<Anime, "status" | "watched" | "liked" | "notify" | "asked_ep">>, now: number): Op => {
  const keys = Object.keys(patch);
  return op(`UPDATE anime SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...Object.values(patch), now, id);
};

export const deleteOp = (id: number): Op => op("DELETE FROM anime WHERE id = ?", id);

/** Применить ночное обновление расписания к строке (чистая функция: что записать). */
export function scheduleOp(a: Anime, sch: Schedule, now: number): Op {
  let airedEp = a.aired_ep;
  let airedAt = a.aired_at;
  // серия, которая должна была выйти по сохранённой дате, считается вышедшей
  if (a.next_ep !== null && a.next_at !== null && a.next_at <= now && a.next_ep >= airedEp) {
    airedEp = a.next_ep;
    airedAt = a.next_at;
  }
  airedEp = Math.max(airedEp, sch.aired, sch.nextEp !== null ? sch.nextEp - 1 : 0, sch.status === "FINISHED" && sch.episodes ? sch.episodes : 0);
  return op(
    "UPDATE anime SET title_orig = COALESCE(NULLIF(?, ''), title_orig), episodes = COALESCE(?, episodes), src_status = ?, next_ep = ?, next_at = ?, aired_ep = ?, aired_at = ?, updated_at = ? WHERE id = ?",
    sch.orig,
    sch.episodes,
    sch.status,
    sch.nextEp,
    sch.nextAt,
    airedEp,
    airedAt,
    now,
    a.id,
  );
}
