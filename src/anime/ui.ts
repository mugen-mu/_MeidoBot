// Аниме: вид сообщений (чистые функции). Кнопки: `an:…`, все на виду, без выпадающих меню (решение Ihor 2026-11-09).
// Идентификаторы: an:ls:<статус>:<стр> список; an:it:<id>:<статус>:<стр> карточка; an:ep/epm/lk/nt/st/dl/dy — действия карточки;
// an:ad добавить; an:pk:<mal>:<статус>:<серия> выбор из вариантов; an:sn:… ответы на «посмотрели?».
import { type Character } from "../flavor.ts";
import { headVoice, voiceText, modal, selectLabel, textLabel } from "../discord/ui.ts";
import type { ActionRow, Button, MessageBody } from "../discord/types.ts";
import { MINUTE, startOfDay, wallOf, fmtHHMM } from "../time/tz.ts";
import type { Candidate, Sequel } from "./sources.ts";
import {
  type Anime,
  type AnimeStatus,
  STATUS_CODE,
  STATUS_LABEL,
  STATUS_ORDER,
  DROP_LABEL,
  clip,
  dayShort,
  effective,
  haru,
    likeMark,
  noticeSet,
  progressText,
  voiceLine,
  weeksText,
  whenShort,
} from "./core.ts";

const btn = (label: string, id: string, style: Button["style"] = 2, disabled = false): Button => ({ type: 2, style, label, custom_id: id, ...(disabled ? { disabled: true } : {}) });
const row = (...components: ActionRow["components"]): ActionRow => ({ type: 1, components });
const body = (content: string, components: ActionRow[]): MessageBody => ({ content, components, allowed_mentions: { parse: [] } });
const withHaru = (text: string, line: string | null): string => (line ? `${text}\n${voiceText(line)}` : text);

export const ANIME_PAGE = 5;

/** Порядок в списке: «Смотрю» — по ближайшему выходу, остальное — недавние сверху. */
export function sortRows(rows: Anime[], status: AnimeStatus, now: number): Anime[] {
  const list = rows.filter((a) => a.status === status);
  if (status === "watching" || status === "planned") {
    const at = (a: Anime) => effective(a, now).upcoming?.at ?? Number.MAX_SAFE_INTEGER;
    return list.sort((x, y) => at(x) - at(y) || x.id - y.id);
  }
  return list.sort((x, y) => y.updated_at - x.updated_at || y.id - x.id);
}

const listLine = (a: Anime, n: number, now: number, tz: string): string =>
  `**${n}.** ${likeMark(a)}${clip(a.title_ru, 60)} — ${progressText(a, now, tz)}${a.status === "watching" && a.notify === 0 ? " 🔕" : ""}`;

