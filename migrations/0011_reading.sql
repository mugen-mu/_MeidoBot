-- Meido: чтение (манга и ранобэ): что читает хозяин, на какой он главе или томе и что вышло по источнику. Время в UTC, миллисекунды (как везде).
-- Только новая таблица и индекс: ничего существующего не трогаем, миграция безопасна для боевой базы.
-- Одна строка = один тайтл. Номера MyAnimeList общие для манги и ранобэ, поэтому mal_id уникален на всю таблицу.
CREATE TABLE reading (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mal_id      INTEGER NOT NULL UNIQUE,
  -- manga манга (в т.ч. манхва и маньхуа), ranobe ранобэ и новеллы
  kind        TEXT NOT NULL DEFAULT 'manga' CHECK (kind IN ('manga','ranobe')),
  title_ru    TEXT NOT NULL,
  title_orig  TEXT,
  -- reading читаю, planned в планах, done дочитал, dropped бросил, waiting жду продолжения
  status      TEXT NOT NULL DEFAULT 'reading' CHECK (status IN ('reading','planned','done','dropped','waiting')),
  -- чем считает хозяин: ch главами, vol томами (по последней фразе; у манги по умолчанию главы, у ранобэ тома)
  unit        TEXT NOT NULL DEFAULT 'ch' CHECK (unit IN ('ch','vol')),
  -- сколько прочитано; NULL — хозяин ещё не говорил, на чём остановился
  read_ch     INTEGER,
  read_vol    INTEGER,
  -- отметка как у аниме: 2 в восторге, 1 понравилось, 0 нет отметки, -1 так себе, -2 не понравилось
  liked       INTEGER NOT NULL DEFAULT 0,
  -- сколько всего по источнику, когда тайтл закончен (NULL — идёт или неизвестно)
  total_ch    INTEGER,
  total_vol   INTEGER,
  -- по данным источника: ongoing идёт, finished закончен, anons анонс, paused перерыв, dropped прекращён
  src_status  TEXT,
  -- последняя известная глава и том по источнику (0 — источник их не показывает) и когда я заметила рост (UTC, мс)
  src_ch      INTEGER NOT NULL DEFAULT 0,
  src_vol     INTEGER NOT NULL DEFAULT 0,
  src_at      INTEGER,
  -- последняя глава на русском (MangaDex); NULL — не знаю или русского перевода нет
  ru_ch       INTEGER,
  -- ссылка на последнюю главу (или на тайтл) в источнике
  src_url     TEXT,
  -- номера в источниках: MangaDex (манга) и MangaUpdates (ранобэ); когда в последний раз искала тайтл там (раз в неделю, не чаще)
  md_id       TEXT,
  mu_id       INTEGER,
  map_at      INTEGER,
  -- ночная проверка: когда прошла, сколько раз подряд не вышла; когда читала итоги у Shikimori
  checked_at  INTEGER,
  chk_fail    INTEGER NOT NULL DEFAULT 0,
  shiki_at    INTEGER,
  -- про какие главу и том уже писала в субботнем сообщении; 1 — про завершение уже писала
  told_ch     INTEGER NOT NULL DEFAULT 0,
  told_vol    INTEGER NOT NULL DEFAULT 0,
  end_told    INTEGER NOT NULL DEFAULT 0,
  -- аниме по этому тайтлу (Shikimori «Адаптация»): номер, название, состояние (anons / ongoing / released), когда искала, о каком уже писала («номер:состояние»)
  adapt_mal    INTEGER,
  adapt_ru     TEXT,
  adapt_status TEXT,
  adapt_at     INTEGER,
  adapt_told   TEXT,
  -- вопросы недели: когда в последний раз спрашивала «между прочим» и когда хозяин сам двигал тайтл
  weekq_at     INTEGER,
  last_move_at INTEGER,
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_reading_status ON reading(status);
