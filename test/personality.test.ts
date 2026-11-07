// Движок настроения (ТЗ «Характер 2», раздел 11): переходы при 1/2/3 пропусках, возврат из яндере,
// ночь, защита от дёргания, спад чисел, серии и похвала, фразы без повторов, база D1.
import { describe, expect, it } from "vitest";
import { MOOD_CONFIG } from "../src/personality/config.ts";
import { MoodSession, canStyle, makeCtx } from "../src/personality/director.ts";
import {
  type MoodCtx,
  type MoodEvent,
  type MoodState,
  candidateMood,
  daytimeHours,
  forceMood,
  initialState,
  isPolite,
  isSeriousTopic,
  peek,
  settle,
  step,
} from "../src/personality/moodEngine.ts";
import { FALLBACK_SITUATION, PHRASES, SITUATIONS } from "../src/personality/phrases.ts";
import { fill, fingerprint, pickPhrase, poolFor, remember } from "../src/personality/speech.ts";
import { kyiv, TZ } from "./helpers.ts";
import { OWNER, World } from "./world.ts";

const H = 3_600_000;
const MIN = 60_000;
// день: 2026-11-07, суббота, 12:00 по Киеву (ночь — с 23:00 до 07:00)
const T0 = kyiv(2026, 11, 7, 12, 0);
const settings = { tz: TZ, quietEnabled: false, quietFrom: 23 * 60, quietTo: 7 * 60 };
const ctxAt = (now: number): MoodCtx => makeCtx(now, settings);
const dayOnly: MoodCtx["isNight"] = () => false;

/** Прогнать цепочку событий: [через сколько минут после предыдущего, событие]. */
function run(events: [number, MoodEvent][], start: MoodState = initialState(T0), isNight?: MoodCtx["isNight"]) {
  let st = start;
  let now = T0;
  const log: ReturnType<typeof step>[] = [];
  for (const [dtMin, ev] of events) {
    now += dtMin * MIN;
    const ctx = isNight ? { now, isNight } : ctxAt(now);
    const r = step(st, ev, ctx);
    st = r.state;
    log.push(r);
  }
  return { st, now, log };
}

const miss: MoodEvent = { type: "miss" };
const onTime: MoodEvent = { type: "done", onTime: true };
const late: MoodEvent = { type: "done", onTime: false };

