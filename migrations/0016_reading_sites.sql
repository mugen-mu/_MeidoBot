-- Meido: чтение по ссылке на сайт, где хозяин реально читает (Senkuro, ReManga, ReNovels, RanobeHub; MangaLib, RanobeLib, Com-X — ручной режим).
-- Только новые столбцы: ничего не удаляем и не меняем, миграция безопасна для боевой базы. Применяется отдельно, по слову владельца.
-- site     — id сайта: senkuro | remanga | renovels | ranobehub | mangalib | ranobelib | comx; NULL — ссылки нет, тайтл идёт по прежним источникам (MangaDex, MangaUpdates, RanobeHub по названию).
--            У первых четырёх бот сам читает число глав (по русскому счётчику сайта; им он и говорит «вышла»); у остальных сайт закрыт для программ — ссылка только хранится и подставляется в сообщения.
-- site_url — адрес страницы тайтла (без параметров): им бот подписывает «читать» в сообщениях.
-- site_key — как найти тайтл на сайте: имя в адресе (Senkuro, ReManga, ReNovels) или номер книги (RanobeHub).
-- site_q   — запрос поиска, по которому тайтл находится на сайте без страницы (RanobeHub: оригинальное название).
-- site_at  — когда число глав с сайта последний раз прочиталось (UTC, мс).
-- Тайтл, которого нет на Shikimori, получает отрицательный mal_id (номер из названия ссылки): внешние запросы по mal_id для него не делаются.
ALTER TABLE reading ADD COLUMN site TEXT;
ALTER TABLE reading ADD COLUMN site_url TEXT;
ALTER TABLE reading ADD COLUMN site_key TEXT;
ALTER TABLE reading ADD COLUMN site_q TEXT;
ALTER TABLE reading ADD COLUMN site_at INTEGER;
