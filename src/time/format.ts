// Человеческие подписи времени и правил повтора («завтра, 10:00», «каждую вторую пятницу в 15:00»).
import type { Recipe } from "../recur.ts";
import { civilDay, fmtHHMM, wallOf } from "./tz.ts";

const WD_ACC = ["", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу", "в воскресенье"];
const WD_DAT = ["", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям"];
const WD_NOM = ["", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
/** род: m / f / n — для «каждый / каждую / каждое» */
const WD_GENDER = ["", "m", "m", "f", "m", "f", "f", "n"];
const ORD_FORMS: Record<number, [string, string, string]> = {
  2: ["второй", "вторую", "второе"],
  3: ["третий", "третью", "третье"],
  4: ["четвёртый", "четвёртую", "четвёртое"],
};

function hhmm(ms: number, tz: string): string {
  const w = wallOf(ms, tz);
  return fmtHHMM(w.h * 60 + w.mi);
}

export function formatDate(ms: number, now: number, tz: string): string {
  const w = wallOf(ms, tz);
  const n = wallOf(now, tz);
  const diff = civilDay(w.y, w.mo, w.d) - civilDay(n.y, n.mo, n.d);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff === -1) return "вчера";
  if (diff > 1 && diff < 7) return WD_ACC[w.wd];
  return usDate(w.y, w.mo, w.d);
}

/** Американский формат месяц.день.год: «11.20.2026» (решение пользователя 2026-11-08, везде). */
export function usDate(y: number, mo: number, d: number): string {
  return `${String(mo).padStart(2, "0")}.${String(d).padStart(2, "0")}.${y}`;
}

/** «завтра, 10:00»; для близкого будущего — «через 20 мин, 14:35». */
export function formatWhen(ms: number, now: number, tz: string): string {
  const delta = ms - now;
  if (delta > 0 && delta < 60 * 60_000) {
    return `через ${Math.max(1, Math.round(delta / 60_000))} мин, ${hhmm(ms, tz)}`;
  }
  return `${formatDate(ms, now, tz)}, ${hhmm(ms, tz)}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function kazhd(gender: string): string {
  return gender === "f" ? "каждую" : gender === "n" ? "каждое" : "каждый";
}

export function describeRecipe(r: Recipe, tz: string): string {
  const n = r.interval;
  const at = r.at ? ` в ${fmtHHMM(r.at.h * 60 + r.at.mi)}` : "";
  let s: string;
  switch (r.freq) {
    case "minutes":
      s = n === 1 ? "каждую минуту" : `каждые ${n} ${plural(n, "минуту", "минуты", "минут")}`;
      break;
    case "hours":
      s = n === 1 ? "каждый час" : `каждые ${n} ${plural(n, "час", "часа", "часов")}`;
      break;
    case "days":
      s = (n === 1 ? "каждый день" : `каждые ${n} ${plural(n, "день", "дня", "дней")}`) + at;
      break;
    case "weeks": {
      const wds = r.weekdays ?? [];
      const key = wds.join(",");
      if (key === "1,2,3,4,5") s = "по будням" + at;
      else if (key === "6,7") s = "по выходным" + at;
      else if (wds.length === 1) {
        const g = WD_GENDER[wds[0]];
        const ord = n > 1 && ORD_FORMS[n] ? ` ${ORD_FORMS[n][g === "f" ? 1 : g === "n" ? 2 : 0]}` : "";
        s = `${kazhd(g)}${ord} ${WD_NOM[wds[0]]}${at}`;
      } else if (wds.length > 1) {
        s = `по ${wds.map((d) => WD_DAT[d]).join(" и ")}${n > 1 ? `, раз в ${n} ${plural(n, "неделю", "недели", "недель")}` : ""}${at}`;
      } else {
        s = (n === 1 ? "каждую неделю" : `каждые ${n} ${plural(n, "неделю", "недели", "недель")}`) + at;
      }
      break;
    }
    case "months": {
      let head: string;
      if (n === 3 && !r.monthDay && !r.nth) head = "каждый квартал";
      else if (n === 6 && !r.monthDay && !r.nth) head = "раз в полгода";
      else head = n === 1 ? "каждый месяц" : `каждые ${n} ${plural(n, "месяц", "месяца", "месяцев")}`;
      if (r.nth) {
        const ord = r.nth.n === -1 ? "последнюю" : ["", "первую", "вторую", "третью", "четвёртую"][r.nth.n];
        head += ` в ${ord} ${WD_NOM[r.nth.weekday]}`;
      } else if (r.monthDay === "last") head += " в последний день";
      else if (typeof r.monthDay === "number") head += ` ${r.monthDay}-го`;
      s = head + at;
      break;
    }
    default: {
      const w = wallOf(r.anchor, tz);
      const d = typeof r.monthDay === "number" ? r.monthDay : w.d;
      const mo = r.month ?? w.mo;
      s = `${n === 1 ? "каждый год" : `каждые ${n} ${plural(n, "год", "года", "лет")}`} ${String(mo).padStart(2, "0")}.${String(d).padStart(2, "0")}${at}`;
    }
  }
  if (r.until !== undefined) s += `, до ${hhmm(r.until, tz)}`;
  return s;
}

/** «за 7, 3 и 1 день» */
export function describeLead(days: number[]): string {
  if (days.length === 0) return "";
  const last = days[days.length - 1];
  const list = days.length === 1 ? String(days[0]) : `${days.slice(0, -1).join(", ")} и ${last}`;
  return `за ${list} ${plural(last, "день", "дня", "дней")}`;
}
