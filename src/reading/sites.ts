// Чтение по ссылкам на сайты, где хозяин реально читает по-русски (разведка 2026-11-19, подробности и ответы сайтов — docs/RECON-READING-SITES.md).
// Бот открывает ТОЛЬКО публичную страницу тайтла (по одному тайтлу за запрос, не чаще раза в ночь) и читает из неё число русских глав:
//  • Senkuro  — страница тайтла встраивает состояние (`window.__SENKURO__`): число глав русской ветки, номер MyAnimeList, названия. robots.txt: /graphql и /*/*/chapters/* закрыты — их не трогаем.
//  • ReManga и ReNovels (один движок) — страница `/manga/<имя>/main` или `/novel/<имя>/main` встраивает данные тайтла: `main_name`, `count_chapters`. robots.txt закрывает /api и /title — их не трогаем.
//  • RanobeHub — открытый JSON поиска (`/api/search`, robots.txt разрешает; закрыты только /api/user и /api/admin): тома и главы по-русски; страница тайтла нужна один раз, чтобы узнать названия.
//  • MangaLib, RanobeLib — страница отдаёт только название (разметка для поисковиков), список глав закрыт защитой (DDoS-Guard, 403): ручной режим.
//  • Com-X — перед страницами проверка «вы человек» на JavaScript: не обходим, ручной режим.
// Любой сбой, страница-заглушка или незнакомая разметка = null: проверка повторится, ничего не ломаем и ничего не выдумываем.
import type { ReadKind } from "./core.ts";
import { type SiteDef, SITES, siteByHost } from "./siteIds.ts";
import { type FetchFn, rhRefresh } from "./sources.ts";

/** Так бот представляется сайтам (честно: личный бот, без подделки под браузер). */
export const SITE_UA = "MeidoBot (personal, 0.1)";
const PAGE_TIMEOUT_MS = 7000;
/** Страницы ReManga и ReNovels весят до мегабайта; нужные данные лежат в первых десятках килобайт, дальше не читаем. */
const PAGE_MAX_CHARS = 900_000;

// ---------- разбор ссылки ----------

/** Страница тайтла по ссылке хозяина. */
export interface SiteLink {
  site: SiteDef;
  /** как найти тайтл на сайте; null — число глав с этого адреса читать нельзя (раздел закрыт сайтом): ручной режим */
  key: string | null;
  /** адрес страницы тайтла без параметров: его бот хранит и подставляет в сообщения */
  url: string;
  kind: ReadKind;
}

/** null — домен не наш; link null — домен наш, но это не страница тайтла (главная, каталог, список обновлений). */
export type LinkParse = { site: SiteDef; link: SiteLink | null } | null;

/** Разделы, которые стоят в адресе там же, где имя тайтла, но тайтлом не являются. */
const NOT_A_TITLE = new Set(["hot-updates", "list", "new", "top", "popular", "catalog", "random", "search", "rating", "calendar", "bookmarks"]);

const dec = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** Имя тайтла в адресе (ReManga и ReNovels кладут туда любые знаки, даже «<»): нормальный вид — как кодирует сам сайт. */
const dirOf = (s: string | undefined): string | null => {
  const d = s ? dec(s) : null;
  return d && d.length >= 2 && d.length <= 200 && !/\s/.test(d) && !NOT_A_TITLE.has(d.toLowerCase()) ? encodeURIComponent(d) : null;
};

const slugOf = (s: string | undefined): string | null => (s && /^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/.test(s) && !NOT_A_TITLE.has(s.toLowerCase()) ? s : null);

