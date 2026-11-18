// Характер Хару по ответам анкеты вкусов (2026-11-17/18): интересы и их частота, подсказки перевода выкл, реплики на отметки аниме под разными углами,
// «пора спать» ночью, подбадривание цитатой в тяжёлый день.
import { beforeEach, describe, expect, it } from "vitest";
import { haru } from "../src/anime/core.ts";
import { STYLE_DEFAULT, emptyStyleState, parseStyle, parseStyleState } from "../src/personality/animeStyle.ts";
import {
  ANGLE_ORDER, ANGLE_WEIGHT, type Angle, LATE_NIGHT, NIGHT_LINE_CHANCE, REACTION_LINES, type ReactionKind, isLateNight, pickReaction,
} from "../src/personality/animeLines.ts";
import { HEAVY, HEAVY_GAP_DAYS, heavyReady, isHeavyDay, markHeavy } from "../src/personality/day.ts";
import { MoodSession, makeCtx, summaryLine } from "../src/personality/director.ts";
import type { AiBinding } from "../src/llm.ts";
import { buildLinePrompt } from "../src/personality/liveLines.ts";
import { INTERESTS, INTEREST_CHANCE, INTEREST_FREE, INTEREST_TOPICS, pickInterests } from "../src/personality/occasions.ts";
import { ADDITION_GROUPS, FALLBACK_SITUATION, PHRASES, SITUATIONS } from "../src/personality/phrases.ts";
import { hasMasculineSelf } from "../src/personality/gender.ts";
import { lintPhrase } from "../src/personality/poolCheck.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { OWNER, World } from "./world.ts";

