// Чтение: действия по живым фразам и вопросам хозяина. Кнопок нет (правило кнопок): ответ — обычное сообщение, поправить можно новой фразой.
// Осторожность: незнакомое название фраза записывает только с обращением («бот», «Хару») или словом «манга» / «ранобэ»; иначе это обычное дело.
import { type Repo, setMeta } from "../db/repo.ts";
import type { MessageBody } from "../discord/types.ts";
import type { Character } from "../flavor.ts";
import {
  type ReadStatus,
  type ReadUnit,
  type Reading,
  TRACK_LIMIT,
  clip,
  defaultUnit,
  haru,
  hasRussian,
  isTracked,
  norm,
  ownMatches,
  rankWeek,
  trackedSet,
  volumesText,
  weekItems,
} from "./core.ts";
import { handleReadLink } from "./linkHandlers.ts";
import { type ReadLinkSay, parseReadLink } from "./linkSay.ts";
import { lookupSource } from "./refresh.ts";
import { parseReadAsk, parseReadSay, type ReadAsk, type ReadSay } from "./say.ts";
import { type FetchFn, type ReadCand, searchRead } from "./sources.ts";
import { type NewReading, type Patch, insertOp, listReading, patchOp } from "./store.ts";
import { SOURCE_DOWN_TEXT, ambiguousFound, ambiguousOwn, listText, newsText, notFoundText, savedMessage, whereText } from "./ui.ts";

export interface ReadCtx {
  repo: Repo;
  now: number;
  tz: string;
  character: Character;
  fetchFn: FetchFn;
  rand?: () => number;
  /** учесть n подзапросов к сети (бюджет запуска); без него — не считаем (тесты) */
  spend?: (n: number) => void;
  /** субботнее сообщение включено (чтобы честно сказать, придёт ли оно) */
  weeklyOn?: boolean;
  /** в чтении уже есть хоть один тайтл (метка `reading_on` в meta): нет — фраза без обращения даже не читает базу, это обычное дело */
  any?: boolean;
  /** в базу записали тайтл и метку `reading_on`: вызывающий обновляет свою копию меты (фразы в тот же запуск уже видят чтение) */
  onAdded?: () => void;
}

const text = (content: string): MessageBody => ({ content, components: [], allowed_mentions: { parse: [] } });

/** fetch, который считает каждый запрос в бюджет подзапросов запуска Worker. */
const counted = (c: ReadCtx): FetchFn => (c.spend ? (((input: unknown, init?: RequestInit) => (c.spend?.(1), c.fetchFn(input as RequestInfo, init))) as unknown as FetchFn) : c.fetchFn);

/** Разобрать сообщение хозяина: вопрос, живая фраза или фраза со ссылкой на сайт чтения; null — это не про чтение. */
export function parseReading(textIn: string): { ask: ReadAsk } | { say: ReadSay } | { link: ReadLinkSay } | null {
  const link = parseReadLink(textIn);
  if (link) return { link };
  const ask = parseReadAsk(textIn);
  if (ask) return { ask };
  const say = parseReadSay(textIn);
  return say ? { say } : null;
}

/** Ответ на фразу или вопрос. null — «не моё»: фраза про чужое название без обращения, остаётся обычным делом. */
export async function handleReading(c: ReadCtx, x: { ask: ReadAsk } | { say: ReadSay } | { link: ReadLinkSay }): Promise<MessageBody | null> {
  if ("link" in x) return handleReadLink(c, x.link);
  return "ask" in x ? handleReadAsk(c, x.ask) : handleReadSay(c, x.say);
}

// ---------- вопросы ----------

export async function handleReadAsk(c: ReadCtx, q: ReadAsk): Promise<MessageBody> {
  const rows = await listReading(c.repo);
  if (q.kind === "list") return text(listText(rows, c.character, c.rand));
  if (q.kind === "news") {
    const tracked = trackedSet(rows);
    return text(newsText(rankWeek(weekItems(tracked)), tracked.length, tracked.filter((r) => !hasRussian(r))));
  }
  const hits = ownMatches(rows, q.query, null);
  if (hits.length > 1) return text(ambiguousOwn(hits));
  if (!hits.length) return text(`«${clip(q.query, 40)}» в вашем чтении нет. Добавить: «бот читаю мангу ${clip(q.query, 40)}».`);
  return text(whereText(hits[0]));
}

