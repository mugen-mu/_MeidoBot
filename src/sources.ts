// «Паспорт источников» (этап 4 ретроспективы 2, A4–A8): когда каждый источник читался и чем кончилось.
// Одна запись в таблице `meta` (`src_passport`): читается вместе со всей метой в начале запуска, пишется вместе с остальным — подзапросов не добавляет.
// Чистая логика без базы и Discord: время «сейчас» приходит аргументом.
import type { LightData } from "./light.ts";
import { groupsFor, hasSchedule, lightLines } from "./light.ts";
import { formatDate, usDate } from "./time/format.ts";
import { fmtHHMM, wallOf } from "./time/tz.ts";

export type SourceId = "light" | "water" | "gas" | "shikimori" | "anilibria" | "animetg" | "weather" | "rain" | "avaria";

export interface SourceInfo {
  id: SourceId;
  /** как называем источник на экране «Состояние» и в итоге недели */
  name: string;
  icon: string;
}

export const SOURCES: SourceInfo[] = [
  { id: "light", name: "Свет (Yasno)", icon: "💡" },
  { id: "avaria", name: "Свет и вода: канал аварийной службы (Telegram)", icon: "⚡" },
  { id: "water", name: "Вода (водоканал)", icon: "💧" },
  { id: "gas", name: "Газ (газовики)", icon: "🔥" },
  { id: "shikimori", name: "Аниме: расписание (Shikimori)", icon: "🎬" },
  { id: "anilibria", name: "Аниме: озвучка (AniLibria)", icon: "🎧" },
  { id: "animetg", name: "Аниме: выходы серий (Telegram-каналы озвучек)", icon: "📣" },
  { id: "weather", name: "Погода", icon: "⛅" },
  { id: "rain", name: "Дождь (Open-Meteo)", icon: "🌧" },
];

/** Сайты чтения по ссылкам (манга и ранобэ, 2026-11-19): отдельный список, чтобы не мешать основным источникам. Строка на «Состоянии» появляется, только когда сайт хоть раз читался. */
export type ReadingSourceId = "rd_senkuro" | "rd_remanga" | "rd_renovels" | "rd_ranobehub";

export const READING_SOURCES: { id: ReadingSourceId; name: string; icon: string }[] = [
  { id: "rd_senkuro", name: "Чтение: Senkuro", icon: "📖" },
  { id: "rd_remanga", name: "Чтение: ReManga", icon: "📖" },
  { id: "rd_renovels", name: "Чтение: ReNovels", icon: "📖" },
  { id: "rd_ranobehub", name: "Чтение: RanobeHub", icon: "📖" },
];

export const META_KEY = "src_passport";

/** Запись об одном источнике: последнее удачное и последнее чтение, неудач подряд, с какого времени неудачи идут. */
export interface SourceRec {
  ok?: number;
  try?: number;
  fails: number;
  since?: number;
  /** сообщение о поломке уже отправлено (только у света; у воды, газа и аниме свои флаги) */
  said?: 1;
}

export type Passport = Partial<Record<SourceId | ReadingSourceId, SourceRec>>;

/** Сколько неудач подряд считаем поломкой (а не разовым сбоем). */
export const BROKEN_FAILS = 3;
/** Свет читается часто и по случаю (сводки, проверки раз в 10 минут): сообщение о поломке — не раньше чем через 2 часа. */
export const LIGHT_NOTICE_AFTER_MS = 2 * 60 * 60_000;

