import { beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "../src/db/repo.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { nowLine, parseYasno, publishedFor, tomorrowDigest, usDate } from "../src/light.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

type Slot = [number, number, "Definite" | "NotPlanned"];
const day = (date: string, status: string, slots: Slot[]) => ({
  date: `${date}T00:00:00+02:00`,
  status,
  slots: slots.map(([start, end, type]) => ({ start, end, type })),
});
const G3: Slot[] = [[0, 390, "NotPlanned"], [390, 840, "Definite"], [840, 1020, "NotPlanned"], [1020, 1260, "Definite"], [1260, 1440, "NotPlanned"]];
const WAIT: Slot[] = [[0, 1440, "NotPlanned"]];
const T3: Slot[] = [[0, 300, "Definite"], [300, 1440, "NotPlanned"]];
const yasno = (tomorrowReady: boolean) => {
  const tmr = tomorrowReady ? day("2026-11-08", "ScheduleApplies", T3) : day("2026-11-08", "WaitingForSchedule", WAIT);
  return {
    "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: tmr },
    "3.2": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: tmr },
  };
};

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed();
});

const at = (h: number, mi: number) => kyiv(2026, 11, 7, h, mi);

describe("свет: «что сейчас» и «опубликован ли график»", () => {
  it("nowLine: внутри отключения, до следующего, после последнего, нет данных", () => {
    const data = parseYasno(yasno(false));
    expect(nowLine(at(7, 0), "3", data, "Europe/Kyiv")).toBe("Сейчас по графику света нет, включат около 14:00.");
    expect(nowLine(at(15, 0), "3", data, "Europe/Kyiv")).toBe("Сейчас по графику свет есть, ближайшее отключение в 17:00.");
    expect(nowLine(at(22, 0), "3", data, "Europe/Kyiv")).toBe("Сейчас по графику свет есть, сегодня отключений больше нет.");
    expect(nowLine(kyiv(2026, 11, 9, 7, 0), "3", data, "Europe/Kyiv")).toBeNull();
    expect(nowLine(at(7, 0), "9", data, "Europe/Kyiv")).toBeNull();
  });
  it("publishedFor: «завтра» опубликовано только когда статус ScheduleApplies и дата та", () => {
    expect(publishedFor("tomorrow", "3", parseYasno(yasno(false)), "2026-11-08")).toBe(false);
    expect(publishedFor("tomorrow", "3", parseYasno(yasno(true)), "2026-11-08")).toBe(true);
    expect(publishedFor("tomorrow", "3", parseYasno(yasno(true)), "2026-11-09")).toBe(false);
    expect(publishedFor("today", "9", parseYasno(yasno(true)), "2026-11-07")).toBe(false);
  });
});

describe("/light: просмотр графика", () => {
  async function light(opts: { now?: number } = {}) {
    const sent: { appId: string; body: { content?: string; flags?: number } }[] = [];
    const api = Object.assign(Object.create(w.discord), {
      editInteractionOriginal: async (appId: string, _t: string, body: { content?: string; flags?: number }) => void sent.push({ appId, body }),
    });
    const fetchFn = (async () => (w.light === null ? new Response("down", { status: 503 }) : Response.json(w.light))) as unknown as typeof fetch;
    const pending: Promise<unknown>[] = [];
    const r = (await handleInteraction(
      { id: "1", token: "t", application_id: "app", guild_id: "g", channel_id: "c", member: { user: { id: OWNER } }, type: 2, data: { name: "light", type: 1 } } as unknown as Interaction,
      { repo: w.repo(), api, now: opts.now ?? at(15, 0), env: {}, defer: (p) => void pending.push(p), fetchFn },
    )) as { type: number; data?: { content?: string; flags?: number } };
    await Promise.all(pending);
    return { r, sent };
  }

  it("группа не задана: подсказка, как включить", async () => {
    const { r } = await light();
    expect(r.data?.content).toContain("/settings");
    expect(r.data?.flags).toBe(64);
  });

  it("группа задана: ответ «только вам» после запроса — сегодня, сейчас, завтра", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = yasno(true);
    const { r, sent } = await light();
    expect(r.type).toBe(5);
    expect(r.data?.flags).toBe(64);
    const text = sent[0].body.content as string;
    expect(sent[0].body.flags).toBe(64);
    expect(text).toContain("Свет сегодня (группа 3): света не будет 06:30–14:00, 17:00–21:00.");
    expect(text).toContain("Сейчас по графику свет есть, ближайшее отключение в 17:00.");
    expect(text).toContain("Свет завтра (группа 3): света не будет 00:00–05:00.");
  });

  it("Yasno не отвечает: понятное сообщение", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = null;
    const { sent } = await light();
    expect(sent[0].body.content).toContain("Yasno не отвечает");
  });
});

