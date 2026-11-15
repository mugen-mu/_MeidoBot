// Журнал отключений света по датчику (ретроспектива «аварийные отключения», 2026-11-15, вариант A).
// Новой таблицы нет: события power_on («появился», в detail — `ms=сколько не было`) и power_announced («света нет» объявлено,
// в detail — `sched=` результат сверки с графиком Yasno) уже пишутся в events (power.ts). Здесь они собираются в промежутки
// «не было света с … по …» и в строку для утренней и вечерней сводок: «за сутки не было 3 ч 5 мин, из них вне графика …».
import type { Repo } from "./db/repo.ts";
import { BLINK_MS, fmtOffTime, readPower } from "./power.ts";
import { DAY, MINUTE, fmtHHMM, localDate, startOfDay, wallOf } from "./time/tz.ts";

export interface OutageRow {
  at: number;
  kind: string;
  detail: string | null;
}

export interface OutageSpan {
  start: number;
  end: number;
  /** результат сверки с графиком: yes / no / emergency / mixed / unknown / unavailable / none */
  sched: string;
  /** отключение ещё идёт (конец — «сейчас») */
  ongoing?: boolean;
}

/** Сколько назад от начала окна смотрим события: отключение могло начаться раньше окна. */
const LOOKBACK = 3 * DAY;
/** «вне графика»: света нет, а график отключений не обещал (no) или Yasno показывает аварийные отключения (emergency) */
const OFF_SCHEDULE = new Set(["no", "emergency"]);
const MAX_LISTED = 5;

/** События -> промежутки без света; моргания короче минуты не считаются (как в объявлениях). */
export function buildSpans(rows: OutageRow[], ongoingSince: number | null, now: number): OutageSpan[] {
  const announced = rows
    .filter((r) => r.kind === "power_announced")
    .map((r) => ({ at: r.at, sched: /sched=(\w+)/.exec(r.detail ?? "")?.[1] ?? "unknown" }));
  const spans: OutageSpan[] = [];
  for (const r of rows) {
    if (r.kind !== "power_on") continue;
    const ms = Number(/ms=(\d+)/.exec(r.detail ?? "")?.[1]);
    if (!Number.isFinite(ms) || ms < BLINK_MS) continue;
    const start = r.at - ms;
    spans.push({ start, end: r.at, sched: announced.find((a) => a.at >= start && a.at <= r.at)?.sched ?? "unknown" });
  }
  if (ongoingSince !== null && now - ongoingSince >= BLINK_MS) {
    const last = announced.filter((a) => a.at >= ongoingSince).pop();
    spans.push({ start: ongoingSince, end: now, sched: last?.sched ?? "unknown", ongoing: true });
  }
  return spans.sort((a, b) => a.start - b.start);
}

const tagText = (sched: string): string => (sched === "yes" ? " по графику" : OFF_SCHEDULE.has(sched) ? " вне графика" : "");

/**
 * Строка для сводки; пустой список — отключений в окне не было (сводка о свете молчит).
 * `label` — «за сутки» или «сегодня». Промежутки обрезаются по окну; ночные — со словом «вчера».
 */
export function outageSummaryLines(spans: OutageSpan[], from: number, to: number, tz: string, label: string): string[] {
  const inWindow = spans.map((s) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) })).filter((s) => s.end - s.start >= MINUTE);
  if (!inWindow.length) return [];
  const total = inWindow.reduce((n, s) => n + (s.end - s.start), 0);
  const off = inWindow.filter((s) => OFF_SCHEDULE.has(s.sched)).reduce((n, s) => n + (s.end - s.start), 0);
  const today = localDate(to, tz);
  const hhmm = (ms: number): string => {
    const w = wallOf(ms, tz);
    return fmtHHMM(w.h * 60 + w.mi);
  };
  const listed = inWindow.slice(-MAX_LISTED).map((s) => {
    const day = localDate(s.start, tz) !== today ? "вчера " : "";
    return s.ongoing ? `${day}с ${hhmm(s.start)} (идёт)${tagText(s.sched)}` : `${day}${hhmm(s.start)}–${hhmm(s.end)}${tagText(s.sched)}`;
  });
  const more = inWindow.length > MAX_LISTED ? `, ещё ${inWindow.length - MAX_LISTED} раньше` : "";
  const offPart = off > 0 ? ` (вне графика ${fmtOffTime(off)})` : "";
  return [`Свет по датчику: ${label} не было ${fmtOffTime(total)}${offPart}: ${listed.join(", ")}${more}.`];
}

/**
 * Строки о фактических отключениях для сводки: утром — за сутки, вечером — за сегодня.
 * Датчик не настроен (нет ключа) или отключений не было — пусто и без обращения к базе.
 */
export async function outageLinesFor(repo: Repo, meta: Map<string, string>, now: number, tz: string, kind: "morning" | "evening"): Promise<string[]> {
  if (!meta.get("power_key")) return [];
  const from = kind === "evening" ? startOfDay(now, tz) : now - DAY;
  const rows = await repo.all<OutageRow>("SELECT at, kind, detail FROM events WHERE kind IN ('power_on', 'power_announced') AND at >= ? ORDER BY at, id", from - LOOKBACK);
  const p = readPower(meta);
  const spans = buildSpans(rows, p.state === "off" ? p.since : null, now);
  return outageSummaryLines(spans, from, now, tz, kind === "evening" ? "сегодня" : "за сутки");
}
