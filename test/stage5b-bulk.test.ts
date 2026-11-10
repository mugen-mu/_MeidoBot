// «отмени #15, #17, #19» текстом в канале «бот»: раньше бот завёл из этого новое дело (живая проверка 2026-11-10, вечер).
import { beforeEach, describe, expect, it } from "vitest";
import { parseNumberCommand } from "../src/bulk.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

describe("parseNumberCommand", () => {
  it.each([
    ["отмени #15, #17, #19, #20, #28", "cancel", [15, 17, 19, 20, 28]],
    ["Отмени #5", "cancel", [5]],
    ["отменить #5 #6", "cancel", [5, 6]],
    ["удали #7 и #8", "delete", [7, 8]],
    ["готово #3, #4", "done", [3, 4]],
    ["закрой #9", "done", [9]],
    ["бот, отмени #15,#17", "cancel", [15, 17]],
  ])("«%s»", (t, action, ids) => {
    expect(parseNumberCommand(t)).toEqual({ action, ids });
  });

  it.each([
    "отмени 15", // без решётки — может быть «отмени 15 минут»
    "отмени 15 минут таймер",
    "отмени встречу #5",
    "завтра отмени #5",
    "купить #5",
    "отмени",
    "",
    "отмени #1 #2 #3 #4 #5 #6 #7 #8 #9 #10 #11 #12 #13",
  ])("«%s» — не команда по номерам", (t) => {
    expect(parseNumberCommand(t)).toBeNull();
  });
});

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  await w.run(NOW);
});
const state = (id: number) => w.d1.q<{ state: string }>("SELECT o.state FROM occurrences o WHERE o.item_id = ? AND o.kind = 'main'", id)[0]?.state;

describe("cron: отмена и «готово» по номерам", () => {
  it("«отмени #1, #2, #9»: два дела отменены, нового дела не создано, про лишний номер сказано", async () => {
    const a = await w.create("завтра в 10 купить хлеб");
    const b = await w.create("завтра в 11 позвонить маме");
    w.discord.say(CH_BOT, OWNER, `отмени #${a.itemId}, #${b.itemId}, #99`);
    const r = await w.run(NOW + MINUTE);
    expect(r.intake).toBe(1);
    expect(state(a.itemId)).toBe("cancelled");
    expect(state(b.itemId)).toBe("cancelled");
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(2);
    const text = String(w.discord.live(CH_BOT)[0].body.content);
    expect(text).toContain("Отменено: 2");
    expect(text).toContain("Купить хлеб");
    expect(text).toContain("Позвонить маме");
    expect(text).toContain("Не нашла открытых дел: #99");
  });

  it("«готово #N» закрывает как «Готово»; «удали #N» — как удаление", async () => {
    const a = await w.create("завтра в 10 купить хлеб");
    const b = await w.create("завтра в 11 позвонить маме");
    w.discord.say(CH_BOT, OWNER, `готово #${a.itemId}`);
    await w.run(NOW + MINUTE);
    expect(state(a.itemId)).toBe("done");
    w.discord.say(CH_BOT, OWNER, `удали #${b.itemId}`, { at: NOW + 2 * MINUTE });
    await w.run(NOW + 2 * MINUTE);
    expect(state(b.itemId)).toBe("cancelled");
    expect(String(w.discord.live(CH_BOT).at(-1)!.body.content)).toContain("Удалено: 1");
  });

  it("чужой человек в канале ничего не отменяет", async () => {
    const a = await w.create("завтра в 10 купить хлеб");
    w.discord.say(CH_BOT, "555", `отмени #${a.itemId}`);
    await w.run(NOW + MINUTE);
    expect(state(a.itemId)).toBe("planned");
  });
});
