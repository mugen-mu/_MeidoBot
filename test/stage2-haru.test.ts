// Этап 2 ретроспективы 2 «Хару ожила»: настроение по дню, случайность от даты и дела, нет повторов 14 дней,
// пятое откладывание, «тихий день», яндере только в подколках при пропуске, слова-флаги, серия и достижения, заготовка дней рождения.
// Тесты написаны до кода (план docs/PLAN-RETRO-2.md, этап 2).
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { type StyleState, emptyStyleState, parseStyleState } from "../src/personality/animeStyle.ts";
import { MoodSession, makeCtx } from "../src/personality/director.ts";
import {
  QUIET_DAY_MS,
  QUIET_OFF_REPLY,
  QUIET_ON_REPLY,
  YANDERE_SITUATIONS,
  dayNumber,
  dayTint,
  effectiveMood,
  hash01,
  noteDone,
  noteMiss,
  observeHot,
  parseQuietDay,
  pinch,
} from "../src/personality/day.ts";
import { isSeriousTopic } from "../src/personality/moodEngine.ts";
import { type Person, occasionFor, parsePeopleDates } from "../src/personality/occasions.ts";
import { PHRASES, type Situation } from "../src/personality/phrases.ts";
import { fingerprint, pickPhrase, poolFor } from "../src/personality/speech.ts";
import type { Mood } from "../src/personality/moodEngine.ts";
import { MINUTE, localDate } from "../src/time/tz.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const DAY = 86_400_000;
const min = (n: number) => NOW + n * MINUTE;
const card = (b: { embeds?: { description?: string }[] }): string => b.embeds?.[0]?.description ?? ""; // карточка (/mood и т. п.)
// фраза Хару в коротких ответах теперь в тексте сообщения (один слой, 2026-11-10), а не в карточке
const said = (b: { content?: string }): string => {
  const first = String(b.content ?? "").split("\n")[0];
  return first.replace(/^<@\d+>\s*/, "").replace(/\s*\*\*[^*]+\*\*.*$/, "");
};
const has = (m: Mood, s: Situation) => poolFor(m, s).length > 0;
const days = (n: number, from = "2026-01-01"): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * DAY).toISOString().slice(0, 10));
/** день с нужной окраской (ищем среди дат) */
const dayWith = (tint: "plain" | "grumpy" | "soft"): string => days(120).find((d) => dayTint(d) === tint)!;
/** текст реплики совпадает с одной из фраз пула (подстановки {user} заменяем любым словом) */
const fromPool = (text: string, pool: string[]): boolean =>
  pool.some((p) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{user\}/g, "[^ ,.!?]+").replace(/\{task\}/g, ".+").replace(/\{[a-z_]+\}/g, "\\d+")}$`, "u").test(text.trim()));

// ---------- чистая часть ----------

describe("случайность от даты и дела", () => {
  it("hash01: одно и то же при тех же аргументах, в [0, 1), от дела зависит", () => {
    expect(hash01("2026-11-07", 5, "x")).toBe(hash01("2026-11-07", 5, "x"));
    for (const id of [1, 2, 3, 99, 1000]) {
      const v = hash01("2026-11-07", id, "x");
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((i) => hash01("2026-11-07", i, "x"))).size).toBeGreaterThan(5);
    expect(hash01("2026-11-07", 5, "x")).not.toBe(hash01("2026-11-08", 5, "x"));
  });

  it("dayNumber считает сутки подряд, dayTint — окраска дня: все три встречаются, обычных около половины", () => {
    expect(dayNumber("2026-11-08") - dayNumber("2026-11-07")).toBe(1);
    expect(dayNumber("1970-01-02")).toBe(1);
    const tints = days(365).map(dayTint);
    expect(dayTint("2026-11-07")).toBe(dayTint("2026-11-07"));
    for (const t of ["plain", "grumpy", "soft"] as const) expect(tints.filter((x) => x === t).length).toBeGreaterThan(50);
    expect(tints.filter((x) => x === "plain").length).toBeGreaterThan(130);
  });

  it("pinch: p=0 никогда, p=1 всегда, остальное — около p и стабильно", () => {
    expect(pinch("2026-11-07", 1, "a", 0)).toBe(false);
    expect(pinch("2026-11-07", 1, "a", 1)).toBe(true);
    const hits = Array.from({ length: 1000 }, (_, i) => pinch("2026-11-07", i, "a", 0.2)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(140);
    expect(hits).toBeLessThan(260);
    expect(pinch("2026-11-07", 7, "a", 0.5)).toBe(pinch("2026-11-07", 7, "a", 0.5));
  });
});

describe("настроение по дню и «яндере только в подколках при пропуске»", () => {
  const eff = (mood: Mood, situation: Situation, dayKey: string, itemId = 0, hasFn = has) => effectiveMood({ mood, situation, dayKey, itemId, has: hasFn });

  it("яндере говорит яндере-языком только про пропуск; в остальных ситуациях — цундере", () => {
    expect([...YANDERE_SITUATIONS].sort()).toEqual(["missed", "missed_first"]);
    for (const s of ["reminder", "reminder_repeat", "done", "snoozed", "draft", "recorded", "summary_morning", "greeting", "deleted", "snooze_5"] as Situation[]) {
      expect(eff("yandere", s, "2026-11-07")).toBe("tsundere");
    }
    expect(eff("yandere", "missed", "2026-11-07")).toBe("yandere");
    expect(eff("yandere", "missed_first", "2026-11-07")).toBe("yandere");
  });

  it("усталая в «ворчливый» день ворчит (цундере) на напоминаниях, в «мягкий» — теплее (гордится) на «Готово»", () => {
    const grumpy = dayWith("grumpy");
    const soft = dayWith("soft");
    // ищем дело, на которое не выпала «щепотка» (чтобы окраска была именно дня)
    const id = (day: string, sit: Situation) => Array.from({ length: 50 }, (_, i) => i).find((i) => !pinch(day, i, `tint:${sit}`, 0.15))!;
    expect(eff("tired", "reminder", grumpy, id(grumpy, "reminder"))).toBe("tsundere");
    expect(eff("tired", "done", soft, id(soft, "done"))).toBe("proud");
    // обычный день: без смены
    const plain = dayWith("plain");
    expect(eff("tired", "reminder", plain, id(plain, "reminder"))).toBe("tired");
  });

  it("окраска дня касается только «усталой»; пропуски и настоящие настроения не трогает", () => {
    const grumpy = dayWith("grumpy");
    for (const m of ["sulking", "tsundere", "proud", "sleepy"] as Mood[]) {
      for (let i = 0; i < 30; i++) expect(eff(m, "reminder", grumpy, i)).toBe(m);
    }
    for (let i = 0; i < 40; i++) expect(["tired", "yandere"]).toContain(eff("tired", "missed", grumpy, i)); // на пропуске усталая либо как есть, либо «подколка» яндере
  });

  it("«щепотка»: в день одной окраски часть дел получает другую, но для одного дела всегда одно и то же", () => {
    const plain = dayWith("plain");
    const res = Array.from({ length: 300 }, (_, i) => eff("tired", "reminder", plain, i));
    expect(res.filter((m) => m !== "tired").length).toBeGreaterThan(15);
    expect(res.filter((m) => m !== "tired").length).toBeLessThan(80);
    expect(eff("tired", "reminder", plain, 17)).toBe(eff("tired", "reminder", plain, 17));
  });

  it("подколка при пропуске: у усталой, цундере, обиженной примерно в пятой части случаев — яндере; у остальных никогда", () => {
    const day = "2026-11-07";
    const yd = Array.from({ length: 500 }, (_, i) => eff("tsundere", "missed", day, i)).filter((m) => m === "yandere").length;
    expect(yd).toBeGreaterThan(60);
    expect(yd).toBeLessThan(150);
    for (let i = 0; i < 100; i++) {
      expect(eff("proud", "missed", day, i)).toBe("proud");
      expect(eff("sleepy", "missed", day, i)).toBe("sleepy");
    }
  });

  it("если у нужного настроения нет фраз для ситуации — остаётся прежнее", () => {
    const none = () => false;
    expect(eff("tired", "reminder", dayWith("grumpy"), 1, none)).toBe("tired");
    expect(eff("tsundere", "missed", "2026-11-07", 1, none)).toBe("tsundere");
  });
});

describe("слова-флаги «серьёзно» и «важно»", () => {
  it("помечают дело серьёзным; прежние серьёзные темы остаются; «неважно» не флаг", () => {
    for (const t of ["серьёзно позвонить маме", "Важно: оплатить счёт", "важная встреча", "Серьезно, подписать договор", "записаться к врачу"]) {
      expect(isSeriousTopic(t), t).toBe(true);
    }
    for (const t of ["купить хлеб", "неважно что", "позвонить маме", "посмотреть аниме"]) expect(isSeriousTopic(t), t).toBe(false);
  });
});

describe("«тихий день»: слово боту", () => {
  it("включают «тихий день» (с «бот» и знаками), выключают «тихий день отмена» и «хватит тихого дня»", () => {
    for (const t of ["тихий день", "Тихий день!", "бот, тихий день", "бот тихий день.", "тихий день пожалуйста"]) expect(parseQuietDay(t), t).toBe("on");
    for (const t of ["тихий день отмена", "тихий день отбой", "хватит тихого дня", "хватит тишины", "отмени тихий день"]) expect(parseQuietDay(t), t).toBe("off");
  });
  it("обычное дело со словами «тихий день» — не команда", () => {
    for (const t of ["", "позвонить маме в тихий день", "купить тихий день", "в тихий день убраться и позвонить", "тихий"]) expect(parseQuietDay(t), t).toBeNull();
  });
  it("тексты ответа и срок: сутки", () => {
    expect(QUIET_ON_REPLY).toBe("Хорошо. Сегодня потише.");
    expect(QUIET_OFF_REPLY).toMatch(/Хару/);
    expect(QUIET_DAY_MS).toBe(DAY);
  });
});

describe("память реплик: 14 дней и серия", () => {
  it("состояние стиля: новые поля читаются и пишутся, мусор отбрасывается", () => {
    const st: StyleState = { ...emptyStyleState(), rl: { abc: 20000, def: 20001 }, ot: { d: 20000, n: 2 }, cl: 19990, ac: { any: 20000, gs: 19995, wk: 19900, wc: 19990 } };
    expect(parseStyleState(JSON.stringify(st))).toEqual(st);
    const bad = parseStyleState(JSON.stringify({ n: 1, words: {}, rl: { a: "x", b: 5 }, ot: { d: "z" }, cl: "q", ac: { any: -1 } }));
    expect(bad.rl).toEqual({ b: 5 });
    expect(bad.ot).toBeUndefined();
    expect(bad.cl).toBeUndefined();
    expect(bad.ac).toBeUndefined();
  });

  it("pickPhrase не берёт фразу, использованную меньше 14 дней назад; когда все были — самую давнюю", () => {
    const bank = { tired: { snoozed: ["раз", "два", "три"] } };
    const [a, b, c] = ["раз", "два", "три"].map(fingerprint);
    const base = { mood: "tired" as const, situation: "snoozed" as const, recent: [], rand: () => 0, bank };
    expect(pickPhrase({ ...base, used: { [a]: 100, [b]: 100 }, today: 105 })!.text).toBe("три");
    expect(pickPhrase({ ...base, used: { [a]: 104, [b]: 100, [c]: 103 }, today: 105 })!.text).toBe("два"); // все свежие: самая давняя
    expect(pickPhrase({ ...base, used: { [a]: 80, [b]: 81, [c]: 82 }, today: 105 })!.text).toBe("раз"); // старше 14 дней: можно снова
    expect(pickPhrase({ ...base, today: 105 })!.text).toBe("раз"); // без памяти — как раньше
  });

  it("MoodSession.say: за один день пул не повторяется, пока не кончится; через 15 дней первая фраза снова доступна", async () => {
    const w = new World();
    await w.seed({ settings: { mood_on: "1", style_level: "0" } });
    const s = await w.settings();
    const mk = (now: number) => new MoodSession({ repo: w.repo(), userId: OWNER, ctx: makeCtx(now, s), rand: () => 0, style: s.style });
    const pool = poolFor("tired", "snoozed");
    expect(pool.length).toBeGreaterThanOrEqual(3);
    const seen: string[] = [];
    let m = mk(NOW);
    await m.load();
    for (let i = 0; i < pool.length; i++) seen.push(m.say("snoozed", {}, "tired")!);
    expect(new Set(seen).size).toBe(pool.length);
    const first = seen[0];
    await w.repo().exec(m.ops());
    // тот же день, новая сессия: помнит
    m = mk(NOW + 5 * MINUTE);
    await m.load();
    expect(Object.keys(m.styleState.rl ?? {}).length).toBe(pool.length);
    // через 15 дней — память сошла
    m = mk(NOW + 15 * DAY);
    await m.load();
    expect(m.say("snoozed", {}, "tired")).toBe(first);
    // сжатие: не растёт без предела
    expect(Object.keys(m.styleState.rl ?? {}).length).toBeLessThanOrEqual(300);
  });
});

describe("серия дней и достижения (чистые функции)", () => {
  const D = 20000;
  const fresh = (): StyleState => emptyStyleState();
  const run = (steps: { day: number; onTime?: boolean; ageDays?: number }[]) => {
    let st = fresh();
    const out: (string | null)[] = [];
    for (const s of steps) {
      const r = noteDone(st, { day: s.day, onTime: s.onTime ?? true, ageDays: s.ageDays ?? 0 });
      st = r.state;
      out.push(r.achievement);
    }
    return { st, out };
  };

  it("хорошая серия: заметка на третий день подряд, не на первый и не на второй", () => {
    expect(run([{ day: D }, { day: D + 1 }, { day: D + 2 }]).out).toEqual([null, null, "good_streak"]);
  });
  it("второе «Готово» в тот же день серию не растит; пропущенный день сбрасывает", () => {
    expect(run([{ day: D }, { day: D }, { day: D + 1 }, { day: D + 1 }]).st.ot).toEqual({ d: D + 1, n: 2 });
    expect(run([{ day: D }, { day: D + 1 }, { day: D + 3 }]).st.ot).toEqual({ d: D + 3, n: 1 });
  });
  it("пропуск обнуляет серию", () => {
    let st = run([{ day: D }, { day: D + 1 }]).st;
    st = noteMiss(st, D + 1);
    expect(st.ot).toBeUndefined();
    expect(noteDone(st, { day: D + 2, onTime: true, ageDays: 0 }).state.ot).toEqual({ d: D + 2, n: 1 });
  });
  it("с опозданием серию не растит и не рвёт", () => {
    const st = run([{ day: D }, { day: D + 1, onTime: false }]).st;
    expect(st.ot).toEqual({ d: D, n: 1 });
  });
  it("7 дней подряд всё вовремя: достижение на седьмой день (заметка серии на третий уже была)", () => {
    const steps = Array.from({ length: 7 }, (_, i) => ({ day: D + i }));
    const { out } = run(steps);
    expect(out[2]).toBe("good_streak");
    expect(out[6]).toBe("week_ontime");
    expect(out.filter((x, i) => x && i !== 2 && i !== 6)).toEqual([]);
  });
  it("давний хвост: закрыто дело, висевшее 7 дней и больше", () => {
    expect(run([{ day: D, onTime: false, ageDays: 7 }]).out).toEqual(["tail"]);
    expect(run([{ day: D, onTime: false, ageDays: 6 }]).out).toEqual([null]);
    expect(run([{ day: D, onTime: false, ageDays: 40 }]).out).toEqual(["tail"]);
  });
  it("особая реплика не чаще одной в сутки (счётчики при этом считаются)", () => {
    const first = noteDone(fresh(), { day: D, onTime: false, ageDays: 30 });
    expect(first.achievement).toBe("tail");
    const second = noteDone(first.state, { day: D, onTime: false, ageDays: 31 });
    expect(second.achievement).toBeNull();
  });
  it("заметка о серии не чаще раза в 7 дней", () => {
    const steps = [{ day: D }, { day: D + 1 }, { day: D + 2 }, { day: D + 3 }, { day: D + 5 }, { day: D + 6 }, { day: D + 7 }];
    // серия рвётся на D+5; новая доходит до 3 на D+7 — всего 5 дней после первой заметки
    expect(run(steps).out.filter((x) => x === "good_streak")).toHaveLength(1);
  });

  it("неделя без «Висит»: наблюдение раз в день; первое — точка отсчёта; через 7 чистых дней — достижение один раз", () => {
    let st = fresh();
    const r0 = observeHot(st, { day: D, hot: 0 });
    expect(r0.achievement).toBeNull();
    expect(r0.state.cl).toBe(D);
    st = r0.state;
    expect(observeHot(st, { day: D + 6, hot: 0 }).achievement).toBeNull();
    const r7 = observeHot(st, { day: D + 7, hot: 0 });
    expect(r7.achievement).toBe("week_clean");
    expect(observeHot(r7.state, { day: D + 8, hot: 0 }).achievement).toBeNull(); // повторно не награждаем
    expect(observeHot(r7.state, { day: D + 14, hot: 0 }).achievement).toBeNull();
  });
  it("«Висит» сбрасывает отсчёт; пропуск в cron — тоже", () => {
    let st = observeHot(fresh(), { day: D, hot: 0 }).state;
    st = observeHot(st, { day: D + 4, hot: 2 }).state;
    expect(st.cl).toBe(D + 4);
    expect(observeHot(st, { day: D + 7, hot: 0 }).achievement).toBeNull();
    expect(observeHot(st, { day: D + 11, hot: 0 }).achievement).toBe("week_clean");
    expect(noteMiss(st, D + 6).cl).toBe(D + 6);
  });
});

describe("дни рождения: заготовка под этап 5", () => {
  it("список «Имя месяц.день» читается; в базу идут только имя и дата", () => {
    const people = parsePeopleDates("Мама 11.20\nАндрей 3.5.1990\nплохая строка\nТётя Лена 12.31");
    expect(people).toEqual([
      { name: "Мама", mo: 11, d: 20 },
      { name: "Андрей", mo: 3, d: 5 },
      { name: "Тётя Лена", mo: 12, d: 31 },
    ] satisfies Person[]);
    expect(parsePeopleDates("")).toEqual([]);
  });
  it("повод на сегодня: день рождения человека из списка — в день, за день и за неделю; хозяина и праздник — как раньше", () => {
    const people: Person[] = [{ name: "Мама", mo: 11, d: 20 }];
    const o0 = occasionFor({ y: 2026, mo: 11, d: 20 }, null, people);
    expect(o0?.situation).toBe("holiday");
    expect(o0?.label).toContain("Мама");
    expect(occasionFor({ y: 2026, mo: 11, d: 19 }, null, people)?.situation).toBe("birthday_soon");
    expect(occasionFor({ y: 2026, mo: 11, d: 13 }, null, people)?.label).toContain("Мама");
    expect(occasionFor({ y: 2026, mo: 11, d: 10 }, null, people)).toBeNull();
    expect(occasionFor({ y: 2026, mo: 12, d: 25 }, null, people)?.label).toBe("Рождество");
    expect(occasionFor({ y: 2026, mo: 11, d: 20 }, { mo: 11, d: 20 })?.label).toContain("хозяина");
  });
});

// ---------- в боте ----------

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

async function run(now: number, rand: () => number = () => 0) {
  const repo = w.repo(100);
  return runCron({
    repo,
    api: countedApi(w.discord, repo.counter),
    now,
    env: {},
    rand,
    fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
  });
}
async function call(i: Partial<Interaction>, now = NOW): Promise<any> {
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
    { repo: w.repo(100), api: w.discord, now, env: {}, rand: () => 0, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r;
}
const click = (custom_id: string, now = NOW) => call({ type: 3, data: { custom_id }, message: { id: "m1" } }, now);
const cmd = (name: string, options: { name: string; value: string | number }[] = [], now = NOW) => call({ type: 2, data: { name, type: 1, options } }, now);
const submit = (custom_id: string, fields: Record<string, string>, now = NOW) =>
  call({ type: 5, data: { custom_id, components: Object.entries(fields).map(([id, value]) => ({ type: 18, component: { type: 4, custom_id: id, value } })) } }, now);
const mood = () => w.d1.q<Record<string, any>>("SELECT * FROM mood_state WHERE user_id = ?", OWNER)[0];
const style = (): StyleState => parseStyleState(mood()?.style_data);
const meta = (k: string) => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const setOcc = (id: number, patch: Record<string, number | string | null>) => {
  const keys = Object.keys(patch);
  w.d1.q(`UPDATE occurrences SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
};

