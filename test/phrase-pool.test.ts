// Целостность набора фраз: пул из Gemini после проверки и сводный набор движка.
import { describe, expect, it } from "vitest";
import { extractLastJson } from "../scripts/import-phrases.ts";
import { BASE_PHRASES } from "../src/personality/phrases.base.ts";
import { GENERATED } from "../src/personality/phrases.generated.ts";
import { PHRASES, SITUATIONS, mergePools } from "../src/personality/phrases.ts";
import { POOL_SITUATIONS, checkMood, integrityProblems, sanitize, sentenceCount } from "../src/personality/poolCheck.ts";
import { fill, pickPhrase } from "../src/personality/speech.ts";
import { MOODS } from "../src/personality/moodEngine.ts";

const WORDS = "альфа бета гамма дельта эпсилон зета эта тета йота каппа".split(" ");
const PLACES = "роща река гора озеро поле остров берег холм луг лес".split(" ");

/** Набор из 10 разных безобидных фраз на каждую ситуацию; over подменяет списки отдельных ситуаций. */
const sample = (over: Record<string, string[]> = {}, mood = "tired") => {
  const phrases: Record<string, string[]> = {};
  POOL_SITUATIONS.forEach((s, si) => (phrases[s] = WORDS.map((w) => `Фраза ${w} про ${PLACES[si]}`)));
  return { mood, phrases: { ...phrases, ...over } };
};

describe("пул фраз: проверка (poolCheck)", () => {
  it("хороший набор проходит без отбраковки", () => {
    const r = checkMood(sample());
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    for (const s of POOL_SITUATIONS) expect(r.kept[s]).toHaveLength(10);
  });

  it("отбрасывает: латиницу, цифры, японское, эмодзи, ссылки, длинное, лишние подстановки, мужской род, серьёзные темы, угрозы", () => {
    const bad = [
      "Hello мир",
      "В 10 часов утра пора",
      "Хозяин-сан, пора",
      "Пора 😀 за дело",
      "Смотрите http://x.ru",
      "а".repeat(170),
      "Фраза с {другое} полем",
      "{miss_count} дел пропущено, увы",
      "Повторяю в третий раз подряд",
      "Я устал от этого всего",
      "Уж я-то знаю про болезни",
      "Я убью эту пыль и вас",
    ];
    const r = checkMood(sample({ reminder: bad }));
    expect(r.kept.reminder).toEqual([]);
    const rejected = new Set(r.issues.filter((i) => i.sit === "reminder" && i.idx >= 0 && i.severity === "error").map((i) => i.idx));
    expect(rejected.size).toBe(bad.length); // каждая негодная названа в замечаниях
  });

  it("{task} только в «ёлочках» или после двоеточия, не больше трети; {user} не больше одной на ситуацию; {done_streak} только в streak_praise", () => {
    const tasks = ["Дело: {task}", "Пора за «{task}»", "Это {task} ну надо же", "Снова «{task}»", "Опять «{task}» тут", "Ещё «{task}» ждёт"];
    const r = checkMood(sample({ reminder: tasks }));
    expect(r.kept.reminder).toEqual(["Дело: {task}", "Пора за «{task}»", "Снова «{task}»"]); // третья не в ёлочках, остальные — больше трети
    const u = checkMood(sample({ greeting: ["Привет, {user}, как дела", "Здравствуйте, {user}, давно вас не слышно"] }));
    expect(u.kept.greeting).toEqual(["Привет, {user}, как дела"]);
    const d = checkMood(sample({ reminder: ["Серия {done_streak} дел подряд"], streak_praise: ["Серия {done_streak} дел подряд"] }));
    expect(d.kept.reminder).toEqual([]);
    expect(d.kept.streak_praise).toEqual(["Серия {done_streak} дел подряд"]);
  });

  it("{miss_count} только в missed и только у tsundere и yandere", () => {
    const f = "Пропущено {miss_count} дел, ну надо же";
    expect(checkMood(sample({ missed: [f] }, "tsundere")).kept.missed).toEqual([f]);
    expect(checkMood(sample({ missed: [f] }, "yandere")).kept.missed).toEqual([f]);
    expect(checkMood(sample({ missed: [f] }, "proud")).kept.missed).toEqual([]);
  });

  it("дубли отбрасываются; «Господин {user}» очищается до «Господин»; предложения считаются без звёздочных действий", () => {
    const r = checkMood(sample({ idle_ping: ["Тихо тут, совсем", "тихо тут совсем!", "Совсем другая фраза"] }));
    expect(r.kept.idle_ping).toEqual(["Тихо тут, совсем", "Совсем другая фраза"]);
    expect(sanitize("Господин {user}, пора  уже")).toBe("Господин, пора уже");
    expect(sentenceCount("*вздох* Раз. Два. Три.")).toBe(3);
    expect(sentenceCount("Раз... Два!")).toBe(2);
  });

  it("слова «долго», «сама», «кровать» не принимаются за запретные; «долгом», «убью» — принимаются", () => {
    const ok = ["Я ждала долго", "Работа сама себя не сделает", "Мечтаю о кровати"];
    expect(checkMood(sample({ idle_ping: ok })).kept.idle_ping).toEqual(ok);
    const bad = ["Дело висит долгом, увы", "Я убью эту пыль и вас"];
    expect(checkMood(sample({ idle_ping: bad })).kept.idle_ping).toEqual([]);
  });

  it("извлекает последний готовый JSON из «стенограммы» с черновиками", () => {
    const text = 'черновик {"mood":"tired","phrases":{"reminder":["старое"]}}\nпояснение\n{\n  "mood": "tired",\n  "phrases": {"reminder": ["новое, с } скобкой"],}\n}\nконец';
    const r = extractLastJson(text);
    expect(r.candidates).toBe(2);
    expect(r.data?.phrases.reminder).toEqual(["новое, с } скобкой"]);
    expect(extractLastJson("нет json").data).toBeNull();
  });
});

