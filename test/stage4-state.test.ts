// Этап 4 ретроспективы 2: «Состояние» (паспорт источников), сообщения о сломанном источнике голосом Хару,
// «данные от вчера 20:00», закреплённый текст «если бот молчит», дела-сопровождение (копия базы, зависимости, модели, ключи).
// Тесты написаны до кода (план docs/PLAN-RETRO-2.md, этап 4). Сторожа healthchecks.io нет — решение владельца 2026-11-10.
import { beforeEach, describe, expect, it } from "vitest";
import { CHORES, choresDue } from "../src/chores.ts";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { PHRASES } from "../src/personality/phrases.ts";
import {
  BROKEN_FAILS,
  SILENT_BOT_TEXT,
  SOURCES,
  type Passport,
  isBroken,
  lightNoticeDue,
  parsePassport,
  recordSource,
  staleStamp,
  statusText,
  weekSourceLines,
} from "../src/sources.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { TEXTS, post } from "./waterFixtures.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const TZ = "Europe/Kyiv";
const T = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);
const DAY = 86_400_000;
const NOW = T(7, 12, 0); // суббота

// ---------- чистая часть ----------

describe("паспорт источников: запись чтений", () => {
  it("успех запоминает время и сбрасывает счётчик; неудача считает подряд и помнит, когда началось", () => {
    let p: Passport = {};
    p = recordSource(p, "water", false, NOW);
    p = recordSource(p, "water", false, NOW + 15 * MINUTE);
    expect(p.water).toMatchObject({ fails: 2, since: NOW, try: NOW + 15 * MINUTE });
    expect(p.water?.ok).toBeUndefined();
    expect(isBroken(p.water)).toBe(false);
    p = recordSource(p, "water", false, NOW + 30 * MINUTE);
    expect(BROKEN_FAILS).toBe(3);
    expect(isBroken(p.water)).toBe(true);
    p = recordSource(p, "water", true, NOW + 45 * MINUTE);
    expect(p.water).toMatchObject({ ok: NOW + 45 * MINUTE, try: NOW + 45 * MINUTE, fails: 0 });
    expect(p.water?.since).toBeUndefined();
    expect(isBroken(p.water)).toBe(false);
  });

  it("другие источники запись не трогает; прежний паспорт не меняется (чистая функция)", () => {
    const a: Passport = { gas: { ok: NOW, try: NOW, fails: 0 } };
    const b = recordSource(a, "light", false, NOW);
    expect(a.light).toBeUndefined();
    expect(b.gas).toEqual(a.gas);
  });

  it("разбор из базы: мусор и чужие поля не ломают", () => {
    expect(parsePassport(undefined)).toEqual({});
    expect(parsePassport("не json")).toEqual({});
    expect(parsePassport('{"water":{"ok":5,"try":6,"fails":2,"since":4,"x":1},"nope":{"ok":1},"gas":7}')).toEqual({ water: { ok: 5, try: 6, fails: 2, since: 4 } });
  });

  it("свет: сообщение о поломке — когда неудач не меньше трёх и прошло не меньше двух часов, один раз", () => {
    let p: Passport = {};
    for (let i = 0; i < 4; i++) p = recordSource(p, "light", false, NOW + i * 30 * MINUTE); // 0, 30, 60, 90 минут
    expect(lightNoticeDue(p.light, NOW + 90 * MINUTE)).toBe(false); // меньше двух часов
    p = recordSource(p, "light", false, NOW + 120 * MINUTE);
    expect(lightNoticeDue(p.light, NOW + 120 * MINUTE)).toBe(true);
    p = { ...p, light: { ...p.light!, said: 1 } };
    expect(lightNoticeDue(p.light, NOW + 180 * MINUTE)).toBe(false);
    p = recordSource(p, "light", true, NOW + 200 * MINUTE);
    expect(p.light?.said).toBeUndefined();
  });
});

describe("пометка «данные от …»", () => {
  it("сегодня, вчера и дальше датой (месяц.день.год)", () => {
    expect(staleStamp(T(7, 8, 0), T(7, 12, 0), TZ)).toBe("данные от сегодня 08:00");
    expect(staleStamp(T(6, 20, 0), T(7, 12, 0), TZ)).toBe("данные от вчера 20:00");
    expect(staleStamp(T(1, 9, 5), T(7, 12, 0), TZ)).toBe("данные от 11.01.2026 09:05");
  });
});

