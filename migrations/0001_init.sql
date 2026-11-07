-- Meido: схема базы D1 (DESIGN.md, раздел 7). Время везде в UTC, миллисекунды.

-- Дело: то, что пользователь записал. Текст закрытых дел стирается через 90 дней (scrubbed_at).
CREATE TABLE items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder','timer','note','link','file')),
  title       TEXT NOT NULL,
  body        TEXT,
  category    TEXT,
  tags        TEXT,
  created_at  INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT 'slash' CHECK (source IN ('slash','menu','dm','inbox','channel','siri','share')),
  -- секрет: текста нет вообще, хранится только пометка «от чего это»
  secret_flag INTEGER NOT NULL DEFAULT 0,
  secret_note TEXT,
  -- лестница настойчивости этого дела (JSON), NULL = по умолчанию из настроек
  ladder      TEXT,
  -- «пробивающее»: игнорирует тихие часы
  critical    INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  scrubbed_at INTEGER
);

-- Правило повтора (JSON-рецепт, не строка cron). Отличие от DESIGN §7: critical живёт в items.
CREATE TABLE rules (
  item_id   INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  recipe    TEXT NOT NULL,
  tz        TEXT NOT NULL,
  lead_days TEXT,
  until_at  INTEGER
);

-- Срабатывание: одно напоминание в конкретный срок. У повторяющегося дела каждое повторение — своя запись.
CREATE TABLE occurrences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main','lead')),
  lead_days       INTEGER,
  due_at          INTEGER,
  -- от какого момента считается лестница (срок или время после «отложить»)
  base_at         INTEGER,
  state           TEXT NOT NULL CHECK (state IN ('draft','planned','fired','snoozed','overdue','done','cancelled')),
  fire_count      INTEGER NOT NULL DEFAULT 0,
  next_fire_at    INTEGER,
  snooze_count    INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_channel_id TEXT,
  lock_until      INTEGER,
  lock_token      TEXT,
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER,
  closed_reason   TEXT
);
CREATE INDEX idx_occ_due ON occurrences(next_fire_at) WHERE next_fire_at IS NOT NULL;
CREATE INDEX idx_occ_item ON occurrences(item_id);
CREATE INDEX idx_occ_state ON occurrences(state);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Служебное: хозяин, каналы, последний живой запуск cron, id сообщения панели, метки сводок.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Журнал событий БЕЗ текста дел и без содержимого сообщений: что отправлено, нажато, ошибка.
CREATE TABLE events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  occ_id INTEGER,
  detail TEXT
);
CREATE INDEX idx_events_at ON events(at);
