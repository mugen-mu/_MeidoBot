// Отключения воды в Днепре (этап 3). Источник — официальный сайт КП «Дніпроводоканал» (WordPress): новости отдаются готовым JSON.
// Правила (решения 2026-11-08): плановые и аварийные, только по словам места пользователя; если отключений нет — молчим;
// время не разобралось — «неподтверждено» и выдержка текста; отмена и перенос — обновление прежнего сообщения; источник сломался — говорим один раз.
// Бот ничего не знает про адрес дома: пользователь сам вписывает слова (район без окончания, улицу) в настройках.
import { formatDate, usDate } from "./time/format.ts";
import { MINUTE, fmtHHMM, wallOf, wallToUtc } from "./time/tz.ts";

export const WATER_URL = "https://vodokanal.dp.ua/wp-json/wp/v2/posts?per_page=6&_fields=id,date_gmt,modified_gmt,link,title,content";
export const WATER_CHECK_EVERY = 60 * MINUTE;
export const WATER_RETRY_AFTER = 15 * MINUTE;
/** сколько неудач подряд нужно, чтобы сказать «источник не отвечает» (один раз) */
export const WATER_FAIL_NOTICE_AT = 3;
const MAX_ALERTS = 5;
const MAX_SEEN = 30;

// ---------- разбор записей ----------

export interface WaterPost {
  id: number;
  /** момент публикации, мс UTC */
  date: number;
  modified: string;
  link: string;
  title: string;
  text: string;
  mapUrl: string | null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘", laquo: "«", raquo: "»", ndash: "–", mdash: "—" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const stripTags = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function rendered(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { rendered?: unknown }).rendered === "string") return (v as { rendered: string }).rendered;
  return "";
}

