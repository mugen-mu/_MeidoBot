// Особые дни и интересы хозяина для реплик Хару (этап 2 «Характер»). ТОЛЬКО ДАННЫЕ и чистые функции.
// День рождения хозяина пока не задан (даты нет): заготовка готова, настройка `birthday` («месяц.день») читается, интерфейса для неё нет.
// Дни рождения близких (этап 2 — заготовка, этап 5 подключит список): `Person` (имя и дата), `parsePeopleDates`, третий аргумент `occasionFor`.

/**
 * Чем интересуется хозяин (анкета вкусов, ответы 2026-11-17/18): Хару вворачивает это в шутки (не в каждой реплике).
 * Только общее: жанры, типажи, штампы, музыка. Названий его тайтлов и отметок здесь нет (личное хранится вне git).
 * Всё кириллицей: ответ модели с латиницей отбраковывается (`cleanLine`), поэтому «джей-поп», а не «J-pop».
 */
export const INTEREST_TOPICS: Record<"genres" | "types" | "tropes" | "memes" | "music", string[]> = {
  /** жанры, которые он любит */
  genres: [
    "романтическая комедия", "исэкай и фэнтези", "повседневность", "юри", "сэйнэн и дзёсэй", "этти и гарем", "мрачная и тёплая атмосфера",
    "приключения и подземелья", "злодейка и брак по контракту", "ведьма с лавкой зелий",
  ],
  /** любимые типажи героев и горничных */
  types: [
    "цундере", "яндере понарошку", "кудере", "горничная, чопорная или цундере", "усталый герой, который всё равно справляется",
    "сильный и холодный герой с трагичным прошлым", "герой с толпой поклонниц", "дядя из другого мира",
  ],
  /** сюжетные штампы, над которыми можно подшутить с любовью */
  tropes: [
    "арка с турниром", "сила дружбы", "эпизод на пляже", "эпизод с горячими источниками", "филлер, который все пропускают",
    "тренировочная арка", "внезапный поворот в конце серии", "обещание «вернусь», которое не выполнят",
  ],
  /** цитаты и мемы: говорить словами героя, не называя источник (хозяин любит угадывать) */
  memes: [
    "«это не то, что вы подумали!»", "«я совсем не рада»", "«ещё одну серию и спать»", "«дело не в вас, просто так вышло»",
    "драматичное «я вернусь»", "«наконец-то мой выход»", "усталое «я просто хотел спокойной жизни»", "«это всего лишь царапина»",
  ],
  /** музыка любимых групп */
  music: ["рок из любимых опенингов", "джей-поп на повторе", "опенинг, который застрял в голове", "эндинг под настроение", "громкий гитарный проигрыш"],
};

/** Весь список (для проверок и подсказки модели): аниме плюс всё из `INTEREST_TOPICS`. */
export const INTERESTS: string[] = ["аниме", ...Object.values(INTEREST_TOPICS).flat()];

/**
 * Шанс упомянуть интересы в одной реплике. Хозяин сказал, что аниме в репликах нужно «часто» (анкета 2026-11-17), но «аниме в каждой шутке надоест»:
 * подняли с 0,3 до 0,5, а темы теперь меняются от реплики к реплике (`pickInterests`). «Тихий день» и мелочь/серьёзное (`INTEREST_FREE`) по-прежнему без отсылок.
 */
export const INTEREST_CHANCE = 0.5;

/** Ситуации без отсылок: серьёзные (важный пропуск, свет, источники, погода) и самая короткая мелочь. Там Хару держится фактов. */
export const INTEREST_FREE: ReadonlySet<string> = new Set([
  "missed_major", "done_major", "missed_minor", "done_minor", "power_off", "power_on", "source_down", "source_week",
  "rain_start", "rain_end", "rain_early", "weather_ask", "heavy_day",
]);

/**
 * Что вворачивать в этой реплике: слово «аниме» и две темы из разных групп (жанр, типаж, штамп, мем или музыка).
 * Другие темы каждый раз, чтобы отсылки не слипались в одну и ту же; выбор зависит только от `rand`.
 */
export function pickInterests(rand: () => number): string[] {
  const groups = Object.values(INTEREST_TOPICS);
  const at = (n: number): number => Math.min(n - 1, Math.floor(rand() * n));
  const first = at(groups.length);
  const second = (first + 1 + at(groups.length - 1)) % groups.length;
  return ["аниме", ...[first, second].map((g) => groups[g][at(groups[g].length)])];
}

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

/** Близкий человек: в базе только имя и дата (F5), без фамилии и телефона. Заготовка под этап 5 «Календарь сюрпризов»: списка в настройках пока нет. */
export interface Person {
  name: string;
  mo: number;
  d: number;
}

/** «Мама 11.20», «Андрей 3.5.1990», по строке на человека; плохие строки пропускаются; год отбрасывается. */
export function parsePeopleDates(text: string | undefined | null): Person[] {
  const out: Person[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = /^(.{1,40}?)\s+(\d{1,2})\.(\d{1,2})(?:\.\d{2,4})?$/u.exec(line.trim());
    if (!m) continue;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push({ name: m[1].trim(), mo, d });
  }
  return out;
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
export function occasionFor(today: { y: number; mo: number; d: number }, birthday: MonthDay | null = null, people: Person[] = []): Occasion | null {
  if (birthday) {
    const n = daysUntil(today, birthday);
    if (n === 0) return { situation: "holiday", label: "день рождения хозяина (сегодня!)" };
    if (n === 1) return { situation: "birthday_soon", label: "день рождения хозяина уже завтра" };
    if (n === 7) return { situation: "birthday_soon", label: "день рождения хозяина через неделю" };
  }
  for (const p of people) {
    const n = daysUntil(today, p);
    if (n === 0) return { situation: "holiday", label: `день рождения: ${p.name} (сегодня!)` };
    if (n === 1) return { situation: "birthday_soon", label: `день рождения: ${p.name} уже завтра` };
    if (n === 7) return { situation: "birthday_soon", label: `день рождения: ${p.name} через неделю` };
  }
  const h = HOLIDAYS.find((x) => x.mo === today.mo && x.d === today.d);
  return h ? { situation: "holiday", label: h.label } : null;
}