// ---------- запись ----------

interface ReadBase {
  read_ch: number | null;
  read_vol: number | null;
  unit: ReadUnit;
  src_status: string | null;
  src_ch: number;
  src_vol: number;
  total_ch: number | null;
  total_vol: number | null;
}

/** Что записать в «прочитано» по фразе. "no-last": просили «последнюю главу», а источник её не показывает. guessed: считали от нуля. */
export function readTarget(b: ReadBase, say: ReadSay): { patch: Patch; guessed: boolean; unit: ReadUnit; value: number | null } | "no-last" {
  const unit: ReadUnit = say.unit ?? (say.chapter !== null ? "ch" : say.volume !== null ? "vol" : b.unit);
  const total = (u: ReadUnit): number | null => (u === "ch" ? b.total_ch : b.total_vol);
  const cap = (n: number, u: ReadUnit): number => (total(u) !== null && n > (total(u) as number) ? (total(u) as number) : n);
  const patch: Patch = {};
  let guessed = false;
  let value: number | null = null;
  if (say.chapter !== null || say.volume !== null) {
    if (say.chapter !== null) patch.read_ch = cap(say.chapter, "ch");
    if (say.volume !== null) patch.read_vol = cap(say.volume, "vol");
    value = unit === "ch" ? (patch.read_ch ?? null) : (patch.read_vol ?? null);
  } else if (say.last) {
    const top = unit === "ch" ? b.src_ch : b.src_vol;
    if (top <= 0) return "no-last";
    value = cap(top, unit);
    patch[unit === "ch" ? "read_ch" : "read_vol"] = value;
  } else if (say.next) {
    const base = unit === "ch" ? b.read_ch : b.read_vol;
    guessed = base === null;
    value = cap((base ?? 0) + 1, unit);
    patch[unit === "ch" ? "read_ch" : "read_vol"] = value;
  }
  if (value !== null) patch.unit = unit;
  return { patch, guessed, unit, value };
}

/** Статус после «прочитал»: дочитал до конца закончившегося — «Дочитал», догнал идущее — «Жду продолжения», иначе «Читаю». */
export function statusAfterRead(b: ReadBase, unit: ReadUnit, value: number): ReadStatus {
  const top = unit === "ch" ? b.src_ch : b.src_vol;
  const total = (unit === "ch" ? b.total_ch : b.total_vol) ?? (top > 0 ? top : null);
  if (b.src_status === "finished") return total !== null && value >= total ? "done" : "reading";
  return top > 0 && value >= top ? "waiting" : "reading";
}

const NO_LAST = "Сколько глав вышло, я пока не знаю. Скажите номер: «прочитал главу 120 …».";

function lineFor(action: ReadSay["action"], st: ReadStatus, how: "added" | "changed", c: ReadCtx): string | null {
  if (action === "drop") return haru("dropped", c.character, c.rand);
  if (action === "plan" || action === "start") return how === "added" ? haru("added", c.character, c.rand) : null;
  if (st === "waiting") return haru("caughtUp", c.character, c.rand);
  if (st === "done") return haru("finished", c.character, c.rand);
  return haru("readAck", c.character, c.rand);
}

const overLimit = (rows: Reading[], fresh: Reading): boolean => isTracked(fresh) && !trackedSet(rows.map((r) => (r.id === fresh.id ? fresh : r))).some((r) => r.id === fresh.id);

/** Фраза: своё название — сразу; чужое — только с обращением (поиск на Shikimori и запись); иначе null. */
export async function handleReadSay(c: ReadCtx, say: ReadSay): Promise<MessageBody | null> {
  if (c.any === false && !say.prefixed) return null;
  const rows = await listReading(c.repo);
  const own = ownMatches(rows, say.query, say.kind);
  if (own.length > 1) return text(ambiguousOwn(own));
  if (own.length === 1) return applyOwn(c, own[0], say, rows);
  if (!say.prefixed) return null;
  if (say.action === "drop") return text(`«${clip(say.query, 40)}» у меня в чтении не записано, так что бросать нечего.`);
  return addNew(c, say, rows);
}

