// Этап 2 «Характер»: живые реплики через модель (liveLines.ts, MoodSession.sayLive), запасной путь на готовые фразы,
// праздники/дни рождения, «Без стиля» на деле, переключатель в настройках, реплики под сводками и в пустом списке.
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import type { AiBinding } from "../src/llm.ts";
import { STYLE_DEFAULT, parseStyleState } from "../src/personality/animeStyle.ts";
import { MOOD_CONFIG } from "../src/personality/config.ts";
import { MoodSession, canStyle, makeCtx, pickAddress, recordedLine, summaryLine } from "../src/personality/director.ts";
import { LIVE_DAILY_CAP, type LineRequest, buildLinePrompt, cleanLine, liveLine, pickLength } from "../src/personality/liveLines.ts";
import { daysUntil, occasionFor, parseBirthday } from "../src/personality/occasions.ts";
import { EXTRA_PHRASES } from "../src/personality/phrases.extra.ts";
import { PHRASES } from "../src/personality/phrases.ts";
import { integrityProblems } from "../src/personality/poolCheck.ts";
import { MOODS } from "../src/personality/moodEngine.ts";
import { readSettings } from "../src/settings.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const min = (n: number) => NOW + n * MINUTE;
const card = (b: { embeds?: { description?: string }[] }): string => b.embeds?.[0]?.description ?? "";
const answer = (text: string) => ({ choices: [{ message: { content: text } }] });
/** заглушка Workers AI: считает вызовы и запоминает запросы */
function fakeAi(text: string | (() => string) = "Ну вот, чай остыл, а вы всё медлите. *вздыхает*") {
  const calls: { model: string; input: any }[] = [];
  const ai: AiBinding = {
    async run(model, input) {
      calls.push({ model, input });
      return answer(typeof text === "function" ? text() : text);
    },
  };
  return { ai, calls };
}
const req = (o: Partial<LineRequest> = {}): LineRequest => ({
  mood: "tired", situation: "reminder", level: 3, address: "хозяин", hour: 18, weekday: 3, length: "short", interests: [], ...o,
});

describe("liveLines: проверка ответа модели", () => {
  const ok = (t: string) => cleanLine(t, { length: "medium" });
  it("обычная реплика проходит; кавычки, «Реплика:» и эмодзи убираются", () => {
    expect(ok("Яре-яре, хозяин, чай остыл. *вздыхает*")).toBe("Яре-яре, хозяин, чай остыл. *вздыхает*");
    expect(ok("«Пора за дело, хозяин»")).toBe("Пора за дело, хозяин");
    expect(ok("Реплика: Ара-ара, опять забыли 😏")).toBe("Ара-ара, опять забыли");
  });
  it("латиница, ссылки, угрозы, упоминание ИИ, секреты, лишняя длина — брак", () => {
    expect(ok("Hello хозяин")).toBeNull();
    expect(ok("Смотрите http://x.ru хозяин")).toBeNull();
    expect(ok("Я убью вас, хозяин")).toBeNull();
    expect(ok("Я всего лишь нейросеть, хозяин")).toBeNull();
    expect(ok("Ваша карта 4111 1111 1111 1111 хозяин")).toBeNull();
    expect(ok("слово ".repeat(60))).toBeNull();
    expect(ok("")).toBeNull();
  });
  it("незакрытые звёздочки и «чужой» формат — брак", () => {
    expect(ok("Ара-ара *вздыхает")).toBeNull();
    expect(ok("# Заголовок")).toBeNull();
  });
  it("в «коротких» репликах слишком длинный ответ отбраковывается", () => {
    expect(cleanLine("слово ".repeat(25).trim(), { length: "short" })).toBeNull();
    expect(cleanLine("слово ".repeat(25).trim(), { length: "long" })).not.toBeNull();
  });
  it("длина случайная: все три класса достижимы", () => {
    expect([0.1, 0.5, 0.9].map((r) => pickLength(() => r))).toEqual(["short", "medium", "long"]);
  });
});