/** Повторяемый генератор случайных чисел (mulberry32), чтобы «статистика» в тестах не прыгала. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- интересы ----------

describe("интересы Хару: шире и чаще, но без перебора", () => {
  it("тем много и они разные: жанры, типажи, штампы, цитаты и мемы, музыка", () => {
    expect(Object.keys(INTEREST_TOPICS).sort()).toEqual(["genres", "memes", "music", "tropes", "types"]);
    for (const [group, list] of Object.entries(INTEREST_TOPICS)) expect(list.length, group).toBeGreaterThanOrEqual(5);
    expect(INTERESTS).toContain("аниме");
    expect(INTERESTS.length).toBeGreaterThan(30);
    // модель отбраковывает латиницу (cleanLine): в темах только кириллица («джей-поп», а не J-pop)
    for (const t of INTERESTS) expect(t, t).not.toMatch(/[A-Za-z]/);
  });

  it("частота выросла с 0,3, но «аниме в каждой шутке» не бывает: меньше, чем в каждой второй-третьей… то есть не больше половины", () => {
    expect(INTEREST_CHANCE).toBeGreaterThan(0.3);
    expect(INTEREST_CHANCE).toBeLessThanOrEqual(0.5);
  });

  it("за один раз — слово «аниме» и две темы из РАЗНЫХ групп; от rand зависит всё", () => {
    const groupOf = (topic: string): string => Object.entries(INTEREST_TOPICS).find(([, l]) => l.includes(topic))![0];
    const seen = new Set<string>();
    const rand = prng(7);
    for (let i = 0; i < 300; i++) {
      const r = pickInterests(rand);
      expect(r).toHaveLength(3);
      expect(r[0]).toBe("аниме");
      expect(groupOf(r[1])).not.toBe(groupOf(r[2]));
      r.slice(1).forEach((t) => seen.add(t));
    }
    // за 300 раз встретилась большая часть тем: отсылки меняются, а не липнут к одной
    expect(seen.size).toBeGreaterThan(INTERESTS.length * 0.7);
    expect(pickInterests(() => 0)).toEqual(pickInterests(() => 0));
    for (const x of [0, 0.5, 0.9999999]) expect(pickInterests(() => x)).toHaveLength(3); // крайние значения не выходят за списки
  });

  it("серьёзное и служебное — без отсылок: важный пропуск, мелочь, свет, источники, погода, тяжёлый день", () => {
    for (const s of ["missed_major", "done_major", "missed_minor", "done_minor", "power_off", "power_on", "source_down", "source_week", "rain_start", "rain_end", "rain_early", "weather_ask", "heavy_day"]) {
      expect(INTEREST_FREE.has(s), s).toBe(true);
    }
    for (const s of ["reminder", "done", "greeting", "summary_morning", "recorded"]) expect(INTEREST_FREE.has(s), s).toBe(false);
  });
});

describe("интересы в запросе к модели", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: {} });
  });
  const answer = (text: string) => ({ choices: [{ message: { content: text } }] });
  function fakeAi() {
    const calls: { input: { messages: { role: string; content: string }[] } }[] = [];
    const ai: AiBinding = {
      async run(_m, input) {
        calls.push({ input: input as never });
        return answer("Ну вот, чай остыл, а вы всё медлите.");
      },
    };
    return { ai, calls };
  }
  const mk = async (rand: () => number) => {
    const s = await w.settings();
    const f = fakeAi();
    const m = new MoodSession({ repo: w.repo(), userId: OWNER, ctx: makeCtx(NOW, s), rand, style: { ...STYLE_DEFAULT, level: 2 }, live: { ai: f.ai, tz: s.tz, timeoutMs: 500 } });
    await m.load();
    return { m, f };
  };
  const system = (f: { calls: { input: { messages: { content: string }[] } }[] }): string => f.calls[0].input.messages[0].content;

  it("обычная ситуация: в запросе «Хозяин любит: аниме, …» и правило «цитату говори словами героя, источник не называй»", async () => {
    const { m, f } = await mk(() => 0.1); // 0,1 < шанса: отсылка выпала
    await m.sayLive("reminder", { task: "Дело" });
    const p = system(f);
    expect(p).toContain("Хозяин любит: аниме, ");
    expect(p).toContain("НЕ называй, откуда они");
    expect(p).not.toMatch(/Хозяин любит:[^.]*[A-Za-z]/);
  });

  it("не выпал шанс — отсылок в запросе нет", async () => {
    const { m, f } = await mk(() => 0.99);
    await m.sayLive("reminder", { task: "Дело" });
    expect(system(f)).not.toContain("Хозяин любит");
  });

  it("важный пропуск и мелочь — без отсылок, даже когда шанс выпал", async () => {
    for (const sit of ["missed_major", "done_minor", "heavy_day"] as const) {
      const { m, f } = await mk(() => 0.1);
      await m.sayLive(sit, {});
      expect(system(f), sit).not.toContain("Хозяин любит");
    }
  });

  it("описание тяжёлого дня есть в запросе: цитата в духе героя, без упрёков, источник не называть", () => {
    const p = buildLinePrompt({ mood: "tired", situation: "heavy_day", level: 2, address: null, hour: 9, weekday: 2, length: "short", interests: [] });
    expect(p).toContain("тяжёлый день");
    expect(p).toContain("источник не называй");
    expect(p).toContain("без упрёков");
  });
});

// ---------- подсказки перевода ----------

describe("подсказки перевода: по умолчанию выключены (ответ Ihor: «не нужны»)", () => {
  it("умолчание в коде и в настройках без записи — выкл; включается только явным hints_on=1", () => {
    expect(STYLE_DEFAULT.hints).toBe(false);
    expect(parseStyle(new Map()).hints).toBe(false);
    expect(parseStyle(new Map([["hints_on", "0"]])).hints).toBe(false);
    expect(parseStyle(new Map([["hints_on", "1"]])).hints).toBe(true);
  });
});

// ---------- реплики на отметки аниме ----------

const KINDS: ReactionKind[] = ["ep", "liked", "dropped", "loved", "meh", "night"];
const linesOf = (kind: ReactionKind): [Angle, string][] => Object.entries(REACTION_LINES[kind]).flatMap(([a, l]) => (l ?? []).map((t) => [a as Angle, t] as [Angle, string]));

describe("реплики Хару на отметки аниме", () => {
  it("прежнее поведение сохранено: rand = 0 даёт первую прежнюю фразу, нейтральный характер молчит", () => {
    expect(haru("ep", "maid", () => 0)).toBe("Принято. Следующую я тоже запомню.");
    expect(haru("liked", "maid", () => 0)).toBe("Рада, что понравилось. Я тоже… нет, не скажу.");
    expect(haru("dropped", "maid", () => 0)).toBe("Понимаю. Не всё стоит времени.");
    expect(haru("ep", "neutral", () => 0)).toBeNull();
    expect(haru("liked", "neutral")).toBeNull();
    // виды без углов работают как раньше
    expect(haru("added", "maid", () => 0)).toBe("Записала. Положила в нужный ящик.");
    expect(haru("weekThanks", "maid", () => 0.99)).toBe("Хорошо. Теперь знаю.");
  });

  it("вариантов много: за 600 нажатий «понравилось» и «бросил» — десятки разных фраз, и все углы звучат", () => {
    for (const kind of ["ep", "liked", "dropped"] as const) {
      const rand = prng(kind.length * 31);
      const heard = new Map<string, number>();
      for (let i = 0; i < 600; i++) {
        const t = haru(kind, "maid", rand)!;
        heard.set(t, (heard.get(t) ?? 0) + 1);
      }
      const all = new Set<string>(linesOf(kind).map(([, t]) => t));
      expect(heard.size, kind).toBeGreaterThanOrEqual(20);
      for (const t of heard.keys()) {
        // всё сказанное — из прежних фраз или из новых; ничего постороннего
        expect(all.has(t) || ["Принято. Следующую я тоже запомню.", "Серия отмечена. Чай остыл, но это ничего.", "Рада, что понравилось. Я тоже… нет, не скажу.", "Записала. У вас хороший вкус, хозяин.", "Понимаю. Не всё стоит времени."].includes(t), `${kind}: ${t}`).toBe(true);
      }
      // ни одна фраза не забивает остальные
      expect(Math.max(...heard.values()) / 600, kind).toBeLessThan(0.15);
    }
  });

  it("углы: подколки за брошенное, «дальше интересно» без спойлера, цитаты героев и сценки есть; цитат больше, чем прежних фраз", () => {
    for (const kind of ["ep", "liked", "dropped"] as const) {
      const angles = Object.keys(REACTION_LINES[kind]);
      expect(angles, kind).toEqual(expect.arrayContaining(["tease", "hint", "quote", "opinion", "scene"]));
      expect(ANGLE_WEIGHT[kind].quote ?? 0, kind).toBeGreaterThanOrEqual(0.16);
    }
    expect(REACTION_LINES.dropped.tease!.length).toBeGreaterThanOrEqual(4);
    expect(ANGLE_WEIGHT.dropped.tease!).toBeGreaterThan(ANGLE_WEIGHT.dropped.plain!);
    // у «понравилось» есть и несогласное мнение: Хару не обязана хвалить
    expect(REACTION_LINES.liked.opinion!.some((t) => /Мне так себе|ниже/.test(t))).toBe(true);
  });

  it("каждый угол с весом имеет фразы, порядок углов — «plain» первым", () => {
    expect(ANGLE_ORDER[0]).toBe("plain");
    for (const kind of KINDS) {
      for (const [angle, w] of Object.entries(ANGLE_WEIGHT[kind]) as [Angle, number][]) {
        if (w > 0 && angle !== "plain") expect(REACTION_LINES[kind][angle]?.length ?? 0, `${kind}.${angle}`).toBeGreaterThan(0);
      }
      for (const angle of Object.keys(REACTION_LINES[kind])) expect(ANGLE_WEIGHT[kind][angle as Angle] ?? 0, `${kind}.${angle} без веса`).toBeGreaterThan(0);
    }
  });

  it("фразы чистые: без цифр, латиницы, эмодзи, угроз, мужского рода о себе, не длиннее 160 знаков, без повторов; названий его тайтлов нет", () => {
    const seen = new Set<string>();
    for (const kind of KINDS) {
      for (const [angle, t] of linesOf(kind)) {
        const at = `${kind}.${angle}: ${t}`;
        // «аниме», «время» и «три предложения» тут нормальны (это реплики про аниме, не пул настроений)
        const bad = lintPhrase(t, "tired", "reminder").filter((i) => i.severity === "error" && !["jp-word"].includes(i.code));
        expect(bad.map((i) => i.code), at).toEqual([]);
        expect(hasMasculineSelf(t), at).toBe(false);
        expect(t.length, at).toBeLessThanOrEqual(160);
        expect(t, at).not.toMatch(/Фрирен|Наруто|Блич|Евангелион|Класс превосходства|\bMAL\b/u);
        const k = t.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
        expect(seen.has(k), `повтор: ${at}`).toBe(false);
        seen.add(k);
      }
    }
    expect(seen.size).toBeGreaterThan(120);
  });

  it("pickReaction: без углов — прежний выбор; пустой пул — null; rand на краях не выходит за списки", () => {
    expect(pickReaction("list", ["а", "б", "в"], () => 0)).toBe("а");
    expect(pickReaction("list", ["а", "б", "в"], () => 0.9999)).toBe("в");
    expect(pickReaction("list", [], () => 0.5)).toBeNull();
    for (const x of [0, 0.3, 0.7, 0.9999999]) for (const kind of KINDS) expect(pickReaction(kind, [], () => x), `${kind} ${x}`).toBeTruthy();
  });

  it("«в восторге» и «не зашло» уже умеют отвечать (подключаются одной строкой в обработчике)", () => {
    for (const kind of ["loved", "meh"] as const) {
      const rand = prng(11);
      const heard = new Set<string>();
      for (let i = 0; i < 200; i++) heard.add(haru(kind, "maid", rand)!);
      expect(heard.size, kind).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("«пора спать» при ночном просмотре", () => {
  it("ночь — с полуночи до пяти утра; вечер, утро и день — нет", () => {
    expect(LATE_NIGHT).toEqual({ from: 0, to: 5 });
    for (const h of [0, 1, 2, 3, 4]) expect(isLateNight(h), String(h)).toBe(true);
    for (const h of [5, 6, 12, 18, 22, 23]) expect(isLateNight(h), String(h)).toBe(false);
  });

  it("на ночную отметку серии — шутка про сон (в шесть из восьми случаев и чаще); днём и без часа — обычная реплика", () => {
    const night = new Set(linesOf("night").map(([, t]) => t));
    expect(night.size).toBeGreaterThanOrEqual(12);
    // первый rand() — «звучит ли ночная шутка», дальше обычный выбор
    const seq = (...xs: number[]) => {
      let i = 0;
      return () => xs[Math.min(i++, xs.length - 1)];
    };
    expect(night.has(haru("ep", "maid", seq(0.1, 0.5, 0.5), 2)!)).toBe(true);
    expect(night.has(haru("ep", "maid", seq(0.1, 0.5, 0.5), 0)!)).toBe(true);
    expect(night.has(haru("ep", "maid", seq(NIGHT_LINE_CHANCE + 0.05, 0.5, 0.5), 2)!)).toBe(false); // ночью, но шанс не выпал
    expect(night.has(haru("ep", "maid", seq(0.1, 0.5, 0.5), 14)!)).toBe(false); // днём
    expect(night.has(haru("ep", "maid", seq(0.1, 0.5, 0.5), 5)!)).toBe(false); // пять утра уже не ночь
    expect(night.has(haru("ep", "maid", seq(0.1, 0.5, 0.5))!)).toBe(false); // час не передали (старые вызовы)
    expect(haru("ep", "neutral", () => 0.1, 2)).toBeNull(); // нейтральный характер молчит и ночью
    // ночью «пора спать» только к отметке серии: понравилось и бросил отвечают как днём
    expect(night.has(haru("liked", "maid", () => 0.1, 2)!)).toBe(false);
  });

  it("ночные шутки с юмором: слово «спать» или «сон» звучит в большинстве", () => {
    const list = linesOf("night").map(([, t]) => t);
    expect(list.filter((t) => /спать|сон|сна|снов|подушк|выспа|кроват/iu.test(t)).length / list.length).toBeGreaterThan(0.7);
  });
});

// ---------- тяжёлый день ----------

describe("тяжёлый день: подбодрить цитатой", () => {
  it("условия: висит три и больше, или в списке двенадцать и больше, или пропуски подряд три и больше", () => {
    expect(HEAVY).toEqual({ hot: 3, open: 12, miss: 3 });
    expect(isHeavyDay({ open: 5, hot: 2, missStreak: 0 })).toBe(false);
    expect(isHeavyDay({ open: 5, hot: 3, missStreak: 0 })).toBe(true);
    expect(isHeavyDay({ open: 12, missStreak: 0 })).toBe(true);
    expect(isHeavyDay({ open: 11, missStreak: 2 })).toBe(false);
    expect(isHeavyDay({ open: 0, missStreak: 3 })).toBe(true);
  });

  it("не чаще раза в три суток; память живёт в style_data и переживает запись", () => {
    const st = emptyStyleState();
    expect(heavyReady(st, 20000)).toBe(true);
    const marked = markHeavy(st, 20000);
    expect(heavyReady(marked, 20000)).toBe(false);
    expect(heavyReady(marked, 20000 + HEAVY_GAP_DAYS - 1)).toBe(false);
    expect(heavyReady(marked, 20000 + HEAVY_GAP_DAYS)).toBe(true);
    expect(parseStyleState(JSON.stringify(marked)).ac?.hd).toBe(20000);
    expect(parseStyleState(JSON.stringify({ n: 0, words: {}, ac: { hd: "мусор" } })).ac).toBeUndefined();
  });

  it("новая ситуация зарегистрирована, у голосов есть фразы, яндере остаётся на пропусках", () => {
    expect(SITUATIONS).toContain("heavy_day");
    expect(FALLBACK_SITUATION.heavy_day).toBe("summary_morning");
    expect(ADDITION_GROUPS.taste).toBeTruthy();
    for (const v of ["tired", "tsundere", "proud", "sleepy", "sulking", "playful", "prim", "bright"]) expect(PHRASES[v].heavy_day?.length ?? 0, v).toBeGreaterThanOrEqual(6);
    expect(PHRASES.yandere.heavy_day).toBeUndefined();
  });
});

describe("тяжёлый день в сводке", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: {} });
  });
  const heavyPool = new Set(Object.values(PHRASES).flatMap((s) => s.heavy_day ?? []));
  const mk = async (rand: () => number, now = NOW) => {
    const s = await w.settings();
    // уровень 0: без вставок аниме-слоя, чтобы текст совпадал с фразой из пула
    const m = new MoodSession({ repo: w.repo(), userId: OWNER, ctx: makeCtx(now, s), rand, style: { ...STYLE_DEFAULT, level: 0 }, live: null });
    await m.load();
    return m;
  };
  const wall = { y: 2026, mo: 6, d: 3 };

  it("утром, когда висит три дела: реплика из heavy_day, и сутки запоминаются", async () => {
    const m = await mk(() => 0);
    const line = await summaryLine(m, { kind: "morning", open: 5, wall, birthday: null, hot: 3 });
    expect(line && heavyPool.has(line), String(line)).toBe(true);
    expect(m.styleState.ac?.hd).toBe(m.dayNum);
  });

  it("в тот же день второй раз — обычная сводка без цитаты; через три суток — снова цитата", async () => {
    const m = await mk(() => 0);
    await summaryLine(m, { kind: "morning", open: 5, wall, birthday: null, hot: 3 });
    const again = await summaryLine(m, { kind: "evening", open: 14, wall, birthday: null });
    expect(again === null || !heavyPool.has(again)).toBe(true);
    const later = await mk(() => 0, NOW + 3 * 86_400_000 + MINUTE);
    later.styleState = m.styleState;
    const next = await summaryLine(later, { kind: "morning", open: 5, wall, birthday: null, hot: 4 });
    expect(next && heavyPool.has(next), String(next)).toBe(true);
  });

  it("не тяжёлый день, недельная сводка и «тихий день» — цитаты нет", async () => {
    const calm = await mk(() => 0);
    const l1 = await summaryLine(calm, { kind: "morning", open: 5, wall, birthday: null, hot: 2 });
    expect(l1 === null || !heavyPool.has(l1)).toBe(true);
    expect(calm.styleState.ac?.hd).toBeUndefined();

    const weekly = await mk(() => 0);
    const l2 = await summaryLine(weekly, { kind: "weekly", open: 20, done: 1, wall, birthday: null, hot: 9 });
    expect(l2 === null || !heavyPool.has(l2)).toBe(true);

    const quiet = await mk(() => 0);
    quiet.silent = true;
    expect(await summaryLine(quiet, { kind: "morning", open: 20, wall, birthday: null, hot: 9 })).toBeNull();
    expect(quiet.styleState.ac?.hd).toBeUndefined();
  });

  it("праздник главнее подбадривания: в Новый год цитата не перебивает поздравление", async () => {
    const m = await mk(() => 0);
    const line = await summaryLine(m, { kind: "morning", open: 5, wall: { y: 2026, mo: 1, d: 1 }, birthday: null, hot: 5 });
    expect(line && heavyPool.has(line)).toBe(false);
  });
});
