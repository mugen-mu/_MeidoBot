// Аниме-слой (Х2): рендер на всех уровнях и письменностях, лимиты, паузы, подсказки перевода, Markdown, суть по-русски.
import { describe, expect, it } from "vitest";
import {
  STYLE_DEFAULT,
  STYLE_LIMITS,
  type StyleConfig,
  type StyleState,
  emptyStyleState,
  escapeMd,
  glossaryEntries,
  parseStyle,
  parseStyleState,
  removeAddress,
  renderStyled,
  styleToSettings,
} from "../src/personality/animeStyle.ts";
import { KAOMOJI, SFX, WORDS } from "../src/personality/lexicon.ts";
import { MOODS, type Mood } from "../src/personality/moodEngine.ts";
import { PHRASES, SITUATIONS } from "../src/personality/phrases.ts";
import { fill } from "../src/personality/speech.ts";

const style = (over: Partial<StyleConfig> = {}): StyleConfig => ({ ...STYLE_DEFAULT, ...over });
/** предсказуемая «случайность»: циклический ряд */
const seq = (...v: number[]) => {
  let i = 0;
  return () => v[i++ % v.length];
};
/** простая псевдослучайность с зерном (для прогонов по многим семенам) */
const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const JP = [...WORDS.flatMap((w) => [w.cyrillic, w.latin]), ...Object.values(SFX).flatMap((s) => [s.kana, s.cyrillic])];
const KANA = /[぀-ヿｦ-ﾟ]/u;
const TEMPLATE = "{user}, напоминание про «{task}». Не забудьте.";
const render = (a: Partial<Parameters<typeof renderStyled>[0]> & { style?: StyleConfig } = {}) =>
  renderStyled({ template: TEMPLATE, mood: "tired", situation: "reminder", style: style(), state: emptyStyleState(), rand: seq(0.1), vars: { task: "Созвон в 15:00" }, ...a });

describe("аниме-слой: уровни и письменность", () => {
  it("уровень 0: на всех фразах пула нет ни японского слова, ни каны, ни каомодзи; текст = обычная подстановка", () => {
    for (const mood of MOODS)
      for (const sit of SITUATIONS)
        for (const t of PHRASES[mood]?.[sit] ?? []) {
          const r = renderStyled({ template: t, mood, situation: sit, style: style({ level: 0 }), state: emptyStyleState(), rand: seq(0, 0.5, 0.99), vars: { task: "Дело" } });
          expect(r.text, `${mood}.${sit}`).toBe(fill(t, { task: "Дело" }));
          expect(r.used).toEqual([]);
        }
  });

  it("уровень 0: токены словаря заменяются русскими эквивалентами", () => {
    const r = render({ template: "{ara_ara} {yare_yare}, {honorific}. {sigh}", style: style({ level: 0 }) });
    expect(r.text).toBe("Ой-ой ну и ну, хозяин. *вздох*");
    for (const w of JP) expect(r.text.toLowerCase()).not.toContain(w.toLowerCase());
  });

  it("одна фраза корректно рендерится на всех 4 уровнях и всех 3 письменностях, без «{}» и с задачей", () => {
    for (const level of [0, 1, 2, 3] as const)
      for (const script of ["cyrillic", "latin", "mixed"] as const)
        for (const mood of MOODS) {
          const r = render({ mood, style: style({ level, script, kaomoji: "on" }), rand: lcg(level * 100 + MOODS.indexOf(mood) + 7) });
          expect(r.text, `${level}/${script}/${mood}`).not.toMatch(/[{}]/);
          expect(r.text).toContain("«Созвон в 15:00»");
        }
  });

  it("уровень 1: ровно одно японское слово, без суффиксов, манга-звуков и каомодзи", () => {
    for (let seed = 1; seed < 60; seed++)
      for (const mood of MOODS) {
        const r = render({ mood, style: style({ level: 1 }), rand: lcg(seed) });
        expect(r.used.length, `${mood}#${seed}`).toBeLessThanOrEqual(1);
        expect(r.text).not.toMatch(KANA);
        expect(r.text).not.toContain("\n");
        expect(r.text).not.toContain("-сама");
      }
  });

  it("латиница: слова пишутся латиницей, кана остаётся только в манга-звуке", () => {
    const r = render({ template: "{ara_ara} Пора.", style: style({ script: "latin", hints: false }) });
    expect(r.text).toContain("Ara ara");
    expect(r.text).not.toContain("ара-ара");
  });
});

