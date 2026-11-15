// Пакет «оживление» (2026-11-15): вес дела (мелочь / обычное / главное), образы дня, дождь и погода голосом Хару, дополнение пулов фраз.
// Повод — слова владельца: «выключить чайник» пять раз в день не должно хвалиться так же, как «поздравить маму»; а пропущенный день рождения должен бить сильнее.
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { MOOD_CONFIG } from "../src/personality/config.ts";
import { MINOR_DONE_LINE_CHANCE } from "../src/personality/director.ts";
import { type MoodState, initialState, step } from "../src/personality/moodEngine.ts";
import { PERSONAS } from "../src/personality/persona.ts";
import { ADDITION_GROUPS, PHRASES, PHRASES_BASE, SITUATIONS, type Situation } from "../src/personality/phrases.ts";
import { GROUP_SPEC, RAIN_NEED, WEIGHT_NEED } from "../src/personality/poolSpec.ts";
import { integrityProblems, lintPhrase } from "../src/personality/poolCheck.ts";
import { WEATHER_REPLY } from "../src/weatherAsk.ts";
import { WEIGHT_WORDS, type WeightInput, weightMark, weightOf } from "../src/personality/weight.ts";
import { parseInput } from "../src/time/parse.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, TZ } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const min = (n: number) => NOW + n * MINUTE;
const OPTS = { now: NOW, tz: TZ };
const w0 = (o: Partial<WeightInput> & { title: string }): WeightInput => ({ item_kind: "reminder", ...o });

// ---------- чистые части ----------

describe("вес дела: что бот решает сам", () => {
  it("важное: даты, близкие, поездки, платежи, «критично»", () => {
    for (const t of ["Поздравить маму с днём рождения", "Купить подарок", "годовщина свадьбы", "Оплатить счёт", "Заплатить за аренду", "Забрать паспорт", "Рейс в Варшаву", "Собеседование", "Продлить страховку"]) {
      expect(weightOf(w0({ title: t })), t).toBe("major");
    }
    expect(weightOf(w0({ title: "Позвонить", critical: 1 }))).toBe("major");
  });

  it("важное: у дела есть «заранее за N дней»", () => {
    expect(weightOf(w0({ title: "Созвон", rule_leads: "[7,1]" }))).toBe("major");
    expect(weightOf(w0({ title: "Созвон", rule_leads: "[]" }))).toBe("normal");
    expect(weightOf(w0({ title: "Созвон", rule_leads: "не json" }))).toBe("normal");
  });

  it("мелочь: быт «на ходу», таймеры и «каждый день» / «каждые N минут»", () => {
    for (const t of ["Выключить чайник", "Выключить утюг", "Закрыть окно", "Полить цветы", "Размяться", "Вынести мусор"]) {
      expect(weightOf(w0({ title: t })), t).toBe("minor");
    }
    expect(weightOf({ title: "Выпить воды", item_kind: "timer" })).toBe("minor");
    expect(weightOf(w0({ title: "Размять шею", rule_recipe: JSON.stringify({ freq: "hours", interval: 1 }) }))).toBe("minor");
    expect(weightOf(w0({ title: "Прогулка", rule_recipe: JSON.stringify({ freq: "days", interval: 1 }) }))).toBe("minor");
  });

  it("обычное: остальное, в том числе «раз в неделю» и «раз в два дня»", () => {
    for (const t of ["Купить хлеб", "Позвонить маме", "Разобрать почту", "Купить чайник", "Купить утюг", "Починить форточку"]) expect(weightOf(w0({ title: t })), t).toBe("normal");
    expect(weightOf(w0({ title: "Уборка", rule_recipe: JSON.stringify({ freq: "weeks", interval: 1 }) }))).toBe("normal");
    expect(weightOf(w0({ title: "Зарядка", rule_recipe: JSON.stringify({ freq: "days", interval: 2 }) }))).toBe("normal");
    expect(weightOf(w0({ title: "Зарядка", rule_recipe: "{" }))).toBe("normal");
  });

  it("порядок: метка хозяина главнее всего; важное перебивает рутину; «каждый год поздравить» остаётся важным", () => {
    expect(weightOf(w0({ title: "Поздравить маму", item_weight: 1 }))).toBe("minor");
    expect(weightOf(w0({ title: "Выключить чайник", item_weight: 2 }))).toBe("major");
    expect(weightOf(w0({ title: "Купить хлеб", item_weight: 0 }))).toBe("normal");
    expect(weightOf(w0({ title: "Поздравить маму", rule_recipe: JSON.stringify({ freq: "days", interval: 1 }) }))).toBe("major");
    expect(weightOf(w0({ title: "Выключить чайник", rule_leads: "[1]" }))).toBe("major");
  });

  it("названия весов и выбор в окне «Изменить»", () => {
    expect(WEIGHT_WORDS).toEqual({ minor: "мелочь", normal: "обычное", major: "главное" });
    expect(weightMark("auto")).toBe(0);
    expect(weightMark("minor")).toBe(1);
    expect(weightMark("major")).toBe(2);
    for (const other of ["keep", "plain", "styled", "", "weird"]) expect(weightMark(other)).toBeNull();
  });
});

