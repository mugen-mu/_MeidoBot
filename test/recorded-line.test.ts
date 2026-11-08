// «Записано …»: короткая реплика Хару карточкой и две кнопки (решение пользователя 2026-11-08); на серьёзных темах — без реплики.
import { beforeEach, describe, expect, it } from "vitest";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { PHRASES } from "../src/personality/phrases.ts";
import { NOW } from "./helpers.ts";
import { OWNER, World } from "./world.ts";

let w: World;
const pending: Promise<unknown>[] = [];
async function remind(text: string, channel = "c1"): Promise<any> {
  const r = await handleInteraction(
    { id: "1", token: "t", application_id: "a", guild_id: "g", channel_id: channel, member: { user: { id: OWNER } }, type: 2, data: { name: "remind", type: 1, options: [{ name: "text", value: text }] } } as Interaction,
    { repo: w.repo(100), api: w.discord, now: NOW, env: { origin: "https://meido.example.workers.dev" }, rand: () => 0, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r;
}
const ids = (r: any): string[] => (r.data.components ?? []).flatMap((x: any) => x.components.map((c: any) => c.custom_id));

beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { mood_on: "1", character: "maid" } });
});

describe("подтверждение записи", () => {
  it("у каждого из шести настроений есть фразы «записано»", () => {
    for (const mood of ["tired", "tsundere", "yandere", "sulking", "proud", "sleepy"]) expect(PHRASES[mood].recorded?.length).toBeGreaterThanOrEqual(4);
  });

  it("настроение включено: реплика в карточке, суть обычным текстом, кнопки только «Изменить» и «Отменить»", async () => {
    const r = await remind("завтра в 10 купить хлеб");
    expect(r.data.content).toContain("Записано: **Купить хлеб** — завтра, 10:00");
    expect(r.data.embeds).toHaveLength(1);
    expect(String(r.data.embeds[0].description).length).toBeGreaterThan(5);
    expect(ids(r).map((i) => i.split(":")[0])).toEqual(["edit", "rm"]);
  });

  it("серьёзная тема (врач, невролог): без реплики, суть та же", async () => {
    const r = await remind("в понедельник в 11 записать ребёнка к неврологу");
    expect(r.data.content).toContain("Записано: **Записать ребёнка к неврологу**");
    expect(r.data.embeds).toBeUndefined();
  });

  it("настроение выключено: без реплики", async () => {
    await w.repo().exec([(await import("../src/db/repo.ts")).setSetting("mood_on", "0")]);
    const r = await remind("завтра в 10 купить хлеб");
    expect(r.data.embeds).toBeUndefined();
    expect(ids(r).map((i) => i.split(":")[0])).toEqual(["edit", "rm"]);
  });
});
