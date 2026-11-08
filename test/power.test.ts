import { beforeEach, describe, expect, it } from "vitest";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { COMMANDS } from "../src/discord/commands.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { checkSchedule, parseYasno } from "../src/light.ts";
import { BLINK_MS, applySignal, fmtOffTime, handlePower, readPower, safeEqual } from "../src/power.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const T0 = kyiv(2026, 11, 7, 17, 42); // «света нет с 17:42»

type Slot = [number, number, "Definite" | "NotPlanned"];
const day = (date: string, status: string, slots: Slot[]) => ({
  date: `${date}T00:00:00+02:00`,
  status,
  slots: slots.map(([start, end, type]) => ({ start, end, type })),
});
// группа 3 на 07.11.2026: 06:30–14:00 и 17:00–21:00
const G3: Slot[] = [[0, 390, "NotPlanned"], [390, 840, "Definite"], [840, 1020, "NotPlanned"], [1020, 1260, "Definite"], [1260, 1440, "NotPlanned"]];
const WAIT: Slot[] = [[0, 1440, "NotPlanned"]];
const yasno = () => ({
  "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
  "3.2": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
});

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed();
  await w.repo().exec([setMeta("power_key", KEY)]);
});

const req = (path: string, method = "GET") => new Request(`https://meido.example.workers.dev${path}`, { method });
async function signal(state: "on" | "off", now: number, key = KEY): Promise<Response> {
  return handlePower(req(`/power/${key}/${state}`), { repo: w.repo(), api: w.discord, now, ownerId: OWNER });
}
const remindPosts = () => w.discord.posted.filter((p) => p.channel === CH_REMIND);
const meta = async () => (await w.repo().loadConfig()).meta;