/** Ответ wp-json -> записи. Всё, что не разобралось, пропускается; пусто — источник «сломан». */
export function parseWaterPosts(json: unknown): WaterPost[] {
  if (!Array.isArray(json)) return [];
  const out: WaterPost[] = [];
  for (const p of json as Record<string, unknown>[]) {
    const id = Number(p?.id);
    const html = rendered(p?.content);
    const title = stripTags(rendered(p?.title));
    if (!Number.isFinite(id) || !title) continue;
    const date = Date.parse(`${String(p.date_gmt ?? "")}Z`);
    const map = /https?:\/\/(?:www\.)?(?:google\.com\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)[^\s"'<>)]*/i.exec(html.replace(/&amp;/g, "&"));
    out.push({
      id,
      date: Number.isFinite(date) ? date : 0,
      modified: String(p.modified_gmt ?? p.date_gmt ?? ""),
      link: typeof p.link === "string" ? p.link : "",
      title,
      text: stripTags(html),
      mapUrl: map ? map[0] : null,
    });
  }
  return out;
}

// ---------- что это за запись ----------

export type WaterKind = "outage" | "cancel" | "restored" | "ignore";

const NOISE_TITLE = /боржник|абонплат|абонентськ|повірк|показан|тариф|лічильник/i;
const NOISE_HEAD = /боржник|заборгован/i;
const OUTAGE = /припин|відсутн|відключ|знижен|тиск|перебої/i;
const CANCEL_TITLE = /скасуван|скасовано|скасовує|відміна|відмінено/i;
const CANCEL_HEAD = /скасовують|скасовано|скасовується|відміняють|не відбудеться/i;
const FUTURE = /буде|будуть|очікує|планує|орієнтов|прогноз|протягом|можлив/i;
const RESTORED = /водопостачання\s+(?:повністю\s+)?відновлен[оа]|відновлен[оа]\s+водопостачання|подачу\s+води\s+відновлено/i;

/** Разбить на предложения; точка в «07. 11.2026» предложение не заканчивает (дальше не заглавная буква). */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+(?=[A-ZА-ЯІЇЄҐ«"‼📍🚱▫])/u).map((s) => s.trim()).filter(Boolean);
}

export function waterKind(p: WaterPost): WaterKind {
  const head = p.text.slice(0, 240);
  if (NOISE_TITLE.test(p.title) || NOISE_HEAD.test(head)) return "ignore";
  if (CANCEL_TITLE.test(p.title) || CANCEL_HEAD.test(head)) return "cancel";
  const whole = `${p.title}. ${p.text}`;
  if (!/вод[аиіуо]|водо/i.test(whole) || !OUTAGE.test(whole)) {
    return RESTORED.test(whole) ? "restored" : "ignore";
  }
  // «водопостачання відновлено» без «буде/очікується» в том же предложении — вода вернулась; иначе это объявление
  if (sentences(whole).some((s) => RESTORED.test(s) && !FUTURE.test(s)) && !/буде\s+припин|припиня[єю]ться|припинено\s+на/i.test(whole)) return "restored";
  return "outage";
}

// ---------- районы ----------

const DISTRICTS: { stem: string; name: string }[] = [
  { stem: "амур", name: "Амур-Нижньодніпровський" },
  { stem: "шевченківськ", name: "Шевченківський" },
  { stem: "соборн", name: "Соборний" },
  { stem: "центральн", name: "Центральний" },
  { stem: "чечелівськ", name: "Чечелівський" },
  { stem: "новокодацьк", name: "Новокодацький" },
  { stem: "індустріальн", name: "Індустріальний" },
  { stem: "самарськ", name: "Самарський" },
  { stem: "новоолександрівськ", name: "Новоолександрівка" },
];

export type DistrictLevel = "off" | "low";
export type DistrictMap = Record<string, DistrictLevel>;

/** Районы из текста: «припинено водопостачання» — off, «знижений тиск» — low; в предложении про «відновлення» районы не берём. */
export function waterDistricts(text: string): DistrictMap {
  const out: DistrictMap = {};
  // внутри предложения тоже бывает смена: «…припинено … Чечелівського району, знижений тиск у Соборному…»
  const clauses = sentences(text).flatMap((s) => s.split(/,\s+(?=знижен|припинен|відключ|перебої)/i));
  for (const sent of clauses) {
    const low = sent.toLowerCase();
    if (/відновлення|нормалізаці/.test(low)) continue;
    const level: DistrictLevel | null = /припинен|припиня/.test(low) ? "off" : /знижен|тиск|перебої/.test(low) ? "low" : /відсутн|відключ/.test(low) ? "off" : null;
    if (!level) continue;
    for (const d of DISTRICTS) {
      if (!low.includes(d.stem)) continue;
      if (out[d.name] !== "off") out[d.name] = level;
    }
  }
  return out;
}

// ---------- время ----------

const MONTHS = ["січн", "лют", "берез", "квіт", "трав", "черв", "лип", "серп", "верес", "жовт", "листопад", "груд"];
const MON = MONTHS.join("|");
const DATE_SRC = String.raw`(?:\d{1,2}\s*\.\s*\d{1,2}\s*\.\s*\d{4}|\d{1,2}\s+(?:${MON})[а-яіїєґ]*(?:\s+\d{4})?)`;
const HW = String.raw`(?:\s*(?:годину|години?|год\.?))?`;

interface Ymd {
  y: number | null;
  m: number;
  d: number;
}

function parseDateTok(tok: string): Ymd | null {
  const t = tok.toLowerCase();
  let m = /^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})$/.exec(t);
  if (m) return { d: +m[1], m: +m[2], y: +m[3] };
  m = new RegExp(String.raw`^(\d{1,2})\s+(${MON})[а-яіїєґ]*(?:\s+(\d{4}))?$`).exec(t);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2]) + 1;
  return mo ? { d: +m[1], m: mo, y: m[3] ? +m[3] : null } : null;
}

