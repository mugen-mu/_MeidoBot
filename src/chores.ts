// Дела-сопровождение (этап 4 ретроспективы 2, A9 и A10): бот сам заводит себе «хозяйственные» напоминания —
// копия базы раз в месяц, зависимости и срок моделей раз в квартал, ключи и токены раз в год.
// Это обычные дела: приходят в «почту», не исчезают без «Готово», видны в списках. Чистая логика: время и память («что уже заведено») — аргументами.
import { localDate, nextTimeOfDay, wallOf } from "./time/tz.ts";
import type { Parsed } from "./time/parse.ts";

export interface Chore {
  id: string;
  title: string;
  /** пояснение в карточке дела: что именно сделать, простыми словами */
  body: string;
  /** месяцы (1–12), в которые дело заводится */
  months: number[];
  /** с какого числа месяца (если бот был недоступен — заведёт позже, как только заработает) */
  day: number;
}

const EVERY_MONTH = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const QUARTERLY = [1, 4, 7, 10];

export const CHORES: Chore[] = [
  {
    id: "backup",
    title: "Сделать копию базы бота",
    body: "На ПК в папке DiscordBot выполните `npm run export`: копия всех дел ляжет в папку backups. Храните её в надёжном месте (не в git и не в чате).",
    months: EVERY_MONTH,
    day: 1,
  },
  {
    id: "deps",
    title: "Проверить обновления бота",
    body: "Раз в квартал: в папке DiscordBot выполните `npm audit` и `npm outdated`. Есть серьёзные предупреждения — попросите Claude обновить и выложить.",
    months: QUARTERLY,
    day: 8,
  },
  {
    id: "models",
    title: "Проверить срок модели для реплик",
    body: "Раз в квартал: в панели Cloudflare (Workers AI → Models) проверьте, что модель для живых реплик не снимают с поддержки. Снимают — попросите Claude заменить её.",
    months: QUARTERLY,
    day: 15,
  },
  {
    id: "keys",
    title: "Проверить ключи и токены бота",
    body: "Раз в год: токен бота (Developer Portal → Bot) и вход в Cloudflare. Если сомневаетесь, что они только у вас, сбросьте токен и запустите `setup.cmd` с новым значением. Ключ для телефона (свет), если пользуетесь, смените тоже.",
    months: [1],
    day: 22,
  },
];

/** Период записи «уже заведено»: месяц, например 2026-11 (хватает и для квартала, и для года: месяцы у дела заданы). */
export const periodKey = (now: number, tz: string): string => localDate(now, tz).slice(0, 7);
export const choreMetaKey = (id: string): string => `chore:${id}`;

/** Какие дела пора завести сегодня; `recorded(key)` — что в мете (период последнего заведения). */
export function choresDue(now: number, tz: string, recorded: (key: string) => string | undefined): Chore[] {
  const w = wallOf(now, tz);
  const period = periodKey(now, tz);
  return CHORES.filter((c) => c.months.includes(w.mo) && w.d >= c.day && recorded(choreMetaKey(c.id)) !== period);
}

/** Дело как разобранная фраза: срок — сегодня в 18:00 (если уже позже — завтра), без повтора и без «заранее». */
export function choreParsed(c: Chore, now: number, tz: string): Parsed {
  return {
    title: c.title,
    due: nextTimeOfDay(now, 18 * 60, tz),
    past: false,
    recipe: null,
    leadDays: [],
    critical: false,
    timer: false,
    seriesEmpty: false,
  };
}
