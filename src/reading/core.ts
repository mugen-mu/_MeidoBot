// Чтение (манга и ранобэ): чистые функции без базы и сети — состояния, «сколько накопилось», выбор для субботнего сообщения, реплики Хару.
// Решения Ihor по анкете вкусов (волна 2): сообщать о «Читаю сейчас», «Жду продолжения» и любимом; раз в неделю по субботам; начать с малого.
import type { Character } from "../flavor.ts";
import { DAY, addDaysWall, localDate, wallOf } from "../time/tz.ts";

export type ReadKind = "manga" | "ranobe";
export type ReadStatus = "reading" | "planned" | "done" | "dropped" | "waiting";
/** ch — главами, vol — томами */
export type ReadUnit = "ch" | "vol";

/** Строка таблицы `reading` (миграция 0011); поля подробно описаны в самой миграции. */
export interface Reading {
  id: number;
  mal_id: number;
  kind: ReadKind;
  title_ru: string;
  title_orig: string | null;
  status: ReadStatus;
  unit: ReadUnit;
  read_ch: number | null;
  read_vol: number | null;
  liked: number;
  total_ch: number | null;
  total_vol: number | null;
  src_status: string | null;
  src_ch: number;
  src_vol: number;
  src_at: number | null;
  /** последняя глава и том по-русски (манга: MangaDex, `ru`; ранобэ: RanobeHub, справочно). null — ещё не смотрела, 0 — смотрела, перевода нет */
  ru_ch: number | null;
  ru_vol: number | null;
  src_url: string | null;
  md_id: string | null;
  mu_id: number | null;
  map_at: number | null;
  /** RanobeHub (ранобэ): номер тайтла и когда искала его там */
  rh_id: number | null;
  rh_map_at: number | null;
  checked_at: number | null;
  chk_fail: number;
  shiki_at: number | null;
  told_ch: number;
  told_vol: number;
  end_told: number;
  adapt_mal: number | null;
  adapt_ru: string | null;
  adapt_status: string | null;
  adapt_at: number | null;
  adapt_told: string | null;
  weekq_at: number | null;
  last_move_at: number | null;
  added_at: number;
  updated_at: number;
}

export const STATUS_LABEL: Record<ReadStatus, string> = { reading: "Читаю", waiting: "Жду продолжения", planned: "В планах", done: "Дочитал", dropped: "Бросил" };
export const KIND_WORD: Record<ReadKind, string> = { manga: "манга", ranobe: "ранобэ" };

/** Сколько тайтлов в «Читаю» и «Жду продолжения» бот сам проверяет и про сколько пишет. «Сначала посмотрим, как получится» (Ihor): начинаем с малого. */
export const TRACK_LIMIT = 10;
/** Сколько тайтлов подробно в одном субботнем сообщении (остальное — одной строкой; «если накопилось много, решает Хару»). */
export const WEEK_SHOWN = 3;

export const norm = (s: string): string => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** «1 глава», «2 главы», «5 глав». */
export function plural(n: number, one: string, few: string, many: string): string {
  const t = n % 100;
  const u = n % 10;
  return t >= 11 && t <= 14 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
}
export const chaptersText = (n: number): string => `${n} ${plural(n, "глава", "главы", "глав")}`;
export const volumesText = (n: number): string => `${n} ${plural(n, "том", "тома", "томов")}`;
export const unitText = (n: number, unit: ReadUnit): string => (unit === "ch" ? chaptersText(n) : volumesText(n));
/** «глава 120» / «том 5» (именительный, номер после слова). */
export const unitLabel = (n: number, unit: ReadUnit): string => `${unit === "ch" ? "глава" : "том"} ${n}`;

export const defaultUnit = (kind: ReadKind): ReadUnit => (kind === "ranobe" ? "vol" : "ch");

export const readOf = (r: Reading, unit: ReadUnit = r.unit): number | null => (unit === "ch" ? r.read_ch : r.read_vol);
export const srcOf = (r: Reading, unit: ReadUnit = r.unit): number => (unit === "ch" ? r.src_ch : r.src_vol);
export const totalOf = (r: Reading, unit: ReadUnit = r.unit): number | null => (unit === "ch" ? r.total_ch : r.total_vol);

/**
 * Что у тайтла «вышло» для разговора с хозяином (решение Ihor 2026-11-18: «писать только когда глава есть по-русски»).
 * Манга — только русский перевод на MangaDex (`ru_ch`, `ru_vol`): главы и тома, которых нет по-русски, не поднимают «накопилось» и не упоминаются.
 * Ранобэ — по-прежнему счётчик источника (MangaUpdates: язык там не различается); RanobeHub для ранобэ — только справочная строка.
 */