const anchoredDate = new RegExp(String.raw`^${HW}\s*(${DATE_SRC})`, "i");
const cmp = (a: Ymd, b: Ymd) => (a.m - b.m) * 40 + (a.d - b.d);

export interface WaterTimes {
  start: number | null;
  end: number | null;
  restore: number | null;
}

/** Попытка разобрать «з 22:00 … до 22:00 …» и «відновлення очікується до 12:00 …»; что не разобралось — null («неподтверждено»). */
export function parseWaterTimes(text: string, postMs: number, tz: string): WaterTimes {
  const low = text.toLowerCase();
  const res: WaterTimes = { start: null, end: null, restore: null };
  const post = wallOf(postMs || Date.now(), tz);
  const toMs = (d: Ymd, h: number, mi: number) => wallToUtc({ y: d.y as number, mo: d.m, d: d.d, h, mi }, tz);
  const validDay = (d: Ymd) => d.m >= 1 && d.m <= 12 && d.d >= 1 && d.d <= 31;
  const inferYear = (d: Ymd): number => {
    let y = post.y;
    // дата без года заметно раньше публикации — это следующий год (запись в декабре про январь)
    if (cmp({ ...d, y }, { m: post.mo, d: post.d, y }) < -60) y++;
    return y;
  };

  const sm = /(?<![а-яіїєґ])[зс]\s+(\d{1,2})[:.](\d{2})(?![\d:]|\.\d)/.exec(low);
  if (sm) {
    const after = low.slice(sm.index + sm[0].length);
    const em = new RegExp(String.raw`(?:до|по)\s+(\d{1,2})[:.](\d{2})(?![\d:]|\.\d)`).exec(after.slice(0, 90));
    if (em) {
      const between = after.slice(0, em.index);
      const tail = after.slice(em.index + em[0].length, em.index + em[0].length + 60);
      const before = low.slice(Math.max(0, sm.index - 45), sm.index);
      let sd: Ymd | null = null;
      const sdm = anchoredDate.exec(between);
      if (sdm) sd = parseDateTok(sdm[1]);
      else {
        // «26 вересня 2026 року з 01:00 до 23:00»: дата стоит перед «з»
        const bm = new RegExp(String.raw`(${DATE_SRC})\s*(?:року|р\.)?[\s,]*$`, "i").exec(before);
        if (bm) sd = parseDateTok(bm[1]);
      }
      let ed: Ymd | null = null;
      const edm = anchoredDate.exec(tail);
      if (edm) ed = parseDateTok(edm[1]);
      if (sd && validDay(sd) && (!ed || validDay(ed))) {
        const s: Ymd = { ...sd };
        const e: Ymd = ed ? { ...ed } : { ...sd };
        if (s.y === null && e.y !== null) s.y = e.y - (cmp(s, e) > 0 ? 1 : 0);
        if (s.y === null) s.y = inferYear(s);
        if (e.y === null) e.y = s.y + (cmp(e, s) < 0 ? 1 : 0);
        const start = toMs(s, +sm[1], +sm[2]);
        const end = toMs(e, +em[1], +em[2]);
        if (end > start) {
          res.start = start;
          res.end = end;
        }
      }
    }
  }

  const rm = new RegExp(String.raw`(?:відновлення|нормалізаці[яї])[\s\S]{0,160}?очікується\s+(?:на|до|о|орієнтовно)?\s*(\d{1,2})[:.](\d{2})(?![\d:]|\.\d)${HW}\s*(${DATE_SRC})?`, "i").exec(low);
  if (rm) {
    let rd: Ymd | null = rm[3] ? parseDateTok(rm[3]) : null;
    if (!rd && res.end !== null) {
      const w = wallOf(res.end, tz);
      rd = { y: w.y, m: w.mo, d: w.d };
    }
    if (rd && validDay(rd)) {
      const r: Ymd = { ...rd };
      if (r.y === null) {
        r.y = inferYear(r);
        if (res.end !== null) {
          const w = wallOf(res.end, tz);
          r.y = w.y + (cmp(r, { y: w.y, m: w.mo, d: w.d }) < -60 ? 1 : 0);
        }
      }
      res.restore = toMs(r, +rm[1], +rm[2]);
    }
  }
  return res;
}