describe("свет: приём сигнала от телефона", () => {
  it("неверный ключ — 401, нет ключа в базе — 401, чужой путь — 404; ничего не меняется", async () => {
    expect((await signal("off", T0, "wrong")).status).toBe(401);
    expect((await signal("off", T0, KEY.slice(0, -1))).status).toBe(401);
    expect((await handlePower(req(`/power/${KEY}/maybe`), { repo: w.repo(), api: w.discord, now: T0, ownerId: OWNER })).status).toBe(404);
    expect((await handlePower(req(`/power/${KEY}`), { repo: w.repo(), api: w.discord, now: T0, ownerId: OWNER })).status).toBe(404);
    expect((await handlePower(req(`/power/${KEY}/off`, "DELETE"), { repo: w.repo(), api: w.discord, now: T0, ownerId: OWNER })).status).toBe(405);
    expect(readPower(await meta()).state).toBeNull();

    const fresh = new World();
    await fresh.seed();
    const r = await handlePower(req(`/power/${KEY}/off`), { repo: fresh.repo(), api: fresh.discord, now: T0, ownerId: OWNER });
    expect(r.status).toBe(401);
    expect(w.discord.posted).toHaveLength(0);
  });

  it("робот предпросмотра ссылок (Discordbot и т. п.) ничего не меняет", async () => {
    const r = await handlePower(new Request(`https://x.dev/power/${KEY}/off`, { headers: { "user-agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" } }), { repo: w.repo(), api: w.discord, now: T0, ownerId: OWNER });
    expect(r.status).toBe(403);
    expect(readPower(await meta()).state).toBeNull();
  });

  it("«пропал»: состояние записано, сообщение не сразу; через минуту cron пишет одно сообщение с упоминанием", async () => {
    expect((await signal("off", T0)).status).toBe(200);
    const p = readPower(await meta());
    expect([p.state, p.since, p.announced]).toEqual(["off", T0, false]);
    expect(remindPosts()).toHaveLength(0);

    await w.run(T0 + 30_000);
    expect(remindPosts()).toHaveLength(0); // моргание короче минуты не шумит

    await w.run(T0 + 2 * MINUTE);
    expect(remindPosts()).toHaveLength(1);
    const m = remindPosts()[0].body;
    expect(m.content).toBe(`<@${OWNER}> Света нет с 17:42`);
    expect(m.allowed_mentions).toEqual({ users: [OWNER] });

    await w.run(T0 + 3 * MINUTE);
    await w.run(T0 + 10 * MINUTE);
    expect(remindPosts()).toHaveLength(1); // не повторяется
    expect(readPower(await meta()).announced).toBe(true);
  });

  it("повторный «пропал» подряд игнорируется и не сдвигает время начала", async () => {
    await signal("off", T0);
    const r = await signal("off", T0 + 5 * MINUTE);
    expect(await r.text()).toBe("ignored");
    expect(readPower(await meta()).since).toBe(T0);
    await w.run(T0 + 6 * MINUTE);
    expect(remindPosts()).toHaveLength(1);
    expect(remindPosts()[0].body.content).toContain("с 17:42");
  });

  it("моргание: «появился» через 40 секунд — ни одного сообщения, состояние «свет есть»", async () => {
    await signal("off", T0);
    const r = await signal("on", T0 + 40_000);
    expect(await r.text()).toBe("blink");
    await w.run(T0 + 2 * MINUTE);
    expect(w.discord.posted).toHaveLength(0);
    expect(readPower(await meta()).state).toBe("on");
  });

  it("отключение дольше минуты, но cron ещё не успел объявить: «появился» всё равно сообщает о возвращении", async () => {
    await signal("off", T0);
    const r = await signal("on", T0 + 108_000);
    expect(await r.text()).toBe("restored");
    expect(remindPosts()).toHaveLength(1);
    expect(remindPosts()[0].body.content).toBe(`<@${OWNER}> Свет вернулся в 17:43, не было 2 мин`);
    await w.run(T0 + 3 * MINUTE);
    expect(remindPosts()).toHaveLength(1); // «света нет» уже не уйдёт: свет вернулся
  });

  it("«появился» после сообщения: «Свет вернулся в 18:05, не было 23 мин»", async () => {
    await signal("off", T0);
    await w.run(T0 + 2 * MINUTE);
    const r = await signal("on", T0 + 23 * MINUTE);
    expect(await r.text()).toBe("restored");
    expect(remindPosts()).toHaveLength(2);
    const m = remindPosts()[1].body;
    expect(m.content).toBe(`<@${OWNER}> Свет вернулся в 18:05, не было 23 мин`);
    expect(m.allowed_mentions).toEqual({ users: [OWNER] });
    // повторный «появился» молчит
    expect(await (await signal("on", T0 + 24 * MINUTE)).text()).toBe("ignored");
    expect(remindPosts()).toHaveLength(2);
  });

  it("длинное отключение: «не было 1 ч 35 мин»; новый «пропал» после возвращения снова объявляется", async () => {
    await signal("off", T0);
    await w.run(T0 + 2 * MINUTE);
    await signal("on", T0 + 95 * MINUTE);
    expect(remindPosts()[1].body.content).toContain("не было 1 ч 35 мин");
    const T1 = T0 + 3 * 60 * MINUTE;
    await signal("off", T1);
    await w.run(T1 + 2 * MINUTE);
    expect(remindPosts().filter((p) => /Свет/.test(p.body.content ?? "") && !(p.body.content ?? "").includes("сводка")).map((p) => (p.body.content ?? "").slice(`<@${OWNER}> `.length, `<@${OWNER}> `.length + 9))).toEqual(["Света нет", "Свет верн", "Света нет"]);
  });

  it("«появился» без «пропал» (телефон уже стоял на зарядке) — молча запоминается", async () => {
    expect(await (await signal("on", T0)).text()).toBe("ignored");
    expect(readPower(await meta()).state).toBe("on");
    expect(w.discord.posted).toHaveLength(0);
  });

  it("сообщение «света нет» идёт и в тихие часы, и в отъезде (это не напоминание дела)", async () => {
    await w.repo().exec([setSetting("quiet_enabled", "1"), setSetting("quiet_from", "00:00"), setSetting("quiet_to", "23:59"), setSetting("away_until", String(T0 + 100 * MINUTE))]);
    await signal("off", T0);
    await w.run(T0 + 2 * MINUTE);
    expect(remindPosts()).toHaveLength(1);
  });

  it("если отправка не удалась, сообщение повторится в следующую минуту", async () => {
    await signal("off", T0);
    w.discord.failPost = { status: 500, times: 1 };
    await w.run(T0 + 2 * MINUTE);
    expect(remindPosts()).toHaveLength(0);
    expect(readPower(await meta()).announced).toBe(false);
    await w.run(T0 + 3 * MINUTE);
    expect(remindPosts()).toHaveLength(1);
  });

  it("гонка: «появился» пришёл, пока cron отправлял — отметка «сообщили» не ставится при свете", async () => {
    await signal("off", T0);
    // cron прочитал состояние «нет света», а до записи пришёл «появился»
    await w.repo().exec(applySignal(readPower(await meta()), "on", T0 + 90_000).ops);
    await w.repo().exec([{ sql: "UPDATE meta SET value = '1' WHERE key = 'power_announced' AND EXISTS (SELECT 1 FROM meta WHERE key = 'power_state' AND value = 'off')", params: [] }]);
    expect(readPower(await meta()).announced).toBe(false);
  });
});

