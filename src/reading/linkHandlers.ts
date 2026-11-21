// Чтение по ссылке: ответ на фразу со ссылкой («бот читаю <ссылка>», «Кауру тут: <ссылка>»). Кнопок нет (правило кнопок): ответ — обычное сообщение.
// Бот по домену выбирает сайт, запоминает ссылку и сайт (столбцы site* — миграция 0016), читает число русских глав там, где сайт это позволяет (Senkuro, ReManga, ReNovels, RanobeHub),
// а остальные сайты (MangaLib, RanobeLib, Com-X) держит в «ручном режиме»: ссылка хранится, глав бот там не видит и честно говорит об этом.
import { setMeta } from "../db/repo.ts";
import type { MessageBody } from "../discord/types.ts";
import { type ReadKind, type ReadStatus, type ReadUnit, type Reading, TRACK_LIMIT, chaptersText, clip, defaultUnit, haru, isTracked, norm, ownMatches, trackedSet, volumesText } from "./core.ts";
import type { ReadCtx } from "./handlers.ts";
import type { ReadLinkSay } from "./linkSay.ts";
import type { SiteDef } from "./siteIds.ts";
import { patchByMalOp, syntheticMal } from "./siteStore.ts";
import { type SiteLink, type SiteTitle, parseSiteLink, readSite } from "./sites.ts";
import { type FetchFn, type ReadCand, searchRead, shikiOne } from "./sources.ts";
import { type NewReading, type Patch, insertOp, listReading, patchOp } from "./store.ts";
import { ambiguousOwn, savedMessage } from "./ui.ts";

const text = (content: string): MessageBody => ({ content: clip(content, 1950), components: [], allowed_mentions: { parse: [] } });

/** fetch, который считает каждый запрос в бюджет подзапросов запуска Worker. */
const counted = (c: ReadCtx): FetchFn => (c.spend ? (((input: unknown, init?: RequestInit) => (c.spend?.(1), c.fetchFn(input as RequestInfo, init))) as unknown as FetchFn) : c.fetchFn);

export const notTitleText = (site: SiteDef): string =>
  `Это не страница тайтла на ${site.name} (главная, каталог или список обновлений). Пришлите ссылку на конкретную мангу или ранобэ, например «бот читаю <ссылка на тайтл>».`;
export const askNameText = (site: SiteDef): string =>
  `Страницу на ${site.name} не получилось открыть, а названия я там не увидела. Напишите название вместе со ссылкой: «бот Название тут: ссылка».`;

/** Почему бот не читает главы на этом сайте: простыми словами. */
const manualWhy = (link: SiteLink): string => (link.key === null ? "сайт просит программы не заходить в этот раздел" : (link.site.why ?? "сайт закрыт для программ"));

const whenLine = (c: ReadCtx): string => (c.weeklyOn === false ? "Сообщения о чтении сейчас выключены («⋯ Ещё»)." : "Напишу в субботу, если что-то накопится.");

/** Фраза-подсказка про отметку прочитанного: бот не знает, где хозяин остановился на сайте. */
const MARK_HINT = "Что вы уже прочитали, я не вижу: отмечайте фразой «прочитал главу 120 …».";

/** Что сказать о слежении: честно, что бот видит на сайте и чего нет. */
export function siteNote(link: SiteLink, t: SiteTitle | null, c: ReadCtx, known = false): string {
  const hint = known ? "" : ` ${MARK_HINT}`; // «что прочитано» подсказываем, только если хозяин ещё не говорил, где остановился
  const name = link.site.name;
  const counting = link.site.counts && !!link.key;
  if (!counting) {
    // ранобэ: русские тома и главы ищу на RanobeHub (по ним и пишу), MangaUpdates — оригинал, о нём только по вопросу «какой том»
    const general =
      link.kind === "ranobe"
        ? `По RanobeHub попробую найти название ночью: если оно там есть по-русски, напишу про новые тома, но что вышло именно на ${name}, он не покажет.`
        : `По общим источникам (MangaDex, MangaUpdates) попробую найти название ночью, но что вышло именно на ${name}, они не покажут.`;
    return `${name}: ${manualWhy(link)}, поэтому глав там сама не вижу. Ссылку запомнила и подставлю в сообщения. ${general}${hint}`;
  }
  if (!t) return `${name} сейчас не открылся. Ссылку запомнила, число глав посчитаю ночью. ${whenLine(c)}`;
  if (!t.ch && !t.vol) return `На ${name} по-русски пока нет ни одной главы, поэтому о новых писать не буду, пока они не появятся. Ссылку запомнила.`;
  const have = [t.vol ? volumesText(t.vol) : "", t.ch ? chaptersText(t.ch) : ""].filter(Boolean).join(", ");
  return `Слежу на ${name}: по-русски там сейчас ${have}. ${whenLine(c)}${hint}`;
}