// ---------- совпадение со словами пользователя ----------

/** Слова из настроек: «Чечелівськ, Могилевська» -> нижний регистр, до 5 штук, без пустых. */
export function parseWaterWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[,;\n]+/)
        .map((w) => w.trim().replace(/\s+/g, " "))
        .filter((w) => w.length >= 3),
    ),
  ].slice(0, 5);
}

const isDistrictWord = (w: string) => DISTRICTS.some((d) => (w.length >= 4 && d.stem.startsWith(w)) || w.startsWith(d.stem));

export interface WaterMatch {
  /** как слова совпали: район / улица названа в тексте / район совпал, а улица не названа (может коснуться) */
  hit: "district" | "street" | "maybe";
  /** уровень по совпавшим районам: off — воды не будет, low — снизится давление */
  level: DistrictLevel;
  /** районы записи (для сообщения) */
  districts: DistrictMap;
}

export function matchWater(post: WaterPost, words: string[]): WaterMatch | null {
  if (!words.length) return null;
  const low = `${post.title} ${post.text}`.toLowerCase();
  const districts = waterDistricts(post.text);
  const dWords = words.filter(isDistrictWord);
  const sWords = words.filter((w) => !isDistrictWord(w));
  const streetHit = sWords.some((w) => low.includes(w));
  let level: DistrictLevel | null = null;
  for (const w of dWords) {
    for (const d of DISTRICTS) {
      const hit = (w.length >= 4 && d.stem.startsWith(w)) || w.startsWith(d.stem);
      const lv = hit ? districts[d.name] : undefined;
      if (lv && level !== "off") level = lv;
    }
  }
  if (streetHit) return { hit: "street", level: level ?? "off", districts };
  if (level) return { hit: sWords.length ? "maybe" : "district", level, districts };
  return null;
}

// ---------- состояние и план сообщений ----------

export interface WaterAlert {
  id: number;
  mod: string;
  title: string;
  link: string;
  map: string | null;
  hit: WaterMatch["hit"];
  level: DistrictLevel;
  districts: string[];
  start: number | null;
  end: number | null;
  restore: number | null;
  /** выдержка текста: показываем, когда время не разобралось */
  excerpt: string;
  sent: { eve?: 1; pre?: 1; back?: 1 };
  /** когда объявление увидели (мс): «накануне вечером» после этого момента уже не шлём */
  born: number;
}

export interface WaterState {
  /** id записи -> modified, которую уже видели (последние MAX_SEEN) */
  seen: Record<string, string>;
  alerts: WaterAlert[];
  /** неудач подряд и сказали ли уже про сбой */
  fail: number;
  failSaid: boolean;
}

export const emptyWaterState = (): WaterState => ({ seen: {}, alerts: [], fail: 0, failSaid: false });

export function parseWaterState(raw: string | undefined): WaterState {
  if (!raw) return emptyWaterState();
  try {
    const v = JSON.parse(raw) as Partial<WaterState>;
    return {
      seen: v.seen && typeof v.seen === "object" ? v.seen : {},
      alerts: Array.isArray(v.alerts) ? v.alerts : [],
      fail: Number(v.fail) || 0,
      failSaid: !!v.failSaid,
    };
  } catch {
    return emptyWaterState();
  }
}

export interface WaterNotice {
  /** alert — новое, update — изменилось/перенос, cancel — отмена, restored — вернулась, soon — за 2 часа, eve — накануне вечером, back — срок прошёл, source — сбой источника */
  kind: "alert" | "update" | "cancel" | "restored" | "soon" | "eve" | "back" | "source";
  text: string;
  /** упоминание хозяина (push): срочное — да, напоминания и итоги — нет */
  mention: boolean;
}

