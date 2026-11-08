// Особые дни и интересы хозяина для реплик Хару (этап 2 «Характер»). ТОЛЬКО ДАННЫЕ и чистые функции.
// День рождения хозяина пока не задан (даты нет): заготовка готова, настройка `birthday` («месяц.день») читается, интерфейса для неё нет.

/** Чем интересуется хозяин: Хару вворачивает это в шутки (не в каждой реплике). Дальше сюда добавятся коллекция аниме и т. п. */
export const INTERESTS: string[] = ["аниме"];

/** Шанс упомянуть интересы в одной реплике (без перебора: «аниме» в каждой шутке надоест). */
export const INTEREST_CHANCE = 0.3;

export interface MonthDay {
  mo: number;
  d: number;
}

/** Праздники: только весёлые и нейтральные, без политики и датам памяти (там Хару молчит и не шутит). */
export const HOLIDAYS: { mo: number; d: number; label: string }[] = [
  { mo: 1, d: 1, label: "Новый год" },
  { mo: 2, d: 14, label: "День святого Валентина" },
  { mo: 3, d: 8, label: "Восьмое марта" },
  { mo: 4, d: 1, label: "День смеха, первое апреля" },
  { mo: 10, d: 31, label: "Хэллоуин" },
  { mo: 12, d: 25, label: "Рождество" },
  { mo: 12, d: 31, label: "канун Нового года" },
];

/** «11.20» или «11.20.1990» → {mo, d}; иначе null. */
export function parseBirthday(raw: string | undefined | null): MonthDay | null {
  const m = /^(\d{1,2})\.(\d{1,2})(?:\.\d{2,4})?$/.exec((raw ?? "").trim());
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { mo, d } : null;
}

export interface Occasion {
  /** ситуация фразы: праздник и «скоро день рождения» */
  situation: "holiday" | "birthday_soon";
  /** как назвать повод в запросе к модели */
  label: string;
}

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Сколько дней от сегодняшней даты до следующей даты bd (0 — сегодня). Год не важен: 29 февраля считаем как есть. */
export function daysUntil(today: { y: number; mo: number; d: number }, bd: MonthDay): number {
  const t = Date.UTC(2001, today.mo - 1, Math.min(today.d, DAYS_IN_MONTH[today.mo]));
  let target = Date.UTC(2001, bd.mo - 1, Math.min(bd.d, DAYS_IN_MONTH[bd.mo]));
  if (target < t) target = Date.UTC(2002, bd.mo - 1, Math.min(bd.d, DAYS_IN_MONTH[bd.mo]));
  return Math.round((target - t) / 86_400_000);
}

/** Особый повод на сегодня: день рождения (сегодня), скоро день рождения (за 7 и за 1 день), иначе праздник; иначе null. */
export function occasionFor(today: { y: number; mo: number; d: number }, birthday: MonthDay | null = null): Occasion | null {
  if (birthday) {
    const n = daysUntil(today, birthday);
    if (n === 0) return { situation: "holiday", label: "день рождения хозяина (сегодня!)" };
    if (n === 1) return { situation: "birthday_soon", label: "день рождения хозяина уже завтра" };
    if (n === 7) return { situation: "birthday_soon", label: "день рождения хозяина через неделю" };
  }
  const h = HOLIDAYS.find((x) => x.mo === today.mo && x.d === today.d);
  return h ? { situation: "holiday", label: h.label } : null;
}