export function animeListMessage(rows: Anime[], status: AnimeStatus, page: number, now: number, tz: string, ch: Character, rand?: () => number): MessageBody {
  const shown = sortRows(rows, status, now);
  const pages = Math.max(1, Math.ceil(shown.length / ANIME_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = shown.slice(p * ANIME_PAGE, p * ANIME_PAGE + ANIME_PAGE);
  const head = `**🎬 Аниме · ${STATUS_LABEL[status]}** (${shown.length})${pages > 1 ? ` · страница ${p + 1} из ${pages}` : ""}`;
  const code = STATUS_CODE[status];
  let text: string;
  let line: string | null;
  if (slice.length) {
    text = `${head}\nНажмите номер, чтобы открыть тайтл.\n${slice.map((a, i) => listLine(a, i + 1, now, tz)).join("\n")}`;
    line = haru(status === "watching" ? "list" : status === "planned" ? "listPlanned" : status === "done" ? "listDone" : "listDropped", ch, rand);
  } else {
    text = `${head}\nЗдесь пусто. Нажмите «＋ Добавить» или напишите в канал «бот»: «бот смотрю название».`;
    line = haru("listEmpty", ch, rand);
  }
  const rowsOut: ActionRow[] = [];
  if (slice.length) rowsOut.push(row(...slice.map((a, i) => btn(String(i + 1), `an:it:${a.id}:${code}:${p}`, 1))));
  rowsOut.push(row(...STATUS_ORDER.map((s) => btn(`${STATUS_LABEL[s]} ${rows.filter((a) => a.status === s).length}`, `an:ls:${STATUS_CODE[s]}:0`, s === status ? 1 : 2))));
  rowsOut.push(row(btn("◀", `an:ls:${code}:${p - 1}`, 2, p === 0), btn("▶", `an:ls:${code}:${p + 1}`, 2, p >= pages - 1), btn("＋ Добавить", "an:ad", 3), btn("🏠 Меню", "mn:home")));
  return body(withHaru(text, line), rowsOut);
}

/** Карточка тайтла: всё про один, действия кнопками. `code`/`p` — откуда пришли («К списку» вернёт туда же). */
export function animeCardMessage(a: Anime, code: string, p: number, now: number, tz: string, ch: Character, opts: { note?: string; rand?: () => number } = {}): MessageBody {
  const e = effective(a, now);
  const lines = [`**${clip(a.title_ru, 120)}**${a.title_orig && a.title_orig !== a.title_ru ? ` (${clip(a.title_orig, 80)})` : ""}`];
  const total = a.episodes ? ` из ${a.episodes}` : "";
  lines.push(`Статус: ${STATUS_LABEL[a.status]} · серия ${a.watched}${total}`);
  if (a.status === "watching" || a.status === "planned") {
    if (e.upcoming) lines.push(`Следующая: ${e.upcoming.ep}-я, ${whenShort(e.upcoming.at, now, tz)}`);
    else if (a.src_status === "FINISHED") lines.push("Все серии уже вышли.");
    else lines.push("Дата следующей серии не объявлена.");
    if (e.airedEp > a.watched && a.status === "watching") lines.push(`Вышла ${e.airedEp}-я, вы ещё не отметили.`);
  }
  if (a.liked) lines.push(a.liked === 2 ? "Отметка: 🔥 в восторге" : a.liked === 1 ? "Отметка: ❤ понравилось" : "Отметка: так себе");
  const voice = a.status === "watching" || a.status === "planned" ? voiceLine(a) : null;
  if (voice) lines.push(voice[0].toUpperCase() + voice.slice(1));
  if (a.status === "dropped" && a.drop_reason) lines.push(`Причина: ${DROP_LABEL[a.drop_reason] ?? a.drop_reason}`);
  if (a.status === "watching") lines.push(`Уведомления: ${a.notify ? "вкл" : "выкл"}`);
  if (opts.note) lines.push(opts.note);
  const ctx = `${a.id}:${code}:${p}`;
  const rows: ActionRow[] = [
    row(
      btn("▶ Серия +1", `an:ep:${ctx}`, 3),
      btn("🔢 Указать номер…", `an:epm:${ctx}`),
      btn("❤ Понравилось", `an:lk:${a.id}:1:${code}:${p}`, a.liked === 1 ? 1 : 2),
      btn("🔥 В восторге", `an:lk:${a.id}:2:${code}:${p}`, a.liked === 2 ? 1 : 2),
      btn(a.notify ? "🔔 Уведомления: вкл" : "🔕 Уведомления: выкл", `an:nt:${ctx}`),
    ),
    row(...STATUS_ORDER.map((s) => btn(STATUS_LABEL[s], `an:st:${a.id}:${STATUS_CODE[s]}:${code}:${p}`, a.status === s ? 1 : 2, a.status === s))),
    row(btn("🗑 Удалить", `an:dl:${ctx}`, 4), btn("◀ К списку", `an:ls:${code}:${p}`), btn("🏠 Меню", "mn:home")),
  ];
  return body(withHaru(lines.join("\n"), haru("card", ch, opts.rand)), rows);
}

export function animeDeleteConfirm(a: Anime, code: string, p: number): MessageBody {
  return body(`Убрать **${clip(a.title_ru, 80)}** из коллекции? Серия и отметки пропадут.`, [row(btn("🗑 Да, убрать", `an:dy:${a.id}:${code}:${p}`, 4), btn("Нет, оставить", `an:it:${a.id}:${code}:${p}`))]);
}

export const animeModal = () =>
  modal("m_anadd", "Добавить аниме", [
    textLabel("Название (можно по-русски)", "name", { max: 100, placeholder: "Фрирен" }),
    selectLabel("Куда записать", "st", STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))),
    textLabel("На какой серии (можно не писать)", "ep", { required: false, max: 4, placeholder: "4" }),
  ]);