/** «сегодня, 22:00», «завтра, 22:00», иначе «11.06.2026, 22:00» (месяц.день.год, без дней недели: в диапазоне они читаются плохо). */
function at(ms: number, now: number, tz: string): string {
  const w = wallOf(ms, tz);
  const d = formatDate(ms, now, tz);
  return `${/^(сегодня|завтра|вчера)$/.test(d) ? d : usDate(w.y, w.mo, w.d)}, ${fmtHHMM(w.h * 60 + w.mi)}`;
}

const LEVEL_WORD: Record<DistrictLevel, string> = { off: "воды не будет", low: "давление снизится" };
const HIT_NOTE: Record<WaterMatch["hit"], string> = {
  district: "",
  street: " Адрес из ваших слов назван в тексте.",
  maybe: " Район совпал, а улицы в тексте нет: может коснуться вас, адрес смотрите по карте.",
};
const shorten = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

function whenLine(a: WaterAlert, now: number, tz: string): string {
  if (a.start !== null && a.end !== null) {
    const restore = a.restore !== null && a.restore > a.end ? ` Стабильный напор обещают к: ${at(a.restore, now, tz)}.` : "";
    return `Начало: ${at(a.start, now, tz)}. Конец: ${at(a.end, now, tz)}.${restore}`;
  }
  return `Время не разобралось (неподтверждено), смотрите текст: «${a.excerpt}»`;
}

const linkLine = (a: WaterAlert) => [a.link, a.map ? `Карта: ${a.map}` : ""].filter(Boolean).join("\n");

function alertText(a: WaterAlert, head: string, now: number, tz: string): string {
  const where = a.districts.length ? ` (${a.districts.join(", ")})` : "";
  return [`💧 ${head}: ${a.title}`, `${LEVEL_WORD[a.level][0].toUpperCase()}${LEVEL_WORD[a.level].slice(1)}${where}.${HIT_NOTE[a.hit]}`, whenLine(a, now, tz), linkLine(a)].join("\n");
}

const DAY_MS = 86_400_000;

/** Ещё актуально ли отключение: идёт или будет; без разобранного времени — свежее двух суток. */
function relevant(a: Pick<WaterAlert, "end" | "restore">, postMs: number, now: number): boolean {
  const until = Math.max(a.end ?? 0, a.restore ?? 0);
  return until ? until > now : now - postMs < 2 * DAY_MS;
}

function alertFrom(p: WaterPost, m: WaterMatch, t: WaterTimes, now: number, prev?: WaterAlert): WaterAlert {
  return {
    id: p.id,
    mod: p.modified,
    title: shorten(p.title, 110),
    link: p.link,
    map: p.mapUrl,
    hit: m.hit,
    level: m.level,
    districts: Object.keys(m.districts),
    start: t.start,
    end: t.end,
    restore: t.restore,
    excerpt: shorten(p.text, 260),
    sent: prev?.sent ?? {},
    born: prev?.born ?? now,
  };
}

/**
 * Что нового в ленте: чистая функция «состояние + записи -> новое состояние + сообщения».
 * Новое объявление про ваше место — сразу, с упоминанием; перенос — «обновление» вместо прежнего; отмена закрывает прежнее.
 */