beforeEach(async () => {
  w = new World();
  pending = [];
  seq = 0;
  await w.seed({ today: true, intake: true, settings: { mood_on: "1", style_level: "0", summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

describe("пятое откладывание", () => {
  it("на пятом откладывании (окно «Отложить на…») — реплика из особого пула; на четвёртом — обычная «отложено»", async () => {
    const { occId } = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    setOcc(occId, { snooze_count: 3 });
    const at = min(6);
    const four = await submit(`m_snz:${occId}`, { quick: "tom", text: "" }, at);
    const fourLine = String(four.data.content).split(" **")[0];
    const anyPool = (sit: "snoozed" | "snooze_5") => Object.keys(PHRASES).some((m) => fromPool(fourLine, PHRASES[m][sit] ?? []));
    expect(anyPool("snooze_5")).toBe(false);
    expect(anyPool("snoozed")).toBe(true);
    const five = await submit(`m_snz:${occId}`, { quick: "tom", text: "" }, at);
    const fiveLine = String(five.data.content).split(" **")[0];
    expect(w.occ(occId).snooze_count).toBe(5);
    expect(fiveLine.length).toBeGreaterThan(3);
    expect(["tired", "tsundere", "proud", "sulking", "sleepy"].some((m) => fromPool(fiveLine, PHRASES[m].snooze_5 ?? []))).toBe(true);
  });

  it("вопрос «что делаем?» на пятом откладывании тоже с репликой; на третьем — без", async () => {
    const { occId } = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    setOcc(occId, { snooze_count: 2 });
    const third = await click(`snz:${occId}:15`, min(6));
    expect(String(third.data.content)).toContain("3-й раз");
    expect(String(third.data.content).startsWith("Откладываешь")).toBe(true); // без фразы
    setOcc(occId, { snooze_count: 4 });
    const fifth = await click(`snz:${occId}:15`, min(6));
    expect(String(fifth.data.content)).toContain("5-й раз");
    expect(String(fifth.data.content).startsWith("Откладываешь")).toBe(false); // фраза впереди, вопрос тот же
    expect(String(fifth.data.content)).toContain("Откладываешь «Оплатить счёт» в 5-й раз. Что делаем?");
  });

  it("серьёзное дело или слово-флаг: пятое откладывание без шуток", async () => {
    const { occId } = await w.create("через 5 минут важно оплатить счёт");
    await run(min(5));
    setOcc(occId, { snooze_count: 4 });
    const r = await submit(`m_snz:${occId}`, { quick: "tom", text: "" }, min(6));
    expect(String(r.data.content)).toMatch(/^Отложено:/); // серьёзное — обычная строка без фразы
  });
});

describe("«тихий день»", () => {
  const say = (text: string) => w.discord.say(CH_BOT, OWNER, text);

  it("слово в канале «бот»: ответ «Хорошо. Сегодня потише.», сутки без реплик, дела не создаётся", async () => {
    await run(min(0)); // запоминает конец канала
    say("тихий день");
    await run(min(1));
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    const msgs = w.discord.live(CH_BOT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body.content).toBe(QUIET_ON_REPLY);
    expect(Number(meta("quiet_day_until"))).toBe(min(1) + QUIET_DAY_MS);
  });

  it("в тихий день напоминание приходит как обычно, но без реплики и карточки; пропуск всё равно считается", async () => {
    await w.repo().exec([setMeta("quiet_day_until", String(min(0) + QUIET_DAY_MS))]);
    const { occId } = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const body = w.discord.live(CH_REMIND)[0].body;
    expect(String(body.content)).toContain("**Оплатить счёт**");
    expect(body.embeds).toBeUndefined();
    for (const m of [10, 20, 40, 120]) await run(min(5 + m));
    expect(w.occ(occId).state).toBe("overdue");
    expect(mood().miss_streak).toBe(1);
    expect(w.discord.live(CH_REMIND)[0].body.embeds).toBeUndefined();
  });

  it("в тихий день «спасибо» и аниме-слова остаются без ответа; обычное дело записывается", async () => {
    await w.repo().exec([setMeta("quiet_day_until", String(min(0) + QUIET_DAY_MS)), setSetting("style_level", "1")]);
    await run(min(0));
    say("спасибо");
    say("ара-ара");
    await run(min(1));
    expect(w.discord.live(CH_BOT)).toHaveLength(0);
    say("завтра в 10 позвонить маме");
    await run(min(2));
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(1);
  });

  it("кнопка «Готово» в тихий день: без реплики, счётчики идут", async () => {
    await w.repo().exec([setMeta("quiet_day_until", String(min(0) + QUIET_DAY_MS))]);
    const { occId } = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const r = await click(`done:${occId}`, min(6));
    expect(String(r.data.content).startsWith("Готово: Оплатить счёт")).toBe(true);
    expect(r.data.embeds ?? []).toHaveLength(0);
    expect(mood().done_streak).toBe(1);
  });

  it("/mood показывает, что тихий день идёт, и как его снять; без него строки нет", async () => {
    expect(card((await cmd("mood")).data)).not.toContain("Тихий день");
    await w.repo().exec([setMeta("quiet_day_until", String(NOW + QUIET_DAY_MS))]);
    const text = card((await cmd("mood")).data);
    expect(text).toContain("Тихий день: Хару молчит до");
    expect(text).toContain("хватит тихого дня");
  });

  it("старые приписки «уставшей горничной» в тихий день тоже молчат; кнопка «Характер» переключает настоящее значение", async () => {
    await w.repo().exec([setSetting("character", "maid")]);
    const loud = String((await cmd("list")).data.content);
    expect(loud.split(String.fromCharCode(10)).length).toBeGreaterThan(1); // пустой список: реплика Хару под текстом
    await w.repo().exec([setMeta("quiet_day_until", String(NOW + QUIET_DAY_MS))]);
    const quiet = String((await cmd("list")).data.content);
    expect(quiet.trim()).toBe("Открытых дел нет.");
    await click("mn:tg:ch:c"); // переключает записанное значение (maid → neutral), а не временное
    expect((await w.settings()).character).toBe("neutral");
  });

  it("через сутки характер возвращается сам", async () => {
    await w.repo().exec([setMeta("quiet_day_until", String(min(0) + QUIET_DAY_MS))]);
    await w.create("через 5 минут оплатить счёт", min(0) + QUIET_DAY_MS + 60 * MINUTE);
    await run(min(0) + QUIET_DAY_MS + 65 * MINUTE);
    expect(said(w.discord.live(CH_REMIND)[0].body).length).toBeGreaterThan(3); // фраза Хару в тексте снова есть
  });

  it("«хватит тихого дня» снимает тишину досрочно; ответ — голосом Хару", async () => {
    await w.repo().exec([setMeta("quiet_day_until", String(min(0) + QUIET_DAY_MS))]);
    await run(min(0));
    say("хватит тихого дня");
    await run(min(1));
    expect(w.discord.live(CH_BOT)[0].body.content).toBe(QUIET_OFF_REPLY);
    expect(Number(meta("quiet_day_until") ?? 0)).toBe(0);
  });

  it("сводка в тихий день идёт без реплики Хару", async () => {
    const withLine = new World();
    await withLine.seed({ today: true, settings: { mood_on: "1", character: "maid", style_level: "0", summary_morning: "08:00", summary_evening: "off", weekly: "off" } });
    const without = new World();
    await without.seed({ today: true, settings: { mood_on: "0", summary_morning: "08:00", summary_evening: "off", weekly: "off" } });
    await withLine.repo().exec([setMeta("quiet_day_until", String(NOW + DAY))]);
    const morning = NOW - 4 * 60 * MINUTE + 5 * MINUTE; // 08:05
    for (const x of [withLine, without]) {
      const repo = x.repo(100);
      await runCron({ repo, api: countedApi(x.discord, repo.counter), now: morning, env: {}, rand: () => 0, fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
    }
    const onlySummary = (x: World) => x.discord.live(CH_REMIND).map((m) => m.body.content).filter((c) => String(c).includes("Сводка на сегодня"));
    const a = onlySummary(withLine);
    const b = onlySummary(without);
    expect(a.length).toBe(1);
    expect(a).toEqual(b);
  });

  it("тишина не трогает время напоминаний: те же срабатывания, что и без неё и при любой «случайности»", async () => {
    const sched = async (setup: (x: World) => Promise<unknown>, rand: () => number) => {
      w = new World();
      await w.seed({ today: true, intake: true, settings: { mood_on: "1", style_level: "0", summary_morning: "off", summary_evening: "off", weekly: "off" } });
      await setup(w);
      const { occId } = await w.create("через 5 минут оплатить счёт");
      for (const m of [5, 15, 25, 45, 125, 245]) await run(min(m), rand);
      const o = w.occ(occId);
      return [o.state, o.fire_count, o.next_fire_at, w.discord.live(CH_REMIND).length];
    };
    const base = await sched(async () => {}, () => 0);
    expect(await sched(async () => {}, () => 0.99)).toEqual(base);
    expect(await sched(async (x) => x.repo().exec([setMeta("quiet_day_until", String(min(0) + QUIET_DAY_MS))]), () => 0.5)).toEqual(base);
  });
});

describe("яндере и серьёзные темы в боте", () => {
  it("яндере на напоминании говорит словами цундере, а на пропуске — своими", async () => {
    await cmd("mood", [{ name: "set", value: "yandere" }]);
    const { occId } = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    const first = said(w.discord.live(CH_REMIND)[0].body);
    expect(fromPool(first, PHRASES.yandere.reminder ?? [])).toBe(false);
    expect(first.length).toBeGreaterThan(3);
    for (const m of [10, 20, 40, 120]) await run(min(5 + m));
    expect(w.occ(occId).state).toBe("overdue");
    const missed = said(w.discord.live(CH_REMIND)[0].body);
    expect(fromPool(missed, PHRASES.yandere.missed ?? []) || fromPool(missed, PHRASES.yandere.missed_first ?? [])).toBe(true);
  });

  it("слово «важно» или «серьёзно» в названии: без реплики и без реакции", async () => {
    await w.create("через 5 минут важно оплатить счёт");
    await w.create("через 5 минут серьёзно позвонить в банк");
    await w.create("через 5 минут купить хлеб");
    await run(min(5));
    const bodies = w.discord.live(CH_REMIND).map((m) => m.body);
    expect(bodies).toHaveLength(3);
    const voiced = bodies.filter((b) => said(b).length > 3);
    expect(voiced).toHaveLength(1);
    expect(String(voiced[0].content)).toContain("Купить хлеб");
  });
});

describe("достижения в боте", () => {
  it("давний хвост: «Готово» по делу, висевшему больше недели, — реплика достижения", async () => {
    const { occId } = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    setOcc(occId, { state: "overdue", due_at: min(5) - 9 * DAY, base_at: min(5) - 9 * DAY });
    const r = await click(`done:${occId}`, min(6));
    const line = said(r.data);
    expect(["tired", "tsundere", "proud", "sulking", "sleepy", "yandere"].some((m) => fromPool(line, PHRASES[m].achieve_tail ?? []))).toBe(true);
    expect(style().ac?.any).toBe(dayNumber(localDate(min(6), "Europe/Kyiv")));
  });

  it("три дня подряд вовремя: на третьем — заметка о серии; счётчик дней в базе", async () => {
    const lines: string[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = NOW + k * DAY;
      const { occId } = await w.create("через 5 минут оплатить счёт", t0);
      await run(t0 + 5 * MINUTE);
      const r = await click(`done:${occId}`, t0 + 6 * MINUTE);
      lines.push(said(r.data));
    }
    expect(style().ot?.n).toBe(3);
    const isStreak = (s: string) => Object.keys(PHRASES).some((m) => fromPool(s, PHRASES[m].good_streak ?? []));
    expect(isStreak(lines[0])).toBe(false);
    expect(isStreak(lines[1])).toBe(false);
    expect(isStreak(lines[2])).toBe(true);
  });

  it("пропуск в cron обнуляет серию дней и начало «недели без Висит»", async () => {
    const a = await w.create("через 5 минут оплатить счёт");
    await run(min(5));
    await click(`done:${a.occId}`, min(6));
    expect(style().ot?.n).toBe(1);
    await w.create("через 5 минут позвонить", min(10));
    for (const m of [0, 10, 20, 40, 120]) await run(min(15 + m));
    expect(style().ot).toBeUndefined();
    expect(style().cl).toBe(dayNumber(localDate(min(135), "Europe/Kyiv")));
  });

  it("неделя без «Висит»: утренняя сводка через 7 чистых дней — реплика достижения под сводкой, один раз", async () => {
    w = new World();
    await w.seed({ today: true, settings: { mood_on: "1", style_level: "0", summary_morning: "08:00", summary_evening: "off", weekly: "off" } });
    const at = (k: number) => NOW - 4 * 60 * MINUTE + 5 * MINUTE + k * DAY; // 08:05 по Киеву
    const morning = async (k: number) => {
      await run(at(k));
      const l = w.discord.live(CH_REMIND).filter((m) => String(m.body.content).includes("Сводка на сегодня"));
      return String(l[l.length - 1].body.content);
    };
    await morning(0);
    for (const k of [1, 2, 3, 4, 5, 6]) await morning(k);
    const seventh = await morning(7);
    const isWeek = (s: string) => Object.keys(PHRASES).some((m) => (PHRASES[m].achieve_week_clean ?? []).some((p) => s.includes(p.replace(/\{user\}.*/, "").slice(0, 8))));
    expect(isWeek(seventh)).toBe(true);
    const eighth = await morning(8);
    expect(isWeek(eighth)).toBe(false);
  });
});

describe("пулы фраз этапа 2", () => {
  const SITS: Situation[] = ["snooze_5", "good_streak", "achieve_tail", "achieve_week_clean", "achieve_week_ontime"];
  it("для каждой новой ситуации есть фразы у всех настроений, кроме яндере (там только пропуск), и без повторов", () => {
    for (const s of SITS) {
      for (const m of ["tired", "tsundere", "sulking", "proud", "sleepy"]) {
        const pool = PHRASES[m][s] ?? [];
        expect(pool.length, `${m}.${s}`).toBeGreaterThanOrEqual(3);
        expect(new Set(pool.map((x) => x.toLowerCase())).size).toBe(pool.length);
      }
    }
  });
  it("фразы без латиницы и без «хозяин, хозяин»; не длиннее 160 знаков", () => {
    for (const s of SITS) for (const m of Object.keys(PHRASES)) for (const t of PHRASES[m][s] ?? []) {
      expect(t.replace(/\{[a-z_]+\}/g, ""), t).not.toMatch(/[A-Za-z]/);
      expect(t.length, t).toBeLessThanOrEqual(160);
    }
  });
});
