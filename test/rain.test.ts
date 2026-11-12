// «В Днепре начался дождь» (src/rain.ts): разбор ответа Open-Meteo, автомат DRY ⇄ RAINING на поддельных данных,
// сбои сайта (тихо, без сообщений в чат), тихие часы, перезапуск бота, очередь при сбое Discord, предупреждение «скоро», переключатель в /settings.
import { beforeEach, describe, expect, it } from "vitest";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import {
  RAIN_CONFIG, type RainReading, type RainState, fetchRain, kindOf, nextRainMode, nextSlot, parseRain, parseRainOutbox, parseRainState, planRain, rainUrl, serializeRainState,
} from "../src/rain.ts";
import { parsePassport, SOURCES, statusText } from "../src/sources.ts";
import { readSettings } from "../src/settings.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

// ---------- вспомогательное ----------

const floor15 = (ms: number) => Math.floor(ms / 900_000) * 900_000;
const sec = (ms: number) => Math.floor(ms / 1000);

/** Ответ Open-Meteo в нашем формате (unixtime), как настоящий: первый слот — текущий срез, дальше +15, +30, +45 минут. */
function om(now: number, o: { mm?: number; rain?: number; showers?: number; snow?: number; next?: number[]; nextSnow?: number[]; ageMin?: number } = {}) {
  const cur = floor15(now - (o.ageMin ?? 0) * MINUTE);
  const mm = o.mm ?? 0;
  const slots = [mm, ...(o.next ?? [0, 0, 0])];
  const snows = [o.snow ?? 0, ...(o.nextSnow ?? [0, 0, 0])];
  return {
    latitude: 48.44558, longitude: 35.048775, utc_offset_seconds: 7200, timezone: "Europe/Kyiv",
    current: { time: sec(cur), interval: 900, precipitation: mm, rain: o.rain ?? ((o.snow ?? 0) > 0 ? 0 : mm), showers: o.showers ?? 0, snowfall: o.snow ?? 0 },
    minutely_15: {
      time: slots.map((_, i) => sec(cur + i * 900_000)),
      precipitation: slots,
      rain: slots.map((p, i) => (snows[i] > 0 ? 0 : p)),
      showers: slots.map(() => 0),
      snowfall: snows,
    },
  };
}

/** Настоящие ответы, снятые 2026-11-12 14:35 по Киеву (сухо). Первый — ровно запрос из ТЗ (время ISO), второй — наш (unixtime). */
const REAL_ISO = {
  latitude: 48.44558, longitude: 35.048775, utc_offset_seconds: 7200, timezone: "Europe/Kyiv",
  current_units: { time: "iso8601", interval: "seconds", precipitation: "mm", rain: "mm" },
  current: { time: "2026-11-12T14:30", interval: 900, precipitation: 0.0, rain: 0.0 },
  minutely_15_units: { time: "iso8601", precipitation: "mm" },
  minutely_15: { time: ["2026-11-12T14:30", "2026-11-12T14:45", "2026-11-12T15:00", "2026-11-12T15:15"], precipitation: [0.0, 0.0, 0.0, 0.0] },
};
const REAL_UNIX = {
  latitude: 48.44558, longitude: 35.048775, utc_offset_seconds: 7200, timezone: "Europe/Kyiv",
  current: { time: 1794486600, interval: 900, precipitation: 0.0, rain: 0.0, showers: 0.0, snowfall: 0.0, weather_code: 3 },
  minutely_15: {
    time: [1794486600, 1794487500, 1794488400, 1794489300], precipitation: [0, 0, 0, 0], rain: [0, 0, 0, 0], showers: [0, 0, 0, 0], snowfall: [0, 0, 0, 0],
  },
};

const reading = (mm: number, over: Partial<RainReading> = {}): RainReading => ({ at: NOW, mm, kind: "rain", slots: [], ...over });
const okResp = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

// ---------- разбор ответа ----------

