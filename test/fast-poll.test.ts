// Быстрый опрос приёма (cron.ts, шаг 4): текст из канала подхватывается за секунды, а не за минуту.
// Время и ожидание поддельные: тест не спит, а «перематывает» часы и по ходу дела подкладывает сообщения в канал.
import { beforeEach, describe, expect, it } from "vitest";
import { type CronReport, FAST_POLL, type FastPoll, runCron } from "../src/cron.ts";
import { countedApi } from "../src/discord/api.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

interface FastRun {
  report: CronReport;
  /** сколько раз за запуск читали канал приёма «бот» (канал напоминаний читается следом, ради ответов Reply) */
  polls: number;
  /** сколько подзапросов к базе сделал запуск */
  d1: number;
  /** сколько секунд «прошло» к концу запуска */
  elapsed: number;
}

/**
 * Запуск cron с быстрым опросом. `at` — что произойдёт на указанной секунде от начала запуска (сообщение в канале и т.п.);
 * срабатывает, когда поддельные часы доходят до этой секунды.
 */
async function runFast(now: number, at: Record<number, () => void> = {}, fp: Partial<FastPoll> = {}, limit = 50): Promise<FastRun> {
  const repo = w.repo(limit);
  let t = 0;
  const todo = Object.entries(at).map(([sec, fn]) => ({ ms: Number(sec) * 1000, fn, done: false }));
  const fire = (): void => {
    for (const x of todo) if (!x.done && x.ms <= t) { x.done = true; x.fn(); }
  };
  // счётчик чтений каналов ставим ДО countedApi: тот привязывает методы в момент создания
  let polls = 0;
  const list = w.discord.listMessages.bind(w.discord);
  w.discord.listMessages = (async (...a: Parameters<typeof list>) => {
    if (a[0] === CH_BOT) polls++;
    return list(...a);
  }) as typeof w.discord.listMessages;
  const api = countedApi(w.discord, repo.counter);
  const d1Before = w.d1.calls;
  const report = await runCron({
    repo,
    api,
    now,
    env: {},
    fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    ping: async () => {},
    fastPoll: { ...FAST_POLL, ...fp, sleep: async (ms) => { t += ms; fire(); }, clock: () => t },
  });
  w.discord.listMessages = list;
  return { report, polls, d1: w.d1.calls - d1Before, elapsed: t / 1000 };
}

const titles = () => w.d1.q<{ title: string }>("SELECT title FROM items ORDER BY id").map((r) => r.title);
const replies = () => w.discord.live(CH_BOT).map((p) => p.body.content ?? "");