describe("вес дела: слова хозяина «мелочь» и «главное»", () => {
  it("«главное» в любом месте: метка стирается из названия", () => {
    const p = parseInput("главное: поздравить маму завтра в 10", OPTS);
    expect(p.weight).toBe("major");
    expect(p.title).toBe("Поздравить маму");
    expect(parseInput("позвонить, главное, завтра в 10", OPTS).weight).toBe("major");
  });

  it("«мелочь» и «пустяк» — только как метка в начале или в конце", () => {
    expect(parseInput("мелочь: выключить чайник завтра в 10", OPTS)).toMatchObject({ weight: "minor", title: "Выключить чайник" });
    expect(parseInput("выключить чайник завтра в 10 (мелочь)", OPTS)).toMatchObject({ weight: "minor", title: "Выключить чайник" });
    expect(parseInput("пустяк, полить цветы завтра в 10", OPTS)).toMatchObject({ weight: "minor", title: "Полить цветы" });
    // слово внутри обычной фразы не метка: «купить мелочь» остаётся делом
    const p = parseInput("купить мелочь на проезд завтра в 10", OPTS);
    expect(p.weight).toBeUndefined();
    expect(p.title).toBe("Купить мелочь на проезд");
  });

  it("«с днём рождения» остаётся в названии (раньше «днём» съедалось как время суток), а «завтра днём» по-прежнему 13:00", () => {
    expect(parseInput("поздравить маму с днём рождения завтра в 10", OPTS).title).toBe("Поздравить маму с днём рождения");
    expect(parseInput("поздравить с Днём Победы завтра в 10", OPTS).title).toBe("Поздравить с Днём Победы");
    const day = parseInput("позвонить завтра днём", OPTS);
    expect(day.title).toBe("Позвонить");
    expect(day.due).toBe(parseInput("позвонить завтра в 13:00", OPTS).due);
  });

  it("без метки поля нет; на время, повтор и «критично» метка не влияет", () => {
    expect(parseInput("купить хлеб завтра в 10", OPTS).weight).toBeUndefined();
    const a = parseInput("мелочь: купить хлеб завтра в 10", OPTS);
    const b = parseInput("купить хлеб завтра в 10", OPTS);
    expect(a.due).toBe(b.due);
    expect(parseInput("главное критично позвонить завтра в 10", OPTS)).toMatchObject({ weight: "major", critical: true });
  });
});

