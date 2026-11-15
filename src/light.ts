// График отключений света для сводок. Источник — открытые данные Yasno (ДТЕК Дніпровські електромережі, Днепр):
// регион 3, оператор 301. Данные: по группам («3.1», «3.2» …) на сегодня и завтра, слоты в минутах от полуночи.
// Адрес дома бот не хранит и не знает — только номер группы, который пользователь задаёт в /settings.
import { addDaysWall, fmtHHMM, localDate, wallOf } from "./time/tz.ts";

export const YASNO_URL = "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/3/dsos/301/planned-outages";

export interface LightDay {
  status: string;
  /** дата в формате ГГГГ-ММ-ДД (по часам Yasno) */
  date: string;
  /** только слоты «света не будет», минуты от полуночи */
  off: { start: number; end: number }[];
}

export type LightData = Record<string, { today: LightDay; tomorrow: LightDay }>;

/**
 * График дня известен: «есть график» или «отключений нет». Со второй половины ноября 2026 Yasno помечает день без отключений
 * статусом `NoOutages` (все слоты «NotPlanned»); раньше бот не знал такого статуса и писал «график не опубликован».
 */
export const hasSchedule = (d: LightDay): boolean => d.status === "ScheduleApplies" || d.status === "NoOutages";

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

/** Сколько раз пробуем запросить Yasno за один раз (разовый сбой или таймаут не должен ломать сводку). Каждая попытка — подзапрос Cloudflare. */
export const YASNO_ATTEMPTS = 2;

async function fetchYasnoOnce(fetchFn: typeof fetch): Promise<LightData | null> {
  try {
    const res = await fetchFn(YASNO_URL, { headers: { accept: "application/json", "user-agent": "MeidoBot (personal, 0.1)" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = parseYasno(await res.json());
    return Object.keys(data).length ? data : null;
  } catch {
    return null;
  }
}

/** Запрос к Yasno с повтором: вторая попытка через паузу. null — не ответил ни разу. */
export async function fetchYasno(fetchFn: typeof fetch = fetch, retryDelayMs = 800): Promise<LightData | null> {
  for (let i = 0; i < YASNO_ATTEMPTS; i++) {
    if (i > 0 && retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    const data = await fetchYasnoOnce(fetchFn);
    if (data) return data;
  }
  return null;
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
    if (d.status === "EmergencyShutdowns") return "Yasno сейчас показывает «аварийные отключения» без часов, график не опубликован (проверьте сайт ДТЭК)";
    if (!hasSchedule(d)) return `график не опубликован (статус Yasno «${d.status}»)`;
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
  /** emergency — Yasno сейчас показывает «аварийные отключения»: графики не действуют */
  verdict: "yes" | "no" | "mixed" | "unknown" | "emergency";
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
    if (day?.status === "EmergencyShutdowns") {
      results.push({ verdict: "emergency" });
      continue;
    }
    if (!day || !hasSchedule(day)) {
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

/** Опубликован ли график на «сегодня» или «завтра» для всех подгрупп группы (на нужную дату). */
export function publishedFor(which: "today" | "tomorrow", group: string, data: LightData, expectedDate: string): boolean {
  const keys = groupsFor(group, data);
  return keys.length > 0 && keys.every((k) => hasSchedule(data[k][which]) && data[k][which].date === expectedDate);
}

/** «Сейчас по графику…»: идёт ли отключение и когда следующее. null — график на сегодня неизвестен или подгруппы расходятся. */
export function nowLine(now: number, group: string, data: LightData, tz: string): string | null {
  const w = wallOf(now, tz);
  const date = `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
  const minute = w.h * 60 + w.mi;
  const lines = new Set<string>();
  for (const k of groupsFor(group, data)) {
    const day = data[k].today;
    if (!hasSchedule(day) || day.date !== date) return null;
    const inside = day.off.find((s) => minute >= s.start && minute < s.end);
    const next = day.off.find((s) => s.start > minute);
    lines.add(
      inside
        ? `Сейчас по графику света нет, включат около ${fmtHHMM(inside.end)}.`
        : next
          ? `Сейчас по графику свет есть, ближайшее отключение в ${fmtHHMM(next.start)}.`
          : day.status === "NoOutages"
            ? "Сейчас по графику свет есть, сегодня отключений нет."
            : "Сейчас по графику свет есть, сегодня отключений больше нет.",
    );
  }
  return lines.size === 1 ? [...lines][0] : null;
}

/** Полный ответ «график света»: сегодня, «сейчас», завтра. Один вид для кнопки «Свет», команды /light и вопроса текстом в канале. */
export function lightFullText(now: number, tz: string, group: string, data: LightData | null): string {
  if (!data) return "Не удалось получить график: Yasno не отвечает. Попробуйте позже.";
  const today = localDate(now, tz);
  const tomorrow = localDate(addDaysWall(now, 1, tz), tz);
  return [...lightLines("today", group, data, today), nowLine(now, group, data, tz), ...lightLines("tomorrow", group, data, tomorrow)].filter(Boolean).join("\n");
}

/** «2026-11-08» -> «11.08.2026» (американский формат месяц.день.год: решение пользователя 2026-11-08). */
export function usDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}.${d}.${y}`;
}

const TODAY_HEADS: ((a: string, date: string) => string)[] = [
  (a, date) => `${a}, график света на сегодня (${date}) наконец опубликован.`,
  (a, date) => `${a}, на сегодня (${date}) вышел график отключений.`,
];

const DIGEST_HEADS: ((a: string, date: string) => string)[] = [
  (a, date) => `${a}, график отключений на завтра ${date} опубликован.`,
  (a, date) => `${a}, на завтра (${date}) вышел график отключений.`,
  (a, date) => `${a}, график света на ${date} уже появился.`,
  (a, date) => `${a}, график отключений на ${date} опубликован.`,
];

/**
 * Сообщение «график на завтра опубликован»: заголовок (одна из нескольких формулировок, выбор по дате, чтобы не повторяться изо дня в день)
 * и строка «Света не будет 03:30–07:30, 14:00–18:00.». Если подгруппы расходятся, строка на каждую.
 */
export function tomorrowDigest(group: string, data: LightData, tomorrowIso: string, address: string, which: "today" | "tomorrow" = "tomorrow"): string {
  const a = address.charAt(0).toUpperCase() + address.slice(1);
  const seed = Number(tomorrowIso.replace(/-/g, "")) % DIGEST_HEADS.length;
  const head = which === "today" ? TODAY_HEADS[seed % TODAY_HEADS.length](a, usDate(tomorrowIso)) : DIGEST_HEADS[seed](a, usDate(tomorrowIso));
  const keys = groupsFor(group, data);
  const days = keys.map((k) => data[k][which]);
  const text = (d: LightDay) => (d.off.length ? `Света не будет ${d.off.map(range).join(", ")}.` : "Отключений не будет.");
  const body = days.every((d) => same(d, days[0]))
    ? [text(days[0])]
    : keys.map((k, i) => `Группа ${k}: ${text(days[i]).charAt(0).toLowerCase()}${text(days[i]).slice(1)}`);
  return [head, ...body].join("\n");
}
