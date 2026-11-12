// Проверка «дождя» одной командой: npm run rain-check
//  1. настоящий запрос к Open-Meteo для Днепра: что ответил и как бот это разобрал;
//  2. сухой прогон автомата на поддельных данных через настоящий цикл cron: DRY → RAINING → DRY, с временем по Киеву.
// Ничего не отправляет в Discord и не трогает настоящую базу.
import { RAIN_CONFIG, fetchRain, nextSlot, planRain, rainUrl } from "../src/rain.ts";
import { MINUTE, wallOf } from "../src/time/tz.ts";
import { kyiv } from "../test/helpers.ts";
import { CH_REMIND, World } from "../test/world.ts";

if (typeof process !== "undefined") process.stdout.setDefaultEncoding?.("utf8");

const hhmm = (ms: number) => {
  const w = wallOf(ms, RAIN_CONFIG.timezone);
  return `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
};

// ---------- 1. настоящий Open-Meteo ----------
console.log("1. Настоящий запрос к Open-Meteo (Днепр)\n");
console.log(`   ${rainUrl()}\n`);
const now = Date.now();
const t0 = Date.now();
const got = await fetchRain(fetch, now);
const ms = Date.now() - t0;
if (!got.ok) {
  console.log(`   НЕ ПРОЧИТАЛОСЬ за ${ms} мс: ${got.why}`);
  process.exitCode = 1;
} else {
  const r = got.reading;
  console.log(`   ответ за ${ms} мс; срез модели от ${hhmm(r.at)} по Киеву (${Math.round((now - r.at) / MINUTE)} мин назад)`);
  console.log(`   сейчас: ${r.mm} мм, вид — ${r.kind}; порог ${RAIN_CONFIG.thresholdMm} мм → ${r.mm >= RAIN_CONFIG.thresholdMm ? "ИДЁТ ДОЖДЬ (по модели)" : "сухо"}`);
  console.log(`   слоты по 15 минут: ${r.slots.map((s) => `${hhmm(s.at)}=${s.mm}`).join("  ")}`);
  const nxt = nextSlot(r, now);
  console.log(`   ближайший слот: ${nxt ? `${hhmm(nxt.at)} = ${nxt.mm} мм` : "нет"}`);
  const first = planRain(null, r, now, true);
  console.log(`   разбор прошёл; первое чтение бот принимает молча: ${first.state.mode.toUpperCase()}, сообщений ${first.notices.length}`);
}

// ---------- 2. автомат на фейковых данных через настоящий cron ----------
console.log("\n2. Фейковая погода через настоящий cron (раз в минуту, проверка каждые 5)\n");
const w = new World();
await w.seed({ settings: { rain: "on", summary_morning: "off", summary_evening: "off", weekly: "off" } });
const start = kyiv(2026, 11, 12, 14, 0);
// слева — осадки в мм по минутам от начала; интересное: сухо → дождь с 10-й по 25-ю минуту (с «просветом») → сухо
const timeline = (m: number) => (m >= 10 && m <= 25 ? (m >= 16 && m <= 19 ? 0 : 0.4) : 0);
const floor15 = (t: number) => Math.floor(t / 900_000) * 900_000;
w.rain = (t: number) => {
  const mm = timeline(Math.round((t - start) / MINUTE));
  const cur = floor15(t);
  return {
    utc_offset_seconds: 7200,
    current: { time: Math.floor(cur / 1000), interval: 900, precipitation: mm, rain: mm, showers: 0, snowfall: 0 },
    minutely_15: { time: [0, 1, 2, 3].map((i) => Math.floor((cur + i * 900_000) / 1000)), precipitation: [mm, 0, 0, 0], rain: [mm, 0, 0, 0], showers: [0, 0, 0, 0], snowfall: [0, 0, 0, 0] },
  };
};
let prev = "";
for (let m = 0; m <= 75; m++) {
  const t = start + m * MINUTE;
  const before = w.discord.posted.length;
  const logsBefore = w.logs.length;
  await w.run(t);
  for (const line of w.logs.slice(logsBefore)) console.log(`   ${line}`);
  for (const p of w.discord.posted.slice(before)) {
    console.log(`   ${hhmm(t)} -> #${p.channel === CH_REMIND ? "напоминания" : p.channel}: ${(p.body.content ?? "").replace(/<@\d+>\s*/, "[звук] ")}`);
  }
  const row = w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = 'rain_state'")[0]?.value;
  const mode = row ? (JSON.parse(row).mode as string) : "—";
  if (mode !== prev) console.log(`   ${hhmm(t)}    состояние в базе: ${mode.toUpperCase()}`);
  prev = mode;
}
console.log(`\nОпросов Open-Meteo за 75 минут: ${w.rainFetches} (ожидается 16: каждые 5 минут). Сообщений в чат: ${w.discord.posted.length}.`);
