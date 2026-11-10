// Календарь сюрпризов (этап 5 ретроспективы 2, группа F): годовые даты, предупреждения за месяц/неделю/день, перевод часов, сезонные «между прочим», «Год с Хару».
// Чистая логика без базы и Discord: время и память («что уже заведено») приходят аргументами, поэтому всё проверяется тестами.
// Личные данные: только название (имя или короткое описание) и дата (F5). Имена и даты в журнал и события не пишем.
import { detectSecret } from "./secrets.ts";
import type { Parsed } from "./time/parse.ts";
import { HOUR, civilDay, daysInMonth, fromCivilDay, offsetAt, wallOf, wallToUtc } from "./time/tz.ts";

export type CalKind = "birthday" | "tax" | "doc" | "pay" | "other";

export interface CalEntry {
  kind: CalKind;
  name: string;
  mo: number;
  d: number;
  /** год — только у разового срока («документ до 14.05.2027»); у годовых дел null */
  year: number | null;
}

/** Строка таблицы `annuals`. */
export interface Annual extends CalEntry {
  id: number;
  /** «ГГГГ-ММ-ДД:стадия» последнего заведённого предупреждения */
  marked: string | null;
}

export interface Ymd {
  y: number;
  mo: number;
  d: number;
}

/** За сколько дней предупреждать: месяц, неделя, день (F2); у дня рождения ещё и сам день (F4). */
export const STAGES: Record<CalKind, number[]> = {
  birthday: [30, 7, 1, 0],
  tax: [30, 7, 1],
  doc: [30, 7, 1],
  pay: [30, 7, 1],
  other: [30, 7, 1],
};

/** Предупреждения приходят в 10:00 по местному времени (или сразу, если бот проснулся позже). */
export const CAL_HOUR = 10;
/** Не больше строк в одном сообщении со списком. */
export const CAL_MAX_ENTRIES = 60;

const KIND_LABEL: Record<CalKind, string> = { birthday: "День рождения", tax: "Налоги", doc: "Документ", pay: "Платёж", other: "Дата" };
export const kindLabel = (k: CalKind): string => KIND_LABEL[k];

