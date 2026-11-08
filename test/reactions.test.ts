// Этап 2б «Характер»: реплики Хару к коротким ответам бота (отмена, откладывание, удаление, черновик, Reply «не понял»).
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { draftMessage } from "../src/discord/ui.ts";
import type { AiBinding } from "../src/llm.ts";
import { STYLE_DEFAULT } from "../src/personality/animeStyle.ts";
import { MoodSession, makeCtx, reactionLine } from "../src/personality/director.ts";
import { MOODS } from "../src/personality/moodEngine.ts";
import { PHRASES } from "../src/personality/phrases.ts";
import { REACTION_PHRASES } from "../src/personality/phrases.reactions.ts";
import { integrityProblems } from "../src/personality/poolCheck.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const min = (n: number) => NOW + n * MINUTE;
const answer = (text: string) => ({ choices: [{ message: { content: text } }] });
function fakeAi(text = "Убрала. Одним делом меньше, одним вздохом больше.") {
  const calls: unknown[] = [];
  const ai: AiBinding = {
    async run(_model, input) {
      calls.push(input);
      return answer(text);
    },
  };
  return { ai, calls };
}
const boom: AiBinding = { run: async () => { throw new Error("нет"); } };

describe("запасные фразы и черновик", () => {
  it("у каждого настроения ≥3 фраз для черновика, отмены, откладывания, удаления, «не поняла»; целостны", () => {
    expect(integrityProblems(REACTION_PHRASES)).toEqual([]);
    for (const mood of MOODS)
      for (const sit of ["draft", "cancelled", "snoozed", "deleted", "reply_unknown"] as const)
        expect(REACTION_PHRASES[mood][sit]?.length ?? 0, `${mood}.${sit}`).toBeGreaterThanOrEqual(3);
    for (const mood of MOODS) for (const sit of ["stopped", "reply_past", "reply_closed"] as const) expect(PHRASES[mood][sit] ?? PHRASES[mood].cancelled).toBeTruthy();
  });

  it("draftMessage: реплика отдельной строкой, «#N» остаётся последним номером для Reply, кнопки на месте", () => {
    const m = draftMessage({ occId: 5, itemId: 9, title: "Купить хлеб", line: "Дело есть, времени нет. *вздох*" });
    expect(m.content).toContain("**Купить хлеб** — когда напомнить? · #9");
    expect(m.content).toContain("-# Дело есть, времени нет. *вздох*");
    expect([...(m.content ?? "").matchAll(/#(\d+)/g)].at(-1)![1]).toBe("9");
    expect(m.components).toHaveLength(2);
    expect(draftMessage({ occId: 5, itemId: 9, title: "Купить хлеб" }).content).toBe("**Купить хлеб** — когда напомнить? · #9");
  });
});

describe("reactionLine", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: {} });
  });
  const mk = async (ai: AiBinding | null, rand = () => 0) => {
    const s = await w.settings();
    const m = new MoodSession({ repo: w.repo(), userId: OWNER, ctx: makeCtx(NOW, s), rand, style: { ...STYLE_DEFAULT, level: 3 }, live: ai ? { ai, tz: s.tz, timeoutMs: 500 } : null });
    await m.load();
    return m;
  };
  it("обычное дело — реплика модели; без модели — готовая фраза", async () => {
    const f = fakeAi("Убрала, хозяин. Одним делом меньше. *вздыхает*");
    expect(await reactionLine(await mk(f.ai), "cancelled", { title: "Купить хлеб" })).toBe("Убрала, хозяин. Одним делом меньше. *вздыхает*");
    expect(await reactionLine(await mk(null), "deleted", { title: "Купить хлеб" })).toBeTruthy();
  });
  it("серьёзная тема, критичное дело, «Без стиля» — без реплики и без вызова модели", async () => {
    const f = fakeAi();
    const m = await mk(f.ai);
    expect(await reactionLine(m, "cancelled", { title: "Записаться к врачу" })).toBeNull();
    expect(await reactionLine(m, "cancelled", { title: "Купить хлеб", critical: 1 })).toBeNull();
    expect(await reactionLine(m, "snoozed", { title: "Купить хлеб", plain: 1 })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
  it("шанс не выпал — null (откладывание — реже остальных)", async () => {
    const f = fakeAi();
    const m = await mk(f.ai, () => 0.75);
    expect(await reactionLine(m, "snoozed", { title: "Купить хлеб" })).toBeNull(); // шанс 0.5
    expect(await reactionLine(m, "cancelled", { title: "Купить хлеб" })).toBeTruthy(); // шанс 0.8
  });
});

describe("в боте", () => {
  let w: World;
  let pending: Promise<unknown>[];
  let seq = 0;
  beforeEach(async () => {
    w = new World();
    pending = [];
    await w.seed({ today: true, intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off", mood_on: "1", character: "maid" } });
  });
  const runCronAt = async (now: number, ai?: AiBinding) => {
    const repo = w.repo(100);
    return runCron({ repo, api: countedApi(w.discord, repo.counter), now, env: {}, rand: () => 0, ai, fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
  };
  const call = async (i: Partial<Interaction>, ai?: AiBinding, world = w): Promise<any> => {
    const r = await handleInteraction(
      { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
      { repo: world.repo(100), api: world.discord, now: NOW, env: {}, rand: () => 0, ai, defer: (p) => void pending.push(p) },
    );
    await Promise.all(pending.splice(0));
    return r;
  };

  it("Reply «отмени»: ответ бота и правка сообщения с репликой Хару", async () => {
    const f = fakeAi();
    await w.create("через 5 минут оплатить счёт");
    await runCronAt(min(5), f.ai);
    const msg = w.discord.live(CH_REMIND)[0].id;
    w.discord.say(CH_REMIND, OWNER, "отмени", { ref: msg, at: min(6) });
    await runCronAt(min(7), f.ai);
    const reply = w.discord.live(CH_REMIND).at(-1)!;
    expect(reply.body.content).toContain("Отменено: **Оплатить счёт**.");
    expect(reply.body.content).toContain("-# Убрала. Одним делом меньше");
    expect(w.discord.edits.at(-1)!.body.content).toContain("-# Убрала.");
  });

  it("Reply «не понял»: модель недоступна — подсказка на месте и готовая фраза под ней", async () => {
    await w.create("через 5 минут оплатить счёт");
    await runCronAt(min(5), boom);
    const msg = w.discord.live(CH_REMIND)[0].id;
    w.discord.say(CH_REMIND, OWNER, "абракадабра", { ref: msg, at: min(6) });
    await runCronAt(min(7), boom);
    const text = w.discord.live(CH_REMIND).at(-1)!.body.content as string;
    expect(text).toContain("Не понял. Ответьте, например");
    expect(text).toContain("-# ");
  });

  it("черновик «когда напомнить?» с репликой Хару; кнопки времени на месте", async () => {
    const f = fakeAi("Дело есть, времени нет. Классика.");
    const r = await call({ type: 2, data: { name: "remind", type: 1, options: [{ name: "text", value: "купить хлеб" }] } }, f.ai);
    expect(r.data.content).toContain("когда напомнить?");
    expect(r.data.content).toContain("-# Дело есть, времени нет");
    expect(JSON.stringify(r.data.components)).toContain("Через час");
  });

  it("кнопка «Отменить» под «Записано»: «Отменено» с репликой; «Настроение» выкл — без неё", async () => {
    const f = fakeAi();
    const created = (await w.create("завтра в 10 купить хлеб")) as { itemId: number };
    const r = await call({ type: 3, data: { custom_id: `rm:${created.itemId}` }, message: { id: "m1" } }, f.ai);
    expect(JSON.stringify(r)).toContain("Отменено: Купить хлеб");
    expect(JSON.stringify(r)).toContain("-# Убрала. Одним делом меньше");
    const w2 = new World();
    await w2.seed({ settings: { mood_on: "0" } });
    const c2 = (await w2.create("завтра в 10 купить хлеб")) as { itemId: number };
    const r2 = await call({ type: 3, data: { custom_id: `rm:${c2.itemId}` }, message: { id: "m1" } }, f.ai, w2);
    expect(JSON.stringify(r2)).not.toContain("-# ");
  });

  it("удаление через меню: реплика под результатом", async () => {
    const f = fakeAi("Стёрла. Хоть что-то в списке закончилось.");
    const created = (await w.create("завтра в 10 купить хлеб")) as { itemId: number };
    const r = await call({ type: 3, data: { custom_id: `mn:dy:${created.itemId}:a:0` }, message: { id: "m1" } }, f.ai);
    expect(JSON.stringify(r)).toContain("Удалено: **Купить хлеб**");
    expect(JSON.stringify(r)).toContain("-# Стёрла.");
  });
});