export const epModal = (a: Anime, code: string, p: number) =>
  modal(`m_anep:${a.id}:${code}:${p}`, "На какой серии вы остановились?", [textLabel("Номер серии", "ep", { max: 4, value: String(a.watched), placeholder: "7" })]);

const candLabel = (c: Candidate): string => {
  const extra = [c.kind === "movie" ? "фильм" : c.kind === "ova" ? "OVA" : c.kind === "special" || c.kind === "tv_special" ? "спецвыпуск" : "", c.year ? String(c.year) : ""].filter(Boolean).join(", ");
  return clip(`${c.ru}${extra ? ` · ${extra}` : ""}`, 80);
};

/** Варианты названия: до трёх кнопок и «Не то». */
export function candidatesMessage(cands: Candidate[], st: AnimeStatus, episode: number | null, ch: Character, rand?: () => number): MessageBody {
  const code = STATUS_CODE[st];
  const rows = cands.slice(0, 3).map((c) => row(btn(candLabel(c), `an:pk:${c.mal}:${code}:${episode ?? 0}`, 2)));
  rows.push(row(btn("Не то", "an:no", 4)));
  return body(withHaru("Какое из них записать?", haru("unclear", ch, rand)), rows);
}

export const NOT_FOUND_TEXT = "Такого названия не нашла. Попробуйте иначе: по-русски или как в оригинале, например «бот смотрю фрирен».";
export const SOURCE_DOWN_TEXT = "Сайт с названиями сейчас не отвечает (Shikimori). Повторите позже: бот ничего не записал.";

// ---------- утреннее «посмотрели?» ----------

export interface AskItem {
  a: Anime;
  airedEp: number;
  airedAt: number | null;
}

const askLine = (x: AskItem, now: number, tz: string): string => `▸ **${clip(x.a.title_ru, 60)}** — ${x.airedEp}-я${x.airedAt ? `, ${whenShort(x.airedAt, now, tz)}` : ""}`;

export function askMessage(items: AskItem[], now: number, tz: string, ch: Character, rand?: () => number): MessageBody {
  const ids = items.map((x) => x.a.id).join(".");
  const text = withHaru(`**🎬 Новые серии** — посмотрели?\n${items.map((x) => askLine(x, now, tz)).join("\n")}`, haru("ask", ch, rand));
  const buttons =
    items.length === 1
      ? [btn("✅ Посмотрел", `an:sn:all:${ids}`, 3), btn("😴 Не успел", `an:sn:no:${ids}`)]
      : [btn("✅ Посмотрел всё", `an:sn:all:${ids}`, 3), btn("Только некоторые…", `an:sn:pick:${ids}`), btn("😴 Не успел", `an:sn:no:${ids}`)];
  return body(text, [row(...buttons)]);
}

/** «Только некоторые…»: кнопка на каждый тайтл. */
export function askPickMessage(items: AskItem[], now: number, tz: string): MessageBody {
  const ids = items.map((x) => x.a.id).join(".");
  const rows = items.slice(0, 4).map((x) => row(btn(`✅ ${clip(x.a.title_ru, 50)} (${x.airedEp}-я)`, `an:sn:${x.a.id}:${ids}`, 2)));
  rows.push(row(btn("😴 Остальные — не успел", `an:sn:no:${ids}`)));
  return body(`**🎬 Какие посмотрели?**\n${items.map((x) => askLine(x, now, tz)).join("\n")}`, rows);
}