describe("пул фраз: данные движка", () => {
  it("загруженный пул прошёл проверку: ни одной негодной фразы, по 8+ фраз в ситуации, все 6 настроений", () => {
    for (const mood of MOODS) {
      const g = GENERATED[mood];
      expect(g, mood).toBeTruthy();
      const r = checkMood({ mood, phrases: g as Record<string, string[]> });
      expect(r.issues.filter((i) => i.severity === "error" && i.idx >= 0), mood).toEqual([]);
      for (const s of POOL_SITUATIONS) expect((g![s] ?? []).length, `${mood}.${s}`).toBeGreaterThanOrEqual(8);
    }
  });

  it("сводный набор целостен: подстановки допустимы, пустых и дублей нет", () => {
    expect(integrityProblems(PHRASES)).toEqual([]);
    expect(integrityProblems(GENERATED)).toEqual([]);
    expect(integrityProblems(BASE_PHRASES)).toEqual([]);
  });

  it("у каждого настроения есть фразы для всех ситуаций, которые использует движок", () => {
    const used = ["reminder", "reminder_repeat", "missed", "done", "done_late", "streak_praise", "greeting", "return_after_pause"] as const;
    for (const mood of MOODS) for (const s of used) expect(PHRASES[mood][s]?.length ?? 0, `${mood}.${s}`).toBeGreaterThanOrEqual(8);
    // собственные ситуации движка остаются из запасного набора
    for (const s of ["missed_first", "relief", "thanks"] as const) expect(Object.values(PHRASES).some((m) => (m[s]?.length ?? 0) > 0), s).toBe(true);
    for (const s of POOL_SITUATIONS) expect(SITUATIONS).toContain(s);
  });

  it("сначала основной пул, запасные — только если там меньше 8", () => {
    const m = mergePools(
      { tired: { done: "раз два три четыре пять шесть семь восемь".split(" ").map((w) => `основная ${w}`), reminder: ["основная один"] } },
      { tired: { done: ["запасная"], reminder: ["запасная раз", "основная один"], thanks: ["спасибо вам"] } },
    );
    expect(m.tired.done).toHaveLength(8);
    expect(m.tired.reminder).toEqual(["основная один", "запасная раз"]);
    expect(m.tired.thanks).toEqual(["спасибо вам"]);
  });

  it("все фразы подставляются: нет остатков {…} и пустых строк; {user} в начале предложения с большой буквы", () => {
    for (const mood of MOODS)
      for (const [sit, list] of Object.entries(PHRASES[mood]))
        for (const t of list ?? []) {
          const out = fill(t, { task: "Купить хлеб", miss_count: 3, done_streak: 7 });
          expect(out, `${mood}.${sit}`).not.toMatch(/[{}]/);
          expect(out.trim().length).toBeGreaterThan(0);
        }
    expect(fill("{user}, идите.", {})).toBe("Хозяин, идите.");
    expect(fill("Ну что, {user}?", {})).toBe("Ну что, хозяин?");
  });

  it("серия и «Готово» с опозданием берут фразы своих ситуаций", () => {
    const p = pickPhrase({ mood: "tsundere", situation: "streak_praise", vars: { done_streak: 7 }, recent: [], rand: () => 0 })!;
    expect(p.text).toBeTruthy();
    expect(pickPhrase({ mood: "yandere", situation: "done_late", recent: [], rand: () => 0.5 })).not.toBeNull();
  });
});
