// Запас бесплатных лимитов Cloudflare: что бот считает сам и как сообщает о нехватке заранее
// (просьба Ihor 2026-11-10: «чтобы мы заранее знали, когда начнём наступать на лимиты»).
// Чистые функции без обращений к базе и Discord: состояние живёт в одной строке meta `usage` (последние 8 суток),
// о каких лимитах уже предупредили — в `limit_warned`.
//
// Что считается точно (из ответов D1 и модели): записи и чтения строк базы, размер базы, нейроны Workers AI, пик подзапросов за запуск.
// Что не видно изнутри Worker: процессорное время (10 мс на запуск). Косвенный признак — перерывы: между запусками прошло больше
// GAP_MINUTES минут (запуск оборвали, лимит, сбой Cloudflare). Они попадают в итог недели и в `npm run status`.
// Считаются запуски по расписанию (основной расход); отдельные нажатия кнопок и команды — единицы в сутки, не считаются.
import { MINUTE, wallOf } from "./time/tz.ts";

export const DAY_MS = 86_400_000;

/** Бесплатные нормы Cloudflare (сверено со страницами документации 2026-11-10; подзапросы — за один запуск, остальное — за сутки UTC). */
export const LIMITS = {
  subrequests: 50,
  rowsWritten: 100_000,
  rowsRead: 5_000_000,
  dbBytes: 500 * 1024 * 1024,
  neurons: 10_000,
} as const;

/** С какой доли нормы начинаем предупреждать. */
export const WARN_AT = 0.7;
/** С этой доли предупреждаем повторно каждые сутки, ниже — раз в WARN_COOLDOWN_DAYS. */
export const WARN_CRITICAL = 0.9;
export const WARN_COOLDOWN_DAYS = 7;
/** Перерыв: между запусками больше стольких минут (одна потерянная минута у Cloudflare бывает и не страшна). */
export const GAP_MINUTES = 5;
export const KEEP_DAYS = 8;
/** Нейронов на один вызов модели, если ответ не сказал, сколько потрачено (замер пробы 2026-11-09: 6,9 на реплику). */
export const NEURONS_FALLBACK = 7;
/** Расценка Workers AI для gemma-4: нейронов за токен (9 091 на млн входных, 27 273 на млн выходных). */
const NEURONS_PER_IN_TOKEN = 9091 / 1_000_000;
const NEURONS_PER_OUT_TOKEN = 27273 / 1_000_000;

export type Metric = "sub" | "rw" | "rr" | "db" | "ai";

export interface DayUsage {
  /** сутки UTC, ГГГГ-ММ-ДД (на 00:00 UTC Cloudflare обнуляет дневные нормы) */
  d: string;
  /** запусков cron */
  runs: number;
  /** пик подзапросов за один запуск */
  sub: number;
  /** записано строк в D1 за сутки */
  rw: number;
  /** прочитано строк в D1 за сутки */
  rr: number;
  /** размер базы (байт) на последнем запуске */
  db: number;
  /** потрачено нейронов Workers AI за сутки (округлено) */
  ai: number;
  /** сколько раз были перерывы и сколько минут в сумме */
  gaps: number;
  gap: number;
}

export interface RunUsage {
  now: number;
  subrequests: number;
  rowsRead: number;
  rowsWritten: number;
  dbBytes: number;
  neurons: number;
  /** минут без запусков перед этим запуском (0 — перерыва нет) */
  gapMin: number;
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function parseUsage(raw: string | undefined | null): DayUsage[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x && typeof x.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.d))
      .map((x) => ({ d: x.d, runs: num(x.runs), sub: num(x.sub), rw: num(x.rw), rr: num(x.rr), db: num(x.db), ai: num(x.ai), gaps: num(x.gaps), gap: num(x.gap) }))
      .slice(-KEEP_DAYS);
  } catch {
    return [];
  }
}

/** Минуты перерыва по прежней отметке «жив»; null/0 — первого запуска или перерыва нет. */
export function gapMinutes(prevAliveAt: number | null | undefined, now: number): number {
  if (!prevAliveAt || prevAliveAt <= 0 || now <= prevAliveAt) return 0;
  const lost = Math.round((now - prevAliveAt) / MINUTE) - 1;
  return lost >= GAP_MINUTES ? lost : 0;
}

/** Добавить итог запуска в сутки (создаёт запись при смене суток), оставляя последние KEEP_DAYS. */
export function addRun(days: DayUsage[], r: RunUsage): DayUsage[] {
  const d = utcDay(r.now);
  const out = days.map((x) => ({ ...x }));
  let cur = out.find((x) => x.d === d);
  if (!cur) {
    cur = { d, runs: 0, sub: 0, rw: 0, rr: 0, db: 0, ai: 0, gaps: 0, gap: 0 };
    out.push(cur);
  }
  cur.runs += 1;
  cur.sub = Math.max(cur.sub, r.subrequests);
  cur.rw += r.rowsWritten;
  cur.rr += r.rowsRead;
  if (r.dbBytes > 0) cur.db = r.dbBytes;
  cur.ai += Math.round(r.neurons);
  if (r.gapMin > 0) {
    cur.gaps += 1;
    cur.gap += r.gapMin;
  }
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out.slice(-KEEP_DAYS);
}

