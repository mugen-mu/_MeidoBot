// Разбор русских фраз: «завтра в 10 купить хлеб», «каждые 20 минут проверить плиту до 23:00»,
// «каждый месяц 20-го оплатить ФОП заранее за 7, 3 и 1 день», «каждую вторую пятницу в 15:00 отчёт».
// Даты-слова, время и интервалы разбираем сами (предсказуемо, без сюрпризов с часовыми поясами);
// chrono-node (ru) подключаем для дат с названием месяца («20 ноября», «15 марта 2027»).
import * as chrono from "chrono-node";
import { type Recipe, clampDay, startSeries } from "../recur.ts";
import {
  DAY,
  HOUR,
  MINUTE,
  addDaysWall,
  civilDay,
  daysInMonth,
  fromCivilDay,
  wallOf,
  wallToUtc,
} from "./tz.ts";

export interface ParseOptions {
  now: number;
  tz: string;
  /** время для дел «на дату без часа», минуты от полуночи (по умолчанию 09:00) */
  defaultTime?: number;
}

export interface Parsed {
  title: string;
  /** первое срабатывание (UTC, мс) или null, если время не названо */
  due: number | null;
  /** названное время уже прошло */
  past: boolean;
  recipe: Recipe | null;
  /** «заранее за N дней» */
  leadDays: number[];
  critical: boolean;
  /** интервальный таймер («каждые 20 минут») */
  timer: boolean;
  /** повтор распознан, но завершился до первого срабатывания */
  seriesEmpty: boolean;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const rx = (src: string, flags = "iu") => new RegExp(src, flags);

const NUMW =
  "\\d+(?:[.,]\\d+)?|один|одну|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пятнадцать|двадцать|тридцать|сорок|пятьдесят";
const UNIT = "минут\\p{L}*|мин|час\\p{L}*|дн\\p{L}*|день|сутки|недел\\p{L}*|месяц\\p{L}*|год\\p{L}*|лет";
const WD =
  "понедельник\\p{L}*|вторник\\p{L}*|сред[аыуе]\\p{L}*|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*";
const ORD = "перв\\p{L}*|втор\\p{L}*|трет\\p{L}*|четв[её]рт\\p{L}*|последн\\p{L}*";

const WORDNUM: Record<string, number> = {
  один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7,
  восемь: 8, девять: 9, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
};

function num(w: string | undefined): number {
  if (!w) return 1;
  const l = w.toLowerCase().replace(",", ".");
  return WORDNUM[l] ?? Number(l);
}

function unitOf(w: string): "minutes" | "hours" | "days" | "weeks" | "months" | "years" | null {
  const l = w.toLowerCase();
  if (l.startsWith("мин")) return "minutes";
  if (l.startsWith("час")) return "hours";
  if (l.startsWith("дн") || l.startsWith("ден") || l.startsWith("сут")) return "days";
  if (l.startsWith("нед")) return "weeks";
  if (l.startsWith("мес")) return "months";
  if (l.startsWith("год") || l.startsWith("лет")) return "years";
  return null;
}

function weekdayOf(w: string): number {
  const l = w.toLowerCase();
  if (l.startsWith("понед")) return 1;
  if (l.startsWith("вторн")) return 2;
  if (l.startsWith("сред")) return 3;
  if (l.startsWith("четв")) return 4;
  if (l.startsWith("пятн")) return 5;
  if (l.startsWith("субб")) return 6;
  return 7;
}

function ordOf(w: string): number {
  const l = w.toLowerCase();
  if (l.startsWith("перв")) return 1;
  if (l.startsWith("втор")) return 2;
  if (l.startsWith("трет")) return 3;
  if (l.startsWith("четв")) return 4;
  return -1; // последний
}

const MONTHS: Record<string, number> = {
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};

class Work {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
  /** Найти первое совпадение и «стереть» его (пробелами, индексы не сдвигаются). */
  take(re: RegExp): RegExpExecArray | null {
    const m = re.exec(this.s);
    if (!m) return null;
    this.s = this.s.slice(0, m.index) + " ".repeat(m[0].length) + this.s.slice(m.index + m[0].length);
    return m;
  }
  has(re: RegExp): boolean {
    return re.test(this.s);
  }
}

function addMonthsWall(ms: number, n: number, tz: string): number {
  const w = wallOf(ms, tz);
  const idx = w.y * 12 + (w.mo - 1) + n;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  return wallToUtc({ y, mo, d: clampDay(y, mo, w.d), h: w.h, mi: w.mi }, tz);
}

function toMinutes(h: number, mer: string | undefined): number | null {
  const m = mer?.toLowerCase();
  if (h > 23) return null;
  if (m === "утра") return h === 12 ? 0 : h;
  if (m === "дня") return h < 12 ? h + 12 : h;
  if (m === "вечера") return h < 12 ? h + 12 : h;
  if (m === "ночи") return h === 12 ? 0 : h < 6 ? h : h + 12;
  return h;
}

// ---------- время суток ----------

function hasDateContext(s: string): boolean {
  return rx(`${B}(?:сегодня|завтра|послезавтра|${WD}|кажд\\p{L}*|ежедневно|по\\s+будн\\p{L}*)${E}`).test(s) ||
    /\d{1,2}\.\d{1,2}/.test(s) ||
    rx(`${B}\\d{1,2}\\s+(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)\\p{L}*`).test(s);
}

/** Время суток в минутах от полуночи или null; найденный кусок стирается. */
function extractTime(w: Work): number | null {
  let m = w.take(rx(`(?:${B}(?:в|к|около|ровно)\\s+)?${B}(\\d{1,2}):(\\d{2})(?:\\s*(утра|вечера|дня|ночи)${E})?`));
  if (m) {
    const h = toMinutes(Number(m[1]), m[3]);
    if (h !== null && Number(m[2]) < 60) return h * 60 + Number(m[2]);
  }
  m = w.take(rx(`${B}(?:в|к)\\s+(\\d{1,2})\\.(\\d{2})(?![\\d.])(?:\\s*(утра|вечера|дня|ночи)${E})?`));
  if (m) {
    const h = toMinutes(Number(m[1]), m[3]);
    if (h !== null && Number(m[2]) < 60) return h * 60 + Number(m[2]);
  }
  if (w.has(rx(`${B}в\\s+полдень${E}`))) {
    w.take(rx(`${B}в\\s+полдень${E}`));
    return 12 * 60;
  }
  if (w.has(rx(`${B}в\\s+полночь${E}`))) {
    w.take(rx(`${B}в\\s+полночь${E}`));
    return 0;
  }
  // «в 10», «в 9 утра», «в 10 часов вечера», «к 8 вечера»
  const bare = rx(`${B}(?:в|к)\\s+(\\d{1,2})(?:\\s*час(?:а|ов)?)?(?:\\s*(утра|вечера|дня|ночи))?${E}`);
  const mb = bare.exec(w.s);
  if (mb) {
    const n = Number(mb[1]);
    const after = w.s.slice(mb.index + mb[0].length);
    const explicit = Boolean(mb[2]) || /час/i.test(mb[0]) || /^\s*[,.;!?]?\s*$/.test(after);
    if (n <= 23 && (explicit || hasDateContext(w.s))) {
      w.take(bare);
      const h = toMinutes(n, mb[2]);
      if (h !== null) return h * 60;
    }
  }
  if (w.take(rx(`${B}в\\s+обед${E}`))) return 13 * 60;
  if (w.take(rx(`${B}утром${E}`))) return 9 * 60;
  if (w.take(rx(`${B}(?:днём|днем)${E}`))) return 13 * 60;
  if (w.take(rx(`${B}вечером${E}`))) return 19 * 60;
  return null;
}

// ---------- дата ----------

type DatePart =
  | { kind: "day"; y: number; mo: number; d: number; sameWeekday?: boolean }
  | { kind: "dom"; d: number };

function extractDate(w: Work, now: number, tz: string, allowWeekday = true): DatePart | null {
  const nw = wallOf(now, tz);
  const today = civilDay(nw.y, nw.mo, nw.d);
  const dayPart = (offset: number): DatePart => {
    const c = fromCivilDay(today + offset);
    return { kind: "day", y: c.y, mo: c.mo, d: c.d };
  };
  if (w.take(rx(`${B}послезавтра${E}`))) return dayPart(2);
  if (w.take(rx(`${B}завтра${E}`))) return dayPart(1);
  if (w.take(rx(`${B}сегодня${E}`))) return dayPart(0);

  const dm = w.take(rx(`(?<![\\d.:])(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?(?![\\d:])`));
  if (dm) {
    const mo = Number(dm[2]);
    const d = Number(dm[1]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = dm[3] ? Number(dm[3]) : nw.y;
      if (y < 100) y += 2000;
      let part: DatePart = { kind: "day", y, mo, d: Math.min(d, daysInMonth(y, mo)) };
      if (!dm[3] && civilDay(y, mo, part.d) < today) {
        y += 1;
        part = { kind: "day", y, mo, d: Math.min(d, daysInMonth(y, mo)) };
      }
      return part;
    }
  }

  // «20 ноября», «15 марта 2027» — через chrono (ru)
  const ref = new Date(nw.y, nw.mo - 1, nw.d, nw.h, nw.mi);
  const found = chrono.ru.parse(w.s, ref, { forwardDate: true });
  for (const r of found) {
    if (r.start.isCertain("month") && r.start.isCertain("day")) {
      const y = r.start.get("year") ?? nw.y;
      const mo = r.start.get("month") ?? 1;
      const d = r.start.get("day") ?? 1;
      w.s = w.s.slice(0, r.index) + " ".repeat(r.text.length) + w.s.slice(r.index + r.text.length);
      return { kind: "day", y, mo, d };
    }
  }

  if (allowWeekday) {
    const wm = w.take(rx(`(?:${B}(?:в|во|на)\\s+)?(?:(следующ\\p{L}*|эту|этот|ближайш\\p{L}*)\\s+)?${B}(${WD})${E}`));
    if (wm) {
      const wd = weekdayOf(wm[2]);
      let delta = (wd - nw.wd + 7) % 7;
      let sameWeekday = false;
      if (delta === 0) sameWeekday = true;
      if (wm[1] && /^следующ/i.test(wm[1])) {
        delta = delta === 0 ? 7 : delta + (wd > nw.wd ? 7 : 0);
        sameWeekday = false;
      }
      const c = fromCivilDay(today + delta);
      return { kind: "day", y: c.y, mo: c.mo, d: c.d, sameWeekday };
    }
  }

  const dom = w.take(rx(`${B}(\\d{1,2})-?(?:го|е|ое)(?:\\s+числа)?${E}`));
  if (dom) {
    const d = Number(dom[1]);
    if (d >= 1 && d <= 31) return { kind: "dom", d };
  }
  return null;
}

function resolveMoment(
  date: DatePart | null,
  timeMin: number | null,
  defMin: number,
  now: number,
  tz: string,
): { ms: number; past: boolean } | null {
  const nw = wallOf(now, tz);
  const at = (c: { y: number; mo: number; d: number }, m: number) =>
    wallToUtc({ ...c, h: Math.floor(m / 60), mi: m % 60 }, tz);
  if (!date) {
    if (timeMin === null) return null;
    let t = at(nw, timeMin);
    if (t <= now) t = addDaysWall(t, 1, tz);
    return { ms: t, past: false };
  }
  const m = timeMin ?? defMin;
  if (date.kind === "dom") {
    let y = nw.y;
    let mo = nw.mo;
    let t = at({ y, mo, d: clampDay(y, mo, date.d) }, m);
    if (t <= now) {
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
      t = at({ y, mo, d: clampDay(y, mo, date.d) }, m);
    }
    return { ms: t, past: false };
  }
  let t = at(date, m);
  if (date.sameWeekday && t <= now) t = addDaysWall(t, 7, tz);
  return { ms: t, past: t <= now };
}

// ---------- повторы ----------

type Draft = Omit<Recipe, "anchor">;

function extractRecurrence(w: Work): Draft | null {
  // «в последний день месяца», «каждый месяц в последнюю пятницу», «во вторую пятницу месяца»
  let m = w.take(
    rx(`(?:${B}кажд\\p{L}*\\s+месяц\\s+)?(?:${B}(?:в|во)\\s+)?(${ORD})\\s+(${WD})\\s+(?:кажд\\p{L}*\\s+)?месяца${E}`),
  );
  if (!m) {
    m = w.take(rx(`${B}кажд\\p{L}*\\s+месяц\\s+(?:(?:в|во)\\s+)?(${ORD})\\s+(${WD})${E}`));
  }
  if (m) {
    return { freq: "months", interval: 1, nth: { n: ordOf(m[1]), weekday: weekdayOf(m[2]) } };
  }
  if (
    (m = w.take(
      rx(`(?:${B}кажд\\p{L}*\\s+месяц\\s+)?(?:${B}(?:в|во)\\s+)?${B}последн\\p{L}*\\s+(?:день|число)(?:\\s+(?:кажд\\p{L}*\\s+)?месяца)?${E}`),
    ))
  ) {
    return { freq: "months", interval: 1, monthDay: "last" };
  }
  // число месяца: «каждый месяц 20-го», «20-го числа каждого месяца», «каждое 20-е число», «ежемесячно 15-го»
  const domRes = [
    rx(`${B}(\\d{1,2})-?(?:го|е|ое)?(?:\\s+числа)?\\s+кажд\\p{L}*\\s+месяц\\p{L}*${E}`),
    rx(`${B}(?:кажд\\p{L}*\\s+месяц|ежемесячно)\\s*,?\\s*(?:(?:в|на)\\s+)?(\\d{1,2})(?:-?(?:го|е|ое))?(?:\\s+числа)?${E}`),
    rx(`${B}кажд\\p{L}*\\s+(\\d{1,2})-?(?:е|ое|го)?\\s+числ\\p{L}*${E}`),
  ];
  for (const re of domRes) {
    m = w.take(re);
    if (m) {
      const d = Number(m[1]);
      if (d >= 1 && d <= 31) return { freq: "months", interval: 1, monthDay: d };
      return { freq: "months", interval: 1 };
    }
  }
  if (w.take(rx(`${B}(?:кажд\\p{L}*\\s+квартал|раз\\s+в\\s+квартал)${E}`))) return { freq: "months", interval: 3 };
  if (w.take(rx(`${B}(?:кажд\\p{L}*\\s+пол\\s?года|раз\\s+в\\s+пол\\s?года)${E}`))) return { freq: "months", interval: 6 };
  if (w.take(rx(`${B}(?:кажд\\p{L}*\\s+пол\\s?часа|раз\\s+в\\s+пол\\s?часа)${E}`))) return { freq: "minutes", interval: 30 };

  // по дням недели: «по понедельникам и средам», «по будням», «по выходным»
  if (w.take(rx(`${B}(?:по\\s+будн\\p{L}*|в\\s+будни|кажд\\p{L}*\\s+будн\\p{L}*\\s+день)${E}`))) {
    return { freq: "weeks", interval: 1, weekdays: [1, 2, 3, 4, 5] };
  }
  if (w.take(rx(`${B}(?:по\\s+выходн\\p{L}*|в\\s+выходные)${E}`))) {
    return { freq: "weeks", interval: 1, weekdays: [6, 7] };
  }
  m = w.take(rx(`${B}по\\s+(${WD})(?:\\s*(?:,|и)\\s*(${WD}))*(?:\\s*(?:,|и)\\s*(${WD}))*${E}`));
  if (m) {
    const days = [...m[0].matchAll(rx(WD, "giu"))].map((x) => weekdayOf(x[0]));
    return { freq: "weeks", interval: 1, weekdays: [...new Set(days)].sort((a, b) => a - b) };
  }
  // «каждую вторую пятницу» = через неделю в пятницу; «каждый понедельник»
  m = w.take(rx(`${B}кажд\\p{L}*\\s+(?:(втор\\p{L}*|трет\\p{L}*|четв[её]рт\\p{L}*)\\s+)?(${WD})${E}`));
  if (m) {
    const step = m[1] ? ordOf(m[1]) : 1;
    return { freq: "weeks", interval: step, weekdays: [weekdayOf(m[2])] };
  }
  // «каждые 20 минут», «каждый час», «каждые две недели», «раз в 2 недели», «каждый год»
  m = w.take(rx(`${B}(?:кажд\\p{L}*|раз\\s+в)\\s+(?:(${NUMW})\\s*)?(${UNIT})${E}`));
  if (m) {
    const u = unitOf(m[2]);
    if (u) return { freq: u, interval: Math.max(1, Math.round(num(m[1]))) };
  }
  if (w.take(rx(`${B}ежедневно${E}`))) return { freq: "days", interval: 1 };
  if (w.take(rx(`${B}еженедельно${E}`))) return { freq: "weeks", interval: 1 };
  if (w.take(rx(`${B}ежемесячно${E}`))) return { freq: "months", interval: 1 };
  if (w.take(rx(`${B}ежегодно${E}`))) return { freq: "years", interval: 1 };
  return null;
}

// ---------- «через N …» ----------

function extractDuration(w: Work, now: number, tz: string): number | null {
  if (w.take(rx(`${B}через\\s+полчаса${E}`))) return now + 30 * MINUTE;
  if (w.take(rx(`${B}через\\s+полтора\\s+часа${E}`))) return now + 90 * MINUTE;
  const m = w.take(
    rx(`${B}через\\s+(?:(${NUMW})\\s*)?(${UNIT})(?:\\s+(?:и\\s+)?(${NUMW})\\s*(${UNIT}))?${E}`),
  );
  if (!m) return null;
  let t = now;
  for (const [n, u] of [[m[1], m[2]], [m[3], m[4]]] as const) {
    if (!u) continue;
    const unit = unitOf(u);
    if (!unit) continue;
    const k = num(n);
    if (unit === "minutes") t += k * MINUTE;
    else if (unit === "hours") t += k * HOUR;
    else if (unit === "days") t = addDaysWall(t, Math.round(k), tz);
    else if (unit === "weeks") t = addDaysWall(t, Math.round(k * 7), tz);
    else if (unit === "months") t = addMonthsWall(t, Math.round(k), tz);
    else t = addMonthsWall(t, Math.round(k * 12), tz);
  }
  return t;
}

// ---------- заголовок ----------

const STOP = new Set(["в", "во", "на", "к", "ко", "до", "и", "через", "за", "по", "с", "со", "—", "-", ":", ","]);

export function cleanTitle(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:напомни(?:ть)?(?:\s+мне)?|напоминай(?:\s+мне)?)(?![\p{L}\p{N}])\s*[:,—-]?\s*/iu, "");
  s = s.replace(/^(?:что|чтобы)(?![\p{L}\p{N}])\s*/iu, "");
  let tokens = s.split(" ").filter(Boolean);
  const junk = (t: string) => STOP.has(t.toLowerCase().replace(/[,.;:]+$/, "")) || /^[,.;:!?—-]+$/.test(t);
  while (tokens.length && junk(tokens[0])) tokens = tokens.slice(1);
  while (tokens.length && junk(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  s = tokens.join(" ").replace(/^[,.;:—\s-]+|[,;:—\s-]+$/g, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- главный разбор ----------

export function parseInput(text: string, opts: ParseOptions): Parsed {
  const { now, tz } = opts;
  const defMin = opts.defaultTime ?? 9 * 60;
  const w = new Work(text);

  // «заранее»
  const leadDays: number[] = [];
  const leadWeeks = w.take(rx(`${B}(?:заранее\\s+)?за\\s+(?:(${NUMW})\\s*)?недел\\p{L}*${E}`));
  if (leadWeeks) leadDays.push(Math.round(num(leadWeeks[1]) * 7));
  const leadM = w.take(
    rx(`${B}(?:заранее\\s+)?за\\s+(\\d+(?:\\s*(?:,|и)\\s*\\d+)*)\\s*(?:дн(?:я|ей)|день)${E}`),
  );
  if (leadM) {
    for (const n of leadM[1].match(/\d+/g) ?? []) leadDays.push(Number(n));
  }
  w.take(rx(`${B}(?:и\\s+)?в\\s+день\\s+срока${E}`));
  const critical = Boolean(w.take(rx(`${B}(?:критичн\\p{L}*|пробивающ\\p{L}*)${E}`)));

  // повтор
  const draft = extractRecurrence(w);

  // «до 23:00» / «до 25 декабря» — только у повторяющихся
  let until: number | undefined;
  if (draft) {
    const um = /(?:^|\s)до\s+(\S.*)$/iu.exec(w.s);
    if (um) {
      const startIdx = um.index + um[0].indexOf("до");
      const tail = new Work(w.s.slice(startIdx + 2));
      const tTime = extractTime(tail);
      const tDate = extractDate(tail, now, tz);
      const r = resolveMoment(tDate, tTime, 23 * 60 + 59, now, tz);
      if (r) {
        until = r.ms;
        w.s = w.s.slice(0, startIdx) + " ".repeat(2) + tail.s;
      }
    }
  }

  // «через N …»
  const durationDue = draft ? null : extractDuration(w, now, tz);

  const timeMin = extractTime(w);
  const date = extractDate(w, now, tz);

  let due: number | null = null;
  let past = false;
  let recipe: Recipe | null = null;
  let seriesEmpty = false;

  if (draft) {
    // дни недели, названные отдельно от «каждую неделю»
    if (draft.freq === "weeks" && !draft.weekdays && date?.kind === "day") {
      const wdAt = fromCivilDay(civilDay(date.y, date.mo, date.d)).wd;
      draft.weekdays = [wdAt];
    }
    if (draft.freq === "months" && draft.monthDay === undefined && !draft.nth && date) {
      if (date.kind === "dom") draft.monthDay = date.d;
      else if (date.kind === "day") draft.monthDay = date.d;
    }
    if (draft.freq === "years" && date?.kind === "day") {
      draft.month = date.mo;
      draft.monthDay = date.d;
    }
    if (draft.freq !== "minutes" && draft.freq !== "hours") {
      const tm = timeMin ?? defMin;
      draft.at = { h: Math.floor(tm / 60), mi: tm % 60 };
    }
    if (until !== undefined) draft.until = until;
    const started = startSeries(draft, now, tz);
    if (started) {
      recipe = started.recipe;
      due = started.first;
    } else {
      seriesEmpty = true;
    }
  } else if (durationDue !== null) {
    due = durationDue;
    if (timeMin !== null && durationDue - now >= DAY) {
      const ow = wallOf(durationDue, tz);
      due = wallToUtc({ y: ow.y, mo: ow.mo, d: ow.d, h: Math.floor(timeMin / 60), mi: timeMin % 60 }, tz);
    }
  } else {
    const r = resolveMoment(date, timeMin, defMin, now, tz);
    if (r) {
      due = r.ms;
      past = r.past;
    }
  }

  return {
    title: cleanTitle(w.s),
    due,
    past,
    recipe,
    leadDays: [...new Set(leadDays)].filter((n) => n > 0).sort((a, b) => b - a),
    critical,
    timer: recipe !== null && (recipe.freq === "minutes" || recipe.freq === "hours"),
    seriesEmpty,
  };
}

/** Только время («завтра 10:30», «через час») — для «На…», /snooze и «Изменить». */
export function parseWhen(text: string, opts: ParseOptions): { due: number; past: boolean } | null {
  const p = parseInput(text, opts);
  if (p.due === null || p.recipe) return null;
  return { due: p.due, past: p.past };
}

/** `/every 20 минут плита` -> «каждые 20 минут плита». */
export function normalizeEvery(text: string): string {
  const t = text.trim();
  if (/^(?:кажд|ежед|ежен|раз\s+в|по\s)/iu.test(t)) return t;
  if (/^\d/.test(t) || rx(`^(?:${NUMW})\\s+(?:${UNIT})`).test(t)) return `каждые ${t}`;
  return t;
}