describe("liveLines: запрос к модели", () => {
  it("в запросе настроение, ситуация, длина, обращение и дело; на уровне 0 японских слов нет", () => {
    const p = buildLinePrompt(req({ mood: "yandere", situation: "missed", task: "Вынести мусор", length: "long", missStreak: 3 }));
    expect(p).toContain("яндере");
    expect(p).toContain("просрочено");
    expect(p).toContain("17–30 слов");
    expect(p).toContain("«хозяин»");
    expect(p).toContain("Вынести мусор");
    expect(p).toContain("пропусков подряд: 3");
    expect(buildLinePrompt(req({ level: 0 }))).not.toContain("не больше 2 на реплику");
  });
  it("без обращения (обида) — просьба говорить «в пустоту»; праздник и интересы попадают в запрос", () => {
    expect(buildLinePrompt(req({ mood: "sulking", address: null }))).toContain("не обращайся");
    const p = buildLinePrompt(req({ occasion: "Новый год", interests: ["аниме"], action: false, noLead: true }));
    expect(p).toContain("Особый день: Новый год");
    expect(p).toContain("Хозяин любит: аниме");
    expect(p).toContain("БЕЗ действий в звёздочках");
    expect(p).toContain("НЕ с японского междометия");
  });
  it("обращение зависит от настроения и уровня", () => {
    const style = { ...STYLE_DEFAULT, level: 3 as const };
    expect(pickAddress("proud", style, "хозяин", () => 0)).toBe("госюдзин-сама");
    expect(pickAddress("sulking", style, "хозяин", () => 0.5)).toBeNull();
    expect(pickAddress("tsundere", style, "хозяин", () => 0)).toBe("х-хозяин");
    expect(pickAddress("proud", { ...style, level: 0 }, "хозяин", () => 0)).toBe("хозяин");
  });
});

