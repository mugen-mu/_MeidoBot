// Аниме: чистые функции без базы и сети — состояние серий, разбор фразы, показ времени, реплики Хару.
import type { Character } from "../flavor.ts";
import { NIGHT_LINE_CHANCE, type ReactionKind, isLateNight, pickReaction } from "../personality/animeLines.ts";
import { fmtHHMM, startOfDay, wallOf } from "../time/tz.ts";
import { MINUTE } from "../time/tz.ts";

export type AnimeStatus = "watching" | "planned" | "done" | "dropped";

export interface Anime {
  id: number;
  mal_id: number;
  anilist_id: number | null;
  title_ru: string;
  title_orig: string | null;
  status: AnimeStatus;
  watched: number;
  liked: number;
  notify: number;
  episodes: number | null;
  src_status: string | null;
  next_ep: number | null;
  next_at: number | null;
  aired_ep: number;
  aired_at: number | null;
  asked_ep: number;
  added_at: number;
  updated_at: number;
  // выкладка 2 (миграция 0007)
  drop_reason: string | null;
  last_move_at: number | null;
  voice_lag: number | null;
  voice_n: number;
  voice_ep: number;
  weekq_at: number | null;
  seq_at: number | null;
  start_asked: number;
}

/** До скольких тайтлов в «Смотрю» бот присылает уведомления (решение Ihor: «можно больше, но уведомления только по первым 5»). */
export const NOTICE_LIMIT = 5;

export const STATUS_CODE: Record<AnimeStatus, string> = { watching: "w", planned: "p", done: "d", dropped: "x" };
export const CODE_STATUS: Record<string, AnimeStatus> = { w: "watching", p: "planned", d: "done", x: "dropped" };
export const STATUS_LABEL: Record<AnimeStatus, string> = { watching: "Смотрю", planned: "В планах", done: "Просмотрено", dropped: "Бросил" };
export const STATUS_ORDER: AnimeStatus[] = ["watching", "planned", "done", "dropped"];

/** Состояние серий на момент `now`: что уже вышло и что дальше. Опирается на сохранённое «ближайшая серия выйдет тогда-то». */
export function effective(a: Anime, now: number): { airedEp: number; airedAt: number | null; upcoming: { ep: number; at: number } | null } {
  const passed = a.next_ep !== null && a.next_at !== null && a.next_at <= now;
  const airedEp = passed ? Math.max(a.aired_ep, a.next_ep as number) : a.aired_ep;
  const airedAt = passed && (a.next_ep as number) >= a.aired_ep ? a.next_at : a.aired_at;
  const upcoming = a.next_ep !== null && a.next_at !== null && a.next_at > now ? { ep: a.next_ep, at: a.next_at } : null;
  return { airedEp, airedAt, upcoming };
}

/** Тайтлы «Смотрю», по которым идут уведомления: с включённым колокольчиком, первые 5 по порядку добавления. */
export function noticeSet(rows: Anime[]): Anime[] {
  return rows.filter((a) => a.status === "watching" && a.notify === 1).sort((x, y) => x.id - y.id).slice(0, NOTICE_LIMIT);
}

// ---------- время ----------

const WD = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** «сегодня 19:30», «завтра 02:30», «пт 19:30», дальше недели — «5 дек 19:30». */
export function whenShort(ms: number, now: number, tz: string): string {
  const w = wallOf(ms, tz);
  const hhmm = fmtHHMM(w.h * 60 + w.mi);
  const days = Math.round((startOfDay(ms, tz) - startOfDay(now, tz)) / (24 * 60 * MINUTE));
  if (days === 0) return `сегодня ${hhmm}`;
  if (days === 1) return `завтра ${hhmm}`;
  if (days === -1) return `вчера ${hhmm}`;
  if (days > 1 && days < 7) return `${WD[w.wd]} ${hhmm}`;
  return `${w.d} ${MONTHS[w.mo]} ${hhmm}`;
}

/** Только день: «сегодня», «пт», «5 дек». */
export function dayShort(ms: number, now: number, tz: string): string {
  const w = wallOf(ms, tz);
  const days = Math.round((startOfDay(ms, tz) - startOfDay(now, tz)) / (24 * 60 * MINUTE));
  if (days === 0) return "сегодня";
  if (days === 1) return "завтра";
  if (days > 1 && days < 7) return WD[w.wd];
  return `${w.d} ${MONTHS[w.mo]}`;
}

