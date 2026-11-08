// Языковая модель, шаг 1: понимание фраз как запасной путь. Сеть не нужна: модель — заглушка.
import { beforeEach, describe, expect, it } from "vitest";
import { createFromText } from "../src/intake.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { type AiBinding, LLM_MODEL, buildPrompt, extractJson, interpretReply, titleOk, understandPhrase } from "../src/llm.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

const O = { now: NOW, tz: TZ, defaultTime: 9 * 60 };
const reply = (o: unknown) => JSON.stringify(o);
const stub = (text: string | (() => Promise<unknown>), calls: Record<string, unknown>[] = []): AiBinding => ({
  run: async (model, input) => {
    calls.push({ model, ...input });
    return typeof text === "string" ? { response: text } : text();
  },
});

describe("проверка ответа модели", () => {
  it("достаёт JSON, даже в обёртке из ```", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson("нет json")).toBeNull();
    expect(extractJson("{сломано")).toBeNull();
  });

  it("название: не пусто, не длинное, по-русски; латиница только если была в фразе", () => {
    expect(titleOk("Позвонить маме", "позвонить маме в субботу")).toBe(true);
    expect(titleOk("", "x")).toBe(false);
    expect(titleOk("А".repeat(121), "x")).toBe(false);
    expect(titleOk("Call mom", "позвонить маме")).toBe(false);
    expect(titleOk("Обновить Bitwarden", "обновить Bitwarden в пятницу")).toBe(true);
    expect(titleOk("Смотри https://x.example", "смотри")).toBe(false);
    expect(titleOk(42, "x")).toBe(false);
    expect(titleOk("12345", "12345")).toBe(false);
  });

  it("разовое дело: when_iso превращается в момент по часовому поясу пользователя", () => {
    const p = interpretReply(reply({ title: "Позвонить маме", when_iso: "2026-11-14T14:00", repeat: null }), "в субботу после обеда напомни позвонить маме", O)!;
    expect(p.title).toBe("Позвонить маме");
    expect(p.due).toBe(kyiv(2026, 11, 14, 14, 0));
    expect(p.recipe).toBeNull();
  });

  it("повтор разбирает обычный разбор: рецепт «каждый понедельник»", () => {
    const p = interpretReply(reply({ title: "Полить цветы", when_iso: "2026-11-09T09:00", repeat: "каждый понедельник в 9:00" }), "по понедельникам утром поливать цветы", O)!;
    expect(p.recipe?.freq).toBe("weeks");
    expect(p.title).toBe("Полить цветы");
    expect(p.due).toBe(kyiv(2026, 11, 9, 9, 0));
  });

  it("мусор, прошлое, далёкое будущее, несуществующая дата, повтор без рецепта — null (бот работает как раньше)", () => {
    const r = (o: unknown) => interpretReply(reply(o), "дело", O);
    expect(r({ title: "Дело", when_iso: null, repeat: null })).toBeNull();
    expect(r({ title: "Дело", when_iso: "завтра", repeat: null })).toBeNull();
    expect(r({ title: "Дело", when_iso: "2026-11-06T10:00", repeat: null })).toBeNull(); // уже прошло
    expect(r({ title: "Дело", when_iso: "2031-01-01T10:00", repeat: null })).toBeNull(); // слишком далеко
    expect(r({ title: "Дело", when_iso: "2026-11-31T10:00", repeat: null })).toBeNull(); // нет такой даты
    expect(r({ title: "Дело", when_iso: "2026-13-01T10:00", repeat: null })).toBeNull();
    expect(r({ title: "Дело", when_iso: "2026-11-14T25:00", repeat: null })).toBeNull();
    expect(r({ title: "Дело", when_iso: "2026-11-14T14:00", repeat: "время от времени" })).toBeNull();
    expect(interpretReply("не json", "дело", O)).toBeNull();
  });

  it("промпт знает «сейчас» по часам пользователя и американский порядок дат", () => {
    const s = buildPrompt(NOW, TZ);
    expect(s).toContain("суббота, 2026-11-07 12:00");
    expect(s).toContain("месяц.день");
  });
});

