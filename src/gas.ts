// Отключения газа в Днепре (этап 3, часть 2). Источник — Дніпровська філія «Газорозподільні мережі України» (dp.grmu.com.ua):
// раз в месяц на главной странице появляется файл .docx «Графік виконання робіт» со списком домов по датам (времени суток в нём нет).
// Аварии компания описывает только после события, заранее предупредить о них нельзя — их бот не разбирает.
// Правила (решения 2026-11-08): только по адресу пользователя (улица, при желании дом); нет совпадений — молчим; источник сломался — говорим один раз.
import { decode, parseWaterWords } from "./water.ts";
import { MINUTE, localDate, wallOf, wallToUtc } from "./time/tz.ts";
import { usDate } from "./time/format.ts";

export const GAS_HOME_URL = "https://dp.grmu.com.ua/";
export const GAS_CHECK_EVERY = 60 * MINUTE;
export const GAS_RETRY_AFTER = 15 * MINUTE;
/** файл с графиком перечитываем не реже раза в сутки: в нём могут поправить адреса под той же ссылкой */
export const GAS_REFETCH_AFTER = 24 * 60 * MINUTE;
export const GAS_FAIL_NOTICE_AT = 3;
const MAX_DOCX_BYTES = 2_000_000;
const MAX_XML_BYTES = 5_000_000;
const DAY_MS = 86_400_000;

// ---------- ссылка на график на главной странице ----------