describe("экран «Состояние»", () => {
  const all = { light: true, water: true, gas: true };
  it("перечисляет все девять источников с названиями; прогноз погоды пока не подключён, дождь — отдельная строка", () => {
    expect(SOURCES.map((s) => s.id)).toEqual(["light", "ukrenergo", "water", "gas", "shikimori", "anilibria", "animetg", "weather", "rain"]);
    const t = statusText({}, all, NOW, TZ);
    for (const s of SOURCES) expect(t, s.id).toContain(s.name);
    expect(t).toMatch(/Погода[^\n]*пока не подключена/);
  });

  it("выключенный источник назван выключенным, не читавшийся — «ещё не читалось»", () => {
    const t = statusText({}, { light: false, water: true, gas: false }, NOW, TZ);
    expect(t).toMatch(/Свет[^\n]*выключен/);
    expect(t).toMatch(/Газ[^\n]*выключен/);
    expect(t).toMatch(/Вода[^\n]*ещё не читалось/);
  });

  it("исправный: когда читалось и «всё в порядке»; сломанный: с какого времени, сколько раз и когда был последний успех", () => {
    let p: Passport = recordSource({}, "light", true, T(7, 8, 0));
    for (let i = 0; i < 4; i++) p = recordSource(p, "water", false, T(6, 20, 0) + i * 15 * MINUTE);
    p = recordSource(p, "gas", true, T(5, 10, 0));
    p = recordSource(p, "gas", false, T(6, 10, 0));
    const t = statusText(p, all, NOW, TZ);
    expect(t).toMatch(/Свет[^\n]*сегодня 08:00[^\n]*всё в порядке/);
    expect(t).toMatch(/Вода[^\n]*не отвечает с вчера 20:00/);
    expect(t).toMatch(/Вода[^\n]*4/);
    expect(t).toMatch(/Газ[^\n]*сбой/); // один сбой — ещё не «не отвечает»
    expect(t).not.toMatch(/Газ[^\n]*не отвечает/);
  });
});

