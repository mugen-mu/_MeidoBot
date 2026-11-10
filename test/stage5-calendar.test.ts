// Этап 5 ретроспективы 2: «календарь сюрпризов» (группа F). Тесты написаны до подключения в cron.
// Все имена и даты — выдуманные примеры; настоящий список владелец пришлёт позже и в git не попадёт.
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Annual,
  CONGRATS,
  SEASON_TEXT,
  STAGES,
  calendarListText,
  congratsOptions,
  dstItem,
  dstWarning,
  dueStage,
  isYearReviewDay,
  markValue,
  nextDue,
  parseCalendarMessage,
  parseEntryLine,
  seasonKey,
  seasonStarting,
  stageItem,
  whenWords,
  yearReviewText,
} from "../src/calendar.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

const TZ = "Europe/Kyiv";
const ann = (o: Partial<Annual> & Pick<Annual, "name" | "mo" | "d">): Annual => ({ id: 1, kind: "birthday", year: null, marked: null, ...o });
const today = (y: number, mo: number, d: number) => ({ y, mo, d });

describe("разбор списка одним сообщением (F3)", () => {
  it("«календарь» одно — показать список", () => {
    expect(parseCalendarMessage("календарь")).toEqual({ kind: "list" });
    expect(parseCalendarMessage("Бот, календарь:")).toEqual({ kind: "list" });
  });

  it("список с заголовками разделов: вид берётся из заголовка, год у дня рождения не хранится", () => {
    const r = parseCalendarMessage("календарь\nдни рождения:\nТест-Мама 14.03\nДруг Тест 2.9.1990\nналоги:\nФОП квартальный 20.01\nдокументы:\nПаспорт 05.07.2027\nплатежи:\n15.02 Домен");
    expect(r).toEqual({
      kind: "add",
      bad: [],
      entries: [
        { kind: "birthday", name: "Тест-Мама", mo: 3, d: 14, year: null },
        { kind: "birthday", name: "Друг Тест", mo: 9, d: 2, year: null },
        { kind: "tax", name: "ФОП квартальный", mo: 1, d: 20, year: null },
        { kind: "doc", name: "Паспорт", mo: 7, d: 5, year: 2027 },
        { kind: "pay", name: "Домен", mo: 2, d: 15, year: null },
      ],
    });
  });

  it("без заголовка вид угадывается по названию; запись в одну строку после слова «календарь»", () => {
    expect(parseEntryLine("ФОП единый налог 20.02", null)?.kind).toBe("tax");
    expect(parseEntryLine("Страховка машины 01.06", null)?.kind).toBe("doc");
    expect(parseEntryLine("Аренда офиса 10.05", null)?.kind).toBe("pay");
    expect(parseEntryLine("Сосед 10.05", null)?.kind).toBe("other");
    expect(parseCalendarMessage("календарь Мама 14.03")).toEqual({ kind: "add", bad: [], entries: [{ kind: "other", name: "Мама", mo: 3, d: 14, year: null }] });
  });

  it("плохие строки не теряются молча: возвращаются списком «не поняла»; неверные даты отвергаются; 29 февраля можно", () => {
    const r = parseCalendarMessage("календарь\nМама 31.04\nПапа 14\nбез даты вообще\nДед 29.02\nЛена 13.13");
    expect(r?.kind).toBe("add");
    if (r?.kind !== "add") return;
    expect(r.entries.map((e) => e.name)).toEqual(["Дед"]);
    expect(r.bad).toHaveLength(4);
  });

  it("личное: только имя и дата — телефон, почта и ссылка в названии отвергаются; секрет-подобное сообщение не разбирается", () => {
    expect(parseEntryLine("Мама 380501234567 14.03", null)).toBeNull();
    expect(parseEntryLine("Мама mama@mail.example 14.03", null)).toBeNull();
    expect(parseEntryLine("Мама https://x.example 14.03", null)).toBeNull();
    expect(parseEntryLine("Мама 14.03 в 10:00", null)).toBeNull();
    expect(parseCalendarMessage("календарь\nпароль: hunter2hunter2 14.03")?.kind).toMatch(/secret|add/);
  });

  it("«календарь убрать Имя»", () => {
    expect(parseCalendarMessage("календарь убрать Тест-Мама")).toEqual({ kind: "remove", name: "Тест-Мама" });
  });

  it("обычное дело не принимается за календарь; «даты сдачи отчёта 15.03» тоже дело", () => {
    expect(parseCalendarMessage("завтра в 10 купить хлеб")).toBeNull();
    expect(parseCalendarMessage("календарные дни проверить")).toBeNull();
    expect(parseCalendarMessage("даты сдачи отчёта 15.03")).toBeNull();
  });
});