/** Первая (самая новая: записи идут сверху вниз) ссылка на .docx с «Графік виконання робіт». indexOf, а не регулярка по всей странице. */
export function findGasLink(html: string): string | null {
  const key = "Графік виконання робіт";
  let from = 0;
  for (let n = 0; n < 12; n++) {
    const at = html.indexOf(key, from);
    if (at < 0) return null;
    from = at + key.length;
    const h = html.lastIndexOf('href="', at);
    if (h < 0 || at - h > 600) continue;
    const end = html.indexOf('"', h + 6);
    if (end < 0 || end > at) continue;
    const href = html.slice(h + 6, end).replace(/&amp;/g, "&").trim();
    if (!/\.docx(\?.*)?$/i.test(href) || !/^https?:\/\//i.test(href)) continue;
    try {
      return new URL(href).href;
    } catch {
      /* битая ссылка: ищем следующую */
    }
  }
  return null;
}

// ---------- чтение .docx (zip) ----------

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Достаёт один файл из zip по центральному каталогу; null — нет такого файла или архив не наш. */
export async function unzipEntry(buf: Uint8Array, name: string): Promise<Uint8Array | null> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let p = u32(buf, eocd + 16);
  const count = u16(buf, eocd + 10);
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (u32(buf, p) !== 0x02014b50) return null;
    const method = u16(buf, p + 10);
    const comp = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const entryName = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (size > MAX_XML_BYTES || local + 30 > buf.length || u32(buf, local) !== 0x04034b50) return null;
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    const raw = buf.subarray(start, start + comp);
    if (method === 0) return raw;
    if (method !== 8) return null;
    const stream = new Blob([raw as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out.length > MAX_XML_BYTES ? null : out;
  }
  return null;
}

/** Абзацы документа Word: текст из `<w:t>` в каждом `<w:p>`. */
export function docxParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    let text = "";
    for (const t of m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) text += t[1];
    text = decode(text).replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

// ---------- разбор графика ----------

/** Дата (ГГГГ-ММ-ДД) -> адреса домов в Днепре, как написаны в файле. */
export type GasSchedule = Record<string, string[]>;

const LOCALITY = /^(?:м|с|смт|сел)\.?\s/i;
const DATE_LINE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(?:року|р\.?)?$/i;
const STOP = /звернітьувагу/i;

/** Строки файла -> «дата -> адреса». Берём только блок «м. Дніпро» (если блоков нет — всё), до «ЗВЕРНІТЬ УВАГУ». */
export function parseGasSchedule(paragraphs: string[]): GasSchedule {
  const out: GasSchedule = {};
  let locality: string | null = null;
  let date: string | null = null;
  for (const raw of paragraphs) {
    const line = raw.trim();
    if (line.length < 40 && STOP.test(line.replace(/\s+/g, ""))) break;
    const dm = DATE_LINE.exec(line);
    if (dm) {
      const [d, m, y] = [+dm[1], +dm[2], +dm[3]];
      date = d >= 1 && d <= 31 && m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
      continue;
    }
    if (LOCALITY.test(line) && !/\d/.test(line)) {
      locality = line.toLowerCase();
      date = null;
      continue;
    }
    if (!date) continue;
    if (locality !== null && !locality.startsWith("м. дніпро")) continue;
    // адресная строка: «вул. …, 12», «просп. …, 35, під’їзд № 11», «пров. …, 1, 2, 3»
    if (/^[а-яіїєґ]{2,10}\.?\s/i.test(line) && /\d/.test(line)) (out[date] ??= []).push(line);
  }
  return out;
}

// ---------- совпадение со словами пользователя ----------

const norm = (s: string) => s.toLowerCase().replace(/[’'`ʼ]/g, "’").replace(/\s+/g, " ").trim();

/**
 * Слово из настроек: «Героїв» — улица (любой дом), «Героїв 35» — улица и дом (дом назван в списке, подъезды и литеры не путаем).
 * Улицу пишут без окончания, как в графике.
 */
export function addressMatches(line: string, word: string): boolean {
  const w = norm(word);
  const hm = /^(.*?)\s+(\d+[а-яіїєґa-z]?(?:\/\d+)?)$/.exec(w);
  const stem = (hm ? hm[1] : w).trim();
  if (stem.length < 3) return false;
  const l = norm(line);
  const split = /^(.*?),\s*(\d.*)$/.exec(l);
  const street = split ? split[1] : l;
  if (!street.includes(stem)) return false;
  if (!hm) return true;
  if (!split) return false;
  const houses = split[2].split(/,\s*/).map((x) => x.trim()).filter((x) => /^\d/.test(x));
  return houses.includes(hm[2]);
}

export const parseGasWords = parseWaterWords;

/** Адреса графика, подходящие под слова: «дата -> строки». Только даты с сегодняшней и позже. */
export function matchGasSchedule(schedule: GasSchedule, words: string[], todayIso: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [date, lines] of Object.entries(schedule)) {
    if (date < todayIso) continue;
    const hit = lines.filter((l) => words.some((w) => addressMatches(l, w)));
    if (hit.length) out[date] = hit;
  }
  return out;
}

// ---------- состояние и план сообщений ----------

export interface GasItem {
  date: string;
  addrs: string[];
  /** когда увидели (мс): «накануне вечером» и «утром» после этого момента уже не шлём */
  born: number;
  sent: { eve?: 1; morn?: 1 };
}

export interface GasState {
  link: string | null;
  fetchedAt: number;
  items: GasItem[];
  fail: number;
  failSaid: boolean;
}

export const emptyGasState = (): GasState => ({ link: null, fetchedAt: 0, items: [], fail: 0, failSaid: false });

export function parseGasState(raw: string | undefined): GasState {
  if (!raw) return emptyGasState();
  try {
    const v = JSON.parse(raw) as Partial<GasState>;
    return {
      link: typeof v.link === "string" ? v.link : null,
      fetchedAt: Number(v.fetchedAt) || 0,
      items: Array.isArray(v.items) ? v.items : [],
      fail: Number(v.fail) || 0,
      failSaid: !!v.failSaid,
    };
  } catch {
    return emptyGasState();
  }
}

export interface GasNotice {
  kind: "found" | "changed" | "eve" | "morning" | "source";
  text: string;
  mention: boolean;
}

const isoToUtc = (iso: string, h: number, mi: number, tz: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return wallToUtc({ y, mo: m, d, h, mi }, tz);
};

/** «сегодня», «завтра» или «11.10.2026» (месяц.день.год). */
function dayWord(iso: string, now: number, tz: string): string {
  const today = localDate(now, tz);
  if (iso === today) return "сегодня";
  if (iso === localDate(now + DAY_MS, tz)) return "завтра";
  const [y, m, d] = iso.split("-").map(Number);
  return usDate(y, m, d);
}

const shorten = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const addrLine = (addrs: string[]) => shorten(addrs.join("; "), 220);
const SOURCE_NOTE = "Времени суток в графике нет: газ могут отключить в любой час этого дня.";

/**
 * Что нового в графике: «состояние + разобранный график -> новое состояние + сообщения».
 * `schedule` — null, если файл не перечитывали (ссылка прежняя и свежая): тогда меняется только ссылка/время.
 */
export function planGas(
  state: GasState,
  link: string,
  schedule: GasSchedule | null,
  words: string[],
  now: number,
  tz: string,
): { state: GasState; notices: GasNotice[] } {
  const st: GasState = { link, fetchedAt: state.fetchedAt, items: state.items.map((i) => ({ ...i, sent: { ...i.sent } })), fail: 0, failSaid: false };
  const notices: GasNotice[] = [];
  if (!schedule) return { state: st, notices };
  st.fetchedAt = now;
  const today = localDate(now, tz);
  const matched = matchGasSchedule(schedule, words, today);
  const fresh: GasItem[] = [];
  const changed: GasItem[] = [];
  for (const [date, addrs] of Object.entries(matched).sort(([a], [b]) => a.localeCompare(b))) {
    const prev = st.items.find((i) => i.date === date);
    if (!prev) {
      fresh.push({ date, addrs, born: now, sent: {} });
    } else if (JSON.stringify(prev.addrs) !== JSON.stringify(addrs)) {
      prev.addrs = addrs;
      changed.push(prev);
    }
  }
  const removed = st.items.filter((i) => i.date >= today && !matched[i.date]);
  st.items = [...st.items.filter((i) => !removed.includes(i)), ...fresh].sort((a, b) => a.date.localeCompare(b.date));
  if (fresh.length) {
    const lines = fresh.slice(0, 6).map((i) => `• ${dayWord(i.date, now, tz)}: ${addrLine(i.addrs)}`);
    notices.push({ kind: "found", mention: true, text: [`🔥 Газ: в графике ремонтных работ есть ваш адрес (${fresh.length > 1 ? `${fresh.length} даты` : "одна дата"}).`, ...lines, SOURCE_NOTE, "Напомню накануне вечером и утром в день работ."].join("\n") });
  }
  if (changed.length) {
    notices.push({ kind: "changed", mention: false, text: ["🔥 Газ: график изменился.", ...changed.slice(0, 6).map((i) => `• ${dayWord(i.date, now, tz)}: ${addrLine(i.addrs)}`)].join("\n") });
  }
  if (removed.length) {
    notices.push({ kind: "changed", mention: false, text: `🔥 Газ: из графика убрана дата с вашим адресом: ${removed.map((i) => dayWord(i.date, now, tz)).join(", ")}. Смотрите свежий график на сайте dp.grmu.com.ua.` });
  }
  return { state: st, notices };
}

/**
 * Напоминания по времени (каждую минуту, без запросов): накануне вечером и утром в день работ — по одному разу.
 * eveningMin — вечер накануне (время вечерней сводки), morningMin — утро (время утренней сводки).
 */
export function dueGas(state: GasState, now: number, tz: string, eveningMin: number, morningMin: number): { state: GasState; notices: GasNotice[] } {
  const st: GasState = { ...state, items: state.items.map((i) => ({ ...i, sent: { ...i.sent } })) };
  const notices: GasNotice[] = [];
  for (const it of st.items) {
    const dayStart = isoToUtc(it.date, 0, 0, tz);
    const dayEnd = dayStart + DAY_MS;
    if (now >= dayEnd) continue;
    const prev = wallOf(dayStart - 12 * 60 * MINUTE, tz);
    const eve = wallToUtc({ y: prev.y, mo: prev.mo, d: prev.d, h: Math.floor(eveningMin / 60), mi: eveningMin % 60 }, tz);
    if (!it.sent.eve && now >= eve) {
      it.sent.eve = 1;
      if (it.born < eve && now < dayStart) {
        notices.push({ kind: "eve", mention: false, text: [`🔥 Завтра газ: работы по вашему адресу — ${addrLine(it.addrs)}.`, SOURCE_NOTE].join("\n") });
      }
    }
    const morn = isoToUtc(it.date, Math.floor(morningMin / 60), morningMin % 60, tz);
    if (!it.sent.morn && now >= morn) {
      it.sent.morn = 1;
      if (it.born < morn) {
        notices.push({ kind: "morning", mention: true, text: [`🔥 Сегодня газ: работы по вашему адресу — ${addrLine(it.addrs)}.`, `${SOURCE_NOTE} Приготовьте воду и еду заранее; после работ в квартиру придут проверить оборудование.`].join("\n") });
      }
    }
  }
  st.items = st.items.filter((i) => isoToUtc(i.date, 0, 0, tz) + 2 * DAY_MS > now);
  return { state: st, notices };
}

/** Сбой источника: после 3 неудач подряд — одно сообщение, пока не наладится. */
export function failGas(state: GasState): { state: GasState; notice: GasNotice | null } {
  const st: GasState = { ...state, fail: state.fail + 1 };
  if (st.fail >= GAS_FAIL_NOTICE_AT && !st.failSaid) {
    st.failSaid = true;
    return { state: st, notice: { kind: "source", mention: false, text: "🔥 Не могу прочитать график газа на сайте газовиков (сайт не отвечает или изменился). Пока не наладится, про газ не предупреждаю: смотрите dp.grmu.com.ua." } };
  }
  return { state: st, notice: null };
}

/** Строки для сводки («Коммуналка»): работы сегодня и завтра по вашему адресу. Пусто — молчим. */
export function gasSummaryLines(state: GasState, now: number, tz: string): string[] {
  const today = localDate(now, tz);
  const tomorrow = localDate(now + DAY_MS, tz);
  return state.items.filter((i) => i.date === today || i.date === tomorrow).map((i) => `Газ ${dayWord(i.date, now, tz)}: ${addrLine(i.addrs)}.`);
}

/** Один обход источника: главная страница -> ссылка -> (при необходимости) файл -> график. null в `schedule` — файл не перечитывали. */
export async function fetchGas(
  state: GasState,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ link: string; schedule: GasSchedule | null } | null> {
  try {
    const init = (accept: string) => ({ headers: { accept, "user-agent": "MeidoBot (personal, 0.1)" }, signal: AbortSignal.timeout(6000) });
    const home = await fetchFn(GAS_HOME_URL, init("text/html"));
    if (!home.ok) return null;
    const link = findGasLink(await home.text());
    if (!link) return null;
    if (link === state.link && now - state.fetchedAt < GAS_REFETCH_AFTER) return { link, schedule: null };
    const res = await fetchFn(link, init("*/*"));
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_DOCX_BYTES) return null;
    const xml = await unzipEntry(buf, "word/document.xml");
    if (!xml) return null;
    const schedule = parseGasSchedule(docxParagraphs(new TextDecoder().decode(xml)));
    return Object.keys(schedule).length ? { link, schedule } : null;
  } catch {
    return null;
  }
}

/** Подсказка в настройках: как составить слова для газа. */
export const GAS_WORDS_HINT =
  "Впишите до 5 слов через запятую: улица без окончания, как в графике (Героїв, Козака Мамая), а при желании с номером дома через пробел (Героїв 35). Газовики объявляют адреса по домам и датам, времени суток в графике нет. «выкл» — не следить.";