describe("дождь: разбор ответа Open-Meteo", () => {
  it("настоящий ответ на запрос из ТЗ (время ISO, только precipitation и rain): сухо, слоты читаются, время сдвинуто по поясу", () => {
    const r = parseRain(REAL_ISO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.mm).toBe(0);
    expect(r.reading.kind).toBe("rain");
    expect(r.reading.at).toBe(kyiv(2026, 11, 12, 14, 30)); // 14:30 по Киеву (UTC+2 зимой)
    expect(r.reading.slots.map((s) => s.at)).toEqual([kyiv(2026, 11, 12, 14, 30), kyiv(2026, 11, 12, 14, 45), kyiv(2026, 11, 12, 15, 0), kyiv(2026, 11, 12, 15, 15)]);
  });

  it("тот же срез в unixtime даёт тот же момент", () => {
    const r = parseRain(REAL_UNIX);
    expect(r.ok && r.reading.at).toBe(kyiv(2026, 11, 12, 14, 30));
  });

  it("порог и «ближайший слот»: слот с меткой позже «сейчас», а не текущий срез", () => {
    const now = kyiv(2026, 11, 12, 14, 35);
    const r = parseRain(om(now, { mm: 0, next: [0.2, 0, 0] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = nextSlot(r.reading, now)!;
    expect(s.at).toBe(kyiv(2026, 11, 12, 14, 45));
    expect(s.mm).toBe(0.2);
  });

  it.each([
    ["не объект", "строка"],
    ["пусто", null],
    ["нет current", { latitude: 1 }],
    ["нет осадков", { current: { time: 1794486600 } }],
    ["осадки не число", { current: { time: 1794486600, precipitation: "много" } }],
    ["осадки отрицательные", { current: { time: 1794486600, precipitation: -1 } }],
    ["нет времени", { current: { precipitation: 0.2 } }],
    ["ошибка API", { error: true, reason: "Cannot initialize" }],
  ])("мусор (%s) — не разобралось, а не падение", (_n, body) => {
    expect(parseRain(body).ok).toBe(false);
  });

  it("вид осадков: дождь, снег и дождь со снегом", () => {
    expect(kindOf(0.4, 0.4, 0, 0)).toBe("rain");
    expect(kindOf(0.4, 0.4, null, null)).toBe("rain"); // запрос ТЗ без снега
    expect(kindOf(0.4, 0, 0, 0.5)).toBe("snow");
    expect(kindOf(0.4, 0.3, 0, 0.2)).toBe("mixed");
    expect(kindOf(0.4, 0.1, 0.1, 0.3)).toBe("snow");
  });

  it("адрес запроса: Днепр, 4 слота вперёд, пояс Киева", () => {
    const u = rainUrl();
    expect(u).toContain("latitude=48.4647");
    expect(u).toContain("longitude=35.0462");
    expect(u).toContain("forecast_minutely_15=4");
    expect(u).toContain("timezone=Europe%2FKyiv");
    expect(u).toContain("current=precipitation,rain");
  });
});

describe("дождь: запрос с таймаутом", () => {
  it("успех, HTTP-ошибка, сбой сети, мусор — ни разу не бросает", async () => {
    expect((await fetchRain(okResp(om(NOW, { mm: 0.3 })), NOW)).ok).toBe(true);
    const http = await fetchRain((async () => new Response("down", { status: 503 })) as unknown as typeof fetch, NOW);
    expect(http).toEqual({ ok: false, why: "Open-Meteo ответил HTTP 503" });
    const net = await fetchRain((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, NOW);
    expect(net.ok).toBe(false);
    expect((await fetchRain((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch, NOW)).ok).toBe(false);
  });

  it("зависший сайт обрывается по таймауту", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await fetchRain(hang, NOW, { ...RAIN_CONFIG, requestTimeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("нет ответа");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("устаревший срез (сайт завис на старых данных) — сбой, а не «сухо»", async () => {
    const r = await fetchRain(okResp(om(NOW, { mm: 0.5, ageMin: 120 })), NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("устарели");
  });

  it("таймаут в настройках по умолчанию — 10 секунд", () => {
    expect(RAIN_CONFIG.requestTimeoutMs).toBe(10_000);
  });
});

// ---------- автомат ----------

describe("дождь: автомат DRY ⇄ RAINING (чистая логика)", () => {
  const dry = (over: Partial<RainState> = {}): RainState => ({ mode: "dry", dryStreak: 0, kind: "rain", since: NOW, lastOk: NOW, lastEarly: 0, ...over });
  const wetState = (over: Partial<RainState> = {}): RainState => ({ ...dry(), mode: "raining", ...over });

  it("DRY → RAINING при 0.1 мм (граница включительно); 0.09 — ещё сухо", () => {
    const hit = planRain(dry(), reading(0.1), NOW + 5 * MINUTE, false);
    expect(hit.state.mode).toBe("raining");
    expect(hit.notices.map((n) => n.text)).toEqual(["🌧 В Днепре начался дождь"]);
    const miss = planRain(dry(), reading(0.09), NOW + 5 * MINUTE, false);
    expect(miss.state.mode).toBe("dry");
    expect(miss.notices).toEqual([]);
  });

  it("RAINING → DRY только после 6 сухих проверок подряд; моросит снова — счёт с нуля", () => {
    let st = wetState();
    let t = NOW;
    const texts: string[] = [];
    const step = (mm: number) => {
      t += 5 * MINUTE;
      const p = planRain(st, reading(mm), t, false);
      st = p.state;
      texts.push(...p.notices.map((n) => n.text));
    };
    for (let i = 0; i < 5; i++) step(0);
    expect(st.mode).toBe("raining");
    expect(st.dryStreak).toBe(5);
    step(0.3); // снова пошёл
    expect(st.dryStreak).toBe(0);
    for (let i = 0; i < 5; i++) step(0);
    expect(st.mode).toBe("raining");
    expect(texts).toEqual([]); // ни одного сообщения: дождь «то стихает, то снова идёт»
    step(0);
    expect(st.mode).toBe("dry");
    expect(texts).toEqual(["☀️ Дождь закончился"]);
  });

  it("слова конца — по виду осадков: снег и «дождь со снегом»", () => {
    const snow = planRain(wetState({ kind: "snow", dryStreak: 5 }), reading(0), NOW + 5 * MINUTE, false);
    expect(snow.notices.map((n) => n.text)).toEqual(["☀️ Снег закончился"]);
    const start = planRain(dry(), reading(0.4, { kind: "snow" }), NOW + 5 * MINUTE, false);
    expect(start.notices.map((n) => n.text)).toEqual(["🌨 В Днепре пошёл снег"]);
  });

  it("первое чтение (состояния нет): молча принимаем как есть — и при дожде тоже, ложного «начался» не бывает", () => {
    const a = planRain(null, reading(0.6), NOW, false);
    expect(a.notices).toEqual([]);
    expect(a.state.mode).toBe("raining");
    const b = planRain(null, reading(0), NOW, false);
    expect(b.notices).toEqual([]);
    expect(b.state.mode).toBe("dry");
  });

  it("долгая пауза, пока считали «идёт дождь»: конец не видели — состояние сбрасывается молча", () => {
    const stale = wetState({ lastOk: NOW - 4 * 60 * MINUTE });
    const a = planRain(stale, reading(0), NOW, false);
    expect(a.state.mode).toBe("dry");
    expect(a.notices).toEqual([]);
    const b = planRain(stale, reading(0.5), NOW, false);
    expect(b.state.mode).toBe("raining");
    expect(b.notices).toEqual([]);
  });

  it("долгая пауза в сухом состоянии не мешает: пошёл дождь — сообщаем", () => {
    const p = planRain(dry({ lastOk: NOW - 10 * 60 * MINUTE }), reading(0.5), NOW, false);
    expect(p.notices.map((n) => n.kind)).toEqual(["start"]);
  });

  describe("предупреждение «скоро» (EARLY_WARNING)", () => {
    const slots = (mm: number) => [{ at: NOW + 10 * MINUTE, mm, kind: "rain" as const }];
    it("по умолчанию выключено: в слоте дождь, а сообщения нет", () => {
      expect(RAIN_CONFIG.earlyWarning).toBe(false);
      const p = planRain(dry(), reading(0, { slots: slots(0.4) }), NOW, false);
      expect(p.notices).toEqual([]);
    });
    it("включено: сухо сейчас, дождь в ближайшем слоте — одно предупреждение, дальше не чаще раза в 2 часа", () => {
      let st = dry();
      const sent: number[] = [];
      for (let i = 0; i <= 26; i++) {
        const t = NOW + i * 5 * MINUTE;
        const p = planRain(st, reading(0, { at: t, slots: [{ at: t + 10 * MINUTE, mm: 0.4, kind: "rain" }] }), t, true);
        st = p.state;
        if (p.notices.length) {
          expect(p.notices[0].text).toBe("⚠️ Скоро может пойти дождь");
          sent.push(i * 5);
        }
      }
      expect(sent).toEqual([0, 120]);
    });
    it("в слоте сухо — тихо; идёт дождь — «скоро» не нужно; текущий срез (метка не позже «сейчас») не считается", () => {
      expect(planRain(dry(), reading(0, { slots: slots(0.05) }), NOW, true).notices).toEqual([]);
      expect(planRain(wetState(), reading(0.3, { slots: slots(0.4) }), NOW, true).notices).toEqual([]);
      expect(planRain(dry(), reading(0, { slots: [{ at: NOW - 5 * MINUTE, mm: 0.4, kind: "rain" }] }), NOW, true).notices).toEqual([]);
    });
    it("дождь начался сам, до предупреждения — только «начался»", () => {
      const p = planRain(dry(), reading(0.3, { slots: slots(0.4) }), NOW, true);
      expect(p.notices.map((n) => n.kind)).toEqual(["start"]);
    });
  });

  it("состояние сохраняется в JSON и читается обратно; мусор — «состояния нет» (первое чтение, молча)", () => {
    const st = wetState({ dryStreak: 3, kind: "snow", lastEarly: 123 });
    expect(parseRainState(serializeRainState(st))).toEqual(st);
    expect(parseRainState(undefined)).toBeNull();
    expect(parseRainState("{")).toBeNull();
    expect(parseRainState('{"mode":"weird","lastOk":1}')).toBeNull();
    expect(parseRainState('{"mode":"dry"}')).toBeNull();
  });

  it("очередь неотправленного: устаревшее и мусор отбрасываются", () => {
    const fresh = { text: "🌧 В Днепре начался дождь", mention: true, at: NOW - 5 * MINUTE };
    const old = { text: "старое", mention: true, at: NOW - 40 * MINUTE };
    expect(parseRainOutbox(JSON.stringify([old, fresh, { text: 1 }]), NOW)).toEqual([fresh]);
    expect(parseRainOutbox("не json", NOW)).toEqual([]);
    expect(parseRainOutbox(undefined, NOW)).toEqual([]);
  });

  it("переключатель: вкл → вкл + «скоро» → выкл → вкл", () => {
    expect(nextRainMode("on")).toBe("early");
    expect(nextRainMode("early")).toBe("off");
    expect(nextRainMode("off")).toBe("on");
  });
});

// ---------- в настоящем cron на поддельной базе и поддельном Discord ----------

describe("дождь в cron: DRY → RAINING → DRY по минутам", () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.seed({ settings: { rain: "on", summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });
  const posts = () => w.discord.posted.map((p) => p.body.content ?? "");
  /** прогон по минутам от start на `minutes` минут; mmAt(минута) — осадки в этот момент */
  async function play(start: number, minutes: number, mmAt: (min: number) => number, from = 0) {
    w.rain = (now: number) => om(now, { mm: mmAt(Math.round((now - start) / MINUTE)) });
    const when: { min: number; text: string }[] = [];
    for (let m = from; m <= minutes; m++) {
      const before = w.discord.posted.length;
      await w.run(start + m * MINUTE);
      for (const p of w.discord.posted.slice(before)) when.push({ min: m, text: p.body.content ?? "" });
    }
    return when;
  }
  const state = () => {
    const rows = w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'rain_state'");
    return rows.length ? parseRainState(rows[0].value) : null;
  };

  it("сухо → пошёл (с 5-й минуты, 4 проверки) → стих: два сообщения, в нужные минуты, раз в 5 минут ходит в сеть", async () => {
    const msgs = await play(NOW, 120, (m) => (m >= 5 && m <= 20 ? 0.3 : 0));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].min).toBe(5);
    expect(msgs[0].text).toBe(`<@${OWNER}> 🌧 В Днепре начался дождь`);
    expect(msgs[1].min).toBe(50); // 25, 30, 35, 40, 45, 50 — шестая сухая проверка
    expect(msgs[1].text).toBe("☀️ Дождь закончился");
    expect(w.rainFetches).toBe(25); // минуты 0, 5, … 120
    expect(state()?.mode).toBe("dry");
    expect(w.discord.posted.every((p) => p.channel === CH_REMIND)).toBe(true);
  });

  it("сообщение «начался» со звуком (упоминание), «закончился» — без", async () => {
    await play(NOW, 60, (m) => (m >= 5 && m <= 10 ? 0.5 : 0));
    expect(w.discord.posted[0].body.allowed_mentions).toEqual({ users: [OWNER] });
    expect(w.discord.posted[1].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("дождь то стихает, то снова идёт: одно «начался» и одно «закончился» в самом конце", async () => {
    // дождь 5–10, пауза (15–35: 5 сухих проверок), опять 40, потом сухо с 45
    const msgs = await play(NOW, 120, (m) => (m >= 5 && m <= 10 ? 0.4 : m === 40 ? 0.2 : 0));
    expect(msgs.map((m) => m.min)).toEqual([5, 70]); // сухие 45, 50, 55, 60, 65, 70
    expect(msgs[0].text).toContain("начался дождь");
    expect(msgs[1].text).toContain("Дождь закончился");
  });

  it("состояние лежит в базе JSON-ом, а после «перезапуска» (новый запуск на той же базе) повторного «начался» нет", async () => {
    await play(NOW, 15, (m) => (m >= 5 ? 0.4 : 0));
    expect(posts()).toHaveLength(1);
    const raw = w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'rain_state'")[0].value;
    expect(JSON.parse(raw).mode).toBe("raining");
    const w2 = new World();
    w2.d1 = w.d1; // та же база, всё остальное — новое: как после перезапуска или новой выкладки
    w2.rain = (now: number) => om(now, { mm: 0.4 });
    await w2.run(NOW + 20 * MINUTE);
    await w2.run(NOW + 25 * MINUTE);
    expect(w2.discord.posted).toHaveLength(0);
    expect(w2.rainFetches).toBe(2);
  });

  it("на пустой базе, пока идёт дождь, «начался» не шлём (первое чтение молча), а «закончился» — когда стихнет", async () => {
    const msgs = await play(NOW, 60, (m) => (m <= 10 ? 0.5 : 0));
    expect(msgs.map((m) => m.text)).toEqual(["☀️ Дождь закончился"]);
    expect(msgs[0].min).toBe(40); // последняя мокрая проверка 10, сухие 15–40
  });

  it("сайт не отвечает: ни сообщений, ни падения; запись в журнал; на следующем круге (через 5 минут) пробуем снова; ответил — всё как обычно", async () => {
    w.rain = null; // 503
    const r0 = await w.run(NOW);
    expect(r0.failed).toBe(0);
    expect(posts()).toEqual([]);
    expect(w.logs.some((l) => l.includes("Open-Meteo не прочитался") && l.includes("HTTP 503") && l.includes("Киев"))).toBe(true);
    await w.run(NOW + MINUTE);
    await w.run(NOW + 4 * MINUTE);
    expect(w.rainFetches).toBe(1); // следующая попытка — на следующем цикле, не каждую минуту
    await w.run(NOW + 5 * MINUTE);
    expect(w.rainFetches).toBe(2);
    expect(posts()).toEqual([]);
    const p = parsePassport(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'src_passport'")[0].value);
    expect(p.rain?.fails).toBe(2);
    w.rain = (now: number) => om(now, { mm: 0 });
    await w.run(NOW + 10 * MINUTE);
    const p2 = parsePassport(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'src_passport'")[0].value);
    expect(p2.rain?.fails).toBe(0);
    expect(state()?.mode).toBe("dry");
  });

  it("сбой сети и мусорный ответ — тоже тихо", async () => {
    w.rain = new Error("fetch failed");
    await w.run(NOW);
    w.rain = { это: "не то" };
    await w.run(NOW + 5 * MINUTE);
    w.rain = (now: number) => om(now, { mm: 0.3, ageMin: 180 }); // застрявший срез
    await w.run(NOW + 10 * MINUTE);
    expect(posts()).toEqual([]);
    expect(w.logs.filter((l) => l.includes("Open-Meteo не прочитался"))).toHaveLength(3);
    expect(state()).toBeNull(); // состояния нет: ни одно чтение не удалось
  });

  it("сбой во время дождя не считается «сухой проверкой»", async () => {
    await play(NOW, 10, (m) => (m >= 5 ? 0.4 : 0));
    expect(state()?.mode).toBe("raining");
    w.rain = null;
    for (let m = 15; m <= 60; m += 5) await w.run(NOW + m * MINUTE);
    expect(state()?.mode).toBe("raining");
    expect(state()?.dryStreak).toBe(0);
    expect(posts()).toHaveLength(1);
  });

  it("настройка «Дождь: выкл» — в сеть не ходим", async () => {
    await w.repo().exec([setSetting("rain", "off")]);
    await w.run(NOW);
    await w.run(NOW + 5 * MINUTE);
    expect(w.rainFetches).toBe(0);
  });

  it("тихие часы: состояние ведём, сообщения не шлём (и после них про старое «начался» не вспоминаем)", async () => {
    await w.repo().exec([setSetting("quiet_enabled", "1"), setSetting("quiet_from", "22:00"), setSetting("quiet_to", "07:00")]);
    const start = kyiv(2026, 11, 7, 23, 0);
    await play(start, 120, (m) => (m >= 10 ? 0.5 : 0));
    expect(posts()).toEqual([]);
    expect(state()?.mode).toBe("raining");
    expect(w.logs.some((l) => l.includes("тихие часы"))).toBe(true);
    // утро, дождь всё ещё идёт: «начался» не приходит
    await w.run(kyiv(2026, 11, 8, 7, 5));
    await w.run(kyiv(2026, 11, 8, 7, 10));
    expect(posts()).toEqual([]);
  });

  it("«я в отъезде»: сообщений нет", async () => {
    await w.repo().exec([setSetting("away_until", String(NOW + 48 * 60 * MINUTE))]);
    await play(NOW, 30, (m) => (m >= 5 ? 0.5 : 0));
    expect(posts()).toEqual([]);
  });

  it("«Личка»: сообщение идёт в личный чат без упоминания (звук у лички и так есть)", async () => {
    await w.repo().exec([setMeta("dm_channel_id", CH_REMIND)]);
    await play(NOW, 10, (m) => (m >= 5 ? 0.5 : 0));
    expect(posts()).toEqual(["🌧 В Днепре начался дождь"]);
  });

  it("Discord не принял сообщение: оно ждёт в очереди и уходит позже, один раз", async () => {
    w.discord.failPost = { status: 500, times: 3 };
    const msgs = await play(NOW, 15, (m) => (m >= 5 ? 0.5 : 0));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].min).toBe(8); // попытки 5, 6, 7 — отказ
    expect(msgs[0].text).toContain("начался дождь");
  });

  it("сообщение не ушло за полчаса — устарело, не отправляется («начался» про дождь получасовой давности вводит в заблуждение)", async () => {
    w.discord.failPost = { status: 500, times: 1000 };
    await play(NOW, 40, (m) => (m >= 5 ? 0.5 : 0));
    w.discord.failPost = null;
    await w.run(NOW + 41 * MINUTE);
    await w.run(NOW + 42 * MINUTE);
    expect(posts()).toEqual([]);
    expect(w.d1.q("SELECT value FROM meta WHERE key = 'rain_outbox'")).toEqual([]);
  });

  it("вид осадков: пошёл снег — «пошёл снег», стих — «снег закончился»", async () => {
    w.rain = (now: number) => om(now, { mm: now >= NOW + 5 * MINUTE && now <= NOW + 10 * MINUTE ? 0.4 : 0, snow: now >= NOW + 5 * MINUTE && now <= NOW + 10 * MINUTE ? 0.5 : 0 });
    for (let m = 0; m <= 40; m++) await w.run(NOW + m * MINUTE);
    expect(posts().map((t) => t.replace(`<@${OWNER}> `, ""))).toEqual(["🌨 В Днепре пошёл снег", "☀️ Снег закончился"]);
  });

  it("предупреждение «скоро»: по умолчанию нет; в «вкл + скоро» — одно, потом тишина на 2 часа", async () => {
    const soon = (now: number) => om(now, { mm: 0, next: [0.3, 0, 0] });
    w.rain = soon;
    for (let m = 0; m <= 60; m += 5) await w.run(NOW + m * MINUTE);
    expect(posts()).toEqual([]);
    await w.repo().exec([setSetting("rain", "early")]);
    for (let m = 65; m <= 190; m += 5) await w.run(NOW + m * MINUTE); // 65 — первое, 185 — через 2 часа второе
    expect(posts().map((t) => t.replace(`<@${OWNER}> `, ""))).toEqual(["⚠️ Скоро может пойти дождь", "⚠️ Скоро может пойти дождь"]);
    expect(w.d1.q<{ at: number }>("SELECT at FROM events WHERE kind = 'rain_early'")).toHaveLength(2);
  });

  it("запас подзапросов: запуск с началом дождя укладывается", async () => {
    await play(NOW, 4, () => 0);
    w.rain = (now: number) => om(now, { mm: 0.5 });
    const rep = await w.run(NOW + 5 * MINUTE);
    expect(rep.subrequests).toBeLessThan(15);
  });

  it("экран «Состояние»: дождь — отдельная строка, и сбой о себе в итоге недели не пишет", async () => {
    w.rain = (now: number) => om(now, { mm: 0 });
    await w.run(NOW);
    const p = parsePassport(w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'src_passport'")[0].value);
    const text = statusText(p, { light: false, water: false, gas: false, rain: true }, NOW, TZ);
    expect(text).toMatch(/Дождь \(Open-Meteo\)[^\n]*читалось[^\n]*всё в порядке/);
    expect(SOURCES.map((s) => s.id)).toContain("rain");
  });
});

// ---------- настройка в /settings ----------

describe("дождь: настройка", () => {
  it("по умолчанию включён, «скоро» выключено; значения в базе читаются", () => {
    expect(readSettings([]).rainOn).toBe(true);
    expect(readSettings([]).rainEarly).toBe(false);
    expect(readSettings([{ key: "rain", value: "off" }]).rainOn).toBe(false);
    const e = readSettings([{ key: "rain", value: "early" }]);
    expect([e.rainOn, e.rainEarly]).toEqual([true, true]);
    expect(readSettings([{ key: "rain", value: "мусор" }]).rainOn).toBe(true);
  });

  it("«⋯ Ещё»: кнопка «Дождь» переключает вкл → «скоро» → выкл → вкл", async () => {
    const w = new World();
    await w.seed({ today: true, intake: true });
    let seq = 0;
    const click = async (id: string) => {
      const pending: Promise<unknown>[] = [];
      const r = await handleInteraction(
        { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: CH_BOT, member: { user: { id: OWNER } }, type: 3, data: { custom_id: id }, message: { id: "m1" } } as Interaction,
        { repo: w.repo(), api: w.discord, now: NOW, env: {}, defer: (p) => void pending.push(p) },
      );
      await Promise.all(pending);
      return r as { type: number; data?: any };
    };
    const screen = await click("mn:s:a");
    const buttons = (screen.data?.components ?? []).flatMap((x: any) => x.components);
    expect(buttons.map((b: any) => b.custom_id)).toContain("mn:tg:rn:a");
    expect((screen.data?.components ?? []).every((x: any) => x.components.length <= 5)).toBe(true);
    expect(String(screen.data?.content).length).toBeLessThan(2000); // лимит Discord на текст сообщения
    expect(screen.data?.content).toContain("Дождь в Днепре: выкл"); // seed() выключает дождь для старых тестов
    const value = () => w.d1.q<{ value: string }>("SELECT value FROM settings WHERE key = 'rain'")[0]?.value;
    const status = async () => String((await click("mn:ss")).data?.content);
    expect(await status()).toMatch(/Дождь \(Open-Meteo\)[^\n]*выключено в настройках/);
    await w.repo().exec([setSetting("rain", "on")]);
    expect(await status()).toMatch(/Дождь \(Open-Meteo\)[^\n]*ещё не читалось/);
    await click("mn:tg:rn:a");
    expect(value()).toBe("early");
    await click("mn:tg:rn:a");
    expect(value()).toBe("off");
    await click("mn:tg:rn:a");
    expect(value()).toBe("on");
  });
});
