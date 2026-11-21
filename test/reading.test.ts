// Чтение (манга и ранобэ): фразы в канале «бот», ночная проверка источников, субботнее сообщение, лимиты, сбои источника, настройки, миграция.
// Сеть везде фальшивая и по выдуманным данным: ни одного настоящего запроса.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { Repo, setMeta, setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { sectionMessage } from "../src/discord/menu.ts";
import { type Reading } from "../src/reading/core.ts";
import { BATCH } from "../src/reading/cron.ts";
import { handleReadSay } from "../src/reading/handlers.ts";
import { parseReadSay } from "../src/reading/say.ts";
import { readSettings } from "../src/settings.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const MON = kyiv(2026, 11, 16, 12, 0); // понедельник
const sat = (h: number, mi = 0) => kyiv(2026, 11, 21, h, mi); // суббота той же недели
const day = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);

// ---------- фальшивые источники ----------

const shikiManga = (id: number, ru: string, name: string, o: Record<string, unknown> = {}) => ({ id, russian: ru, name, kind: "manga", status: "ongoing", volumes: 0, chapters: 0, aired_on: "2020-05-01", ...o });
const shikiNovel = (id: number, ru: string, name: string, o: Record<string, unknown> = {}) => ({ id, russian: ru, name, kind: "light_novel", status: "ongoing", volumes: 0, chapters: 0, aired_on: "2016-01-01", ...o });
const mdEntry = (id: string, mal: number, langs = ["en", "ru"]) => ({ id, type: "manga", attributes: { links: { mal: String(mal) }, availableTranslatedLanguages: langs } });
const rhBook = (id: number, ru: string, orig: string, vol: number, ch: number) => ({ id, slug: `b${id}`, title: ru, originalTitle: orig, volumes: vol, chapters: ch, status: "В процессе" });
const agg = (ch: number, vol: number) => ({ result: "ok", volumes: { [String(vol)]: { volume: String(vol), chapters: { [String(ch - 2)]: {}, [String(ch - 1)]: {} } }, none: { volume: "none", chapters: { [String(ch)]: {} } } } });

class Src {
  shikiManga: unknown[] | null = [];
  shikiRanobe: unknown[] | null = [];
  shikiById: Record<number, unknown> = {};
  related: Record<number, unknown[]> = {};
  mdSearch: unknown[] | null = [];
  mdAgg: Record<string, unknown | null> = {};
  mdAggRu: Record<string, unknown | null> = {};
  mdFeed: Record<string, unknown> = {};
  muSearch: unknown[] | null = [];
  muSeries: Record<number, unknown | null> = {};
  /** RanobeHub: ответ поиска по запросу `q` (массив книг; null — сайт не отвечает; нет записи — пустой ответ) */
  rh: Record<string, unknown[] | null> = {};
  calls: string[] = [];
  count = (needle: string): number => this.calls.filter((u) => u.includes(needle)).length;

  fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as { url?: string }).url);
    this.calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (v: unknown): Response => (v === null || v === undefined ? new Response("down", { status: 503 }) : Response.json(v));
    if (url.includes("shikimori.io/api/mangas?")) return json(this.shikiManga);
    if (url.includes("shikimori.io/api/ranobe?")) return json(this.shikiRanobe);
    let m = /shikimori\.io\/api\/mangas\/(\d+)\/related/.exec(url);
    if (m) return json(this.related[Number(m[1])] ?? []);
    m = /shikimori\.io\/api\/mangas\/(\d+)/.exec(url);
    if (m) return this.shikiById[Number(m[1])] ? json(this.shikiById[Number(m[1])]) : new Response("none", { status: 404 });
    if (url.includes("api.mangadex.org/manga?")) return json(this.mdSearch === null ? null : { result: "ok", data: this.mdSearch });
    m = /api\.mangadex\.org\/manga\/([\w-]+)\/aggregate\?(.*)$/.exec(url);
    if (m) return json(decodeURIComponent(m[2]).includes("=en") ? this.mdAgg[m[1]] : this.mdAggRu[m[1]]);
    m = /api\.mangadex\.org\/manga\/([\w-]+)\/feed/.exec(url);
    if (m) return json(this.mdFeed[m[1]]);
    if (url.includes("ranobehub.org/api/search")) {
      const v = this.rh[new URL(url).searchParams.get("q") ?? ""];
      return json(v === null ? null : { books: v ?? [] });
    }
    if (url.includes("api.mangaupdates.com/v1/series/search")) return json(this.muSearch === null ? null : { results: this.muSearch.map((record) => ({ record })) });
    m = /api\.mangaupdates\.com\/v1\/series\/(\d+)/.exec(url);
    if (m) return json(this.muSeries[Number(m[1])]);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let w: World;
let src: Src;

const HANA = shikiManga(9001, "Цветок и меч", "Hana to Ken");
const KEN = shikiNovel(9002, "Меч и тень", "Ken to Kage");

/** Запуск cron с фальшивыми источниками; limit — подзапросов за запуск (50 как у Cloudflare). */
async function run(now: number, limit = 50) {
  const repo = w.repo(limit);
  const api = countedApi(w.discord, repo.counter);
  return runCron({ repo, api, now, env: {}, fetchFn: src.fetch, ping: async () => {}, log: () => {} });
}

/** Хозяин написал в канал «бот»; через минуту cron читает. Возвращает текст ответа бота. */
async function say(text: string, at: number): Promise<string> {
  const before = w.discord.posted.length;
  w.discord.say(CH_BOT, OWNER, text);
  await run(at);
  return w.discord.posted.slice(before).filter((p) => p.channel === CH_BOT).map((p) => p.body.content ?? "").join("\n");
}

const rows = () => w.d1.q<Reading>("SELECT * FROM reading ORDER BY id");
const posted = (needle: string) => w.discord.posted.filter((p) => p.channel === CH_REMIND && p.body.content?.includes(needle));

