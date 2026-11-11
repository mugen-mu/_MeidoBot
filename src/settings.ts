// Настройки пользователя (таблица settings) и служебные значения (meta). Значения по умолчанию — только стартовые.
import { type Character, parseCharacter } from "./flavor.ts";
import { type StyleConfig, parseStyle } from "./personality/animeStyle.ts";
import { type MonthDay, parseBirthday } from "./personality/occasions.ts";
import { DEFAULT_SPEC, type LadderSpec, parseSpec } from "./ladder.ts";
import { DEFAULT_TZ, parseHHMM } from "./time/tz.ts";
import { parseWaterWords } from "./water.ts";

export interface AppSettings {
  tz: string;
  defaultLadder: LadderSpec;
  /** время для дел «на дату без часа», минуты от полуночи */
  defaultTime: number;
  quietEnabled: boolean;
  quietFrom: number;
  quietTo: number;
  /** «я в отъезде» до этого момента (UTC, мс) или 0 */
  awayUntil: number;
  /** время сводок, минуты от полуночи; null = выключена */
  morning: number | null;
  evening: number | null;
  /** недельная уборка: день недели 1..7 и время; null = выключена */
  weekly: { dow: number; at: number } | null;
  chRemind: string | null;
  chBot: string | null;
  chToday: string | null;
  chForum: string | null;
  chArchive: string | null;
  /** каналы, откуда бот читает обычный текст (канал «бот», при необходимости личка) */
  intake: string[];
  /** группа отключений света для сводок («3» или «3.1») или null — не показывать */
  lightGroup: string | null;
  /** слова места для отключений воды (район без окончания, улица); пусто — не следить */
  waterWords: string[];
  /** слова адреса для графика газа (улица, при желании дом через пробел); пусто — не следить */
  gasWords: string[];
  /** характер бота: нейтральный (по умолчанию) или «уставшая горничная» */
  character: Character;
  /** настроение горничной («Характер 2»): вкл по умолчанию (решение пользователя 2026-11-08; раньше было выкл) */
  moodOn: boolean;
  /** аниме-слой («Характер 2», Х2): уровень, письменность, манга-звуки, подсказки перевода */
  style: StyleConfig;
  /** языковая модель понимает фразы, которые обычный разбор не понял (шаг 1): выкл по умолчанию */
  llmOn: boolean;
  /** живые реплики Хару через модель (этап 2 «Характер»): вкл по умолчанию; без модели или при сбое — готовые фразы */
  liveOn: boolean;
  /** день рождения хозяина (месяц.день) или null; интерфейса пока нет — заготовка */
  birthday: MonthDay | null;
  /** что значит «утром» в фразах и быстрых вариантах, минуты от полуночи (решение пользователя 2026-11-10, C4); по умолчанию — `defaultTime` */
  wordMorning: number;
  /** что значит «вечером», минуты от полуночи (C4); по умолчанию 19:00 */
  wordEvening: number;
  /** «Добавить» показывает три последних дела кнопками (C5); выкл по умолчанию */
  recentOn: boolean;
  /** сообщения бота в канал — со звуком (упоминание хозяина), не только настоящие напоминания (D7); выкл по умолчанию */
  soundAll: boolean;
  /** бот сам заводит дела-сопровождение (копия базы, зависимости, модели, ключи; этап 4); вкл по умолчанию */
  choresOn: boolean;
}

/** Ключ меты с копией каналов до включения «Личка» (по нему выключение возвращает всё как было). */
export const DM_BACKUP_KEY = "dm_backup";

/**
 * «Личка» (решение 2026-11-11, DECISIONS): напоминания, сводки, панель «Горит» и ввод дел идут в личный чат с ботом.
 * Включена, когда канал напоминаний — это и есть личка; одна лишь запись дел в личке (прежний режим) — не «Личка».
 */
export function dmAllOn(s: Pick<AppSettings, "chRemind">, meta: Map<string, string>): boolean {
  const dm = meta.get("dm_channel_id");
  return !!dm && s.chRemind === dm;
}