/** Если без ответа прошло три утра подряд: один раз спросить, продолжать ли. */
export function askPauseMessage(): MessageBody {
  return body("Я уже несколько дней спрашиваю про серии, а ответа нет. Записывать дальше, что вы смотрите? Или поставить вопросы на паузу.", [row(btn("Продолжай", "an:pz:on", 3), btn("Пауза", "an:pz:off"))]);
}

// ---------- вечер и неделя ----------

/** «Сегодня выходит» для вечерней сводки: серии с 06:00 до полуночи по Киеву (ночные — утром, как вышедшие). */
export function eveningLines(rows: Anime[], now: number, tz: string, ch: Character, rand?: () => number): string[] {
  const t0 = startOfDay(now, tz);
  const t1 = t0 + 24 * 60 * MINUTE;
  const list = noticeSet(rows)
    .map((a) => ({ a, up: effective(a, now).upcoming }))
    .filter((x): x is { a: Anime; up: { ep: number; at: number } } => x.up !== null && x.up.at >= t0 + 6 * 60 * MINUTE && x.up.at < t1)
    .sort((x, y) => x.up.at - y.up.at);
  if (!list.length) return [];
  const out = ["🎬 Аниме — сегодня выходит:"];
  for (const { a, up } of list) {
    const w = wallOf(up.at, tz);
    out.push(`• ${fmtHHMM(w.h * 60 + w.mi)} ${clip(a.title_ru, 60)} — ${up.ep}-я серия`);
    const voice = voiceLine(a);
    if (voice) out.push(voiceText(voice));
  }
  const line = haru("tonight", ch, rand);
  if (line) out.push(voiceText(line));
  return out;
}

/** Строка для /week: что выходит на неделе, по дням. null — ничего. */
export function weekAnimeText(rows: Anime[], now: number, tz: string): string | null {
  const end = startOfDay(now, tz) + 7 * 24 * 60 * MINUTE;
  const list = rows
    .filter((a) => a.status === "watching")
    .map((a) => ({ a, up: effective(a, now).upcoming }))
    .filter((x): x is { a: Anime; up: { ep: number; at: number } } => x.up !== null && x.up.at < end)
    .sort((x, y) => x.up.at - y.up.at);
  if (!list.length) return null;
  const byDay: { day: string; items: string[] }[] = [];
  for (const { a, up } of list) {
    const day = dayShort(up.at, now, tz);
    const item = `«${clip(a.title_ru, 40)}» ${up.ep}-я`;
    const last = byDay[byDay.length - 1];
    if (last && last.day === day) last.items.push(item);
    else byDay.push({ day, items: [item] });
  }
  return `**🎬 Аниме:** ${byDay.map((d) => `${d.day} — ${d.items.join(", ")}`).join(" · ")}`;
}

// ---------- «между прочим» (раз в неделю, воскресенье вечером) ----------
// Идентификаторы: an:wq:<вид>:<id>:<ответ>. Виды: e серия, l оценка, c продолжать ли, r причина «бросил», p давний план, q продолжение.

export type WeekAsk =
  | { kind: "ep"; a: Anime }
  | { kind: "liked"; a: Anime }
  | { kind: "cont"; a: Anime; idle: number }
  | { kind: "planned"; a: Anime; since: string }
  | { kind: "seq"; a: Anime; sequel: Sequel };

const ps = "**Между прочим:**";
const short = (a: Anime) => `«${clip(a.title_ru, 50)}»`;

