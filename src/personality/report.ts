// Текст команды /mood: настроение, отношение и серии простыми словами (с шуткой про отношение, как просит ТЗ).
import { MOOD_CONFIG, type MoodConfig } from "./config.ts";
import { MOOD_LABELS, type MoodState, affectionLabel, irritationLabel } from "./moodEngine.ts";

export function moodReport(a: { state: MoodState; enabled: boolean; greeting?: string | null; cfg?: MoodConfig }): string {
  const cfg = a.cfg ?? MOOD_CONFIG;
  const s = a.state;
  const lines = [
    `**${cfg.name}** — сейчас: ${MOOD_LABELS[s.mood]}`,
    `Ваше отношение: ${affectionLabel(s.affection)} (${Math.round(s.affection)}/100)`,
    `Её раздражение: ${irritationLabel(s.irritation)} (${Math.round(s.irritation)}/100)`,
    `Подряд выполнено: ${s.doneStreak}, пропущено: ${s.missStreak}`,
  ];
  if (a.greeting) lines.push(`-# ${a.greeting}`);
  if (!a.enabled) lines.push("Настроение выключено: напоминания идут обычным тоном. Включить: /settings → «Настроение».");
  return lines.join("\n");
}