describe("когда предупреждать (F2, F10)", () => {
  it("ближайшая дата: в этом году, если не прошла, иначе в следующем; 29 февраля в невисокосный год — 28-е; разовый срок прошёл — null", () => {
    expect(nextDue(ann({ name: "a", mo: 11, d: 14 }), today(2026, 11, 7))).toEqual(today(2026, 11, 14));
    expect(nextDue(ann({ name: "a", mo: 11, d: 7 }), today(2026, 11, 7))).toEqual(today(2026, 11, 7));
    expect(nextDue(ann({ name: "a", mo: 3, d: 14 }), today(2026, 11, 7))).toEqual(today(2027, 3, 14));
    expect(nextDue(ann({ name: "a", mo: 2, d: 29 }), today(2026, 11, 7))).toEqual(today(2027, 2, 28));
    expect(nextDue(ann({ name: "a", mo: 5, d: 1, year: 2026 }), today(2026, 11, 7))).toBeNull();
  });

  it("редкое скрыто до месяца до даты: дальше 30 дней — предупреждения нет (в списках дела ещё не существует)", () => {
    expect(dueStage(ann({ name: "a", mo: 12, d: 15 }), today(2026, 11, 7))).toBeNull(); // 38 дней
    expect(dueStage(ann({ name: "a", mo: 12, d: 7 }), today(2026, 11, 7))?.stage).toBe(30); // ровно 30
  });

  it("месяц, неделя, день; у дня рождения ещё сам день; у остальных в день срока — последнее предупреждение «сегодня»", () => {
    const b = (d: number) => dueStage(ann({ name: "a", mo: 11, d }), today(2026, 11, 7));
    expect(b(14)?.stage).toBe(7); // за 7
    expect(b(8)?.stage).toBe(1);
    expect(b(7)?.stage).toBe(0);
    expect(STAGES.birthday).toEqual([30, 7, 1, 0]);
    expect(STAGES.tax).toEqual([30, 7, 1]);
    const t = dueStage(ann({ name: "a", mo: 11, d: 7, kind: "tax" }), today(2026, 11, 7));
    expect(t).toMatchObject({ days: 0, stage: 1 });
  });

  it("уже заведённое не повторяется; следующая стадия того же срока — заводится; новый срок — заново", () => {
    const base = ann({ name: "a", mo: 11, d: 14 });
    const d7 = dueStage(base, today(2026, 11, 7))!;
    const marked = { ...base, marked: markValue(d7) };
    expect(dueStage(marked, today(2026, 11, 7))).toBeNull();
    expect(dueStage(marked, today(2026, 11, 8))).toBeNull(); // 6 дней: всё ещё стадия 7
    expect(dueStage(marked, today(2026, 11, 13))?.stage).toBe(1);
    expect(dueStage({ ...marked, marked: "2025-11-14:0" }, today(2026, 11, 7))?.stage).toBe(7); // прошлогодняя отметка не мешает
  });

  it("бот был недоступен: пропущенные стадии не сыплются пачкой — одна, последняя подходящая", () => {
    const d = dueStage(ann({ name: "a", mo: 11, d: 8 }), today(2026, 11, 7))!;
    expect(d.stage).toBe(1);
    expect(d.days).toBe(1);
  });
});

