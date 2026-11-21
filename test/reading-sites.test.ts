// Чтение по ссылкам на сайты (Senkuro, ReManga, ReNovels, RanobeHub; MangaLib, RanobeLib, Com-X — ручной режим): разбор ссылок и страниц на кусках настоящих ответов,
// фразы «бот читаю <ссылка>» и «Кауру тут: <ссылка>», ночная проверка по сайту, субботнее сообщение, паспорт источников, правила robots.txt и лимиты.
// Сеть везде фальшивая: ни одного настоящего запроса.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { setMeta } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Reading, availOf, siteLed } from "../src/reading/core.ts";
import { parseReadLink } from "../src/reading/linkSay.ts";
import { SITES, siteByHost } from "../src/reading/siteIds.ts";
import { syntheticMal } from "../src/reading/siteStore.ts";
import { SITE_UA, parseLdName, parseReManga, parseRhPage, parseSenkuro, parseSiteLink, readPage, readSite } from "../src/reading/sites.ts";
import { parsePassport, statusText } from "../src/sources.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { COMX_CHECK, MANGALIB_PAGE, RANOBELIB_PAGE, REMANGA_DIR, SENKURO_SLUG, ldPage, remangaObject, remangaPage, rhBook, rhPage, rhSearchJson, senkuroManga, senkuroPage } from "./readingSitesFixtures.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const MON = kyiv(2026, 11, 16, 12, 0);
const day = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);
const sat = (h: number, mi = 0) => kyiv(2026, 11, 21, h, mi);
const NIGHT = day(17, 3, 40);

// ---------- фальшивая сеть ----------

const shikiManga = (id: number, ru: string, name: string, o: Record<string, unknown> = {}) => ({ id, russian: ru, name, kind: "manga", status: "ongoing", volumes: 0, chapters: 0, aired_on: "2022-06-22", ...o });
const shikiNovel = (id: number, ru: string, name: string, o: Record<string, unknown> = {}) => ({ id, russian: ru, name, kind: "light_novel", status: "ongoing", volumes: 0, chapters: 0, aired_on: "2010-01-01", ...o });

/** Тело ответа кусками (как приходит страница): считаем, сколько кусков прочитали. */
function chunked(text: string, size = 8000): { body: ReadableStream<Uint8Array>; pulled: () => number; total: number } {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  let n = 0;
  const total = Math.ceil(bytes.length / size);
  return {
    body: new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pos >= bytes.length) return ctrl.close();
        n++;
        ctrl.enqueue(bytes.slice(pos, pos + size));
        pos += size;
      },
    }),
    pulled: () => n,
    total,
  };
}

class Web {
  routes = new Map<string, () => Response>();
  calls: { url: string; ua: string }[] = [];
  shikiManga: unknown[] | null = [];
  shikiRanobe: unknown[] | null = [];
  shikiById: Record<number, unknown> = {};
  /** RanobeHub: ответ поиска по запросу (массив книг) */
  rh: Record<string, unknown[]> = {};

  /** Ответ на точный адрес: страница (текст) или готовый ответ. */
  on(url: string, v: string | (() => Response), status = 200): this {
    this.routes.set(url, typeof v === "string" ? () => new Response(v, { status, headers: { "content-type": "text/html" } }) : v);
    return this;
  }
  count = (needle: string): number => this.calls.filter((c) => c.url.includes(needle)).length;
  urls = (needle: string): string[] => this.calls.filter((c) => c.url.includes(needle)).map((c) => c.url);

  fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as { url?: string }).url);
    const h = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({ url, ua: h["User-Agent"] ?? "" });
    const json = (v: unknown): Response => (v === null || v === undefined ? new Response("down", { status: 503 }) : Response.json(v));
    if (url.includes("shikimori.io/api/mangas?")) return json(this.shikiManga);
    if (url.includes("shikimori.io/api/ranobe?")) return json(this.shikiRanobe);
    if (/shikimori\.io\/api\/mangas\/\d+\/related/.test(url)) return json([]);
    const sm = /shikimori\.io\/api\/mangas\/(\d+)/.exec(url);
    if (sm) return this.shikiById[Number(sm[1])] ? json(this.shikiById[Number(sm[1])]) : new Response("none", { status: 404 });
    if (url.includes("ranobehub.org/api/search")) return json(rhSearchJson((this.rh[new URL(url).searchParams.get("q") ?? ""] ?? []) as Record<string, unknown>[]));
    const r = this.routes.get(url);
    return r ? r() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let w: World;
let web: Web;

async function run(now: number, limit = 50) {
  const repo = w.repo(limit);
  const api = countedApi(w.discord, repo.counter);
  return runCron({ repo, api, now, env: {}, fetchFn: web.fetch, ping: async () => {}, log: () => {} });
}

async function say(text: string, at: number): Promise<string> {
  const before = w.discord.posted.length;
  w.discord.say(CH_BOT, OWNER, text);
  await run(at);
  return w.discord.posted.slice(before).filter((p) => p.channel === CH_BOT).map((p) => p.body.content ?? "").join("\n");
}

const rows = () => w.d1.q<Reading>("SELECT * FROM reading ORDER BY id");
const meta = (k: string) => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const passport = () => parsePassport(meta("src_passport"));
const posted = (needle: string) => w.discord.posted.filter((p) => p.channel === CH_REMIND && p.body.content?.includes(needle));

