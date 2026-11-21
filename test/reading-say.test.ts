// Чтение: живые фразы и вопросы (чистые функции), разбор ответов источников, подсчёт «накопилось», выбор для субботнего сообщения.
import { describe, expect, it } from "vitest";
import { type Reading, availOf, hasRussian, noRussianYet, ownMatches, rankWeek, unread, weekItems, weekKey } from "../src/reading/core.ts";
import { readTarget, statusAfterRead } from "../src/reading/handlers.ts";
import { JUMP_MAX, applyObs } from "../src/reading/refresh.ts";
import { parseReadAsk, parseReadSay } from "../src/reading/say.ts";
import { parseAggregate, parseMuStatus, parseReadCand, parseRhBooks, pickAdapt, pickRh } from "../src/reading/sources.ts";
import { parseReadingWhen, progressText, ruBit, whereText } from "../src/reading/ui.ts";
import { readSettings } from "../src/settings.ts";
import { kyiv } from "./helpers.ts";

const row = (o: Partial<Reading> = {}): Reading => ({
  id: 1, mal_id: 9001, kind: "manga", title_ru: "Цветок и меч", title_orig: "Hana to Ken", status: "reading", unit: "ch", read_ch: null, read_vol: null, liked: 0, total_ch: null, total_vol: null,
  src_status: "ongoing", src_ch: 0, src_vol: 0, src_at: null, ru_ch: null, ru_vol: null, src_url: null, md_id: null, mu_id: null, rh_id: null, rh_map_at: null, map_at: null, checked_at: null, chk_fail: 0, shiki_at: null, told_ch: 0, told_vol: 0,
  end_told: 0, adapt_mal: null, adapt_ru: null, adapt_status: null, adapt_at: null, adapt_told: null, weekq_at: null, last_move_at: null, added_at: 0, updated_at: 0, ...o,
});

describe("чтение: фразы записи", () => {
  it("«прочитал главу 120 X»: номер главы и название", () => {
    expect(parseReadSay("прочитал главу 120 Цветок и меч")).toMatchObject({ action: "read", query: "Цветок и меч", chapter: 120, volume: null, next: false, unit: "ch", prefixed: false });
    expect(parseReadSay("прочитала 45 главу Цветок и меч")).toMatchObject({ action: "read", query: "Цветок и меч", chapter: 45 });
    expect(parseReadSay("Дочитал главу 7 из Цветок и меч!")).toMatchObject({ action: "read", query: "Цветок и меч", chapter: 7 });
  });

  it("«прочитал X» — на одну дальше; «прочитал главу X» — тоже", () => {
    expect(parseReadSay("прочитал Цветок и меч")).toMatchObject({ action: "read", query: "Цветок и меч", chapter: null, next: true });
    expect(parseReadSay("прочитал главу Цветок и меч")).toMatchObject({ query: "Цветок и меч", next: true, unit: "ch" });
    expect(parseReadSay("прочитал том Цветок и меч")).toMatchObject({ query: "Цветок и меч", next: true, unit: "vol" });
  });

  it("том, последняя глава, номер тома после названия", () => {
    expect(parseReadSay("прочитал Цветок и меч том 5")).toMatchObject({ query: "Цветок и меч", volume: 5, chapter: null, unit: "vol", next: false });
    expect(parseReadSay("прочитал 3 том Цветок и меч")).toMatchObject({ volume: 3, query: "Цветок и меч" });
    expect(parseReadSay("прочитал последнюю главу Цветок и меч")).toMatchObject({ query: "Цветок и меч", last: true, next: false, unit: "ch" });
  });

  it("читаю / бросил читать / хочу почитать", () => {
    expect(parseReadSay("читаю Цветок и меч")).toMatchObject({ action: "start", query: "Цветок и меч", next: false });
    expect(parseReadSay("читаю сейчас Цветок и меч глава 12")).toMatchObject({ action: "start", query: "Цветок и меч", chapter: 12 });
    expect(parseReadSay("бросил читать Цветок и меч")).toMatchObject({ action: "drop", query: "Цветок и меч" });
    expect(parseReadSay("перестала читать Цветок и меч")).toMatchObject({ action: "drop", query: "Цветок и меч" });
    expect(parseReadSay("хочу почитать Цветок и меч")).toMatchObject({ action: "plan", query: "Цветок и меч" });
    expect(parseReadSay("потом прочитаю Цветок и меч")).toMatchObject({ action: "plan", query: "Цветок и меч" });
    expect(parseReadSay("в планах почитать Цветок и меч")).toMatchObject({ action: "plan", query: "Цветок и меч" });
  });

  it("обращение или слово «манга» / «ранобэ» разрешает записать незнакомое название", () => {
    expect(parseReadSay("бот читаю Цветок и меч")).toMatchObject({ action: "start", query: "Цветок и меч", prefixed: true, kind: null });
    expect(parseReadSay("Хару, прочитал главу 5 Цветок и меч")).toMatchObject({ action: "read", chapter: 5, prefixed: true });
    expect(parseReadSay("читаю мангу Цветок и меч")).toMatchObject({ action: "start", query: "Цветок и меч", prefixed: true, kind: "manga" });
    expect(parseReadSay("хочу почитать ранобэ Меч и тень")).toMatchObject({ action: "plan", query: "Меч и тень", prefixed: true, kind: "ranobe" });
    expect(parseReadSay("хочу ранобэ Меч и тень")).toMatchObject({ action: "plan", query: "Меч и тень", kind: "ranobe" });
    expect(parseReadSay("бросил мангу Цветок и меч")).toMatchObject({ action: "drop", query: "Цветок и меч", kind: "manga" });
    expect(parseReadSay("прочитал веб-новеллу Меч и тень том 3")).toMatchObject({ query: "Меч и тень", volume: 3, kind: "ranobe", prefixed: true });
  });

  it("обычные дела не трогаем: инфинитив, чужие глаголы, аниме", () => {
    expect(parseReadSay("прочитать договор до пятницы")).toBeNull();
    expect(parseReadSay("почитать про Rust")).toBeNull();
    expect(parseReadSay("купить хлеб")).toBeNull();
    expect(parseReadSay("посмотрел 5 серию Фрирен")).toBeNull();
    expect(parseReadSay("смотрю Фрирен")).toBeNull();
    expect(parseReadSay("бросил Фрирен")).toBeNull();
    expect(parseReadSay("хочу купить хлеб")).toBeNull();
    expect(parseReadSay("читаю")).toBeNull();
    expect(parseReadSay("прочитал")).toBeNull();
    expect(parseReadSay("прочитал главу 5")).toBeNull();
    expect(parseReadSay("бот купить хлеб")).toBeNull();
  });
});

