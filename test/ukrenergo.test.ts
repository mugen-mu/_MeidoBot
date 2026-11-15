// Укрэнерго (вариант B): разбор страницы ленты, что подходит, выдержка, первое чтение, cron и строка в сообщении «света нет».
import { beforeEach, describe, expect, it } from "vitest";
import { applySignal, readPower } from "../src/power.ts";
import { parsePassport, statusText } from "../src/sources.ts";
import { UKR_FRESH_FOR_OUTAGE, UKR_MAX_AGE, parseUkrenergo, parseUkrLast, parseUkrState, planUkrenergo, ukrAnnounceLine, ukrExcerpt, ukrKind } from "../src/ukrenergo.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";
import { ALL_HTML, EMERGENCY_HTML, NEWS_HTML, OTHER_REGION_HTML, PLANNED_HTML, REGION_HTML, ukrPage } from "./ukrFixtures.ts";

const TZ = "Europe/Kyiv";
const NOW = kyiv(2026, 11, 15, 12, 0);
const page = (...p: [number, number, string | null][]) => ukrPage(p.map(([id, at, html]) => ({ id, at, html })));

describe("Укрэнерго: разбор страницы", () => {
  it("посты с текстом: номер, время, ссылка; теги, невидимые знаки и «&#39;» убраны, <br> стал переводом строки; пост без текста пропущен", () => {
    const posts = parseUkrenergo(page([5700, NOW - 2 * HOUR, REGION_HTML], [5701, NOW - HOUR, null], [5702, NOW - 30 * MINUTE, NEWS_HTML]));
    expect(posts.map((p) => p.id)).toEqual([5700, 5702]);
    expect(posts[0].at).toBe(NOW - 2 * HOUR);
    expect(posts[0].link).toBe("https://t.me/Ukrenergo/5700");
    expect(posts[0].text).toContain("енергооб'єкти");
    expect(posts[0].text).not.toMatch(/[<>⁠]/);
    expect(posts[0].text.split("\n\n")).toHaveLength(3);
    expect(posts[0].text).toContain("• для промисловості");
  });

  it("мусор и пустая страница — пусто, не ошибка", () => {
    expect(parseUkrenergo("")).toEqual([]);
    expect(parseUkrenergo("<html>нет постов</html>")).toEqual([]);
    expect(parseUkrenergo('<div data-post="Ukrenergo/abc"></div>')).toEqual([]);
  });
});

describe("Укрэнерго: что подходит", () => {
  it.each([
    [EMERGENCY_HTML, "emergency"],
    [ALL_HTML, "emergency"],
    [REGION_HTML, "region"],
    [OTHER_REGION_HTML, null],
    [PLANNED_HTML, null],
    [NEWS_HTML, null],
  ])("%#: вид поста", (html, kind) => {
    const [p] = parseUkrenergo(page([1, NOW, html]));
    expect(ukrKind(p.text)).toBe(kind);
  });

  it("«аварийно-відновлювальні роботи» — не аварийные отключения; «Дніпровськ…» — не наша область", () => {
    expect(ukrKind("Аварійно-відновлювальні роботи тривають у Дніпропетровській області, відновлюємо електропостачання.")).toBe("region");
    expect(ukrKind("Аварійно-відновлювальні роботи тривають у Харківській області, відновлюємо електропостачання.")).toBeNull();
    expect(ukrKind("Дніпровська ГЕС працює у штатному режимі, відключень немає.")).toBeNull();
    expect(ukrKind("Знеструмлення в м. Дніпро та області: енергетики працюють.")).toBe("region");
  });

  it("выдержка: абзац про аварийные отключения у нас идёт первым, даже если в посте он последний (настоящий пост 11.11.2026 так и устроен)", () => {
    const long = `${"Дніпропетровщина: ситуація залишається складною, енергетики працюють. ".repeat(8)}\n\n❗️У Харківській та Дніпропетровській областях зранку застосовувалися графіки аварійних відключень.`;
    expect(ukrKind(long)).toBe("emergency");
    const ex = ukrExcerpt(long);
    expect(ex.startsWith("❗️У Харківській та Дніпропетровській областях зранку застосовувалися графіки аварійних відключень.")).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(451);
  });

  it("выдержка: абзацы про нашу область, а не шапка про соседей; длинная режется по концу предложения", () => {
    const [p] = parseUkrenergo(page([1, NOW, REGION_HTML]));
    const ex = ukrExcerpt(p.text);
    expect(ex).toContain("Дніпропетровській");
    expect(ex).not.toContain("•");
    const long = `${"Дніпропетровщина: знеструмлення триває. ".repeat(30)}`;
    const cut = ukrExcerpt(long);
    expect(cut.length).toBeLessThanOrEqual(451);
    expect(cut.endsWith(".")).toBe(true);
  });
});