function put(o: Partial<Reading> & { mal_id: number; title_ru: string }): void {
  const r = { kind: "manga", title_orig: null, status: "reading", unit: "ch", read_ch: null, read_vol: null, liked: 0, src_status: "ongoing", src_ch: 0, src_vol: 0, told_ch: 0, told_vol: 0, end_told: 0, chk_fail: 0, added_at: MON, updated_at: MON, ...o } as Record<string, unknown>;
  const keys = Object.keys(r);
  w.d1.sqlite.prepare(`INSERT INTO reading (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((k) => r[k]) as never[]));
}

beforeEach(async () => {
  w = new World();
  web = new Web();
  await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off" } });
  await run(MON);
});

const SENKURO_URL = `https://senkuro.com/manga/${SENKURO_SLUG}`;
const REMANGA_URL = `https://remanga.org/manga/${REMANGA_DIR}`;

// ---------- 1. ссылки: примеры Ihor ----------

describe("ссылки: страница тайтла по примерам Ihor", () => {
  it("RanobeLib: страница книги → ручной режим, ссылка без языка и параметров", () => {
    const p = parseSiteLink("https://ranobelib.me/ru/book/278175--heonteomurinjul-aratneunde-setakmurieotda-wn");
    expect(p?.site.id).toBe("ranobelib");
    expect(p?.link).toMatchObject({ key: "278175--heonteomurinjul-aratneunde-setakmurieotda-wn", kind: "ranobe", url: "https://ranobelib.me/ru/book/278175--heonteomurinjul-aratneunde-setakmurieotda-wn" });
    expect(p?.site.counts).toBe(false);
  });

  it("ReManga: ссылка на главу с параметрами («progress» хозяина) → страница тайтла без параметров", () => {
    const p = parseSiteLink("https://remanga.org/manga/%3C17.06.2026%3Ei-want-to-end-the-game-that-i-love/2821317?page=1&progress=0.72");
    expect(p?.link).toMatchObject({ key: REMANGA_DIR, url: REMANGA_URL, kind: "manga" });
    expect(p?.link?.url).not.toContain("?");
    expect(p?.link?.url).not.toContain("2821317");
  });

  it("Senkuro: ссылка на вкладку «Главы» → страница тайтла", () => {
    expect(parseSiteLink("https://senkuro.com/manga/bil-eomeogeul-hwansaeng/chapters")?.link).toMatchObject({ key: SENKURO_SLUG, url: SENKURO_URL, kind: "manga" });
  });

  it("главные страницы и списки — это не тайтл: сайт опознан, ссылки на тайтл нет (MangaLib, RanobeHub, ReNovels, Com-X «просмотренное»)", () => {
    for (const u of ["https://ranobehub.org/", "https://renovels.org/", "https://mangalib.me/ru?section=home-updates", "https://com-x.life/watched/", "https://renovels.org/manga/hot-updates"]) {
      const p = parseSiteLink(u);
      expect(p, u).not.toBeNull();
      expect(p?.link, u).toBeNull();
    }
  });

  it("RanobeHub, ReNovels (новелла и манга), MangaLib, Com-X: ключ, вид и адрес; чужой домен — null", () => {
    expect(parseSiteLink("https://ranobehub.org/ranobe/206-overlord/chapter/438922")?.link).toMatchObject({ key: "206", url: "https://ranobehub.org/ranobe/206", kind: "ranobe" });
    expect(parseSiteLink("https://renovels.org/novel/sinful-marriage/main")?.link).toMatchObject({ key: "sinful-marriage", url: "https://renovels.org/novel/sinful-marriage", kind: "ranobe" });
    expect(parseSiteLink("https://renovels.org/manga/some-manga")?.link).toMatchObject({ kind: "manga", url: "https://renovels.org/manga/some-manga" });
    expect(parseSiteLink("https://mangalib.me/ru/279740--nulevye-pacienty/read/v1/c3")?.link).toMatchObject({ key: "279740--nulevye-pacienty", url: "https://mangalib.me/ru/manga/279740--nulevye-pacienty", kind: "manga" });
    expect(parseSiteLink("https://com-x.life/12345-chelovek-pauk.html")?.link).toMatchObject({ key: "12345-chelovek-pauk", kind: "manga" });
    expect(parseSiteLink("https://www.senkuro.com/manga/one-piece")?.link?.key).toBe("one-piece");
    expect(parseSiteLink("https://example.com/manga/x")).toBeNull();
    expect(parseSiteLink("ftp://senkuro.com/manga/x")).toBeNull();
    expect(parseSiteLink("не ссылка")).toBeNull();
  });

  it("ReManga /novel закрыт её robots.txt: ссылку знаем, ключа нет — читать не будем", () => {
    const p = parseSiteLink("https://remanga.org/novel/some-novel");
    expect(p?.link).toMatchObject({ key: null, kind: "ranobe" });
  });

  it("у каждого сайта: четыре со счётчиком, три — ручной режим с причиной", () => {
    expect(Object.values(SITES).filter((s) => s.counts).map((s) => s.id).sort()).toEqual(["ranobehub", "remanga", "renovels", "senkuro"]);
    for (const s of Object.values(SITES).filter((x) => !x.counts)) expect(s.why, s.id).toBeTruthy();
    expect(siteByHost("WWW.MangaLib.me")?.id).toBe("mangalib");
  });
});

// ---------- 2. разбор страниц на кусках настоящих ответов ----------

describe("разбор страниц сайтов", () => {
  it("Senkuro: название по-русски, номер MyAnimeList, главы русской ветки", () => {
    const t = parseSenkuro(senkuroPage(), SENKURO_SLUG);
    expect(t).toMatchObject({ title: "Чёртова реинкарнация", orig: "Bil-eomeogeul hwansaeng", mal: 149438, ch: 82, vol: 0 });
    expect(t?.alts).toContain("My Blasted Reincarnated Life");
  });

  it("Senkuro: русской ветки нет — по-русски 0 (а не общее число); чужой тайтл на странице и заглушка — null", () => {
    expect(parseSenkuro(senkuroPage(senkuroManga({ chapters: 120, branches: [{ lang: "EN", chapters: 120 }] })), SENKURO_SLUG)?.ch).toBe(0);
    expect(parseSenkuro(senkuroPage(senkuroManga({ branches: [{ lang: "RU", chapters: 5 }, { lang: "RU", chapters: 82 }] })), SENKURO_SLUG)?.ch).toBe(82);
    expect(parseSenkuro(senkuroPage(), "other-slug")).toBeNull();
    expect(parseSenkuro("<html><title>Just a moment...</title></html>", SENKURO_SLUG)).toBeNull();
    expect(parseSenkuro("<script>window.__SENKURO__=({state:{},graphql:{}})</script>", SENKURO_SLUG)).toBeNull();
  });

  it("ReManga: число глав, название и оригинал; адрес из «dir» сверяется со ссылкой", () => {
    expect(parseReManga(remangaPage(), REMANGA_DIR)).toMatchObject({ title: "Я хочу закончить эту игру любви", orig: "I want to end the game that I love", ch: 48, vol: 0 });
  });

  it("ReManga: среди нескольких тайтлов на странице берём тот, чей «dir» совпал; нет совпадения — не гадаем", () => {
    const other = remangaObject({ id: 7, main: "Другой тайтл", secondary: "Other", dir: "other-title", count: 999 });
    expect(parseReManga(remangaPage([other, remangaObject()]), REMANGA_DIR)?.ch).toBe(48);
    expect(parseReManga(remangaPage([other]), REMANGA_DIR)).toBeNull();
    expect(parseReManga("<html>Checking your browser before accessing</html>", REMANGA_DIR)).toBeNull();
  });

  it("RanobeHub: названия со страницы тайтла (русское и оригинал)", () => {
    expect(parseRhPage(rhPage())).toEqual({ ru: "Повелитель", orig: "Overlord" });
    expect(parseRhPage(rhPage("Меч &amp; тень", "Ken &amp; Kage"))).toEqual({ ru: "Меч & тень", orig: "Ken & Kage" });
    expect(parseRhPage("<html></html>")).toBeNull();
  });

  it("MangaLib и RanobeLib: из разметки для поисковиков — только название; числа глав на странице нет", () => {
    expect(parseLdName(MANGALIB_PAGE)).toMatchObject({ title: "Нулевые пациенты", orig: "Zero patients", ch: 0, vol: 0, mal: null });
    expect(parseLdName(RANOBELIB_PAGE)?.title).toBe("Я думал, это история про охотников, а оказалось — про прачечную");
    expect(parseLdName("<html></html>")).toBeNull();
  });
});

// ---------- 3. чтение страницы: честный заголовок, robots.txt, остановка, сбои ----------

describe("чтение страницы: правила сайтов", () => {
  it("представляется честно («MeidoBot (personal, 0.1)») и читает ровно одну страницу за тайтл", async () => {
    web.on(SENKURO_URL, senkuroPage());
    const t = await readSite(SITES.senkuro, SENKURO_URL, SENKURO_SLUG, web.fetch);
    expect(t?.ch).toBe(82);
    expect(web.calls).toHaveLength(1);
    expect(web.calls[0].ua).toBe(SITE_UA);
    expect(SITE_UA).toBe("MeidoBot (personal, 0.1)");
  });

  it("robots.txt: ни по одному сайту бот не ходит в закрытые пути (/api, /graphql, /title, /chapters/, параметры)", async () => {
    web.on(SENKURO_URL, senkuroPage()).on(`${REMANGA_URL}/main`, remangaPage()).on("https://renovels.org/novel/sinful-marriage/main", remangaPage([remangaObject({ dir: "sinful-marriage", main: "Грешный брак", count: 30 })]));
    web.on("https://ranobehub.org/ranobe/206", rhPage()).on("https://mangalib.me/ru/manga/279740--nulevye-pacienty", MANGALIB_PAGE).on("https://ranobelib.me/ru/book/1--x", RANOBELIB_PAGE);
    web.rh.Overlord = [rhBook()];
    await readSite(SITES.senkuro, SENKURO_URL, SENKURO_SLUG, web.fetch);
    await readSite(SITES.remanga, REMANGA_URL, REMANGA_DIR, web.fetch);
    await readSite(SITES.renovels, "https://renovels.org/novel/sinful-marriage", "sinful-marriage", web.fetch);
    await readSite(SITES.ranobehub, "https://ranobehub.org/ranobe/206", "206", web.fetch);
    await readSite(SITES.mangalib, "https://mangalib.me/ru/manga/279740--nulevye-pacienty", "279740--nulevye-pacienty", web.fetch);
    await readSite(SITES.ranobelib, "https://ranobelib.me/ru/book/1--x", "1--x", web.fetch);
    expect(web.calls.length).toBeGreaterThanOrEqual(7);
    for (const { url } of web.calls) {
      const u = new URL(url);
      expect(u.search === "" || (u.hostname === "ranobehub.org" && u.pathname === "/api/search"), url).toBe(true); // параметров нет, кроме поиска RanobeHub (robots.txt его разрешает)
      // ReManga, ReNovels, Senkuro закрывают /api, /title, /graphql целиком; RanobeHub разрешает /api/search и закрывает только /api/user/ и /api/admin/
      if (u.hostname === "ranobehub.org") expect(u.pathname, url).not.toMatch(/^\/(?:api\/(?:user|admin)\/|control-panel|settings|auth|login)/);
      else expect(u.pathname, url).not.toMatch(/^\/(?:api|graphql|title|settings|dashboard)(?:\/|$)/);
      expect(u.pathname, url).not.toMatch(/\/chapters\/|\/read\/|\/chapter$/);
    }
    expect(web.urls("remanga.org").every((u) => u.endsWith("/main"))).toBe(true);
  });

  it("Com-X (проверка «вы человек» на JavaScript) и закрытый раздел ReManga: ни одного запроса, ничего не обходим", async () => {
    web.on("https://com-x.life/12345-chelovek-pauk.html", COMX_CHECK, 404);
    expect(await readSite(SITES.comx, "https://com-x.life/12345-chelovek-pauk.html", "12345-chelovek-pauk", web.fetch)).toBeNull();
    expect(await readSite(SITES.remanga, "https://remanga.org/novel/some-novel", null, web.fetch)).toBeNull();
    expect(web.calls).toHaveLength(0);
  });

  it("страница-заглушка, 403, 503, таймаут, чужой домен в сохранённом адресе — null, а не выдуманные главы", async () => {
    web.on(SENKURO_URL, "<html><title>Just a moment...</title><body>Checking your browser</body></html>");
    expect(await readSite(SITES.senkuro, SENKURO_URL, SENKURO_SLUG, web.fetch)).toBeNull();
    web.on(SENKURO_URL, senkuroPage(), 403);
    expect(await readSite(SITES.senkuro, SENKURO_URL, SENKURO_SLUG, web.fetch)).toBeNull();
    web.on(SENKURO_URL, "x", 503);
    expect(await readSite(SITES.senkuro, SENKURO_URL, SENKURO_SLUG, web.fetch)).toBeNull();
    const boom = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect(await readSite(SITES.senkuro, SENKURO_URL, SENKURO_SLUG, boom)).toBeNull();
    const n = web.calls.length;
    expect(await readSite(SITES.senkuro, "https://evil.example/manga/x", SENKURO_SLUG, web.fetch)).toBeNull();
    expect(web.calls.length).toBe(n);
  });

  it("длинную страницу целиком не читаем: данные в начале — останавливаемся на первых кусках (процессорное время Worker мало)", async () => {
    const page = remangaPage([remangaObject()], 40_000); // около 800 КБ хвоста
    const c = chunked(page, 8000);
    const f = (async () => new Response(c.body, { status: 200 })) as unknown as typeof fetch;
    const t = await readSite(SITES.remanga, REMANGA_URL, REMANGA_DIR, f);
    expect(t?.ch).toBe(48);
    expect(c.total).toBeGreaterThan(80);
    expect(c.pulled()).toBeLessThan(6);
  });

  it("readPage: нужного в странице нет до самого конца — null", async () => {
    const c = chunked("x".repeat(30_000), 8000);
    const f = (async () => new Response(c.body)) as unknown as typeof fetch;
    expect(await readPage(f, "https://x.test/", (s) => s.includes("нужное"))).toBeNull();
  });

  it("RanobeHub: книгу находим по номеру среди результатов поиска по названию; страницу читаем один раз, потом хватает сохранённого запроса", async () => {
    web.on("https://ranobehub.org/ranobe/206", rhPage());
    web.rh.Overlord = [rhBook({ id: 1265, title: "Володар [Украинский]", volumes: 2, chapters: 12 }), rhBook()];
    const first = await readSite(SITES.ranobehub, "https://ranobehub.org/ranobe/206", "206", web.fetch);
    expect(first).toMatchObject({ title: "Повелитель", orig: "Overlord", vol: 19, ch: 177, q: "Overlord" });
    expect(web.count("/ranobe/206")).toBe(1);
    const again = await readSite(SITES.ranobehub, "https://ranobehub.org/ranobe/206", "206", web.fetch, { q: first?.q, ru: first?.title });
    expect(again?.vol).toBe(19);
    expect(web.count("/ranobe/206")).toBe(1); // страницу второй раз не спрашивали
    expect(web.count("/api/search")).toBe(2);
  });
});

// ---------- 4. фразы ----------

describe("фразы со ссылкой", () => {
  const SEN = "https://senkuro.com/manga/bil-eomeogeul-hwansaeng";

  it("«бот читаю <ссылка>», «читаю <ссылка>», «бот читаю мангу <ссылка>» — завести по ссылке", () => {
    expect(parseReadLink(`бот читаю ${SEN}`)).toMatchObject({ action: "start", url: SEN, name: null, prefixed: true });
    expect(parseReadLink(`читаю ${SEN}`)).toMatchObject({ action: "start", name: null });
    expect(parseReadLink(`бот читаю мангу ${SEN}`)).toMatchObject({ action: "start", kind: "manga", name: null });
    expect(parseReadLink(`Хару, читаю ранобэ https://ranobehub.org/ranobe/206-overlord.`)).toMatchObject({ kind: "ranobe", url: "https://ranobehub.org/ranobe/206-overlord" });
    expect(parseReadLink(`хочу почитать ${SEN}`)).toMatchObject({ action: "plan", name: null });
  });

  it("«Название тут: <ссылка>» и родственные — привязать к названию", () => {
    expect(parseReadLink(`Чёртова реинкарнация тут: ${SEN}`)).toMatchObject({ action: "attach", name: "Чёртова реинкарнация", prefixed: false });
    expect(parseReadLink(`бот Атака на титанов здесь ${SEN}`)).toMatchObject({ action: "attach", name: "Атака на титанов", prefixed: true });
    expect(parseReadLink(`ссылка на Кауру: ${SEN}`)).toMatchObject({ action: "attach", name: "Кауру" });
    expect(parseReadLink(`читаю Кауру тут ${SEN}`)).toMatchObject({ action: "start", name: "Кауру" });
    expect(parseReadLink(`бот Кауру на сайте ${SEN}`)).toMatchObject({ action: "attach", name: "Кауру" });
  });

  it("не наша фраза: чужой сайт, голая ссылка, дело со ссылкой — остаётся обычным делом", () => {
    expect(parseReadLink("бот читаю https://example.com/manga/x")).toBeNull();
    expect(parseReadLink(SEN)).toBeNull();
    expect(parseReadLink(`перечитать позже ${SEN}`)).toBeNull();
    expect(parseReadLink("бот читаю мангу Кауру")).toBeNull();
    expect(parseReadLink(`а ${"очень ".repeat(30)}длинная фраза про что-то ${SEN}`)).toBeNull();
  });
});

// ---------- 5. запись по ссылке ----------

describe("«бот читаю <ссылка>»: Senkuro", () => {
  beforeEach(() => {
    web.on(SENKURO_URL, senkuroPage());
    web.shikiById[149438] = shikiManga(149438, "Чёртова реинкарнация", "Bil-eomeogeul hwansaeng", { kind: "manhwa" });
  });

  it("завели по ссылке: номер MyAnimeList — со страницы, русский счётчик — с сайта, про уже вышедшее не пишем", async () => {
    const t = await say(`бот читаю ${SENKURO_URL}/chapters`, MON + MINUTE);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ mal_id: 149438, kind: "manga", title_ru: "Чёртова реинкарнация", status: "reading", unit: "ch", site: "senkuro", site_key: SENKURO_SLUG, site_url: SENKURO_URL, ru_ch: 82, ru_vol: 0, src_ch: 82, told_ch: 82, told_vol: 0, md_id: null, mu_id: null, site_at: MON + MINUTE });
    expect(t).toContain("Записала");
    expect(t).toContain("Чёртова реинкарнация");
    expect(t).toContain("Слежу на Senkuro: по-русски там сейчас 82 главы");
    expect(t).toContain("прочитал главу 120");
    expect(web.count("mangadex")).toBe(0);
    expect(web.count("mangaupdates")).toBe(0);
    expect(w.d1.q("SELECT * FROM items")).toHaveLength(0);
    expect(meta("reading_on")).toBe("1");
  });

  it("лимит запуска: заведение по ссылке — не больше 8 подзапросов (страница, Shikimori, база)", async () => {
    w.discord.say(CH_BOT, OWNER, `бот читаю ${SENKURO_URL}`);
    const rep = await run(MON + MINUTE);
    expect(rep.subrequests).toBeLessThanOrEqual(20);
    expect(web.calls.length).toBeLessThanOrEqual(3);
  });

  it("повторная фраза: второй записи нет, статус и счётчик обновились", async () => {
    await say(`бот читаю ${SENKURO_URL}`, MON + MINUTE);
    await say(`бот читаю ${SENKURO_URL}`, MON + 2 * MINUTE);
    expect(rows()).toHaveLength(1);
  });

  it("«хочу почитать <ссылка>»: в планах, ссылка запомнена", async () => {
    await say(`бот хочу почитать ${SENKURO_URL}`, MON + MINUTE);
    expect(rows()[0]).toMatchObject({ status: "planned", site: "senkuro" });
  });

  it("сайт не открылся при заведении: тайтл записан по названию из фразы, число глав посчитаем ночью (первая цифра станет отправной точкой)", async () => {
    web.on(SENKURO_URL, "x", 503);
    const t = await say(`бот Чёртова реинкарнация тут: ${SENKURO_URL}`, MON + MINUTE);
    expect(rows()[0]).toMatchObject({ site: "senkuro", ru_ch: null, told_ch: 0 });
    expect(t).toContain("Senkuro сейчас не открылся");
    web.on(SENKURO_URL, senkuroPage());
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ ru_ch: 82, told_ch: 82, src_at: null });
  });

  it("без названия и страница не открылась — просим названием, ничего не записываем", async () => {
    web.on(SENKURO_URL, "x", 503);
    const t = await say(`бот читаю ${SENKURO_URL}`, MON + MINUTE);
    expect(rows()).toHaveLength(0);
    expect(t).toContain("Напишите название вместе со ссылкой");
  });

  it("по-русски на сайте глав нет: записали, честно сказали, что писать будем, когда появятся; в субботу молчим", async () => {
    web.on(SENKURO_URL, senkuroPage(senkuroManga({ chapters: 40, branches: [{ lang: "EN", chapters: 40 }] })));
    const t = await say(`бот читаю ${SENKURO_URL}`, MON + MINUTE);
    expect(rows()[0]).toMatchObject({ ru_ch: 0, ru_vol: 0 });
    expect(t).toContain("по-русски пока нет ни одной главы");
    await run(sat(11, 5));
    expect(posted("Чтение")).toHaveLength(0);
  });

  it("это не страница тайтла: подсказка, ничего не записано и в сеть не ходили", async () => {
    const t = await say("бот читаю https://mangalib.me/ru?section=home-updates", MON + MINUTE);
    expect(t).toContain("Это не страница тайтла на MangaLib");
    expect(rows()).toHaveLength(0);
    expect(web.calls).toHaveLength(0);
  });
});