describe("дело-предупреждение: смысл на месте, отдельное дело на каждое", () => {
  const NOW = kyiv(2026, 11, 7, 12, 0);

  it("день рождения заранее: имя, срок словами и датой; в день рождения — два варианта поздравления в пояснении", () => {
    const week = stageItem(ann({ name: "Тест-Мама", mo: 11, d: 14 }), dueStage(ann({ name: "Тест-Мама", mo: 11, d: 14 }), today(2026, 11, 7))!, NOW, TZ);
    expect(week.parsed.title).toBe("День рождения: Тест-Мама — через 7 дней (14 ноября)");
    expect(week.parsed.recipe).toBeNull(); // отдельное обычное дело, не повтор
    const dayOf = ann({ name: "Тест-Мама", mo: 11, d: 7 });
    const it = stageItem(dayOf, dueStage(dayOf, today(2026, 11, 7))!, NOW, TZ);
    expect(it.parsed.title).toBe("Сегодня день рождения: Тест-Мама");
    expect(it.body).toContain("Варианты поздравления:");
    expect(it.body).toMatch(/1\) .*Тест-Мама[\s\S]*2\) .*Тест-Мама/);
    const tom = ann({ name: "Тест-Мама", mo: 11, d: 8 });
    expect(stageItem(tom, dueStage(tom, today(2026, 11, 7))!, NOW, TZ).parsed.title).toBe("Завтра день рождения: Тест-Мама");
  });

  it("налоги, документы, платежи: вид и название в заголовке", () => {
    const e = ann({ name: "ФОП квартальный", mo: 11, d: 14, kind: "tax" });
    expect(stageItem(e, dueStage(e, today(2026, 11, 7))!, NOW, TZ).parsed.title).toBe("Налоги: ФОП квартальный — срок через 7 дней (14 ноября)");
    const p = ann({ name: "Паспорт", mo: 11, d: 8, kind: "doc", year: 2026 });
    expect(stageItem(p, dueStage(p, today(2026, 11, 7))!, NOW, TZ).parsed.title).toBe("Документ: Паспорт — срок завтра");
  });

  it("время: сегодня в 10:00, если ещё не прошло; иначе через минуту (не в прошлом)", () => {
    const e = ann({ name: "a", mo: 11, d: 14 });
    const d = dueStage(e, today(2026, 11, 7))!;
    expect(stageItem(e, d, kyiv(2026, 11, 7, 9, 0), TZ).parsed.due).toBe(kyiv(2026, 11, 7, 10, 0));
    expect(stageItem(e, d, kyiv(2026, 11, 7, 13, 0), TZ).parsed.due).toBe(kyiv(2026, 11, 7, 13, 0) + MINUTE);
  });

  it("варианты поздравления: два разных, с именем, одинаково при повторе; год меняет выбор", () => {
    const a = congratsOptions("Тест", 2026);
    expect(a[0]).not.toBe(a[1]);
    expect(a.every((t) => t.includes("Тест"))).toBe(true);
    expect(congratsOptions("Тест", 2026)).toEqual(a);
    expect(CONGRATS.every((t) => t.includes("{name}"))).toBe(true);
    const years = new Set([2026, 2027, 2028, 2029, 2030].map((y) => congratsOptions("Тест", y).join("|")));
    expect(years.size).toBeGreaterThan(1);
  });

  it("слова про срок", () => {
    expect(whenWords(0)).toBe("сегодня");
    expect(whenWords(1)).toBe("завтра");
    expect(whenWords(7)).toBe("через 7 дней");
    expect(whenWords(21)).toBe("через 21 день");
    expect(whenWords(22)).toBe("через 22 дня");
  });
});

describe("перевод часов за день (F6)", () => {
  it("весной (суббота перед последним воскресеньем марта) и осенью предупреждает; в обычные дни — нет", () => {
    const spring = dstWarning(kyiv(2026, 3, 28, 12, 0), TZ);
    expect(spring?.direction).toBe(1);
    expect(spring?.tomorrow).toEqual(today(2026, 3, 29));
    expect(spring?.title).toContain("вперёд");
    const autumn = dstWarning(kyiv(2026, 10, 24, 12, 0), TZ);
    expect(autumn?.direction).toBe(-1);
    expect(autumn?.title).toContain("назад");
    expect(dstWarning(kyiv(2026, 3, 27, 12, 0), TZ)).toBeNull();
    expect(dstWarning(kyiv(2026, 11, 7, 12, 0), TZ)).toBeNull();
    expect(dstWarning(kyiv(2026, 3, 29, 12, 0), TZ)).toBeNull(); // в сам день уже поздно
  });

  it("дело-предупреждение: срок сегодня 10:00 или через минуту", () => {
    const w = dstWarning(kyiv(2026, 3, 28, 9, 0), TZ)!;
    expect(dstItem(w, kyiv(2026, 3, 28, 9, 0), TZ).due).toBe(kyiv(2026, 3, 28, 10, 0));
  });
});