// ---------- показ ----------

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** liked: 0 нет отметки, 1 понравилось, 2 в восторге, -1 «так себе» (в списке без значка), -2 «не зашло» (👎). */
export const likeMark = (a: Anime): string => (a.liked === 2 ? "🔥 " : a.liked === 1 ? "❤ " : a.liked <= -2 ? "👎 " : "");

/** Отметка словами для карточки и ответов: «🔥 в восторге», «❤ понравилось», «так себе», «👎 не зашло»; пусто — отметки нет. */
export const likeWords = (liked: number): string =>
  liked >= 2 ? "🔥 в восторге" : liked === 1 ? "❤ понравилось" : liked === -1 ? "так себе" : liked <= -2 ? "👎 не зашло" : "";

/** Хвост строки списка про серии: на какой я и что дальше. */
export function progressText(a: Anime, now: number, tz: string): string {
  const e = effective(a, now);
  if (a.status === "planned") {
    if (e.upcoming) return `${e.upcoming.ep === 1 ? "старт" : `${e.upcoming.ep}-я`}: ${whenShort(e.upcoming.at, now, tz)}`;
    return a.src_status === "FINISHED" || a.src_status === "RELEASING" ? "уже вышло" : "дата не объявлена";
  }
  // у загруженных из анкеты отметок серий нет (watched = 0): «серия 0» и «остановился на 0» не пишем
  if (a.status === "done") return a.episodes ? `${a.episodes} сер.` : a.watched ? `серия ${a.watched}` : "просмотрено";
  if (a.status === "dropped") return a.watched ? `остановился на ${a.watched}` : "бросил";
  const parts = [`серия ${a.watched}`];
  if (e.airedEp > a.watched) parts.push(`вышла ${e.airedEp}-я`);
  if (e.upcoming) parts.push(`${e.upcoming.ep}-я: ${whenShort(e.upcoming.at, now, tz)}`);
  else if (a.src_status === "FINISHED") parts.push("всё вышло");
  else parts.push("дата не объявлена");
  return parts.join(" · ");
}

// ---------- фраза ----------

export interface AnimePhrase {
  status: AnimeStatus;
  query: string;
  episode: number | null;
}

const VERB: [RegExp, AnimeStatus][] = [
  [/^(смотрю|смотрела)$/i, "watching"],
  [/^(хочу|в планах|запланировал|запланировала|планирую)$/i, "planned"],
  [/^(посмотрел|посмотрела|досмотрел|досмотрела)$/i, "done"],
  [/^(бросил|бросила|дропнул|дропнула)$/i, "dropped"],
];

const EP_TAIL = /\s+(?:на\s+)?(?:сери[яюи]\s+(\d{1,4})|(\d{1,4})(?:-?[яйюе])?\s+сери[яюи])\s*$/i;

/**
 * Фраза «бот смотрю фрирен», «аниме хочу блич», «бот бросил ДжоДжо», «бот смотрю фрирен серия 4».
 * Без слова «бот» или «аниме» в начале — не наша фраза (обычные дела вроде «хочу купить хлеб» остаются делами).
 */
export function parseAnimePhrase(text: string): AnimePhrase | null {
  const m = /^\s*(?:бот|аниме)\s*[,:;.\-–—]?\s*(?:аниме\s*[,:;.\-–—]?\s*)?(в планах|[а-яё]+)\s*[:\-–—]?\s*(.+?)\s*$/is.exec(text);
  if (!m) return null;
  const verb = m[1].trim();
  const hit = VERB.find(([re]) => re.test(verb));
  if (!hit) return null;
  let query = m[2].trim().replace(/[.!?…]+$/u, "").trim();
  let episode: number | null = null;
  const e = EP_TAIL.exec(query);
  if (e) {
    episode = Number.parseInt(e[1] ?? e[2], 10);
    query = query.slice(0, e.index).trim();
  }
  query = query.replace(/^[«"“]|[»"”]$/gu, "").trim();
  if (!query) return null;
  return { status: hit[1], query, episode };
}

export const norm = (s: string): string => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();

/** Единственное совпадение в своём списке (по русскому или оригинальному названию); несколько или ни одного — null. */
export function findOwn(rows: Anime[], query: string): Anime | null {
  const q = norm(query);
  if (!q) return null;
  const exact = rows.filter((a) => norm(a.title_ru) === q || norm(a.title_orig ?? "") === q);
  if (exact.length === 1) return exact[0];
  const part = rows.filter((a) => norm(a.title_ru).includes(q) || norm(a.title_orig ?? "").includes(q));
  return part.length === 1 ? part[0] : null;
}