/** Нейроны, которые стоил один ответ модели (по usage из ответа или запасное значение). */
export function neuronsOf(response: unknown): number {
  const u = (response as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null | undefined)?.usage;
  const pin = Number(u?.prompt_tokens);
  const pout = Number(u?.completion_tokens);
  if (Number.isFinite(pin) && Number.isFinite(pout) && pin >= 0 && pout >= 0 && pin + pout > 0) {
    return pin * NEURONS_PER_IN_TOKEN + pout * NEURONS_PER_OUT_TOKEN;
  }
  return NEURONS_FALLBACK;
}

/**
 * Можно ли звать модель ради необязательного разбора фразы (аниме запасным путём): сегодня (сутки UTC) съедено меньше WARN_AT дневной нормы
 * нейронов, считая и то, что уже потратил этот запуск (`thisRun`, в итог суток оно попадёт только в конце запуска). Дальше — готовые фразы и обычные дела.
 */
export function aiHasRoom(days: DayUsage[], now: number, thisRun: number): boolean {
  const today = days.find((x) => x.d === utcDay(now));
  return ((today?.ai ?? 0) + Math.max(0, thisRun)) / LIMITS.neurons < WARN_AT;
}

export type Shares = Record<Metric, number>;

/** Доля нормы (0..1+) по каждой метрике за одни сутки. */
export function shares(d: DayUsage): Shares {
  return {
    sub: d.sub / LIMITS.subrequests,
    rw: d.rw / LIMITS.rowsWritten,
    rr: d.rr / LIMITS.rowsRead,
    db: d.db / LIMITS.dbBytes,
    ai: d.ai / LIMITS.neurons,
  };
}

const NAME: Record<Metric, string> = {
  sub: "обращения за один запуск",
  rw: "записи в базу",
  rr: "чтение базы",
  db: "размер базы",
  ai: "живые реплики",
};

const METRICS: Metric[] = ["sub", "rw", "rr", "db", "ai"];

const pct = (x: number): string => (x > 0 && x < 0.01 ? "меньше 1%" : `${Math.round(x * 100)}%`);
const group = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const mb = (b: number): string => {
  const v = b / (1024 * 1024);
  return v < 10 ? v.toFixed(1).replace(".", ",") : String(Math.round(v));
};

/** Худшие значения каждой метрики за последние `n` суток (для итога недели и status). */
export function worstOf(days: DayUsage[], n = 7): { day: DayUsage; share: Shares; gaps: number; gapMin: number } | null {
  const last = days.slice(-n);
  if (!last.length) return null;
  const day: DayUsage = { d: last[last.length - 1].d, runs: 0, sub: 0, rw: 0, rr: 0, db: 0, ai: 0, gaps: 0, gap: 0 };
  let gaps = 0;
  let gapMin = 0;
  for (const x of last) {
    day.runs += x.runs;
    day.sub = Math.max(day.sub, x.sub);
    day.rw = Math.max(day.rw, x.rw);
    day.rr = Math.max(day.rr, x.rr);
    day.db = Math.max(day.db, x.db);
    day.ai = Math.max(day.ai, x.ai);
    gaps += x.gaps;
    gapMin += x.gap;
  }
  return { day, share: shares(day), gaps, gapMin };
}

function detailLine(w: NonNullable<ReturnType<typeof worstOf>>): string {
  const { day, share } = w;
  return [
    `обращения за запуск до ${day.sub} из ${LIMITS.subrequests}`,
    `запись в базу ${pct(share.rw)}`,
    `чтение ${pct(share.rr)}`,
    `реплики ${pct(share.ai)}`,
    day.db > 0 ? `база ${mb(day.db)} МБ из ${mb(LIMITS.dbBytes)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Строка для итога недели: самое тесное место и перерывы. null — данных ещё нет (бот только что выложен).
 * Нет тревог — спокойная строка; есть доля от 70% — с пометкой ⚠️.
 */
export function weeklyLimitsLine(days: DayUsage[]): string | null {
  const w = worstOf(days, 7);
  if (!w || w.day.runs < 5) return null;
  const top = METRICS.map((m) => ({ m, v: w.share[m] })).sort((a, b) => b.v - a.v)[0];
  const tight = top.v >= WARN_AT;
  const gap = w.gaps ? `Перерывов в работе: ${w.gaps} (около ${w.gapMin} мин).` : "Перерывов в работе не было.";
  const head = tight
    ? `⚠️ Бесплатные лимиты Cloudflare: тесно — ${NAME[top.m]} ${top.m === "sub" ? `${w.day.sub} из ${LIMITS.subrequests}` : pct(top.v)}.`
    : `Бесплатные лимиты Cloudflare: с большим запасом (самое тесное — ${NAME[top.m]} ${top.m === "sub" ? `${w.day.sub} из ${LIMITS.subrequests}` : pct(top.v)}).`;
  return `${head} ${detailLine(w)}. ${gap}`;
}

export interface LimitWarning {
  metric: Metric;
  text: string;
}

const hhmm = (ms: number, tz: string): string => {
  const w = wallOf(ms, tz);
  return `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
};

/** Когда Cloudflare обнулит дневные нормы (00:00 UTC) по времени пользователя. */
export function resetTime(now: number, tz: string): string {
  return hhmm((Math.floor(now / DAY_MS) + 1) * DAY_MS, tz);
}

export function parseWarned(raw: string | undefined | null): Partial<Record<Metric, string>> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<Metric, string>> = {};
    for (const m of METRICS) if (typeof v[m] === "string") out[m] = v[m] as string;
    return out;
  } catch {
    return {};
  }
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * Что пора сказать вслух: метрики сегодняшних суток от WARN_AT, о которых не предупреждали недавно
 * (от 70% — раз в неделю, от 90% — каждые сутки). Пусто — молчим.
 */