/** Разобрать ссылку на тайтл. Параметры и «#…» отбрасываем: у ReManga в них «progress» хозяина, у MangaLib — служебные метки. */
export function parseSiteLink(raw: string): LinkParse {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const site = siteByHost(u.hostname);
  if (!site) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  const mk = (key: string | null, url: string, kind: ReadKind): LinkParse => ({ site, link: { site, key, url, kind } });
  const none: LinkParse = { site, link: null };
  switch (site.id) {
    case "senkuro": {
      const slug = seg[0] === "manga" ? slugOf(seg[1]) : null;
      return slug ? mk(slug.toLowerCase(), `https://senkuro.com/manga/${slug.toLowerCase()}`, "manga") : none;
    }
    case "remanga": {
      if (seg[0] === "novel") {
        // robots.txt ReManga закрывает /novel целиком: ссылку храним, читать не пытаемся
        const dir = dirOf(seg[1]);
        return dir ? mk(null, `https://remanga.org/novel/${dir}`, "ranobe") : none;
      }
      const dir = seg[0] === "manga" ? dirOf(seg[1]) : null;
      return dir ? mk(dir, `https://remanga.org/manga/${dir}`, "manga") : none;
    }
    case "renovels": {
      const dir = seg[0] === "novel" || seg[0] === "manga" ? dirOf(seg[1]) : null;
      return dir ? mk(dir, `https://renovels.org/${seg[0]}/${dir}`, seg[0] === "novel" ? "ranobe" : "manga") : none;
    }
    case "ranobehub": {
      const m = seg[0] === "ranobe" ? /^(\d{1,7})(?:-.*)?$/.exec(seg[1] ?? "") : null;
      return m ? mk(m[1], `https://ranobehub.org/ranobe/${m[1]}`, "ranobe") : none;
    }
    case "mangalib":
    case "ranobelib": {
      const rest = seg[0] === "ru" || seg[0] === "en" ? seg.slice(1) : seg;
      const word = site.id === "mangalib" ? "manga" : "book";
      const key = slugOf(rest[0] === word ? rest[1] : /^\d+--/.test(rest[0] ?? "") ? rest[0] : undefined);
      return key ? mk(key, `https://${site.hosts[0]}/ru/${word}/${key}`, site.id === "mangalib" ? "manga" : "ranobe") : none;
    }
    case "comx": {
      const m = seg.length === 1 ? /^(\d+-[A-Za-z0-9-]+)\.html$/.exec(seg[0]) : null;
      return m ? mk(m[1], `https://com-x.life/${m[1]}.html`, "manga") : none;
    }
  }
}

// ---------- чтение страницы ----------

/**
 * Прочитать страницу кусками и остановиться, как только `enough` скажет, что нужное есть (страницы по мегабайту не читаем целиком: процессорное время Worker мало).
 * null — сайт не ответил, ответил не «200», это заглушка (нужного в странице нет) или страница слишком длинная.
 */
export async function readPage(f: FetchFn, url: string, enough: (s: string) => boolean, max = PAGE_MAX_CHARS): Promise<string | null> {
  try {
    const r = await f(url, { headers: { "User-Agent": SITE_UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "ru" }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), redirect: "follow" });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    const td = new TextDecoder();
    let acc = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += td.decode(value, { stream: true });
      if (enough(acc) || acc.length > max) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    return enough(acc) ? acc : null;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string): string =>
  s.replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,5})|([a-z]{2,6}));/gi, (m, d: string | undefined, h: string | undefined, n: string | undefined) => {
    if (d) return String.fromCodePoint(Number(d));
    if (h) return String.fromCodePoint(Number.parseInt(h, 16));
    return ENTITIES[(n ?? "").toLowerCase()] ?? m;
  });

