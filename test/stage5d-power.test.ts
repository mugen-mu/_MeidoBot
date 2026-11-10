// Объявления про свет («Света нет с …», «Свет вернулся в …») с фразой Хару — просьба Ihor 2026-11-10.
// Факты (время, сколько не было) остаются; фраза идёт первой, без второй мелкой строки; тихий день и выключенный характер — прежний текст.
import { beforeEach, describe, expect, it } from "vitest";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { hasMasculineSelf } from "../src/personality/gender.ts";
import { MOODS } from "../src/personality/moodEngine.ts";
import { PHRASES } from "../src/personality/phrases.ts";
import { integrityProblems } from "../src/personality/poolCheck.ts";
import { POWER_PHRASES } from "../src/personality/phrases.stage5.ts";
import { QUIET_META_KEY } from "../src/personality/day.ts";
import { announceOutage, handlePower } from "../src/power.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const KEY = "0123456789abcdef0123456789abcdef";
const T0 = kyiv(2026, 11, 7, 22, 0);

describe("фразы про свет", () => {
  it("у каждого настроения (кроме яндере, она говорит как цундере) ≥5 фраз для «света нет» и «свет вернулся»; без мужского рода, цифр и времени", () => {
    expect(integrityProblems(POWER_PHRASES)).toEqual([]);
    for (const m of MOODS.filter((x) => x !== "yandere"))
      for (const sit of ["power_off", "power_on"] as const) {
        const list = POWER_PHRASES[m]?.[sit] ?? [];
        expect(list.length, `${m}.${sit}`).toBeGreaterThanOrEqual(5);
        for (const p of list) {
          expect(hasMasculineSelf(p), p).toBe(false);
          expect(p, p).not.toMatch(/\d/);
        }
      }
    expect(PHRASES.tired.power_on?.length).toBeGreaterThanOrEqual(5);
  });
});

let w: World;
const signal = (state: "on" | "off", now: number) =>
  handlePower(new Request(`https://meido.example.workers.dev/power/${KEY}/${state}`), { repo: w.repo(), api: w.discord, now, ownerId: OWNER });
const posts = () => w.discord.posted.filter((p) => p.channel === CH_REMIND).map((p) => String(p.body.content));

beforeEach(async () => {
  w = new World();
  await w.seed({ settings: { mood_on: "1", character: "maid" } });
  await w.repo().exec([setMeta("power_key", KEY)]);
});

describe("объявления: фраза + факты", () => {
  it("«Свет вернулся»: упоминание, фраза Хару, потом время и сколько не было; мелкой строки нет", async () => {
    await signal("off", T0);
    // чтобы возвращение не посчиталось морганием, сообщим «света нет» вручную
    await announceOutage({ repo: w.repo(), api: w.discord, now: T0 + 3 * MINUTE, ownerId: OWNER, meta: (await w.repo().loadConfig()).meta, s: await w.settings(), spend: () => undefined, fetchFn: (async () => new Response("down", { status: 503 })) as typeof fetch });
    await signal("on", T0 + 20 * MINUTE);
    const p = posts();
    expect(p).toHaveLength(2);
    expect(p[1]).toMatch(new RegExp(`^<@${OWNER}> .{6,}? Свет вернулся в 22:20, не было 20 мин$`));
    expect(p[1]).not.toContain("\n-# ");
    expect(p[0]).toMatch(new RegExp(`^<@${OWNER}> .{6,}? Света нет с 22:00`));
  });

  it("тихий день: только факты, как раньше", async () => {
    await w.repo().exec([setMeta(QUIET_META_KEY, String(T0 + 24 * 60 * MINUTE))]);
    await signal("off", T0);
    await announceOutage({ repo: w.repo(), api: w.discord, now: T0 + 3 * MINUTE, ownerId: OWNER, meta: (await w.repo().loadConfig()).meta, s: await w.settings(), spend: () => undefined, fetchFn: (async () => new Response("down", { status: 503 })) as typeof fetch });
    await signal("on", T0 + 20 * MINUTE);
    expect(posts()).toEqual([`<@${OWNER}> Света нет с 22:00`, `<@${OWNER}> Свет вернулся в 22:20, не было 20 мин`]);
  });

  it("характер выключен: только факты, как раньше", async () => {
    await w.repo().exec([setSetting("mood_on", "0")]);
    await signal("off", T0);
    await signal("on", T0 + 20 * MINUTE);
    expect(posts().at(-1)).toBe(`<@${OWNER}> Свет вернулся в 22:20, не было 20 мин`);
  });
});