describe("чтение: вопросы", () => {
  it("«что я читаю» и похожее — список", () => {
    for (const t of ["что я читаю", "Что читаю?", "что читаю сейчас", "бот что я читаю", "покажи что я читаю", "список чтения", "что мои манга и ранобэ"]) expect(parseReadAsk(t), t).toEqual({ kind: "list" });
  });

  it("«что вышло по чтению», «новые главы» — что вышло", () => {
    for (const t of ["что вышло по чтению", "новые главы", "какие новые главы", "что нового по манге", "что накопилось по чтению", "новые тома", "что вышло в манге"]) expect(parseReadAsk(t), t).toEqual({ kind: "news" });
  });

  it("«какая глава X» — где я", () => {
    expect(parseReadAsk("какая глава Цветок и меч")).toEqual({ kind: "where", query: "цветок и меч" });
    expect(parseReadAsk("на какой я главе Цветок и меч")).toEqual({ kind: "where", query: "цветок и меч" });
    expect(parseReadAsk("до какого тома дочитал Цветок и меч")).toEqual({ kind: "where", query: "цветок и меч" });
    expect(parseReadAsk("какая последняя глава у Цветок и меч")).toEqual({ kind: "where", query: "цветок и меч" });
  });

  it("чужие вопросы не перехватываем: аниме, дела, голое слово", () => {
    for (const t of ["что вышло нового", "что нового", "что я смотрю", "что у меня горит", "новые серии", "манга", "ранобэ", "что почитать", "читаю книгу про Rust и весь день", "какая погода"]) expect(parseReadAsk(t), t).toBeNull();
  });
});

