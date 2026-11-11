// «Личка» (решение 2026-11-11): напоминания, сводки и ввод дел — всё в личном чате с ботом; выключение возвращает каналы сервера.
import { beforeEach, describe, expect, it } from "vitest";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { dmAllOn } from "../src/settings.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const MINUTE = 60_000;
const DM = `dm-${OWNER}`;

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

async function call(i: Partial<Interaction>): Promise<{ type: number; data?: any }> {
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
    { repo: w.repo(), api: w.discord, now: NOW, env: {}, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r as { type: number; data?: any };
}
const toggle = () => call({ type: 3, data: { custom_id: "mn:tg:dm:a" }, message: { id: "m1" } });
const meta = async () => (await w.repo().loadConfig()).meta;

beforeEach(async () => {
  w = new World();
  pending = [];
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

describe("личка: включение и выключение", () => {
  it("включение: напоминания, «бот» и приём — в личку; прежние каналы запомнены", async () => {
    const r = await toggle();
    expect(r.data.content).toContain("Личка: вкл");
    const s = await w.settings();
    expect([s.chRemind, s.chBot]).toEqual([DM, DM]);
    expect(s.intake).toEqual([DM]);
    const m = await meta();
    expect(m.get("dm_channel_id")).toBe(DM);
    expect(dmAllOn(s, m)).toBe(true);
    expect(JSON.parse(m.get("dm_backup") as string)).toEqual({ remind: CH_REMIND, bot: CH_BOT, intake: [CH_BOT] });
  });

  it("выключение возвращает каналы сервера как были", async () => {
    await toggle();
    const r = await toggle();
    expect(r.data.content).toContain("Личка: выкл");
    const s = await w.settings();
    expect([s.chRemind, s.chBot]).toEqual([CH_REMIND, CH_BOT]);
    expect(s.intake).toEqual([CH_BOT]);
    const m = await meta();
    expect(m.get("dm_backup")).toBeUndefined();
    expect(dmAllOn(s, m)).toBe(false);
  });

  it("прежний режим «запись дел в личке» (личка в приёме, напоминания в канале) — это ещё не «Личка»", async () => {
    await w.repo().exec([setMeta("dm_channel_id", DM), setSetting("intake", JSON.stringify([CH_BOT, DM]))]);
    const s0 = await w.settings();
    expect(dmAllOn(s0, await meta())).toBe(false);
    expect((await toggle()).data.content).toContain("Личка: вкл");
    expect((await w.settings()).intake).toEqual([DM]);
    await toggle();
    const s = await w.settings();
    expect(s.intake).toEqual([CH_BOT, DM]); // прежнее состояние вернулось целиком
    expect(s.chRemind).toBe(CH_REMIND);
  });

  it("выключение без сохранённой копии не оставляет напоминания в личке: каналы пусты, нужен /setup", async () => {
    await toggle();
    await w.repo().exec([setMeta("dm_backup", "не json")]);
    await toggle();
    const s = await w.settings();
    expect(s.chRemind).toBeNull();
    expect(s.chBot).toBeNull();
    expect(s.intake).toEqual([]);
  });

  it("текст экрана «Ещё» говорит, куда идёт всё", async () => {
    const before = await call({ type: 3, data: { custom_id: "mn:s:a" }, message: { id: "m1" } });
    expect(before.data.content).toContain("Личка: выкл. Всё идёт в каналы сервера");
    const after = await toggle();
    expect(after.data.content).toContain("Личка: вкл. Напоминания, сводки и запись дел — всё здесь");
  });
});

describe("личка: как работает бот после включения", () => {
  it("напоминание приходит в личку, а не в канал", async () => {
    await toggle();
    await w.create("через 5 минут позвонить");
    await w.run(NOW + 5 * MINUTE);
    expect(w.discord.live(DM).some((p) => p.body.content?.includes("Позвонить"))).toBe(true);
    expect(w.discord.live(CH_REMIND)).toHaveLength(0);
  });

  it("текст из личного чата записывается делом и ответ приходит туда же; канал «бот» больше не читается", async () => {
    await toggle();
    await w.run(NOW);
    w.discord.say(DM, OWNER, "завтра в 10 купить хлеб");
    w.discord.say(CH_BOT, OWNER, "завтра в 11 из старого канала");
    const r = await w.run(NOW + MINUTE);
    expect(r.intake).toBe(1);
    expect(w.d1.q("SELECT title FROM items")).toEqual([{ title: "Купить хлеб" }]);
    expect(w.discord.live(DM).some((p) => p.body.content?.includes("Записано"))).toBe(true);
    expect(w.discord.live(CH_BOT)).toHaveLength(0);
  });

  it("ответы бота в личке видны сразу и остаются, а не «только вам»", async () => {
    const remind = { type: 2, data: { name: "remind", type: 1, options: [{ name: "text", value: "завтра в 10 купить хлеб" }] }, channel_id: DM, guild_id: undefined };
    const before = await call(remind);
    expect(before.data.flags).toBe(64);
    await toggle();
    const after = await call(remind);
    expect(after.data.flags).toBeUndefined();
  });
});