describe("«Название тут: <ссылка>»: тайтл уже в списке", () => {
  beforeEach(() => {
    put({ mal_id: 9001, title_ru: "Цветок и меч", title_orig: "Hana to Ken", md_id: "md-1", src_ch: 199, src_vol: 24, ru_ch: 149, ru_vol: 19, told_ch: 149, told_vol: 19, read_ch: 140, map_at: MON, shiki_at: MON, adapt_at: MON });
    w.d1.sqlite.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('reading_on', '1')").run();
    web.on("https://senkuro.com/manga/hana-to-ken", senkuroPage(senkuroManga({ slug: "hana-to-ken", malId: 9001, titles: [{ lang: "RU", content: "Цветок и меч" }], chapters: 150, branches: [{ lang: "RU", chapters: 150 }] })));
  });

  it("ссылка привязана, счётчик переходит на сайт: первая цифра — отправная точка (ru_ch 150, не «вышла»), MangaDex для тайтла больше не спрашиваем", async () => {
    const t = await say("цветок и меч тут: https://senkuro.com/manga/hana-to-ken", MON + MINUTE);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ mal_id: 9001, site: "senkuro", site_key: "hana-to-ken", ru_ch: 150, told_ch: 150, src_ch: 199, read_ch: 140, status: "reading" });
    expect(t).toContain("Слежу на Senkuro");
    expect(t).toContain("Накопилось: 10 глав");
    const before = web.count("senkuro.com");
    await run(NIGHT);
    expect(web.count("mangadex")).toBe(0);
    expect(web.count("senkuro.com") - before).toBe(1); // ночью — один запрос к сайту на тайтл
    expect(rows()[0].checked_at).toBe(NIGHT);
  });

  it("без обращения и про незнакомое название — это не чтение, обычное дело", async () => {
    const before = rows().length;
    const t = await say("Что-то неведомое тут: https://mangalib.me/ru/manga/1--neizvestno", MON + MINUTE);
    expect(rows()).toHaveLength(before);
    expect(t).not.toContain("Записала");
    expect(web.count("mangalib")).toBe(0);
  });

  it("ссылка на ручной сайт: названия и счётчики не трогаем, ссылка подставится в «читать»", async () => {
    const t = await say("бот цветок и меч тут: https://mangalib.me/ru/manga/55--hana-to-ken", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ site: "mangalib", site_key: "55--hana-to-ken", ru_ch: 149, told_ch: 149, md_id: "md-1" });
    expect(t).toContain("MangaLib: сайт закрывает список глав от программ");
    expect(web.count("mangalib")).toBe(0);
    const news = await say("что вышло по чтению", MON + 2 * MINUTE);
    expect(news).toContain("[читать](<https://mangalib.me/ru/manga/55--hana-to-ken>)");
    expect(news).toContain("по-русски до главы 149 на MangaDex"); // счётчик у тайтла по-прежнему прежний
  });
});