describe("запрос к модели", () => {
  const ok = reply({ title: "Позвонить маме", when_iso: "2026-11-14T14:00", repeat: null });

  it("зовёт нужную модель без «рассуждений»", async () => {
    const calls: Record<string, unknown>[] = [];
    const p = await understandPhrase(stub(ok, calls), "в субботу после обеда позвонить маме", O);
    expect(p?.due).toBe(kyiv(2026, 11, 14, 14, 0));
    expect(calls[0].model).toBe(LLM_MODEL);
    expect(calls[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("понимает и форму ответа choices[0].message.content", async () => {
    const ai = stub(async () => ({ choices: [{ message: { content: ok } }] }));
    expect((await understandPhrase(ai, "в субботу после обеда позвонить маме", O))?.title).toBe("Позвонить маме");
  });

  it("нет привязки, ошибка, пустой ответ, таймаут — тихо null", async () => {
    expect(await understandPhrase(undefined, "дело", O)).toBeNull();
    expect(await understandPhrase(stub(async () => { throw new Error("лимит нейронов"); }), "дело", O)).toBeNull();
    expect(await understandPhrase(stub(async () => ({ response: "" })), "дело", O)).toBeNull();
    expect(await understandPhrase(stub(async () => ({})), "дело", O)).toBeNull();
    const slow = stub(() => new Promise((r) => setTimeout(() => r({ response: ok }), 300)));
    expect(await understandPhrase(slow, "дело", { ...O, timeoutMs: 20 })).toBeNull();
    const lateFail = stub(() => new Promise((_, rej) => setTimeout(() => rej(new Error("поздно")), 60)));
    expect(await understandPhrase(lateFail, "дело", { ...O, timeoutMs: 10 })).toBeNull(); // поздний сбой не роняет процесс
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe("проводка: createFromText", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ intake: true });
  });
  const ok = reply({ title: "Позвонить маме", when_iso: "2026-11-14T14:00", repeat: null });
  const make = async (text: string, ai: AiBinding | undefined, llm: boolean) => {
    if (llm) await w.repo().exec([(await import("../src/db/repo.ts")).setSetting("llm_on", "1")]);
    return createFromText({ repo: w.repo(), settings: await w.settings(), now: NOW, ai }, text, "slash");
  };

  it("выключено по умолчанию: модель не зовут, дело без времени остаётся черновиком", async () => {
    const calls: Record<string, unknown>[] = [];
    const r = await make("двадцатого заплатить за квартиру", stub(ok, calls), false);
    expect(calls).toHaveLength(0);
    expect(r.kind === "created" && r.draft).toBe(true);
  });

  it("включено: время понято моделью, запись с пометкой «проверьте», кнопки «Верно / Изменить» на месте", async () => {
    // обычный разбор «через пару дней» не понимает
    const r = await make("двадцатого заплатить за квартиру", stub(ok), true);
    if (r.kind !== "created") throw new Error(r.kind);
    expect(r.draft).toBe(false);
    expect(r.message.content).toContain("**Позвонить маме**");
    expect(r.message.content).toContain("11.14.2026, 14:00");
    expect(r.message.content).toContain("языковая модель");
    const ids = (r.message.components as any[]).flatMap((x) => x.components.map((c: any) => c.custom_id));
    expect(ids.some((i: string) => i.startsWith("edit"))).toBe(true);
  });

  it("сбой модели: молча как раньше (черновик «когда?»)", async () => {
    const r = await make("двадцатого заплатить за квартиру", stub(async () => { throw new Error("down"); }), true);
    expect(r.kind === "created" && r.draft).toBe(true);
    expect(r.kind === "created" && r.message.content).not.toContain("модель");
  });

  it("обычный разбор справился сам: модель не зовут", async () => {
    const calls: Record<string, unknown>[] = [];
    const r = await make("завтра в 10 купить хлеб", stub(ok, calls), true);
    expect(calls).toHaveLength(0);
    expect(r.kind === "created" && r.message.content).toContain("завтра, 10:00");
  });

  it("секрет до модели не доходит", async () => {
    const calls: Record<string, unknown>[] = [];
    const r = await make("пароль от почты: Hunter2Hunter2!", stub(ok, calls), true);
    expect(r.kind).toBe("secret");
    expect(calls).toHaveLength(0);
  });

  it("/every (нужен повтор): модель не зовут", async () => {
    const calls: Record<string, unknown>[] = [];
    await w.repo().exec([(await import("../src/db/repo.ts")).setSetting("llm_on", "1")]);
    const r = await createFromText({ repo: w.repo(), settings: await w.settings(), now: NOW, ai: stub(ok, calls) }, "иногда звонить маме", "slash", { requireRecurring: true });
    expect(r.kind).toBe("not_recurring");
    expect(calls).toHaveLength(0);
  });
});

describe("настройка в /settings", () => {
  it("кнопка переключает «Понимание моделью», по умолчанию выкл", async () => {
    const w = new World();
    await w.seed({ intake: true });
    const pending: Promise<unknown>[] = [];
    const call = async (i: Partial<Interaction>) => {
      const r = await handleInteraction(
        { id: "1", token: "t", application_id: "a", guild_id: "g", channel_id: CH_BOT, member: { user: { id: OWNER } }, type: 3, message: { id: "m" }, ...i } as Interaction,
        { repo: w.repo(100), api: w.discord, now: NOW, env: {}, rand: () => 0, defer: (p) => void pending.push(p) },
      );
      await Promise.all(pending.splice(0));
      return r as any;
    };
    expect((await w.settings()).llmOn).toBe(false);
    const r = await call({ data: { custom_id: "s_llm" } });
    expect((await w.settings()).llmOn).toBe(true);
    expect(JSON.stringify(r)).toContain("Понимание фраз моделью: вкл");
    await call({ data: { custom_id: "s_llm" } });
    expect((await w.settings()).llmOn).toBe(false);
  });
});