/** Что узнали о тайтле на сайте. */
export interface SiteTitle {
  /** название по-русски (как на сайте) */
  title: string;
  /** оригинальное название; null — сайт его не даёт */
  orig: string | null;
  /** другие названия сайта: для сверки с Shikimori */
  alts: string[];
  /** номер MyAnimeList, если сайт его знает (Senkuro) — он же номер Shikimori */
  mal: number | null;
  /** сколько глав и томов по-русски есть на сайте (0 — нет или сайт не показывает) */
  ch: number;
  vol: number;
  /** запрос, по которому тайтл находится на сайте без страницы (RanobeHub) */
  q: string | null;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000 ? Math.floor(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ---------- Senkuro ----------

/** Страница тайтла встраивает состояние: `window.__SENKURO__=({… graphql:{"хеш":{hasNext:false,data:"<JSON строкой>"}}})`. Берём запись с `manga`. */
export function parseSenkuro(html: string, slug: string | null): SiteTitle | null {
  const i = html.indexOf("window.__SENKURO__=");
  const j = i < 0 ? -1 : html.indexOf("</script>", i);
  if (j < 0) return null;
  for (const m of html.slice(i, j).matchAll(/data:"((?:[^"\\]|\\.)*)"/g)) {
    if (!m[1].includes('\\"manga\\"')) continue;
    let mg: Record<string, any> | undefined;
    try {
      mg = JSON.parse(JSON.parse(`"${m[1]}"`))?.manga;
    } catch {
      continue;
    }
    if (!mg || typeof mg !== "object" || (slug && mg.slug && String(mg.slug).toLowerCase() !== slug)) continue;
    const titles: { lang?: string; content?: string }[] = Array.isArray(mg.titles) ? mg.titles : [];
    const byLang = (l: string): string => text(titles.find((t) => t?.lang === l)?.content);
    const title = byLang("RU") || text(mg.originalName?.content) || byLang("EN");
    if (!title) continue;
    // главы по-русски — русская ветка перевода; нет русской ветки — по-русски глав нет (честно 0, а не общее число)
    const branches: { lang?: string; chapters?: unknown }[] | null = Array.isArray(mg.branches) && mg.branches.length ? mg.branches : null;
    const ch = branches ? Math.max(0, ...branches.filter((b) => b?.lang === "RU").map((b) => count(b.chapters))) : count(mg.chapters);
    const alts = [byLang("EN"), text(mg.originalName?.content), ...titles.map((t) => text(t?.content))].filter((t, k, a) => t && a.indexOf(t) === k && t !== title).slice(0, 8);
    return { title, orig: text(mg.originalName?.content) || byLang("EN") || null, alts, mal: typeof mg.malId === "number" && mg.malId > 0 ? mg.malId : null, ch, vol: 0, q: null };
  }
  return null;
}

// ---------- ReManga и ReNovels ----------