describe("ReManga и ReNovels", () => {
  it("ReManga: ссылка на главу с параметрами → страница /main; название сверено с Shikimori по оригиналу; 48 глав", async () => {
    web.on(`${REMANGA_URL}/main`, remangaPage());
    web.shikiManga = [shikiManga(1111, "Я хочу закончить эту игру любви", "I want to end the game that I love")];
    const t = await say(`бот читаю https://remanga.org/manga/${REMANGA_DIR}/2821317?page=1&progress=0.72`, MON + MINUTE);
    expect(rows()[0]).toMatchObject({ mal_id: 1111, site: "remanga", site_key: REMANGA_DIR, site_url: REMANGA_URL, ru_ch: 48, told_ch: 48, title_ru: "Я хочу закончить эту игру любви" });
    expect(t).toContain("Слежу на ReManga: по-русски там сейчас 48 глав");
    expect(web.urls("remanga.org")).toEqual([`${REMANGA_URL}/main`]);
  });

  it("тайтла нет на Shikimori: номер выдуманный (отрицательный), по нему ни Shikimori, ни MangaDex ночью не спрашиваем", async () => {
    web.on(`${REMANGA_URL}/main`, remangaPage());
    await say(`бот читаю ${REMANGA_URL}`, MON + MINUTE);
    const r = rows()[0];
    expect(r.mal_id).toBe(syntheticMal("remanga", REMANGA_DIR));
    expect(r.mal_id).toBeLessThan(0);
    const n = web.calls.length;
    await run(NIGHT);
    expect(web.calls.slice(n).map((c) => new URL(c.url).hostname)).toEqual(["remanga.org"]);
    expect(rows()[0]).toMatchObject({ ru_ch: 48, chk_fail: 0 });
  });

  it("ReNovels: новелла — это ранобэ; у сайта только главы, поэтому считаем главами", async () => {
    web.on("https://renovels.org/novel/sinful-marriage/main", remangaPage([remangaObject({ dir: "sinful-marriage", main: "Грешный брак", secondary: "Sinful marriage", count: 30 })]));
    const t = await say("бот читаю https://renovels.org/novel/sinful-marriage/main", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ kind: "ranobe", unit: "ch", site: "renovels", ru_ch: 30, ru_vol: 0, title_ru: "Грешный брак" });
    expect(t).toContain("Слежу на ReNovels: по-русски там сейчас 30 глав");
    expect(availOf(rows()[0])).toBe(30);
  });

  it("ночью выросло: «вышла глава N на ReManga» в субботу, со ссылкой на страницу тайтла; MangaDex не спрашиваем", async () => {
    web.on(`${REMANGA_URL}/main`, remangaPage());
    await say(`бот читаю ${REMANGA_URL}`, MON + MINUTE);
    await say("прочитал главу 40 я хочу закончить", MON + 2 * MINUTE);
    web.on(`${REMANGA_URL}/main`, remangaPage([remangaObject({ count: 49 })]));
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ ru_ch: 49, told_ch: 48, src_at: NIGHT });
    await run(sat(11, 5));
    const t = posted("Чтение")[0]?.body.content ?? "";
    expect(t).toContain("**Я хочу закончить эту игру любви** (манга) — вышла глава 49 на ReManga");
    expect(t).toContain("вы на 40, накопилось 9");
    expect(t).toContain(`[читать](<${REMANGA_URL}>)`);
    expect(web.count("mangadex")).toBe(0);
  });
});

