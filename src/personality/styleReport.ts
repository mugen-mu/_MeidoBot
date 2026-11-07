// Тексты команд /style, /hints, /glossary (аниме-слой, Х2): простыми словами, с живыми примерами.
import { type StyleConfig, type StyleState, emptyStyleState, glossaryEntries, renderStyled } from "./animeStyle.ts";
import { WORDS } from "./lexicon.ts";
import { MOOD_LABELS, type Mood } from "./moodEngine.ts";
import { poolFor } from "./speech.ts";

const LEVEL_TEXT = [
  "0 — обычный русский, без японских слов",
  "1 — лёгкие вставки: одно японское слово в сообщении",
  "2 — фансаб-стиль: слова, обращения («-сама»), редкие манга-звуки",
  "3 — полный отаку: плюс каомодзи, шёпот в спойлере, манга-звуки чаще",
];
const SCRIPT_TEXT = { cyrillic: "кириллица («ара-ара»)", latin: "латиница («ara ara»)", mixed: "вперемешку" };
const SFX_TEXT = { kana: "кана (ゴゴゴゴ)", cyrillic: "кириллица («гогого»)", off: "выкл" };
const KAO_TEXT = { auto: "только на уровне 3", on: "вкл", off: "выкл" };

export const levelText = (n: number): string => LEVEL_TEXT[n] ?? String(n);

/** Одна строка для /settings. */
export function styleSummary(s: StyleConfig): string {
  return `уровень ${s.level}, письмо: ${SCRIPT_TEXT[s.script]}, манга-звуки: ${SFX_TEXT[s.sfx]}, обращения: ${s.honorifics ? "вкл" : "выкл"}, подсказки перевода: ${s.hints ? "вкл" : "выкл"} (/style, /hints, /glossary)`;
}

/** Живые примеры: настоящие фразы из пула, пропущенные через слой с текущими настройками (в базу ничего не пишется). */
export function stylePreview(style: StyleConfig, rand: () => number, moods: Mood[] = ["tired", "tsundere", "yandere"]): string[] {
  const out: string[] = [];
  for (const m of moods) {
    const pool = poolFor(m, "reminder");
    if (!pool.length) continue;
    const template = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    const r = renderStyled({ template, mood: m, situation: "reminder", style, state: emptyStyleState(), vars: { task: "Созвон в 15:00" }, rand });
    out.push(`• ${MOOD_LABELS[m]}: ${r.text.replace(/\n/g, "  ")}`);
  }
  return out;
}

export function styleReport(a: { style: StyleConfig; rand: () => number; changed?: string[] }): string {
  const s = a.style;
  const lines = [
    "**Стиль речи Хару**",
    ...(a.changed?.length ? [`Изменено: ${a.changed.join(", ")}.`] : []),
    `Уровень: ${LEVEL_TEXT[s.level]}`,
    `Письмо: ${SCRIPT_TEXT[s.script]}; манга-звуки: ${SFX_TEXT[s.sfx]}; каомодзи: ${KAO_TEXT[s.kaomoji]}`,
    `Обращения («госюдзин-сама», заикание): ${s.honorifics ? "вкл" : "выкл"}; подсказки перевода в скобках: ${s.hints ? "вкл" : "выкл"}`,
    "",
    "Так это звучит сейчас:",
    ...stylePreview(s, a.rand),
    "",
    "Менять: `/style level:2`, `/style script:latin`, `/style sfx:off`; подсказки — `/hints`; слова — `/glossary`.",
    "Стиль работает только когда включено «Настроение» в /settings; на серьёзных делах (здоровье, горе) и критичных он выключается сам, время и название дела всегда по-русски.",
  ];
  return lines.join("\n");
}

/** /glossary: слова, которые Хару уже говорила, с переводом. */
export function glossaryReport(a: { state: StyleState; style: StyleConfig }): string {
  const list = glossaryEntries(a.state, a.style.script === "latin" ? "latin" : "cyrillic");
  if (!list.length) {
    return "Пока ни одного слова: Хару ещё не вставляла японских слов. Они появятся, когда включено «Настроение» в /settings, а уровень стиля больше 0 (/style).";
  }
  const lines = list.slice(0, 30).map((e) => `• **${e.word}** — ${e.meaning} _(${e.uses} раз)_`);
  return [`**Слова Хару** — открыто ${list.length} из ${WORDS.length}`, ...lines, `-# Перевод в скобках показывается первые 2 раза, потом считается, что слово выучено (/hints off — не показывать совсем).`].join("\n");
}