/** Чем считать тайтл с сайта: манга — главами; ранобэ — томами, если они там настоящие (больше одного, или один небольшой), а у веб-новелл (томов нет или один «том» на сотни глав) — главами. */
export function pickUnit(kind: ReadKind, t: Pick<SiteTitle, "ch" | "vol">): ReadUnit {
  if (kind !== "ranobe") return "ch";
  if (t.vol > 1 || (t.vol === 1 && t.ch < 20)) return "vol";
  return t.ch > 0 ? "ch" : "vol";
}

const overLimit = (rows: Reading[], fresh: Reading): boolean => isTracked(fresh) && !trackedSet(rows.map((r) => (r.id === fresh.id ? fresh : r))).some((r) => r.id === fresh.id);

/** Прочитать тайтл на сайте; у RanobeHub, если страница не открылась, пробуем искать по названию из фразы. */
async function readTitle(link: SiteLink, x: ReadLinkSay, f: FetchFn): Promise<SiteTitle | null> {
  if (!link.key) return null;
  let t = await readSite(link.site, link.url, link.key, f);
  if (!t && link.site.id === "ranobehub" && x.name) t = await readSite(link.site, link.url, link.key, f, { q: x.name, ru: x.name });
  return t;
}

/** Разобрать фразу со ссылкой. null — «не моё»: фраза про чужое название без обращения, остаётся обычным делом. */
export async function handleReadLink(c: ReadCtx, x: ReadLinkSay): Promise<MessageBody | null> {
  const parsed = parseSiteLink(x.url);
  if (!parsed) return null;
  if (!parsed.link) return text(notTitleText(parsed.site));
  if (c.any === false && x.action === "attach" && !x.prefixed) return null;
  const link = parsed.link;
  const rows = await listReading(c.repo);
  const bySite = rows.find((r) => r.site === link.site.id && (link.key ? r.site_key === link.key : r.site_url === link.url)) ?? null;
  const own = x.name ? ownMatches(rows, x.name, x.kind) : [];
  if (!bySite && own.length > 1) return text(ambiguousOwn(own));
  const target = bySite ?? own[0] ?? null;
  if (!target && x.action === "attach" && !x.prefixed) return null;
  return target ? attachToOwn(c, x, link, target, rows) : addFromLink(c, x, link, rows);
}

/** Тайтл уже в списке: запомнить ссылку и сайт, у сайта со счётчиком — перейти на его счётчик. */
async function attachToOwn(c: ReadCtx, x: ReadLinkSay, link: SiteLink, r: Reading, rows: Reading[], tIn?: SiteTitle | null): Promise<MessageBody> {
  const counting = link.site.counts && !!link.key;
  const t = tIn !== undefined ? tIn : counting ? await readTitle(link, x, counted(c)) : null;
  const patch: Patch = { site: link.site.id, site_url: link.url, site_key: link.key, site_q: t?.q ?? null };
  if (counting) {
    if (t) {
      // счётчик меняется (MangaDex → сайт): первая цифра с сайта — отправная точка, про накопленное не пишем как про новое
      Object.assign(patch, { site_at: c.now, ru_ch: t.ch, ru_vol: t.vol, src_ch: Math.max(r.src_ch, t.ch), src_vol: Math.max(r.src_vol, t.vol), told_ch: t.ch, told_vol: t.vol });
    } else {
      Object.assign(patch, { ru_ch: null, ru_vol: null }); // сайт не открылся: ночью первая цифра станет отправной точкой
    }
  }
  const status: ReadStatus = x.action === "start" ? "reading" : x.action === "plan" ? "planned" : r.status;
  if (status !== r.status) patch.status = status;
  await c.repo.exec([patchOp(r.id, patch, c.now), setMeta("reading_on", "1")]);
  c.onAdded?.();
  const fresh = { ...r, ...patch, last_move_at: status !== r.status ? c.now : r.last_move_at } as Reading;
  const line = haru("readAck", c.character, c.rand);
  return savedMessage({ r: fresh, how: "changed", sourceNote: siteNote(link, t, c, r.read_ch !== null || r.read_vol !== null), overLimit: overLimit(rows, fresh), line });
}