/** Значение строки `"key":"…"` после позиции `from` (в пределах `limit` знаков); JSON-экранирование снимаем. */
function strAfter(s: string, key: string, from: number, limit: number): string | null {
  const k = s.indexOf(`"${key}":"`, from);
  if (k < 0 || k > from + limit) return null;
  let e = k + key.length + 4;
  const start = e;
  while (e < s.length && s[e] !== '"') e += s[e] === "\\" ? 2 : 1;
  try {
    return JSON.parse(`"${s.slice(start, e)}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Данные тайтла в странице ReManga/ReNovels лежат объектом `{…"main_name":"…","dir":"…","count_chapters":N…}`. Страница может нести и чужие тайтлы (похожие),
 * поэтому берём тот объект, у которого `dir` совпал с адресом.
 */
export function parseReManga(html: string, dir: string | null): SiteTitle | null {
  const starts: number[] = [];
  for (let k = html.indexOf('"main_name":"'); k >= 0; k = html.indexOf('"main_name":"', k + 10)) starts.push(k);
  const want = dir ? dec(dir) : null;
  let fallback: SiteTitle | null = null;
  for (let n = 0; n < starts.length; n++) {
    const from = starts[n];
    const to = starts[n + 1] ?? from + 40_000;
    const c = html.indexOf('"count_chapters":', from);
    if (c < 0 || c > to) continue;
    const num = /^\d{1,5}/.exec(html.slice(c + 17, c + 23));
    const title = strAfter(html, "main_name", from, 0)?.trim();
    if (!num || !title) continue;
    const got = strAfter(html, "dir", from, to - from);
    const t: SiteTitle = { title, orig: strAfter(html, "secondary_name", from - 400, 400)?.trim() || null, alts: [], mal: null, ch: count(Number(num[0])), vol: 0, q: null };
    if (got === null || want === null) {
      fallback ??= t;
      continue;
    }
    if (got === want) return t;
  }
  // адрес не опознан (нет «dir» в объекте): берём единственный найденный, но не гадаем среди нескольких
  return starts.length === 1 ? fallback : null;
}

// ---------- RanobeHub ----------

/** Названия из страницы тайтла RanobeHub (нужны один раз, чтобы потом искать книгу по названию). */
export function parseRhPage(html: string): { ru: string; orig: string } | null {
  const ru = /<h1[^>]*class="book-title-cyrillic"[^>]*>([^<]+)<\/h1>/.exec(html)?.[1] ?? /<title>([^<]+?)\s+—\s+RanobeHub<\/title>/.exec(html)?.[1];
  const orig = /<p[^>]*class="book-original-title"[^>]*>([^<]+)<\/p>/.exec(html)?.[1];
  const r = ru ? decodeEntities(ru).trim() : "";
  const o = orig ? decodeEntities(orig).trim() : "";
  return r || o ? { ru: r, orig: o } : null;
}

// ---------- MangaLib и RanobeLib: только название ----------

/** Название из разметки для поисковиков (`CreativeWorkSeries`). Числа глав на странице нет. */
export function parseLdName(html: string): SiteTitle | null {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]) as Record<string, unknown>;
      if (j["@type"] !== "CreativeWorkSeries") continue;
      const title = text(j.name);
      if (!title) continue;
      const alts = (Array.isArray(j.alternateName) ? j.alternateName : []).map(text).filter(Boolean);
      return { title, orig: alts[0] ?? null, alts: alts.slice(0, 8), mal: null, ch: 0, vol: 0, q: null };
    } catch {
      // не тот блок
    }
  }
  return null;
}

// ---------- чтение сайта ----------

/** Что известно о ранее найденной книге: чем искать (RanobeHub) и как называется. */
export interface SiteHint {
  q?: string | null;
  ru?: string | null;
}

/**
 * Прочитать тайтл на сайте по ссылке. Для сайтов со счётчиком вернёт число русских глав (у RanobeHub ещё и томов).
 * Для MangaLib и RanobeLib вернёт только название (`ch` = 0); для Com-X и закрытых разделов — null без обращения к сети.
 */
export async function readSite(site: SiteDef, url: string, key: string | null, f: FetchFn, hint: SiteHint = {}): Promise<SiteTitle | null> {
  if (!key) return null;
  try {
    if (new URL(url).hostname.replace(/^www\./, "") !== site.hosts[0]) return null;
  } catch {
    return null;
  }
  switch (site.id) {
    case "senkuro": {
      const html = await readPage(f, url, (s) => {
        const i = s.indexOf("window.__SENKURO__=");
        return i >= 0 && s.indexOf("</script>", i) > 0;
      });
      return html ? parseSenkuro(html, key) : null;
    }
    case "remanga":
    case "renovels": {
      const html = await readPage(f, `${url}/main`, (s) => {
        const i = s.indexOf('"main_name":"');
        const c = i < 0 ? -1 : s.indexOf('"count_chapters":', i);
        return c >= 0 && /^\d+[,}]/.test(s.slice(c + 17, c + 30));
      });
      return html ? parseReManga(html, key) : null;
    }
    case "ranobehub": {
      let q = hint.q?.trim() || null;
      let ru = hint.ru?.trim() || "";
      if (!q) {
        // название и оригинал стоят рядом в начале страницы; страница на 600 КБ целиком не нужна
        const html = await readPage(f, url, (s) => {
          const i = s.indexOf('class="book-title-cyrillic"');
          return i >= 0 && s.length - i > 600;
        }, 450_000);
        const names = html ? parseRhPage(html) : null;
        if (!names) return null;
        q = names.orig || names.ru;
        ru = names.ru || ru;
      }
      const b = await rhRefresh(Number(key), q, ru, f);
      return b ? { title: b.ru || ru || q, orig: b.orig || q, alts: [], mal: null, ch: b.ch, vol: b.vol, q } : null;
    }
    case "mangalib":
    case "ranobelib": {
      const html = await readPage(f, url, (s) => {
        const i = s.indexOf('"CreativeWorkSeries"');
        return i >= 0 && s.indexOf("</script>", i) > 0;
      }, 120_000);
      return html ? parseLdName(html) : null;
    }
    default:
      return null;
  }
}

/** Все сайты: для проверки, что бот ходит только по разрешённым путям (тест). */
export const SITE_LIST = Object.values(SITES);
