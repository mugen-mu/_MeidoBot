-- Meido: выходы серий по-русски из публичных телеграм-каналов озвучек и сайтов (src/anime/tgReleases.ts, разведка docs/RECON-ANIME-RELEASES.md).
-- Одна строка на тайтл из «Смотрю» / «В планах»: последняя вышедшая по-русски серия, кто озвучил, ссылка на пост и (если AnimeVost назвал время
-- в утреннем расписании) ожидаемая минута выхода сегодня. Только новая таблица: ничего не удаляется, миграция безопасна для боевой базы.
-- ep = 0 значит «серию по-русски ещё не видела» (строка есть только ради времени из расписания).
CREATE TABLE IF NOT EXISTS anime_ru (
  anime_id INTEGER PRIMARY KEY,
  ep INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL DEFAULT 0,
  voices TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  next_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0
);