const ORD_WORDS: Record<number, string[]> = {
  1: ["первый", "first", "i"],
  2: ["второй", "second", "ii", "2nd"],
  3: ["третий", "third", "iii", "3rd"],
  4: ["четвертый", "fourth", "iv", "4th"],
  5: ["пятый", "fifth", "v", "5th"],
};

const titleTokens = (a: Anime): string[] => norm(`${a.title_ru} ${a.title_orig ?? ""}`).split(" ");
/** В названии есть номер этого сезона: «… 2», «2nd season», «второй сезон». */
const hasSeason = (a: Anime, n: number): boolean => {
  const t = titleTokens(a);
  return t.includes(String(n)) || (ORD_WORDS[n] ?? []).some((w) => t.includes(w));
};
const hasAnySeason = (a: Anime): boolean => titleTokens(a).some((w) => /^(?:[2-9]|\d{2})$/.test(w) || [2, 3, 4, 5].some((n) => (ORD_WORDS[n] ?? []).includes(w)));

/**
 * Как findOwn, но у тайтла несколько сезонов (каждый сезон — отдельная запись): сезон из фразы («s3e2», «2 сезон») выбирает нужный,
 * даже если название первого сезона совпало точно; без сезона берём единственный из тех, что «Смотрю» сейчас, затем точное совпадение.
 * Единственная запись другого сезона не подходит. Иначе null (неясно: заведём как дело или спросим).
 */
export function findOwnSeason(rows: Anime[], query: string, season: number | null): Anime | null {
  const q = norm(query);
  if (!q) return null;
  const hits = rows.filter((a) => norm(a.title_ru).includes(q) || norm(a.title_orig ?? "").includes(q));
  if (!hits.length) return null;
  if (hits.length === 1) return season !== null && hasAnySeason(hits[0]) && !hasSeason(hits[0], season) ? null : hits[0];
  if (season !== null) {
    const bySeason = hits.filter((a) => hasSeason(a, season));
    if (bySeason.length === 1) return bySeason[0];
    if (season === 1) {
      const plain = hits.filter((a) => !hasAnySeason(a));
      if (plain.length === 1) return plain[0];
    }
    return null;
  }
  const watching = hits.filter((a) => a.status === "watching");
  return watching.length === 1 ? watching[0] : findOwn(rows, query);
}

// ---------- озвучка AniLibria ----------

const HOUR_MS = 60 * MINUTE;
const DAY_MS = 24 * HOUR_MS;

/** Озвучка, пришедшая позже этого срока после выхода серии, в замер не идёт (это уже не «обычная» задержка). */
export const VOICE_MAX_LAG = 72 * 60;

/** Что видно у AniLibria про один тайтл: когда появилась последняя озвученная серия и какая следующая. */
export interface Voice {
  mal: number;
  freshAt: number | null;
  nextEp: number | null;
  ongoing: boolean;
}

/**
 * Один замер задержки озвучки (минуты): последняя озвученная серия — это серия перед «следующей» у AniLibria; сравниваем с тем,
 * когда она вышла у нас. Берём только если серии совпадают, время выхода известно и разница похожа на правду.
 */
export function voiceObservation(a: Anime, v: Voice, now: number): number | null {
  if (v.nextEp === null || v.freshAt === null) return null;
  const ep = v.nextEp - 1;
  const e = effective(a, now);
  if (ep < 1 || ep !== e.airedEp || e.airedAt === null || a.voice_ep === ep) return null;
  const lag = Math.round((v.freshAt - e.airedAt) / MINUTE);
  return lag >= 0 && lag <= VOICE_MAX_LAG ? lag : null;
}

/** Новое среднее: старое значение весит как до трёх прежних замеров. */
export const voiceAverage = (old: number | null, n: number, obs: number): number => (old === null || n <= 0 ? obs : Math.round((old * Math.min(n, 3) + obs) / (Math.min(n, 3) + 1)));

const hoursWord = (h: number): string => {
  if (!Number.isInteger(h)) return "часа";
  const t = h % 100;
  if (t >= 11 && t <= 14) return "часов";
  const u = h % 10;
  return u === 1 ? "час" : u >= 2 && u <= 4 ? "часа" : "часов";
};

/** «~40 мин», «~2,5 часа», «~5 часов» — с шагом в полчаса. */
export function lagText(min: number): string {
  if (min < 60) return `~${Math.max(10, Math.round(min / 10) * 10)} мин`;
  const h = Math.round(min / 30) / 2;
  return `~${String(h).replace(".", ",")} ${hoursWord(h)}`;
}