const MONTH_GEN = ["", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const dateText = (mo: number, d: number): string => `${d} ${MONTH_GEN[mo]}`;

// ---------- разбор сообщения со списком (F3) ----------

export type CalCommand =
  | { kind: "list" }
  | { kind: "add"; entries: CalEntry[]; bad: string[] }
  | { kind: "remove"; name: string }
  | { kind: "secret" };

const TRIGGER = /^(?:(?:бот|хару)[,:]?\s+)?(календарь|годовые дела|годовые даты|годовые|даты)(?:\s*[:\-–—]\s*|\s+|$)(.*)$/iu;

const HEADERS: [RegExp, CalKind][] = [
  [/^(?:дни рождения|день рождения|рождения|др|дни рожденья|именинники)$/iu, "birthday"],
  [/^(?:налоги|налог|фоп|налоги и фоп|налоги фоп|отчёты|отчеты)$/iu, "tax"],
  [/^(?:документы|документ|сроки документов|сроки)$/iu, "doc"],
  [/^(?:платежи|платёж|платеж|оплаты|ежегодные платежи|подписки)$/iu, "pay"],
  [/^(?:другое|прочее|разное|остальное)$/iu, "other"],
];

/** Вид дела по названию, если заголовка раздела не было. */
function guessKind(name: string): CalKind {
  // \b в JavaScript не знает кириллицу: границу слова ставим через буквы Юникода
  const L = String.raw`\p{L}*`;
  const start = String.raw`(?<![\p{L}])`;
  if (new RegExp(String.raw`^(?:др|день рождения|д\.р\.)(?![\p{L}])`, "iu").test(name)) return "birthday";
  if (new RegExp(`${start}(?:фоп|налог${L}|есв|декларац${L}|отч[её]т${L})`, "iu").test(name)) return "tax";
  if (new RegExp(`${start}(?:паспорт${L}|права|виза|страховк${L}|документ${L}|полис${L}|сертификат${L})`, "iu").test(name)) return "doc";
  if (new RegExp(`${start}(?:оплат${L}|платеж${L}|платёж${L}|подписк${L}|аренд${L}|домен${L})`, "iu").test(name)) return "pay";
  return "other";
}

const DATE = String.raw`(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?`;
const RX_NAME_FIRST = new RegExp(String.raw`^(.+?)[\s:–—,\-]+${DATE}$`, "u");
const RX_DATE_FIRST = new RegExp(String.raw`^${DATE}[\s:–—,\-]+(.+)$`, "u");

/** Допустимая дата: месяц 1–12, число не больше дней в месяце (29 февраля — можно: в невисокосный год сдвинется на 28-е). */
function validMd(mo: number, d: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(2024, mo);
}

/** Одна строка списка → запись или null (не поняла). */
export function parseEntryLine(raw: string, kindHint: CalKind | null): CalEntry | null {
  const line = raw.trim().replace(/^[•*\-–—]\s+/u, "").trim();
  if (!line) return null;
  let name: string;
  let d: number;
  let mo: number;
  let year: number | null = null;
  const a = RX_NAME_FIRST.exec(line);
  const b = a ? null : RX_DATE_FIRST.exec(line);
  if (a) {
    name = a[1];
    d = Number(a[2]);
    mo = Number(a[3]);
    year = a[4] ? Number(a[4]) : null;
  } else if (b) {
    d = Number(b[1]);
    mo = Number(b[2]);
    year = b[3] ? Number(b[3]) : null;
    name = b[4];
  } else return null;
  name = name.trim().replace(/^["«“„']+|["»”']+$/gu, "").trim();
  if (!validMd(mo, d) || name.length < 1 || name.length > 40 || !/\p{L}/u.test(name)) return null;
  // личные данные: только имя и дата — ни телефонов, ни ссылок, ни адресов почты
  if ((name.match(/\d/g) ?? []).length >= 5 || /@|https?:|www\./iu.test(name) || detectSecret(name).secret) return null;
  const kind = kindHint ?? guessKind(name);
  // год у дня рождения — год рождения: не храним (F5, только имя и дата)
  if (kind === "birthday") year = null;
  else if (year !== null && (year < 2000 || year > 2100)) return null;
  return { kind, name, mo, d, year };
}

/** Заголовок раздела («Дни рождения:», «налоги») → вид; иначе null. */
function headerKind(line: string): CalKind | null {
  const t = line.trim().replace(/[:：]+$/u, "").trim();
  if (!t || /\d/.test(t)) return null;
  for (const [rx, k] of HEADERS) if (rx.test(t)) return k;
  return null;
}

/**
 * Сообщение хозяина в канале «бот» про календарь: «календарь» (показать), «календарь» + строки (внести списком одним сообщением),
 * «календарь убрать Мама». Любое другое сообщение — null (это обычное дело). Сообщение, похожее на пароль или ключ, — `secret`.
 */
export function parseCalendarMessage(text: string): CalCommand | null {
  const lines = text.replace(/\r/g, "").split("\n");
  const first = TRIGGER.exec(lines[0].trim());
  if (!first) return null;
  const word = first[1].toLowerCase();
  const rest = first[2].trim();
  const more = lines.slice(1).filter((l) => l.trim());
  // слово «даты» само по себе слишком обычное: действует, только если дальше идёт список строками или оно одно в сообщении
  if (word === "даты" && !more.length && rest) return null;
  if (detectSecret(text).secret) return { kind: "secret" };
  const rm = /^(?:убрать|убери|удалить|удали)\s+(.{1,40})$/iu.exec(rest);
  if (rm && !more.length) return { kind: "remove", name: rm[1].trim().replace(/^["«“„']+|["»”']+$/gu, "") };
  const body = [...(rest ? [rest] : []), ...more];
  if (!body.length) return { kind: "list" };
  const entries: CalEntry[] = [];
  const bad: string[] = [];
  let hint: CalKind | null = null;
  for (const l of body) {
    const h = headerKind(l);
    if (h) {
      hint = h;
      continue;
    }
    const e = parseEntryLine(l, hint);
    if (e) entries.push(e);
    else bad.push(l.trim().slice(0, 50));
  }
  if (entries.length > CAL_MAX_ENTRIES) return { kind: "add", entries: entries.slice(0, CAL_MAX_ENTRIES), bad: [...bad, `…ещё ${entries.length - CAL_MAX_ENTRIES} строк не поместились`] };
  return { kind: "add", entries, bad };
}

// ---------- когда предупреждать ----------

const ymdKey = (t: Ymd): string => `${t.y}-${String(t.mo).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
export const ymdText = ymdKey;
const dayNum = (t: Ymd): number => civilDay(t.y, t.mo, t.d);

/** Ближайшая дата события не раньше `today`: годовое — в этом году или в следующем; разовое — своя дата (прошла — null). 29 февраля в невисокосный год — 28-е. */
export function nextDue(e: Pick<CalEntry, "mo" | "d" | "year">, today: Ymd): Ymd | null {
  const inYear = (y: number): Ymd => ({ y, mo: e.mo, d: Math.min(e.d, daysInMonth(y, e.mo)) });
  if (e.year !== null) {
    const t = inYear(e.year);
    return dayNum(t) >= dayNum(today) ? t : null;
  }
  const t = inYear(today.y);
  return dayNum(t) >= dayNum(today) ? t : inYear(today.y + 1);
}

export const daysBetween = (from: Ymd, to: Ymd): number => dayNum(to) - dayNum(from);

export interface Due {
  /** сколько дней до даты (0 — сегодня) */
  days: number;
  due: Ymd;
  /** стадия, которую заводим и помечаем (30, 7, 1 или 0) */
  stage: number;
}

/**
 * Какое предупреждение пора завести сегодня (или null). Если бот был недоступен и пропустил несколько стадий — заводим одну, последнюю подходящую
 * (не сыпем пачкой). Уже заведённую стадию и более раннюю по тому же сроку не повторяем.
 */
export function dueStage(e: Annual, today: Ymd): Due | null {
  const due = nextDue(e, today);
  if (!due) return null;
  const days = daysBetween(today, due);
  const stage = Math.min(...STAGES[e.kind].filter((s) => s >= days).concat([Infinity]));
  if (!Number.isFinite(stage)) return null; // до срока больше месяца: дело пока скрыто (F10)
  if (e.marked) {
    const [mDue, mStage] = e.marked.split(":");
    if (mDue === ymdKey(due) && Number(mStage) <= stage) return null;
  }
  return { days, due, stage };
}

const plural = (n: number, a: string, b: string, c: string): string => {
  const m = n % 100;
  if (m >= 11 && m <= 14) return c;
  const k = n % 10;
  return k === 1 ? a : k >= 2 && k <= 4 ? b : c;
};
export const daysText = (n: number): string => `${n} ${plural(n, "день", "дня", "дней")}`;

/** Через сколько: «сегодня», «завтра», «через 7 дней», «через месяц». */
export function whenWords(days: number): string {
  if (days === 0) return "сегодня";
  if (days === 1) return "завтра";
  return `через ${daysText(days)}`;
}

/** Варианты поздравления (F4). Пул написан заранее (текст без имён и дат; имя подставляется), из него берём два разных — по имени и году, поэтому повторный запуск даёт то же. */
export const CONGRATS: string[] = [
  "{name}, с днём рождения! Желаю здоровья, лёгких дел и поводов для улыбки каждый день.",
  "С днём рождения, {name}! Пусть год будет спокойным там, где нужно, и ярким там, где хочется.",
  "{name}, поздравляю! Пусть всё задуманное складывается легко, а рядом всегда будут хорошие люди.",
  "С днём рождения, {name}! Тепла, сил и чтобы любимое занятие находило время само.",
  "{name}, с праздником! Пусть будет много добрых новостей и ни одной скучной недели.",
  "Поздравляю, {name}! Пусть здоровья хватает на всё, а настроение держится выше обычного.",
  "{name}, с днём рождения! Пусть этот год подарит то, чего давно хочется, и немного приятных сюрпризов.",
  "С днём рождения, {name}! Спокойных дней, интересных планов и людей, с которыми приятно молчать и говорить.",
  "{name}, поздравляю! Пусть удача заходит без звонка, а хорошее настроение не уходит.",
  "С днём рождения, {name}! Желаю лёгкости, уверенности и времени на то, что по-настоящему любишь.",
  "{name}, с днём рождения! Пусть сбываются не только большие мечты, но и маленькие желания.",
  "Поздравляю, {name}! Крепкого здоровья, тёплых встреч и поводов гордиться собой.",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Два разных варианта поздравления для имени и года. */
export function congratsOptions(name: string, year: number): [string, string] {
  const i = hash(`${name}|${year}`) % CONGRATS.length;
  const j = (i + 1 + (hash(`${year}|${name}`) % (CONGRATS.length - 1))) % CONGRATS.length;
  return [CONGRATS[i].replaceAll("{name}", name), CONGRATS[j].replaceAll("{name}", name)];
}

export interface StageItem {
  parsed: Parsed;
  body: string | null;
}

/** Дело-предупреждение как разобранная фраза: срок — сегодня в 10:00 (если уже позже — через минуту), без повтора. Каждое предупреждение — отдельное дело с «Готово». */
export function stageItem(e: Annual, d: Due, now: number, tz: string): StageItem {
  const w = wallOf(now, tz);
  const at = wallToUtc({ y: w.y, mo: w.mo, d: w.d, h: CAL_HOUR, mi: 0 }, tz);
  const when = d.days >= 2 ? `${whenWords(d.days)} (${dateText(d.due.mo, d.due.d)})` : whenWords(d.days);
  let title: string;
  let body: string | null = null;
  if (e.kind === "birthday") {
    title = d.days === 0 ? `Сегодня день рождения: ${e.name}` : d.days === 1 ? `Завтра день рождения: ${e.name}` : `День рождения: ${e.name} — ${when}`;
    if (d.days === 0) {
      const [a, b] = congratsOptions(e.name, d.due.y);
      body = `Варианты поздравления:\n1) ${a}\n2) ${b}`;
    } else if (d.days <= 7) body = "Если нужен подарок или звонок — самое время подумать.";
  } else {
    title = `${kindLabel(e.kind)}: ${e.name} — срок ${when}`;
  }
  return {
    parsed: { title, due: Math.max(at, now + 60_000), past: false, recipe: null, leadDays: [], critical: false, timer: false, seriesEmpty: false },
    body,
  };
}

/** Строка с пометкой стадии для таблицы `annuals.marked`. */
export const markValue = (d: Due): string => `${ymdKey(d.due)}:${d.stage}`;

// ---------- список для экрана «Календарь» ----------

/** Что показать в списке: ближайшая дата каждой записи, по возрастанию. */
export function calendarListText(list: Annual[], today: Ymd, max = 25): string {
  if (list.length === 0) {
    return "**Календарь**\nПока пусто. Внести даты можно одним сообщением в канал «бот»:\n```\nкалендарь\nдни рождения:\nМама 14.03\nналоги:\nФОП 20.01\n```\nЗа месяц, неделю и день бот заведёт напоминание; в день рождения ещё предложит слова поздравления.";
  }
  const rows = list
    .map((e) => ({ e, due: nextDue(e, today) }))
    .filter((r): r is { e: Annual; due: Ymd } => r.due !== null)
    .map((r) => ({ ...r, days: daysBetween(today, r.due) }))
    .sort((a, b) => a.days - b.days);
  const lines = rows.slice(0, max).map((r) => `• ${r.e.kind === "birthday" ? "🎂 " : ""}${r.e.name} — ${dateText(r.due.mo, r.due.d)} (${whenWords(r.days)})`);
  if (rows.length > max) lines.push(`… и ещё ${rows.length - max}`);
  return `**Календарь** — записей: ${list.length}\n${lines.join("\n")}\nУбрать запись: в канале «бот» напишите «календарь убрать Имя». Добавить — «календарь» и список строк.`;
}

/** Ответ на внесённый список: сколько записано и что не поняла (имена в ответе — в личном канале хозяина, в журнал не идут). */
export function addedReply(added: number, skipped: number, bad: string[]): string {
  const parts: string[] = [];
  parts.push(added > 0 ? `Записала в календарь: ${added}.` : "Новых записей нет.");
  if (skipped > 0) parts.push(`Уже были в календаре: ${skipped}.`);
  if (added > 0) parts.push("Напомню за месяц, за неделю и за день; в день рождения ещё предложу слова поздравления. Весь список — «⋯ Ещё» → «📆 Календарь».");
  if (bad.length) parts.push(`Не поняла строк: ${bad.length}. Пишите так: «Мама 14.03» (имя или короткое название и дата).\n${bad.slice(0, 5).map((b) => `• ${b}`).join("\n")}`);
  return parts.join(" ");
}

// ---------- перевод часов (F6) ----------

export interface DstWarning {
  title: string;
  /** дата ночи перехода: завтра */
  tomorrow: Ymd;
  /** +1 — вперёд, −1 — назад */
  direction: 1 | -1;
}

/** Завтра ночью переводят часы? Сравниваем смещение пояса в полдень сегодня и в полдень завтра. */
export function dstWarning(now: number, tz: string): DstWarning | null {
  const w = wallOf(now, tz);
  const t = fromCivilDay(civilDay(w.y, w.mo, w.d) + 1);
  const noonToday = wallToUtc({ y: w.y, mo: w.mo, d: w.d, h: 12, mi: 0 }, tz);
  const noonTomorrow = wallToUtc({ y: t.y, mo: t.mo, d: t.d, h: 12, mi: 0 }, tz);
  const delta = (offsetAt(noonTomorrow, tz) - offsetAt(noonToday, tz)) / HOUR;
  if (delta === 0) return null;
  const direction = delta > 0 ? 1 : -1;
  const title =
    direction === 1
      ? "Сегодня ночью часы переводят вперёд на 1 час: ночь станет короче, будильники и напоминания на утро сдвинутся в голове, не в боте"
      : "Сегодня ночью часы переводят назад на 1 час: ночь станет длиннее, утреннее время вернётся на час раньше по ощущениям";
  return { title, tomorrow: { y: t.y, mo: t.mo, d: t.d }, direction };
}

/** Дело-предупреждение о переводе часов: сегодня в 10:00 (или через минуту). */
export function dstItem(w: DstWarning, now: number, tz: string): Parsed {
  const nw = wallOf(now, tz);
  const at = wallToUtc({ y: nw.y, mo: nw.mo, d: nw.d, h: CAL_HOUR, mi: 0 }, tz);
  return { title: w.title, due: Math.max(at, now + 60_000), past: false, recipe: null, leadDays: [], critical: false, timer: false, seriesEmpty: false };
}

// ---------- сезонные «между прочим» (F8) ----------

export type Season = "winter" | "spring" | "summer" | "autumn";
/** Первые числа сезона: с 1-го по 7-е число первого месяца ждём тихий момент (нет вопроса важнее), потом пропускаем. */
export const SEASON_WINDOW_DAYS = 7;

export function seasonStarting(today: Ymd): Season | null {
  if (today.d > SEASON_WINDOW_DAYS) return null;
  return ({ 3: "spring", 6: "summer", 9: "autumn", 12: "winter" } as Record<number, Season>)[today.mo] ?? null;
}

export const seasonKey = (s: Season, y: number): string => `${s}-${y}`;

export const SEASON_TEXT: Record<Season, string> = {
  spring: "Между прочим: началась весна. Если в планах что-то сезонное (окна, велосипед, рассада, шины) — напишите сюда обычным текстом, заведу дело.",
  summer: "Между прочим: началось лето. Если нужно что-то к жаре и отпускам (кондиционер, документы для поездки, прививки) — напишите сюда, заведу дело.",
  autumn: "Между прочим: началась осень. Отопление, тёплые вещи, шины, запас зарядок на случай отключений — если что-то из этого нужно, напишите сюда, заведу дело.",
  winter: "Между прочим: началась зима. Тёплые вещи, отопление, подарки и конец года — если что-то нужно записать, напишите сюда, заведу дело.",
};

// ---------- «Год с Хару» (F9) ----------

/** Конец декабря: с 28-го числа. */
export const YEAR_REVIEW_FROM_DAY = 28;
export const isYearReviewDay = (today: Ymd): boolean => today.mo === 12 && today.d >= YEAR_REVIEW_FROM_DAY;

export function yearReviewText(a: { year: number; done: number; created: number; open: number; frozen: number }): string {
  const lines = [`**Год с Хару — ${a.year}**`, `Закрыто дел: ${a.done}. Записано новых: ${a.created}. Сейчас открыто: ${a.open}${a.frozen ? `, заморожено: ${a.frozen}` : ""}.`];
  if (a.done === 0) lines.push("В этом году закрытых дел почти нет — зато бот всё время был на месте.");
  return lines.join("\n");
}

/** Начало и конец года (UTC, мс) по часам пояса — для подсчёта закрытых дел за год. */
export function yearBounds(year: number, tz: string): { from: number; to: number } {
  return { from: wallToUtc({ y: year, mo: 1, d: 1, h: 0, mi: 0 }, tz), to: wallToUtc({ y: year + 1, mo: 1, d: 1, h: 0, mi: 0 }, tz) };
}

