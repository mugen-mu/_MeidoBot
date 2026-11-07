-- «Характер 2», этап Х1: настроение бота на каждого пользователя (по ТЗ, раздел 3).
-- Тут только числа и названия настроений, никаких текстов дел и сообщений.
CREATE TABLE mood_state (
  user_id          TEXT PRIMARY KEY,
  affection        REAL NOT NULL DEFAULT 50,   -- симпатия 0..100
  irritation       REAL NOT NULL DEFAULT 10,   -- раздражение 0..100
  miss_streak      INTEGER NOT NULL DEFAULT 0, -- пропущено подряд
  done_streak      INTEGER NOT NULL DEFAULT 0, -- выполнено подряд
  last_activity    INTEGER,                    -- последнее действие пользователя, мс
  current_mood     TEXT NOT NULL DEFAULT 'tired',
  mood_since       INTEGER NOT NULL,           -- когда началось текущее настроение, мс
  updated_at       INTEGER NOT NULL,           -- до какого момента посчитан спад чисел, мс
  idle_penalty     REAL NOT NULL DEFAULT 0,    -- сколько раздражения уже набежало за молчание
  recent           TEXT NOT NULL DEFAULT '[]', -- последние 5 фраз (короткие отпечатки), чтобы не повторяться
  last_drama_at    INTEGER,                    -- когда в последний раз была «драма» при 4-м пропуске и далее, мс
  yandere_cleared  INTEGER NOT NULL DEFAULT 0  -- после яндере выполнено дело: можно выходить через tsundere
);