export function availOf(r: Reading, unit: ReadUnit = r.unit): number {
  if (r.kind === "manga") return (unit === "ch" ? r.ru_ch : r.ru_vol) ?? 0;
  return srcOf(r, unit);
}

/** Есть ли у манги хоть что-то по-русски (по MangaDex). У ранобэ вопрос не стоит: правило языка там не действует. */
export const hasRussian = (r: Reading): boolean => r.kind !== "manga" || (r.ru_ch ?? 0) > 0 || (r.ru_vol ?? 0) > 0;

/** Манга, которую смотрели на MangaDex, а русского перевода там нет: о ней молчим, пока он не появится. */
export const noRussianYet = (r: Reading): boolean => r.kind === "manga" && r.ru_ch !== null && !hasRussian(r);

/** «до главы 150» / «до тома 25» (родительный, для «по-русски до … на …»). */
export const upTo = (n: number, unit: ReadUnit): string => `до ${unit === "ch" ? "главы" : "тома"} ${n}`;

/** Сколько накопилось: что вышло (по-русски — у манги) минус прочитанное. null — не знаем, на чём хозяин остановился, или счётчика нет. */
export function unread(r: Reading): number | null {
  const have = readOf(r);
  const top = availOf(r);
  return have !== null && top > 0 ? Math.max(0, top - have) : null;
}

/** Тайтлы, про которые бот пишет и которые проверяет по ночам: «Читаю», «Жду продолжения» и любимое (в восторге, дочитано, но продолжается). */
export const isTracked = (r: Reading): boolean => r.status === "reading" || r.status === "waiting" || (r.status === "done" && r.liked >= 2 && r.src_status !== "finished");

/** Тайтл идёт или закончен по данным источника. */
export const isFinished = (r: Reading): boolean => r.src_status === "finished";

/** За кем бот следит: отслеживаемые тайтлы, не больше TRACK_LIMIT (первые по порядку добавления). */
export const trackedSet = (rows: Reading[]): Reading[] => rows.filter(isTracked).sort((x, y) => x.id - y.id).slice(0, TRACK_LIMIT);

// ---------- поиск в своём списке ----------

/** Подходящие тайтлы из своего списка по названию (русскому или оригинальному); `kind` сужает до манги или ранобэ. Точное совпадение важнее частичного. */
export function ownMatches(rows: Reading[], query: string, kind: ReadKind | null): Reading[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const pool = kind ? rows.filter((r) => r.kind === kind) : rows;
  const exact = pool.filter((r) => norm(r.title_ru) === q || norm(r.title_orig ?? "") === q);
  if (exact.length) return exact;
  if (q.length < 4) return [];
  return pool.filter((r) => norm(r.title_ru).includes(q) || norm(r.title_orig ?? "").includes(q));
}

// ---------- время ----------

/** Ключ недели: дата её понедельника по часам пояса (чтобы не слать субботнее сообщение дважды за неделю, даже если день поменяли в настройках). */
export function weekKey(now: number, tz: string): string {
  return localDate(addDaysWall(now, -(wallOf(now, tz).wd - 1), tz), tz);
}

/** Сколько недель прошло, словами: «3 недели». */
export function weeksText(ms: number): string {
  const n = Math.max(1, Math.round(ms / (7 * DAY)));
  return `${n} ${plural(n, "неделю", "недели", "недель")}`;
}

/** Через сколько недель без движения «Читаю» считаем застоявшимся и один раз спрашиваем, продолжает ли хозяин. */
export const IDLE_WEEKS = 8;
const IDLE_MS = IDLE_WEEKS * 7 * DAY;

/** Тайтл «Читаю», который давно не двигался (самый давний из таких), если про него ещё не спрашивали в эти недели. */
export function idleTitle(rows: Reading[], now: number): Reading | null {
  const moved = (r: Reading): number => r.last_move_at ?? r.added_at;
  const idle = rows.filter((r) => r.status === "reading" && now - moved(r) >= IDLE_MS && (r.weekq_at === null || now - r.weekq_at >= IDLE_MS));
  return idle.sort((x, y) => moved(x) - moved(y) || x.id - y.id)[0] ?? null;
}

// ---------- субботний выбор ----------

export interface WeekItem {
  r: Reading;
  /** с прошлого сообщения вышла новая глава / новый том (по росту счётчика у источника) */
  newCh: boolean;
  newVol: boolean;
  /** сколько накопилось (null — хозяин не говорил, где остановился, или счётчика нет) */
  unread: number | null;
  /** тайтл закончился, а я ещё не писала об этом */
  ended: boolean;
}