describe("RanobeHub по ссылке", () => {
  beforeEach(() => {
    web.on("https://ranobehub.org/ranobe/206", rhPage());
    web.rh.Overlord = [rhBook()];
    web.shikiRanobe = [shikiNovel(4000, "Повелитель", "Overlord")];
  });

  it("завели: названия со страницы, тома и главы — из поиска; единица — тома", async () => {
    const t = await say("бот читаю ранобэ https://ranobehub.org/ranobe/206-overlord", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ mal_id: 4000, kind: "ranobe", unit: "vol", site: "ranobehub", site_key: "206", site_q: "Overlord", ru_vol: 19, ru_ch: 177, told_vol: 19, told_ch: 177, mu_id: null, rh_id: null });
    expect(t).toContain("Слежу на RanobeHub: по-русски там сейчас 19 томов, 177 глав");
    expect(web.count("ranobehub.org/ranobe/206")).toBe(1);
  });

  it("ночью выросло: страницу не читаем, хватает поиска; в субботу «вышел том 20 на RanobeHub»; MangaUpdates не спрашиваем", async () => {
    await say("бот читаю ранобэ https://ranobehub.org/ranobe/206-overlord", MON + MINUTE);
    web.rh.Overlord = [rhBook({ volumes: 20, chapters: 183 })];
    await run(NIGHT);
    expect(web.count("ranobehub.org/ranobe/206")).toBe(1);
    expect(rows()[0]).toMatchObject({ ru_vol: 20, ru_ch: 183, told_vol: 19, src_at: NIGHT });
    expect(passport().rd_ranobehub?.ok).toBe(NIGHT);
    await run(sat(11, 5));
    const t = posted("Чтение")[0]?.body.content ?? "";
    expect(t).toContain("(ранобэ) — вышел том 20 на RanobeHub");
    expect(web.count("mangaupdates")).toBe(0);
  });
});