describe("Укрэнерго: что делать с прочитанной лентой", () => {
  const posts = (...p: [number, number, string][]) => parseUkrenergo(page(...p));

  it("первое чтение молчит и запоминает последний пост; последний подходящий свежий — для строки «света нет»", () => {
    const r = planUkrenergo(null, posts([5700, NOW - HOUR, EMERGENCY_HTML], [5701, NOW - 10 * MINUTE, NEWS_HTML]), NOW, TZ, null);
    expect(r.notices).toEqual([]);
    expect(r.state).toEqual({ last: 5701 });
    expect(r.last?.id).toBe(5700);
    expect(r.last?.kind).toBe("emergency");
  });

  it("новый подходящий пост — одно сообщение; аварийный с упоминанием, про область — без; старое и чужое молчит", () => {
    const st = { last: 5700 };
    const r = planUkrenergo(st, posts([5700, NOW - 3 * HOUR, EMERGENCY_HTML], [5701, NOW - 40 * MINUTE, NEWS_HTML], [5702, NOW - 20 * MINUTE, EMERGENCY_HTML], [5703, NOW - 5 * MINUTE, REGION_HTML]), NOW, TZ, null);
    expect(r.notices).toHaveLength(2);
    expect(r.notices[0].mention).toBe(true);
    expect(r.notices[0].text).toContain("аварийные отключения");
    expect(r.notices[0].text).toContain("<https://t.me/Ukrenergo/5702>");
    expect(r.notices[1].mention).toBe(false);
    expect(r.notices[1].text).toContain("что с электроснабжением в области");
    expect(r.state).toEqual({ last: 5703 });
    const again = planUkrenergo(r.state, posts([5702, NOW - 20 * MINUTE, EMERGENCY_HTML], [5703, NOW - 5 * MINUTE, REGION_HTML]), NOW, TZ, r.last);
    expect(again.notices).toEqual([]);
  });

  it("не больше двух сообщений за раз (самые свежие) и ничего старше 12 часов", () => {
    const many = posts([5701, NOW - 4 * HOUR, REGION_HTML], [5702, NOW - 3 * HOUR, REGION_HTML], [5703, NOW - 2 * HOUR, REGION_HTML], [5704, NOW - UKR_MAX_AGE - HOUR, REGION_HTML]);
    const r = planUkrenergo({ last: 5600 }, many, NOW, TZ, null);
    expect(r.notices).toHaveLength(2);
    expect(r.notices[1].text).toContain("5703");
  });

  it("строка в «света нет»: свежий пост — есть, старше 6 часов — нет; сломанное значение — нет", () => {
    const [p] = parseUkrenergo(page([5702, NOW - 20 * MINUTE, EMERGENCY_HTML]));
    const raw = JSON.stringify({ id: p.id, at: p.at, kind: "emergency", text: ukrExcerpt(p.text), link: p.link });
    const line = ukrAnnounceLine(raw, NOW, TZ);
    expect(line).toContain("⚡ Укрэнерго, сегодня 11:40");
    expect(line).toContain("Дніпропетровській");
    expect(line).toContain("<https://t.me/Ukrenergo/5702>");
    expect(line).not.toContain("\n");
    expect(ukrAnnounceLine(raw, NOW + UKR_FRESH_FOR_OUTAGE + HOUR, TZ)).toBeNull();
    expect(ukrAnnounceLine("{не json", NOW, TZ)).toBeNull();
    expect(ukrAnnounceLine(undefined, NOW, TZ)).toBeNull();
    expect(parseUkrLast(JSON.stringify({ at: 1 }))).toBeNull();
    expect(parseUkrState("{}")).toBeNull();
  });
});

