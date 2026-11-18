// Чтение: вид сообщений (чистые функции). Кнопок здесь нет вообще (правило кнопок): всё делается фразами, список — вопросом «что я читаю»,
// включение и время субботнего сообщения — в «⋯ Ещё» (окно `m_read`).
import type { Character } from "../flavor.ts";
import { headVoice, modal, textLabel, voiceText } from "../discord/ui.ts";
import type { MessageBody } from "../discord/types.ts";
import { fmtHHMM, parseHHMM } from "../time/tz.ts";
import {
  type ReadKind,
  type ReadStatus,
  type Reading,
  type WeekItem,
  KIND_WORD,
  STATUS_LABEL,
  chaptersText,
  clip,
  haru,
  isFinished,
  readOf,
  srcOf,
  totalOf,
  unitLabel,
  unitText,
  unread,
  volumesText,
  weeksText,
} from "./core.ts";

const text = (content: string): MessageBody => ({ content: clip(content, 1950), components: [], allowed_mentions: { parse: [] } });

export const SOURCE_DOWN_TEXT = "Сайт с названиями сейчас не отвечает (Shikimori). Повторите позже: я ничего не записала.";
export const notFoundText = (q: string): string => `Такого названия не нашла: «${clip(q, 50)}». Попробуйте иначе: по-русски или как в оригинале, например «бот читаю мангу Кауру».`;

const name = (r: Reading): string => `**${clip(r.title_ru, 70)}**`;

// ---------- одна строка про тайтл ----------

/** Где хозяин и сколько накопилось: «глава 120 из 199 · накопилось 79». */
export function progressText(r: Reading): string {
  const have = readOf(r);
  const top = srcOf(r);
  const left = unread(r);
  const parts: string[] = [];
  if (have === null) parts.push(r.status === "planned" ? "ещё не начато" : "на чём остановились — не говорили");
  else parts.push(`${unitLabel(have, r.unit)}${top > 0 ? ` из ${top}` : ""}`);
  if (left && r.status !== "planned" && r.status !== "dropped") parts.push(`накопилось ${left}`);
  if (isFinished(r) && r.status !== "dropped") parts.push("закончен");
  return parts.join(" · ");
}

const listLine = (r: Reading): string => `• ${name(r)} (${KIND_WORD[r.kind]}) — ${progressText(r)}`;

const ORDER: ReadStatus[] = ["reading", "waiting", "planned", "done", "dropped"];

/** «Что я читаю»: «Читаю» и «Жду продолжения» подробно; «В планах» названиями; «Дочитал» и «Бросил» числом. */
export function listText(rows: Reading[], ch: Character, rand?: () => number): string {
  if (!rows.length) return headVoice(haru("listEmpty", ch, rand), "**📖 Чтение** — пока пусто. Напишите «бот читаю мангу Название» или «хочу почитать ранобэ Название», и я запомню.");
  const by = (s: ReadStatus) => rows.filter((r) => r.status === s);
  const out: string[] = ["**📖 Чтение**"];
  for (const s of ["reading", "waiting"] as const) {
    const g = by(s);
    if (!g.length) continue;
    out.push(`**${STATUS_LABEL[s]}** (${g.length})`, ...g.slice(0, 10).map(listLine));
    if (g.length > 10) out.push(`…и ещё ${g.length - 10}`);
  }
  const planned = by("planned");
  if (planned.length) out.push(`**${STATUS_LABEL.planned}** (${planned.length}): ${planned.slice(0, 8).map((r) => clip(r.title_ru, 30)).join(", ")}${planned.length > 8 ? "…" : ""}`);
  const tail = ORDER.slice(3).map((s) => (by(s).length ? `${STATUS_LABEL[s].toLowerCase()}: ${by(s).length}` : "")).filter(Boolean);
  if (tail.length) out.push(tail.join(" · "));
  return headVoice(haru("list", ch, rand), out.join("\n"));
}

/** Что нового у тайтла по росту счётчика у источника. */
function newBits(it: WeekItem): string[] {
  const { r } = it;
  const bits: string[] = [];
  if (it.ended) bits.push(`закончен${r.src_ch > 0 || r.src_vol > 0 ? `: всего ${[r.src_ch > 0 ? chaptersText(r.src_ch) : "", r.src_vol > 0 ? volumesText(r.src_vol) : ""].filter(Boolean).join(", ")}` : ""}`);
  if (it.newCh) {
    const n = r.src_ch - r.told_ch;
    bits.push(n > 1 && r.told_ch > 0 ? `вышло ${chaptersText(n)}, последняя — ${r.src_ch}` : `вышла глава ${r.src_ch}`);
  }
  if (it.newVol) {
    const n = r.src_vol - r.told_vol;
    bits.push(n > 1 && r.told_vol > 0 ? `вышло ${volumesText(n)}, последний — ${r.src_vol}` : `вышел том ${r.src_vol}`);
  }
  return bits;
}