describe("ручной режим: MangaLib, RanobeLib, Com-X", () => {
  it("MangaLib: название — из страницы; ссылка хранится, главы бот не видит и честно говорит об этом; ночью на сайт не ходит", async () => {
    web.on("https://mangalib.me/ru/manga/279740--nulevye-pacienty", MANGALIB_PAGE);
    const t = await say("бот читаю https://mangalib.me/ru/manga/279740--nulevye-pacienty", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ kind: "manga", title_ru: "Нулевые пациенты", site: "mangalib", site_key: "279740--nulevye-pacienty", ru_ch: null, site_at: null });
    expect(rows()[0].mal_id).toBeLessThan(0);
    expect(siteLed(rows()[0])).toBe(false);
    expect(t).toContain("MangaLib: сайт закрывает список глав от программ, поэтому глав там сама не вижу");
    expect(t).toContain("прочитал главу 120");
    const n = web.calls.length;
    await run(NIGHT);
    await run(sat(11, 5));
    expect(web.calls.slice(n).filter((c) => c.url.includes("mangalib"))).toHaveLength(0);
    expect(passport().rd_senkuro).toBeUndefined();
  });

  it("с названием из фразы страницу MangaLib вообще не открываем (меньше запросов)", async () => {
    await say("бот Нулевые пациенты тут: https://mangalib.me/ru/manga/279740--nulevye-pacienty", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ title_ru: "Нулевые пациенты", site: "mangalib" });
    expect(web.count("mangalib.me")).toBe(0);
  });

  it("RanobeLib: пример Ihor — название из разметки страницы, вид — ранобэ", async () => {
    const u = "https://ranobelib.me/ru/book/278175--heonteomurinjul-aratneunde-setakmurieotda-wn";
    web.on(u, RANOBELIB_PAGE);
    const t = await say(`бот читаю ${u}`, MON + MINUTE);
    expect(rows()[0]).toMatchObject({ kind: "ranobe", unit: "vol", site: "ranobelib", title_ru: "Я думал, это история про охотников, а оказалось — про прачечную" });
    expect(t).toContain("RanobeLib: сайт закрывает список глав от программ");
  });

  it("RanobeLib и правило «только по-русски»: глав на сайте бот не видит и говорит об этом; тома пишет, только когда нашлись по-русски на RanobeHub; оригинал новостей не даёт", async () => {
    const u = "https://ranobelib.me/ru/book/278175--heonteomurinjul-aratneunde-setakmurieotda-wn";
    web.on(u, RANOBELIB_PAGE);
    const t = await say(`бот читаю ${u}`, MON + MINUTE);
    expect(t).toContain("RanobeLib: сайт закрывает список глав от программ, поэтому глав там сама не вижу");
    expect(t).toContain("По RanobeHub попробую найти название ночью");
    expect(t).not.toContain("MangaUpdates"); // оригинал новых томов не обещает
    expect(t).not.toContain("MangaDex");
    expect(rows()[0]).toMatchObject({ kind: "ranobe", site: "ranobelib", ru_ch: null, ru_vol: null, told_ch: 0, told_vol: 0 });
    expect(siteLed(rows()[0])).toBe(false);
    const orig = rows()[0].title_orig as string;
    const ru = rows()[0].title_ru;
    // ночью страницу сайта не открываем; на RanobeHub такой книги нет: по-русски нет, о новых молчим
    const n = web.calls.length;
    await run(NIGHT);
    expect(web.calls.slice(n).filter((c) => c.url.includes("ranobelib"))).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ ru_vol: 0, ru_ch: 0, rh_id: null });
    await run(sat(11, 5));
    expect(posted("Чтение")).toHaveLength(0);
    const list = await say("что я читаю", sat(12));
    expect(list).toContain("на RanobeLib (вручную)");
    expect(list).toContain("русского перевода на RanobeHub пока нет");
    // на RanobeHub книга появилась (нашлась по названию): это новость, ссылка «читать» — на RanobeLib, где читает хозяин
    web.rh[orig] = [rhBook({ id: 500, title: ru, originalTitle: orig, volumes: 3, chapters: 20 })];
    await run(day(25, 3, 40));
    expect(rows()[0]).toMatchObject({ rh_id: 500, ru_vol: 3, ru_ch: 20, site: "ranobelib", site_key: "278175--heonteomurinjul-aratneunde-setakmurieotda-wn" });
    expect(siteLed(rows()[0])).toBe(false); // сайт по-прежнему ручной
    await run(day(28, 11, 5));
    const msg = posted("Чтение")[0]?.body.content ?? "";
    expect(msg).toContain("(ранобэ) — вышел том 3");
    expect(msg).toContain("по-русски до тома 3 на RanobeHub");
    expect(msg).toContain(`[читать](<${u}>)`);
  });

  it("Com-X: страница закрыта проверкой браузера — не открываем, берём название из фразы; без названия просим его", async () => {
    const u = "https://com-x.life/12345-chelovek-pauk.html";
    const t0 = await say(`бот читаю ${u}`, MON + MINUTE);
    expect(rows()).toHaveLength(0);
    expect(t0).toContain("Напишите название вместе со ссылкой");
    const t = await say(`бот Человек-паук тут: ${u}`, MON + 2 * MINUTE);
    expect(rows()[0]).toMatchObject({ title_ru: "Человек-паук", site: "comx", site_key: "12345-chelovek-pauk" });
    expect(t).toContain("Com-X: сайт проверяет, что к нему пришёл человек в браузере, поэтому глав там сама не вижу");
    expect(web.count("com-x.life")).toBe(0);
  });

  it("в списке и в «какая глава» видно, где читает хозяин: «на Senkuro», «на MangaLib (вручную)» и ссылка", async () => {
    web.on(SENKURO_URL, senkuroPage());
    web.shikiById[149438] = shikiManga(149438, "Чёртова реинкарнация", "Bil-eomeogeul hwansaeng");
    await say(`бот читаю ${SENKURO_URL}`, MON + MINUTE);
    await say("бот Нулевые пациенты тут: https://mangalib.me/ru/manga/279740--nulevye-pacienty", MON + 2 * MINUTE);
    const list = await say("что я читаю", MON + 3 * MINUTE);
    expect(list).toContain("**Чёртова реинкарнация** (манга) —");
    expect(list).toContain("на Senkuro");
    expect(list).toContain("**Нулевые пациенты** (манга) —");
    expect(list).toContain("на MangaLib (вручную)");
    const where = await say("какая глава чёртова реинкарнация", MON + 4 * MINUTE);
    expect(where).toContain(`Читаете на Senkuro: [ссылка](<${SENKURO_URL}>).`);
    const where2 = await say("какая глава нулевые пациенты", MON + 5 * MINUTE);
    expect(where2).toContain("Читаете на MangaLib (глав там не вижу:");
  });
});