async function applyOwn(c: ReadCtx, r: Reading, say: ReadSay, rows: Reading[]): Promise<MessageBody> {
  let patch: Patch = {};
  let guessed = false;
  if (say.action === "drop") patch.status = "dropped";
  else if (say.action === "plan") patch.status = "planned";
  else {
    const t = readTarget(r, say);
    if (t === "no-last") return text(NO_LAST);
    patch = { ...t.patch };
    guessed = t.guessed;
    if (say.action === "read" && t.value === null) return text("Не поняла, до какой главы или тома вы дочитали. Скажите: «прочитал главу 120 …».");
    patch.status = say.action === "read" && t.value !== null ? statusAfterRead(r, t.unit, t.value) : "reading";
  }
  await c.repo.exec([patchOp(r.id, patch, c.now), setMeta("reading_on", "1")]);
  c.onAdded?.();
  const fresh = { ...r, ...patch, last_move_at: c.now } as Reading;
  return savedMessage({ r: fresh, how: "changed", guessed, overLimit: overLimit(rows, fresh), line: lineFor(say.action, fresh.status, "changed", c) });
}

/** Новое название: поиск на Shikimori, привязка к источнику счётчиков, запись. */
async function addNew(c: ReadCtx, say: ReadSay, rows: Reading[]): Promise<MessageBody> {
  const f = counted(c);
  const cands = await searchRead(say.query, say.kind, f);
  if (cands === null) return text(SOURCE_DOWN_TEXT);
  if (!cands.length) return text(notFoundText(say.query));
  const q = norm(say.query);
  const exact = cands.filter((x) => norm(x.ru) === q || norm(x.orig) === q);
  const pick: ReadCand | null = cands.length === 1 ? cands[0] : exact.length === 1 ? exact[0] : null;
  if (!pick) return text(ambiguousFound(cands));
  const dup = rows.find((r) => r.mal_id === pick.mal);
  if (dup) return applyOwn(c, dup, say, rows);

  const src = await lookupSource(pick, f);
  const finished = pick.status === "finished";
  const base: ReadBase = {
    read_ch: null,
    read_vol: null,
    unit: say.unit ?? defaultUnit(pick.kind),
    src_status: pick.status || null,
    src_ch: Math.max(src.ch, finished ? pick.chapters : 0),
    src_vol: Math.max(src.vol, finished ? pick.volumes : 0),
    total_ch: finished && pick.chapters ? pick.chapters : null,
    total_vol: finished && pick.volumes ? pick.volumes : null,
  };
  let status: ReadStatus = say.action === "plan" ? "planned" : "reading";
  let patch: Patch = {};
  let guessed = false;
  if (say.action === "read" || say.action === "start") {
    const t = readTarget(base, say);
    if (t === "no-last") return text(NO_LAST);
    patch = t.patch;
    guessed = t.guessed;
    if (say.action === "read" && t.value === null) return text("Не поняла, до какой главы или тома вы дочитали. Скажите: «бот прочитал главу 120 …».");
    if (say.action === "read" && t.value !== null) status = statusAfterRead(base, t.unit, t.value);
  }
  const n: NewReading = {
    mal: pick.mal,
    kind: pick.kind,
    ru: pick.ru,
    orig: pick.orig || null,
    status,
    unit: (patch.unit as ReadUnit | undefined) ?? base.unit,
    readCh: patch.read_ch ?? null,
    readVol: patch.read_vol ?? null,
    totalCh: base.total_ch,
    totalVol: base.total_vol,
    srcStatus: base.src_status,
    srcCh: base.src_ch,
    srcVol: base.src_vol,
    ruCh: src.ruCh,
    ruVol: src.ruVol,
    srcUrl: src.url,
    mdId: src.mdId,
    muId: src.muId,
    rhId: src.rhId,
    mapAt: src.search === "fail" ? null : c.now,
    rhMapAt: src.rhSearch === null || src.rhSearch === "fail" ? null : c.now,
    now: c.now,
  };
  await c.repo.exec([insertOp(n), setMeta("reading_on", "1")]);
  c.onAdded?.();
  const fresh: Reading = {
    id: 0, mal_id: n.mal, kind: n.kind, title_ru: n.ru, title_orig: n.orig, status: n.status, unit: n.unit, read_ch: n.readCh, read_vol: n.readVol, liked: 0,
    total_ch: n.totalCh, total_vol: n.totalVol, src_status: n.srcStatus, src_ch: n.srcCh, src_vol: n.srcVol, src_at: null, ru_ch: n.ruCh, ru_vol: n.ruVol, src_url: n.srcUrl, md_id: n.mdId, mu_id: n.muId,
    rh_id: n.rhId, rh_map_at: n.rhMapAt, map_at: n.mapAt, checked_at: c.now, chk_fail: 0, shiki_at: null, told_ch: n.kind === "manga" ? (n.ruCh ?? 0) : n.srcCh, told_vol: n.kind === "manga" ? (n.ruVol ?? 0) : n.srcVol, end_told: finished ? 1 : 0, adapt_mal: null, adapt_ru: null, adapt_status: null,
    adapt_at: null, adapt_told: null, weekq_at: null, last_move_at: c.now, added_at: c.now, updated_at: c.now,
  };
  return savedMessage({ r: fresh, how: "added", guessed, sourceNote: sourceNote(pick, src, c), overLimit: isTracked(fresh) && trackedSet(rows).length >= TRACK_LIMIT, line: lineFor(say.action, status, "added", c) });
}

