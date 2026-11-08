-- «Без стиля» на конкретном деле (решение 2026-11-08, A17/H): для такого дела Хару не добавляет реплик и аниме-слов.
ALTER TABLE items ADD COLUMN plain INTEGER NOT NULL DEFAULT 0;