// ---------- 6. ночная проверка и паспорт источников ----------

describe("ночная проверка по сайту", () => {
  beforeEach(async () => {
    web.on(SENKURO_URL, senkuroPage());
    web.shikiById[149438] = shikiManga(149438, "Чёртова реинкарнация", "Bil-eomeogeul hwansaeng");
    await say(`бот читаю ${SENKURO_URL}`, MON + MINUTE);
  });

  it("рост на сайте: русский счётчик и «вышла» по нему; один запрос к сайту на тайтл; Shikimori — раз в неделю; субботнее сообщение со ссылкой", async () => {
    await say("прочитал главу 80 чёртова реинкарнация", MON + 2 * MINUTE);
    web.on(SENKURO_URL, senkuroPage(senkuroManga({ chapters: 84, branches: [{ lang: "RU", chapters: 84 }] })));
    await run(NIGHT);
    expect(web.count("senkuro.com")).toBe(2); // при заведении и ночью
    expect(rows()[0]).toMatchObject({ ru_ch: 84, src_ch: 84, told_ch: 82, src_at: NIGHT, site_at: NIGHT, chk_fail: 0, checked_at: NIGHT });
    expect(web.count("mangadex")).toBe(0);
    expect(web.count("shikimori.io/api/mangas/149438")).toBeGreaterThanOrEqual(2); // при заведении и ночью (раз в неделю: пока не спрашивали)
    await run(sat(11, 5));
    const t = posted("Чтение")[0]?.body.content ?? "";
    expect(t).toContain("**Чёртова реинкарнация** (манга) — вышло 2 главы, последняя — 84 на Senkuro");
    expect(t).toContain("вы на 80, накопилось 4");
    expect(t).toContain(`[читать](<${SENKURO_URL}>)`);
    expect(t).not.toContain("MangaDex");
  });

  it("без роста — тишина; в паспорте источников строка «Чтение: Senkuro» появилась и в порядке", async () => {
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ ru_ch: 82, src_at: null });
    expect(passport().rd_senkuro?.ok).toBe(NIGHT);
    const text = statusText(passport(), {}, NIGHT + MINUTE, "Europe/Kyiv");
    expect(text).toContain("Чтение: Senkuro — читалось сегодня 03:40, всё в порядке.");
    expect(text).not.toContain("Чтение: ReManga");
  });

  it("сайт не отвечает: счётчик не меняется, сбой виден в паспорте; через три ночи — «не отвечает»; в субботнем сообщении честная строка", async () => {
    await say("прочитал главу 80 чёртова реинкарнация", MON + 2 * MINUTE);
    web.on(SENKURO_URL, "x", 503);
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ ru_ch: 82, chk_fail: 1 });
    expect(passport().rd_senkuro).toMatchObject({ fails: 1 });
    expect(statusText(passport(), {}, NIGHT, "Europe/Kyiv")).toContain("Чтение: Senkuro — был сбой (1)");
    for (let i = 1; i <= 3; i++) {
      await run(day(17 + i, 3, 40));
      await run(day(17 + i, 5, 0));
      await run(day(17 + i, 7, 0));
    }
    expect(passport().rd_senkuro!.fails).toBeGreaterThanOrEqual(3);
    expect(statusText(passport(), {}, day(20, 8), "Europe/Kyiv")).toContain("Чтение: Senkuro — не отвечает с");
    expect(rows()[0].ru_ch).toBe(82);
    expect(web.count("mangadex")).toBe(0);
  });

  it("страница изменила разметку (заглушка вместо данных): не обновляем и не выдумываем, пробуем снова", async () => {
    web.on(SENKURO_URL, "<html><body>Что-то новое без данных</body></html>");
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ ru_ch: 82, chk_fail: 1 });
  });

  it("скачок больше 100 за ночь — чужая заливка: не новость", async () => {
    web.on(SENKURO_URL, senkuroPage(senkuroManga({ chapters: 400, branches: [{ lang: "RU", chapters: 400 }] })));
    await run(NIGHT);
    expect(rows()[0].told_ch).toBe(400); // как у MangaDex: залили разом — не новость
  });
});

