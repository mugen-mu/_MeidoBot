// Аниме: запасной разбор фразы языковой моделью («Да, всегда», волна 4 анкеты, 2026-11-18). Сети нет: модель — заглушка.
// Проверяем: ответ модели разбирается строго; в модель не уходят секреты, фразы со временем, длинные и при нехватке нейронов;
// любой сбой — обычное дело; действие выполняют обработчики правил; незнакомое название само не добавляется.
import { beforeEach, describe, expect, it } from "vitest";
import type { Anime } from "../src/anime/core.ts";
import { LLM_MAX_CHARS, LLM_PER_RUN, animeLlmGate, buildAnimePrompt, classifyAnime, interpretAnimeReply, resolveOwn, runAnimeLlm } from "../src/anime/llmSay.ts";
import { parseAnimeMark } from "../src/anime/mark.ts";
import { parseAnimeSay } from "../src/anime/say.ts";
import { setMeta } from "../src/db/repo.ts";
import { sectionMessage } from "../src/discord/menu.ts";
import { type AiBinding, LLM_MODEL } from "../src/llm.ts";
import { readSettings } from "../src/settings.ts";
import { MINUTE } from "../src/time/tz.ts";
import { LIMITS, aiHasRoom, utcDay } from "../src/usage.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

const J = (o: Record<string, unknown>): string => JSON.stringify({ action: "none", title: null, episode: null, season: null, status: null, liked: null, sure: true, ...o });
const settings = readSettings([]);

describe("ответ модели: строгая проверка", () => {
  const ok = (o: Record<string, unknown>, original = "Фрирен") => interpretAnimeReply(J(o), original);

  it("каждое действие разбирается в нужные поля", () => {
    expect(ok({ action: "episode", title: "Фрирен", episode: 6 })).toMatchObject({ action: "episode", title: "Фрирен", episode: 6, sure: true });
    expect(ok({ action: "episode", title: "Фрирен", episode: "last" })?.episode).toBe("last");
    expect(ok({ action: "episode", title: "Фрирен", episode: "next" })?.episode).toBe("next");
    expect(ok({ action: "episode", title: "Фрирен", episode: "7" })?.episode).toBe(7); // число строкой
    expect(ok({ action: "episode", title: "Фрирен" })?.episode).toBeNull(); // номер не назван — следующая
    expect(ok({ action: "status", title: "Фрирен", status: "dropped" })).toMatchObject({ action: "status", status: "dropped" });
    expect(ok({ action: "rate", title: "Фрирен", liked: 2 })).toMatchObject({ action: "rate", liked: 2 });
    expect(ok({ action: "rate", title: "Фрирен", liked: "-2" })?.liked).toBe(-2);
    expect(ok({ action: "ask_watching" })).toMatchObject({ action: "ask_watching", title: null });
    expect(ok({ action: "ask_planned" })?.action).toBe("ask_planned");
    expect(ok({ action: "ask_news" })?.action).toBe("ask_news");
    expect(ok({ action: "ask_next" })).toMatchObject({ action: "ask_next", title: null });
    expect(ok({ action: "ask_next", title: "Фрирен" })?.title).toBe("Фрирен");
    expect(ok({ action: "ask_did", title: "Фрирен", season: 2 })).toMatchObject({ action: "ask_did", season: 2 });
  });

  it("оценка числом: нет liked, но есть score — 9–10 → 2, 7–8 → 1, 5–6 → −1, ≤4 → −2", () => {
    const sc = (score: number) => interpretAnimeReply(JSON.stringify({ action: "rate", title: "Фрирен", score, sure: true }), "Фрирен")?.liked;
    expect([sc(10), sc(9), sc(8), sc(7), sc(6), sc(5), sc(4), sc(1)]).toEqual([2, 2, 1, 1, -1, -1, -2, -2]);
    expect(sc(11)).toBeUndefined();
  });

  it("«none», неизвестное действие, мусор — null (сообщение идёт дальше как дело)", () => {
    expect(ok({ action: "none" })).toBeNull();
    expect(ok({ action: "delete_everything", title: "Фрирен" })).toBeNull();
    expect(interpretAnimeReply("не json", "Фрирен")).toBeNull();
    expect(interpretAnimeReply("{сломано", "Фрирен")).toBeNull();
    expect(interpretAnimeReply("[1,2]", "Фрирен")).toBeNull();
    expect(interpretAnimeReply("", "Фрирен")).toBeNull();
  });

  it("неверные значения полей отбрасывают весь ответ", () => {
    expect(ok({ action: "episode", title: "Фрирен", episode: 0 })).toBeNull();
    expect(ok({ action: "episode", title: "Фрирен", episode: 99999 })).toBeNull();
    expect(ok({ action: "episode", title: "Фрирен", episode: 2.5 })).toBeNull();
    expect(ok({ action: "episode", title: "Фрирен", episode: "завтра" })).toBeNull();
    expect(ok({ action: "episode", title: "Фрирен", season: 0 })).toBeNull();
    expect(ok({ action: "status", title: "Фрирен", status: "finished" })).toBeNull();
    expect(ok({ action: "status", title: "Фрирен" })).toBeNull();
    expect(ok({ action: "rate", title: "Фрирен", liked: 3 })).toBeNull();
    expect(ok({ action: "rate", title: "Фрирен" })).toBeNull();
    expect(ok({ action: "episode", title: null, episode: 3 })).toBeNull(); // серия без названия
    expect(ok({ action: "ask_did" })).toBeNull(); // «смотрел ли» без названия
  });

  it("название обязано быть в сообщении: выдуманное и переведённое отбрасываем, падеж прощаем", () => {
    expect(ok({ action: "status", title: "Берсерк", status: "done" }, "Фрирен досмотрел")).toBeNull(); // выдумала
    expect(ok({ action: "status", title: "Frieren", status: "done" }, "Фрирен досмотрел")).toBeNull(); // перевела
    expect(ok({ action: "status", title: "Фрирен", status: "done" }, "досмотрел Фрирена")?.title).toBe("Фрирен");
    expect(ok({ action: "status", title: "Магическая битва", status: "done" }, "досмотрел магическую битву")?.title).toBe("Магическая битва");
    expect(ok({ action: "status", title: "Sousou no Frieren", status: "done" }, "досмотрел sousou no frieren")?.title).toBe("Sousou no Frieren");
    expect(ok({ action: "status", title: "Ф", status: "done" }, "Ф досмотрел")).toBeNull(); // слишком коротко
    expect(ok({ action: "status", title: "Фрирен https://x.example", status: "done" }, "Фрирен https://x.example")).toBeNull();
    expect(ok({ action: "status", title: "Фрирен".repeat(20), status: "done" }, "Фрирен".repeat(20))).toBeNull();
  });

  it("уверенность: без «sure: true» (или с false) — не уверена", () => {
    expect(ok({ action: "episode", title: "Фрирен", sure: false })?.sure).toBe(false);
    expect(interpretAnimeReply('{"action":"episode","title":"Фрирен"}', "Фрирен")?.sure).toBe(false);
  });

  it("JSON в обёртке из ``` понимаем", () => {
    expect(interpretAnimeReply("```json\n" + J({ action: "ask_news" }) + "\n```", "что вышло")?.action).toBe("ask_news");
  });

  it("промпт: все действия, шкала оценок и пример «none»", () => {
    const p = buildAnimePrompt();
    for (const a of ["none", "episode", "status", "rate", "ask_watching", "ask_planned", "ask_news", "ask_next", "ask_did"]) expect(p).toContain(a);
    expect(p).toContain("9–10");
    expect(p).toContain("4 и ниже");
    expect(p).toContain("«купить хлеб»");
    expect(p.length).toBeLessThan(2200); // компактный: это тратит бесплатные нейроны
  });
});