describe("liveLines: вызов модели с запасным путём", () => {
  it("обычный ответ — реплика", async () => {
    const f = fakeAi();
    expect(await liveLine(f.ai, req(), { timeoutMs: 500 })).toContain("чай остыл");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].input.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
  it("нет привязки, исключение, плохой ответ, долгий ответ — null", async () => {
    expect(await liveLine(undefined, req(), { timeoutMs: 500 })).toBeNull();
    const boom: AiBinding = { run: async () => { throw new Error("лимит"); } };
    expect(await liveLine(boom, req(), { timeoutMs: 500 })).toBeNull();
    expect(await liveLine(fakeAi("Hello").ai, req(), { timeoutMs: 500 })).toBeNull();
    const slow: AiBinding = { run: () => new Promise((r) => setTimeout(() => r(answer("Поздно, хозяин")), 300)) };
    expect(await liveLine(slow, req(), { timeoutMs: 30 })).toBeNull();
  });
});

describe("MoodSession.sayLive", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: {} });
  });
  const session = async (live: Partial<NonNullable<ConstructorParameters<typeof MoodSession>[0]["live"]>> | null, rand = () => 0.99) => {
    const s = await w.settings();
    const m = new MoodSession({
      repo: w.repo(), userId: OWNER, ctx: makeCtx(NOW, s), rand, style: { ...STYLE_DEFAULT, level: 3 },
      live: live ? { ai: fakeAi().ai, tz: s.tz, timeoutMs: 500, ...live } : null,
    });
    await m.load();
    return m;
  };

  it("без модели — готовая фраза из пула, как раньше", async () => {
    const m = await session(null, () => 0);
    const line = await m.sayLive("reminder", { task: "Дело" });
    expect(line).toBeTruthy();
    expect(m.styleState.lv).toBeUndefined(); // модель не звали: счётчик пуст
  });

  it("модель ответила — её реплика; вызов записан в счётчик суток и сохраняется", async () => {
    const f = fakeAi("Хозяин, чай остыл. *вздыхает*");
    const m = await session({ ai: f.ai });
    expect(await m.sayLive("reminder", { task: "Оплатить счёт" })).toBe("Хозяин, чай остыл. *вздыхает*");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].input.messages[0].content).toContain("Оплатить счёт");
    await w.repo().exec(m.ops());
    const row = w.d1.q<{ style_data: string }>("SELECT style_data FROM mood_state WHERE user_id = ?", OWNER)[0];
    expect(parseStyleState(row.style_data).lv).toEqual({ d: Math.floor(NOW / 86_400_000), n: 1 });
  });

  it("сбой модели — готовая фраза, вызов всё равно засчитан", async () => {
    const m = await session({ ai: fakeAi("Hello").ai });
    const line = await m.sayLive("reminder", { task: "Дело" }, "tired");
    expect(line).toBeTruthy();
    expect(line).not.toBe("Hello");
    expect(m.styleState.lv?.n).toBe(1);
  });

  it("дневной потолок: дальше модель не зовём, говорим готовыми фразами", async () => {
    const f = fakeAi();
    const m = await session({ ai: f.ai, cap: 2 });
    await m.sayLive("done");
    await m.sayLive("done");
    expect(f.calls).toHaveLength(2);
    expect(await m.sayLive("done")).toBeTruthy();
    expect(f.calls).toHaveLength(2);
    expect(LIVE_DAILY_CAP).toBeGreaterThan(50);
    expect(LIVE_DAILY_CAP).toBeLessThanOrEqual(400); // ≈ 7 нейронов на вызов: меньше 30% бесплатных 10 000 в сутки
  });

  it("новые сутки обнуляют счётчик", async () => {
    const f = fakeAi();
    const m = await session({ ai: f.ai, cap: 1 });
    m.styleState = { ...m.styleState, lv: { d: Math.floor(NOW / 86_400_000) - 1, n: 99 } };
    await m.sayLive("done");
    expect(f.calls).toHaveLength(1);
  });

  it("нет запаса подзапросов (gate) — модель не зовём", async () => {
    const f = fakeAi();
    const m = await session({ ai: f.ai, gate: () => false });
    expect(await m.sayLive("done")).toBeTruthy();
    expect(f.calls).toHaveLength(0);
  });

  it("секретное или «серьёзное» название дела до модели не доходит", async () => {
    const f = fakeAi();
    const m = await session({ ai: f.ai });
    await m.sayLive("reminder", { task: "карта 4111 1111 1111 1111" });
    await m.sayLive("reminder", { task: "Записаться к врачу" });
    for (const c of f.calls) {
      expect(c.input.messages[0].content).not.toContain("4111");
      expect(c.input.messages[0].content).not.toContain("врачу");
    }
  });

  it("повторное напоминание: половина — готовой фразой (бережём лимит)", async () => {
    const f = fakeAi();
    const m = await session({ ai: f.ai }, () => 0.1);
    await m.sayLive("reminder_repeat");
    expect(f.calls).toHaveLength(0);
    const m2 = await session({ ai: f.ai }, () => 0.9);
    await m2.sayLive("reminder_repeat");
    expect(f.calls).toHaveLength(1);
  });

  it("recordedLine отдаёт дело модели; на серьёзной теме — null", async () => {
    const f = fakeAi("Записано, хозяин. *кивает*");
    const m = await session({ ai: f.ai });
    expect(await recordedLine(m, "Купить хлеб", false)).toBe("Записано, хозяин. *кивает*");
    expect(await recordedLine(m, "Похороны бабушки", false)).toBeNull();
    expect(await recordedLine(m, "Купить хлеб", true)).toBeNull();
  });

  it("«без стиля» на деле выключает стиль так же, как серьёзная тема", () => {
    expect(canStyle("Купить хлеб", false, true)).toBe(false);
    expect(canStyle("Купить хлеб", false, false)).toBe(true);
    expect(canStyle("Купить хлеб", 0, 1)).toBe(false);
  });
});