/** Строка про озвучку: только если мы её знаем (у тайтлов без AniLibria строки нет). */
export const voiceLine = (a: Anime): string | null => (a.voice_lag === null ? null : `озвучка AniLibria обычно через ${lagText(a.voice_lag)}`);

// ---------- «между прочим» ----------

export const WEEK_DAY = 7; // воскресенье (wallOf().wd: 1 = пн … 7 = вс)
/** Во сколько в воскресенье спрашивать (минут от полуночи): 19:10, окно три часа. */
export const WEEKQ_AT = 19 * 60 + 10;
export const WEEKQ_WINDOW = 180;
export const WEEKQ_TTL = DAY_MS;
const IDLE_ASK_EP = 7 * DAY_MS;
const IDLE_CONTINUE = 21 * DAY_MS;
const PLANNED_OLD = 180 * DAY_MS;
const SEQ_RECHECK = 60 * DAY_MS;
/** После вопроса «добавить продолжение?» про этот тайтл больше не ищем почти год. */
export const SEQ_AFTER_ASK = 300 * DAY_MS;

export type WeekKind = "ep" | "liked" | "cont" | "planned" | "seq";

const movedAt = (a: Anime): number => a.last_move_at ?? a.added_at;
const asked = (a: Anime, ago: number, now: number): boolean => a.weekq_at !== null && now - a.weekq_at < ago;
const behind = (a: Anime, now: number): boolean => effective(a, now).airedEp > a.watched;
const oldest = (xs: Anime[]): Anime | null => xs.sort((x, y) => movedAt(x) - movedAt(y) || x.id - y.id)[0] ?? null;

export interface WeekPicks {
  cont: Anime | null;
  ep: Anime | null;
  planned: Anime | null;
  liked: Anime | null;
  /** кого проверить на анонс продолжения (до трёх, самые любимые и свежие) */
  seq: Anime[];
}

/** Кандидаты на вопрос недели по ситуации; порядок выбора решает вызывающий: cont → ep → seq → planned → liked. */
export function weekPicks(rows: Anime[], now: number): WeekPicks {
  const watching = rows.filter((a) => a.status === "watching" && a.notify === 1 && behind(a, now));
  const idle = (a: Anime) => now - movedAt(a);
  const done = rows.filter((a) => a.status === "done");
  return {
    cont: oldest(watching.filter((a) => idle(a) >= IDLE_CONTINUE && !asked(a, IDLE_CONTINUE, now))),
    ep: oldest(watching.filter((a) => a.watched >= 1 && idle(a) >= IDLE_ASK_EP && idle(a) < IDLE_CONTINUE && !asked(a, IDLE_CONTINUE, now))),
    planned: oldest(rows.filter((a) => a.status === "planned" && idle(a) >= PLANNED_OLD && !asked(a, PLANNED_OLD, now))),
    liked: done.filter((a) => a.liked === 0 && a.weekq_at === null).sort((x, y) => y.updated_at - x.updated_at || y.id - x.id)[0] ?? null,
    seq: done
      // про продолжение того, что не зашло («так себе», «не зашло»), не спрашиваем
      .filter((a) => a.liked >= 0 && (a.seq_at === null || now - a.seq_at >= SEQ_RECHECK))
      .sort((x, y) => y.liked - x.liked || y.updated_at - x.updated_at)
      .slice(0, 3),
  };
}

/** Сколько недель тайтл не двигается, словами: «3 недели». */
export function weeksText(ms: number): string {
  const n = Math.max(1, Math.round(ms / (7 * DAY_MS)));
  const u = n % 10;
  const t = n % 100;
  return `${n} ${t >= 11 && t <= 14 ? "недель" : u === 1 ? "неделю" : u >= 2 && u <= 4 ? "недели" : "недель"}`;
}

export const idleTime = (a: Anime, now: number): number => now - movedAt(a);