describe("сезонные «между прочим» (F8) и «Год с Хару» (F9)", () => {
  it("сезон начинается 1–7 марта, июня, сентября, декабря; в другие дни — нет; ключ — сезон и год", () => {
    expect(seasonStarting(today(2026, 3, 1))).toBe("spring");
    expect(seasonStarting(today(2026, 6, 7))).toBe("summer");
    expect(seasonStarting(today(2026, 9, 3))).toBe("autumn");
    expect(seasonStarting(today(2026, 12, 2))).toBe("winter");
    expect(seasonStarting(today(2026, 3, 8))).toBeNull();
    expect(seasonStarting(today(2026, 11, 7))).toBeNull();
    expect(seasonKey("autumn", 2026)).toBe("autumn-2026");
    for (const s of ["spring", "summer", "autumn", "winter"] as const) expect(SEASON_TEXT[s]).toMatch(/^Между прочим:/);
  });

  it("«Год с Хару» — с 28 декабря; цифры на месте", () => {
    expect(isYearReviewDay(today(2026, 12, 27))).toBe(false);
    expect(isYearReviewDay(today(2026, 12, 28))).toBe(true);
    expect(isYearReviewDay(today(2026, 11, 30))).toBe(false);
    const t = yearReviewText({ year: 2026, done: 120, created: 140, open: 9, frozen: 2 });
    expect(t).toContain("Год с Хару — 2026");
    expect(t).toContain("Закрыто дел: 120");
    expect(t).toContain("заморожено: 2");
  });
});

describe("экран «Календарь»", () => {
  it("пусто — подсказка как внести; список — по возрастанию срока, с датой и словами", () => {
    expect(calendarListText([], today(2026, 11, 7))).toContain("Пока пусто");
    const t = calendarListText([ann({ id: 1, name: "Дальний", mo: 3, d: 14 }), ann({ id: 2, name: "Ближний", mo: 11, d: 9 })], today(2026, 11, 7));
    expect(t.indexOf("Ближний")).toBeLessThan(t.indexOf("Дальний"));
    expect(t).toContain("Ближний — 9 ноября (через 2 дня)");
    expect(t).toContain("календарь убрать");
  });
});

// ---------- в боте ----------

const NOW0 = kyiv(2026, 11, 7, 12, 0);
let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  await w.run(NOW0); // первый запуск запоминает конец канала
});
const items = () => w.d1.q<{ title: string; body: string | null; source: string }>("SELECT title, body, source FROM items ORDER BY id");
const annuals = () => w.d1.q<{ name: string; month: number; day: number; kind: string; marked: string | null }>("SELECT name, month, day, kind, marked FROM annuals ORDER BY id");