describe("праздники и дни рождения", () => {
  it("праздники по датам; обычный день — null", () => {
    expect(occasionFor({ y: 2026, mo: 1, d: 1 })?.label).toBe("Новый год");
    expect(occasionFor({ y: 2026, mo: 10, d: 31 })?.label).toBe("Хэллоуин");
    expect(occasionFor({ y: 2026, mo: 6, d: 3 })).toBeNull();
  });
  it("день рождения: сегодня, завтра, через неделю; через год и в обычные дни — нет", () => {
    const bd = parseBirthday("11.20.1990");
    expect(bd).toEqual({ mo: 11, d: 20 });
    expect(occasionFor({ y: 2026, mo: 11, d: 20 }, bd)?.situation).toBe("holiday");
    expect(occasionFor({ y: 2026, mo: 11, d: 19 }, bd)?.situation).toBe("birthday_soon");
    expect(occasionFor({ y: 2026, mo: 11, d: 13 }, bd)?.situation).toBe("birthday_soon");
    expect(occasionFor({ y: 2026, mo: 11, d: 10 }, bd)).toBeNull();
    expect(daysUntil({ y: 2026, mo: 12, d: 30 }, { mo: 1, d: 2 })).toBe(3);
  });
  it("разбор даты рождения", () => {
    expect(parseBirthday("3.7")).toEqual({ mo: 3, d: 7 });
    expect(parseBirthday("13.40")).toBeNull();
    expect(parseBirthday("завтра")).toBeNull();
    expect(parseBirthday(undefined)).toBeNull();
  });
  it("настройки: живые реплики включены по умолчанию, birthday читается", () => {
    expect(readSettings([]).liveOn).toBe(true);
    expect(readSettings([{ key: "live_on", value: "0" }]).liveOn).toBe(false);
    expect(readSettings([{ key: "birthday", value: "11.20" }]).birthday).toEqual({ mo: 11, d: 20 });
    expect(readSettings([]).birthday).toBeNull();
  });
});

describe("summaryLine", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: {} });
  });
  const mk = async (rand: () => number) => {
    const s = await w.settings();
    const m = new MoodSession({ repo: w.repo(), userId: OWNER, ctx: makeCtx(NOW, s), rand, style: { ...STYLE_DEFAULT, level: 3 }, live: null });
    await m.load();
    return m;
  };
  it("в праздник утром — праздничная реплика даже при «невыпавшем» шансе", async () => {
    const m = await mk(() => 0.99);
    expect(await summaryLine(m, { kind: "morning", open: 3, wall: { y: 2026, mo: 1, d: 1 }, birthday: null })).toBeTruthy();
  });
  it("пустой день утром — реплика «дел нет»; вечером шанс не выпал — null", async () => {
    const m = await mk(() => 0.99);
    expect(await summaryLine(m, { kind: "morning", open: 0, wall: { y: 2026, mo: 6, d: 3 }, birthday: null })).toBeTruthy();
    expect(await summaryLine(m, { kind: "evening", open: 2, wall: { y: 2026, mo: 6, d: 3 }, birthday: null })).toBeNull();
  });
  it("шанс выпал — реплика есть для всех трёх видов сводки", async () => {
    const m = await mk(() => 0.01);
    for (const kind of ["morning", "evening", "weekly"] as const)
      expect(await summaryLine(m, { kind, open: 2, done: 4, wall: { y: 2026, mo: 6, d: 3 }, birthday: null }), kind).toBeTruthy();
  });
});