describe("итог недели: сломанные источники", () => {
  it("пусто, когда всё в порядке; строка на каждый сломанный", () => {
    expect(weekSourceLines({}, NOW, TZ, { light: true, water: true, gas: true })).toEqual([]);
    let p: Passport = {};
    for (let i = 0; i < 3; i++) p = recordSource(p, "water", false, T(5, 12, 0) + i * 15 * MINUTE);
    p = recordSource(p, "gas", false, NOW);
    const lines = weekSourceLines(p, NOW, TZ, { light: true, water: true, gas: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Вода");
    expect(lines[0]).toContain("11.05.2026");
  });

  it("выключенный источник в итог не попадает", () => {
    let p: Passport = {};
    for (let i = 0; i < 3; i++) p = recordSource(p, "water", false, NOW + i * MINUTE);
    expect(weekSourceLines(p, NOW + 10 * MINUTE, TZ, { water: false })).toEqual([]);
  });
});

describe("фразы Хару про источники", () => {
  it("у каждого из пяти настроений есть строки «источник замолчал» и «всё ещё молчит»", () => {
    for (const mood of ["tired", "tsundere", "sulking", "proud", "sleepy"]) {
      expect((PHRASES[mood]?.source_down ?? []).length, `${mood}.source_down`).toBeGreaterThanOrEqual(3);
      expect((PHRASES[mood]?.source_week ?? []).length, `${mood}.source_week`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("закреплённый текст «если бот молчит»", () => {
  it("короткий, по шагам, без секретов и ссылок на рабочее", () => {
    expect(SILENT_BOT_TEXT.length).toBeLessThan(1800);
    expect(SILENT_BOT_TEXT).toContain("Если бот молчит");
    expect(SILENT_BOT_TEXT).toContain("npm run status");
    expect(SILENT_BOT_TEXT).toContain("Состояние");
    expect(SILENT_BOT_TEXT).not.toMatch(/b-eng-s|token=|[A-Za-z0-9_-]{40,}/);
  });
});

describe("дела-сопровождение: расписание", () => {
  const due = (now: number, recorded: Record<string, string> = {}) => choresDue(now, TZ, (k) => recorded[k]).map((c) => c.id);

  it("четыре дела: копия базы — ежемесячно, зависимости и модели — раз в квартал, ключи — раз в год", () => {
    expect(CHORES.map((c) => c.id)).toEqual(["backup", "deps", "models", "keys"]);
    for (const c of CHORES) {
      expect(c.title.length).toBeGreaterThan(5);
      expect(c.body.length).toBeGreaterThan(20);
    }
  });

  it("ноябрь: только копия (с 1-го числа); записанный период второй раз не заводится", () => {
    expect(due(T(7, 12))).toEqual(["backup"]);
    expect(due(T(7, 12), { "chore:backup": "2026-11" })).toEqual([]);
    expect(due(T(1, 12), {})).toEqual(["backup"]);
    expect(due(T(1, 12), { "chore:backup": "2026-10" })).toEqual(["backup"]);
  });

  it("квартал: зависимости с 8-го, модели с 15-го января, апреля, июля, октября; ключи — с 22 января", () => {
    const oct = (d: number) => kyiv(2026, 10, d, 12, 0);
    expect(due(oct(7), { "chore:backup": "2026-10" })).toEqual([]);
    expect(due(oct(8), { "chore:backup": "2026-10" })).toEqual(["deps"]);
    expect(due(oct(15), { "chore:backup": "2026-10", "chore:deps": "2026-10" })).toEqual(["models"]);
    const jan = (d: number) => kyiv(2027, 1, d, 12, 0);
    const done = { "chore:backup": "2027-01", "chore:deps": "2027-01", "chore:models": "2027-01" };
    expect(due(jan(21), done)).toEqual([]);
    expect(due(jan(22), done)).toEqual(["keys"]);
    expect(due(kyiv(2027, 2, 22, 12, 0), { ...done, "chore:backup": "2027-02" })).toEqual([]);
  });
});

// ---------- cron и кнопки ----------

let w: World;
const meta = (k: string) => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const passport = (): Passport => parsePassport(meta("src_passport"));
const remind = () => w.discord.posted.filter((p) => p.channel === CH_REMIND);
const texts = () => w.discord.posted.map((p) => p.body.content ?? "");
const feed = () => [post("Аварійні роботи", TEXTS.cancel, "2026-11-07T09:00:00", { id: 9001 })];

const type = (r: { type: number; data?: any }) => r;
async function call(i: Partial<Interaction>, now = NOW): Promise<{ type: number; data?: any }> {
  const pending: Promise<unknown>[] = [];
  const r = await handleInteraction(
    { id: String(Math.random()), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user: { id: OWNER } }, type: 3, message: { id: "m1" }, ...i } as Interaction,
    { repo: w.repo(100), api: w.discord, now, env: {}, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending);
  return type(r as { type: number; data?: any });
}
const click = (custom_id: string, now = NOW) => call({ data: { custom_id } }, now);
const ids = (r: { data?: any }): string[] => (r.data?.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.custom_id as string));

beforeEach(async () => {
  w = new World();
  w.water = feed();
  await w.seed({ today: true, intake: true, settings: { water: "чечелівськ", summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

describe("cron: паспорт заполняется сам", () => {
  it("вода: успешное чтение запоминается, три неудачи подряд — это уже «не отвечает»", async () => {
    await w.run(NOW);
    expect(passport().water).toMatchObject({ ok: NOW, fails: 0 });
    w.water = null;
    const at = NOW + 61 * MINUTE;
    await w.run(at);
    await w.run(at + 15 * MINUTE);
    await w.run(at + 30 * MINUTE);
    expect(passport().water).toMatchObject({ ok: NOW, fails: 3 });
    expect(isBroken(passport().water)).toBe(true);
  });

  it("запись паспорта не добавляет подзапросов: тот же запуск тратит столько же", async () => {
    const r1 = await w.run(NOW);
    const w2 = new World();
    w2.water = feed();
    await w2.seed({ today: true, intake: true, settings: { water: "чечелівськ", summary_morning: "off", summary_evening: "off", weekly: "off" } });
    const r2 = await w2.run(NOW);
    expect(r1.subrequests).toBe(r2.subrequests);
    expect(r1.subrequests).toBeLessThanOrEqual(11);
  });
});

describe("cron: сообщение о сломанной воде — голосом Хару", () => {
  it("с включённым характером: строка Хару, потом факты; одно сообщение", async () => {
    await w.seed({ today: true, settings: { mood_on: "1", character: "maid", style_level: "0", water: "чечелівськ", summary_morning: "off", summary_evening: "off", weekly: "off" } });
    w.water = null;
    for (const m of [0, 15, 30, 45, 60]) await w.run(NOW + m * MINUTE);
    const n = remind().filter((p) => p.body.content?.includes("Не могу прочитать"));
    expect(n).toHaveLength(1);
    const body = n[0].body.content!;
    const lines = body.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.at(-1)).toContain("Не могу прочитать");
    const pool = new Set(Object.values(PHRASES).flatMap((m) => m.source_down ?? []));
    expect(pool.has(lines[0]), lines[0]).toBe(true);
  });

  it("«тихий день»: только факты, без реплики Хару", async () => {
    await w.seed({ today: true, settings: { mood_on: "1", character: "maid", style_level: "0", water: "чечелівськ", summary_morning: "off", summary_evening: "off", weekly: "off" } });
    await w.repo().exec([setMeta("quiet_day_until", String(NOW + DAY))]);
    w.water = null;
    for (const m of [0, 15, 30, 45]) await w.run(NOW + m * MINUTE);
    const n = remind().filter((p) => p.body.content?.includes("Не могу прочитать"));
    expect(n).toHaveLength(1);
    expect(n[0].body.content!.startsWith("💧")).toBe(true);
  });
});

// ---------- свет ----------

type Slot = [number, number, "Definite" | "NotPlanned"];
const day = (date: string, status: string, slots: Slot[]) => ({ date: `${date}T00:00:00+02:00`, status, slots: slots.map(([start, end, type]) => ({ start, end, type })) });
const G3: Slot[] = [[0, 390, "NotPlanned"], [390, 840, "Definite"], [840, 1020, "NotPlanned"], [1020, 1260, "Definite"], [1260, 1440, "NotPlanned"]];
const yasno = (today: string, tomorrow: string) => ({
  "3.1": { today: day(today, "ScheduleApplies", G3), tomorrow: day(tomorrow, "ScheduleApplies", G3) },
  "3.2": { today: day(today, "ScheduleApplies", G3), tomorrow: day(tomorrow, "ScheduleApplies", G3) },
});

describe("cron: свет — «данные от вчера 20:00»", () => {
  beforeEach(async () => {
    await w.seed({ today: true, intake: true, settings: { light: "3", water: "off", summary_morning: "08:00", summary_evening: "20:00", weekly: "off" } });
  });

  it("вечером прочитали, утром Yasno молчит: показываем последнее известное с пометкой и честно говорим про сбой", async () => {
    w.light = yasno("2026-11-07", "2026-11-08");
    await w.run(T(7, 20, 0));
    w.light = null;
    await w.run(T(8, 8, 0));
    const morning = texts().find((t) => t.includes("Сводка на сегодня") && t.includes("📅")) ?? texts().filter((t) => t.includes("Сводка на сегодня")).at(-1)!;
    expect(morning).toContain("данные от вчера 20:00");
    expect(morning).toContain("света не будет 06:30–14:00, 17:00–21:00");
    expect(morning).toContain("Yasno не отвечает");
  });

  it("если читать было нечего — прежний честный текст без выдуманного графика", async () => {
    w.light = null;
    await w.run(T(7, 8, 0));
    const t = texts().find((x) => x.includes("Сводка на сегодня"))!;
    expect(t).toContain("не удалось получить данные");
    expect(t).not.toContain("данные от");
  });

  it("долгий сбой: одно сообщение «свет не читается» через два часа и больше нет; в итоге недели — строка про свет", async () => {
    w.light = null;
    for (const [h, m] of [[8, 0], [8, 31], [9, 2], [9, 33], [10, 5], [10, 34], [11, 5], [11, 40], [12, 40]]) await w.run(T(7, h, m));
    const notes = remind().filter((p) => p.body.content?.includes("не могу прочитать график света"));
    expect(notes).toHaveLength(1);
    expect(notes[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(isBroken(passport().light)).toBe(true);
  }, 30_000);
});

// ---------- итог недели ----------

describe("итог недели: строка про сломанный источник голосом Хару", () => {
  it("воскресный итог упоминает воду, пока она не отвечает; когда всё исправно — строки нет", async () => {
    await w.seed({ today: true, settings: { mood_on: "1", character: "maid", style_level: "0", water: "чечелівськ", summary_morning: "off", summary_evening: "off", weekly: "7@19:00" } });
    w.water = null;
    for (const m of [0, 15, 30, 45]) await w.run(T(7, 12, 0) + m * MINUTE);
    await w.run(T(8, 19, 5)); // воскресенье
    const weekly = texts().find((t) => t.includes("Итоги недели"))!;
    expect(weekly).toContain("Вода");
    expect(weekly).toContain("не отвечает");
    const w2 = new World();
    w2.water = feed();
    await w2.seed({ today: true, settings: { water: "чечелівськ", summary_morning: "off", summary_evening: "off", weekly: "7@19:00" } });
    await w2.run(T(7, 12, 0));
    await w2.run(T(8, 19, 5));
    const ok = w2.discord.posted.map((p) => p.body.content ?? "").find((t) => t.includes("Итоги недели"))!;
    expect(ok).not.toContain("не отвечает");
  });
});

// ---------- сводка: вода и газ «данные от …» ----------

describe("сводка: «Коммуналка» помечает устаревшее", () => {
  it("вода не отвечает: в вечерней сводке строка «данные от …»", async () => {
    await w.seed({ today: true, settings: { water: "чечелівськ", summary_morning: "off", summary_evening: "20:00", weekly: "off" } });
    await w.run(T(7, 9, 0)); // успешное чтение
    w.water = null;
    for (const m of [0, 15, 30, 45, 60]) await w.run(T(7, 19, 0) + m * MINUTE);
    const s = texts().find((t) => t.includes("Вечерняя сводка"))!;
    expect(s).toContain("Коммуналка");
    expect(s).toMatch(/Вода[^\n]*данные от сегодня 09:00/);
  });
});

// ---------- аниме ----------

describe("cron: аниме — паспорт для Shikimori", () => {
  const addWatching = () =>
    w.d1.sqlite.exec(
      `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, next_ep, next_at, aired_ep, aired_at, asked_ep, notify, added_at, updated_at, last_move_at)
       VALUES (10, 'Меч', 'watching', 3, 24, 'RELEASING', 5, ${T(14, 19)}, 4, ${T(5, 19)}, 4, 1, 0, 0, ${T(1, 12)})`,
    );
  it("ночное обновление удалось — «ok»; не удалось — неудача записана", async () => {
    addWatching();
    w.shikiCalendar = [{ next_episode: 5, next_episode_at: new Date(T(14, 19)).toISOString(), anime: { id: 10, russian: "Меч", name: "Ken", kind: "tv", status: "ongoing", episodes: 24, episodes_aired: 4, aired_on: "2026-10-08" } }];
    await w.run(T(8, 3, 5));
    expect(passport().shikimori).toMatchObject({ ok: T(8, 3, 5), fails: 0 });
    w.shikiCalendar = null;
    await w.run(T(9, 3, 5));
    expect(passport().shikimori).toMatchObject({ fails: 1 });
  });
});

// ---------- кнопки: «Ещё» → «Состояние», закреп ----------

describe("«Ещё» → «Состояние»", () => {
  it("в «Ещё» одна новая кнопка; экран показывает источники и ведёт назад", async () => {
    expect(ids(await click("mn:more"))).toContain("mn:ss");
    expect(ids(await click("pn:more"))).toContain("pn:ss");
    await w.run(NOW);
    const r = await click("mn:ss");
    const t = String(r.data.content);
    expect(t).toContain("Состояние");
    expect(t).toMatch(/Вода[^\n]*всё в порядке/);
    expect(t).toMatch(/Погода[^\n]*пока не подключена/);
    expect(ids(r)).toEqual(expect.arrayContaining(["mn:sq", "mn:more"]));
  });

  it("с панели экран приходит только вам, новым сообщением", async () => {
    const r = await click("pn:ss");
    expect(r.data.flags).toBe(64);
    expect(String(r.data.content)).toContain("Состояние");
  });

  it("«Закрепить текст»: пишет в канал «бот», закрепляет, повторное нажатие правит то же сообщение", async () => {
    const pins: string[] = [];
    w.discord.pinMessage = async (_ch: string, id: string) => void pins.push(id);
    const r = await click("mn:sq");
    const posted = w.discord.posted.filter((p) => p.channel === CH_BOT);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.content).toBe(SILENT_BOT_TEXT);
    expect(pins).toHaveLength(1);
    expect(String(r.data.content)).toMatch(/закреп/i);
    expect(meta("silent_msg_id")).toBeTruthy();
    await click("mn:sq");
    expect(w.discord.posted.filter((p) => p.channel === CH_BOT)).toHaveLength(1); // не дубль
    expect(pins).toHaveLength(1);
  });

  it("закрепить не вышло — текст всё равно в канале и подсказка «закрепите вручную»", async () => {
    w.discord.pinMessage = async () => {
      throw new Error("нет права");
    };
    const r = await click("mn:sq");
    expect(w.discord.posted.filter((p) => p.channel === CH_BOT)).toHaveLength(1);
    expect(String(r.data.content)).toMatch(/вручную/);
  });

  it("канала «бот» ещё нет — понятная подсказка, ничего не отправлено", async () => {
    const w3 = new World();
    await w3.seed({ intake: false });
    w = w3;
    const r = await click("mn:sq");
    expect(String(r.data.content)).toContain("/setup");
    expect(w.discord.posted).toHaveLength(0);
  });
});

// ---------- дела-сопровождение в cron ----------

describe("cron: дела-сопровождение заводятся сами", () => {
  beforeEach(async () => {
    await w.seed({ today: true, intake: true, settings: { chores: "1", water: "off", summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });
  const items = (title: string) => w.d1.q<{ id: number }>("SELECT id FROM items WHERE title = ?", title);
  const BACKUP = CHORES.find((c) => c.id === "backup")!.title;

  it("после 10:00 заводит «копию базы» на вечер того же дня; дальше в этот месяц — ничего", async () => {
    await w.run(T(7, 9, 55));
    expect(items(BACKUP)).toHaveLength(0); // рано
    await w.run(T(7, 10, 5));
    const it = items(BACKUP);
    expect(it).toHaveLength(1);
    const occ = w.d1.q<{ state: string; due_at: number; next_fire_at: number }>("SELECT * FROM occurrences WHERE item_id = ?", it[0].id)[0];
    expect(occ.state).toBe("planned");
    expect(occ.due_at).toBe(T(7, 18, 0));
    expect(meta("chore:backup")).toBe("2026-11");
    await w.run(T(7, 10, 6));
    await w.run(T(8, 10, 5));
    expect(items(BACKUP)).toHaveLength(1);
  });

  it("напоминает как обычное дело: в 18:00 приходит в «почту» и не исчезает без «Готово»", async () => {
    await w.run(T(7, 10, 5));
    await w.run(T(7, 18, 0));
    const m = remind().filter((p) => p.body.content?.includes(BACKUP));
    expect(m.length).toBeGreaterThanOrEqual(1);
  });

  it("предыдущее ещё не закрыто — новое в следующем месяце не копится, период всё равно помечен", async () => {
    await w.run(T(7, 10, 5));
    await w.run(kyiv(2026, 12, 1, 10, 5));
    expect(items(BACKUP)).toHaveLength(1);
    expect(meta("chore:backup")).toBe("2026-12");
  });

  it("предыдущее закрыто («Готово») — в следующем месяце заводится новое", async () => {
    await w.run(T(7, 10, 5));
    w.d1.sqlite.exec(`UPDATE occurrences SET state = 'done', closed_at = ${T(7, 18, 5)}, closed_reason = 'done', next_fire_at = NULL`);
    await w.run(kyiv(2026, 12, 1, 10, 5));
    expect(items(BACKUP)).toHaveLength(2);
  });

  it("в режиме «я в отъезде» не заводит; после возвращения — заведёт", async () => {
    await w.repo().exec([setSetting("away_until", String(T(9, 12, 0)))]);
    await w.run(T(7, 10, 5));
    expect(items(BACKUP)).toHaveLength(0);
    await w.run(T(9, 12, 5));
    await w.run(T(9, 12, 6));
    await w.run(T(10, 10, 5));
    expect(items(BACKUP)).toHaveLength(1);
  });

  it("в январе вместе с копией: зависимости и модели (с 8-го и 15-го), ключи — с 22-го", async () => {
    const run = (d: number) => w.run(kyiv(2027, 1, d, 10, 5));
    await run(8);
    await run(15);
    await run(22);
    for (const c of CHORES) expect(items(c.title), c.id).toHaveLength(1);
  });

  it("бюджет подзапросов: заведение дел укладывается в запас запуска", async () => {
    const r = await w.run(T(7, 10, 5));
    expect(r.subrequests).toBeLessThanOrEqual(15);
  });
});