describe("вызов модели", () => {
  const stub = (run: () => Promise<unknown>, calls: Record<string, unknown>[] = []): AiBinding => ({
    run: async (model, input) => {
      calls.push({ model, ...input });
      return run();
    },
  });
  const good = { response: J({ action: "episode", title: "Фрирен", episode: 5 }) };

  it("зовёт нужную модель без «рассуждений», режет текст", async () => {
    const calls: Record<string, unknown>[] = [];
    const r = await classifyAnime(stub(async () => good, calls), "  Фрирен пятая серия  ");
    expect(r.found).toMatchObject({ action: "episode", episode: 5 });
    expect(calls[0].model).toBe(LLM_MODEL);
    expect(calls[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(calls[0].temperature).toBe(0);
    expect((calls[0].messages as { role: string; content: string }[])[1]).toEqual({ role: "user", content: "Фрирен пятая серия" });
  });

  it("форма ответа choices[0].message.content тоже понятна", async () => {
    const r = await classifyAnime(stub(async () => ({ choices: [{ message: { content: good.response } }] })), "Фрирен 5");
    expect(r.found?.action).toBe("episode");
  });

  it("ошибка, пустой ответ, не JSON, таймаут — failed (без исключений); «none» — не сбой", async () => {
    expect((await classifyAnime(stub(async () => { throw new Error("лимит нейронов"); }), "Фрирен 5")).failed).toBe(true);
    expect((await classifyAnime(stub(async () => ({ response: "" })), "Фрирен 5")).failed).toBe(true);
    expect((await classifyAnime(stub(async () => ({})), "Фрирен 5")).failed).toBe(true);
    expect((await classifyAnime(stub(async () => ({ response: "я не знаю" })), "Фрирен 5")).failed).toBe(true);
    const slow = stub(() => new Promise((r) => setTimeout(() => r(good), 300)));
    expect((await classifyAnime(slow, "Фрирен 5", 20)).failed).toBe(true);
    const lateFail = stub(() => new Promise((_, rej) => setTimeout(() => rej(new Error("поздно")), 60)));
    expect((await classifyAnime(lateFail, "Фрирен 5", 10)).failed).toBe(true); // поздний сбой не роняет процесс
    await new Promise((r) => setTimeout(r, 100));
    const none = await classifyAnime(stub(async () => ({ response: J({ action: "none" }) })), "купить хлеб");
    expect(none).toEqual({ failed: false, found: null });
  });
});

describe("кому можно отправить сообщение в модель", () => {
  const gate = (text: string, o: { days?: { d: string; ai: number }[]; neurons?: number; at?: number } = {}) =>
    animeLlmGate(text, {
      now: NOW,
      at: o.at ?? NOW,
      settings,
      days: (o.days ?? []).map((x) => ({ runs: 1, sub: 0, rw: 0, rr: 0, db: 0, gaps: 0, gap: 0, ...x })),
      neurons: o.neurons ?? 0,
    });

  it("обычные фразы без времени — можно (в том числе «купить хлеб»: «Да, всегда»)", () => {
    expect(gate("Фрирен я наконец-то досмотрела")).toBe(true);
    expect(gate("купить хлеб")).toBe(true);
    expect(gate("а Фрирен я вообще смотрел")).toBe(true);
  });

  it("секрет (пароль, ключ, карта) — нельзя", () => {
    expect(gate("пароль от почты: Hunter2Hunter2!")).toBe(false);
    expect(gate("Фрирен 4111 1111 1111 1111")).toBe(false);
    expect(gate("ключ sk-abcdefghijklmnopqrstuv Фрирен")).toBe(false);
  });

  it("обычный разбор уже понял время или повтор — это дело со своим путём, нельзя", () => {
    expect(gate("завтра в 19:00 посмотреть Фрирен")).toBe(false);
    expect(gate("через 10 минут посмотреть серию")).toBe(false);
    expect(gate("каждый понедельник смотреть Фрирен")).toBe(false);
  });

  it("прошедшее время («досмотрел вчера …») — можно: это не напоминание", () => {
    expect(gate("досмотрел вчера Магическую битву")).toBe(true);
  });

  it("оценка «10/10» обычный разбор принимает за дату, но модели такую фразу показываем", () => {
    expect(gate("Блич 10/10")).toBe(true);
    expect(gate("Блич 9 / 10, огонь")).toBe(true);
    expect(gate("сдать отчёт 10/12")).toBe(false); // настоящая дата
  });

  it("длиннее 200 символов, несколько строк, ссылка, пусто — нельзя", () => {
    expect(gate("а".repeat(LLM_MAX_CHARS + 1))).toBe(false);
    expect(gate("Фрирен\nБлич")).toBe(false);
    expect(gate("посмотрел Фрирен https://shikimori.one/animes/52991")).toBe(false);
    expect(gate("   ")).toBe(false);
  });

  it("запас нейронов: от 70% суточной нормы (с учётом этого запуска) — нельзя; вчерашний расход не мешает", () => {
    const today = utcDay(NOW);
    const limit = LIMITS.neurons;
    expect(gate("Фрирен досмотрел", { days: [{ d: today, ai: limit * 0.69 }] })).toBe(true);
    expect(gate("Фрирен досмотрел", { days: [{ d: today, ai: limit * 0.7 }] })).toBe(false);
    expect(gate("Фрирен досмотрел", { days: [{ d: today, ai: limit * 0.65 }], neurons: limit * 0.06 })).toBe(false);
    expect(gate("Фрирен досмотрел", { days: [{ d: utcDay(NOW - 86_400_000), ai: limit * 0.99 }] })).toBe(true);
    expect(aiHasRoom([], NOW, 0)).toBe(true);
  });
});

describe("сверка названия со списком", () => {
  const row = (id: number, ru: string, orig: string | null, o: Partial<Anime> = {}): Anime =>
    ({ id, mal_id: id, anilist_id: null, title_ru: ru, title_orig: orig, status: "done", watched: 0, liked: 0, notify: 1, episodes: 12, src_status: "FINISHED", next_ep: null, next_at: null, aired_ep: 12, aired_at: null,
      asked_ep: 0, added_at: 0, updated_at: 0, drop_reason: null, last_move_at: null, voice_lag: null, voice_n: 0, voice_ep: 0, weekq_at: null, seq_at: null, start_asked: 0, ...o }) as Anime;
  const rows = [row(1, "Провожающая в последний путь Фрирен", "Sousou no Frieren"), row(2, "Класс превосходства", "Youkoso Jitsuryoku"), row(3, "Класс превосходства 2", "Youkoso 2nd Season"), row(4, "Магическая битва", "Jujutsu Kaisen")];

  it("точное название, оригинал, падеж", () => {
    expect(resolveOwn(rows, "Фрирен", null)).toMatchObject({ kind: "own", row: { id: 1 } });
    expect(resolveOwn(rows, "sousou no frieren", null)).toMatchObject({ kind: "own", row: { id: 1 } });
    expect(resolveOwn(rows, "Фрирена", null)).toMatchObject({ kind: "own", row: { id: 1 } }); // падеж
    expect(resolveOwn(rows, "Магическую битву", null)).toMatchObject({ kind: "own", row: { id: 4 } });
  });

  it("сезон выбирает запись; неясное — несколько; нет в списке — none", () => {
    expect(resolveOwn(rows, "Класс превосходства", 2)).toMatchObject({ kind: "own", row: { id: 3 } });
    expect(resolveOwn(rows, "превосходства", null)).toMatchObject({ kind: "several" });
    expect(resolveOwn(rows, "Берсерк", null)).toEqual({ kind: "none" });
  });
});

describe("меню настроек", () => {
  it("«⋯ Ещё»: подпись про аниме-фразы, всё помещается в сообщение Discord", () => {
    const b = sectionMessage(settings, "a", NOW, false);
    expect(b.content).toContain("Понимание фраз моделью: выкл.");
    expect(b.content).toContain("про аниме");
    expect(b.content).toContain("поняла по смыслу");
    expect((b.content ?? "").length).toBeLessThan(2000);
  });
});

// ---------- cron: от сообщения в канале до ответа ----------

const D0 = kyiv(2026, 11, 9, 12, 0);
const T = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);
let w: World;
const anime = () => w.d1.q<Anime>("SELECT * FROM anime ORDER BY id");
const items = () => w.d1.q("SELECT 1 FROM items").length;
const replies = () => w.discord.posted.filter((p) => p.channel === CH_BOT);
const last = () => replies().at(-1)?.body.content as string;

/** Заглушка Workers AI: на каждое сообщение отвечает по таблице (текст → JSON, Error, строка); запросы на понимание времени получают «времени нет». */
function fakeAi(table: Record<string, unknown> | ((text: string) => unknown)) {
  const calls: { kind: "anime" | "time"; text: string }[] = [];
  const ai: AiBinding = {
    async run(_model, input) {
      const msgs = input.messages as { role: string; content: string }[];
      const kind = msgs[0].content.startsWith("Ты разбираешь короткие русские фразы хозяина бота про его аниме") ? "anime" : "time";
      calls.push({ kind, text: msgs[1].content });
      if (kind === "time") return { response: JSON.stringify({ title: "Дело", when_iso: null, repeat: null }) };
      const v = typeof table === "function" ? table(msgs[1].content) : table[msgs[1].content];
      if (v instanceof Error) throw v;
      return { response: typeof v === "string" ? v : (v === undefined ? J({ action: "none", sure: false }) : JSON.stringify(v)) };
    },
  };
  return { ai, calls, anime: () => calls.filter((c) => c.kind === "anime") };
}
const fa = (o: Record<string, unknown>) => ({ action: "none", title: null, episode: null, season: null, status: null, liked: null, sure: true, ...o });

async function say(text: string, at = D0 + MINUTE): Promise<void> {
  w.discord.say(CH_BOT, OWNER, text);
  await w.run(at);
}

async function setup(llm = true): Promise<void> {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off", ...(llm ? { llm_on: "1" } : {}) } });
  w.d1.sqlite.exec(
    `INSERT INTO anime (mal_id, title_ru, title_orig, status, watched, episodes, src_status, next_ep, next_at, aired_ep, asked_ep, added_at, updated_at, voice_lag)
       VALUES (1, 'Провожающая в последний путь Фрирен', 'Sousou no Frieren', 'watching', 4, 28, 'RELEASING', 7, ${T(9, 19)}, 6, 6, 0, 0, 120),
              (2, 'Блич', 'Bleach', 'planned', 0, 12, 'FINISHED', NULL, NULL, 12, 0, 0, 0, NULL),
              (3, 'ДжоДжо', 'JoJo', 'watching', 3, 12, 'FINISHED', NULL, NULL, 12, 3, 0, 0, NULL)`,
  );
  await w.run(D0); // первый запуск запоминает конец канала
}
beforeEach(() => setup());

describe("cron: аниме-фразы, которые не узнали правила", () => {
  it("«Фрирен я наконец-то досмотрела» — статус «Просмотрено», честный ответ с пометкой, дело не заводится", async () => {
    const f = fakeAi({ "Фрирен я наконец-то досмотрела": fa({ action: "status", title: "Фрирен", status: "done" }) });
    w.ai = f.ai;
    await say("Фрирен я наконец-то досмотрела");
    expect(anime()[0]).toMatchObject({ status: "done", watched: 28 });
    expect(last()).toContain("Записала");
    expect(last()).toContain("Просмотрено");
    expect(last()).toContain("поняла по смыслу");
    expect(items()).toBe(0);
    expect(f.anime()).toHaveLength(1);
    expect(f.calls).toHaveLength(1); // понимание времени не звали: дело не создавалось
  });

  it("серия: номер, «последняя» и «следующая»", async () => {
    const f = fakeAi({
      "Фрирен, 6-я серия зашла, глянул": fa({ action: "episode", title: "Фрирен", episode: 6 }),
      "ну что, Фрирен свежую серию глянул": fa({ action: "episode", title: "Фрирен", episode: "last" }),
      "посмотрел серию Фрирена": fa({ action: "episode", title: "Фрирена", episode: null }),
    });
    w.ai = f.ai;
    await say("Фрирен, 6-я серия зашла, глянул");
    expect(anime()[0].watched).toBe(6);
    expect(last()).toContain("серия 6");
    w.d1.sqlite.exec("UPDATE anime SET watched = 3 WHERE id = 1");
    await say("ну что, Фрирен свежую серию глянул", D0 + 2 * MINUTE);
    expect(anime()[0].watched).toBe(6); // последняя вышедшая
    await say("посмотрел серию Фрирена", D0 + 3 * MINUTE); // правила: «Фрирена» не нашли (падеж) → модель
    expect(anime()[0].watched).toBe(7);
    expect(items()).toBe(0);
  });

  it("серия больше, чем есть в тайтле, обрезается как у правил", async () => {
    w.ai = fakeAi({ "Блич, глянул 99 серию": fa({ action: "episode", title: "Блич", episode: 99 }) }).ai;
    await say("Блич, глянул 99 серию");
    expect(anime()[1]).toMatchObject({ status: "done", watched: 12 }); // у «Блич» 12 серий и он вышел целиком: 12-я серия — это «Просмотрено», как у правил
  });

  it("статусы: бросил, в планах, смотрю", async () => {
    const f = fakeAi({
      "ДжоДжо мне больше не интересен": fa({ action: "status", title: "ДжоДжо", status: "dropped" }),
      "Блич надо бы начать": fa({ action: "status", title: "Блич", status: "watching" }),
    });
    w.ai = f.ai;
    await say("ДжоДжо мне больше не интересен");
    expect(anime()[2].status).toBe("dropped");
    await say("Блич надо бы начать", D0 + 2 * MINUTE);
    expect(anime()[1].status).toBe("watching");
    expect(items()).toBe(0);
  });

  it("оценка: словами и числом (шкала 9–10 → «в восторге»)", async () => {
    const f = fakeAi({
      "Фрирен на 9 баллов": fa({ action: "rate", title: "Фрирен", liked: 2 }),
      "Блич как-то так себе вышел": fa({ action: "rate", title: "Блич", liked: -1 }),
      "Блич 10/10": fa({ action: "rate", title: "Блич", liked: 2 }),
    });
    w.ai = f.ai;
    await say("Фрирен на 9 баллов");
    expect(anime()[0].liked).toBe(2);
    expect(last()).toContain("в восторге");
    await say("Блич как-то так себе вышел", D0 + 2 * MINUTE);
    expect(anime()[1].liked).toBe(-1);
    await say("Блич 10/10", D0 + 3 * MINUTE); // обычный разбор видит тут дату — но не дело: модель поняла оценку
    expect(anime()[1].liked).toBe(2);
    expect(items()).toBe(0);
  });

  it("вопросы: что смотрю, что отложено, что нового, когда серия, смотрел ли — как у правил, без пометки", async () => {
    const f = fakeAi({
      "ну и что у меня сейчас в просмотре": fa({ action: "ask_watching" }),
      "что там в планах валяется": fa({ action: "ask_planned" }),
      "что новенького по сериям вышло": fa({ action: "ask_news" }),
      "когда там Фрирен новую серию выпустят": fa({ action: "ask_next", title: "Фрирен" }),
      "а Фрирен я вообще смотрел": fa({ action: "ask_did", title: "Фрирен" }),
    });
    w.ai = f.ai;
    await say("ну и что у меня сейчас в просмотре");
    expect(last()).toContain("Аниме · Смотрю");
    await say("что там в планах валяется", D0 + 2 * MINUTE);
    expect(last()).toContain("Аниме · В планах");
    await say("что новенького по сериям вышло", D0 + 3 * MINUTE);
    expect(last()).toContain("Вышло, а вы ещё не смотрели");
    await say("когда там Фрирен новую серию выпустят", D0 + 4 * MINUTE);
    expect(last()).toContain("7-я серия");
    await say("а Фрирен я вообще смотрел", D0 + 5 * MINUTE);
    expect(last()).toContain("Смотрю: серия 4");
    expect(last()).not.toContain("поняла по смыслу");
    expect(items()).toBe(0);
  });

  it("вопрос про название, которого нет в списке: честное «в списке нет»", async () => {
    w.ai = fakeAi({ "а Берсерк я смотрел вообще": fa({ action: "ask_did", title: "Берсерк" }) }).ai;
    await say("а Берсерк я смотрел вообще");
    expect(last()).toContain("в вашем списке нет");
    expect(items()).toBe(0);
  });
});

describe("cron: осторожность", () => {
  it("незнакомое название без обращения: говорим «в списке нет», сами не добавляем и в Shikimori не ходим", async () => {
    const f = fakeAi({ "Берсерк вчерашний наконец досмотрел": fa({ action: "status", title: "Берсерк", status: "done" }) });
    w.ai = f.ai;
    const fetches = w.animeFetches;
    const before = JSON.stringify(anime());
    await say("Берсерк вчерашний наконец досмотрел");
    expect(last()).toContain("«Берсерк» в вашем списке нет");
    expect(last()).toContain("бот смотрю Берсерк");
    expect(JSON.stringify(anime())).toBe(before);
    expect(w.animeFetches).toBe(fetches);
    expect(items()).toBe(0);
  });

  it("незнакомое название и модель не уверена — обычное дело, без лишних вопросов", async () => {
    w.ai = fakeAi({ "посмотреть бы Дюну как-нибудь": fa({ action: "status", title: "Дюну", status: "planned", sure: false }) }).ai;
    await say("посмотреть бы Дюну как-нибудь");
    expect(items()).toBe(1);
    expect(replies().some((p) => p.body.content?.includes("в вашем списке нет"))).toBe(false);
  });

  it("с обращением «Хару» незнакомое название ищется на Shikimori и записывается, как у правил", async () => {
    w.shikiSearch = [{ id: 57612, russian: "Магия вернувшегося", name: "Kikansha no Mahou", kind: "tv", status: "ongoing", episodes: 12, aired_on: "2026-10-08" }];
    w.shikiById[57612] = w.shikiSearch[0];
    w.ai = fakeAi({ "Хару, я тут Магию вернувшегося начала смотреть": fa({ action: "status", title: "Магию вернувшегося", status: "watching" }) }).ai;
    await say("Хару, я тут Магию вернувшегося начала смотреть");
    expect(anime().map((a) => a.mal_id)).toEqual([1, 2, 3, 57612]);
    expect(items()).toBe(0);
  });

  it("несколько подходящих записей: переспрос одной строкой, ничего не меняется", async () => {
    w.d1.sqlite.exec(
      `INSERT INTO anime (mal_id, title_ru, title_orig, status, watched, episodes, src_status, aired_ep, asked_ep, added_at, updated_at)
         VALUES (4, 'Класс превосходства', 'Youkoso', 'done', 12, 12, 'FINISHED', 12, 12, 0, 0), (5, 'Класс превосходства 2', 'Youkoso 2', 'done', 13, 13, 'FINISHED', 13, 13, 0, 0)`,
    );
    w.ai = fakeAi({ "про превосходства я оценил на 9": fa({ action: "rate", title: "превосходства", liked: 2 }) }).ai;
    await say("про превосходства я оценил на 9");
    expect(last()).toContain("Подходит несколько");
    expect(last()).toContain("Класс превосходства 2");
    expect(anime().filter((a) => a.liked !== 0)).toHaveLength(0);
    expect(items()).toBe(0);
  });

  it("модель не уверена, а название в списке есть: один раз спрашиваем «Так?», ничего не пишем", async () => {
    w.ai = fakeAi({ "ну Фрирен там 6 вроде": fa({ action: "episode", title: "Фрирен", episode: 6, sure: false }) }).ai;
    await say("ну Фрирен там 6 вроде");
    expect(last()).toContain("Так?");
    expect(last()).toContain("серия 6");
    expect(last()).toContain("«бот смотрю Фрирен серия 6»");
    expect(anime()[0].watched).toBe(4);
    expect(items()).toBe(0);
    expect(replies().filter((p) => p.body.content?.includes("Так?"))).toHaveLength(1);
  });

  it("«Так?» подсказывает фразу, которую поймут правила, и она означает то же самое", async () => {
    const c = { repo: w.repo(), now: D0 + MINUTE, tz: TZ, character: "neutral" as const, fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch };
    const guess = async (f: Record<string, unknown>, original: string) => {
      const found = interpretAnimeReply(JSON.stringify({ ...fa({ sure: false }), ...f }), original);
      const out = await runAnimeLlm(c, found!, original);
      return /«(бот [^»]+)»/.exec(out?.content ?? "")![1];
    };
    expect(parseAnimeSay(await guess({ action: "episode", title: "Фрирен", episode: 6 }, "Фрирен 6"))).toMatchObject({ status: "watching", query: "Фрирен", episode: 6, prefixed: true });
    expect(parseAnimeSay(await guess({ action: "episode", title: "Фрирен", episode: "last" }, "Фрирен свежая"))).toMatchObject({ query: "Фрирен", latest: true });
    expect(parseAnimeSay(await guess({ action: "episode", title: "Фрирен" }, "Фрирен серия"))).toMatchObject({ query: "Фрирен", next: true });
    for (const [status, want] of [["watching", "watching"], ["dropped", "dropped"], ["planned", "planned"], ["done", "done"]] as const) {
      expect(parseAnimeSay(await guess({ action: "status", title: "Фрирен", status }, "Фрирен так"))).toMatchObject({ status: want, query: "Фрирен", prefixed: true });
    }
    for (const liked of [2, 1, -1, -2]) expect(parseAnimeMark(await guess({ action: "rate", title: "Блич", liked }, "Блич так"))).toMatchObject({ liked, query: "Блич", prefixed: true });
  });

  it("вопрос без уверенности — обычное дело", async () => {
    w.ai = fakeAi({ "что там вообще вышло в магазине": fa({ action: "ask_news", sure: false }) }).ai;
    await say("что там вообще вышло в магазине");
    expect(items()).toBe(1);
  });

  it("«none»: обычное дело остаётся делом (и обычное понимание времени работает как раньше)", async () => {
    const f = fakeAi({});
    w.ai = f.ai;
    await say("купить хлеб");
    expect(items()).toBe(1);
    expect(last()).toContain("когда напомнить");
    expect(f.anime()).toHaveLength(1);
    expect(f.calls.map((c) => c.kind)).toEqual(["anime", "time"]);
  });

  it("правила сработали — модель не зовут: «глянул последнюю серию Фрирен», «что я смотрю», «что у меня горит»", async () => {
    const f = fakeAi({});
    w.ai = f.ai;
    await say("глянул последнюю серию Фрирен");
    await say("что я смотрю", D0 + 2 * MINUTE);
    await say("что у меня горит", D0 + 3 * MINUTE);
    expect(anime()[0].watched).toBe(6);
    expect(f.calls).toHaveLength(0);
  });

  it("секретное сообщение в модель не уходит: ни классификатор, ни понимание времени", async () => {
    const f = fakeAi({});
    w.ai = f.ai;
    await say("пароль от почты: Hunter2Hunter2! Фрирен");
    expect(f.calls).toHaveLength(0);
    expect(replies().some((p) => p.body.content?.includes("Похоже на пароль"))).toBe(true);
    expect(items()).toBe(0);
  });

  it("сообщение с датой и временем — дело со своим путём: модель про аниме не зовут", async () => {
    const f = fakeAi({});
    w.ai = f.ai;
    await say("завтра в 19:00 посмотреть Фрирен");
    expect(f.calls).toHaveLength(0);
    expect(items()).toBe(1);
    expect(last()).toContain("завтра, 19:00");
  });

  it("длинное сообщение и ссылка — в модель не уходят", async () => {
    const f = fakeAi({});
    w.ai = f.ai;
    await say(`${"Фрирен очень длинная история про аниме и всё остальное. ".repeat(5)}`);
    await say("глянь https://shikimori.one/animes/52991 вечером", D0 + 2 * MINUTE); // время есть — и без того мимо модели; проверяем ссылку отдельно
    await say("гляну потом https://shikimori.one/animes/52991", D0 + 3 * MINUTE);
    expect(f.anime()).toHaveLength(0);
  });

  it("выключено «Понимание моделью» — модель не зовут вообще, всё как раньше", async () => {
    await setup(false);
    const f = fakeAi({ "Фрирен я наконец-то досмотрела": fa({ action: "status", title: "Фрирен", status: "done" }) });
    w.ai = f.ai;
    await say("Фрирен я наконец-то досмотрела");
    expect(f.calls).toHaveLength(0);
    expect(anime()[0].status).toBe("watching");
    expect(items()).toBe(1);
  });

  it("нет привязки модели (env.AI) — всё как раньше", async () => {
    await say("Фрирен я наконец-то досмотрела");
    expect(items()).toBe(1);
  });

  it("не хватает бесплатной нормы нейронов (от 70%) — модель не зовут, фраза остаётся делом", async () => {
    const day = utcDay(D0 + MINUTE);
    await w.repo().exec([setMeta("usage", JSON.stringify([{ d: day, runs: 100, sub: 3, rw: 10, rr: 10, db: 1000, ai: LIMITS.neurons * 0.75, gaps: 0, gap: 0 }]))]);
    const f = fakeAi({ "Фрирен я наконец-то досмотрела": fa({ action: "status", title: "Фрирен", status: "done" }) });
    w.ai = f.ai;
    await say("Фрирен я наконец-то досмотрела");
    expect(f.anime()).toHaveLength(0);
    expect(anime()[0].status).toBe("watching");
    expect(items()).toBe(1);
  });

  it("вчерашний расход нейронов не мешает", async () => {
    await w.repo().exec([setMeta("usage", JSON.stringify([{ d: utcDay(D0 - 86_400_000), runs: 100, sub: 3, rw: 10, rr: 10, db: 1000, ai: LIMITS.neurons * 0.99, gaps: 0, gap: 0 }]))]);
    const f = fakeAi({ "Фрирен я наконец-то досмотрела": fa({ action: "status", title: "Фрирен", status: "done" }) });
    w.ai = f.ai;
    await say("Фрирен я наконец-то досмотрела");
    expect(f.anime()).toHaveLength(1);
    expect(anime()[0].status).toBe("done");
  });

  it("расход нейронов считается: после вызова модели в итоге суток есть «ai»", async () => {
    const ai: AiBinding = { run: async () => ({ response: J({ action: "none", sure: false }), usage: { prompt_tokens: 400, completion_tokens: 30 } }) };
    w.ai = ai;
    await say("Фрирен я наконец-то досмотрела");
    const usage = JSON.parse(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'usage'")[0].value) as { ai: number }[];
    expect(usage.at(-1)!.ai).toBeGreaterThan(0);
  });

  it("мусор, ошибка модели — без сообщения об ошибке, фраза остаётся делом; после сбоя в этом запуске модель больше не зовут", async () => {
    for (const bad of ["я не знаю что это", new Error("лимит нейронов"), "{сломано"]) {
      await setup();
      const f = fakeAi(() => bad);
      w.ai = f.ai;
      w.discord.say(CH_BOT, OWNER, "Фрирен я наконец-то досмотрела");
      w.discord.say(CH_BOT, OWNER, "Блич я тоже вчера досмотрела");
      await w.run(D0 + MINUTE);
      expect(f.anime()).toHaveLength(1); // вторую фразу этого запуска не спрашивали
      expect(items()).toBe(2); // обе — обычные дела
      expect(replies().every((p) => !/ошибк|не получилось|модел/i.test(p.body.content ?? ""))).toBe(true);
      expect(anime()[0].status).toBe("watching");
    }
  });

  it("за один запуск спрашиваем модель не больше LLM_PER_RUN раз", async () => {
    const f = fakeAi({});
    w.ai = f.ai;
    for (let i = 0; i < LLM_PER_RUN + 3; i++) w.discord.say(CH_BOT, OWNER, `купить хлеб ${"а".repeat(i + 1)}`);
    await w.run(D0 + MINUTE);
    expect(f.anime()).toHaveLength(LLM_PER_RUN);
    expect(items()).toBe(LLM_PER_RUN + 3); // остальные — обычные дела
  });

  it("запись о происшедшем: текст сообщения не попадает ни в события, ни в журнал", async () => {
    w.ai = fakeAi({ "Фрирен я наконец-то досмотрела": fa({ action: "status", title: "Фрирен", status: "done" }) }).ai;
    await say("Фрирен я наконец-то досмотрела");
    expect(JSON.stringify(w.d1.q("SELECT * FROM events"))).not.toContain("досмотрела");
    expect(w.logs.join("\n")).not.toContain("досмотрела");
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
  });

  it("норма «Это уже записано» не ломается: повтор той же оценки отвечает честно", async () => {
    w.ai = fakeAi({ "Фрирен на 9 баллов": fa({ action: "rate", title: "Фрирен", liked: 2 }) }).ai;
    await say("Фрирен на 9 баллов");
    await say("Фрирен на 9 баллов", D0 + 2 * MINUTE);
    expect(last()).toContain("Это уже записано");
  });
});