describe("аниме-слой: лимиты и паузы", () => {
  it("не больше двух японских слов, одного манга-звука и одного каомодзи на сообщение", () => {
    const kao = Object.values(KAOMOJI).map(escapeMd);
    for (let seed = 1; seed < 200; seed++)
      for (const mood of MOODS)
        for (const sit of ["reminder", "missed", "done", "return_after_pause", "greeting"] as const) {
          const r = render({ mood, situation: sit, style: style({ level: 3, kaomoji: "on" }), rand: lcg(seed) });
          expect(r.used.length, `${mood}.${sit}#${seed}`).toBeLessThanOrEqual(STYLE_LIMITS.maxInterjections);
          expect(r.text.split("\n").length).toBeLessThanOrEqual(2);
          expect(kao.filter((k) => r.text.includes(k)).length).toBeLessThanOrEqual(1);
        }
  });

  it("явные токены тоже считаются в лимит: третье слово становится русским", () => {
    const r = render({ template: "{ara_ara} {yare_yare} {mendokusai} Пора.", style: style({ hints: false }) });
    expect(r.used).toEqual(["ara_ara", "yare_yare"]);
    expect(r.text).toContain("как же лень");
  });

  it("одно и то же слово — не чаще раза в 5 сообщений", () => {
    let state: StyleState = emptyStyleState();
    const last: Record<string, number> = {};
    for (let n = 1; n <= 80; n++) {
      const r = render({ state, mood: MOODS[n % MOODS.length] as Mood, situation: n % 3 ? "reminder" : "done", rand: lcg(n * 31), style: style({ level: 3 }) });
      for (const id of r.used) {
        if (last[id] !== undefined) expect(n - last[id], `${id} на сообщении ${n}`).toBeGreaterThanOrEqual(STYLE_LIMITS.wordCooldown);
        last[id] = n;
      }
      state = r.state;
    }
    expect(Object.keys(last).length).toBeGreaterThan(5);
  });
});

describe("аниме-слой: подсказки перевода", () => {
  it("перевод в скобках — ровно первые 2 раза, потом слово «выучено»", () => {
    let state = emptyStyleState();
    const outs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = render({ template: "{yare_yare} Пора за делом.", state, rand: seq(0.99) });
      outs.push(r.text);
      state = r.state;
    }
    expect(outs.map((t) => t.includes("(ну и ну)"))).toEqual([true, true, false, false]);
  });

  it("/hints off: перевода нет совсем", () => {
    expect(render({ template: "{yare_yare} Пора.", style: style({ hints: false }) }).text).not.toContain("(");
  });

  it("слова копятся в словаре: сколько раз и в каком порядке", () => {
    let state = emptyStyleState();
    for (let i = 0; i < 3; i++) state = render({ template: "{yare_yare} {ara_ara} Пора.", state, rand: seq(0.99) }).state;
    state = render({ template: "{mou} Пора.", state, mood: "tsundere", rand: seq(0.99) }).state;
    const g = glossaryEntries(state);
    expect(g.map((e) => [e.id, e.uses])).toEqual([["ara_ara", 3], ["yare_yare", 3], ["mou", 1]]);
    expect(g[0].meaning).toBeTruthy();
  });
});