export const SETTING_KEYS = [
  "tz", "default_ladder", "default_time", "quiet_enabled", "quiet_from", "quiet_to", "away_until",
  "summary_morning", "summary_evening", "weekly", "ch_remind", "ch_bot", "ch_today", "ch_forum", "ch_archive", "intake", "light", "water", "gas", "character", "mood_on",
  "style_level", "style_script", "style_sfx", "style_honorifics", "style_kaomoji", "hints_on", "llm_on", "live_on", "birthday",
  "time_morning", "time_evening", "recent_on", "sound_all", "chores",
] as const;

function minutes(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined) return fallback;
  if (v === "off" || v === "") return null;
  return parseHHMM(v) ?? fallback;
}

export function readSettings(rows: { key: string; value: string }[]): AppSettings {
  const m = new Map(rows.map((r) => [r.key, r.value]));
  let weekly: AppSettings["weekly"] = { dow: 7, at: 19 * 60 };
  const w = m.get("weekly");
  if (w === "off") weekly = null;
  else if (w) {
    const [d, t] = w.split("@");
    const at = parseHHMM(t ?? "");
    if (Number(d) >= 1 && Number(d) <= 7 && at !== null) weekly = { dow: Number(d), at };
  }
  let intake: string[] = [];
  try {
    const v = JSON.parse(m.get("intake") ?? "[]");
    if (Array.isArray(v)) intake = v.map(String);
  } catch {
    /* повреждено: пусто */
  }
  return {
    tz: m.get("tz") || DEFAULT_TZ,
    defaultLadder: parseSpec(m.get("default_ladder")) ?? DEFAULT_SPEC,
    defaultTime: minutes(m.get("default_time"), 9 * 60) ?? 9 * 60,
    quietEnabled: m.get("quiet_enabled") === "1",
    quietFrom: minutes(m.get("quiet_from"), 23 * 60) ?? 23 * 60,
    quietTo: minutes(m.get("quiet_to"), 7 * 60) ?? 7 * 60,
    awayUntil: Number(m.get("away_until") ?? 0) || 0,
    morning: minutes(m.get("summary_morning"), 8 * 60),
    evening: minutes(m.get("summary_evening"), 20 * 60),
    weekly,
    chRemind: m.get("ch_remind") || null,
    chBot: m.get("ch_bot") || null,
    chToday: m.get("ch_today") || null,
    chForum: m.get("ch_forum") || null,
    chArchive: m.get("ch_archive") || null,
    intake,
    lightGroup: m.get("light") && m.get("light") !== "off" ? (m.get("light") as string) : null,
    waterWords: m.get("water") && m.get("water") !== "off" ? parseWaterWords(m.get("water") as string) : [],
    gasWords: m.get("gas") && m.get("gas") !== "off" ? parseWaterWords(m.get("gas") as string) : [],
    character: parseCharacter(m.get("character")),
    moodOn: m.get("mood_on") !== "0",
    style: parseStyle(m),
    llmOn: m.get("llm_on") === "1",
    liveOn: m.get("live_on") !== "0",
    birthday: parseBirthday(m.get("birthday")),
    wordMorning: minutes(m.get("time_morning") || undefined, null) ?? (minutes(m.get("default_time"), 9 * 60) ?? 9 * 60),
    wordEvening: minutes(m.get("time_evening") || undefined, null) ?? 19 * 60,
    recentOn: m.get("recent_on") === "1",
    soundAll: m.get("sound_all") === "1",
    choresOn: m.get("chores") !== "0",
  };
}

/** Настройки времени для разбора фраз: одни и те же «утро» и «вечер» везде, где бот читает время. */
export function timeOpts(s: AppSettings): { tz: string; defaultTime: number; morningTime: number; eveningTime: number } {
  return { tz: s.tz, defaultTime: s.defaultTime, morningTime: s.wordMorning, eveningTime: s.wordEvening };
}

/** В тихих часах ли момент ms (окно может переходить через полночь, например 23:00–07:00). */
export function inQuietHours(s: AppSettings, minuteOfDay: number): boolean {
  if (!s.quietEnabled || s.quietFrom === s.quietTo) return false;
  return s.quietFrom < s.quietTo
    ? minuteOfDay >= s.quietFrom && minuteOfDay < s.quietTo
    : minuteOfDay >= s.quietFrom || minuteOfDay < s.quietTo;
}