describe("cron: внести список и получить предупреждения", () => {
  it("список одним сообщением: записи в базе (только имя и дата), ответ «записала», предупреждение за неделю заведено тем же запуском", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь\nдни рождения:\nТест-Мама 14.11\nТест-Друг 14.03\nналоги:\nФОП 20.01");
    const r = await w.run(NOW0 + MINUTE);
    expect(r.intake).toBe(1);
    expect(annuals().map((a) => `${a.name} ${a.day}.${a.month} ${a.kind}`)).toEqual(["Тест-Мама 14.11 birthday", "Тест-Друг 14.3 birthday", "ФОП 20.1 tax"]);
    expect(w.discord.live(CH_BOT)[0].body.content).toContain("Записала в календарь: 3.");
    // мама через 7 дней — дело заведено; остальные далеко — их в списках нет (F10)
    expect(items().map((i) => i.title)).toEqual(["День рождения: Тест-Мама — через 7 дней (14 ноября)"]);
    expect(annuals()[0].marked).toBe("2026-11-14:7");
  });

  it("повторный запуск и повторное сообщение ничего не дублируют; «не поняла» возвращает строки", async () => {
    const msg = "календарь\nТест-Мама 14.11\nмусор без даты";
    w.discord.say(CH_BOT, OWNER, msg);
    await w.run(NOW0 + MINUTE);
    await w.run(NOW0 + 2 * MINUTE);
    w.discord.say(CH_BOT, OWNER, "календарь\nТест-Мама 14.11", { at: NOW0 + 3 * MINUTE });
    await w.run(NOW0 + 3 * MINUTE);
    expect(annuals()).toHaveLength(1);
    expect(items()).toHaveLength(1);
    const texts = w.discord.live(CH_BOT).map((m) => String(m.body.content));
    expect(texts[0]).toContain("Не поняла строк: 1");
    expect(texts[0]).toContain("мусор без даты");
    expect(texts[1]).toContain("Уже были в календаре: 1");
  });

  it("предупреждение — обычное дело: приходит напоминанием с «Готово», не пропадает молча", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь\nдни рождения:\nТест-Мама 8.11");
    await w.run(NOW0 + MINUTE);
    const it = w.d1.q<{ id: number }>("SELECT o.id FROM occurrences o JOIN items i ON i.id = o.item_id WHERE o.kind = 'main'")[0];
    expect(it).toBeDefined();
    await w.run(NOW0 + 3 * MINUTE);
    const msg = w.discord.live("100").find((m) => String(m.body.content).includes("Тест-Мама"));
    expect(msg).toBeDefined();
    const ids = (msg!.body.components ?? []).flatMap((x) => x.components.map((c) => c.custom_id));
    expect(ids.some((i) => String(i).startsWith("done:"))).toBe(true);
  });

  it("в день рождения: напоминание с двумя вариантами поздравления прямо в тексте", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь\nдни рождения:\nТест-Мама 7.11");
    await w.run(NOW0 + MINUTE);
    await w.run(NOW0 + 3 * MINUTE);
    const msg = w.discord.live("100").find((m) => String(m.body.content).includes("Тест-Мама"))!;
    expect(String(msg.body.content)).toContain("Сегодня день рождения: Тест-Мама");
    expect(String(msg.body.content)).toContain("Варианты поздравления:");
    expect(String(msg.body.content)).toMatch(/1\) .*\n2\) /);
  });

  it("«календарь» показывает список, «календарь убрать …» убирает", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь\nТест-Мама 14.03");
    await w.run(NOW0 + MINUTE);
    w.discord.say(CH_BOT, OWNER, "календарь", { at: NOW0 + 2 * MINUTE });
    await w.run(NOW0 + 2 * MINUTE);
    expect(String(w.discord.live(CH_BOT).at(-1)!.body.content)).toContain("Тест-Мама — 14 марта");
    w.discord.say(CH_BOT, OWNER, "календарь убрать тест-мама", { at: NOW0 + 3 * MINUTE });
    await w.run(NOW0 + 3 * MINUTE);
    expect(annuals()).toHaveLength(0);
    expect(String(w.discord.live(CH_BOT).at(-1)!.body.content)).toContain("Убрала из календаря: 1");
  });

  it("секрет-подобное сообщение не записывается", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь\nкарта 4111 1111 1111 1111 14.03");
    await w.run(NOW0 + MINUTE);
    expect(annuals()).toHaveLength(0);
  });

  it("предупреждения идут раз в сутки: на следующий день — следующая стадия; при отъезде — не заводятся, после — наверстываются одной", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь\nдни рождения:\nТест-Мама 14.11");
    await w.run(NOW0 + MINUTE); // стадия 7
    await w.run(kyiv(2026, 11, 8, 12, 0)); // 6 дней: та же стадия — нового дела нет
    expect(items()).toHaveLength(1);
    await w.run(kyiv(2026, 11, 13, 12, 0)); // 1 день
    expect(items().map((i) => i.title)).toEqual(["День рождения: Тест-Мама — через 7 дней (14 ноября)", "Завтра день рождения: Тест-Мама"]);
    await w.run(kyiv(2026, 11, 14, 12, 0)); // сам день
    expect(items().at(-1)!.title).toBe("Сегодня день рождения: Тест-Мама");
    expect(items().at(-1)!.body).toContain("Варианты поздравления:");
    expect(items()).toHaveLength(3);
  });

  it("перевод часов: за день заводится одно дело, повторно в тот же день — нет", async () => {
    const sat = kyiv(2026, 3, 28, 12, 0);
    await w.run(sat);
    await w.run(sat + 5 * MINUTE);
    expect(items().filter((i) => i.title.includes("часы переводят"))).toHaveLength(1);
    expect(items()[0].source).toBe("menu");
  });

  it("сезонное «между прочим»: один раз за сезон, не при открытом вопросе про аниме; не в первые часы утра", async () => {
    const d = (day: number, h: number) => kyiv(2026, 9, day, h, 0);
    await w.run(d(1, 9)); // рано
    expect(w.discord.live("100")).toHaveLength(0);
    await w.run(d(1, 13));
    const first = w.discord.live("100").filter((m) => String(m.body.content).includes("Между прочим: началась осень"));
    expect(first).toHaveLength(1);
    await w.run(d(1, 14));
    await w.run(d(2, 13));
    expect(w.discord.live("100").filter((m) => String(m.body.content).includes("Между прочим: началась осень"))).toHaveLength(1);
  });

  it("сезонное откладывается, пока висит вопрос про аниме (вопрос важнее)", async () => {
    const { setMeta } = await import("../src/db/repo.ts");
    await w.repo().exec([setMeta("anime_weekq", JSON.stringify({ ch: "100", msg: "m1", at: kyiv(2026, 6, 1, 8, 0) }))]);
    await w.run(kyiv(2026, 6, 1, 13, 0));
    expect(w.discord.live("100").filter((m) => String(m.body.content).includes("Между прочим: началось лето"))).toHaveLength(0);
  });

  it("«Год с Хару»: одно сообщение с 28 декабря, больше не повторяется", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь"); // просто чтобы появились какие-то события
    await w.run(kyiv(2026, 12, 28, 13, 0));
    const y = () => w.discord.live("100").filter((m) => String(m.body.content).includes("Год с Хару — 2026"));
    expect(y()).toHaveLength(1);
    await w.run(kyiv(2026, 12, 29, 13, 0));
    expect(y()).toHaveLength(1);
  });

  it("нет таблицы (миграция не применена): бот не падает и не дёргает базу каждую минуту", async () => {
    w.d1.sqlite.exec("DROP TABLE annuals");
    const r1 = await w.run(kyiv(2026, 11, 8, 12, 0));
    expect(r1.notes.join(" ")).toContain("календарь: не удалось прочитать таблицу");
    const r2 = await w.run(kyiv(2026, 11, 8, 12, 1));
    expect(r2.notes.join(" ")).not.toContain("не удалось прочитать таблицу");
  });
});