describe("аниме-слой: манера, обращение, звуки", () => {
  it("обращение по настроению (уровень 2): yandere «Госюдзин-сама~», без лишней запятой после тильды", () => {
    const r = render({ mood: "yandere", style: style({ hints: false }), rand: seq(0.99, 0.99, 0.99, 0.1, 0.99) });
    expect(r.text).toContain("Госюдзин-сама~ напоминание");
    expect(r.text).not.toContain("~,");
  });

  it("tsundere заикается на обращении («Х-хозяин»), а в середине фразы обращение обычное", () => {
    expect(render({ mood: "tsundere", style: style({ hints: false }), rand: seq(0.99, 0.99, 0.1, 0.1, 0.1, 0.99) }).text).toContain("Х-хозяин, напоминание");
    const mid = render({ template: "Вы лучший {user} во всём мире.", mood: "tsundere", style: style({ hints: false }), rand: seq(0.99, 0.99, 0.1, 0.1, 0.1, 0.99) });
    expect(mid.text).toContain("лучший хозяин");
  });

  it("sulking не называет по имени вовсе, а при выключенных обращениях и на уровне 1 — обычное «хозяин»", () => {
    const r = render({ mood: "sulking", rand: seq(0.99) });
    expect(r.text).not.toMatch(/хозяин|госюдзин/iu);
    expect(r.text).toContain("Напоминание про «Созвон в 15:00»");
    expect(render({ mood: "yandere", style: style({ honorifics: false }), rand: seq(0.99) }).text).toContain("Хозяин, напоминание");
    expect(render({ mood: "yandere", style: style({ level: 1 }), rand: seq(0.99) }).text).not.toMatch(/госюдзин/iu);
  });

  it("removeAddress аккуратно убирает обращение", () => {
    expect(removeAddress("{user}, пора за делом.")).toBe("Пора за делом.");
    expect(removeAddress("Пора за делом, {user}.")).toBe("Пора за делом.");
    expect(removeAddress("Ну что ж. {user}... идите.")).toBe("Ну что ж. Идите.");
    expect(removeAddress("Без обращения.")).toBe("Без обращения.");
  });

  it("манга-звук идёт отдельной строкой; {sfx:id} в тексте форсирует его, на уровне 1 и при sfx=off его нет", () => {
    const forced = render({ template: "Пора. {sfx:menace}", mood: "yandere", rand: seq(0.99) });
    expect(forced.text.split("\n")[1]).toBe(SFX.menace.kana);
    expect(render({ template: "Пора. {sfx:menace}", mood: "yandere", style: style({ sfx: "cyrillic" }), rand: seq(0.99) }).text).toContain("\nгогого…");
    expect(render({ template: "Пора. {sfx:menace}", style: style({ sfx: "off" }) }).text).not.toContain("\n");
    expect(render({ template: "Пора. {sfx:menace}", style: style({ level: 1 }) }).text).not.toContain("\n");
  });

  it("шёпот цундере в спойлере на уровне 3 и без японских слов", () => {
    const r = render({ template: "Пропущено. {whisper:ну я же просила}", mood: "tsundere", style: style({ level: 3 }), rand: seq(0.99) });
    expect(r.text).toContain("||ну я же просила||");
    expect(render({ template: "{whisper:тише}", style: style({ level: 2 }) }).text).toContain("(тихо: тише)");
  });

  it("каомодзи: уровень 3 или «вкл», с экранированием Markdown", () => {
    const on = render({ mood: "tired", style: style({ level: 3, kaomoji: "auto" }), rand: seq(0.1) }).text;
    expect(on).toContain("(－\\_－;)");
    expect(render({ mood: "tired", style: style({ level: 2, kaomoji: "auto" }), rand: seq(0.1) }).text).not.toContain("(－");
    expect(render({ mood: "tired", style: style({ level: 2, kaomoji: "on" }), rand: seq(0.1) }).text).toContain("(－");
    expect(render({ mood: "tired", style: style({ level: 3, kaomoji: "off" }), rand: seq(0.1) }).text).not.toContain("(－");
  });

  it("escapeMd экранирует _ * ~ \\ | и обратная операция даёт исходное каомодзи", () => {
    for (const k of Object.values(KAOMOJI)) {
      const e = escapeMd(k);
      expect(e.replace(/\\([\\_*~`|])/g, "$1")).toBe(k);
      expect(e.replace(/\\[\\_*~`|]/g, "")).not.toMatch(/[_*~`|]/);
    }
  });

  it("неизвестный токен пропадает, предложение не ломается; {stutter:…} на уровне 1 без заикания", () => {
    expect(render({ template: "Пора {no_such} идти.", style: style({ level: 0 }) }).text).toBe("Пора идти.");
    expect(render({ template: "{stutter:х-хозяин}, пора.", style: style({ level: 1, hints: false }), rand: seq(0.99) }).text).toContain("хозяин, пора");
  });
});

describe("аниме-слой: суть по-русски и серьёзное", () => {
  it("время и название дела проходят нетронутыми на любом уровне и настроении", () => {
    for (const level of [0, 1, 2, 3] as const)
      for (const mood of MOODS)
        for (let seed = 1; seed < 40; seed++) {
          const r = renderStyled({
            template: "Напоминаю про «{task}» — срок 15:00.",
            mood,
            situation: "reminder",
            style: style({ level, kaomoji: "on" }),
            state: emptyStyleState(),
            rand: lcg(seed),
            vars: { task: "Отчёт по щиту ЩР-2" },
          });
          expect(r.text).toContain("«Отчёт по щиту ЩР-2» — срок 15:00");
        }
  });
});

describe("аниме-слой: настройки и состояние", () => {
  it("parseStyle: умолчания ТЗ, чтение и круговая проверка со styleToSettings", () => {
    expect(parseStyle(new Map())).toEqual(STYLE_DEFAULT);
    const s = style({ level: 3, script: "mixed", sfx: "cyrillic", honorifics: false, kaomoji: "off", hints: false });
    expect(parseStyle(styleToSettings(s))).toEqual(s);
    expect(parseStyle(new Map([["style_level", "9"], ["style_script", "greek"]]))).toEqual(STYLE_DEFAULT);
  });

  it("parseStyleState переживает мусор и чужие слова", () => {
    expect(parseStyleState("не json")).toEqual(emptyStyleState());
    expect(parseStyleState(JSON.stringify({ n: 4, words: { ara_ara: { u: 2, l: 3 }, чужое: { u: 1, l: 1 } } }))).toEqual({ n: 4, words: { ara_ara: { u: 2, l: 3 } } });
  });
});