export function limitWarnings(days: DayUsage[], now: number, tz: string, warned: Partial<Record<Metric, string>>): LimitWarning[] {
  const today = days.find((x) => x.d === utcDay(now));
  if (!today) return [];
  const sh = shares(today);
  const out: LimitWarning[] = [];
  for (const m of METRICS) {
    const v = sh[m];
    if (v < WARN_AT) continue;
    const last = warned[m];
    const age = last ? daysBetween(last, today.d) : Infinity;
    if (age < (v >= WARN_CRITICAL ? 1 : WARN_COOLDOWN_DAYS)) continue;
    out.push({ metric: m, text: warnText(m, today, v, now, tz) });
  }
  return out;
}

function warnText(m: Metric, d: DayUsage, v: number, now: number, tz: string): string {
  const reset = resetTime(now, tz);
  switch (m) {
    case "sub":
      return `Обращения за один запуск: ${d.sub} из ${LIMITS.subrequests} разрешённых. Дойдёт до ${LIMITS.subrequests} — остаток работы уйдёт в следующую минуту, сообщения станут чуть запаздывать.`;
    case "rw":
      return `Записи в базу: сегодня ${pct(v)} дневной нормы (${group(d.rw)} из ${group(LIMITS.rowsWritten)}). Упрёмся — до ${reset} (по вашему времени, тогда нормы обнуляются) бот не сможет ничего сохранять.`;
    case "rr":
      return `Чтение базы: сегодня ${pct(v)} дневной нормы (${group(d.rr)} из ${group(LIMITS.rowsRead)}). Упрёмся — до ${reset} (тогда нормы обнуляются) бот перестанет читать свои дела.`;
    case "db":
      return `Размер базы: ${mb(d.db)} МБ из ${mb(LIMITS.dbBytes)} (${pct(v)}). Когда переполнится, новые дела не запишутся — придётся чистить старое.`;
    case "ai":
      return `Живые реплики: сегодня ${pct(v)} дневной нормы модели (около ${group(d.ai)} из ${group(LIMITS.neurons)} «нейронов»). Кончится — до ${reset} Хару будет отвечать готовыми фразами.`;
  }
}

/** Готовое сообщение со всеми предупреждениями (или null, если молчим). */
export function warningMessage(ws: LimitWarning[], ownerId: string): string | null {
  if (!ws.length) return null;
  return [
    `<@${ownerId}> ⚠️ Запас бесплатных лимитов Cloudflare заканчивается:`,
    ...ws.map((w) => `• ${w.text}`),
    "Срочно делать ничего не нужно — это предупреждение заранее. Если так и останется, решим: упростить, почистить или взять платный тариф.",
  ].join("\n");
}

/** Отметить, что о метриках предупредили сегодня. */
export function markWarned(warned: Partial<Record<Metric, string>>, ws: LimitWarning[], now: number): Partial<Record<Metric, string>> {
  const next = { ...warned };
  for (const w of ws) next[w.metric] = utcDay(now);
  return next;
}

/** Строки для `npm run status`: сегодня и худшее за 7 суток. */
export function statusLines(days: DayUsage[], now: number): string[] {
  if (!days.length) return ["Лимиты Cloudflare: данных ещё нет (бот считает их с первого запуска после обновления)."];
  const today = days.find((x) => x.d === utcDay(now));
  const out: string[] = [];
  const w7 = worstOf(days, 7);
  if (today) {
    const t = worstOf([today], 1) as NonNullable<ReturnType<typeof worstOf>>;
    out.push(`Лимиты Cloudflare сегодня (UTC): ${detailLine(t)}.`);
  }
  if (w7) {
    const top = METRICS.map((m) => ({ m, v: w7.share[m] })).sort((a, b) => b.v - a.v)[0];
    out.push(
      `Лимиты Cloudflare за ${Math.min(7, days.length)} сут.: самое тесное — ${NAME[top.m]} ${top.m === "sub" ? `${w7.day.sub} из ${LIMITS.subrequests}` : pct(top.v)}${top.v >= WARN_AT ? " (ТЕСНО)" : ""}; ` +
        (w7.gaps ? `перерывов: ${w7.gaps} (около ${w7.gapMin} мин).` : "перерывов не было."),
    );
  }
  return out;
}