export function planWater(state: WaterState, posts: WaterPost[], words: string[], now: number, tz: string): { state: WaterState; notices: WaterNotice[] } {
  const st: WaterState = { seen: { ...state.seen }, alerts: state.alerts.map((a) => ({ ...a, sent: { ...a.sent } })), fail: 0, failSaid: false };
  const notices: WaterNotice[] = [];
  // старые записи первыми: порядок сообщений = порядок событий
  const fresh = posts.filter((p) => st.seen[String(p.id)] !== p.modified).sort((a, b) => a.date - b.date);
  for (const p of fresh) {
    st.seen[String(p.id)] = p.modified;
    const kind = waterKind(p);
    const open = st.alerts.filter((a) => relevant(a, p.date, now));
    if (kind === "cancel") {
      if (!open.length) continue;
      const names = open.map((a) => `«${a.title}»`).join(", ");
      notices.push({ kind: "cancel", mention: true, text: [`💧 Вода: водоканал отменил или отложил работы — «${p.title}».`, `Это про прежнее предупреждение ${names}; если речь не о нём — смотрите ссылку.`, p.link].filter(Boolean).join("\n") });
      st.alerts = st.alerts.filter((a) => !open.includes(a));
    } else if (kind === "restored") {
      if (!open.length) continue;
      notices.push({ kind: "restored", mention: true, text: [`💧 Вода вернулась: «${p.title}».`, p.link].filter(Boolean).join("\n") });
      st.alerts = st.alerts.filter((a) => !open.includes(a));
    } else if (kind === "outage") {
      const m = matchWater(p, words);
      if (!m) continue;
      const t = parseWaterTimes(p.text, p.date, tz);
      if (!relevant({ end: t.end, restore: t.restore }, p.date, now)) continue;
      const prevSame = st.alerts.find((a) => a.id === p.id);
      const next = alertFrom(p, m, t, now, prevSame);
      if (prevSame) {
        // правка уже объявленной записи: пишем только если изменился срок или тип, и без push
        const changed = prevSame.start !== next.start || prevSame.end !== next.end || prevSame.level !== next.level;
        st.alerts = st.alerts.map((a) => (a.id === p.id ? next : a));
        if (changed) {
          next.sent = {};
          notices.push({ kind: "update", mention: false, text: alertText(next, "Обновление про воду", now, tz) });
        }
        continue;
      }
      // новое объявление заменяет прежние (перенос даты, новая версия)
      const replaced = open.filter((a) => a.id !== p.id);
      st.alerts = [...st.alerts.filter((a) => !replaced.includes(a)), next];
      notices.push({ kind: replaced.length ? "update" : "alert", mention: true, text: alertText(next, replaced.length ? "Обновление про воду" : "Вода", now, tz) });
    }
  }
  // забываем лишнее
  const ids = Object.keys(st.seen);
  if (ids.length > MAX_SEEN) {
    for (const id of ids.sort((a, b) => Number(a) - Number(b)).slice(0, ids.length - MAX_SEEN)) delete st.seen[id];
  }
  st.alerts = st.alerts.filter((a) => (a.end ?? a.restore ?? 0) === 0 || Math.max(a.end ?? 0, a.restore ?? 0) > now - 3 * DAY_MS).slice(-MAX_ALERTS);
  return { state: st, notices };
}

/**
 * Напоминания по времени (каждую минуту, без запросов): накануне вечером, за 2 часа до начала, и «срок прошёл» — по одному разу.
 * eveningMin — вечер накануне (по умолчанию время вечерней сводки).
 */
