// Подготовка загрузки прошлых отметок из анкеты вкусов в таблицу anime (scripts/lib/tasteMarks.ts): сопоставление кодов, сборка строк, SQL.
// Данные ВЫДУМАННЫЕ (настоящие ответы владельца в git не попадают).
import { describe, expect, it } from "vitest";
import { buildRows, collectTitles, mapCodes, orderRows, renderSql, summarize } from "../scripts/lib/tasteMarks.ts";
import { World } from "./world.ts";

describe("mapCodes: коды анкеты → статус и оценка", () => {
  it.each([
    // одна отметка (волна 1 — строка; волна 3 — массив из одного кода)
    ["now", "watching", 0],
    ["plan", "planned", 0],
    ["drop", "dropped", 0],
    ["love", "done", 2],
    ["like", "done", 1],
    ["meh", "done", -1],
    ["dislike", "done", -2],
    ["seen", "done", 0],
    [["love"], "done", 2],
    // несколько отметок (волна 3)
    [["like", "drop"], "dropped", 1], // понравилось + бросил = бросил, но оценка остаётся
    [["dislike", "drop"], "dropped", -2],
    [["drop", "seen"], "dropped", 0],
    [["dislike", "drop", "seen"], "dropped", -2],
    [["love", "seen"], "done", 2],
    [["like", "now"], "watching", 1],
    [["none", "plan"], "planned", 0], // «не смотрел» + «в планах» — это планы
    [["plan", "seen"], "done", 0],
    [["like", "plan", "seen"], "done", 1],
    [["drop", "plan"], "dropped", 0],
  ] as const)("%j → %s, оценка %i", (codes, status, liked) => {
    expect(mapCodes(codes as string[] | string)).toMatchObject({ status, liked });
  });

  it.each([["none"], [["none"]], [[]], [["ok"]], [["never"]], [["must"]], [[""]]])("%j — загружать нечего", (codes) => {
    expect(mapCodes(codes as string[] | string)).toBeNull();
  });

  it("противоречивые оценки — оценка 0 и пометка; тайтл всё равно загружается", () => {
    expect(mapCodes(["like", "dislike"])).toEqual({ status: "done", liked: 0, notes: ["rating-conflict"] });
  });

  it("спорные сочетания помечаются для сводки", () => {
    expect(mapCodes(["plan", "seen"])?.notes).toEqual(["plan+seen"]);
    expect(mapCodes(["drop", "plan"])?.notes).toEqual(["drop+plan"]);
    expect(mapCodes(["drop", "now"])?.notes).toEqual(["drop+now"]);
    expect(mapCodes(["like", "drop"])?.notes).toEqual([]);
  });
});

const pageA = { lists: [{ id: "a", items: [{ id: 1, ru: "Первое", orig: "First", episodes: 12 }, { id: 2, ru: "Второе", orig: "Second" }, { id: 3, ru: "О'Хара", orig: "O'Hara" }] }] };
const pageB = { lists: [{ id: "b", items: [{ id: 4, ru: "Четвёртое", orig: "" }, { id: 5, ru: "Пятое", orig: "Fifth", episodes: 24 }, { id: 1, ru: "Дубль", orig: "Dup" }] }] };