/** Хозяин и накопленное: «вы на 190, накопилось 9». */
function whereBits(r: Reading): string | null {
  const have = readOf(r);
  const left = unread(r);
  if (have === null) return null;
  return `вы на ${have}${left ? `, накопилось ${left}` : ""}`;
}

const ruBit = (r: Reading): string | null => (r.unit === "ch" && r.ru_ch && r.ru_ch < r.src_ch ? `по-русски на MangaDex до ${r.ru_ch}` : null);
const linkBit = (r: Reading): string | null => (r.src_url ? `[читать](<${r.src_url}>)` : null);

/** Строка тайтла в новостях и субботнем сообщении: что вышло, где хозяин и сколько накопилось, русский перевод, ссылка. */
function itemLine(it: WeekItem): string {
  const parts = [...newBits(it)];
  const w = whereBits(it.r);
  if (w) parts.push(w);
  for (const x of [ruBit(it.r), linkBit(it.r)]) if (x) parts.push(x);
  return `• ${name(it.r)} (${KIND_WORD[it.r.kind]}) — ${parts.join(" · ")}`;
}

/** «Что вышло по чтению» по запросу: без перезаписи «про что уже писала», только честный взгляд на то, что накопилось. */
export function newsText(items: WeekItem[], tracked: number): string {
  if (!tracked) return "В «Читаю» и «Жду продолжения» пока пусто, так что и нового нет. Добавить: «бот читаю мангу Название».";
  if (!items.length) return "По чтению нового нет: что вышло по моим источникам, вы уже прочитали. Я смотрю источники раз в ночь.";
  return [`**📖 Чтение · что вышло и накопилось** (${items.length})`, ...items.map(itemLine), "Я смотрю источники раз в ночь."].join("\n");
}

/** «Какая глава Кауру»: где он, что у источника. */
export function whereText(r: Reading): string {
  const have = readOf(r);
  const top = srcOf(r);
  const lines = [`${name(r)} (${KIND_WORD[r.kind]}) — ${STATUS_LABEL[r.status].toLowerCase()}.`];
  lines.push(have === null ? "Вы не говорили, на чём остановились. Скажите: «прочитал главу 120 …»." : `Вы на: ${unitLabel(have, r.unit)}${top > 0 ? ` (по источнику вышло ${top})` : ""}.`);
  const left = unread(r);
  if (left) lines.push(`Накопилось: ${unitText(left, r.unit)}.`);
  const total = totalOf(r);
  if (isFinished(r) && total) lines.push(`Тайтл закончен: всего ${unitText(total, r.unit)}.`);
  else if (top === 0 && !isFinished(r)) lines.push(r.md_id || r.mu_id ? "Источник пока не показал, сколько вышло." : "Сколько вышло, сама не вижу: источника для этого названия не нашла.");
  const ru = ruBit(r);
  if (ru) lines.push(`${ru[0].toUpperCase()}${ru.slice(1)}.`);
  return lines.join("\n");
}

export const ambiguousOwn = (rows: Reading[]): string =>
  `Подходит несколько: ${rows.slice(0, 4).map((r) => `«${clip(r.title_ru, 40)}» (${KIND_WORD[r.kind]})`).join(", ")}. Напишите точнее или со словом «манга» / «ранобэ».`;

export function ambiguousFound(cands: { ru: string; kind: ReadKind; year: number | null }[]): string {
  const list = cands.slice(0, 4).map((c) => `«${clip(c.ru, 40)}» (${KIND_WORD[c.kind]}${c.year ? `, ${c.year}` : ""})`);
  return `Нашла несколько: ${list.join(", ")}. Напишите точнее: название целиком и слово «манга» или «ранобэ», например «бот читаю ${cands[0].kind === "ranobe" ? "ранобэ" : "мангу"} ${clip(cands[0].ru, 40)}».`;
}

// ---------- ответы на фразы ----------

export interface SavedInfo {
  r: Reading;
  /** что сделали: добавили новый, поменяли существующий */
  how: "added" | "changed";
  /** ночью/сейчас: как идёт слежение */
  sourceNote?: string;
  /** хозяин не говорил, где остановился, а сказал «прочитал» без номера: честно говорим, откуда считаем */
  guessed?: boolean;
  /** источник слежения не берёт тайтлов сверх лимита */
  overLimit?: boolean;
  line: string | null;
}