describe("чтение: подсчёт и выбор", () => {
  it("накопилось = вышло по-русски (манга) − прочитано; без «где я» или без счётчика — null; общий счётчик MangaDex у манги не считается", () => {
    expect(unread(row({ ru_ch: 149, src_ch: 199, read_ch: 140 }))).toBe(9);
    expect(unread(row({ ru_ch: 149, src_ch: 199, read_ch: null }))).toBeNull();
    expect(unread(row({ ru_ch: 0, src_ch: 199, read_ch: 5 }))).toBeNull(); // по-русски нет: 199 глав по-английски не в счёт
    expect(unread(row({ ru_ch: null, src_ch: 199, read_ch: 5 }))).toBeNull();
    expect(unread(row({ ru_ch: 10, read_ch: 12 }))).toBe(0);
    expect(unread(row({ unit: "vol", ru_vol: 13, read_vol: 10, src_vol: 20 }))).toBe(3);
    // ранобэ: то же правило (решение Ihor 2026-11-21): по-русски (RanobeHub или сайт), оригинал по MangaUpdates в «накопилось» не идёт
    expect(unread(row({ kind: "ranobe", unit: "vol", src_vol: 13, read_vol: 2, ru_vol: 4, rh_id: 7 }))).toBe(2);
    expect(unread(row({ kind: "ranobe", unit: "vol", src_vol: 13, read_vol: 2, ru_vol: 0, ru_ch: 0 }))).toBeNull(); // по-русски нет: 13 томов оригинала не в счёт
    expect(unread(row({ kind: "ranobe", unit: "vol", src_vol: 13, read_vol: 2, ru_vol: null }))).toBeNull();
    expect(availOf(row({ ru_ch: 149, src_ch: 199 }), "ch")).toBe(149);
    expect(availOf(row({ kind: "ranobe", src_vol: 12, ru_vol: 3 }), "vol")).toBe(3);
    expect(availOf(row({ kind: "ranobe", src_vol: 12, ru_vol: null }), "vol")).toBe(0);
  });

  it("есть ли что-то по-русски: по русскому счётчику, и у манги, и у ранобэ; «смотрела, нет» отличается от «не смотрела»", () => {
    expect(hasRussian(row({ ru_ch: 1 }))).toBe(true);
    expect(hasRussian(row({ ru_vol: 1 }))).toBe(true);
    expect(hasRussian(row({ ru_ch: 0, ru_vol: 0 }))).toBe(false);
    expect(hasRussian(row({ ru_ch: null }))).toBe(false);
    expect(noRussianYet(row({ ru_ch: 0, ru_vol: 0 }))).toBe(true);
    expect(noRussianYet(row({ ru_ch: null }))).toBe(false);
    expect(noRussianYet(row({ ru_ch: 5 }))).toBe(false);
    // ранобэ: оригинал (MangaUpdates) русским не считается
    const novel = (o: Partial<Reading> = {}) => row({ kind: "ranobe", unit: "vol", src_vol: 12, mu_id: 5, ...o });
    expect(hasRussian(novel({ ru_ch: null }))).toBe(false);
    expect(hasRussian(novel({ ru_vol: 2 }))).toBe(true);
    expect(hasRussian(novel({ ru_ch: 40, ru_vol: 0 }))).toBe(true);
    expect(noRussianYet(novel({ ru_ch: 0, ru_vol: 0 }))).toBe(true);
    expect(noRussianYet(novel({ ru_ch: null, rh_map_at: 5 }))).toBe(true); // старая строка: на RanobeHub искала, цифр по-русски там нет
    expect(noRussianYet(novel({ ru_ch: null, rh_map_at: null }))).toBe(false); // RanobeHub ещё не смотрела: не «нет», а «не знаю»
    expect(noRussianYet(novel({ ru_vol: 3 }))).toBe(false);
  });

  it("поиск в своём списке: точное важнее частичного, несколько — не угадываем", () => {
    const a = row({ id: 1, title_ru: "Провожающая в последний путь Фрирен", title_orig: "Sousou no Frieren" });
    const b = row({ id: 2, mal_id: 2, kind: "ranobe", title_ru: "Провожающая в последний путь Фрирен", title_orig: "Sousou no Frieren Novel" });
    expect(ownMatches([a], "фрирен", null)).toHaveLength(1);
    expect(ownMatches([a, b], "Провожающая в последний путь Фрирен", null)).toHaveLength(2);
    expect(ownMatches([a, b], "Провожающая в последний путь Фрирен", "ranobe").map((r) => r.id)).toEqual([2]);
    expect(ownMatches([a], "ф", null)).toEqual([]);
    expect(ownMatches([a], "соу", null)).toEqual([]);
    expect(ownMatches([a], "sousou no frieren", null)).toHaveLength(1);
  });

  it("«прочитал» записывает главу/том, считает от нуля, если не знаем где он; «последняя» берёт у источника", () => {
    const base = { read_ch: 119, read_vol: null, unit: "ch" as const, src_status: "ongoing", src_ch: 199, src_vol: 24, total_ch: null, total_vol: null };
    expect(readTarget(base, parseReadSay("прочитал Цветок и меч")!)).toMatchObject({ patch: { read_ch: 120, unit: "ch" }, guessed: false, value: 120 });
    expect(readTarget({ ...base, read_ch: null }, parseReadSay("прочитал Цветок и меч")!)).toMatchObject({ patch: { read_ch: 1 }, guessed: true });
    expect(readTarget(base, parseReadSay("прочитал главу 130 Цветок и меч")!)).toMatchObject({ patch: { read_ch: 130, unit: "ch" } });
    expect(readTarget(base, parseReadSay("прочитал Цветок и меч том 5")!)).toMatchObject({ patch: { read_vol: 5, unit: "vol" }, unit: "vol" });
    expect(readTarget(base, parseReadSay("прочитал последнюю главу Цветок и меч")!)).toMatchObject({ patch: { read_ch: 199 } });
    expect(readTarget({ ...base, src_ch: 0 }, parseReadSay("прочитал последнюю главу Цветок и меч")!)).toBe("no-last");
    expect(readTarget({ ...base, src_status: "finished", total_ch: 150, read_ch: 149 }, parseReadSay("прочитал главу 160 Цветок и меч")!)).toMatchObject({ patch: { read_ch: 150 } });
  });

  it("статус после «прочитал»: догнал идущее — ждёт, дочитал законченное — дочитал", () => {
    const b = { src_status: "ongoing", src_ch: 199, src_vol: 0, total_ch: null, total_vol: null, read_ch: null, read_vol: null, unit: "ch" as const };
    expect(statusAfterRead(b, "ch", 120)).toBe("reading");
    expect(statusAfterRead(b, "ch", 199)).toBe("waiting");
    expect(statusAfterRead({ ...b, src_status: "finished", total_ch: 210, src_ch: 210 }, "ch", 209)).toBe("reading");
    expect(statusAfterRead({ ...b, src_status: "finished", total_ch: 210, src_ch: 210 }, "ch", 210)).toBe("done");
    expect(statusAfterRead({ ...b, src_ch: 0 }, "ch", 5)).toBe("reading");
  });

  it("в субботнее сообщение попадают новое по-русски, завершение и накопленное; порядок решает Хару; без русского перевода — молчание", () => {
    const quiet = row({ id: 1, title_ru: "A", ru_ch: 50, told_ch: 50, read_ch: 50 }); // ничего нового
    const heap = row({ id: 2, title_ru: "B", ru_ch: 100, told_ch: 100, read_ch: 60 }); // накопилось 40
    const fresh = row({ id: 3, title_ru: "C", ru_ch: 31, told_ch: 30, read_ch: 30 }); // вышла новая по-русски
    const fav = row({ id: 4, title_ru: "D", ru_ch: 12, told_ch: 12, read_ch: 10, liked: 2 }); // любимое, накопилось 2
    const ended = row({ id: 5, title_ru: "E", src_status: "finished", src_ch: 20, ru_ch: 20, told_ch: 20, read_ch: 20, end_told: 0 });
    const planned = row({ id: 6, title_ru: "F", status: "planned", ru_ch: 9, told_ch: 0 });
    const dropped = row({ id: 7, title_ru: "G", status: "dropped", ru_ch: 9, told_ch: 0, read_ch: 1 });
    const noRu = row({ id: 8, title_ru: "H", src_ch: 300, ru_ch: 0, ru_vol: 0, told_ch: 0, read_ch: 1 }); // по-английски 300 глав, по-русски нет совсем
    const noRuEnded = row({ id: 9, title_ru: "I", src_status: "finished", src_ch: 50, ru_ch: 0, ru_vol: 0, read_ch: 50 });
    const unseen = row({ id: 10, title_ru: "J", src_ch: 80, ru_ch: null, read_ch: 1 });
    const items = rankWeek(weekItems([quiet, heap, fresh, fav, ended, planned, dropped, noRu, noRuEnded, unseen]));
    expect(items.map((x) => x.r.title_ru)).toEqual(["E", "D", "C", "B"]);
    expect(items[0].ended).toBe(true);
    expect(items[2]).toMatchObject({ newCh: true, unread: 1 });
  });

  it("ранобэ в субботнем выборе: новое и накопленное только по-русски; только оригинал или «не смотрела» молчат; считает хозяин тем, чем считает", () => {
    const novel = (o: Partial<Reading>) => row({ kind: "ranobe", unit: "vol", src_vol: 14, mu_id: 5, ...o });
    const ruNew = novel({ id: 1, title_ru: "A", ru_vol: 9, ru_ch: 70, told_vol: 8, told_ch: 70, read_vol: 9 }); // вышел русский том 9
    const origOnly = novel({ id: 2, title_ru: "B", src_vol: 20, ru_vol: 0, ru_ch: 0, rh_map_at: 5, read_vol: 1 }); // оригинал есть, по-русски нет
    const unseen = novel({ id: 3, title_ru: "C", src_vol: 20, ru_vol: null, read_vol: 1 }); // RanobeHub ещё не смотрели
    const web = novel({ id: 4, title_ru: "D", unit: "ch", ru_vol: 1, ru_ch: 301, told_vol: 1, told_ch: 300, read_ch: 301 }); // веб-новелла: том один, считаем главами
    const endedOrig = novel({ id: 5, title_ru: "E", src_status: "finished", src_vol: 12, ru_vol: 0, ru_ch: 0, rh_map_at: 5, read_vol: 12 }); // закончено по оригиналу, перевода нет
    const items = weekItems([ruNew, origOnly, unseen, web, endedOrig]);
    expect(items.map((x) => x.r.title_ru)).toEqual(["A", "D"]);
    expect(items[0]).toMatchObject({ newVol: true, newCh: false, unread: 0 });
    expect(items[1]).toMatchObject({ newCh: true, newVol: false });
  });

  it("английская глава не новость: общий счётчик вырос, а русский нет — тишина; русский вырос — новость", () => {
    const en = row({ src_ch: 201, ru_ch: 149, told_ch: 149, read_ch: 149 });
    expect(weekItems([en])).toEqual([]);
    expect(weekItems([{ ...en, ru_ch: 150 }])).toHaveLength(1);
    expect(weekItems([{ ...en, ru_ch: 150 }])[0]).toMatchObject({ newCh: true, unread: 1 });
  });

  it("ключ недели — понедельник; суббота и пятница одной недели совпадают, следующая суббота — нет", () => {
    expect(weekKey(kyiv(2026, 11, 21, 11, 0), "Europe/Kyiv")).toBe("2026-11-16");
    expect(weekKey(kyiv(2026, 11, 20, 18, 0), "Europe/Kyiv")).toBe("2026-11-16");
    expect(weekKey(kyiv(2026, 11, 28, 11, 0), "Europe/Kyiv")).toBe("2026-11-23");
    expect(weekKey(kyiv(2026, 11, 22, 23, 30), "Europe/Kyiv")).toBe("2026-11-16");
  });
});