describe("collectTitles", () => {
  it("названия, оригинал и число серий; первое найденное не перезаписывается; мусор пропускается", () => {
    const t = collectTitles([pageA, pageB, null, { lists: "no" }, { lists: [{ items: [{ id: "x", ru: "Без номера" }, { id: 9, ru: "" }] }] }]);
    expect([...t.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(t.get(1)).toEqual({ ru: "Первое", orig: "First", episodes: 12 });
    expect(t.get(2)).toEqual({ ru: "Второе", orig: "Second", episodes: null });
    expect(t.get(4)).toEqual({ ru: "Четвёртое", orig: null, episodes: null });
  });
});

describe("buildRows: списки анкеты → строки таблицы", () => {
  const titles = collectTitles([pageA, pageB]);
  const w1 = { kind: "title", states: { "1": "love", "2": "none", "3": "drop", "4": "plan" }, names: { "1": "из списка" } };
  const w3 = {
    kind: "anime2",
    states: { "5": ["like", "now"], "6": ["dislike", "drop"], "7": ["none"] },
    names: { "6": "Шестое (имя только в списке)", "7": "Седьмое" },
  };
  const taste = { kind: "taste", states: { "1": "love", "99": "like" } }; // жанры/вкусы: не тайтлы, в загрузку не идут
  const rep = buildRows([w1, w3, taste, { kind: "need", states: { "8": "must" } }], titles);
  const byId = (id: number) => rep.rows.find((r) => r.mal_id === id);

  it("строки: статус, оценка, watched = 0; названия из titles.json, запасное — имя из списка", () => {
    expect(byId(1)).toEqual({ mal_id: 1, title_ru: "Первое", title_orig: "First", status: "done", watched: 0, liked: 2, episodes: 12 });
    expect(byId(3)).toEqual({ mal_id: 3, title_ru: "О'Хара", title_orig: "O'Hara", status: "dropped", watched: 0, liked: 0, episodes: null });
    expect(byId(4)).toMatchObject({ status: "planned", liked: 0, episodes: null });
    expect(byId(5)).toMatchObject({ status: "watching", liked: 1, episodes: null }); // серии только у «Просмотрено»
    expect(byId(6)).toMatchObject({ title_ru: "Шестое (имя только в списке)", title_orig: null, status: "dropped", liked: -2 });
  });

  it("«не смотрел» и не-тайтлы не загружаются; сводка считает", () => {
    expect(byId(2)).toBeUndefined();
    expect(byId(7)).toBeUndefined();
    expect(byId(8)).toBeUndefined();
    expect(byId(99)).toBeUndefined();
    expect(rep.rows.map((r) => r.mal_id).sort()).toEqual([1, 3, 4, 5, 6]);
    expect(rep.seen).toBe(7);
    expect(rep.skippedNone).toBe(2);
    expect(rep.noTitle).toBe(0);
    const text = summarize(rep).join("\n");
    expect(text).toContain("к загрузке: 5");
    expect(text).toContain("Смотрю: 1 · В планах: 1 · Просмотрено: 1 · Бросил: 2");
    expect(text).not.toContain("О'Хара"); // названий в сводке нет
  });

  it("серии у «Просмотрено» — из titles.json, если там есть; нет названия нигде — тайтл пропущен и посчитан", () => {
    const r = buildRows([{ kind: "title", states: { "5": "like", "2": "seen", "404": "love" } }], titles);
    expect(r.rows.find((x) => x.mal_id === 5)?.episodes).toBe(24);
    expect(r.rows.find((x) => x.mal_id === 2)?.episodes).toBeNull();
    expect(r.noTitle).toBe(1);
  });

  it("один тайтл в двух списках — коды складываются", () => {
    const r = buildRows([{ kind: "title", states: { "1": "like" } }, { kind: "anime2", states: { "1": ["drop"] } }], titles);
    expect(r.rows).toEqual([{ mal_id: 1, title_ru: "Первое", title_orig: "First", status: "dropped", watched: 0, liked: 1, episodes: null }]);
    expect(r.merged).toBe(1);
  });

  it("порядок вставки: в «Просмотрено» и «Бросил» (id по убыванию) любимое окажется сверху, в «Смотрю» и «В планах» (id по возрастанию) — тоже", () => {
    const mk = (mal_id: number, title_ru: string, status: "watching" | "planned" | "done" | "dropped", liked: number) => ({ mal_id, title_ru, title_orig: null, status, watched: 0 as const, liked, episodes: null });
    const rows = orderRows([mk(1, "Б", "done", 0), mk(2, "А", "done", 2), mk(3, "В", "done", 2), mk(4, "Г", "done", -2), mk(5, "Б", "planned", 0), mk(6, "А", "planned", 0), mk(7, "Я", "watching", 0), mk(8, "Д", "dropped", 1)]);
    // id в таблице будут идти в порядке вставки: показ «Просмотрено» = обратный порядок
    expect(rows.filter((r) => r.status === "done").map((r) => r.title_ru).reverse()).toEqual(["А", "В", "Б", "Г"]);
    expect(rows.filter((r) => r.status === "planned").map((r) => r.title_ru)).toEqual(["А", "Б"]);
    expect(rows.map((r) => r.status)).toEqual(["watching", "planned", "planned", "done", "done", "done", "done", "dropped"]);
  });
});

describe("renderSql: SQL для d1 execute", () => {
  const rows = [{ mal_id: 3, title_ru: "О'Хара", title_orig: "O'Hara", status: "dropped" as const, watched: 0 as const, liked: -2, episodes: null }];

  it("одна вставка на строку, кавычки удвоены, ON CONFLICT DO NOTHING, без BEGIN/COMMIT", () => {
    const sql = renderSql(rows, 1000);
    expect(sql).toContain("VALUES (3, 'О''Хара', 'O''Hara', 'dropped', 0, -2, NULL, 1000, 1000) ON CONFLICT(mal_id) DO NOTHING;");
    expect(sql).not.toMatch(/BEGIN|COMMIT|PRAGMA/i);
    expect(sql.endsWith("\n")).toBe(true);
  });

  it("настоящая схема: вставка работает, повтор ничего не меняет и не затирает записанное в боте", async () => {
    const w = new World();
    const sql = renderSql(
      [
        ...rows,
        { mal_id: 1, title_ru: "Первое", title_orig: "First", status: "done" as const, watched: 0 as const, liked: 2, episodes: 12 },
        { mal_id: 4, title_ru: "Четвёртое", title_orig: null, status: "planned" as const, watched: 0 as const, liked: 0, episodes: null },
      ],
      5000,
    );
    w.d1.sqlite.exec("INSERT INTO anime (mal_id, title_ru, status, watched, liked, added_at, updated_at) VALUES (4, 'Уже записано в боте', 'watching', 7, 1, 1, 1)");
    w.d1.sqlite.exec(sql);
    w.d1.sqlite.exec(sql); // повторный запуск
    const all = w.d1.q<{ mal_id: number; title_ru: string; status: string; watched: number; liked: number; episodes: number | null; notify: number; aired_ep: number; src_status: string | null }>(
      "SELECT mal_id, title_ru, status, watched, liked, episodes, notify, aired_ep, src_status FROM anime ORDER BY mal_id",
    );
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ mal_id: 1, status: "done", liked: 2, episodes: 12, watched: 0, notify: 1, aired_ep: 0, src_status: null });
    expect(all[1]).toMatchObject({ mal_id: 3, title_ru: "О'Хара", status: "dropped", liked: -2 });
    expect(all[2]).toMatchObject({ mal_id: 4, title_ru: "Уже записано в боте", status: "watching", watched: 7, liked: 1 }); // не затёрто
  });
});