export function dueWater(state: WaterState, now: number, tz: string, eveningMin: number): { state: WaterState; notices: WaterNotice[] } {
  const st: WaterState = { ...state, alerts: state.alerts.map((a) => ({ ...a, sent: { ...a.sent } })) };
  const notices: WaterNotice[] = [];
  for (const a of st.alerts) {
    if (a.start !== null && a.end !== null) {
      // вечер накануне: ближайший «вечер» перед началом; если до начала меньше суток и вечер уже прошёл — пропускаем
      if (!a.sent.eve && now < a.start) {
        const dayBefore = wallOf(a.start - DAY_MS, tz);
        const eve = wallToUtc({ y: dayBefore.y, mo: dayBefore.mo, d: dayBefore.d, h: Math.floor(eveningMin / 60), mi: eveningMin % 60 }, tz);
        if (now >= eve && a.born < eve) {
          a.sent.eve = 1;
          notices.push({ kind: "eve", mention: false, text: [`💧 Завтра вода: ${a.title}`, `${LEVEL_WORD[a.level][0].toUpperCase()}${LEVEL_WORD[a.level].slice(1)}. Начало: ${at(a.start, now, tz)}, конец: ${at(a.end, now, tz)}. Запас воды лучше набрать заранее.`, a.link].filter(Boolean).join("\n") });
        } else if (now >= eve) a.sent.eve = 1; // объявление пришло уже после «вечера накануне»: не повторяем
      }
      if (!a.sent.pre && now >= a.start - 120 * MINUTE && now < a.start) {
        a.sent.pre = 1;
        a.sent.eve = 1;
        notices.push({ kind: "soon", mention: true, text: [`💧 Через 2 часа вода: ${a.title}`, `${LEVEL_WORD[a.level][0].toUpperCase()}${LEVEL_WORD[a.level].slice(1)}. Начало: ${at(a.start, now, tz)}, конец: ${at(a.end, now, tz)}.`, a.link].filter(Boolean).join("\n") });
      }
    }
    const back = a.restore ?? a.end;
    if (back !== null && !a.sent.back && now >= back) {
      a.sent.back = 1;
      notices.push({ kind: "back", mention: false, text: `💧 Срок по сообщению водоканала вышел (${at(back, now, tz)}). Воды нет или слабый напор — смотрите свежие записи: ${a.link}` });
    }
  }
  st.alerts = st.alerts.filter((a) => !a.sent.back || Math.max(a.end ?? 0, a.restore ?? 0) > now - 3 * DAY_MS);
  return { state: st, notices };
}

/** Итог по сбою источника: после 3 неудач подряд — одно сообщение, пока не наладится. */
export function failWater(state: WaterState): { state: WaterState; notice: WaterNotice | null } {
  const st: WaterState = { ...state, alerts: state.alerts, fail: state.fail + 1 };
  if (st.fail >= WATER_FAIL_NOTICE_AT && !st.failSaid) {
    st.failSaid = true;
    return { state: st, notice: { kind: "source", mention: false, text: "💧 Не могу прочитать сообщения водоканала (сайт не отвечает или изменился). Пока не наладится, про воду не предупреждаю: смотрите vodokanal.dp.ua." } };
  }
  return { state: st, notice: null };
}

/** Строки для сводки («Коммуналка»): что сейчас идёт или будет в ближайшие сутки. Пусто — молчим. */
export function waterSummaryLines(state: WaterState, now: number, tz: string): string[] {
  const out: string[] = [];
  for (const a of state.alerts) {
    const until = Math.max(a.end ?? 0, a.restore ?? 0);
    if (until && until <= now) continue;
    if (a.start !== null && a.start > now + 36 * 60 * MINUTE) continue;
    out.push(a.start !== null && a.end !== null ? `Вода: ${LEVEL_WORD[a.level]}, начало ${at(a.start, now, tz)}, конец ${at(a.end, now, tz)}.` : `Вода: ${shorten(a.title, 80)} (время неподтверждено).`);
  }
  return out;
}

export async function fetchWater(fetchFn: typeof fetch = fetch): Promise<WaterPost[] | null> {
  try {
    const res = await fetchFn(WATER_URL, { headers: { accept: "application/json", "user-agent": "MeidoBot (personal, 0.1)" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const posts = parseWaterPosts(await res.json());
    return posts.length ? posts : null;
  } catch {
    return null;
  }
}

/** Подсказка в настройках: как составить слова. */
export const WATER_WORDS_HINT =
  "Впишите 1–5 слов через запятую, по-украински и без окончаний: район (Чечелівськ, Соборн, Новокодацьк…) и, по желанию, свою улицу (Могилевськ). Водоканал в тексте называет районы, а улицы чаще только на карте. «выкл» — не следить.";
