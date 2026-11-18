// Жанры для субботней подборки (чистые функции, без базы и сети).
// Жанры Shikimori сопоставляем по названию (английскому и русскому), а не по номеру: номера жанров у сайта уже менялись.
// Стартовые «любит / обходим» — слова Ihor из анкеты вкусов (docs/DECISIONS.md, 2026-11-17/18); меняются записью в настройках
// (`pick_genres`, `pick_avoid`), списки тайтлов из анкеты в код не вшиты.

export const GENRE_KEYS = ["romance", "fantasy", "isekai", "comedy", "slice", "ecchi", "harem", "horror", "mecha", "space", "bl"] as const;
export type GenreKey = (typeof GENRE_KEYS)[number];

/** Русское слово для сообщения («романтика, комедия»). */
export const GENRE_LABEL: Record<GenreKey, string> = {
  romance: "романтика",
  fantasy: "фэнтези",
  isekai: "исэкай",
  comedy: "комедия",
  slice: "повседневность",
  ecchi: "этти",
  harem: "гарем",
  horror: "ужасы",
  mecha: "меха",
  space: "космос",
  bl: "BL",
};

const TESTS: Record<GenreKey, RegExp> = {
  romance: /romance|романт/,
  fantasy: /fantasy|фэнтези|фентези/,
  isekai: /isekai|исэкай|исекай/,
  comedy: /^comedy$|комеди/,
  slice: /slice of life|повседнев/,
  ecchi: /ecchi|этти/,
  harem: /harem|гарем/,
  horror: /horror|ужас/,
  mecha: /mecha|меха/,
  space: /^space$|космос/,
  bl: /yaoi|shounen[ -]?ai|boys[ -]?love|яой|с[еэ]н[еэ]н[ -]?ай|бойз/,
};

/**
 * Номера жанров Shikimori (сверено с /api/genres 2026-11-18): нужны, чтобы просить у сайта «жанр такой-то, но без таких-то».
 * У Shikimori нет жанра «исэкай» (у новых тайтлов жанры вообще часто пусты), поэтому у isekai номеров нет: такое попадает под «фэнтези».
 */
export const GENRE_IDS: Record<GenreKey, number[]> = {
  romance: [22], fantasy: [10], isekai: [], comedy: [4], slice: [36], ecchi: [9], harem: [35], horror: [14], mecha: [18], space: [29], bl: [33, 28],
};
/** Хентай и «эротика»: исключаем из любого запроса. */
const ADULT_IDS = [12, 539];

/** Часть запроса про жанры, которых в ответе быть не должно: «!14,!18,…» (обходимые из настроек и взрослое). */
export const excludeParam = (avoid: GenreKey[]): string => [...new Set([...avoid.flatMap((k) => GENRE_IDS[k]), ...ADULT_IDS])].map((id) => `!${id}`).join(",");

/** Взрослое (хентай) не предлагаем никогда, даже если убрать из настроек. Этти — это не оно. */
const ADULT = /hentai|хентай|erotica|эротика/;

const flat = (s: string): string => s.toLowerCase().replace(/ё/g, "е").trim();

/** Какие из наших жанров есть у тайтла (по списку названий жанров Shikimori) и не взрослое ли это. */
export function classify(names: string[]): { keys: Set<GenreKey>; adult: boolean } {
  const keys = new Set<GenreKey>();
  let adult = false;
  for (const raw of names) {
    const n = flat(raw);
    if (!n) continue;
    if (ADULT.test(n)) adult = true;
    for (const k of GENRE_KEYS) if (TESTS[k].test(n)) keys.add(k);
  }
  return { keys, adult };
}

/** Что Ihor любит (стартовые значения настройки `pick_genres`). */
export const DEFAULT_LIKES: GenreKey[] = ["romance", "fantasy", "isekai", "comedy", "slice", "ecchi", "harem"];
/** Что не предлагаем (стартовые значения `pick_avoid`): красные линии (ужасы, меха) и нелюбимое (космос, BL). */
export const DEFAULT_AVOID: GenreKey[] = ["horror", "mecha", "space", "bl"];
/** О чём предупреждаем, если оно всё-таки попало в подборку (только ужасы и меха; решение Ihor, волна 3). */
export const WARN_GENRES: GenreKey[] = ["horror", "mecha"];

/** Значение настройки: «romance, fantasy» → список; нет значения — стартовый; «off» / «-» — пусто; незнакомые слова пропускаем. */
export function parseGenreList(raw: string | undefined, fallback: GenreKey[]): GenreKey[] {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "off" || v === "-" || v === "выкл") return [];
  const out: GenreKey[] = [];
  for (const w of v.split(/[\s,;]+/)) if ((GENRE_KEYS as readonly string[]).includes(w) && !out.includes(w as GenreKey)) out.push(w as GenreKey);
  return out.length ? out : fallback;
}

/** Время субботней подборки по умолчанию (минут от полуночи): 12:00. Лежит здесь, а не в pick.ts, чтобы settings.ts не тянул за собой весь вид сообщений. */
export const PICK_AT = 12 * 60;
/** Что перебирает кнопка в «⋯ Ещё» (после последнего — «выкл»). */
export const PICK_TIMES = [12 * 60, 18 * 60];

/** Следующее значение кнопки: выкл → 12:00 → 18:00 → выкл (чужое время, поставленное записью настройки, → 12:00). */
export function nextPickAt(cur: number | null): number | null {
  if (cur === null) return PICK_TIMES[0];
  const i = PICK_TIMES.indexOf(cur);
  if (i < 0) return PICK_TIMES[0];
  return i + 1 < PICK_TIMES.length ? PICK_TIMES[i + 1] : null;
}
