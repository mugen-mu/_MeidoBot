// График отключений света для сводок. Источник — открытые данные Yasno (ДТЕК Дніпровські електромережі, Днепр):
// регион 3, оператор 301. Данные: по группам («3.1», «3.2» …) на сегодня и завтра, слоты в минутах от полуночи.
// Адрес дома бот не хранит и не знает — только номер группы, который пользователь задаёт в /settings.
import { fmtHHMM, wallOf } from "./time/tz.ts";

export const YASNO_URL = "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/3/dsos/301/planned-outages";

export interface LightDay {
  status: string;
  /** дата в формате ГГГГ-ММ-ДД (по часам Yasno) */
  date: string;
  /** только слоты «света не будет», минуты от полуночи */
  off: { start: number; end: number }[];
}

export type LightData = Record<string, { today: LightDay; tomorrow: LightDay }>;

type RawSlot = { start?: number; end?: number; type?: string };
type RawDay = { slots?: RawSlot[]; date?: string; status?: string };

function parseDay(d: RawDay | undefined): LightDay | null {
  if (!d || !Array.isArray(d.slots)) return null;
  const off = d.slots
    .filter((s) => s.type === "Definite" && Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({ start: s.start as number, end: s.end as number }))
    .sort((a, b) => a.start - b.start);
  // соседние слоты склеиваем: 13:30–17:30 и 17:30–21:00 -> 13:30–21:00
  const merged: LightDay["off"] = [];
  for (const s of off) {
    const last = merged[merged.length - 1];
    if (last && last.end === s.start) last.end = s.end;
    else merged.push({ ...s });
  }
  return { status: String(d.status ?? ""), date: String(d.date ?? "").slice(0, 10), off: merged };
}

/** Разбор ответа Yasno; группы, которых не удалось разобрать, пропускаются. */
export function parseYasno(json: unknown): LightData {
  const out: LightData = {};
  if (!json || typeof json !== "object") return out;
  for (const [group, v] of Object.entries(json as Record<string, { today?: RawDay; tomorrow?: RawDay }>)) {
    const today = parseDay(v?.today);
    const tomorrow = parseDay(v?.tomorrow);
    if (today && tomorrow) out[group] = { today, tomorrow };
  }
  return out;
}

export async function fetchYasno(fetchFn: typeof fetch = fetch): Promise<LightData | null> {
  try {
    const res = await fetchFn(YASNO_URL, { headers: { accept: "application/json", "user-agent": "MeidoBot (personal, 0.1)" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = parseYasno(await res.json());
    return Object.keys(data).length ? data : null;
  } catch {
    return null;
  }
}

/** «3» -> все подгруппы 3.x, «3.1» -> одна. */
export function groupsFor(group: string, data: LightData): string[] {
  return Object.keys(data)
    .filter((g) => g === group || g.startsWith(`${group}.`))
    .sort();
}

const same = (a: LightDay, b: LightDay) => a.status === b.status && JSON.stringify(a.off) === JSON.stringify(b.off);
const range = (s: { start: number; end: number }) => `${fmtHHMM(s.start)}–${fmtHHMM(s.end)}`;

/** Строки для сводки: график на сегодня или на завтра для группы пользователя. */
export function lightLines(which: "today" | "tomorrow", group: string, data: LightData, expectedDate: string): string[] {
  const keys = groupsFor(group, data);
  const when = which === "today" ? "сегодня" : "завтра";
  if (keys.length === 0) return [`График света: группа ${group} не найдена (проверьте номер в /settings).`];
  const describe = (d: LightDay): string => {
    if (d.status === "WaitingForSchedule" || d.date !== expectedDate) return "график ещё не опубликован";
    if (d.status !== "ScheduleApplies") return `статус «${d.status}»`;
    return d.off.length ? `света не будет ${d.off.map(range).join(", ")}` : "отключений нет";
  };
  const days = keys.map((k) => data[k][which]);
  if (days.every((d) => same(d, days[0]))) return [`Свет ${when} (группа ${group}): ${describe(days[0])}.`];
  return [
    ...keys.map((k, i) => `Свет ${when} (группа ${k}): ${describe(days[i])}.`),
    "Графики подгрупп разные: выберите свою в /settings → «Свет: группа…» (например, 3.1).",
  ];
}

/** Номер группы из настроек: «3» или «3.1»; null — не годится. */
export function normalizeGroup(text: string): string | null {
  const t = text.trim().replace(",", ".");
  return /^[1-6](\.[12])?$/.test(t) ? t : null;
}

export interface ScheduleCheck {
  verdict: "yes" | "no" | "mixed" | "unknown";
  /** интервал «света не будет», в который попал момент, например «17:30–20:30» */
  range?: string;
}

/** Допуск: сеть может отключиться чуть раньше начала слота. */
export const SCHEDULE_SLACK_MIN = 15;

/**
 * Попал ли момент `at` в график отключений группы («по графику» или нет).
 * Если у группы подгруппы (3.1, 3.2) и ответы разные — «mixed». Нет данных на эту дату — «unknown».
 */
export function checkSchedule(at: number, group: string, data: LightData, tz: string): ScheduleCheck {
  const w = wallOf(at, tz);
  const date = `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
  const minute = w.h * 60 + w.mi;
  const results: ScheduleCheck[] = [];
  for (const k of groupsFor(group, data)) {
    const day = [data[k].today, data[k].tomorrow].find((d) => d.date === date);
    if (!day || day.status !== "ScheduleApplies") {
      results.push({ verdict: "unknown" });
      continue;
    }
    const hit = day.off.find((s) => minute >= s.start - SCHEDULE_SLACK_MIN && minute < s.end);
    results.push(hit ? { verdict: "yes", range: range(hit) } : { verdict: "no" });
  }
  if (results.length === 0 || results.every((r) => r.verdict === "unknown")) return { verdict: "unknown" };
  const first = results[0];
  if (results.every((r) => r.verdict === first.verdict && r.range === first.range)) return first;
  return { verdict: "mixed" };
}