describe("настроение: числа и события (ТЗ, раздел 4)", () => {
  it("старт: tired, симпатия 50, раздражение 10", () => {
    const s = initialState(T0);
    expect([s.mood, s.affection, s.irritation, s.missStreak, s.doneStreak]).toEqual(["tired", 50, 10, 0, 0]);
  });

  it("выполнено вовремя: серия +1, пропуски 0, симпатия +3, раздражение −10 (не ниже 0)", () => {
    const { st } = run([[0, miss], [0, miss], [0, onTime]]);
    expect(st.missStreak).toBe(0);
    expect(st.doneStreak).toBe(1);
    // 50 −2 −2 +3 = 49; 10 +15 +15 −10 = 30
    expect(st.affection).toBe(49);
    expect(st.irritation).toBe(30);
    const calm = run([[0, onTime]]).st;
    expect(calm.irritation).toBe(0);
  });

  it("выполнено с опозданием: симпатия +1, раздражение −3, пропуски 0, серия выполненных не растёт", () => {
    const { st } = run([[0, miss], [0, late]]);
    expect(st.missStreak).toBe(0);
    expect(st.doneStreak).toBe(0);
    expect(st.affection).toBe(50 - 2 + 1);
    expect(st.irritation).toBe(10 + 15 - 3);
  });

  it("пропуск: серия пропусков +1, выполненных 0, раздражение +15, симпатия −2; числа в пределах 0..100", () => {
    const { st } = run([[0, onTime], [0, miss]]);
    expect(st.doneStreak).toBe(0);
    expect(st.missStreak).toBe(1);
    expect(st.irritation).toBe(15);
    const many = run(Array.from({ length: 30 }, () => [0, miss] as [number, MoodEvent])).st;
    expect(many.irritation).toBeLessThanOrEqual(100);
    expect(many.affection).toBeGreaterThanOrEqual(0);
  });

  it("активность: вежливое сообщение даёт симпатию +4", () => {
    const { st } = run([[0, { type: "activity", polite: true }]]);
    expect(st.affection).toBe(54);
    expect(isPolite("Спасибо!")).toBe(true);
    expect(isPolite("молодец")).toBe(true);
    expect(isPolite("купить хлеб, спасибо если сможешь это очень длинное дело про совсем другое")).toBe(false);
    expect(isPolite("купить хлеб")).toBe(false);
  });

  it("спад со временем: раздражение −2/час, симпатия тянется к 50 на 1/час", () => {
    const s0 = { ...initialState(T0), irritation: 50, affection: 70 };
    const s1 = settle(s0, { now: T0 + 5 * H, isNight: dayOnly });
    expect(s1.irritation).toBe(40);
    expect(s1.affection).toBe(65);
    const low = settle({ ...initialState(T0), affection: 48 }, { now: T0 + 5 * H, isNight: dayOnly });
    expect(low.affection).toBe(50); // не перескакивает через норму
    const lowIrr = settle({ ...initialState(T0), irritation: 3 }, { now: T0 + 5 * H, isNight: dayOnly });
    expect(lowIrr.irritation).toBe(0);
  });

  it("молчание дольше 12 дневных часов: +5 за каждые 12 ч, всего не больше +20", () => {
    const base = { ...initialState(T0), irritation: 0 };
    // 13 часов без ночи: +5, спад до нуля не даёт уйти ниже 0, итог 5
    const a = settle(base, { now: T0 + 13 * H, isNight: dayOnly });
    expect(a.idlePenalty).toBe(5);
    expect(a.irritation).toBe(5);
    const b = settle(base, { now: T0 + 400 * H, isNight: dayOnly });
    expect(b.idlePenalty).toBe(20);
    expect(b.irritation).toBe(20);
  });

  it("ночь молчанием не считается", () => {
    const evening = kyiv(2026, 11, 7, 22, 0);
    const morning = kyiv(2026, 11, 8, 8, 0);
    const day = daytimeHours(evening, morning, ctxAt(0).isNight);
    // 22:00–23:00 и 07:00–08:00 — всего 2 дневных часа из 10
    expect(day).toBe(2);
  });

  it("возврат после паузы дольше 24 ч: один раз флаг и симпатия +2; повторная активность — уже нет", () => {
    const r1 = step(initialState(T0), { type: "activity" }, { now: T0 + 30 * H, isNight: dayOnly });
    expect(r1.returned).toBe(true);
    expect(r1.state.affection).toBeCloseTo(50 + 2, 5);
    const r2 = step(r1.state, { type: "activity" }, { now: T0 + 31 * H, isNight: dayOnly });
    expect(r2.returned).toBe(false);
  });
});