describe("быстрый опрос: ответ приходит внутри минуты", () => {
  it("сообщение на 20-й секунде записано в этом же запуске, а не в следующую минуту", async () => {
    await runFast(NOW); // первый запуск: запоминает конец канала
    const r = await runFast(NOW + MINUTE, { 20: () => w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб") });
    expect(r.report.intake).toBe(1);
    expect(titles()).toEqual(["Купить хлеб"]);
    expect(replies().some((c) => c.includes("Записано: **Купить хлеб**"))).toBe(true);
  });

  it("опросов: один в начале минуты и четыре быстрых (12, 24, 36, 48 с), дальше запуск не тянется", async () => {
    await runFast(NOW);
    const r = await runFast(NOW + MINUTE);
    expect(r.polls).toBe(1 + 4);
    expect(r.elapsed).toBe(48);
  });

  it("без быстрого опроса — как раньше: одна проверка в минуту", async () => {
    await runFast(NOW);
    const r = await runFast(NOW + MINUTE, {}, { rounds: 0 });
    expect(r.polls).toBe(1);
    expect(r.elapsed).toBe(0);
  });

  it("пустой быстрый опрос не обращается к базе: те же подзапросы к базе, лишние — только чтения каналов", async () => {
    await runFast(NOW, {}, { rounds: 0 }); // разовые суточные дела (замок, заморозка) отрабатывают в первых запусках — сравниваем потом
    await runFast(NOW + MINUTE, {}, { rounds: 0 });
    const quiet = await runFast(NOW + 2 * MINUTE, {}, { rounds: 0 });
    const fast = await runFast(NOW + 3 * MINUTE);
    expect(fast.d1).toBe(quiet.d1);
    expect(fast.report.subrequests - quiet.report.subrequests).toBe(4 * 2); // 4 круга × 2 канала (приёма и напоминаний), больше ничего
  });

  it("несколько сообщений в разные моменты — каждое записано один раз, без дублей и потерь", async () => {
    await runFast(NOW);
    const r = await runFast(NOW + MINUTE, {
      5: () => w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб"),
      30: () => w.discord.say(CH_BOT, OWNER, "послезавтра в 11 позвонить маме"),
      31: () => w.discord.say(CH_BOT, "555", "чужое сообщение"),
    });
    expect(r.report.intake).toBe(2);
    expect(titles()).toEqual(["Купить хлеб", "Позвонить маме"]);
    await runFast(NOW + 2 * MINUTE); // следующая минута те же сообщения не трогает
    expect(titles()).toHaveLength(2);
    expect(replies().filter((c) => c.includes("Записано"))).toHaveLength(2);
  });

  it("первый запуск после выкладки только запоминает конец канала; сообщение, пришедшее позже, не пропущено", async () => {
    w.discord.say(CH_BOT, OWNER, "завтра в 9 старое сообщение");
    const r = await runFast(NOW, { 15: () => w.discord.say(CH_BOT, OWNER, "завтра в 10 новое") });
    expect(r.report.intake).toBe(1);
    expect(titles()).toEqual(["Новое"]);
  });

  it("прочитанное записывается в базу после каждого круга: следующая минута начинает с нужного места", async () => {
    await runFast(NOW);
    await runFast(NOW + MINUTE, { 40: () => w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб") });
    const last = w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", `intake_last:${CH_BOT}`)[0].value;
    expect(last).toBe(w.discord.inbox.get(CH_BOT)!.at(-1)!.id);
  });

  it("поздний срок: круги, которые начались бы после maxMs, не запускаются", async () => {
    await runFast(NOW);
    const r = await runFast(NOW + MINUTE, {}, { rounds: 10, everyMs: 12_000, maxMs: 30_000 });
    expect(r.polls).toBe(1 + 2); // 12 и 24 с
    expect(r.elapsed).toBe(24);
  });

  it("мало подзапросов — быстрые круги тихо пропускаются, запуск не падает", async () => {
    await runFast(NOW, {}, {}, 8);
    const r = await runFast(NOW + MINUTE, { 20: () => w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб") }, {}, 8);
    expect(r.report.notes.join("\n")).not.toContain("ошибка");
    expect(r.report.subrequests).toBeLessThanOrEqual(8);
  });

  it("секрет в быстром круге: не сохраняется и не попадает в журнал, как и в обычном", async () => {
    await runFast(NOW);
    await runFast(NOW + MINUTE, { 20: () => w.discord.say(CH_BOT, OWNER, "пароль: Qw3rty!x7") });
    expect(titles()).toEqual([]);
    expect(replies().some((c) => c.includes("Bitwarden"))).toBe(true);
    const dump = JSON.stringify(w.d1.q("SELECT * FROM events")) + JSON.stringify(w.d1.q("SELECT * FROM meta"));
    expect(dump).not.toContain("Qw3rty");
  });

  it("сообщение без текста (нет доступа к содержимому): подсказка раз в сутки, даже если быстрых кругов несколько", async () => {
    await runFast(NOW);
    await runFast(NOW + MINUTE, {
      14: () => w.discord.say(CH_BOT, OWNER, ""),
      26: () => w.discord.say(CH_BOT, OWNER, ""),
    });
    expect(replies().filter((c) => c.includes("Message Content Intent"))).toHaveLength(1);
  });
});
