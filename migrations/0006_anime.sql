-- Meido: аниме (этап «Аниме», выкладка 1). Время в UTC, миллисекунды (как везде).
-- Одна строка = один сезон (решение Ihor: «каждый сезон — отдельный тайтл»). Склейка источников — по номеру MyAnimeList.
CREATE TABLE anime (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mal_id      INTEGER NOT NULL UNIQUE,
  anilist_id  INTEGER,
  title_ru    TEXT NOT NULL,
  title_orig  TEXT,
  -- watching смотрю, planned в планах, done просмотрено, dropped бросил
  status      TEXT NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','planned','done','dropped')),
  -- на какой серии я
  watched     INTEGER NOT NULL DEFAULT 0,
  -- 0 нет отметки, 1 понравилось, 2 в восторге
  liked       INTEGER NOT NULL DEFAULT 0,
  notify      INTEGER NOT NULL DEFAULT 1,
  -- сколько серий всего (NULL — пока неизвестно)
  episodes    INTEGER,
  -- по данным источника: идёт, закончилось, ещё не вышло
  src_status  TEXT,
  -- ближайшая невышедшая серия и когда она выйдет (UTC, мс); NULL — даты нет
  next_ep     INTEGER,
  next_at     INTEGER,
  -- последняя вышедшая серия по данным источника и когда она вышла
  aired_ep    INTEGER NOT NULL DEFAULT 0,
  aired_at    INTEGER,
  -- про какую серию я уже спрашивал «посмотрели?»
  asked_ep    INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_anime_status ON anime(status);