/** Что просится в субботнее сообщение: новое по-русски (у манги), завершение или накопленное непрочитанное. Только отслеживаемые тайтлы; манга без русского перевода молчит целиком. */
export function weekItems(rows: Reading[]): WeekItem[] {
  const out: WeekItem[] = [];
  for (const r of rows) {
    if (!isTracked(r) || !hasRussian(r)) continue;
    const it: WeekItem = { r, newCh: availOf(r, "ch") > r.told_ch, newVol: availOf(r, "vol") > r.told_vol, unread: unread(r), ended: isFinished(r) && !r.end_told };
    if (it.ended || it.newCh || it.newVol || (it.unread ?? 0) > 0) out.push(it);
  }
  return out;
}

/** Порядок «решает Хару»: сначала закончившееся, любимое, с новой главой, «Читаю» раньше «Жду продолжения», где накопилось меньше (ближе догнать). */
export function rankWeek(items: WeekItem[]): WeekItem[] {
  const key = (x: WeekItem): number[] => [x.ended ? 0 : 1, -x.r.liked, x.newCh || x.newVol ? 0 : 1, x.r.status === "reading" ? 0 : 1, x.unread ?? 9999, x.r.id];
  return [...items].sort((x, y) => {
    const a = key(x);
    const b = key(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
}

/** Аниме по манге или ранобэ, о котором ещё не писали (идёт сейчас или анонсировано). */
export const adaptKey = (r: Reading): string | null => (r.adapt_mal && (r.adapt_status === "ongoing" || r.adapt_status === "anons") ? `${r.adapt_mal}:${r.adapt_status}` : null);
export const adaptNew = (r: Reading): boolean => {
  const k = adaptKey(r);
  return k !== null && r.adapt_told !== k;
};

// ---------- реплики Хару ----------

type LineKind = "weekIntro" | "scene" | "readAck" | "added" | "dropped" | "caughtUp" | "finished" | "adapt" | "idle" | "listEmpty" | "list";

const LINES: Record<LineKind, string[]> = {
  weekIntro: [
    "Я заглянула на вашу полку. Просто мимо проходила.",
    "Тут кое-что накопилось. Я не давлю, я констатирую.",
    "Суббота. Самое время для томика. Я свой уже взяла.",
    "Пока вы были заняты, вышло новое. Оно подождёт. Недолго.",
  ],
  scene: [
    "*Хару сидит рядом с томиком и делает вид, что читает не ту же страницу.*",
    "*Хару тихо переворачивает страницу, чтобы не мешать, и мешает.*",
    "*Хару поставила чайник и устроилась у лампы с книгой. Чай, разумеется, остыл.*",
    "*Хару загнула уголок страницы и тут же виновато разгладила.*",
    "*Хару прислонилась к вашему плечу с томиком. Случайно. Совсем.*",
    "*Хару достала закладку и долго выбирала, куда её положить.*",
  ],
  readAck: ["Записала. Закладка на месте.", "Принято. Страницы не убегут, но я присмотрю.", "Хорошо. Следующая глава подождёт.", "Отметила. Читайте не спеша."],
  added: ["Положила на полку. Я запомню, где вы остановились.", "Записала. Ящик «Читаю» пополнился."],
  dropped: ["Бросили так бросили. Закладку я не выкину. Пока.", "Понимаю. Не всё стоит времени."],
  caughtUp: ["Вы догнали. Теперь я жду вместе с вами.", "До последней дочитали. Дальше только ждать, это я умею."],
  finished: ["Дочитали до конца. Тишина после последней страницы самая громкая."],
  adapt: [
    "В манге дальше интереснее, чем в аниме. Это не спойлер, это наблюдение.",
    "В оригинале лучше. Я не спорю, я просто права.",
    "Аниме — это хорошо. Но томик пахнет бумагой. Я проверяла.",
  ],
  idle: ["Не давлю. Просто закладка соскучилась.", "Я не осуждаю. Я наблюдаю."],
  listEmpty: ["Полка пока пустая. Скажите, что читаете, и я запомню."],
  list: ["Вот что у вас на полке. Я ничего не потеряла.", "Всё на месте. Закладки тоже."],
};

/** Короткая реплика Хару: только при характере «горничная». */
export function haru(kind: LineKind, character: Character, rand: () => number = Math.random): string | null {
  if (character !== "maid") return null;
  const pool = LINES[kind];
  return pool[Math.floor(rand() * pool.length) % pool.length];
}