describe("свет: сверка с графиком Yasno", () => {
  it("группа задана, момент внутри слота: «по графику: да, 17:00–21:00»", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = yasno();
    await signal("off", T0);
    await w.run(T0 + 2 * MINUTE);
    expect(remindPosts()[0].body.content).toBe(`<@${OWNER}> Света нет с 17:42 (по графику: да, 17:00–21:00)`);
    expect(w.lightFetches).toBe(1);
  });

  it("вне графика: «по графику: нет»", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = yasno();
    const t = kyiv(2026, 11, 7, 15, 10);
    await signal("off", t);
    await w.run(t + 2 * MINUTE);
    expect(remindPosts()[0].body.content).toBe(`<@${OWNER}> Света нет с 15:10 (по графику: нет)`);
  });

  it("Yasno не отвечает: «график недоступен», сообщение всё равно уходит", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = null;
    await signal("off", T0);
    await w.run(T0 + 2 * MINUTE);
    expect(remindPosts()[0].body.content).toBe(`<@${OWNER}> Света нет с 17:42 (график недоступен)`);
  });

  it("группа не задана: график не запрашивается и в тексте его нет", async () => {
    w.light = yasno();
    await signal("off", T0);
    await w.run(T0 + 2 * MINUTE);
    expect(remindPosts()[0].body.content).toBe(`<@${OWNER}> Света нет с 17:42`);
    expect(w.lightFetches).toBe(0);
  });

  it("checkSchedule: допуск 15 минут до начала, конец не включается, чужая дата — «неизвестно», разные подгруппы — «mixed»", () => {
    const data = parseYasno(yasno());
    const at = (h: number, mi: number) => kyiv(2026, 11, 7, h, mi);
    expect(checkSchedule(at(16, 45), "3", data, "Europe/Kyiv").verdict).toBe("yes"); // 17:00 − 15 мин
    expect(checkSchedule(at(16, 44), "3", data, "Europe/Kyiv").verdict).toBe("no");
    expect(checkSchedule(at(20, 59), "3", data, "Europe/Kyiv").verdict).toBe("yes");
    expect(checkSchedule(at(21, 0), "3", data, "Europe/Kyiv").verdict).toBe("no");
    expect(checkSchedule(kyiv(2026, 11, 9, 18, 0), "3", data, "Europe/Kyiv").verdict).toBe("unknown");
    expect(checkSchedule(kyiv(2026, 11, 8, 18, 0), "3", data, "Europe/Kyiv").verdict).toBe("unknown"); // завтра ещё не опубликовано
    const mixed = parseYasno({
      "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
      "3.2": { today: day("2026-11-07", "ScheduleApplies", WAIT), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
    });
    expect(checkSchedule(at(18, 0), "3", mixed, "Europe/Kyiv").verdict).toBe("mixed");
    expect(checkSchedule(at(18, 0), "3.1", mixed, "Europe/Kyiv").verdict).toBe("yes");
    expect(checkSchedule(at(18, 0), "9", data, "Europe/Kyiv").verdict).toBe("unknown");
  });
});