describe("в боте: cron, кнопки, настройки", () => {
  let w: World;
  let pending: Promise<unknown>[];
  let seq = 0;
  beforeEach(async () => {
    w = new World();
    pending = [];
    await w.seed({ today: true, intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off", mood_on: "1", character: "maid" } });
  });
  async function run(now: number, ai?: AiBinding, rand = () => 0) {
    const repo = w.repo(100);
    return runCron({
      repo, api: countedApi(w.discord, repo.counter), now, env: {}, rand, ai,
      fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    });
  }
  async function call(i: Partial<Interaction>, now = NOW, ai?: AiBinding): Promise<any> {
    const r = await handleInteraction(
      { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
      { repo: w.repo(100), api: w.discord, now, env: {}, rand: () => 0, ai, defer: (p) => void pending.push(p) },
    );
    await Promise.all(pending.splice(0));
    return r;
  }
  const click = (custom_id: string, now = NOW, ai?: AiBinding) => call({ type: 3, data: { custom_id }, message: { id: "m1" } }, now, ai);

  it("напоминание: под ним реплика модели", async () => {
    const f = fakeAi("Хозяин, чай остыл, а дело ждёт. *вздыхает*");
    await w.create("через 5 минут оплатить счёт");
    await run(min(5), f.ai);
    expect(card(w.discord.live(CH_REMIND)[0].body)).toContain("чай остыл");
    expect(f.calls).toHaveLength(1);
  });

  it("модель недоступна — напоминание уходит с готовой фразой", async () => {
    const boom: AiBinding = { run: async () => { throw new Error("нет"); } };
    await w.create("через 5 минут оплатить счёт");
    await run(min(5), boom);
    expect(card(w.discord.live(CH_REMIND)[0].body).length).toBeGreaterThan(3);
  });

  it("выключатель «Живые реплики»: выкл — модель не зовётся", async () => {
    expect((await click("mn:s:c")).data.content).toContain("Живые реплики через модель: вкл");
    expect((await click("mn:tg:lv:c")).data.content).toContain("Живые реплики через модель: выкл");
    expect((await w.settings()).liveOn).toBe(false);
    const f = fakeAi();
    await w.create("через 5 минут оплатить счёт");
    await run(min(5), f.ai);
    expect(f.calls).toHaveLength(0);
  });

  it("«Без стиля» на деле: в окне «Изменить» есть выбор; после выбора реплики нет, модель не зовётся", async () => {
    const { occId, itemId } = (await w.create("через 5 минут оплатить счёт")) as any;
    const m = await click(`mn:ed:${occId}:a:0`);
    expect(JSON.stringify(m.data.components)).toContain("Реплики Хару");
    const r = await call({
      type: 5,
      data: { custom_id: `m_edit:${occId}:mn`, components: [
        { type: 18, component: { type: 4, custom_id: "title", value: "Оплатить счёт" } },
        { type: 18, component: { type: 3, custom_id: "plain", values: ["plain"] } },
      ] },
    });
    expect(r).toBeTruthy();
    expect(w.d1.q<{ plain: number }>("SELECT plain FROM items WHERE id = ?", itemId ?? occId)[0]?.plain).toBe(1);
    const f = fakeAi();
    await run(min(5), f.ai);
    expect(w.discord.live(CH_REMIND)[0].body.embeds).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it("пустой /list: реплика Хару; без неё (шанс не выпал) — прежний текст", async () => {
    const w2 = new World();
    await w2.seed({ settings: { mood_on: "1", character: "maid" } });
    const f = fakeAi("Пусто, хозяин, даже чаю не с чем попить. *вздыхает*");
    const r = await handleInteraction(
      { id: "x1", token: "t", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, data: { name: "list", type: 1 } } as Interaction,
      { repo: w2.repo(100), api: w2.discord, now: NOW, env: {}, rand: () => 0, ai: f.ai, defer: () => undefined },
    );
    expect((r as any).data.content).toContain("Открытых дел нет.");
    expect((r as any).data.content).toContain("даже чаю не с чем");
  });
});

describe("запасные фразы для новых ситуаций", () => {
  it("целостны; у каждого настроения есть сводки, пустой список и праздник (≥4), остальное — через запасные ситуации", () => {
    expect(integrityProblems(EXTRA_PHRASES)).toEqual([]);
    for (const mood of MOODS)
      for (const sit of ["summary_morning", "summary_evening", "empty_list", "holiday"] as const)
        expect(EXTRA_PHRASES[mood][sit]?.length ?? 0, `${mood}.${sit}`).toBeGreaterThanOrEqual(4);
    for (const mood of MOODS) for (const sit of ["summary_weekly", "empty_today", "birthday_soon"] as const) expect(PHRASES[mood][sit] ?? PHRASES[mood].summary_evening).toBeTruthy();
  });
});

describe("серьёзные темы: без стиля", () => {
  it("тяжёлые события (болезнь близких, похороны, поминки, соболезнования) — стиль выключен; обычные дела — нет", async () => {
    const { isSeriousTopic } = await import("../src/personality/moodEngine.ts");
    for (const t of ["Навестить маму, она болеет — болезнь серьёзная", "Похороны дедушки", "Поминки в субботу", "Отправить соболезнования", "Дядя умер, позвонить тёте", "Купить лекарства"])
      expect(isSeriousTopic(t), t).toBe(true);
    for (const t of ["Купить хлеб", "Оплатить интернет", "Умывальник заказать", "Позвонить маме"]) expect(isSeriousTopic(t), t).toBe(false);
  });
});