describe("настроение: выбор и переходы (ТЗ, разделы 5–7)", () => {
  it("1 пропуск → tsundere, 3 подряд → yandere сразу, без 30-минутной задержки", () => {
    const one = run([[0, miss]]);
    expect(one.st.mood).toBe("tsundere");
    const two = run([[0, miss], [1, miss]]);
    expect(two.st.mood).toBe("tsundere");
    const three = run([[0, miss], [1, miss], [2, miss]]);
    expect(three.st.mood).toBe("yandere");
    expect(three.log[2].change?.to).toBe("yandere");
  });

  it("раздражение ≥ 80 даёт yandere и без серии", () => {
    const st = { ...initialState(T0), irritation: 85 };
    expect(candidateMood(st, { now: T0, isNight: dayOnly })).toBe("yandere");
  });

  it("возврат из яндере: «Готово» → tsundere (а не сразу tired), потом со временем tired", () => {
    const { st: y } = run([[0, miss], [1, miss], [2, miss]]);
    expect(y.mood).toBe("yandere");
    const r = step(y, onTime, { now: T0 + 10 * MIN, isNight: dayOnly });
    expect(r.state.mood).toBe("tsundere");
    expect(r.relief).toBe(true);
    // раздражение: 10+45=55 → −10 = 45. Через 4 часа спало до ~37, 30 минут держим уже прошли → tired
    const later = peek(r.state, { now: T0 + 10 * MIN + 4 * H, isNight: dayOnly });
    expect(later.state.mood).toBe("tired");
    expect(later.change?.to).toBe("tired");
  });

  it("из яндере без «Готово» не выходит, даже если числа успокоились; сама успокаивается лишь через сутки — и тоже через tsundere", () => {
    const { st: y } = run([[0, miss], [1, miss], [2, miss]]);
    const afterHours = peek(y, { now: T0 + 10 * H, isNight: dayOnly });
    expect(afterHours.state.mood).toBe("yandere");
    const afterDay = peek(y, { now: T0 + 26 * H, isNight: dayOnly });
    expect(afterDay.state.mood).toBe("tsundere");
  });

  it("если после «Готово» раздражение всё ещё ≥ 80, яндере остаётся, но выход разрешён и случится при спаде", () => {
    const st = { ...initialState(T0), irritation: 100, missStreak: 3, mood: "yandere" as const };
    const r = step(st, onTime, { now: T0 + 5 * MIN, isNight: dayOnly }); // 100 − 10 = 90
    expect(r.state.mood).toBe("yandere");
    expect(r.state.yandereCleared).toBe(true);
    const later = peek(r.state, { now: T0 + 10 * H, isNight: dayOnly }); // ~70
    expect(later.state.mood).toBe("tsundere");
  });

  it("ночное время → sleepy, днём → tired", () => {
    const night = kyiv(2026, 11, 8, 2, 0);
    const s = { ...initialState(night - 2 * H), lastActivity: night - 30 * MIN };
    expect(peek(s, { now: night, isNight: ctxAt(night).isNight }).state.mood).toBe("sleepy");
    expect(candidateMood(s, ctxAt(T0))).toBe("tired");
  });

  it("молчание больше 12 дневных часов → sulking; активность возвращает", () => {
    const st = initialState(T0);
    const later = { now: T0 + 14 * H, isNight: dayOnly };
    expect(peek(st, later).state.mood).toBe("sulking");
    const back = step(peek(st, later).state, { type: "activity" }, { now: later.now + MIN * 40, isNight: dayOnly });
    expect(back.state.mood).toBe("tired"); // 40 мин ≥ 30 мин удержания
  });

  it("три выполненных подряд и симпатия ≥ 60 → proud; без симпатии — нет", () => {
    // 50 +3 +3 +3 = 59 — мало; добавим вежливость (+4)
    const a = run([[10, onTime], [10, onTime], [10, onTime]]);
    expect(a.st.mood).toBe("tired");
    const b = run([[10, { type: "activity", polite: true }], [50, onTime], [50, onTime], [50, onTime]]);
    expect(b.st.affection).toBeGreaterThanOrEqual(60);
    expect(b.st.mood).toBe("proud");
  });

  it("защита от дёргания: новое настроение держится ≥ 30 минут (кроме яндере)", () => {
    // сидим в tired, пропуск → tsundere (из tired в tsundere — удержание от старта, оно уже прошло)
    const a = run([[40, miss]]);
    expect(a.st.mood).toBe("tsundere");
    // сразу выполнено → числа в норме, но < 30 минут: остаёмся в tsundere
    const b = step(a.st, late, { now: a.now + 5 * MIN, isNight: dayOnly });
    expect(b.state.mood).toBe("tsundere");
    // раздражение 25−3=22 (<40), пропусков нет, но 5 минут — держим
    const c = peek(b.state, { now: a.now + 20 * MIN, isNight: dayOnly });
    expect(c.state.mood).toBe("tsundere");
    const d = peek(b.state, { now: a.now + 45 * MIN, isNight: dayOnly });
    expect(d.state.mood).toBe("tired");
  });

  it("серия 3, 7, 14, 30: отметка для особой похвалы", () => {
    const seen: (number | null)[] = [];
    let st = initialState(T0);
    for (let i = 1; i <= 30; i++) {
      const r = step(st, onTime, { now: T0 + i * 60 * MIN, isNight: dayOnly });
      st = r.state;
      seen.push(r.milestone);
    }
    expect(seen.filter((x) => x !== null)).toEqual([3, 7, 14, 30]);
  });

  it("/mood set: принудительное настроение держится, пока нет событий", () => {
    for (const m of ["tired", "tsundere", "yandere", "sulking", "proud", "sleepy"] as const) {
      const f = forceMood(initialState(T0), m, T0);
      expect(f.mood).toBe(m);
    }
    const y = forceMood(initialState(T0), "yandere", T0);
    expect(peek(y, { now: T0 + 5 * MIN, isNight: dayOnly }).state.mood).toBe("yandere");
    const p = forceMood(initialState(T0), "proud", T0);
    expect(peek(p, { now: T0 + 5 * MIN, isNight: dayOnly }).state.mood).toBe("proud");
    const s = forceMood(initialState(T0), "sulking", T0);
    expect(peek(s, { now: T0 + 5 * MIN, isNight: dayOnly }).state.mood).toBe("sulking");
  });

  it("числа берутся из config: сменили порог — поменялось поведение", () => {
    const cfg = { ...MOOD_CONFIG, thresholds: { ...MOOD_CONFIG.thresholds, yandereMiss: 2 } };
    const r1 = step(initialState(T0), miss, { now: T0, isNight: dayOnly }, cfg);
    const r2 = step(r1.state, miss, { now: T0, isNight: dayOnly }, cfg);
    expect(r2.state.mood).toBe("yandere");
  });
});