describe("свет: мелочи", () => {
  it("длительность простыми словами", () => {
    expect(fmtOffTime(10_000)).toBe("1 мин");
    expect(fmtOffTime(23 * MINUTE)).toBe("23 мин");
    expect(fmtOffTime(60 * MINUTE)).toBe("1 ч");
    expect(fmtOffTime(95 * MINUTE)).toBe("1 ч 35 мин");
    expect(fmtOffTime(50 * 60 * MINUTE)).toBe("2 дн. 2 ч");
  });
  it("сравнение ключей и порог моргания", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(BLINK_MS).toBe(60_000);
  });
});

describe("свет: команда /power (ссылки только хозяину)", () => {
  async function power(opts: { user?: string; reset?: boolean; now?: number } = {}) {
    const options = opts.reset ? [{ name: "reset", value: true }] : [];
    return (await handleInteraction(
      { id: "1", token: "t", application_id: "app", guild_id: "g", channel_id: "c-other", member: { user: { id: opts.user ?? OWNER } }, type: 2, data: { name: "power", type: 1, options } } as unknown as Interaction,
      { repo: w.repo(), api: w.discord, now: opts.now ?? T0, env: { origin: "https://meido.example.workers.dev" }, defer: () => undefined },
    )) as { data: { content: string; flags?: number } };
  }

  it("создаёт ключ один раз, показывает две ссылки «только вам», /power повторно — тот же ключ", async () => {
    const fresh = new World();
    await fresh.seed();
    w = fresh; // ключа в базе ещё нет
    const a = await power();
    expect(a.data.flags).toBe(68); // только вам + без предпросмотра ссылок
    const key = (await meta()).get("power_key") as string;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(a.data.content).toContain(`https://meido.example.workers.dev/power/${key}/off`);
    expect(a.data.content).toContain(`https://meido.example.workers.dev/power/${key}/on`);
    const b = await power();
    expect((await meta()).get("power_key")).toBe(key);
    expect(b.data.content).toContain(key);
  });

  it("reset меняет ключ: старые ссылки перестают работать", async () => {
    const r = await power({ reset: true });
    const key = (await meta()).get("power_key") as string;
    expect(key).not.toBe(KEY);
    expect(r.data.content).toContain("Ключ заменён");
    expect((await signal("off", T0, KEY)).status).toBe(401);
    expect((await signal("off", T0, key)).status).toBe(200);
  });

  it("чужому пользователю ключ не показывается; в журнал событий ключ не попадает", async () => {
    const r = await power({ user: "555" });
    expect(r.data.content).toBe("Этот бот личный.");
    expect(r.data.content).not.toContain(KEY);
    await power();
    await signal("off", T0);
    await w.run(T0 + 2 * MINUTE);
    const rows = w.d1.q<{ detail: string | null }>("SELECT detail FROM events");
    expect(JSON.stringify(rows)).not.toContain(KEY);
    // сообщения бота в каналах тоже без ключа
    expect(JSON.stringify(w.discord.posted)).not.toContain(KEY);
  });

  it("показывает текущее состояние света", async () => {
    await signal("off", T0);
    const r = await power({ now: T0 + 5 * MINUTE });
    expect(r.data.content).toContain("света нет с");
  });

  it("/power убрана из подсказки Discord: ссылки — кнопка в ⚙ Настройки → Сводки и свет", () => {
    expect(COMMANDS.find((x) => x.name === "power")).toBeUndefined();
  });
});