describe("дайджест: график на завтра вышел позже вечерней сводки", () => {
  const tenPast = (h: number, mi: number) => kyiv(2026, 11, 7, h, mi);
  const posts = () => w.discord.posted.filter((p) => p.channel === CH_REMIND && (p.body.content ?? "").includes("Хозяин, "));

  it("20:00 — сводка «ещё не опубликован»; в 21:10 график вышел — одно сообщение с упоминанием, потом тишина", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = yasno(false);
    await w.run(tenPast(20, 0));
    expect(w.discord.posted.some((p) => (p.body.content ?? "").includes("график ещё не опубликован"))).toBe(true);
    await w.run(tenPast(20, 30)); // всё ещё нет
    expect(posts()).toHaveLength(0);
    w.light = yasno(true);
    await w.run(tenPast(21, 10));
    expect(posts()).toHaveLength(1);
    const m = posts()[0].body;
    expect(m.content).toBe(`<@${OWNER}> Хозяин, график отключений на завтра 11.08.2026 опубликован.\nСвета не будет 00:00–05:00.`);
    expect(m.allowed_mentions).toEqual({ users: [OWNER] });
    await w.run(tenPast(21, 20));
    await w.run(tenPast(23, 50));
    expect(posts()).toHaveLength(1);
  });

  it("график уже был в вечерней сводке: отдельного сообщения нет", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = yasno(true);
    await w.run(tenPast(20, 0));
    await w.run(tenPast(20, 10));
    await w.run(tenPast(21, 10));
    expect(posts()).toHaveLength(0);
  });

  it("сводки ещё не было (19:10): график не запрашивается", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = yasno(true);
    await w.run(tenPast(19, 10));
    expect(w.lightFetches).toBe(0);
    expect(posts()).toHaveLength(0);
  });

  it("группа не задана: график не запрашивается совсем", async () => {
    w.light = yasno(true);
    await w.run(tenPast(20, 0));
    await w.run(tenPast(21, 10));
    expect(w.lightFetches).toBe(0);
    expect(posts()).toHaveLength(0);
  });

  it("запрос к Yasno не чаще раза в 10 минут", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = yasno(false);
    await w.run(tenPast(20, 0));
    const before = w.lightFetches;
    for (let m = 1; m <= 9; m++) await w.run(tenPast(20, 0) + m * MINUTE);
    expect(w.lightFetches).toBe(before);
  });
});

describe("сообщение «график на завтра опубликован»: формулировки и формат", () => {
  it("американский формат даты месяц.день.год", () => {
    expect(usDate("2026-11-08")).toBe("11.08.2026");
    expect(usDate("2027-01-05")).toBe("01.05.2027");
  });
  it("четыре формулировки по дате; вторая строка — интервалы; обращение с большой буквы", () => {
    const data = parseYasno({
      "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "ScheduleApplies", [[210, 450, "Definite"], [840, 1080, "Definite"]]) },
    });
    const heads = new Set<string>();
    for (let d = 1; d <= 8; d++) {
      const iso = `2026-11-${String(d).padStart(2, "0")}`;
      const lines = tomorrowDigest("3.1", data, iso, "хозяин").split("\n");
      expect(lines[0].startsWith("Хозяин, ")).toBe(true);
      expect(lines[0]).toContain(usDate(iso));
      expect(lines[1]).toBe("Света не будет 03:30–07:30, 14:00–18:00.");
      heads.add(lines[0].replace(usDate(iso), "D"));
    }
    expect(heads.size).toBe(4);
  });
  it("без отключений и при разных подгруппах", () => {
    const none = parseYasno({ "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "ScheduleApplies", WAIT) } });
    expect(tomorrowDigest("3.1", none, "2026-11-08", "хозяин").split("\n")[1]).toBe("Отключений не будет.");
    const mixed = parseYasno({
      "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "ScheduleApplies", T3) },
      "3.2": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "ScheduleApplies", WAIT) },
    });
    const lines = tomorrowDigest("3", mixed, "2026-11-08", "хозяин").split("\n");
    expect(lines.slice(1)).toEqual(["Группа 3.1: света не будет 00:00–05:00.", "Группа 3.2: отключений не будет."]);
  });
});
