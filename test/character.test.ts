import { beforeEach, describe, expect, it } from "vitest";
import { type Character, parseCharacter, tired } from "../src/flavor.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { doneMessage, listText, panelText, settingsMessage, summaryText, weekText, weeklyText } from "../src/discord/ui.ts";
import { readSettings } from "../src/settings.ts";
import { kyiv, NOW } from "./helpers.ts";
import { OWNER, World } from "./world.ts";

const TZ = "Europe/Kyiv";
const MAID: Character = "maid";

describe("характер: помощники", () => {
  it("значение настройки разбирается; всё непонятное — нейтральный", () => {
    expect(parseCharacter("maid")).toBe("maid");
    expect(parseCharacter("neutral")).toBe("neutral");
    expect(parseCharacter(undefined)).toBe("neutral");
    expect(parseCharacter("что-то")).toBe("neutral");
    expect(readSettings([]).character).toBe("neutral");
    expect(readSettings([{ key: "character", value: "maid" }]).character).toBe("maid");
  });

  it("нейтральный характер ничего не добавляет; горничная даёт непустую фразу, выбор зависит от seed", () => {
    expect(tired("neutral", "done", 1)).toBeNull();
    const a = tired("maid", "done", 0);
    const b = tired("maid", "done", 1);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(tired("maid", "done", 0)).toBe(a);
    expect(tired("maid", "done", 3)).toBe(a); // по кругу
  });
});

describe("характер: тексты", () => {
  it("нейтральные тексты не изменились (без параметра и с «neutral»)", () => {
    expect(listText([], NOW, TZ)).toBe("Открытых дел нет.");
    expect(listText([], NOW, TZ, "neutral")).toBe("Открытых дел нет.");
    expect(panelText([], NOW, TZ)).toBe("**Горит**\nГорящего нет.");
    expect(weekText([], NOW, TZ)).toBe("На ближайшие 7 дней дел нет.");
    expect(doneMessage("купить хлеб").content).toBe("Готово: купить хлеб");
  });

  it("горничная: пустые списки и «Готово» с усталой ноткой, суть сообщения сохранена", () => {
    expect(listText([], NOW, TZ, MAID)).toContain("Открытых дел нет");
    expect(listText([], NOW, TZ, MAID)).not.toBe("Открытых дел нет.");
    expect(panelText([], NOW, TZ, MAID)).toContain("Горящего нет");
    expect(weekText([], NOW, TZ, MAID)).toContain("дел нет");
    const d = doneMessage("купить хлеб", MAID, 2).content ?? "";
    expect(d.startsWith("Готово: купить хлеб")).toBe(true);
    expect(d.length).toBeGreaterThan("Готово: купить хлеб".length);
  });

  it("сводки: упоминание, заголовок и факты те же, добавляется только пара слов; итоги недели тоже", () => {
    const base = { items: [], now: kyiv(2026, 11, 8, 8, 0), tz: TZ, ownerId: OWNER };
    const plain = summaryText("morning", base);
    const maid = summaryText("morning", { ...base, character: MAID });
    expect(maid).not.toBe(plain);
    expect(maid).toContain(`<@${OWNER}>`);
    expect(maid).toContain("Сводка на сегодня.");
    const wPlain = weeklyText({ doneCount: 3, items: [], now: NOW, tz: TZ, ownerId: OWNER });
    const wMaid = weeklyText({ doneCount: 3, items: [], now: NOW, tz: TZ, ownerId: OWNER, character: MAID });
    expect(wMaid).not.toBe(wPlain);
    expect(wMaid).toContain("Закрыто за неделю: 3.");
  });

  it("окно настроек показывает характер и кнопку переключения", () => {
    const s = readSettings([]);
    const neutral = settingsMessage(s, NOW, false);
    expect(neutral.content).toContain("Характер: нейтральный");
    const maid = settingsMessage({ ...s, character: MAID }, NOW, false);
    expect(maid.content).toContain("Характер: уставшая горничная");
    const ids = (m: typeof neutral) => (m.components ?? []).flatMap((r: any) => r.components.map((c: any) => c.custom_id));
    expect(ids(neutral)).toContain("s_char");
  });

});

describe("характер: переключатель и действие в боте", () => {
  let w: World;
  let pending: Promise<unknown>[];
  let seq = 0;

  async function call(i: Partial<Interaction>): Promise<any> {
    const r = await handleInteraction(
      { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
      { repo: w.repo(), api: w.discord, now: NOW, env: {}, defer: (p) => void pending.push(p) },
    );
    await Promise.all(pending.splice(0));
    return r;
  }
  const click = (custom_id: string, values?: string[]) => call({ type: 3, data: { custom_id, values }, message: { id: "m1" } });
  const cmd = (name: string) => call({ type: 2, data: { name, type: 1, options: [] } });

  beforeEach(async () => {
    w = new World();
    pending = [];
    await w.seed({ today: true, intake: true });
  });

  it("по умолчанию нейтральный; кнопка переключает туда и обратно и сохраняет в базе", async () => {
    expect((await cmd("settings")).data.content).toContain("Характер: нейтральный");
    expect((await click("s_char")).data.content).toContain("Характер: уставшая горничная");
    expect((await w.settings()).character).toBe("maid");
    expect((await click("s_char")).data.content).toContain("Характер: нейтральный");
    expect((await w.settings()).character).toBe("neutral");
  });

  it("с характером «горничная» команды отвечают в новом тоне, с нейтральным — как раньше", async () => {
    expect((await cmd("list")).data.content).toBe("Открытых дел нет.");
    await click("s_char");
    const r = await cmd("list");
    expect(r.data.content).toContain("Открытых дел нет");
    expect(r.data.content).not.toBe("Открытых дел нет.");
  });

  it("кнопка «Готово» отвечает «Готово: …» и с характером", async () => {
    const created = await w.create("завтра в 10 купить хлеб");
    await click("s_char");
    const r = await click(`done:${created.occId}`);
    expect(String(r.data.content).startsWith("Готово: Купить хлеб")).toBe(true);
  });
});