/** Нового тайтла в списке нет: завести по ссылке (название — из фразы или со страницы сайта), сверить с Shikimori, записать. */
async function addFromLink(c: ReadCtx, x: ReadLinkSay, link: SiteLink, rows: Reading[]): Promise<MessageBody> {
  const f = counted(c);
  const counting = link.site.counts && !!link.key;
  // страницу читаем, если сайт со счётчиком или если нужно название (у MangaLib и RanobeLib оно есть в странице; Com-X пускает только браузер)
  const t = link.key && (counting || !x.name) ? await readTitle(link, x, f) : null;
  const name = x.name ?? t?.title ?? null;
  if (!name) return text(askNameText(link.site));
  const kind = link.kind;

  // тайтл на Shikimori: Senkuro знает номер MyAnimeList, у остальных ищем по названию и берём только точное совпадение
  let cand: ReadCand | null = t?.mal ? await shikiOne(t.mal, f) : null;
  if (!cand && !t?.mal) {
    const names = new Set([name, t?.title, t?.orig, ...(t?.alts ?? [])].filter((s): s is string => !!s).map(norm));
    const exact = ((await searchRead(name, kind, f)) ?? []).filter((cn) => names.has(norm(cn.ru)) || (!!cn.orig && names.has(norm(cn.orig))));
    if (exact.length === 1) cand = exact[0];
  }
  const mal = cand?.mal ?? t?.mal ?? syntheticMal(link.site.id, link.key ?? link.url);
  const dup = rows.find((r) => r.mal_id === mal);
  if (dup) return attachToOwn(c, x, link, dup, rows, counting ? t : null);

  const pick: ReadCand = { ...(cand ?? { mal, ru: name, orig: t?.orig ?? "", kind, status: "", volumes: 0, chapters: 0, year: null }), kind };
  // сайт без счётчика: прежние источники (MangaDex, MangaUpdates) остаются запасными, если тайтл есть на Shikimori; найдёт их ночная проверка (map_at пуст)
  const finished = pick.status === "finished";
  const siteCh = counting && t ? t.ch : 0;
  const siteVol = counting && t ? t.vol : 0;
  const status: ReadStatus = x.action === "plan" ? "planned" : "reading";
  const unit: ReadUnit = counting && t ? pickUnit(kind, t) : defaultUnit(kind);
  const n: NewReading = {
    mal,
    kind,
    ru: name,
    orig: pick.orig || t?.orig || null,
    status,
    unit,
    readCh: null,
    readVol: null,
    totalCh: finished && pick.chapters ? pick.chapters : null,
    totalVol: finished && pick.volumes ? pick.volumes : null,
    srcStatus: pick.status || null,
    srcCh: Math.max(siteCh, finished ? pick.chapters : 0),
    srcVol: Math.max(siteVol, finished ? pick.volumes : 0),
    ruCh: counting ? (t ? t.ch : null) : null,
    ruVol: counting ? (t ? t.vol : null) : null,
    srcUrl: link.url,
    mdId: null,
    muId: null,
    rhId: null,
    mapAt: counting || mal < 0 ? c.now : null,
    rhMapAt: null,
    now: c.now,
  };
  const siteFields: Patch = { site: link.site.id, site_url: link.url, site_key: link.key, site_q: t?.q ?? null, site_at: counting && t ? c.now : null };
  if (counting) Object.assign(siteFields, { told_ch: t?.ch ?? 0, told_vol: t?.vol ?? 0 });
  await c.repo.exec([insertOp(n), patchByMalOp(mal, siteFields, c.now), setMeta("reading_on", "1")]);
  c.onAdded?.();
  const fresh: Reading = {
    id: 0, mal_id: mal, kind, title_ru: name, title_orig: n.orig, status, unit, read_ch: null, read_vol: null, liked: 0, total_ch: n.totalCh, total_vol: n.totalVol, src_status: n.srcStatus,
    src_ch: n.srcCh, src_vol: n.srcVol, src_at: null, ru_ch: n.ruCh, ru_vol: n.ruVol, src_url: link.url, md_id: n.mdId, mu_id: n.muId, rh_id: n.rhId, rh_map_at: n.rhMapAt, map_at: n.mapAt,
    checked_at: c.now, chk_fail: 0, shiki_at: null, told_ch: counting ? (t?.ch ?? 0) : (n.ruCh ?? 0), told_vol: counting ? (t?.vol ?? 0) : (n.ruVol ?? 0),
    end_told: finished ? 1 : 0, adapt_mal: null, adapt_ru: null, adapt_status: null, adapt_at: null, adapt_told: null, weekq_at: null, last_move_at: c.now, added_at: c.now, updated_at: c.now,
    ...siteFields,
  } as Reading;
  const line = haru("added", c.character, c.rand);
  return savedMessage({ r: fresh, how: "added", sourceNote: siteNote(link, t, c), overLimit: isTracked(fresh) && trackedSet(rows).length >= TRACK_LIMIT, line });
}