describe("чтение: что увидели у источника", () => {
  const T = 1_000_000;
  it("ранобэ: оригинал (MangaUpdates) растёт — это только справка; по-русски первая цифра — отправная точка, рост — новость, спад и заливка — не новость", () => {
    const novel = (o: Partial<Reading> = {}) => row({ kind: "ranobe", unit: "vol", ...o });
    // оригинал: общий счётчик растёт, но «вышло» и «про что писала» он не двигает
    const first = applyObs(novel({ src_vol: 0 }), { vol: 24 }, T);
    expect(first).toMatchObject({ src_vol: 24 });
    expect(first.told_vol).toBeUndefined();
    expect(first.src_at).toBeUndefined();
    const grew = applyObs(novel({ src_vol: 24, told_vol: 3, ru_vol: 3, ru_ch: 20 }), { vol: 25, url: "https://x/y" }, T);
    expect(grew).toMatchObject({ src_vol: 25, src_url: "https://x/y" });
    expect(grew.told_vol).toBeUndefined();
    expect(grew.src_at).toBeUndefined(); // оригинальный том — не новость
    expect(applyObs(novel({ src_vol: 24 }), { vol: 20 }, T).src_vol).toBeUndefined();
    expect(applyObs(novel({ src_vol: 24 }), { vol: 24 + JUMP_MAX + 1 }, T).src_vol).toBeUndefined();
    expect(applyObs(novel({ src_vol: 24 }), { vol: 24 + JUMP_MAX }, T).src_vol).toBe(124);
    // по-русски (RanobeHub): первая цифра — отправная точка, рост — новость
    const rhFirst = applyObs(novel({ src_vol: 24, told_vol: 0, ru_vol: null, ru_ch: null }), { ruCh: 40, ruVol: 2 }, T);
    expect(rhFirst).toMatchObject({ ru_ch: 40, told_ch: 40, ru_vol: 2, told_vol: 2 });
    expect(rhFirst.src_at).toBeUndefined();
    const rhGrew = applyObs(novel({ ru_ch: 40, told_ch: 40, ru_vol: 2, told_vol: 2 }), { ruCh: 43, ruVol: 3, url: "https://ranobehub.org/ranobe/1" }, T);
    expect(rhGrew).toMatchObject({ ru_ch: 43, ru_vol: 3, src_at: T, src_url: "https://ranobehub.org/ranobe/1" });
    expect(rhGrew.told_vol).toBeUndefined();
    expect(applyObs(novel({ ru_vol: 3, told_vol: 3 }), { ruVol: 1 }, T).ru_vol).toBe(3); // счётчик только растёт
    const bulk = applyObs(novel({ ru_vol: 2, told_vol: 2 }), { ruVol: 2 + JUMP_MAX + 1 }, T);
    expect(bulk).toMatchObject({ ru_vol: 103, told_vol: 103 }); // залили разом: не новость
    expect(bulk.src_at).toBeUndefined();
    // RanobeHub сказал «такой книги нет»: по-русски нет, это не «не смотрела»
    expect(applyObs(novel({ ru_vol: null, ru_ch: null, told_vol: 12 }), { ruCh: 0, ruVol: 0 }, T)).toMatchObject({ ru_ch: 0, ru_vol: 0, told_ch: 0, told_vol: 0 });
    // старая строка: «про что писала» шло по MangaUpdates и больше, чем есть по-русски — подтягиваем вниз, чтобы следующий русский том был новостью
    const legacy = applyObs(novel({ src_vol: 13, told_vol: 13, ru_vol: 8, ru_ch: 70, told_ch: 0 }), { ruCh: 70, ruVol: 8 }, T);
    expect(legacy).toMatchObject({ told_vol: 8 });
    expect(legacy.src_at).toBeUndefined();
  });

  it("манга: общий счётчик MangaDex про «вышло» не говорит; по-русски первая цифра — отправная точка, рост — новость, спад и заливка — не новость", () => {
    const all = applyObs(row({ src_ch: 199, told_ch: 149, ru_ch: 149 }), { ch: 201, vol: 24 }, T);
    expect(all).toMatchObject({ src_ch: 201, src_vol: 24 });
    expect(all.src_at).toBeUndefined(); // английские главы — не новость
    expect(all.told_ch).toBeUndefined();
    const first = applyObs(row({ src_ch: 199, ru_ch: null, told_ch: 0 }), { ch: 199, ruCh: 149, ruVol: 19 }, T);
    expect(first).toMatchObject({ ru_ch: 149, told_ch: 149, ru_vol: 19, told_vol: 19 });
    expect(first.src_at).toBeUndefined();
    const none = applyObs(row({ ru_ch: null }), { ruCh: 0, ruVol: 0 }, T);
    expect(none).toMatchObject({ ru_ch: 0, told_ch: 0, ru_vol: 0 });
    const grew = applyObs(row({ ru_ch: 149, told_ch: 149, ru_vol: 19, told_vol: 19 }), { ruCh: 151, ruVol: 19, url: "https://x/ru" }, T);
    expect(grew).toMatchObject({ ru_ch: 151, src_at: T, src_url: "https://x/ru" });
    expect(grew.told_ch).toBeUndefined();
    expect(applyObs(row({ ru_ch: 149, told_ch: 149 }), { ruCh: 140 }, T).ru_ch).toBe(149); // счётчик только растёт
    const bulk = applyObs(row({ ru_ch: 0, told_ch: 0, ru_vol: 0 }), { ruCh: 150 + JUMP_MAX, ruVol: 0 }, T);
    expect(bulk).toMatchObject({ ru_ch: 150 + JUMP_MAX, told_ch: 150 + JUMP_MAX }); // залили разом: «накопилось» покажет, «вышла глава» — нет
    expect(bulk.src_at).toBeUndefined();
    const appeared = applyObs(row({ ru_ch: 0, told_ch: 0, ru_vol: 0 }), { ruCh: 12, ruVol: 1 }, T);
    expect(appeared).toMatchObject({ ru_ch: 12, src_at: T }); // русский перевод появился: это новость
    expect(appeared.told_ch).toBeUndefined();
  });

  it("итоги закончившегося: счётчики и состояние, ссылка запоминается только при росте или в первый раз", () => {
    const p = applyObs(row({ kind: "ranobe", unit: "vol", src_vol: 15, told_vol: 3, ru_vol: 3 }), { status: "finished", totalCh: 160, totalVol: 18 }, T);
    expect(p).toMatchObject({ src_status: "finished", total_ch: 160, total_vol: 18, src_vol: 18 });
    expect(p.src_at).toBeUndefined(); // итоги по оригиналу не делают «вышел том» у ранобэ: по-русски они могут быть позже
    expect(p.told_vol).toBeUndefined();
    const m = applyObs(row({ src_ch: 150, ru_ch: 100, told_ch: 100 }), { status: "finished", totalCh: 160, totalVol: 18 }, T);
    expect(m).toMatchObject({ src_status: "finished", total_ch: 160, src_ch: 160 });
    expect(m.src_at).toBeUndefined(); // итоги не делают «вышла глава» у манги: по-русски они могут быть позже
    expect(applyObs(row({ src_ch: 150, src_url: "u1" }), { ch: 150, url: "u2" }, T).src_url).toBeUndefined();
    expect(applyObs(row({ src_ch: 150, src_url: null }), { ch: 150, url: "u2" }, T).src_url).toBe("u2");
  });

  it("RanobeHub: книги из ответа поиска; выбор — только точное совпадение названия, чужой язык и похожее не берём", () => {
    const books = parseRhBooks({
      books: [
        { id: 1265, title: "Володар [Украинский]", originalTitle: "Overlord", volumes: 2, chapters: 12 },
        { id: 206, title: "Повелитель", originalTitle: "Overlord", volumes: 19, chapters: 177 },
        { id: 49, title: "Повелитель, люби меня нежно!", originalTitle: "废材七小姐", volumes: 1, chapters: 498 },
        { id: "x", title: "мусор" },
        { id: 7, title: "Без цифр", originalTitle: "No Numbers", volumes: 0, chapters: -5 },
      ],
    });
    expect(books).toHaveLength(4);
    expect(books[3]).toMatchObject({ id: 7, vol: 0, ch: 0 });
    expect(pickRh(books, "Overlord", "Повелитель")).toMatchObject({ id: 206, vol: 19, ch: 177 });
    expect(pickRh(books, "Overlord Spin", "Повелитель-2")).toBeNull();
    expect(pickRh(books, "", "")).toBeNull();
    // пометки «(LN)», «(Новелла)», «[перевод …]» не мешают; несколько совпадений — берём с большим числом томов
    const marked = parseRhBooks({
      books: [
        { id: 47, title: "О моём перерождении в слизь", originalTitle: "Tensei Shitara Slime Datta Ken", volumes: 1, chapters: 435 },
        { id: 966, title: "О моем перерождении в слизь (LN)", originalTitle: "Tensei Shitara Slime Datta Ken (LN)", volumes: 21, chapters: 136 },
        { id: 708, title: "Re:Zero [перевод команда]", originalTitle: "Re:Zero Kara Hajimeru Isekai Seikatsu", volumes: 9, chapters: 179 },
      ],
    });
    expect(pickRh(marked, "Tensei shitara Slime Datta Ken", "О моём перерождении в слизь")?.id).toBe(966);
    expect(pickRh(marked, "Re:Zero kara Hajimeru Isekai Seikatsu", "Re:Zero. Жизнь с нуля")?.id).toBe(708);
    // русское название совпало, оригинал у сайта японский («Мастера меча онлайн»)
    expect(pickRh([{ id: 114, ru: "Мастера меча онлайн", orig: "ソードアート・オンライン", vol: 21, ch: 291 }], "Sword Art Online", "Мастера Меча Онлайн")?.id).toBe(114);
    expect(parseRhBooks(null)).toEqual([]);
    expect(parseRhBooks({ books: "нет" })).toEqual([]);
  });

  it("строки про русский перевод: манга — «по-русски до главы N на MangaDex», ранобэ — RanobeHub; список и «какая глава» честно говорят, если перевода нет", () => {
    const hana = row({ ru_ch: 149, ru_vol: 19, src_ch: 199, read_ch: 140, md_id: "md-1" });
    expect(ruBit(hana)).toBe("по-русски до главы 149 на MangaDex");
    expect(ruBit({ ...hana, unit: "vol" })).toBe("по-русски до тома 19 на MangaDex");
    expect(ruBit({ ...hana, unit: "vol", ru_vol: 0 })).toBe("по-русски до главы 149 на MangaDex");
    expect(ruBit({ ...hana, ru_ch: 0, ru_vol: 0 })).toBeNull();
    expect(progressText(hana)).toBe("глава 140 из 149 · накопилось 9");
    const none = row({ ru_ch: 0, ru_vol: 0, src_ch: 199, read_ch: 30, md_id: "md-1" });
    expect(progressText(none)).toBe("глава 30 · русского перевода на MangaDex пока нет");
    expect(whereText(none)).toContain("Русского перевода на MangaDex пока нет");
    expect(whereText(none)).not.toContain("199");
    expect(whereText(hana)).toContain("Вы на: глава 140 (по-русски вышло 149).");
    expect(whereText(hana)).not.toContain("199");
    const novel = row({ kind: "ranobe", unit: "vol", src_vol: 12, read_vol: 6, rh_id: 7, ru_vol: 9, ru_ch: 80, mu_id: 5 });
    expect(ruBit(novel)).toBe("по-русски до тома 9 на RanobeHub");
    expect(ruBit({ ...novel, unit: "ch" })).toBe("по-русски до главы 80 на RanobeHub");
    expect(ruBit({ ...novel, ru_ch: 0, ru_vol: 0 })).toBeNull();
    expect(progressText(novel)).toBe("том 6 из 9 · накопилось 3"); // «из N» и «накопилось» — по-русски; 12 томов оригинала не звучат
    expect(whereText(novel)).toContain("Вы на: том 6 (по-русски вышло 9).");
    expect(whereText(novel)).toContain("Накопилось: 3 тома.");
    expect(whereText(novel)).toContain("По оригиналу (MangaUpdates) вышло 12 томов."); // справка на прямой вопрос
    // ранобэ только по оригиналу: по-русски нет — честная пометка и в списке, и в «какой том»; оригинал назван справкой
    const orig = row({ kind: "ranobe", unit: "vol", src_vol: 12, read_vol: 10, ru_vol: 0, ru_ch: 0, mu_id: 5, rh_map_at: 5 });
    expect(ruBit(orig)).toBeNull();
    expect(progressText(orig)).toBe("том 10 · русского перевода на RanobeHub пока нет");
    expect(whereText(orig)).toContain("Русского перевода на RanobeHub пока нет, поэтому о новых томах и главах не пишу, пока он не появится.");
    expect(whereText(orig)).toContain("По оригиналу (MangaUpdates) вышло 12 томов.");
    expect(whereText(orig)).not.toContain("Накопилось");
    expect(whereText(orig)).not.toContain("по-русски вышло");
    // RanobeHub ещё не смотрели: не «перевода нет», а «догоню ночью»
    expect(whereText({ ...orig, ru_vol: null, ru_ch: null, rh_map_at: null })).toContain("Русский перевод на RanobeHub пока не посмотрела, догоню ночью.");
  });

  it("MangaDex: наибольшие целые глава и том; дробные главы считаем целой частью; «none» не считается", () => {
    const j = {
      result: "ok",
      volumes: {
        "1": { volume: "1", chapters: { "1": {}, "2": {}, "10.5": {} } },
        "24": { volume: "24", chapters: { "198": {}, "199": {} } },
        none: { volume: "none", chapters: { "200": {}, "201.5": {}, none: {} } },
      },
    };
    expect(parseAggregate(j)).toEqual({ ch: 201, vol: 24 });
    expect(parseAggregate({ result: "ok", volumes: {} })).toEqual({ ch: 0, vol: 0 });
    expect(parseAggregate({ result: "error" })).toBeNull();
    expect(parseAggregate(null)).toBeNull();
  });

  it("MangaUpdates: тома из строки состояния, веб-тома не считаем", () => {
    expect(parseMuStatus("28 Volumes (Ongoing)")).toEqual({ vol: 28, finished: false });
    expect(parseMuStatus("26 LN Volumes (Complete)  \n24 Web Volumes (Complete)")).toEqual({ vol: 26, finished: true });
    expect(parseMuStatus("24 Web Volumes (Complete)")).toBeNull();
    expect(parseMuStatus("Ongoing")).toBeNull();
  });

  it("Shikimori: манга и ранобэ узнаются по kind, остальное (додзинси) — нет; статусы переводятся", () => {
    expect(parseReadCand({ id: 1, name: "A", russian: "А", kind: "manga", status: "ongoing", volumes: 0, chapters: 0, aired_on: "2020-04-28" })).toMatchObject({ kind: "manga", status: "ongoing", year: 2020 });
    expect(parseReadCand({ id: 2, name: "B", russian: "", kind: "light_novel", status: "released", volumes: 5, chapters: 30 })).toMatchObject({ kind: "ranobe", ru: "B", status: "finished", volumes: 5, chapters: 30 });
    expect(parseReadCand({ id: 3, name: "C", kind: "doujin", status: "released" })).toBeNull();
    expect(parseReadCand({ name: "D", kind: "manga" })).toBeNull();
  });

  it("аниме по манге: идёт — важнее анонса, вышедшее — не новость", () => {
    expect(pickAdapt([{ mal: 1, ru: "а", status: "released" }, { mal: 2, ru: "б", status: "anons" }, { mal: 3, ru: "в", status: "ongoing" }])).toMatchObject({ mal: 3 });
    expect(pickAdapt([{ mal: 1, ru: "а", status: "released" }, { mal: 2, ru: "б", status: "anons" }])).toMatchObject({ mal: 2 });
    expect(pickAdapt([{ mal: 1, ru: "а", status: "released" }])).toBeNull();
  });
});

describe("чтение: настройка дня и времени", () => {
  it("по умолчанию суббота 11:00; значение из базы читается; битое — по умолчанию", () => {
    expect(readSettings([]).reading).toEqual({ dow: 6, at: 11 * 60 });
    expect(readSettings([{ key: "reading", value: "off" }]).reading).toBeNull();
    expect(readSettings([{ key: "reading", value: "5@18:30" }]).reading).toEqual({ dow: 5, at: 18 * 60 + 30 });
    expect(readSettings([{ key: "reading", value: "9@99:99" }]).reading).toEqual({ dow: 6, at: 11 * 60 });
  });

  it("окно: «суббота 11:00», «сб 11:00», «11:00» (суббота), «выкл»; ошибка — null", () => {
    expect(parseReadingWhen("суббота 11:00")).toBe("6@11:00");
    expect(parseReadingWhen("Вс 9.30")).toBe("7@09:30");
    expect(parseReadingWhen("18:00")).toBe("6@18:00");
    expect(parseReadingWhen("выкл")).toBe("off");
    expect(parseReadingWhen("")).toBe("off");
    expect(parseReadingWhen("когда-нибудь")).toBeNull();
    expect(parseReadingWhen("субота 25:00")).toBeNull();
  });
});
