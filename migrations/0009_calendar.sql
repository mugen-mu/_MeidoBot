-- Этап 5 ретроспективы 2 «Календарь сюрпризов»: годовые даты (дни рождения близких, налоги, сроки документов, платежи).
-- В базе только название (имя или короткое описание) и дата (F5): ни фамилий, ни телефонов, ни суммы.
-- Сами напоминания заводятся «в нужный момент» обычными делами (за месяц, неделю, день): отдельное дело на каждое предупреждение, у каждого есть «Готово»;
-- поэтому редкие дела не засоряют списки раньше, чем за месяц до даты (F10).
-- marked — «ДАТА:СТАДИЯ» последнего заведённого предупреждения (стадия — за сколько дней: 30, 7, 1, 0), чтобы повторный запуск ничего не дублировал.
CREATE TABLE annuals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('birthday','tax','doc','pay','other')),
  name       TEXT NOT NULL,
  month      INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  year       INTEGER,            -- только для разовых сроков (документ до 2027-05-14); у годовых — NULL
  marked     TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_annuals_uniq ON annuals(kind, name, month, day, COALESCE(year, 0));
