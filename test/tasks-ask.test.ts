// Вопросы про свои дела обычным текстом (решение 2026-11-11: панели «Горит» нет, спрашиваю текстом):
// «что у меня горит», «какие у меня дела», «что на сегодня», «что на неделю» — список, а не новое дело.
import { beforeEach, describe, expect, it } from "vitest";
import { parseTasksQuestion } from "../src/tasksAsk.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

describe("parseTasksQuestion: что спрашивают", () => {
  it.each([
    ["что у меня горит", "hot"],
    ["Что горит?", "hot"],
    ["что там висит", "hot"],
    ["что просрочено", "hot"],
    ["Хару, что у меня горит?", "hot"],
    ["что сегодня горит", "hot"],
    ["какие у меня дела", "all"],
    ["дела", "all"],
    ["покажи дела", "all"],
    ["список дел", "all"],
    ["мои дела", "all"],
    ["все дела", "all"],
    ["что у меня", "all"],
    ["что там у меня?", "all"],
    ["что на сегодня", "today"],
    ["дела на сегодня", "today"],
    ["что сегодня", "today"],
    ["что у меня сегодня", "today"],
    ["что на неделю", "week"],
    ["планы на неделю", "week"],
    ["что на завтра", "week"],
    ["какие дела на завтра?", "week"],
  ])("«%s» → %s", (text, kind) => {
    expect(parseTasksQuestion(text)).toBe(kind);
  });

  it.each([
    "как дела",
    "купить хлеб",
    "сегодня",
    "завтра в 10 купить хлеб",
    "что купить",
    "позвонить маме завтра",
    "что-то про дела надо сделать",
    "дела по работе",
    "план отпуска",
    "горит свет",
    "что у меня в 18:00",
    "",
    "   ",
  ])("«%s» — не вопрос, это обычное дело", (text) => {
    expect(parseTasksQuestion(text)).toBeNull();
  });
});

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  await w.run(NOW); // первый запуск запоминает конец канала
});

const items = () => w.d1.q("SELECT 1 FROM items").length;
const answers = () => w.discord.live(CH_BOT);

describe("cron: вопрос про дела в канале приёма", () => {
  it("«что у меня горит» → список того, что висит; новое дело не заводится; под ответом «Это было дело»", async () => {
    await w.create("через 5 минут позвонить", NOW);
    await w.run(NOW + 5 * MINUTE); // сработало: ждёт «Готово»
    const before = items();
    w.discord.say(CH_BOT, OWNER, "что у меня горит");
    const r = await w.run(NOW + 6 * MINUTE);
    expect(r.intake).toBe(1);
    expect(items()).toBe(before);
    const reply = answers()[0];
    expect(reply.body.content).toContain("Висит");
    expect(reply.body.content).toContain("Позвонить");
    expect(reply.body.components?.[0].components[0].custom_id).toBe("ldo:что у меня горит");
  });

  it("«что горит», когда ничего не висит → «Ничего не висит»", async () => {
    w.discord.say(CH_BOT, OWNER, "что горит");
    await w.run(NOW + MINUTE);
    expect(answers()[0].body.content).toContain("Ничего не висит");
  });

  it("«какие у меня дела» → все открытые дела", async () => {
    await w.create("завтра в 10 купить хлеб", NOW);
    await w.create("через 3 часа проверить почту", NOW);
    w.discord.say(CH_BOT, OWNER, "какие у меня дела");
    await w.run(NOW + MINUTE);
    const text = answers()[0].body.content as string;
    expect(text).toContain("Открытые дела (2)");
    expect(text).toContain("Купить хлеб");
    expect(text).toContain("Проверить почту");
    expect(items()).toBe(2);
  });

  it("«что на сегодня» → висящее и сегодняшнее по времени; завтрашнее не попадает", async () => {
    await w.create("через 3 часа проверить почту", NOW);
    await w.create("завтра в 10 купить хлеб", NOW);
    w.discord.say(CH_BOT, OWNER, "что на сегодня");
    await w.run(NOW + MINUTE);
    const text = answers()[0].body.content as string;
    expect(text).toContain("Сегодня");
    expect(text).toContain("15:00 Проверить почту");
    expect(text).not.toContain("Купить хлеб");
  });

  it("«что на неделю» → ближайшие 7 дней", async () => {
    await w.create("завтра в 10 купить хлеб", NOW);
    w.discord.say(CH_BOT, OWNER, "что на неделю");
    await w.run(NOW + MINUTE);
    const text = answers()[0].body.content as string;
    expect(text).toContain("Ближайшие 7 дней");
    expect(text).toContain("Купить хлеб");
  });

  it("обычное дело и «как дела» вопросом про дела не считаются", async () => {
    w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб");
    await w.run(NOW + MINUTE);
    expect(items()).toBe(1);
    expect(answers()[0].body.content).toContain("Записано");
    w.discord.say(CH_BOT, OWNER, "как дела");
    await w.run(NOW + 2 * MINUTE);
    expect(answers().some((p) => p.body.content?.includes("Открытые дела"))).toBe(false);
  });

  it("то же работает в личке после включения «Личка»", async () => {
    const DM = `dm-${OWNER}`;
    await w.repo().exec([]);
    const { setMeta, setSetting } = await import("../src/db/repo.ts");
    await w.repo().exec([setMeta("dm_channel_id", DM), setSetting("ch_remind", DM), setSetting("ch_bot", DM), setSetting("intake", JSON.stringify([DM]))]);
    await w.run(NOW + MINUTE); // baseline для личного чата
    w.discord.say(DM, OWNER, "что у меня горит");
    await w.run(NOW + 2 * MINUTE);
    expect(w.discord.live(DM).some((p) => p.body.content?.includes("Ничего не висит"))).toBe(true);
  });
});
