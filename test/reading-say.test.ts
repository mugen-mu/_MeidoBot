// Чтение: живые фразы и вопросы (чистые функции), разбор ответов источников, подсчёт «накопилось», выбор для субботнего сообщения.
import { describe, expect, it } from "vitest";
import { type Reading, ownMatches, rankWeek, unread, weekItems, weekKey } from "../src/reading/core.ts";
import { readTarget, statusAfterRead } from "../src/reading/handlers.ts";
import { JUMP_MAX, applyObs } from "../src/reading/refresh.ts";
import { parseReadAsk, parseReadSay } from "../src/reading/say.ts";
import { parseAggregate, parseMuStatus, parseReadCand, pickAdapt } from "../src/reading/sources.ts";
import { parseReadingWhen } from "../src/reading/ui.ts";
import { readSettings } from "../src/settings.ts";
import { kyiv } from "./helpers.ts";

const row = (o: Partial<Reading> = {}): Reading => ({
  id: 1, mal_id: 9001, kind: "manga", title_ru: "Цветок и меч", title_orig: "Hana to Ken", status: "reading", unit: "ch", read_ch: null, read_vol: null, liked: 0, total_ch: null, total_vol: null,
  src_status: "ongoing", src_ch: 0, src_vol: 0, src_at: null, ru_ch: null, src_url: null, md_id: null, mu_id: null, map_at: null, checked_at: null, chk_fail: 0, shiki_at: null, told_ch: 0, told_vol: 0,
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
  it("накопилось = вышло − прочитано; без «где я» или без счётчика — null", () => {
    expect(unread(row({ src_ch: 199, read_ch: 190 }))).toBe(9);
    expect(unread(row({ src_ch: 199, read_ch: null }))).toBeNull();
    expect(unread(row({ src_ch: 0, read_ch: 5 }))).toBeNull();
    expect(unread(row({ src_ch: 10, read_ch: 12 }))).toBe(0);
    expect(unread(row({ unit: "vol", src_vol: 13, read_vol: 10, src_ch: 0 }))).toBe(3);
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

  it("в субботнее сообщение попадают новое, завершение и накопленное; порядок решает Хару", () => {
    const quiet = row({ id: 1, title_ru: "A", src_ch: 50, told_ch: 50, read_ch: 50 }); // ничего нового
    const heap = row({ id: 2, title_ru: "B", src_ch: 100, told_ch: 100, read_ch: 60 }); // накопилось 40
    const fresh = row({ id: 3, title_ru: "C", src_ch: 31, told_ch: 30, read_ch: 30 }); // вышла новая
    const fav = row({ id: 4, title_ru: "D", src_ch: 12, told_ch: 12, read_ch: 10, liked: 2 }); // любимое, накопилось 2
    const ended = row({ id: 5, title_ru: "E", src_status: "finished", src_ch: 20, told_ch: 20, read_ch: 20, end_told: 0 });
    const planned = row({ id: 6, title_ru: "F", status: "planned", src_ch: 9, told_ch: 0 });
    const dropped = row({ id: 7, title_ru: "G", status: "dropped", src_ch: 9, told_ch: 0, read_ch: 1 });
    const items = rankWeek(weekItems([quiet, heap, fresh, fav, ended, planned, dropped]));
    expect(items.map((x) => x.r.title_ru)).toEqual(["E", "D", "C", "B"]);
    expect(items[0].ended).toBe(true);
    expect(items[2]).toMatchObject({ newCh: true, unread: 1 });
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
  it("первая цифра — отправная точка (про неё не пишем), рост — новость, спад и скачок — игнор", () => {
    const first = applyObs(row({ src_ch: 0 }), { ch: 199, vol: 24 }, T);
    expect(first).toMatchObject({ src_ch: 199, told_ch: 199, src_vol: 24, told_vol: 24 });
    expect(first.src_at).toBeUndefined();
    const grew = applyObs(row({ src_ch: 199, told_ch: 199, src_vol: 24, told_vol: 24 }), { ch: 201, vol: 24, url: "https://x/y" }, T);
    expect(grew).toMatchObject({ src_ch: 201, src_at: T, src_url: "https://x/y" });
    expect(grew.told_ch).toBeUndefined();
    expect(applyObs(row({ src_ch: 199 }), { ch: 150 }, T).src_ch).toBeUndefined();
    expect(applyObs(row({ src_ch: 199 }), { ch: 199 + JUMP_MAX + 1 }, T).src_ch).toBeUndefined();
    expect(applyObs(row({ src_ch: 199 }), { ch: 199 + JUMP_MAX }, T).src_ch).toBe(299);
  });

  it("итоги закончившегося: счётчики и состояние, ссылка запоминается только при росте или в первый раз", () => {
    const p = applyObs(row({ src_ch: 150, told_ch: 150 }), { status: "finished", totalCh: 160, totalVol: 18 }, T);
    expect(p).toMatchObject({ src_status: "finished", total_ch: 160, total_vol: 18, src_ch: 160, src_at: T });
    expect(applyObs(row({ src_ch: 150, src_url: "u1" }), { ch: 150, url: "u2" }, T).src_url).toBeUndefined();
    expect(applyObs(row({ src_ch: 150, src_url: null }), { ch: 150, url: "u2" }, T).src_url).toBe("u2");
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