/** Вставить тайтл в базу напрямую (для проверок субботы и ночи без долгого разговора). */
function put(o: Partial<Reading> & { mal_id: number; title_ru: string }): void {
  const r = { kind: "manga", title_orig: null, status: "reading", unit: "ch", read_ch: null, read_vol: null, liked: 0, src_status: "ongoing", src_ch: 0, src_vol: 0, told_ch: 0, told_vol: 0, end_told: 0, chk_fail: 0, added_at: MON, updated_at: MON, ...o } as Record<string, unknown>;
  const keys = Object.keys(r);
  w.d1.sqlite.prepare(`INSERT INTO reading (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((k) => r[k]) as never[]));
}
const turnOn = () => w.repo().exec([setMeta("reading_on", "1")]);

beforeEach(async () => {
  w = new World();
  src = new Src();
  await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off" } });
});

describe("чтение: миграция", () => {
  it("0011 применена: таблица на месте, безопасные значения по умолчанию, номер MAL уникален", () => {
    const cols = w.d1.q<{ name: string }>("PRAGMA table_info(reading)").map((c) => c.name);
    for (const c of ["mal_id", "kind", "status", "unit", "read_ch", "read_vol", "liked", "src_ch", "src_vol", "src_at", "told_ch", "weekq_at", "last_move_at", "ru_ch", "ru_vol", "rh_id", "rh_map_at"]) expect(cols).toContain(c);
    w.d1.sqlite.prepare("INSERT INTO reading (mal_id, title_ru, added_at, updated_at) VALUES (1, 'А', 0, 0)").run();
    expect(rows()[0]).toMatchObject({ kind: "manga", status: "reading", unit: "ch", read_ch: null, liked: 0, src_ch: 0, end_told: 0 });
    expect(() => w.d1.sqlite.prepare("INSERT INTO reading (mal_id, title_ru, added_at, updated_at) VALUES (1, 'Б', 0, 0)").run()).toThrow();
    expect(() => w.d1.sqlite.prepare("INSERT INTO reading (mal_id, title_ru, status, added_at, updated_at) VALUES (2, 'В', 'вообще', 0, 0)").run()).toThrow();
  });
});

describe("чтение: миграция 0013", () => {
  it("старые строки манги: «про что писала» не больше того, что известно по-русски; ранобэ не трогаем; томов по-русски ещё не знаем", () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "0013_reading_ru.sql"), "utf8");
    const fix = /UPDATE reading[^;]*;/.exec(sql)?.[0];
    expect(fix).toBeTruthy();
    put({ mal_id: 1, title_ru: "А", src_ch: 199, told_ch: 199, told_vol: 24, ru_ch: 149 });
    put({ mal_id: 2, title_ru: "Б", src_ch: 50, told_ch: 50, told_vol: 5 }); // русский счётчик не смотрели
    put({ mal_id: 3, title_ru: "В", src_ch: 40, told_ch: 40, ru_ch: 60 }); // по-русски больше, чем писала: оставляем
    put({ mal_id: 4, title_ru: "Г", kind: "ranobe", unit: "vol", src_vol: 12, told_vol: 12 });
    w.d1.sqlite.prepare(fix as string).run();
    expect(rows().map((r) => [r.told_ch, r.told_vol, r.ru_vol])).toEqual([[149, 0, null], [0, 0, null], [40, 0, null], [0, 12, null]]);
  });
});

describe("чтение: запись фразой в канале «бот»", () => {
  beforeEach(async () => {
    src.shikiManga = [HANA];
    src.mdSearch = [mdEntry("md-1", 9001)];
    src.mdAgg["md-1"] = agg(199, 24);
    src.mdAggRu["md-1"] = agg(149, 19);
    await run(MON);
  });

  it("новое название с обращением: нашли, привязали к MangaDex, записали; про уже вышедшее не пишем", async () => {
    const t = await say("бот читаю мангу цветок и меч глава 120", MON + MINUTE);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ mal_id: 9001, kind: "manga", status: "reading", unit: "ch", read_ch: 120, src_ch: 199, src_vol: 24, told_ch: 149, told_vol: 19, ru_ch: 149, ru_vol: 19, md_id: "md-1", end_told: 0 });
    expect(t).toContain("Записала");
    expect(t).toContain("Цветок и меч");
    expect(t).toContain("глава 120 из 149"); // «из» — по-русски, 199 по-английски в разговоре не звучит
    expect(t).toContain("Накопилось: 29 глав");
    expect(t).toContain("MangaDex");
    expect(t).toContain("до главы 149");
    expect(t).not.toContain("199");
    expect(w.d1.q("SELECT * FROM items")).toHaveLength(0); // это не дело
    expect(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'reading_on'")[0].value).toBe("1");
  });

  it("русского перевода у тайтла нет совсем: записали, честно сказали, что о главах писать не будем, пока он не появится", async () => {
    src.mdSearch = [mdEntry("md-1", 9001, ["en"])]; // MangaDex сам говорит: по-русски глав нет
    const t = await say("бот читаю мангу цветок и меч глава 120", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ md_id: "md-1", src_ch: 199, ru_ch: 0, ru_vol: 0, told_ch: 0 });
    expect(t).toContain("русского перевода там пока нет");
    expect(t).toContain("писать не буду");
    expect(t).not.toContain("из 199");
    expect(t).not.toContain("Накопилось");
    expect(src.calls.filter((u) => u.includes("/aggregate") && !decodeURIComponent(u).includes("=en"))).toHaveLength(0); // русских глав нет — русскую выдачу не спрашивали
  });

  it("MangaDex говорит, что русский есть, но цифры не отдал: русский счётчик не смотрели (null), доспросим ночью", async () => {
    src.mdAggRu["md-1"] = null;
    const t = await say("бот читаю мангу цветок и меч глава 120", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ ru_ch: null, ru_vol: null, told_ch: 0, src_ch: 199 });
    expect(t).toContain("русский перевод проверю ночью");
  });

  it("«прочитал X» — на одну дальше; «прочитал главу N X» — ровно N; том переключает единицу", async () => {
    await say("бот читаю мангу цветок и меч глава 120", MON + MINUTE);
    await say("прочитал цветок и меч", MON + 2 * MINUTE);
    expect(rows()[0]).toMatchObject({ read_ch: 121, status: "reading" });
    const t = await say("прочитал главу 130 цветок", MON + 3 * MINUTE);
    expect(rows()[0].read_ch).toBe(130);
    expect(t).toContain("глава 130 из 149");
    await say("прочитал цветок и меч том 5", MON + 4 * MINUTE);
    expect(rows()[0]).toMatchObject({ read_vol: 5, unit: "vol", read_ch: 130 });
    await say("прочитал цветок", MON + 5 * MINUTE);
    expect(rows()[0]).toMatchObject({ read_vol: 6, unit: "vol" });
  });

  it("«прочитал последнюю главу» догоняет: статус «жду продолжения»; новая глава делает «читаю» снова при следующей фразе", async () => {
    await say("бот читаю мангу цветок и меч глава 120", MON + MINUTE);
    const t = await say("прочитал последнюю главу цветок и меч", MON + 2 * MINUTE);
    expect(rows()[0]).toMatchObject({ read_ch: 199, status: "waiting" });
    expect(t).toContain("жду продолжения");
    await say("читаю цветок и меч", MON + 3 * MINUTE);
    expect(rows()[0].status).toBe("reading");
  });

  it("не знаем, где он: «прочитал» без номера считает от нуля и честно говорит об этом", async () => {
    await say("бот читаю мангу цветок и меч", MON + MINUTE);
    expect(rows()[0].read_ch).toBeNull();
    const t = await say("прочитал цветок и меч", MON + 2 * MINUTE);
    expect(rows()[0].read_ch).toBe(1);
    expect(t).toContain("Я не знала, где вы были");
  });

  it("бросил читать, потом хочу почитать: статусы меняются, название берётся из своего списка без сети", async () => {
    await say("бот читаю мангу цветок и меч глава 120", MON + MINUTE);
    const before = src.calls.length;
    await say("бросил читать цветок и меч", MON + 2 * MINUTE);
    expect(rows()[0].status).toBe("dropped");
    await say("хочу почитать цветок и меч", MON + 3 * MINUTE);
    expect(rows()[0].status).toBe("planned");
    expect(src.calls.length).toBe(before);
    expect(rows()[0].read_ch).toBe(120);
  });

  it("чужое название без обращения — это обычное дело, в сеть не ходим", async () => {
    const before = src.calls.length;
    await say("прочитал письмо от банка", MON + MINUTE);
    expect(rows()).toHaveLength(0);
    expect(w.d1.q("SELECT * FROM items")).toHaveLength(1);
    expect(src.calls.length).toBe(before);
  });

  it("два сообщения в один запуск: после добавления вторая фраза без обращения уже про чтение, а не дело", async () => {
    w.discord.say(CH_BOT, OWNER, "бот читаю мангу цветок и меч глава 120");
    w.discord.say(CH_BOT, OWNER, "прочитал цветок и меч");
    await run(MON + MINUTE);
    expect(rows()[0]).toMatchObject({ mal_id: 9001, read_ch: 121 });
    expect(w.d1.q("SELECT * FROM items")).toHaveLength(0);
  });

  it("пока в чтении пусто, фраза без обращения даже не читает базу: это обычное дело", async () => {
    const boom = { prepare: () => { throw new Error("в базу ходить не нужно"); } } as unknown as D1Database;
    const c = { repo: new Repo(boom), now: MON, tz: "Europe/Kyiv", character: "neutral" as const, fetchFn: src.fetch, any: false };
    await expect(handleReadSay(c, parseReadSay("читаю лекцию в клубе")!)).resolves.toBeNull();
    await expect(handleReadSay(c, parseReadSay("прочитал письмо от банка")!)).resolves.toBeNull();
    expect(src.calls).toHaveLength(0);
  });

  it("«бросил читать» неизвестного названия: ничего не ищем и не записываем", async () => {
    const before = src.calls.length;
    const t = await say("бот бросил читать что-то неведомое", MON + MINUTE);
    expect(rows()).toHaveLength(0);
    expect(t).toContain("бросать нечего");
    expect(src.calls.length).toBe(before);
  });

  it("ранобэ только по оригиналу (на RanobeHub нет): MangaUpdates — справка, о новых томах не пишем, честно говорим об этом", async () => {
    src.shikiRanobe = [KEN];
    src.muSearch = [{ series_id: 555, title: "Ken to Kage (Novel)" }, { series_id: 556, title: "Ken to Kage: Side (Novel)" }];
    src.muSeries[555] = { status: "12 Volumes (Ongoing)" };
    const t = await say("хочу почитать ранобэ меч и тень", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ mal_id: 9002, kind: "ranobe", status: "planned", unit: "vol", src_vol: 12, told_vol: 0, ru_vol: 0, ru_ch: 0, mu_id: 555, rh_id: null });
    expect(t).toContain("На RanobeHub этого названия нет");
    expect(t).toContain("писать буду только про русское");
    expect(t).toContain("По оригиналу на MangaUpdates вышло 12 томов"); // справка: оригинал не скрываем, но «слежу» про него не говорим
    expect(t).not.toContain("Слежу");
    expect(src.count("mangadex")).toBe(0);
    await say("читаю меч и тень том 4", MON + 2 * MINUTE);
    expect(rows()[0]).toMatchObject({ read_vol: 4, status: "reading", unit: "vol" });
    const t2 = await say("прочитал меч и тень", MON + 3 * MINUTE);
    expect(rows()[0].read_vol).toBe(5);
    expect(t2).not.toContain("Накопилось"); // 12 томов оригинала в «накопилось» не идут
    expect(t2).not.toContain("из 12");
  });

  it("ранобэ: русский перевод на RanobeHub ведёт «вышло» и «накопилось»; MangaUpdates — только справка в ответе", async () => {
    src.shikiRanobe = [KEN];
    src.muSearch = [{ series_id: 555, title: "Ken to Kage (Novel)" }];
    src.muSeries[555] = { status: "12 Volumes (Ongoing)" };
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень (ЛН)", "Ken to Kage (LN)", 7, 60), rhBook(78, "Меч и тень [Украинский]", "Ken to Kage", 12, 99), rhBook(79, "Совсем другое", "Other", 30, 300)];
    const t = await say("читаю ранобэ меч и тень том 4", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ mu_id: 555, src_vol: 12, told_vol: 7, told_ch: 60, rh_id: 77, ru_vol: 7, ru_ch: 60, unit: "vol", src_url: "https://ranobehub.org/ranobe/77" });
    expect(rows()[0].rh_map_at).not.toBeNull();
    expect(t).toContain("Слежу по RanobeHub, пишу только про то, что там есть по-русски: сейчас до тома 7");
    expect(t).toContain("Накопилось: 3 тома"); // 7 − 4: по-русски, а не 12 − 4 по оригиналу
    expect(t).toContain("из 7");
    expect(t).toContain("По оригиналу на MangaUpdates вышло 12 томов"); // справка
    expect(src.count("ranobehub.org")).toBe(1);
  });

  it("ранобэ-веб-новелла на RanobeHub (том один, глав много): считаем главами, а не пустой единицей", async () => {
    src.shikiRanobe = [KEN];
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень", "Ken to Kage", 1, 300)];
    const t = await say("читаю ранобэ меч и тень", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ unit: "ch", ru_vol: 1, ru_ch: 300, told_ch: 300 });
    expect(t).toContain("до главы 300");
    // сказал «том» — его слово главнее
    w.d1.sqlite.prepare("DELETE FROM reading").run();
    await say("читаю ранобэ меч и тень том 1", MON + 2 * MINUTE);
    expect(rows()[0].unit).toBe("vol");
  });

  it("ранобэ: на RanobeHub не нашли — по-русски нет, о новых томах писать не будем; сайт не ответил — найдём ночью", async () => {
    src.shikiRanobe = [KEN];
    src.muSearch = [];
    let t = await say("читаю ранобэ меч и тень", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ rh_id: null, ru_vol: 0, ru_ch: 0, told_vol: 0 });
    expect(rows()[0].rh_map_at).not.toBeNull();
    expect(t).toContain("На RanobeHub этого названия нет");
    expect(t).toContain("о новых писать не буду");
    w.d1.sqlite.prepare("DELETE FROM reading").run();
    src.rh["Ken to Kage"] = null;
    src.rh["Меч и тень"] = null;
    t = await say("читаю ранобэ меч и тень", MON + 2 * MINUTE);
    expect(rows()[0]).toMatchObject({ rh_id: null, rh_map_at: null, ru_vol: null });
    expect(t).toContain("Записала");
    expect(t).toContain("RanobeHub сейчас не ответил, найду это название ночью");
    expect(t).toContain("только когда они есть по-русски");
  });

  it("источника счётчиков для названия нет: записываем, честно говорим, что главы сам считать буду по его фразам", async () => {
    src.mdSearch = []; // на MangaDex такого нет
    const t = await say("бот читаю мангу цветок и меч", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ md_id: null, src_ch: 0 });
    expect(rows()[0].map_at).not.toBeNull(); // искала: повторю не раньше чем через неделю
    expect(t).toContain("главы сама не вижу");
    await say("прочитал цветок и меч", MON + 2 * MINUTE);
    expect(rows()[0].read_ch).toBe(1);
  });

  it("MangaDex не ответил при добавлении: записали, найдём ночью", async () => {
    src.mdSearch = null;
    const t = await say("бот читаю мангу цветок и меч", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ md_id: null, map_at: null });
    expect(t).toContain("найду это название ночью");
  });

  it("Shikimori не ответил: ничего не записали, сказали об этом", async () => {
    src.shikiManga = null;
    const t = await say("бот читаю мангу цветок и меч", MON + MINUTE);
    expect(rows()).toHaveLength(0);
    expect(t).toContain("не отвечает");
  });

  it("не нашлось и неоднозначно: спрашиваем точнее, ничего не записываем", async () => {
    src.shikiManga = [];
    expect(await say("бот читаю мангу ничего подобного", MON + MINUTE)).toContain("не нашла");
    src.shikiManga = [shikiManga(1, "Меч тьмы", "Ken A"), shikiManga(2, "Меч света", "Ken B")];
    expect(await say("бот читаю мангу меч", MON + 2 * MINUTE)).toContain("Нашла несколько");
    expect(rows()).toHaveLength(0);
  });

  it("манга и ранобэ с одним названием: без уточнения — спрашиваем; со словом «ранобэ» — выбирает его", async () => {
    src.shikiManga = [shikiManga(11, "Реинкарнация", "Reinc M")];
    src.shikiRanobe = [shikiNovel(12, "Реинкарнация", "Reinc N")];
    expect(await say("бот читаю реинкарнация", MON + MINUTE)).toContain("Нашла несколько");
    await say("читаю ранобэ реинкарнация", MON + 2 * MINUTE);
    expect(rows().map((r) => r.mal_id)).toEqual([12]);
    expect(src.count("shikimori.io/api/mangas?")).toBe(1); // со словом «ранобэ» мангу не искали
  });

  it("лимит слежения: одиннадцатый тайтл записан, но бот честно говорит, что о нём пока не пишет", async () => {
    for (let i = 0; i < 10; i++) put({ mal_id: 100 + i, title_ru: `Тайтл ${i}` });
    await turnOn();
    const t = await say("бот читаю мангу цветок и меч", MON + MINUTE);
    expect(rows()).toHaveLength(11);
    expect(t).toContain("первыми десятью");
  });
});

describe("чтение: вопросы", () => {
  beforeEach(async () => {
    put({ mal_id: 1, title_ru: "Цветок и меч", read_ch: 140, src_ch: 199, told_ch: 149, told_vol: 19, ru_ch: 149, ru_vol: 19, md_id: "md-1" });
    put({ mal_id: 2, title_ru: "Меч и тень", kind: "ranobe", unit: "vol", status: "waiting", read_vol: 12, src_vol: 14, told_vol: 12, ru_vol: 12, ru_ch: 90, mu_id: 5, rh_id: 77, rh_map_at: MON });
    put({ mal_id: 3, title_ru: "Лунный сад", status: "planned" });
    put({ mal_id: 4, title_ru: "Старая сказка", status: "done", src_status: "finished", src_ch: 40, total_ch: 40, read_ch: 40 });
    await turnOn();
    await run(MON);
  });

  it("«что я читаю»: читаю и жду подробно, планы названиями, остальное числом", async () => {
    const t = await say("что я читаю", MON + MINUTE);
    expect(t).toContain("📖 Чтение");
    expect(t).toContain("**Читаю** (1)");
    expect(t).toContain("**Цветок и меч** (манга) — глава 140 из 149 · накопилось 9");
    expect(t).toContain("**Жду продолжения** (1)");
    expect(t).toContain("**Меч и тень** (ранобэ) — том 12 из 12");
    expect(t).toContain("**В планах** (1): Лунный сад");
    expect(t).toContain("дочитал: 1");
    expect(w.d1.q("SELECT * FROM items")).toHaveLength(0);
  });

  it("«что вышло по чтению»: накопленное с ссылкой и русским переводом; когда всё прочитано — так и скажет", async () => {
    w.d1.sqlite.prepare("UPDATE reading SET src_url = 'https://example.test/c199' WHERE mal_id = 1").run();
    const t = await say("что вышло по чтению", MON + MINUTE);
    expect(t).toContain("**Цветок и меч** (манга) — вы на 140, накопилось 9 · по-русски до главы 149 на MangaDex");
    expect(t).toContain("[читать](<https://example.test/c199>)");
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 149 WHERE mal_id = 1").run();
    expect(await say("новые главы", MON + 2 * MINUTE)).toContain("нового нет");
  });

  it("манга без русского перевода: в «что вышло» честная строка (там можно), в списке — одна пометка; по ней не копится", async () => {
    put({ mal_id: 5, title_ru: "Без перевода", read_ch: 3, src_ch: 120, ru_ch: 0, ru_vol: 0, md_id: "md-5" });
    put({ mal_id: 6, title_ru: "Нет на MangaDex", read_ch: 3 });
    const news = await say("что вышло по чтению", MON + MINUTE);
    expect(news).toContain("**Цветок и меч**");
    expect(news).not.toContain("**Без перевода**");
    expect(news).toContain("Русского перевода на MangaDex не вижу: Без перевода, Нет на MangaDex. Пока он не появится, о них молчу.");
    expect(news).not.toContain("120");
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 149 WHERE mal_id = 1").run();
    const none = await say("новые главы", MON + 2 * MINUTE);
    expect(none).toContain("нового нет");
    expect(none).toContain("Без перевода");
    const list = await say("что я читаю", MON + 3 * MINUTE);
    expect(list).toContain("**Без перевода** (манга) — глава 3 · русского перевода на MangaDex пока нет");
    expect(list).not.toContain("120");
  });

  it("ранобэ только по оригиналу: в «что вышло» честная строка и ни слова про его тома, в списке — пометка, по «какой том» оригинал показан справкой", async () => {
    put({ mal_id: 7, title_ru: "Только оригинал", kind: "ranobe", unit: "vol", read_vol: 3, src_vol: 20, mu_id: 9, ru_vol: 0, ru_ch: 0, rh_map_at: MON });
    put({ mal_id: 8, title_ru: "Не искали", kind: "ranobe", unit: "vol", read_vol: 1, src_vol: 15, mu_id: 10 });
    const news = await say("что вышло по чтению", MON + MINUTE);
    expect(news).toContain("Русского перевода на RanobeHub не вижу: Только оригинал, Не искали. Пока он не появится, о них молчу.");
    expect(news).not.toMatch(/\b(?:20|15)\b/); // тома оригинала не звучат
    expect(news).not.toContain("Меч и тень"); // а ранобэ с русским переводом, где вы догнали, не «молчит»: нового просто нет
    const list = await say("что я читаю", MON + 2 * MINUTE);
    expect(list).toContain("**Только оригинал** (ранобэ) — том 3 · русского перевода на RanobeHub пока нет");
    expect(list).not.toMatch(/из (?:20|15)\b/);
    const where = await say("какой том только оригинал", MON + 3 * MINUTE);
    expect(where).toContain("Русского перевода на RanobeHub пока нет, поэтому о новых томах и главах не пишу, пока он не появится.");
    expect(where).toContain("По оригиналу (MangaUpdates) вышло 20 томов.");
    expect(where).not.toContain("Накопилось");
  });

  it("«какая глава Цветок»: где вы, что у источника; неизвестное название — подсказка", async () => {
    const t = await say("какая глава цветок и меч", MON + MINUTE);
    expect(t).toContain("Вы на: глава 140 (по-русски вышло 149)");
    expect(t).toContain("Накопилось: 9 глав");
    expect(t).toContain("По-русски до главы 149 на MangaDex.");
    expect(t).not.toContain("199");
    expect(await say("на какой я главе неведомая вещь", MON + 2 * MINUTE)).toContain("в вашем чтении нет");
  });

  it("вопрос про аниме не перехвачен чтением: «что вышло нового» остаётся аниме", async () => {
    const t = await say("что вышло нового", MON + MINUTE);
    expect(t).not.toContain("Чтение");
    expect(t).toContain("пока пусто"); // ответ аниме-части: «В «Смотрю» пока пусто…»
  });
});

describe("чтение: ночная проверка", () => {
  const NIGHT = day(17, 3, 40); // вторник 03:40 (позже REFRESH_FROM = 03:30)

  it("в чтении ничего нет — ни одного запроса к источникам и ни одной записи про чтение", async () => {
    await run(day(17, 4));
    await run(day(17, 5));
    expect(src.calls).toHaveLength(0);
    expect(w.d1.q("SELECT * FROM meta WHERE key LIKE 'reading%'")).toHaveLength(0);
  });

  it("рост у MangaDex: английская глава не новость, русская — новость (ссылка на неё), «про что писала» не трогается; без роста — тишина", async () => {
    src.shikiManga = [HANA];
    src.mdSearch = [mdEntry("md-1", 9001)];
    src.mdAgg["md-1"] = agg(199, 24);
    src.mdAggRu["md-1"] = agg(149, 19);
    src.shikiById[9001] = HANA;
    await run(MON);
    await say("бот читаю мангу цветок и меч глава 140", MON + MINUTE);
    expect(rows()[0]).toMatchObject({ src_ch: 199, ru_ch: 149, told_ch: 149, src_at: null });
    // следующая ночь: ничего нового
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ src_ch: 199, ru_ch: 149, src_at: null, chk_fail: 0 });
    expect(rows()[0].checked_at).toBe(NIGHT);
    // ещё через ночь по-английски вышло две главы, по-русски ничего: тихо (общий счётчик записан, но не новость)
    src.mdAgg["md-1"] = agg(201, 24);
    await run(day(18, 3, 40));
    expect(rows()[0]).toMatchObject({ src_ch: 201, ru_ch: 149, told_ch: 149, src_vol: 24, src_at: null });
    expect(src.count("/feed")).toBe(0);
    // ещё через ночь вышла русская глава 151: новость, ссылка на русскую главу
    src.mdAgg["md-1"] = agg(202, 24);
    src.mdAggRu["md-1"] = agg(151, 19);
    src.mdFeed["md-1"] = { result: "ok", data: [{ id: "chap-ru-151", attributes: { chapter: "151", externalUrl: null } }] };
    await run(day(19, 3, 40));
    expect(rows()[0]).toMatchObject({ src_ch: 202, ru_ch: 151, told_ch: 149 });
    expect(rows()[0].src_at).toBe(day(19, 3, 40));
    expect(rows()[0].src_url).toBe("https://mangadex.org/chapter/chap-ru-151");
    expect(decodeURIComponent(src.calls.find((u) => u.includes("/feed")) ?? "")).not.toContain("translatedLanguage[]=en");
    // официальная ссылка важнее
    src.mdAggRu["md-1"] = agg(152, 19);
    src.mdFeed["md-1"] = { result: "ok", data: [{ id: "chap-ru-152", attributes: { chapter: "152", externalUrl: "https://official.test/152" } }] };
    await run(day(20, 3, 40));
    expect(rows()[0]).toMatchObject({ ru_ch: 152, src_url: "https://official.test/152" });
  });

  it("русский перевод появился позже: по тайтлу молчали, потом появилась первая глава по-русски — это новость, и в субботу о ней напишут", async () => {
    put({ mal_id: 9001, title_ru: "Цветок и меч", title_orig: "Hana to Ken", md_id: "md-1", src_ch: 199, ru_ch: 0, ru_vol: 0, told_ch: 0, read_ch: 3, map_at: MON, shiki_at: MON, adapt_at: MON });
    src.mdAgg["md-1"] = agg(199, 24);
    src.mdAggRu["md-1"] = agg(0, 0);
    await turnOn();
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ ru_ch: 0, ru_vol: 0 });
    await run(sat(11, 5));
    expect(posted("Чтение")).toHaveLength(0); // молчим, хотя по-английски 199 глав
    src.mdAggRu["md-1"] = agg(2, 1);
    await run(day(22, 3, 40));
    expect(rows()[0]).toMatchObject({ ru_ch: 2, ru_vol: 1 });
    await run(day(28, 11, 5));
    const t = posted("Чтение")[0].body.content ?? "";
    expect(t).toContain("**Цветок и меч** (манга) — вышла глава 2");
    expect(t).toContain("вы на 3");
    expect(t).not.toContain("199");
  });

  it("проверка не чаще раза в сутки и понемногу: по паре тайтлов за запуск, потом день закрыт", async () => {
    for (let i = 1; i <= 5; i++) {
      put({ mal_id: i, title_ru: `Тайтл ${i}`, md_id: `md-${i}`, src_ch: 10, told_ch: 10, map_at: MON, shiki_at: MON, adapt_at: MON });
      src.mdAgg[`md-${i}`] = agg(10, 1);
      src.mdAggRu[`md-${i}`] = agg(5, 1);
    }
    await turnOn();
    await run(NIGHT);
    expect(rows().filter((r) => r.checked_at === NIGHT)).toHaveLength(BATCH);
    expect(src.count("/aggregate")).toBe(BATCH * 2);
    await run(NIGHT + MINUTE);
    await run(NIGHT + 2 * MINUTE);
    expect(rows().every((r) => r.checked_at !== null && r.checked_at >= NIGHT)).toBe(true);
    expect(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'reading_refresh'")[0].value).toBe("2026-11-17");
    const done = src.calls.length;
    await run(NIGHT + 3 * MINUTE);
    await run(day(17, 15));
    expect(src.calls.length).toBe(done); // за сутки больше ни запроса
    expect(src.count("shikimori")).toBe(0); // Shikimori у свежепроверенных (меньше недели) не спрашивают
  });

  it("не проверяет раньше 03:30 и не по тем, за кем не следит (планы, брошенное)", async () => {
    put({ mal_id: 1, title_ru: "Читаю", md_id: "md-1", map_at: MON, shiki_at: MON, adapt_at: MON });
    put({ mal_id: 2, title_ru: "План", md_id: "md-2", status: "planned" });
    put({ mal_id: 3, title_ru: "Брошено", md_id: "md-3", status: "dropped" });
    src.mdAgg["md-1"] = agg(10, 1);
    await turnOn();
    await run(day(17, 2, 59));
    expect(src.calls).toHaveLength(0);
    await run(NIGHT);
    expect(src.calls.every((u) => u.includes("md-1"))).toBe(true);
    expect(src.calls.length).toBeGreaterThan(0);
  });

  it("первая цифра — отправная точка: ночью узнали счётчик впервые, про «вышло» не пишем; в запуске не больше своих подзапросов", async () => {
    put({ mal_id: 9001, title_ru: "Цветок и меч", title_orig: "Hana to Ken", read_ch: 10 });
    src.mdSearch = [mdEntry("md-1", 9001)];
    src.mdAgg["md-1"] = agg(199, 24);
    src.mdAggRu["md-1"] = agg(149, 19);
    src.shikiById[9001] = HANA;
    await turnOn();
    const rep = await run(NIGHT, 20);
    expect(rows()[0]).toMatchObject({ md_id: "md-1", src_ch: 199, told_ch: 149, src_vol: 24, ru_ch: 149, ru_vol: 19, told_vol: 19, src_status: "ongoing" });
    expect(rows()[0].src_at).toBeNull();
    expect(rep.subrequests).toBeLessThanOrEqual(20);
    expect(rep.notes.some((n) => n.includes("чтение: проверено 1 из 1"))).toBe(true);
  });

  it("MangaDex не отвечает: повтор через час, после третьей неудачи — до следующей ночи, без сообщений и без записи цифр", async () => {
    put({ mal_id: 1, title_ru: "Тайтл", md_id: "md-1", src_ch: 10, told_ch: 10, map_at: MON, shiki_at: MON, adapt_at: MON });
    src.mdAgg["md-1"] = null;
    await turnOn();
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ chk_fail: 1, src_ch: 10 });
    const n1 = src.calls.length;
    await run(NIGHT + 30 * MINUTE); // рано
    expect(src.calls.length).toBe(n1);
    await run(NIGHT + HOUR + MINUTE);
    expect(rows()[0].chk_fail).toBe(2);
    await run(NIGHT + 2 * HOUR + 2 * MINUTE);
    expect(rows()[0].chk_fail).toBe(3);
    expect(rows()[0].checked_at).toBe(NIGHT + 2 * HOUR + 2 * MINUTE); // сегодня больше не пробуем
    const n2 = src.calls.length;
    await run(NIGHT + 5 * HOUR);
    expect(src.calls.length).toBe(n2);
    expect(w.discord.posted.filter((p) => p.channel === CH_REMIND)).toHaveLength(0);
    // заработал — счётчик неудач сбрасывается
    src.mdAgg["md-1"] = agg(11, 1);
    await run(day(18, 4));
    expect(rows()[0]).toMatchObject({ chk_fail: 0, src_ch: 11 });
  });

  it("тайтл закончился по Shikimori (раз в неделю): итоги и состояние записаны; аниме по тайтлу найдено", async () => {
    put({ mal_id: 9001, title_ru: "Цветок и меч", title_orig: "Hana to Ken", md_id: "md-1", src_ch: 199, told_ch: 199, read_ch: 190, map_at: MON });
    src.mdAgg["md-1"] = agg(199, 24);
    src.shikiById[9001] = shikiManga(9001, "Цветок и меч", "Hana to Ken", { status: "released", chapters: 205, volumes: 25 });
    src.related[9001] = [
      { relation: "Adaptation", anime: { id: 7, russian: "Цветок и меч (аниме)", status: "released" } },
      { relation: "Adaptation", anime: { id: 8, russian: "Цветок и меч 2", status: "ongoing" } },
      { relation: "Sequel", anime: { id: 9, russian: "Не то", status: "ongoing" } },
    ];
    await turnOn();
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ src_status: "finished", total_ch: 205, total_vol: 25, src_ch: 205, src_vol: 25, adapt_mal: 8, adapt_ru: "Цветок и меч 2", adapt_status: "ongoing" });
    expect(rows()[0].shiki_at).toBe(NIGHT);
  });
});

describe("чтение: субботнее сообщение", () => {
  const SAT = sat(11, 5);

  beforeEach(async () => {
    put({ mal_id: 1, title_ru: "Цветок и меч", read_ch: 140, src_ch: 201, src_vol: 24, told_ch: 149, told_vol: 19, ru_ch: 151, ru_vol: 19, src_url: "https://example.test/c151", md_id: "md-1" });
    await turnOn();
  });

  it("в субботу после 11:00: что вышло, где вы, сколько накопилось, ссылка и русский перевод; один раз за неделю", async () => {
    await run(sat(10, 59));
    expect(posted("Чтение")).toHaveLength(0);
    await run(SAT);
    const msg = posted("Чтение");
    expect(msg).toHaveLength(1);
    const t = msg[0].body.content ?? "";
    expect(t).toContain("**📖 Чтение · что накопилось**");
    expect(t).toContain("**Цветок и меч** (манга) — вышло 2 главы, последняя — 151 · вы на 140, накопилось 11 · по-русски до главы 151 на MangaDex · [читать](<https://example.test/c151>)");
    expect(t).not.toContain("201"); // английские главы в сообщении не звучат
    expect(msg[0].body.components ?? []).toHaveLength(0); // кнопок нет
    expect(rows()[0]).toMatchObject({ told_ch: 151 });
    await run(SAT + MINUTE);
    await run(SAT + 5 * HOUR);
    expect(posted("Чтение")).toHaveLength(1);
  });

  it("на следующей неделе: если новых нет, но накопилось, напоминает ещё раз; если всё прочитано — молчит", async () => {
    await run(SAT);
    expect(posted("Чтение")).toHaveLength(1);
    await run(sat(11, 5) + 7 * 24 * HOUR);
    expect(posted("Чтение")).toHaveLength(2);
    expect(posted("Чтение")[1].body.content).toContain("вы на 140, накопилось 11");
    expect(posted("Чтение")[1].body.content).not.toContain("вышло 2 главы");
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 151").run();
    await run(sat(11, 5) + 14 * 24 * HOUR);
    expect(posted("Чтение")).toHaveLength(2);
  });

  it("тихие часы: сообщение ждёт их конца, но в тот же день; в отъезде — не шлёт", async () => {
    await w.repo().exec([setSetting("quiet_enabled", "1"), setSetting("quiet_from", "10:00"), setSetting("quiet_to", "12:00")]);
    await run(SAT);
    expect(posted("Чтение")).toHaveLength(0);
    await run(sat(12, 5));
    expect(posted("Чтение")).toHaveLength(1);
    // отъезд
    await w.repo().exec([setSetting("quiet_enabled", "0"), setSetting("away_until", String(sat(12, 0) + 30 * 24 * HOUR))]);
    await run(sat(11, 5) + 7 * 24 * HOUR);
    expect(posted("Чтение")).toHaveLength(1);
  });

  it("выключено в настройках — не пишет; другой день и время — пишет по ним", async () => {
    await w.repo().exec([setSetting("reading", "off")]);
    await run(SAT);
    expect(posted("Чтение")).toHaveLength(0);
    await w.repo().exec([setSetting("reading", "5@18:30")]); // пятница 18:30 той же недели (ключ недели ещё не занят)
    await run(day(20, 18, 29));
    expect(posted("Чтение")).toHaveLength(0);
    await run(day(20, 18, 31));
    expect(posted("Чтение")).toHaveLength(1);
    await run(SAT); // суббота той же недели — уже было
    expect(posted("Чтение")).toHaveLength(1);
  });

  it("много накопилось: Хару решает — 3 тайтла подробно (завершённое, любимое, свежее первыми), остальные одной строкой", async () => {
    put({ mal_id: 2, title_ru: "Тайтл Б", read_ch: 10, ru_ch: 50, told_ch: 50 });
    put({ mal_id: 3, title_ru: "Тайтл В", read_ch: 10, ru_ch: 31, told_ch: 30 });
    put({ mal_id: 4, title_ru: "Тайтл Г", read_ch: 10, ru_ch: 12, told_ch: 12, liked: 2 });
    put({ mal_id: 5, title_ru: "Тайтл Д", read_ch: 1, ru_ch: 90, told_ch: 90 });
    put({ mal_id: 6, title_ru: "Тайтл Е", src_status: "finished", src_ch: 20, ru_ch: 20, total_ch: 20, read_ch: 20 });
    put({ mal_id: 7, title_ru: "Тайтл Ж", src_ch: 400, ru_ch: 0, ru_vol: 0, read_ch: 1 }); // по-английски много, по-русски ничего
    put({ mal_id: 8, title_ru: "Тайтл З", src_status: "finished", src_ch: 60, ru_ch: 0, ru_vol: 0, total_ch: 60, read_ch: 60 }); // закончен, но перевода нет
    await run(SAT);
    const t = posted("Чтение")[0].body.content ?? "";
    const lines = t.split("\n").filter((l) => l.startsWith("• "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Тайтл Е");
    expect(lines[0]).toContain("закончен: всего 20 глав");
    expect(lines[1]).toContain("Тайтл Г");
    expect(lines[2]).toContain("Цветок и меч"); // свежая глава и накопилось меньше, чем у «Тайтл В»
    expect(t).toContain("Ещё накопилось: Тайтл В +21, Тайтл Б +40, Тайтл Д +89.");
    expect(rows().find((r) => r.mal_id === 6)?.end_told).toBe(1);
    expect(t).not.toContain("Тайтл Ж"); // без русского перевода — ни слова, хотя 400 глав по-английски
    expect(t).not.toContain("Тайтл З");
    expect(t).not.toContain("не вижу");
    expect(rows().find((r) => r.mal_id === 8)?.end_told).toBe(0); // про завершение скажу, когда будет что читать по-русски
    expect(rows().find((r) => r.mal_id === 1)?.told_ch).toBe(151); // показан подробно: теперь про главу сказано
    expect(rows().find((r) => r.mal_id === 3)?.told_ch).toBe(30); // в «Ещё» одной строкой: новое ещё не рассказано, расскажу в следующий раз
  });

  it("по-английски вышло много, по-русски ничего нового: ни сообщения, ни слова про английские главы", async () => {
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 151, told_ch = 151, src_ch = 260, src_vol = 30").run();
    await run(SAT);
    expect(posted("Чтение")).toHaveLength(0);
    expect(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'reading_week'")[0].value).toBe("2026-11-16");
    w.d1.sqlite.prepare("UPDATE reading SET ru_ch = 152, read_ch = 140").run();
    await run(sat(11, 5) + 7 * 24 * HOUR);
    const t = posted("Чтение")[0].body.content ?? "";
    expect(t).toContain("вышла глава 152");
    expect(t).not.toContain("260");
  });

  it("аниме по его манге: один раз, когда идёт или анонсировано", async () => {
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 151, adapt_mal = 8, adapt_ru = 'Цветок и меч 2', adapt_status = 'ongoing'").run();
    await run(SAT);
    const t = posted("Чтение")[0].body.content ?? "";
    expect(t).toContain("🎬 По **Цветок и меч** сейчас идёт аниме: «Цветок и меч 2».");
    expect(rows()[0].adapt_told).toBe("8:ongoing");
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 140").run();
    await run(SAT + 7 * 24 * HOUR);
    expect(posted("Чтение")[1].body.content).not.toContain("🎬");
  });

  it("давно не двигается: один раз спрашивает, продолжает ли; бросить можно фразой", async () => {
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 151, last_move_at = ?").run(SAT - 70 * 24 * HOUR);
    await run(SAT);
    const t = posted("Чтение")[0].body.content ?? "";
    expect(t).toContain("не двигается уже 10 недель");
    expect(t).toContain("бросил читать Цветок и меч");
    expect(rows()[0].weekq_at).toBe(SAT);
    await run(SAT + 7 * 24 * HOUR);
    expect(posted("Чтение")).toHaveLength(1); // второй раз не спрашивает
  });

  it("источник долго не отвечал: честная строка (даже если новых глав нет)", async () => {
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 151, told_ch = 151, chk_fail = 4").run();
    await run(SAT);
    expect(posted("Чтение")).toHaveLength(1);
    expect(posted("Чтение")[0].body.content).toContain("Источники глав последние дни не отвечали");
  });

  it("нечего сказать — тишина, но неделя помечена (не перечитываем таблицу каждую минуту)", async () => {
    w.d1.sqlite.prepare("UPDATE reading SET read_ch = 151, told_ch = 151").run();
    await run(SAT);
    expect(posted("Чтение")).toHaveLength(0);
    expect(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'reading_week'")[0].value).toBe("2026-11-16");
  });

  it("характер «горничная»: реплика Хару и сценка есть, у нейтрального нет", async () => {
    await w.repo().exec([setSetting("character", "maid"), setSetting("mood_on", "0")]);
    await run(SAT);
    const t = posted("Чтение")[0].body.content ?? "";
    expect(t).toMatch(/\*Хару [^*]+\*/);
    expect(t.split("\n").length).toBeGreaterThan(3);
  });
});

describe("чтение: ранобэ по томам", () => {
  const RH_URL = "https://ranobehub.org/ranobe/77";

  it("по оригиналу вышло больше: MangaUpdates растёт — тишина; по-русски вышел том — «вышел том 9» и только он", async () => {
    put({ mal_id: 9002, title_ru: "Меч и тень", title_orig: "Ken to Kage", kind: "ranobe", unit: "vol", read_vol: 8, src_vol: 12, told_vol: 8, ru_vol: 8, ru_ch: 70, rh_id: 77, rh_map_at: MON, src_url: RH_URL, mu_id: 555, map_at: MON, shiki_at: MON, adapt_at: MON });
    src.muSeries[555] = { status: "13 Volumes (Ongoing)" };
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень", "Ken to Kage", 8, 70)];
    await turnOn();
    await run(day(17, 4));
    expect(rows()[0]).toMatchObject({ src_vol: 13, told_vol: 8, ru_vol: 8 }); // оригинал вырос, русский счётчик нет
    expect(rows()[0].src_at).toBeNull();
    await run(sat(11, 5));
    expect(posted("Чтение")).toHaveLength(0); // молчим, хотя по оригиналу 13 томов, а вы на 8
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень", "Ken to Kage", 9, 75)];
    await run(day(22, 4));
    expect(rows()[0]).toMatchObject({ ru_vol: 9, ru_ch: 75, told_vol: 8 });
    await run(day(28, 11, 5));
    const t = posted("Чтение")[0].body.content ?? "";
    expect(t).toContain(`**Меч и тень** (ранобэ) — вышел том 9 · вы на 8, накопилось 1 · по-русски до тома 9 на RanobeHub · [читать](<${RH_URL}>)`);
    expect(t).not.toContain("13");
    expect(rows()[0].told_vol).toBe(9);
  });

  it("ранобэ без русского перевода: ночью оригинал растёт, а в субботу — ни сообщения, ни слова про тома по-английски", async () => {
    put({ mal_id: 9002, title_ru: "Меч и тень", title_orig: "Ken to Kage", kind: "ranobe", unit: "vol", read_vol: 1, src_vol: 12, ru_vol: 0, ru_ch: 0, rh_map_at: day(16, 3), mu_id: 555, map_at: MON, shiki_at: MON, adapt_at: MON });
    src.muSeries[555] = { status: "14 Volumes (Ongoing)" };
    await turnOn();
    await run(day(17, 4));
    expect(rows()[0]).toMatchObject({ src_vol: 14, ru_vol: 0, told_vol: 0 });
    await run(sat(11, 5));
    expect(posted("Чтение")).toHaveLength(0);
    expect(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'reading_week'")[0].value).toBe("2026-11-16"); // неделя отмечена: таблицу не перечитываем
    // закончился (по Shikimori), но перевода нет: про завершение тоже молчим, пока нет русского
    w.d1.sqlite.prepare("UPDATE reading SET src_status = 'finished', total_vol = 14").run();
    await run(sat(11, 5) + 7 * 24 * HOUR);
    expect(posted("Чтение")).toHaveLength(0);
    expect(rows()[0].end_told).toBe(0);
  });

  it("старая строка ранобэ (про что писала — по MangaUpdates, русская цифра из справочной строки): ложных новостей нет, следующий русский том — новость", async () => {
    put({ mal_id: 9002, title_ru: "Меч и тень", title_orig: "Ken to Kage", kind: "ranobe", unit: "vol", read_vol: 8, src_vol: 13, told_vol: 13, ru_vol: 8, ru_ch: 70, rh_id: 77, rh_map_at: MON, src_url: RH_URL, mu_id: 555, map_at: MON, shiki_at: MON, adapt_at: MON });
    src.muSeries[555] = { status: "13 Volumes (Ongoing)" };
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень", "Ken to Kage", 8, 70)];
    await turnOn();
    await run(day(17, 4));
    expect(rows()[0].told_vol).toBe(8); // подтянули вниз: русских томов 8
    await run(sat(11, 5));
    expect(posted("Чтение")).toHaveLength(0);
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень", "Ken to Kage", 9, 75)];
    await run(day(22, 4));
    await run(day(28, 11, 5));
    expect(posted("Чтение")[0].body.content).toContain("вышел том 9");
  });
});

describe("чтение: ранобэ и RanobeHub ночью", () => {
  const NIGHT = day(17, 3, 40);
  const novel = (o: Partial<Reading> = {}) => put({ mal_id: 9002, title_ru: "Меч и тень", title_orig: "Ken to Kage", kind: "ranobe", unit: "vol", read_vol: 10, src_vol: 12, told_vol: 12, mu_id: 555, map_at: MON, shiki_at: MON, adapt_at: MON, ...o });

  it("находит книгу на RanobeHub и привязывает; первая русская цифра — отправная точка; в субботу — накопилось по-русски, оригинал не звучит; ссылка на русский перевод", async () => {
    novel({ read_vol: 5 });
    src.muSeries[555] = { status: "13 Volumes (Ongoing)" };
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень", "Ken to Kage", 8, 70)];
    await turnOn();
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ rh_id: 77, ru_vol: 8, ru_ch: 70, src_vol: 13, told_vol: 8, told_ch: 70, src_url: "https://ranobehub.org/ranobe/77" });
    expect(rows()[0].rh_map_at).toBe(NIGHT);
    await run(sat(11, 5));
    const t = posted("Чтение")[0].body.content ?? "";
    // «вышел том 13» по MangaUpdates больше не пишем: по-русски до 8, и накопилось 8 − 5
    expect(t).toContain("**Меч и тень** (ранобэ) — вы на 5, накопилось 3 · по-русски до тома 8 на RanobeHub · [читать](<https://ranobehub.org/ranobe/77>)");
    expect(t).not.toContain("вышел том");
    expect(t).not.toContain("13");
  });

  it("привязанная книга обновляется по номеру: растёт — записываем; сайт не отвечает или книга пропала из выдачи — прежние цифры, ночь не считается сбойной", async () => {
    novel({ rh_id: 77, ru_vol: 8, ru_ch: 70, rh_map_at: MON, src_url: "https://ranobehub.org/ranobe/77" });
    src.muSeries[555] = { status: "12 Volumes (Ongoing)" };
    src.rh["Ken to Kage"] = [rhBook(76, "Другая", "Other", 1, 1), rhBook(77, "Меч и тень", "Ken to Kage", 9, 80)];
    await turnOn();
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ rh_id: 77, ru_vol: 9, ru_ch: 80, chk_fail: 0 });
    src.rh["Ken to Kage"] = null;
    src.rh["Меч и тень"] = null;
    await run(day(18, 3, 40));
    expect(rows()[0]).toMatchObject({ rh_id: 77, ru_vol: 9, chk_fail: 0 });
    expect(rows()[0].checked_at).toBe(day(18, 3, 40));
    src.rh["Ken to Kage"] = [rhBook(76, "Другая", "Other", 1, 1)]; // книги нет в выдаче: цифры остаются
    src.rh["Меч и тень"] = [];
    await run(day(19, 3, 40));
    expect(rows()[0]).toMatchObject({ rh_id: 77, ru_vol: 9 });
  });

  it("не нашла на RanobeHub — повтор не раньше чем через неделю; сайт не ответил — повтор в следующую ночь, проверка тайтла при этом удаётся", async () => {
    novel();
    src.muSeries[555] = { status: "12 Volumes (Ongoing)" };
    await turnOn();
    await run(NIGHT);
    expect(rows()[0]).toMatchObject({ rh_id: null, ru_vol: 0, ru_ch: 0, told_vol: 0, chk_fail: 0 }); // искала, на RanobeHub нет: по-русски нет (а не «не смотрела»)
    expect(rows()[0].rh_map_at).toBe(NIGHT);
    const n = src.count("ranobehub.org");
    await run(day(18, 3, 40));
    await run(day(20, 3, 40));
    expect(src.count("ranobehub.org")).toBe(n); // меньше недели: не ищем
    await run(day(24, 3, 40));
    expect(src.count("ranobehub.org")).toBeGreaterThan(n);
    // сайт не отвечает: метку не ставим, на следующую ночь пробуем снова
    w.d1.sqlite.prepare("UPDATE reading SET rh_map_at = NULL, checked_at = NULL").run();
    src.rh["Ken to Kage"] = null;
    src.rh["Меч и тень"] = null;
    const before = src.count("ranobehub.org");
    await run(day(25, 3, 40));
    expect(rows()[0]).toMatchObject({ rh_map_at: null, chk_fail: 0 });
    expect(src.count("ranobehub.org")).toBeGreaterThan(before);
  });

  it("запросов за ночь немного: у ранобэ с RanobeHub не больше трёх обращений к источникам на тайтл", async () => {
    novel({ rh_id: 77, rh_map_at: MON, ru_vol: 8 });
    src.muSeries[555] = { status: "12 Volumes (Ongoing)" };
    src.rh["Ken to Kage"] = [rhBook(77, "Меч и тень", "Ken to Kage", 8, 70)];
    await turnOn();
    await run(NIGHT, 20);
    expect(src.calls.length).toBeLessThanOrEqual(3); // MangaUpdates (том) + RanobeHub (одна выдача); Shikimori и аниме у свежепроверенных не спрашиваем
    expect(src.count("ranobehub.org")).toBe(1);
  });
});

describe("чтение: настройки в «⋯ Ещё»", () => {
  let seq = 0;
  async function call(i: Partial<Interaction>): Promise<{ type: number; data?: any }> {
    return (await handleInteraction(
      { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user: { id: OWNER } }, type: 3, message: { id: "m1" }, ...i } as Interaction,
      { repo: w.repo(), api: w.discord, now: MON, env: {}, defer: () => {}, fetchFn: src.fetch },
    )) as { type: number; data?: any };
  }
  const buttons = (m: { components?: any[] }): string[] => (m.components ?? []).flatMap((r: any) => r.components.map((c: any) => c.custom_id as string));

  it("кнопка «Чтение: сб 11:00» спрятана в «Ещё» (в ряду не больше пяти), текст объясняет, как спросить список", () => {
    const m = sectionMessage(readSettings([]), "a", MON, false);
    expect(buttons(m)).toContain("mn:md:rd:a");
    expect(m.content).toContain("Чтение (манга и ранобэ): суббота 11:00");
    expect(m.content).toContain("что я читаю");
    for (const r of m.components ?? []) expect(r.components.length).toBeLessThanOrEqual(5);
    const label = (m.components ?? []).flatMap((r: any) => r.components).find((c: any) => c.custom_id === "mn:md:rd:a");
    expect(label.label).toBe("Чтение: сб 11:00");
  });

  it("окно открывается, ввод «воскресенье 18:00» и «выкл» записывается, ошибка — подсказка", async () => {
    const open = await call({ data: { custom_id: "mn:md:rd:a" } });
    expect(open.type).toBe(9);
    expect(open.data.custom_id).toBe("m_read:mn:a");
    const submit = (when: string) => call({ type: 5, data: { custom_id: "m_read:mn:a", components: [{ type: 18, component: { type: 4, custom_id: "when", value: when } }] } });
    await submit("воскресенье 18:00");
    expect((await w.settings()).reading).toEqual({ dow: 7, at: 18 * 60 });
    await submit("выкл");
    expect((await w.settings()).reading).toBeNull();
    const bad = await submit("когда-нибудь");
    expect(JSON.stringify(bad)).toContain("суббота 11:00");
    expect((await w.settings()).reading).toBeNull(); // не изменилось
  });
});