describe("вес дела в движке настроения", () => {
  const cfg = MOOD_CONFIG;
  const fresh = (over: Partial<MoodState> = {}): MoodState => ({ ...initialState(NOW), lastActivity: NOW, ...over });
  const ctx = { now: NOW, isNight: () => false, dayKey: "2026-11-07" }; // тот же момент, что у состояния: спад за время в этих проверках не мешает

  it("обычный пропуск как раньше: серия +1, раздражение +15, симпатия −2", () => {
    const r = step(fresh(), { type: "miss" }, ctx).state;
    expect(r.missStreak).toBe(1);
    expect(r.irritation).toBeCloseTo(10 + 15, 5);
    expect(r.affection).toBeCloseTo(50 - 2, 5);
    expect(step(fresh(), { type: "miss", weight: "normal" }, ctx).state.missStreak).toBe(1);
  });

  it("пропуск мелочи почти не злит и серий не трогает: ни пропусков, ни сброса «подряд»", () => {
    const r = step(fresh({ doneStreak: 5 }), { type: "miss", weight: "minor" }, ctx);
    expect(r.state.missStreak).toBe(0);
    expect(r.state.doneStreak).toBe(5);
    expect(r.state.irritation).toBeCloseTo(10 + cfg.weights.minor.miss.irritation, 5);
    expect(r.state.mood).toBe("tired"); // не цундере: чайник не повод
    expect(r.change).toBeNull();
  });

  it("пропуск важного бьёт сильно: сразу цундере, серия +2, раздражение +30, симпатия −5", () => {
    const r = step(fresh({ doneStreak: 5 }), { type: "miss", weight: "major" }, ctx);
    expect(r.state.missStreak).toBe(2);
    expect(r.state.doneStreak).toBe(0);
    expect(r.state.irritation).toBeCloseTo(10 + 30, 5);
    expect(r.state.affection).toBeCloseTo(50 - 5, 5);
    expect(r.state.mood).toBe("tsundere");
  });

  it("два пропуска важного подряд — уже яндере; один важный и один обычный — тоже (серия 3)", () => {
    const a = step(step(fresh(), { type: "miss", weight: "major" }, ctx).state, { type: "miss", weight: "major" }, ctx).state;
    expect(a.mood).toBe("yandere");
    const b = step(step(fresh(), { type: "miss", weight: "major" }, ctx).state, { type: "miss" }, ctx).state;
    expect(b.missStreak).toBe(3);
    expect(b.mood).toBe("yandere");
  });

  it("«Готово» по мелочи: серия выполненных не растёт, серия пропусков не гаснет, яндере не успокаивается, раздражение чуть отпускает", () => {
    const base = fresh({ missStreak: 3, irritation: 60, mood: "yandere", moodSince: NOW });
    const r = step(base, { type: "done", onTime: true, weight: "minor" }, ctx);
    expect(r.state.doneStreak).toBe(0);
    expect(r.state.missStreak).toBe(3);
    expect(r.state.yandereCleared).toBe(false);
    expect(r.state.mood).toBe("yandere");
    expect(r.state.irritation).toBeLessThan(60);
    expect(r.milestone).toBeNull();
    expect(r.relief).toBe(false);
  });

  it("пять «Готово» по мелочи подряд не дают ни серии, ни особой похвалы", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++) {
      const r = step(s, { type: "done", onTime: true, weight: "minor" }, { ...ctx, now: ctx.now + i * 10 * MINUTE });
      expect(r.milestone).toBeNull();
      s = r.state;
    }
    expect(s.doneStreak).toBe(0);
    expect(s.mood).toBe("tired");
  });

  it("«Готово» по важному считается за два и греет сильнее: серия +2, симпатия +6", () => {
    const r = step(fresh(), { type: "done", onTime: true, weight: "major" }, ctx).state;
    expect(r.doneStreak).toBe(2);
    expect(r.affection).toBeCloseTo(50 + 6, 5);
    const n = step(fresh(), { type: "done", onTime: true }, ctx).state;
    expect(n.doneStreak).toBe(1);
    expect(n.affection).toBeCloseTo(50 + 3, 5);
  });

  it("серия шагает через две ступени — отметка похвалы не пропадает (ловим пересечение, а не точное совпадение)", () => {
    // было 2, важное → 4: пересекли отметку 3
    const r = step(fresh({ doneStreak: 2 }), { type: "done", onTime: true, weight: "major" }, ctx);
    expect(r.state.doneStreak).toBe(4);
    expect(r.milestone).toBe(3);
    // было 5, важное → 7: ровно отметка 7
    expect(step(fresh({ doneStreak: 5 }), { type: "done", onTime: true, weight: "major" }, ctx).milestone).toBe(7);
    // было 3, важное → 5: отметок на пути нет
    expect(step(fresh({ doneStreak: 3 }), { type: "done", onTime: true, weight: "major" }, ctx).milestone).toBeNull();
    // обычная серия как раньше: ровно на 3
    expect(step(fresh({ doneStreak: 2 }), { type: "done", onTime: true }, ctx).milestone).toBe(3);
  });

  it("важное, сделанное после яндере: яндере успокаивается через цундере, как и обычное", () => {
    const base = fresh({ missStreak: 4, irritation: 70, mood: "yandere", moodSince: NOW });
    const r = step(base, { type: "done", onTime: false, weight: "major" }, ctx);
    expect(r.state.missStreak).toBe(0);
    expect(r.state.mood).toBe("tsundere"); // флаг «можно выходить» сработал и сразу снят: она уже вышла
    expect(r.change).toMatchObject({ from: "yandere", to: "tsundere" });
    expect(r.relief).toBe(true);
  });

  it("важное, сделанное с опозданием, отпускает раздражение сильнее обычного: после пропуска главного она не ворчит сутками", () => {
    const missed = step(fresh(), { type: "miss", weight: "major" }, ctx).state; // раздражение 40, цундере
    const later = { ...ctx, now: ctx.now + 40 * MINUTE };
    const late = step(missed, { type: "done", onTime: false, weight: "major" }, later).state;
    const lateNormal = step(missed, { type: "done", onTime: false }, later).state;
    expect(late.irritation).toBeLessThan(lateNormal.irritation - 5);
    expect(late.missStreak).toBe(0);
    expect(late.doneStreak).toBe(0); // с опозданием серию вовремя не растим
    expect(late.mood).toBe("tired"); // раздражение ниже порога, держать цундере нечем
  });
});

