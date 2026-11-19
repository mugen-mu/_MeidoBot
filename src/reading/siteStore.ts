// Чтение по ссылке: запись в базу (столбцы site* из миграции 0016) и номер для тайтла, которого нет на Shikimori.
import { op } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import type { Patch } from "./store.ts";

/**
 * Номер вместо номера MyAnimeList для тайтла, которого нет на Shikimori (таблица требует уникальный mal_id): отрицательный, из сайта и ключа тайтла.
 * Одна и та же ссылка всегда даёт один и тот же номер, поэтому повторная фраза найдёт уже записанный тайтл.
 */
export function syntheticMal(site: string, key: string): number {
  let h = 2166136261;
  for (const ch of `${site}:${key}`) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  return -((h % 2_000_000_000) + 1);
}

/** Изменить поля тайтла по номеру MyAnimeList (для только что добавленной строки, id которой ещё не знаем). */
export function patchByMalOp(mal: number, patch: Patch, now: number): Op {
  const keys = Object.keys(patch);
  return op(`UPDATE reading SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE mal_id = ?`, ...Object.values(patch), now, mal);
}