/** Вопрос недели: один, короткий, кнопками. */
export function weekQuestion(q: WeekAsk, now: number, ch: Character, rand?: () => number): MessageBody {
  const a = q.a;
  switch (q.kind) {
    case "ep":
      return body(withHaru(`${ps} вы остановились на ${a.watched}-й серии ${short(a)}? Я записала. Поправьте, если ошиблась.`, haru("weekEp", ch, rand)), [
        row(btn(`Да, на ${a.watched}-й`, `an:wq:e:${a.id}:0`, 3), btn(`Уже на ${a.watched + 1}-й`, `an:wq:e:${a.id}:1`), btn("Ещё ниже", `an:wq:e:${a.id}:2`)),
      ]);
    case "liked":
      return body(withHaru(`${ps} ${short(a)} вам понравилось?`, haru("weekLiked", ch, rand)), [
        row(btn("🔥 В восторге", `an:wq:l:${a.id}:2`, 3), btn("❤ Понравилось", `an:wq:l:${a.id}:1`), btn("Так себе", `an:wq:l:${a.id}:3`), btn("Не хочу оценивать", `an:wq:l:${a.id}:0`)),
      ]);
    case "cont":
      return body(withHaru(`${ps} ${short(a)} не двигается уже ${weeksText(q.idle)}. Продолжаем?`, haru("weekCont", ch, rand)), [
        row(btn("Продолжаю", `an:wq:c:${a.id}:c`, 3), btn("Поставить на паузу", `an:wq:c:${a.id}:p`), btn("Бросил", `an:wq:c:${a.id}:d`, 4)),
      ]);
    case "planned":
      return body(withHaru(`${ps} ${short(a)} лежит в «В планах» ещё с ${q.since}. Всё ещё хочется?`, haru("weekPlanned", ch, rand)), [
        row(btn("Ещё хочу", `an:wq:p:${a.id}:y`, 3), btn("Уже нет", `an:wq:p:${a.id}:n`)),
      ]);
    case "seq":
      return body(withHaru(`${ps} у ${short(a)} ${q.sequel.status === "ongoing" ? "уже идёт" : "анонсировано"} продолжение: «${clip(q.sequel.ru, 70)}». Добавить в планы?`, haru("weekSeq", ch, rand)), [
        row(btn("Добавить в планы", `an:wq:q:${q.sequel.mal}:y`, 3), btn("Не нужно", `an:wq:q:${q.sequel.mal}:n`)),
      ]);
  }
}

/** После «Бросил»: почему (тем же сообщением). */
export function dropReasonMessage(a: Anime, ch: Character, rand?: () => number): MessageBody {
  return body(withHaru(`Понимаю, ${short(a)} брошено. А почему?`, haru("weekReason", ch, rand)), [
    row(
      btn("Скучно", `an:wq:r:${a.id}:b`),
      btn("Не успеваю", `an:wq:r:${a.id}:u`),
      btn("Слишком длинный", `an:wq:r:${a.id}:l`),
      btn("Не моё", `an:wq:r:${a.id}:n`),
      btn("Пропустить", `an:wq:r:${a.id}:s`),
    ),
  ]);
}

/** Снять вопрос через сутки без ответа: текст остаётся, кнопки уходят. */
export const weekExpiredBody = (): MessageBody => ({ components: [], allowed_mentions: { parse: [] } });

// ---------- начало сезона ----------

/** Утреннее сообщение в день старта тайтла из «В планах». */
export function seasonStartMessage(a: Anime, at: number, now: number, tz: string, ch: Character, rand?: () => number): MessageBody {
  const w = wallOf(at, tz);
  const when = at > now ? ` (в ${fmtHHMM(w.h * 60 + w.mi)})` : " — уже вышла";
  return body(withHaru(`**🎬 Начинается: ${clip(a.title_ru, 80)}**\nСегодня первая серия${when}. Вы планировали это посмотреть.`, haru("start", ch, rand)), [
    row(btn("Смотрю", `an:ss:${a.id}:w`, 3), btn("Позже", `an:ss:${a.id}:l`), btn("Не буду", `an:ss:${a.id}:n`)),
  ]);
}