// ---------- 7. миграция и паспорт ----------

describe("миграция 0016 и паспорт источников", () => {
  it("0016: только новые столбцы (ничего не удаляется), применилась в тестовой базе, отрицательный номер допустим", () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "0016_reading_sites.sql"), "utf8");
    // файл на Windows может прийти с CRLF: режем по любому переводу строки и обрезаем пробелы
    const statements = sql.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE reading ADD COLUMN (?:site|site_url|site_key|site_q|site_at) (?:TEXT|INTEGER);$/);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|UPDATE|RENAME)\b/i);
    const cols = w.d1.q<{ name: string }>("PRAGMA table_info(reading)").map((c) => c.name);
    for (const c of ["site", "site_url", "site_key", "site_q", "site_at"]) expect(cols).toContain(c);
    put({ mal_id: -5, title_ru: "Без Shikimori" });
    expect(rows()[0]).toMatchObject({ mal_id: -5, site: null, site_url: null });
  });

  it("выдуманный номер: один и тот же для одной ссылки, разный для разных, всегда отрицательный", () => {
    expect(syntheticMal("mangalib", "1--a")).toBe(syntheticMal("mangalib", "1--a"));
    expect(syntheticMal("mangalib", "1--a")).not.toBe(syntheticMal("mangalib", "2--b"));
    expect(syntheticMal("comx", "12345-x")).toBeLessThan(0);
  });

  it("паспорт: без прочитанных сайтов экран «Состояние» прежний (строк про чтение нет); записи сайтов читаются обратно", () => {
    expect(statusText({}, {}, NIGHT, "Europe/Kyiv")).not.toContain("Чтение:");
    const p = parsePassport(JSON.stringify({ rd_remanga: { ok: NIGHT, try: NIGHT, fails: 0 }, bogus: { fails: 1 } }));
    expect(p.rd_remanga?.ok).toBe(NIGHT);
    expect((p as Record<string, unknown>).bogus).toBeUndefined();
    expect(statusText(p, {}, NIGHT, "Europe/Kyiv")).toContain("Чтение: ReManga — читалось");
  });

  it("поломка Senkuro не попадает в итог недели про свет и воду: у чтения своя честная строка в субботнем сообщении", async () => {
    web.on(SENKURO_URL, senkuroPage());
    web.shikiById[149438] = shikiManga(149438, "Чёртова реинкарнация", "Bil-eomeogeul hwansaeng");
    await say(`бот читаю ${SENKURO_URL}`, MON + MINUTE);
    await say("прочитал главу 10 чёртова реинкарнация", MON + 2 * MINUTE);
    w.d1.sqlite.prepare("UPDATE reading SET chk_fail = 4 WHERE mal_id = 149438").run();
    await run(sat(11, 5));
    const t = posted("Чтение")[0]?.body.content ?? "";
    expect(t).toContain("Источники глав последние дни не отвечали");
  });
});

// сам факт, что мета не пострадала от наших записей
it("мета reading_on ставится при заведении по ссылке", async () => {
  expect(meta("reading_on")).toBeUndefined();
  web.on("https://mangalib.me/ru/manga/279740--nulevye-pacienty", ldPage({ name: "Нулевые пациенты", alt: [], site: "mangalib" }));
  await say("бот читаю https://mangalib.me/ru/manga/279740--nulevye-pacienty", MON + MINUTE);
  expect(meta("reading_on")).toBe("1");
  await w.repo().exec([setMeta("x", "1")]);
});
