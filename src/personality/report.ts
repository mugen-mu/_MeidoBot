// Текст команды /mood: настроение, отношение и серии простыми словами (с шуткой про отношение, как просит ТЗ).
import { MOOD_CONFIG, type MoodConfig } from "./config.ts";
import { type DayVoice } from "./day.ts";
import { MOOD_LABELS, type MoodState, affectionLabel, irritationLabel } from "./moodEngine.ts";
import { PERSONA_LABELS, isPersona } from "./persona.ts";

const DAY_VOICE_LABELS = { tired: "обычная, усталая", tsundere: "ворчливая", proud: "мягкая" } as const;

export function moodReport(a: {
  state: MoodState;
  enabled: boolean;
  greeting?: string | null;
  cfg?: MoodConfig;
  /** «тихий день» идёт до этого времени (уже в виде текста) */
  quietUntil?: string | null;
  /** образ сегодняшнего дня (day.ts): строка «Образ дня» */
  dayVoice?: DayVoice;
}): string {
  const cfg = a.cfg ?? MOOD_CONFIG;
  const s = a.state;
  const lines = [
    `**${cfg.name}** — сейчас: ${MOOD_LABELS[s.mood]}`,
    `Ваше отношение: ${affectionLabel(s.affection)} (${Math.round(s.affection)}/100)`,
    `Её раздражение: ${irritationLabel(s.irritation)} (${Math.round(s.irritation)}/100)`,
    `Подряд выполнено: ${s.doneStreak}, пропущено: ${s.missStreak}`,
  ];
  if (a.dayVoice) lines.push(`Образ дня: ${isPersona(a.dayVoice) ? PERSONA_LABELS[a.dayVoice] : DAY_VOICE_LABELS[a.dayVoice]}. В спокойные дни она говорит так; после пропусков, ночью и в обиде — по настроению.`);
  if (a.quietUntil) lines.push(`Тихий день: Хару молчит до ${a.quietUntil}. Снять: «хватит тихого дня» в канале «бот».`);
  if (a.greeting) lines.push(`-# ${a.greeting}`);
  if (!a.enabled) lines.push("Настроение выключено: напоминания идут обычным тоном. Включить: /settings → «Настроение».");
  return lines.join("\n");
}
