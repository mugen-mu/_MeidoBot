// Внешний вид горничной («Характер 2», этап Х3): цвет карточки по настроению, спрайт-миниатюра, реакции эмодзи.
// Чистая логика без Discord и базы: случайность приходит аргументом, поэтому всё проверяется тестами.
import type { Embed } from "../discord/types.ts";
import { SFX } from "./lexicon.ts";
import type { Mood } from "./moodEngine.ts";

/** Цвет полоски карточки (ТЗ, 5Г): tired — серо-синий, tsundere — оранжевый, yandere — тёмно-красный, sulking — серый, proud — розовый, sleepy — фиолетовый. */
export const MOOD_COLOR: Record<Mood, number> = {
  tired: 0x6b7a99,
  tsundere: 0xf28c28,
  yandere: 0x8b0000,
  sulking: 0x8a8d91,
  proud: 0xf78fb3,
  sleepy: 0x8e6bbf,
};

/** Числа внешнего вида в одном месте (подкручиваются здесь). */
export const LOOK = {
  /** шанс миниатюры-спрайта в обычной реплике горничной (в /mood и в кино-моментах — всегда) */
  spriteChance: 0.12,
  /** шанс реакции эмодзи на обычное сообщение хозяина в канале «бот» (на «спасибо» и «ара-ара» — всегда) */
  reactionChance: 0.25,
  /** сторона квадратной картинки, px (то, что лежит в public/sprites) */
  spriteSize: 160,
};

/** Реакции по настроению: подбираются по смыслу, без значков с модификаторами (чтобы не ломать адрес запроса). */
export const MOOD_REACTIONS: Record<Mood, string[]> = {
  tired: ["😪", "☕"],
  tsundere: ["😤", "💢"],
  yandere: ["💗", "👀"],
  sulking: ["😒", "🙄"],
  proud: ["✨", "💖"],
  sleepy: ["😴", "💤"],
};

/** Адрес спрайта: файлы лежат в public/sprites и раздаются самим Worker (бесплатно). Без адреса Worker — картинки нет, цвет остаётся. */
export function spriteUrl(origin: string | null | undefined, mood: Mood): string | null {
  if (!origin || !/^https:\/\//.test(origin)) return null;
  return `${origin.replace(/\/+$/, "")}/sprites/${mood}.jpg`;
}

const ALL_SFX = new Set(Object.values(SFX).flatMap((s) => [s.kana, s.cyrillic]));

/** Текст реплики для карточки: строка с манга-звуком становится курсивом (мелкий текст «-#» в карточках работает не везде). */
export function embedText(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      const t = l.startsWith("-# ") ? l.slice(3) : l;
      return ALL_SFX.has(t.trim()) ? `*${t.trim()}*` : t;
    })
    .join("\n")
    .slice(0, 4000);
}

/**
 * Карточка горничной: цветная полоска по настроению, реплика, при желании миниатюра-спрайт.
 * Суть напоминания (время, дело) сюда не кладём: она остаётся обычным текстом сообщения.
 */
export function maidEmbed(a: { mood: Mood; text: string; origin?: string | null; sprite?: boolean; title?: string }): Embed {
  const e: Embed = { color: MOOD_COLOR[a.mood], description: embedText(a.text) };
  if (a.title) e.title = a.title;
  const url = a.sprite ? spriteUrl(a.origin, a.mood) : null;
  if (url) e.thumbnail = { url };
  return e;
}

/**
 * Карточка только со спрайтом (одна фраза = одно место, 2026-11-10): сама фраза идёт в тексте сообщения, карточка — цветная полоска с миниатюрой
 * и без текста. Нет спрайта (не выпал шанс или нет адреса картинок) — карточки нет совсем.
 */
export function spriteCard(look: { mood: Mood; origin?: string | null; sprite?: boolean } | null | undefined): Embed[] | undefined {
  if (!look?.sprite) return undefined;
  const url = spriteUrl(look.origin, look.mood);
  return url ? [{ color: MOOD_COLOR[look.mood], thumbnail: { url } }] : undefined;
}

/** Показывать ли спрайт в этот раз: редко (по шансу) или всегда (`always`). */
export const wantSprite = (rand: () => number, always = false): boolean => always || rand() < LOOK.spriteChance;

/** Реакция на сообщение хозяина: эмодзи по настроению или null (не в этот раз). `always` — на «спасибо» и подобное. */
export function pickReaction(mood: Mood, rand: () => number, always = false): string | null {
  if (!always && rand() >= LOOK.reactionChance) return null;
  const list = MOOD_REACTIONS[mood];
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}