const IDS = new Set<string>([...SOURCES, ...READING_SOURCES].map((s) => s.id));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function parsePassport(raw: string | undefined): Passport {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, Partial<SourceRec> | null>;
    const out: Passport = {};
    for (const [id, r] of Object.entries(v)) {
      if (!IDS.has(id) || !r || typeof r !== "object") continue;
      const rec: SourceRec = { fails: Math.max(0, Math.floor(num(r.fails) ?? 0)) };
      const ok = num(r.ok);
      const tr = num(r.try);
      const since = num(r.since);
      if (ok !== undefined) rec.ok = ok;
      if (tr !== undefined) rec.try = tr;
      if (since !== undefined) rec.since = since;
      if (r.said === 1) rec.said = 1;
      out[id as SourceId | ReadingSourceId] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

/** Записать итог одного чтения. Возвращает новый паспорт, прежний не меняет. */
export function recordSource(p: Passport, id: SourceId | ReadingSourceId, ok: boolean, now: number): Passport {
  const prev = p[id];
  if (ok) return { ...p, [id]: { ok: now, try: now, fails: 0 } };
  const rec: SourceRec = { ...(prev ?? { fails: 0 }), try: now, fails: (prev?.fails ?? 0) + 1 };
  if (rec.since === undefined) rec.since = now;
  return { ...p, [id]: rec };
}

export const markSaid = (p: Passport, id: SourceId): Passport => ({ ...p, [id]: { ...(p[id] ?? { fails: 0 }), said: 1 } });

export const isBroken = (r: SourceRec | undefined): boolean => !!r && r.fails >= BROKEN_FAILS;

export function lightNoticeDue(r: SourceRec | undefined, now: number): boolean {
  return isBroken(r) && !r?.said && now - (r?.since ?? now) >= LIGHT_NOTICE_AFTER_MS;
}

const hhmm = (ms: number, tz: string): string => {
  const w = wallOf(ms, tz);
  return fmtHHMM(w.h * 60 + w.mi);
};

/** «сегодня 08:00», «вчера 20:00», дальше датой «11.01.2026 09:05» (американский порядок, как везде в боте). */
export function whenText(ms: number, now: number, tz: string): string {
  const d = formatDate(ms, now, tz);
  const w = wallOf(ms, tz);
  // formatDate называет день недели для ближайшей недели; для «когда читалось» нужна дата, а не «в среду»
  const word = d === "сегодня" || d === "вчера" || d === "завтра" ? d : usDate(w.y, w.mo, w.d);
  return `${word} ${hhmm(ms, tz)}`;
}

/** Пометка к устаревшим данным: «данные от вчера 20:00». */
export const staleStamp = (at: number, now: number, tz: string): string => `данные от ${whenText(at, now, tz)}`;

export type Enabled = Partial<Record<SourceId, boolean>>;

/** Экран «Состояние»: по строке на источник, простыми словами. */
export function statusText(p: Passport, enabled: Enabled, now: number, tz: string): string {
  const lines = SOURCES.map((s) => {
    if (s.id === "weather") return `${s.icon} ${s.name} — пока не подключена.`;
    if (enabled[s.id] === false) return `${s.icon} ${s.name} — выключено в настройках.`;
    const r = p[s.id];
    if (!r || r.try === undefined) return `${s.icon} ${s.name} — ещё не читалось.`;
    const last = r.ok !== undefined ? `читалось ${whenText(r.ok, now, tz)}` : "ни разу не прочиталось";
    if (isBroken(r)) return `${s.icon} ${s.name} — не отвечает с ${whenText(r.since ?? r.try, now, tz)} (неудач подряд: ${r.fails}); ${last}.`;
    if (r.fails > 0) return `${s.icon} ${s.name} — был сбой (${r.fails}), пробую снова; ${last}.`;
    return `${s.icon} ${s.name} — ${last}, всё в порядке.`;
  });
  // сайты чтения по ссылкам: строка только у тех, что хоть раз читались (ссылок нет — и строки нет)
  const reading = READING_SOURCES.filter((s) => p[s.id]?.try !== undefined).map((s) => {
    const r = p[s.id] as SourceRec;
    const last = r.ok !== undefined ? `читалось ${whenText(r.ok, now, tz)}` : "ни разу не прочиталось";
    if (isBroken(r)) return `${s.icon} ${s.name} — не отвечает с ${whenText(r.since ?? r.try ?? now, now, tz)} (неудач подряд: ${r.fails}); ${last}.`;
    if (r.fails > 0) return `${s.icon} ${s.name} — был сбой (${r.fails}), пробую снова; ${last}.`;
    return `${s.icon} ${s.name} — ${last}, всё в порядке.`;
  });
  return ["**Состояние**", "Когда бот последний раз читал каждый источник:", ...lines, ...reading].join("\n");
}

/** Строки для итога недели: только сломанные и только включённые. */
export function weekSourceLines(p: Passport, now: number, tz: string, enabled: Enabled): string[] {
  const out: string[] = [];
  for (const s of SOURCES) {
    const r = p[s.id];
    // дождь о сбое в чат не пишет (просьба владельца): сбой виден только на экране «Состояние»
    if (s.id === "weather" || s.id === "rain" || enabled[s.id] === false || !isBroken(r)) continue;
    const ok = r?.ok !== undefined ? staleStamp(r.ok, now, tz) : "данных пока нет";
    out.push(`${s.icon} ${s.name}: не отвечает с ${whenText(r?.since ?? r?.try ?? now, now, tz)}, ${ok}.`);
  }
  return out;
}

// ---------- свет: последнее известное ----------

export interface LightLast {
  at: number;
  data: LightData;
}

export function parseLightLast(raw: string | undefined): LightLast | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LightLast>;
    return typeof v.at === "number" && v.data && typeof v.data === "object" ? { at: v.at, data: v.data } : null;
  } catch {
    return null;
  }
}

/** Что запомнить после удачного чтения: только группа хозяина (мало байт). */
export function lightLastOf(data: LightData, group: string, now: number): LightLast {
  const keep: LightData = {};
  for (const g of groupsFor(group, data)) keep[g] = data[g];
  return { at: now, data: keep };
}

/**
 * Строки света из запомненных данных на нужную дату — или null, если запомненное этой даты не знает
 * (вчера вечером «завтра» — это сегодняшнее «сегодня»: переносим день на своё место).
 */
export function lastKnownLightLines(last: LightLast | null, which: "today" | "tomorrow", group: string, date: string): string[] | null {
  if (!last) return null;
  const view: LightData = {};
  for (const g of groupsFor(group, last.data)) {
    const days = [last.data[g].today, last.data[g].tomorrow];
    const day = days.find((d) => d.date === date && hasSchedule(d));
    if (day) view[g] = { today: day, tomorrow: day };
  }
  if (!Object.keys(view).length) return null;
  return lightLines(which, group, view, date);
}

// ---------- закреплённый текст ----------

/** Текст для закрепа в канале «бот» (A8): что делать, если бот молчит. Без секретов и без рабочего. */
export const SILENT_BOT_TEXT = [
  "📌 **Если бот молчит**",
  "1. Подождите 2–3 минуты: бот проверяет дела раз в минуту.",
  "2. Нажмите `/menu`. Ответил — бот жив. Тогда откройте «⋯ Ещё» → «🩺 Состояние»: там видно, какой источник (свет, вода, газ, аниме) сейчас не читается.",
  "3. Не ответил — на ПК, в папке DiscordBot, запустите `npm run status`. Он скажет, работает ли расписание, и подскажет следующий шаг.",
  "4. Всё ещё тихо — напишите Claude: «бот молчит» и вставьте то, что напечатал `npm run status`. Подробности — в README, раздел «Если бот молчит».",
  "5. Дела не потеряются: они в базе. Когда бот заработает, пропущенные напоминания придут сами. Копия дел — `npm run export`.",
].join("\n");