const MONTH_GEN = ["", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** «марта»: с какого месяца тайтл лежит без движения (для вопроса «ещё хочется?»). */
export const sinceText = (a: Anime, tz: string): string => MONTH_GEN[wallOf(movedAt(a), tz).mo];

export const DROP_REASON: Record<string, string> = { b: "bored", u: "busy", l: "long", n: "notmine" };
export const DROP_LABEL: Record<string, string> = { bored: "скучно", busy: "не успеваю", long: "слишком длинный", notmine: "не моё" };

// ---------- начало сезона ----------

/**
 * Когда сегодня выходит первая серия тайтла из «В планах» (UTC, мс), если про это ещё не писали.
 * Ночная первая серия (раньше 06:00 по Киеву) тоже считается сегодняшней. null — сегодня не старт.
 */
export function seasonStart(a: Anime, now: number, tz: string): number | null {
  if (a.status !== "planned" || a.start_asked) return null;
  const e = effective(a, now);
  const at = e.upcoming && e.upcoming.ep === 1 ? e.upcoming.at : e.airedEp === 1 ? e.airedAt : null;
  if (at === null) return null;
  const t0 = startOfDay(now, tz);
  return at >= t0 - 6 * HOUR_MS && at < t0 + DAY_MS ? at : null;
}

// ---------- реплики Хару ----------

type LineKind =
  | "list" | "listEmpty" | "listPlanned" | "listDone" | "listDropped" | "card" | "ep" | "liked" | "dropped" | "added" | "ask" | "tonight" | "unclear"
  | "weekEp" | "weekLiked" | "weekCont" | "weekReason" | "weekPlanned" | "weekSeq" | "weekThanks" | "start";

const LINES: Record<LineKind, string[]> = {
  list: ["Всё записано. Я ничего не пропускаю, даже когда очень хочется.", "Вот. Не благодарите, я просто стою рядом.", "Список у меня. Вы смотрите, а я помню."],
  listEmpty: ["Здесь пусто. Добавьте что-нибудь, пока я не заскучала. Я не скучаю, я просто сказала."],
  listPlanned: ["«Потом» тоже записано. Я напомню, когда оно наступит."],
  listDone: ["Всё это вы уже пережили. Я горжусь. Немного."],
  listDropped: ["Бросили, и ладно. Я не осуждаю. Почти."],
  card: ["Это всё, что я знаю. А я знаю много."],
  ep: ["Принято. Следующую я тоже запомню.", "Серия отмечена. Чай остыл, но это ничего."],
  liked: ["Рада, что понравилось. Я тоже… нет, не скажу.", "Записала. У вас хороший вкус, хозяин."],
  dropped: ["Понимаю. Не всё стоит времени."],
  added: ["Записала. Положила в нужный ящик.", "Готово. Я запомнила, вам не нужно."],
  ask: ["Спрашиваю один раз в день. Больше не буду. Наверное."],
  tonight: ["Хорошо, что вы всё ещё смотрите. Чай заварила.", "Не забудьте. Я не напоминаю, я констатирую."],
  unclear: ["Тут есть варианты. Выберите, я не телепат."],
  weekEp: ["Я записала. Поправьте, если ошиблась. Я не ошибаюсь, но на всякий случай.", "Спрашиваю не из любопытства. Из порядка."],
  weekLiked: ["Просто спросила. Просто.", "Мне не всё равно. Совсем чуть-чуть."],
  weekCont: ["Не давлю. Просто напоминаю, что я помню.", "Я не осуждаю. Я наблюдаю."],
  weekReason: ["Это только для меня, я никому не скажу."],
  weekPlanned: ["«Потом» бывает слишком долгим. Я лишь прибираюсь."],
  weekSeq: ["Я случайно услышала. Я не подслушивала, мимо проходила."],
  weekThanks: ["Спасибо. Записала.", "Хорошо. Теперь знаю."],
  start: ["Это «потом» наступило, господин. Я не напоминаю, я констатирую.", "Сегодня то, что вы записали на потом. Чай заварить?"],
};

/**
 * Короткая реплика Хару: только при характере «горничная», без перебора (одна на сообщение).
 * На отметки (`ep`, `liked`, `dropped`, а также `loved` и `meh`) отвечает под разными углами: соглашается, спорит, подкалывает, намекает, цитирует, играет сценку
 * (`src/personality/animeLines.ts`, анкета вкусов); прежние фразы из `LINES` остаются одним из углов. Остальные виды — как раньше.
 * `hour` — местный час: на отметку серии ночью (с полуночи до пяти) Хару чаще шутит «пора спать». Без него (старые вызовы) ночи нет.
 */
export function haru(kind: LineKind | ReactionKind, character: Character, rand: () => number = Math.random, hour?: number): string | null {
  if (character !== "maid") return null;
  if (kind === "ep" && hour !== undefined && isLateNight(hour) && rand() < NIGHT_LINE_CHANCE) return pickReaction("night", [], rand);
  return pickReaction(kind, LINES[kind as LineKind] ?? [], rand);
}