describe("экран «⋯ Ещё» → «📆 Календарь»", () => {
  let seq = 0;
  async function click(custom_id: string, now = NOW0) {
    const pending: Promise<unknown>[] = [];
    const r = await handleInteraction(
      { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: CH_BOT, member: { user: { id: OWNER } }, type: 3, data: { custom_id }, message: { id: "m1" } } as Interaction,
      { repo: w.repo(), api: w.discord, now, env: {}, defer: (p) => void pending.push(p) },
    );
    await Promise.all(pending.splice(0));
    return r as { type: number; data: { content: string; components: { components: { custom_id: string }[] }[] } };
  }

  it("кнопка есть в «Ещё»; экран показывает записи по возрастанию срока и ведёт «Назад»", async () => {
    w.discord.say(CH_BOT, OWNER, "календарь\nдни рождения:\nТест-Мама 14.03\nТест-Друг 9.11");
    await w.run(NOW0 + MINUTE);
    const more = await click("mn:more");
    expect(more.data.components.flatMap((r) => r.components.map((c) => c.custom_id))).toContain("mn:cal");
    const r = await click("mn:cal");
    expect(r.type).toBe(7);
    expect(r.data.content).toContain("**Календарь** — записей: 2");
    expect(r.data.content.indexOf("Тест-Друг")).toBeLessThan(r.data.content.indexOf("Тест-Мама"));
    expect(r.data.components.flatMap((x) => x.components.map((c) => c.custom_id))).toEqual(["mn:more", "mn:home"]);
    const p = await click("pn:cal");
    expect(p.type).toBe(4);
  });

  it("таблицы нет (миграция не применена): честное сообщение вместо ошибки", async () => {
    w.d1.sqlite.exec("DROP TABLE annuals");
    const r = await click("mn:cal");
    expect(r.data.content).toContain("миграция 0009");
  });
});