// ---------- пулы фраз ----------

describe("пакет «оживление»: пулы фраз", () => {
  it("все новые фразы проходят правила poolCheck: ни одной ОШИБКИ", () => {
    const bad: string[] = [];
    for (const [group, bank] of Object.entries(ADDITION_GROUPS)) {
      for (const [voice, sits] of Object.entries(bank)) {
        for (const [sit, list] of Object.entries(sits)) {
          for (const t of list ?? []) for (const i of lintPhrase(t, voice, sit)) if (i.severity === "error") bad.push(`${group} ${voice}.${sit} ${i.code}: ${t}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("в каждом файле только свои голоса и ситуации; по каждой паре хватает фраз; сводный набор целостен", () => {
    for (const [group, spec] of Object.entries(GROUP_SPEC)) {
      const bank = ADDITION_GROUPS[group];
      expect(Object.keys(bank).sort(), group).toEqual(Object.keys(spec).sort());
      for (const [voice, need] of Object.entries(spec)) {
        for (const [sit, n] of Object.entries(need) as [Situation, number][]) {
          expect(PHRASES[voice]?.[sit]?.length ?? 0, `${group} ${voice}.${sit}`).toBeGreaterThanOrEqual(n);
        }
        // файл группы не залезает в чужие ситуации
        for (const sit of Object.keys(bank[voice] ?? {})) expect(Object.keys(need), `${group} ${voice}.${sit}`).toContain(sit);
      }
    }
    expect(integrityProblems(PHRASES)).toEqual([]);
  });

  it("у каждого образа дня есть костяк повседневных ситуаций; новые ситуации есть в общем списке", () => {
    for (const p of PERSONAS) {
      for (const sit of ["reminder", "reminder_repeat", "missed", "done", "greeting", "recorded", "snoozed", "summary_morning", "summary_evening", "empty_list"] as Situation[]) {
        expect(PHRASES[p][sit]?.length ?? 0, `${p}.${sit}`).toBeGreaterThanOrEqual(4);
      }
    }
    for (const s of ["missed_minor", "done_minor", "missed_major", "done_major", "rain_start", "rain_end", "rain_early", "weather_ask"] as Situation[]) expect(SITUATIONS).toContain(s);
  });

  it("короткие пулы шести настроений доросли до десяти: «Записано», сводки, «Отложено», «Спасибо» и остальное не крутятся по кругу", () => {
    for (const mood of ["tired", "tsundere", "sulking", "proud", "sleepy"]) {
      for (const sit of ["recorded", "summary_morning", "summary_evening", "empty_list", "draft", "cancelled", "snoozed", "deleted", "reply_unknown", "snooze_5", "thanks", "missed_first", "good_streak"] as Situation[]) {
        expect(PHRASES[mood][sit]?.length ?? 0, `${mood}.${sit}`).toBeGreaterThanOrEqual(10);
      }
    }
    expect(PHRASES.yandere.missed_first?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("мелочь не хвалят всерьёз: в done_minor нет слов настоящей похвалы", () => {
    const praise = /(молодец|умница|великолепн|восхитительн|потрясающ|отличная работа|превосходн|горжусь)/iu;
    const loud: string[] = [];
    for (const voice of Object.keys(GROUP_SPEC.weight)) for (const t of PHRASES[voice]?.done_minor ?? []) if (praise.test(t)) loud.push(`${voice}: ${t}`);
    expect(loud).toEqual([]);
  });

  it("число новых фраз: пакет реально добавил голосов и разнообразия", () => {
    let added = 0;
    for (const bank of Object.values(ADDITION_GROUPS)) for (const sits of Object.values(bank)) for (const list of Object.values(sits)) added += list?.length ?? 0;
    expect(added).toBeGreaterThan(1000);
    // и сводный набор больше базового
    const total = (b: typeof PHRASES) => Object.values(b).reduce((a, s) => a + Object.values(s).reduce((x, l) => x + (l?.length ?? 0), 0), 0);
    expect(total(PHRASES) - total(PHRASES_BASE)).toBe(added);
  });

  it("в дожде вид осадков не назван; в weather_ask можно, и спецификация на месте", () => {
    for (const [voice, need] of Object.entries(GROUP_SPEC.rain)) {
      expect(need).toEqual(RAIN_NEED);
      for (const sit of ["rain_start", "rain_end", "rain_early"] as Situation[]) {
        for (const t of PHRASES[voice][sit] ?? []) expect(lintPhrase(t, voice, sit).filter((i) => i.code === "rain-kind"), `${voice}.${sit}: ${t}`).toEqual([]);
      }
    }
    expect(WEIGHT_NEED).toEqual({ missed_minor: 5, done_minor: 5, missed_major: 5, done_major: 5 });
  });
});

// ---------- в боте: cron, кнопки, окно «Изменить» ----------

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

/** cron с фиксированной «случайностью» (0): мелочь отзывается (0 < шанс), фразы предсказуемы */
async function run(now: number) {
  const repo = w.repo(100);
  return runCron({
    repo,
    api: countedApi(w.discord, repo.counter),
    now,
    env: {},
    rand: () => 0,
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
const submit = (custom_id: string, fields: Record<string, string | string[]>) =>
  call({
    type: 5,
    data: { custom_id, components: Object.entries(fields).map(([id, v]) => ({ type: 18, component: Array.isArray(v) ? { type: 3, custom_id: id, values: v } : { type: 4, custom_id: id, value: v } })) },
  });
const mood = () => w.d1.q<Record<string, any>>("SELECT * FROM mood_state WHERE user_id = ?", OWNER)[0];
const item = (occId: number) => w.d1.q<{ weight: number; title: string }>("SELECT i.weight, i.title FROM items i JOIN occurrences o ON o.item_id = i.id WHERE o.id = ?", occId)[0];

/** Текст реплики совпадает с одной из фраз пулов этой ситуации (у любого голоса): подстановки {user} и {task} — любым словом. */
const fromAnyPool = (text: string, sit: Situation): boolean =>
  Object.values(PHRASES).some((bank) =>
    (bank[sit] ?? []).some((p) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{user\}/g, "[^ ,.!?]+").replace(/\{task\}/g, ".+")}$`, "u").test(text.trim())),
  );
const firstLine = (b: { content?: string }): string => String(b.content ?? "").split("\n")[0].replace(/^<@\d+>\s*/, "").replace(/\s*\*\*[^*]+\*\*.*$/, "");
const OVERDUE_RUNS = [0, 10, 20, 40, 120];

describe("вес дела в боте", () => {
  beforeEach(async () => {
    w = new World();
    pending = [];
    seq = 0;
    // уровень 0: аниме-слой не дописывает слова и звуки, и реплику можно сверить с пулом дословно
    await w.seed({ today: true, intake: true, settings: { mood_on: "1", style_level: "0", summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });

  it("метка словами при создании сохраняется в базе: «мелочь» = 1, «главное» = 2, без метки = 0", async () => {
    const a = await w.create("мелочь: купить хлеб через 5 минут");
    const b = await w.create("главное: позвонить через 5 минут");
    const c = await w.create("через 5 минут разобрать почту");
    expect(item(a.occId)).toMatchObject({ weight: 1, title: "Купить хлеб" });
    expect(item(b.occId)).toMatchObject({ weight: 2, title: "Позвонить" });
    expect(item(c.occId).weight).toBe(0);
  });

  it("пропущенный день рождения: серия +2, цундере сразу, реплика из missed_major, карточка со спрайтом", async () => {
    const { occId } = await w.create("через 5 минут поздравить маму с днём рождения");
    for (const m of OVERDUE_RUNS) await run(min(5 + m));
    expect(w.occ(occId).state).toBe("overdue");
    expect(mood().miss_streak).toBe(2);
    expect(mood().current_mood).toBe("tsundere");
    expect(Number(mood().irritation)).toBeGreaterThanOrEqual(35);
    // сообщение о том, что дело стало «просрочено», — реплика именно про важное
    const posts = w.discord.posted.filter((p) => p.channel === CH_REMIND).map((p) => firstLine(p.body));
    expect(posts.some((t) => fromAnyPool(t, "missed_major"))).toBe(true);
  });

  it("пропущенный чайник: серия не растёт, настроение прежнее, раздражение +3; реплика из missed_minor", async () => {
    const { occId } = await w.create("через 5 минут выключить чайник");
    for (const m of OVERDUE_RUNS) await run(min(5 + m));
    expect(w.occ(occId).state).toBe("overdue");
    expect(mood().miss_streak).toBe(0);
    expect(mood().current_mood).toBe("tired");
    expect(Number(mood().irritation)).toBeLessThan(20);
    const posts = w.discord.posted.filter((p) => p.channel === CH_REMIND).map((p) => firstLine(p.body));
    expect(posts.some((t) => fromAnyPool(t, "missed_minor"))).toBe(true);
    expect(posts.some((t) => fromAnyPool(t, "missed_major"))).toBe(false);
  });

  it("обычное дело — как раньше: серия +1 и реплика не из «веса»", async () => {
    await w.create("через 5 минут разобрать почту");
    for (const m of OVERDUE_RUNS) await run(min(5 + m));
    expect(mood().miss_streak).toBe(1);
    const posts = w.discord.posted.filter((p) => p.channel === CH_REMIND).map((p) => firstLine(p.body));
    expect(posts.some((t) => fromAnyPool(t, "missed_minor") || fromAnyPool(t, "missed_major"))).toBe(false);
  });

  it("«Готово» по мелочи: серия 0, реплика из done_minor без похвалы (rand=0 — отозвалась)", async () => {
    const a = await w.create("через 5 минут выключить чайник");
    await run(min(5));
    const r = await click(`done:${a.occId}`, min(6));
    expect(mood().done_streak).toBe(0);
    const content = String(r.data.content);
    expect(content).toContain("**Выключить чайник** — готово");
    expect(fromAnyPool(firstLine(r.data), "done_minor")).toBe(true);
  });

  it("мелочь отзывается не всегда: при большом rand реплики нет, ответ — просто «готово»", async () => {
    expect(MINOR_DONE_LINE_CHANCE).toBeLessThan(0.5);
    const a = await w.create("через 5 минут выключить чайник");
    await run(min(5));
    const r = await handleInteraction(
      { id: "99", token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 3, data: { custom_id: `done:${a.occId}` }, message: { id: "m1" } } as Interaction,
      { repo: w.repo(100), api: w.discord, now: min(6), env: {}, rand: () => 0.99, defer: (p) => void pending.push(p) },
    );
    await Promise.all(pending.splice(0));
    expect(String((r as any).data.content).startsWith("Готово:")).toBe(true);
  });

  it("пять «Готово» по мелочам за день не растят серию и не вызывают «похвалу за серию»", async () => {
    for (let i = 0; i < 5; i++) {
      const a = await w.create(`через ${5 + i} минут выключить чайник`, min(i));
      await run(min(i + 5 + i + 1));
      await click(`done:${a.occId}`, min(i + 5 + i + 2));
    }
    expect(mood().done_streak).toBe(0);
    expect(mood().current_mood).toBe("tired");
  });

  it("«Готово» по важному вовремя: серия +2, реплика из done_major (тёплая)", async () => {
    const a = await w.create("через 5 минут поздравить маму с днём рождения");
    await run(min(5));
    const r = await click(`done:${a.occId}`, min(6));
    expect(mood().done_streak).toBe(2);
    expect(fromAnyPool(firstLine(r.data), "done_major") || fromAnyPool(firstLine(r.data), "streak_praise") || fromAnyPool(firstLine(r.data), "relief")).toBe(true);
  });

  it("чайник не искупает пропущенный день рождения: серия пропусков остаётся после «Готово» по мелочи", async () => {
    await w.create("через 5 минут поздравить маму с днём рождения");
    for (const m of OVERDUE_RUNS) await run(min(5 + m));
    expect(mood().miss_streak).toBe(2);
    const t = await w.create("через 5 минут выключить чайник", min(130));
    await run(min(135));
    await click(`done:${t.occId}`, min(136));
    expect(mood().miss_streak).toBe(2);
    expect(mood().current_mood).toBe("tsundere");
  });

  it("окно «Изменить»: важность выбирается в списке «Реплики Хару и важность» и сохраняется", async () => {
    const a = await w.create("через 5 минут разобрать почту");
    const m = await click(`edit:${a.occId}`);
    const select = JSON.stringify(m.data.components);
    for (const v of ["minor", "major", "auto", "plain", "styled", "keep"]) expect(select).toContain(`"value":"${v}"`);
    expect(select).toContain("Реплики Хару и важность дела");
    expect(m.data.components.length).toBeLessThanOrEqual(5); // больше пяти полей Discord не принимает

    await submit(`m_edit:${a.occId}`, { title: "Разобрать почту", when: "", ladder: ["keep"], nums: "", plain: ["major"] });
    expect(item(a.occId).weight).toBe(2);
    const m2 = await click(`edit:${a.occId}`);
    expect(JSON.stringify(m2.data.components)).toContain("главное");
    await submit(`m_edit:${a.occId}`, { title: "Разобрать почту", when: "", ladder: ["keep"], nums: "", plain: ["minor"] });
    expect(item(a.occId).weight).toBe(1);
    await submit(`m_edit:${a.occId}`, { title: "Разобрать почту", when: "", ladder: ["keep"], nums: "", plain: ["auto"] });
    expect(item(a.occId).weight).toBe(0);
    // выбор «без стиля» метку веса не трогает
    await submit(`m_edit:${a.occId}`, { title: "Разобрать почту", when: "", ladder: ["keep"], nums: "", plain: ["major"] });
    await submit(`m_edit:${a.occId}`, { title: "Разобрать почту", when: "", ladder: ["keep"], nums: "", plain: ["plain"] });
    expect(item(a.occId).weight).toBe(2);
  });
});

// ---------- образ дня в живом потоке ----------

describe("образ дня в боте", () => {
  beforeEach(async () => {
    w = new World();
    pending = [];
    seq = 0;
    // уровень 3 — самый «японский»: чопорная всё равно говорит только по-русски
    await w.seed({ today: true, intake: true, settings: { mood_on: "1", style_level: "3", summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });

  it("7 ноября 2026 — день образа «чопорная»: напоминание звучит из пула prim, без японских слов и манга-звуков даже на уровне 3", async () => {
    await w.create("через 5 минут разобрать почту");
    await run(min(5));
    const content = String(w.discord.live(CH_REMIND)[0].body.content);
    const line = firstLine(w.discord.live(CH_REMIND)[0].body);
    expect(content).not.toMatch(/сама|хай|ганбатте|яре|ара/iu);
    expect(fromAnyPool(line, "reminder")).toBe(true);
    const inPrim = (PHRASES.prim.reminder ?? []).some((p) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{user\}/g, "[^ ,.!?]+").replace(/\{task\}/g, ".+")}$`, "u").test(line.trim()));
    expect(inPrim).toBe(true);
    expect(content).not.toMatch(/[ぁ-ヿ]/u);
  });

  it("/mood показывает образ дня одной строкой", async () => {
    const r = await call({ type: 2, data: { name: "mood", type: 1, options: [] } });
    expect(String(r.data.embeds?.[0]?.description)).toContain("Образ дня: чопорная старшая горничная");
  });
});

// ---------- дождь и погода голосом Хару ----------

describe("дождь и погода: реплика Хару рядом с фактом", () => {
  const om = (now: number, mm: number) => {
    const cur = Math.floor(now / 900_000) * 900_000;
    const sec = (ms: number) => Math.floor(ms / 1000);
    return {
      latitude: 48.4, longitude: 35.0, utc_offset_seconds: 7200, timezone: "Europe/Kyiv",
      current: { time: sec(cur), interval: 900, precipitation: mm, rain: mm, showers: 0, snowfall: 0 },
      minutely_15: { time: [sec(cur)], precipitation: [mm], rain: [mm], showers: [0], snowfall: [0] },
    };
  };

  beforeEach(async () => {
    w = new World();
    pending = [];
    await w.seed({ today: true, intake: true, settings: { rain: "on", mood_on: "1", style_level: "0", summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });

  async function play(minutes: number, mmAt: (m: number) => number) {
    w.rain = (now: number) => om(now, mmAt(Math.round((now - NOW) / MINUTE)));
    for (let m = 0; m <= minutes; m++) await w.run(NOW + m * MINUTE);
  }
  const rainPosts = () => w.discord.posted.filter((p) => p.channel === CH_REMIND).map((p) => String(p.body.content ?? ""));

  it("«начался»: факт первой строкой (он нужен в превью уведомления), под ним реплика Хару из rain_start", async () => {
    await play(10, (m) => (m >= 5 ? 0.4 : 0));
    const [start] = rainPosts();
    const lines = start.split("\n");
    expect(lines[0]).toBe(`<@${OWNER}> 🌧 В Днепре начался дождь`);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(fromAnyPool(lines.slice(1).join("\n"), "rain_start")).toBe(true);
  });

  it("«закончился»: факт и реплика из rain_end; звук (упоминание) у «закончился» по-прежнему нет", async () => {
    await play(60, (m) => (m >= 5 && m <= 10 ? 0.4 : 0));
    const posts = rainPosts();
    expect(posts).toHaveLength(2);
    const end = posts[1].split("\n");
    expect(end[0]).toBe("☀️ Дождь закончился");
    expect(fromAnyPool(end.slice(1).join("\n"), "rain_end")).toBe(true);
    expect(w.discord.posted[1].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("«тихий день»: фактическое сообщение остаётся, реплики нет", async () => {
    await w.repo().exec([(await import("../src/db/repo.ts")).setMeta("quiet_day_until", String(NOW + 86_400_000))]);
    await play(10, (m) => (m >= 5 ? 0.4 : 0));
    expect(rainPosts()).toEqual([`<@${OWNER}> 🌧 В Днепре начался дождь`]);
  });

  it("характер выключен: сообщение как раньше, одной строкой", async () => {
    await w.repo().exec([(await import("../src/db/repo.ts")).setSetting("mood_on", "0")]);
    await play(10, (m) => (m >= 5 ? 0.4 : 0));
    expect(rainPosts()).toEqual([`<@${OWNER}> 🌧 В Днепре начался дождь`]);
  });

  it("вопрос про погоду в канале «бот»: реплика Хару, под ней честный ответ «пока не читаю»", async () => {
    await run(min(0)); // первый запуск запоминает конец канала
    w.discord.say(CH_BOT, OWNER, "какая погода");
    await run(min(1));
    const reply = w.discord.live(CH_BOT)[0].body;
    const lines = String(reply.content).split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.slice(1).join("\n")).toBe(WEATHER_REPLY);
    expect(fromAnyPool(lines[0], "weather_ask")).toBe(true);
    expect(JSON.stringify(reply.components)).toContain("Это было дело"); // кнопка поправить промах осталась
  });
});