/** Честно: чем и как слежу за этим названием. */
function sourceNote(pick: ReadCand, src: Awaited<ReturnType<typeof lookupSource>>, c: ReadCtx): string {
  const when = c.weeklyOn === false ? "Сообщения о чтении сейчас выключены («⋯ Ещё»)." : "Напишу в субботу, если что-то накопится.";
  if (pick.kind === "manga") {
    if (src.search === "fail") return "MangaDex сейчас не ответил, найду это название ночью.";
    if (src.mdId && src.counted) {
      if (src.ruCh === null) return `Главы смотрю по MangaDex, русский перевод проверю ночью. ${when}`;
      if (!src.ruCh && !src.ruVol) return "На MangaDex это название есть, но русского перевода там пока нет, поэтому о новых главах писать не буду, пока он не появится.";
      return `Главы смотрю по MangaDex, пишу только про то, что там есть по-русски: сейчас ${src.ruCh ? `до главы ${src.ruCh}` : `до тома ${src.ruVol}`}. ${when}`;
    }
    if (src.mdId) return `Нашла название на MangaDex, но число глав пока не прочиталось, догоню ночью. ${when}`;
    return "На MangaDex этого названия нет, поэтому главы сама не вижу. Отмечайте прочитанное фразой «прочитал …», я посчитаю.";
  }
  // ранобэ: тома по MangaUpdates (язык там не различается), русская строка по RanobeHub — справочно
  const ru = src.rhId && (src.ruVol || src.ruCh) ? ` По-русски на RanobeHub ${src.ruVol ? `есть до тома ${src.ruVol}` : `есть до главы ${src.ruCh}`}.` : "";
  if (src.search === "fail") return `MangaUpdates сейчас не ответил, найду это название ночью.${ru}`;
  if (src.muId && src.counted) return `Тома смотрю по MangaUpdates (там число томов ведут люди, оно может отставать): сейчас вышло ${volumesText(src.vol)}. ${when}${ru}`;
  if (src.muId) return `Нашла название на MangaUpdates, но число томов там не указано. Отмечайте прочитанное фразой «прочитал том …», я посчитаю.${ru}`;
  return `По ранобэ у меня нет надёжного источника новых томов, и этого названия я там не нашла. Отмечайте прочитанное фразой «прочитал том …», я посчитаю.${ru}`;
}
