import { beforeEach, describe, expect, it } from "vitest";
import { fetchYasno, groupsFor, lightLines, normalizeGroup, parseYasno } from "../src/light.ts";
import { setSetting } from "../src/db/repo.ts";
import { kyiv } from "./helpers.ts";
import { World } from "./world.ts";

type Slot = [number, number, "Definite" | "NotPlanned"];
const day = (date: string, status: string, slots: Slot[]) => ({
  date: `${date}T00:00:00+02:00`,
  status,
  slots: slots.map(([start, end, type]) => ({ start, end, type })),
});
// График группы 3 на 07.11.2026 с сайта: 06:30–14:00 и 17:00–21:00 (форма данных Yasno).
const G3: Slot[] = [[0, 390, "NotPlanned"], [390, 840, "Definite"], [840, 1020, "NotPlanned"], [1020, 1260, "Definite"], [1260, 1440, "NotPlanned"]];
const WAIT: Slot[] = [[0, 1440, "NotPlanned"]];
const yasno = (tomorrow: { status: string; slots: Slot[] } = { status: "WaitingForSchedule", slots: WAIT }) => ({
  "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", tomorrow.status, tomorrow.slots) },
  "3.2": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", tomorrow.status, tomorrow.slots) },
  "4.1": { today: day("2026-11-07", "ScheduleApplies", [[390, 630, "Definite"]]), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
});

describe("график света: разбор и подписи", () => {
  it("слоты склеиваются, мусор пропускается, «Definite» = света не будет", () => {
    const data = parseYasno({
      ...yasno(),
      "5.1": { today: day("2026-11-07", "ScheduleApplies", [[600, 900, "Definite"], [900, 1050, "Definite"]]), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
      bad: { today: 1 },
    });
    expect(data["3.1"].today.off).toEqual([{ start: 390, end: 840 }, { start: 1020, end: 1260 }]);
    expect(data["5.1"].today.off).toEqual([{ start: 600, end: 1050 }]);
    expect("bad" in data).toBe(false);
    expect(parseYasno(null)).toEqual({});
  });

  it("группа «3» -> подгруппы 3.1 и 3.2; одинаковые графики — одна строка", () => {
    const data = parseYasno(yasno());
    expect(groupsFor("3", data)).toEqual(["3.1", "3.2"]);
    expect(groupsFor("3.2", data)).toEqual(["3.2"]);
    expect(lightLines("today", "3", data, "2026-11-07")).toEqual(["Свет сегодня (группа 3): света не будет 06:30–14:00, 17:00–21:00."]);
  });

  it("завтра ещё не опубликовано; опубликовано — показываем; нет отключений", () => {
    expect(lightLines("tomorrow", "3", parseYasno(yasno()), "2026-11-08")).toEqual(["Свет завтра (группа 3): график ещё не опубликован."]);
    const pub = parseYasno(yasno({ status: "ScheduleApplies", slots: [[0, 180, "Definite"], [180, 1440, "NotPlanned"]] }));
    expect(lightLines("tomorrow", "3", pub, "2026-11-08")[0]).toBe("Свет завтра (группа 3): света не будет 00:00–03:00.");
    const none = parseYasno(yasno({ status: "ScheduleApplies", slots: WAIT }));
    expect(lightLines("tomorrow", "3", none, "2026-11-08")[0]).toContain("отключений нет");
  });

  it("подгруппы с разными графиками: обе строки и подсказка выбрать свою", () => {
    const raw = yasno();
    raw["3.2"] = { today: day("2026-11-07", "ScheduleApplies", [[600, 660, "Definite"]]), tomorrow: raw["3.2"].tomorrow };
    const lines = lightLines("today", "3", parseYasno(raw), "2026-11-07");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("группа 3.1");
    expect(lines[1]).toContain("группа 3.2");
    expect(lines[2]).toContain("выберите свою");
    expect(lightLines("today", "3.2", parseYasno(raw), "2026-11-07")).toEqual(["Свет сегодня (группа 3.2): света не будет 10:00–11:00."]);
  });

  it("нет такой группы и устаревшая дата", () => {
    const data = parseYasno(yasno());
    expect(lightLines("today", "6", data, "2026-11-07")[0]).toContain("не найдена");
    expect(lightLines("today", "3", data, "2026-11-09")[0]).toContain("ещё не опубликован");
  });

  it("normalizeGroup", () => {
    expect([normalizeGroup("3"), normalizeGroup(" 3,1 "), normalizeGroup("6.2"), normalizeGroup("7"), normalizeGroup("3.3"), normalizeGroup("abc")]).toEqual(["3", "3.1", "6.2", null, null, null]);
  });

  it("fetchYasno: успех, не 200, сбой сети — null", async () => {
    const ok = (async () => Response.json(yasno())) as unknown as typeof fetch;
    expect(Object.keys((await fetchYasno(ok))!)).toEqual(["3.1", "3.2", "4.1"]);
    expect(await fetchYasno((async () => new Response("x", { status: 503 })) as unknown as typeof fetch)).toBeNull();
    expect(
      await fetchYasno((async () => {
        throw new Error("сеть");
      }) as unknown as typeof fetch),
    ).toBeNull();
    expect(await fetchYasno((async () => Response.json({})) as unknown as typeof fetch)).toBeNull();
  });
});

describe("график света в сводках", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: { weekly: "off" } });
    w.light = yasno();
  });
  const texts = () => w.discord.posted.map((p) => p.body.content ?? "");

  it("по умолчанию выключен: в сводке света нет, к Yasno не ходим", async () => {
    await w.run(kyiv(2026, 11, 7, 8, 0));
    expect(texts()[0]).toContain("Сводка на сегодня");
    expect(texts()[0]).not.toContain("Свет");
    expect(w.lightFetches).toBe(0);
  });

  it("утром — график на сегодня, вечером — на завтра; один запрос на сводку", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    const morning = await w.run(kyiv(2026, 11, 7, 8, 0));
    expect(texts()[0]).toContain("Свет сегодня (группа 3): света не будет 06:30–14:00, 17:00–21:00.");
    expect(w.lightFetches).toBe(1);
    expect(morning.subrequests).toBeLessThanOrEqual(50);
    await w.run(kyiv(2026, 11, 7, 20, 0));
    const evening = texts().find((t) => t.includes("Вечерняя сводка"))!;
    expect(evening).toContain("Свет завтра (группа 3): график ещё не опубликован.");
    expect(w.lightFetches).toBe(2);
  });

  it("Yasno не отвечает: сводка всё равно приходит, с пометкой", async () => {
    await w.repo().exec([setSetting("light", "3")]);
    w.light = null;
    await w.run(kyiv(2026, 11, 7, 8, 0));
    expect(texts()[0]).toContain("Сводка на сегодня");
    expect(texts()[0]).toContain("не удалось получить данные");
  });
});