describe("фразы: пулы без повторов, подстановки", () => {
  it("в каждом настроении есть фразы для главных ситуаций; нет пустых и дублей", () => {
    const core = ["reminder", "reminder_repeat", "missed", "done", "streak_praise"] as const;
    for (const mood of ["tired", "tsundere", "yandere", "sulking", "proud", "sleepy"]) {
      for (const sit of core) {
        const pool = poolFor(mood as never, sit);
        expect(pool.length, `${mood}.${sit}`).toBeGreaterThanOrEqual(2);
      }
      for (const sit of SITUATIONS) {
        const own = PHRASES[mood][sit] ?? [];
        expect(new Set(own).size, `${mood}.${sit}`).toBe(own.length);
        for (const t of own) expect(t.trim().length).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(FALLBACK_SITUATION).length).toBeGreaterThan(0);
  });

  it("подстановки {user}, {task}, {miss_count}, {name}; неизвестные скобки не трогаются", () => {
    expect(fill("{user}: {task} ×{miss_count} ({name}) {что-то}", { user: "хозяин", task: "хлеб", miss_count: 3, name: "Хару" })).toBe(
      "Хозяин: хлеб ×3 (Хару) {что-то}",
    );
  });

  it("последние 5 не повторяются (на пуле из 10 фраз): 200 выборов, окно из 5 всегда разное; на пуле из 5 соседние разные", () => {
    const rnd = (() => {
      let x = 12345;
      return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    })();
    const big = { tired: { reminder: Array.from({ length: 10 }, (_, i) => `фраза номер ${i}`) } };
    let recent: string[] = [];
    for (let i = 0; i < 200; i++) {
      const p = pickPhrase({ mood: "tired", situation: "reminder", recent, rand: rnd, bank: big })!;
      expect(recent.slice(-5)).not.toContain(p.key);
      recent = remember(recent, p.key);
    }
    let prev = "";
    recent = [];
    for (let i = 0; i < 100; i++) {
      const p = pickPhrase({ mood: "tired", situation: "reminder", recent, rand: rnd })!;
      expect(p.key).not.toBe(prev);
      prev = p.key;
      recent = remember(recent, p.key);
    }
  });

  it("если все фразы пула недавно были, всё равно не повторяет предыдущую подряд", () => {
    const single = { yandere: { streak_praise: ["единственная"] } };
    const p = pickPhrase({ mood: "yandere", situation: "streak_praise", recent: [fingerprint("единственная")], rand: () => 0, bank: single });
    expect(p?.text).toBe("единственная"); // один вариант: повторить неизбежно
    const p2 = pickPhrase({ mood: "tired", situation: "done", recent: PHRASES.tired.done!.map(fingerprint), rand: () => 0 })!;
    expect(p2.key).not.toBe(fingerprint(PHRASES.tired.done![PHRASES.tired.done!.length - 1]));
  });

  it("серьёзные темы и критичные дела — без стиля", () => {
    expect(isSeriousTopic("записаться к врачу")).toBe(true);
    expect(isSeriousTopic("принять таблетки")).toBe(true);
    expect(isSeriousTopic("купить хлеб")).toBe(false);
    expect(canStyle("купить хлеб", 0)).toBe(true);
    expect(canStyle("купить хлеб", 1)).toBe(false);
    expect(canStyle("анализ крови", 0)).toBe(false);
  });
});

describe("D1: состояние на пользователя, миграция 0003", () => {
  it("состояние сохраняется и читается, переход настроения попадает в журнал; /reset_mood сбрасывает", async () => {
    const w = new World();
    const repo = w.repo(100);
    const mk = (now: number) => new MoodSession({ repo, userId: OWNER, ctx: ctxAt(now), rand: () => 0 });

    const a = mk(T0);
    await a.load();
    a.apply(miss);
    a.apply(miss);
    a.apply(miss);
    expect(a.state?.mood).toBe("yandere");
    await repo.exec(a.ops());

    const b = mk(T0 + 5 * MIN);
    const st = await b.load();
    expect(st.mood).toBe("yandere");
    expect(st.missStreak).toBe(3);

    const log = await repo.all<{ detail: string }>("SELECT detail FROM events WHERE kind = 'mood' ORDER BY id");
    expect(log.map((r) => r.detail.split(":")[0])).toEqual(["tired>tsundere", "tsundere>yandere"]);

    const { resetOps } = await import("../src/personality/director.ts");
    await repo.exec(resetOps(OWNER));
    const c = mk(T0 + 6 * MIN);
    expect((await c.load()).mood).toBe("tired");
    expect(c.state?.missStreak).toBe(0);
  });

  it("у каждого пользователя своё состояние; фразы запоминаются и сохраняются", async () => {
    const w = new World();
    const repo = w.repo(100);
    const a = new MoodSession({ repo, userId: "u1", ctx: ctxAt(T0), rand: () => 0 });
    const b = new MoodSession({ repo, userId: "u2", ctx: ctxAt(T0), rand: () => 0 });
    await a.load();
    await b.load();
    a.apply(miss);
    const line = a.say("missed_first");
    expect(line).toBeTruthy();
    await repo.exec([...a.ops(), ...b.ops()]);
    const a2 = new MoodSession({ repo, userId: "u1", ctx: ctxAt(T0 + MIN), rand: () => 0 });
    const b2 = new MoodSession({ repo, userId: "u2", ctx: ctxAt(T0 + MIN), rand: () => 0 });
    expect((await a2.load()).missStreak).toBe(1);
    expect((await b2.load()).missStreak).toBe(0);
    expect(a2.state?.recent.length).toBe(1);
  });

  it("4-й пропуск подряд и далее: драматичная фраза не чаще раза в N минут", async () => {
    const w = new World();
    const repo = w.repo(100);
    const s = new MoodSession({ repo, userId: OWNER, ctx: ctxAt(T0), rand: () => 0 });
    await s.load();
    for (let i = 0; i < 4; i++) s.apply(miss);
    expect(s.say("missed")).toBeTruthy();
    expect(s.say("missed")).toBeNull(); // пауза
    const later = new MoodSession({ repo, userId: OWNER, ctx: ctxAt(T0 + 3 * H), rand: () => 0 });
    later.state = s.state;
    expect(later.say("missed")).toBeTruthy();
  });
});