export function savedMessage(s: SavedInfo): MessageBody {
  const { r } = s;
  const lines = [`Записала: ${name(r)} (${KIND_WORD[r.kind]}) — ${STATUS_LABEL[r.status].toLowerCase()}${readOf(r) !== null ? `, ${unitLabel(readOf(r) as number, r.unit)}${srcOf(r) > 0 ? ` из ${srcOf(r)}` : ""}` : ""}.`];
  const left = unread(r);
  if (left && r.status !== "planned" && r.status !== "dropped") lines.push(`Накопилось: ${unitText(left, r.unit)}.`);
  if (s.guessed) lines.push("Я не знала, где вы были, и считаю от начала. Если вы дальше, напишите «прочитал главу 120 …».");
  if (s.sourceNote) lines.push(s.sourceNote);
  if (s.overLimit) lines.push("Слежу пока за первыми десятью тайтлами из «Читаю» и «Жду продолжения»: этот записан, но о нём я пока не пишу.");
  const body = lines.join("\n");
  return text(s.line ? `${voiceText(s.line)}\n${body}` : body);
}

// ---------- субботнее сообщение ----------

export interface WeekView {
  shown: WeekItem[];
  rest: WeekItem[];
  /** тайтлы, по которым вышло или анонсировано аниме и об этом ещё не писали */
  adapt: Reading[];
  /** тайтл «Читаю», который давно не двигается */
  idle: { r: Reading; ms: number } | null;
  /** источники давно не отвечали: честная строка */
  stale: boolean;
}

export function weekMessage(v: WeekView, ch: Character, rand?: () => number): MessageBody | null {
  if (!v.shown.length && !v.adapt.length && !v.idle && !v.stale) return null;
  const out: string[] = [v.shown.length ? "**📖 Чтение · что накопилось**" : "**📖 Чтение**"];
  if (v.shown.length) {
    const intro = haru("weekIntro", ch, rand);
    if (intro) out.push(voiceText(intro));
    out.push(...v.shown.map(itemLine));
    if (v.rest.length) out.push(`Ещё накопилось: ${v.rest.slice(0, 6).map((it) => `${clip(it.r.title_ru, 30)}${it.unread ? ` +${it.unread}` : ""}`).join(", ")}${v.rest.length > 6 ? "…" : ""}. Спросите «что вышло по чтению».`);
  }
  for (const r of v.adapt.slice(0, 2)) out.push(`🎬 По ${name(r)} ${r.adapt_status === "ongoing" ? "сейчас идёт аниме" : "анонсировано аниме"}: «${clip(r.adapt_ru ?? "", 60)}».`);
  if (v.adapt.length) {
    const hint = haru("adapt", ch, rand);
    if (hint) out.push(voiceText(hint));
  }
  if (v.idle) out.push(`«${clip(v.idle.r.title_ru, 40)}» не двигается уже ${weeksText(v.idle.ms)}. Продолжаете? Если бросили, напишите «бросил читать ${clip(v.idle.r.title_ru, 40)}».`);
  if (v.stale) out.push("Источники глав последние дни не отвечали, поэтому данные могут быть не самыми свежими.");
  if (v.shown.length) {
    const scene = haru("scene", ch, rand);
    if (scene) out.push(scene);
  }
  return text(out.join("\n"));
}

// ---------- настройка: день и время ----------

const WD_NAME = ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const WD_BY: Record<string, number> = { понедельник: 1, пн: 1, вторник: 2, вт: 2, среда: 3, ср: 3, четверг: 4, чт: 4, пятница: 5, пт: 5, суббота: 6, сб: 6, воскресенье: 7, вс: 7 };

export const describeReading = (s: { reading: { dow: number; at: number } | null }): string => (s.reading ? `${WD_NAME[s.reading.dow]} ${fmtHHMM(s.reading.at)}` : "выкл");

/** Короткая подпись для кнопки: «сб 11:00» или «выкл». */
const WD_SHORT = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
export const shortReading = (s: { reading: { dow: number; at: number } | null }): string => (s.reading ? `${WD_SHORT[s.reading.dow]} ${fmtHHMM(s.reading.at)}` : "выкл");

/** Значение настройки `reading` из введённого в окне: «суббота 11:00», «сб 11:00», «11:00» (суббота), «выкл». null — не поняла. */
export function parseReadingWhen(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "выкл" || t === "off") return "off";
  const m = /^(?:(\S+)\s+)?(\d{1,2}[:.]\d{2})$/.exec(t);
  if (!m) return null;
  const dow = m[1] ? WD_BY[m[1]] : 6;
  const at = parseHHMM(m[2]);
  return dow && at !== null ? `${dow}@${fmtHHMM(at)}` : null;
}

export const readingModal = (s: { reading: { dow: number; at: number } | null }) =>
  modal("m_read", "Чтение: сообщение раз в неделю", [textLabel("День и время («суббота 11:00», «выкл» — не писать)", "when", { value: describeReading(s), max: 30 })]);
