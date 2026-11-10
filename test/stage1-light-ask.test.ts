// Этап 1 «C-lite» ретроспективы 2: «дай график света» текстом в канале «бот» отвечает графиком, а не создаёт дело.
import { beforeEach, describe, expect, it } from "vitest";
import { isLightQuestion } from "../src/lightAsk.ts";
import { COMMANDS } from "../src/discord/commands.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

void COMMANDS;

describe("isLightQuestion: короткие вопросы про свет", () => {
  it.each([
    "дай график света",
    "Свет",
    "свет?",
    "что со светом",
    "что там со светом?",
    "покажи график света на завтра",
    "график света",
    "скажи, когда выключат свет",
    "Хару, дай график света пожалуйста",
    "какой сегодня график света",
    "свет есть?",
  ])("«%s» — вопрос про свет", (t) => {
    expect(isLightQuestion(t)).toBe(true);
  });

  it.each([
    "купить лампочку, свет",
    "свет в 18:00 проверить счётчик",
    "завтра в 10 оплатить свет",
    "оплатить свет",
    "позвонить насчёт света",
    "график работы",
    "напомни про свет через 20 минут",
    "дай график света на следующий вторник в 9:00 и ещё что-нибудь важное длинное",
    "",
    "   ",
    "в 19:30 свет",
    "светлана",
  ])("«%s» — не вопрос, это обычное дело", (t) => {
    expect(isLightQuestion(t)).toBe(false);
  });
});

type Slot = [number, number, "Definite" | "NotPlanned"];
const day = (date: string, status: string, slots: Slot[]) => ({
  date: `${date}T00:00:00+02:00`,
  status,
  slots: slots.map(([start, end, type]) => ({ start, end, type })),
});
const G3: Slot[] = [[0, 390, "NotPlanned"], [390, 840, "Definite"], [840, 1020, "NotPlanned"], [1020, 1260, "Definite"], [1260, 1440, "NotPlanned"]];
const WAIT: Slot[] = [[0, 1440, "NotPlanned"]];
const yasno = () => ({
  "3.1": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
  "3.2": { today: day("2026-11-07", "ScheduleApplies", G3), tomorrow: day("2026-11-08", "WaitingForSchedule", WAIT) },
});

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off", light: "3" } });
  w.light = yasno();
  await w.run(NOW); // первый запуск запоминает конец канала
});

describe("cron: свет текстом в канале «бот»", () => {
  it("«дай график света» → график вместо дела, кнопка «Это было дело», без вызова модели и без записи дела", async () => {
    w.discord.say(CH_BOT, OWNER, "дай график света");
    const r = await w.run(NOW + MINUTE);
    expect(r.intake).toBe(1);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    const msg = w.discord.live(CH_BOT)[0];
    expect(msg.body.content).toContain("Свет сегодня (группа 3)");
    expect(msg.body.content).toContain("06:30–14:00");
    const ids = (msg.body.components ?? []).flatMap((x) => x.components.map((c) => c.custom_id));
    expect(ids).toEqual(["ldo:дай график света"]);
  });

  it("Yasno не отвечает: честное сообщение, дела всё равно нет", async () => {
    w.light = null;
    w.discord.say(CH_BOT, OWNER, "что со светом");
    await w.run(NOW + MINUTE);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    expect(w.discord.live(CH_BOT)[0].body.content).toContain("Yasno не отвечает");
  });

  it("группа не задана: подсказка, где её задать, дела нет", async () => {
    w = new World();
    await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
    await w.run(NOW);
    w.discord.say(CH_BOT, OWNER, "свет");
    await w.run(NOW + MINUTE);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    expect(w.discord.live(CH_BOT)[0].body.content).toContain("Группа света не задана");
  });

  it("обычное дело со словом «свет» остаётся делом", async () => {
    w.discord.say(CH_BOT, OWNER, "завтра в 10 оплатить свет");
    await w.run(NOW + MINUTE);
    expect(w.d1.q("SELECT title FROM items")).toEqual([{ title: "Оплатить свет" }]);
    expect(w.lightFetches).toBe(0);
  });

  it("чужой человек в канале график не вызывает", async () => {
    w.discord.say(CH_BOT, "555", "дай график света");
    await w.run(NOW + MINUTE);
    expect(w.discord.live(CH_BOT)).toHaveLength(0);
  });
});

describe("кнопка «Это было дело»", () => {
  let seq = 0;
  async function click(custom_id: string) {
    const pending: Promise<unknown>[] = [];
    const r = await handleInteraction(
      { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: CH_BOT, member: { user: { id: OWNER } }, type: 3, data: { custom_id }, message: { id: "m1" } } as Interaction,
      { repo: w.repo(), api: w.discord, now: NOW, env: {}, defer: (p) => void pending.push(p) },
    );
    await Promise.all(pending);
    return r as { type: number; data?: any };
  }

  it("создаёт дело из исходной фразы (запись не теряется)", async () => {
    const r = await click("ldo:свет проверить завтра");
    expect(w.d1.q("SELECT title FROM items")).toHaveLength(1);
    expect(JSON.stringify(r.data)).toContain("Записано");
  });
});
