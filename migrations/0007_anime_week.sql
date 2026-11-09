-- Meido: аниме, выкладка 2 («между прочим», озвучка AniLibria, начало сезона). Время в UTC, миллисекунды.
-- Причина «бросил»: bored скучно, busy не успеваю, long слишком длинный, notmine не моё; NULL — не говорил / пропустил.
ALTER TABLE anime ADD COLUMN drop_reason TEXT;
-- Когда хозяин в последний раз сам двигал тайтл (серия или статус); NULL — не двигал, считаем от добавления.
ALTER TABLE anime ADD COLUMN last_move_at INTEGER;
-- Озвучка AniLibria: за сколько минут после выхода серии обычно появляется (среднее по последним замерам); NULL — не знаем или тайтла там нет.
ALTER TABLE anime ADD COLUMN voice_lag INTEGER;
ALTER TABLE anime ADD COLUMN voice_n INTEGER NOT NULL DEFAULT 0;
-- Для какой серии озвучка уже замерена (чтобы не считать дважды).
ALTER TABLE anime ADD COLUMN voice_ep INTEGER NOT NULL DEFAULT 0;
-- Когда про этот тайтл в последний раз спрашивали «между прочим» (чтобы не повторять).
ALTER TABLE anime ADD COLUMN weekq_at INTEGER;
-- Когда в последний раз искали продолжение этого сезона (после вопроса «добавить в планы?» — на год вперёд).
ALTER TABLE anime ADD COLUMN seq_at INTEGER;
-- 1 — про начало сезона уже писали (одно сообщение на тайтл).
ALTER TABLE anime ADD COLUMN start_asked INTEGER NOT NULL DEFAULT 0;