describe("Укрэнерго: cron", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    w.ukr = page([5700, NOW - 3 * HOUR, NEWS_HTML]);
    await w.seed({ settings: { light: "3", summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });
  const ukr = () => w.discord.posted.filter((p) => p.body.content?.includes("Укрэнерго"));
  const meta = async () => (await w.repo().loadConfig()).meta;

  it("группа света не задана — в сеть не ходим", async () => {
    await w.seed({ settings: { light: "off" } });
    await w.run(NOW);
    expect(w.ukrFetches).toBe(0);
  });

  it("первое чтение молчит; чтение раз в 10 минут; новый аварийный пост — одно сообщение с упоминанием, повтора нет", async () => {
    await w.run(NOW);
    expect(w.ukrFetches).toBe(1);
    expect(ukr()).toHaveLength(0);
    await w.run(NOW + 5 * MINUTE);
    expect(w.ukrFetches).toBe(1);
    w.ukr = page([5700, NOW - 3 * HOUR, NEWS_HTML], [5701, NOW + 8 * MINUTE, EMERGENCY_HTML]);
    await w.run(NOW + 10 * MINUTE);
    expect(w.ukrFetches).toBe(2);
    const m = ukr();
    expect(m).toHaveLength(1);
    expect(m[0].channel).toBe(CH_REMIND);
    expect(m[0].body.content).toContain(`<@${OWNER}>`);
    expect(m[0].body.content).toContain("аварийные отключения");
    expect(m[0].body.content).toContain("<https://t.me/Ukrenergo/5701>");
    expect(m[0].body.allowed_mentions).toEqual({ users: [OWNER] });
    await w.run(NOW + 20 * MINUTE);
    await w.run(NOW + 30 * MINUTE);
    expect(w.ukrFetches).toBe(4);
    expect(ukr()).toHaveLength(1);
  });

  it("пост про область без слов «аварийные отключения» приходит без упоминания", async () => {
    await w.run(NOW);
    w.ukr = page([5700, NOW - 3 * HOUR, NEWS_HTML], [5701, NOW + 5 * MINUTE, REGION_HTML]);
    await w.run(NOW + 10 * MINUTE);
    expect(ukr()).toHaveLength(1);
    expect(ukr()[0].body.content).not.toContain(`<@${OWNER}>`);
    expect(ukr()[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("Discord не принял сообщение — оно ждёт в очереди и уходит ровно один раз", async () => {
    await w.run(NOW);
    w.ukr = page([5700, NOW - 3 * HOUR, NEWS_HTML], [5701, NOW + 5 * MINUTE, EMERGENCY_HTML]);
    w.discord.failPost = { status: 500, times: 1 };
    await w.run(NOW + 10 * MINUTE);
    expect(ukr()).toHaveLength(0);
    await w.run(NOW + 11 * MINUTE);
    expect(ukr()).toHaveLength(1);
    await w.run(NOW + 12 * MINUTE);
    expect(ukr()).toHaveLength(1);
  });

  it("лента не отвечает: в чат ничего, на экране «Состояние» — «не отвечает» после трёх неудач", async () => {
    w.ukr = null;
    for (let i = 0; i < 3; i++) await w.run(NOW + i * 10 * MINUTE);
    expect(ukr()).toHaveLength(0);
    const text = statusText(parsePassport((await meta()).get("src_passport")), { ukrenergo: true }, NOW + 30 * MINUTE, TZ);
    expect(text).toMatch(/Укрэнерго[^\n]*не отвечает/);
  });

  it("свежий аварийный пост попадает в сообщение «Света нет»", async () => {
    w.ukr = page([5700, NOW - 3 * HOUR, NEWS_HTML], [5701, NOW - 20 * MINUTE, EMERGENCY_HTML]);
    await w.run(NOW); // первое чтение: молчит, но запоминает «последний подходящий»
    expect(ukr()).toHaveLength(0);
    await w.repo().exec(applySignal(readPower(await meta()), "off", NOW + MINUTE).ops);
    w.light = {};
    await w.run(NOW + 3 * MINUTE);
    const m = w.discord.posted.find((p) => p.body.content?.includes("Света нет с"));
    expect(m?.body.content).toContain("⚡ Укрэнерго, сегодня 11:40");
    expect(m?.body.content).toContain("<https://t.me/Ukrenergo/5701>");
    expect(m?.body.allowed_mentions).toEqual({ users: [OWNER] });
  });
});
