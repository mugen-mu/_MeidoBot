// Сухой прогон: сутки работы бота на базе-заглушке и поддельном Discord, по минутам.
// Запуск: npm run dry-run. Ничего не отправляет наружу и не трогает настоящие базы.
import { CH_REMIND, World } from "../test/world.ts";
import { kyiv } from "../test/helpers.ts";
import { MINUTE } from "../src/time/tz.ts";

if (typeof process !== "undefined") process.stdout.setDefaultEncoding?.("utf8");

const w = new World();
await w.seed({ today: true });
const start = kyiv(2026, 11, 7, 7, 0);
const items = [
  "в 9:30 позвонить в банк",
  "через 20 минут проверить духовку",
  "каждые 30 минут разминка до 12:00",
  "каждый месяц 20-го оплатить ФОП заранее за 3 дня",
  "сегодня в 18:00 забрать посылку",
];
for (const t of items) await w.create(t, start);

const fmt = (ms: number) => new Date(ms + 2 * 3600_000).toISOString().slice(11, 16); // Киев зимой UTC+2
let sentTotal = 0;
let maxSub = 0;
for (let t = start; t < start + 24 * 60 * MINUTE; t += MINUTE) {
  const before = w.discord.posted.length;
  const rep = await w.run(t);
  maxSub = Math.max(maxSub, rep.subrequests);
  sentTotal += rep.sent;
  for (const p of w.discord.posted.slice(before)) {
    const first = (p.body.content ?? "").split("\n")[0].replace(/<@\d+>\s*/, "");
    console.log(`${fmt(t)} -> #${p.channel === CH_REMIND ? "напоминания" : p.channel}: ${first}`);
  }
}
console.log(`\nИтого за сутки: отправлено напоминаний ${sentTotal}, сообщений в канале ${w.discord.posted.length}, удалено ${w.discord.deletes.length}.`);
console.log(`Больше всего подзапросов за один запуск: ${maxSub} (предел бесплатного плана — 50).`);
