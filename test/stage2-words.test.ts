// Разнообразие аниме-слов Хару (просьба владельца 2026-11-10: «яре-яре» слишком часто, пул словечек шире, само слово оставить).
import { describe, expect, it } from "vitest";
import { STYLE_DEFAULT, type StyleConfig, emptyStyleState, renderStyled } from "../src/personality/animeStyle.ts";
import { WORDS } from "../src/personality/lexicon.ts";
import { LEVEL_PROMPTS_FOR_TEST, buildLinePrompt, pickJaWords, type LineRequest } from "../src/personality/liveLines.ts";
import { MOODS, type Mood } from "../src/personality/moodEngine.ts";

const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const style = (o: Partial<StyleConfig> = {}): StyleConfig => ({ ...STYLE_DEFAULT, level: 2, ...o });

describe("словарь: пул шире, «яре яре» реже", () => {
  it("идентификаторы и написания уникальны, у каждого слова есть перевод, русский эквивалент и настроение", () => {
    expect(new Set(WORDS.map((w) => w.id)).size).toBe(WORDS.length);
    expect(new Set(WORDS.map((w) => w.cyrillic)).size).toBe(WORDS.length);
    for (const w of WORDS) {
      expect(w.meaning.length, w.id).toBeGreaterThanOrEqual(2);
      expect(w.ru.length, w.id).toBeGreaterThan(0);
      expect(w.moods.length, w.id).toBeGreaterThan(0);
      expect(w.cyrillic, w.id).not.toMatch(/[A-Za-z]/);
    }
  });

  it("слов стало заметно больше; у каждого настроения не меньше пяти слов в начале сообщения", () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(35);
    for (const m of MOODS) {
      const lead = WORDS.filter((w) => w.slot === "lead" && w.moods.includes(m));
      expect(lead.length, m).toBeGreaterThanOrEqual(5);
    }
    // у усталой и цундере (самые частые настроения) выбор шире десяти
    for (const m of ["tired", "tsundere"] as Mood[]) expect(WORDS.filter((w) => w.slot === "lead" && w.moods.includes(m)).length).toBeGreaterThanOrEqual(9);
  });

  it("«яре яре» остаётся, но с долгой паузой: после использования не возвращается ближайшие сообщения", () => {
    const yare = WORDS.find((w) => w.id === "yare_yare")!;
    expect(yare.cooldown).toBeGreaterThanOrEqual(12);
    const state = { ...emptyStyleState(), n: 10, words: { yare_yare: { u: 3, l: 4 } } }; // было 6 сообщений назад: обычное слово уже можно, «яре яре» — нет
    for (let seed = 1; seed <= 200; seed++) {
      const r = renderStyled({ template: "Пора.", mood: "tired", situation: "reminder", style: style({ level: 3 }), state, rand: lcg(seed) });
      expect(r.used).not.toContain("yare_yare");
    }
  });

  it("на длинной дистанции «яре яре» — не больше десятой доли слов, а разных слов много", () => {
    for (const mood of ["tired", "tsundere"] as Mood[]) {
      let state = emptyStyleState();
      const rand = lcg(7);
      const count: Record<string, number> = {};
      let total = 0;
      for (let i = 0; i < 600; i++) {
        const r = renderStyled({ template: "Пора.", mood, situation: "reminder", style: style({ level: 3 }), state, rand });
        state = r.state;
        for (const id of r.used) {
          count[id] = (count[id] ?? 0) + 1;
          total++;
        }
      }
      expect((count.yare_yare ?? 0) / total, mood).toBeLessThan(0.1);
      expect(Object.keys(count).length, mood).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("живые реплики: подсказка модели не тянет к «яре яре»", () => {
  const req = (o: Partial<LineRequest> = {}): LineRequest => ({
    mood: "tired", situation: "reminder", level: 2, address: null, hour: 10, weekday: 2, length: "short", interests: [], ...o,
  });

  it("pickJaWords: слова под настроение, без «яре яре», «бака», «мо-о»; одинаковая случайность — одинаковый набор; разные — разные", () => {
    for (const mood of MOODS) {
      const a = pickJaWords(mood, lcg(1), 5);
      expect(a.length, mood).toBe(5);
      expect(new Set(a).size).toBe(5);
      for (const w of a) expect(["яре яре", "бака", "мо-о"], w).not.toContain(w);
    }
    expect(pickJaWords("tired", lcg(3), 5)).toEqual(pickJaWords("tired", lcg(3), 5));
    const sets = new Set(Array.from({ length: 30 }, (_, i) => pickJaWords("tired", lcg(i + 1), 5).join(",")));
    expect(sets.size).toBeGreaterThan(8);
  });

  it("в тексте запроса нет примера «ну и ну → яре яре»; есть набор слов на выбор; «яре-яре» остаётся в списке «редко»", () => {
    for (const level of [1, 2, 3] as const) {
      const p = buildLinePrompt(req({ level, jaWords: ["наруходо", "тайхэн"] }));
      expect(p).not.toContain("ну и ну → «яре яре»");
      expect(p).toContain("наруходо");
      expect(p).toContain("тайхэн");
      expect(p).toMatch(/яре-яре/); // как «редко»
    }
    expect(LEVEL_PROMPTS_FOR_TEST[3]).not.toMatch(/«яре яре»/);
    expect(buildLinePrompt(req({ level: 0, jaWords: ["наруходо"] }))).not.toContain("наруходо");
  });
});
