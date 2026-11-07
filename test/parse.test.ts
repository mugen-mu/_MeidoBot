import { describe, expect, it } from "vitest";
import { describeLead, describeRecipe, formatWhen } from "../src/time/format.ts";
import { cleanTitle, normalizeEvery, parseInput, parseWhen } from "../src/time/parse.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";

const p = (text: string, now = NOW) => parseInput(text, { now, tz: TZ });

describe("разовые фразы (сейчас: суббота 7 ноября 2026, 12:00)", () => {
  it("завтра в 10 купить хлеб", () => {
    const r = p("завтра в 10 купить хлеб");
    expect(r.title).toBe("Купить хлеб");
    expect(r.due).toBe(kyiv(2026, 11, 8, 10, 0));
    expect(r.recipe).toBeNull();
    expect(r.past).toBe(false);
  });

  it("дата с названием месяца и временем: «15 ноября в 9:00» не теряет дату (баг из пробы Workers AI 2026-11)", () => {
    for (const [text, d, h, mi, title] of [
      ["15 ноября в 9:00 позвонить маме", 15, 9, 0, "Позвонить маме"],
      ["14 ноября в 14:00 встреча", 14, 14, 0, "Встреча"],
      ["15 ноября 9:00 позвонить маме", 15, 9, 0, "Позвонить маме"],
      ["20 ноября в 9 купить хлеб", 20, 9, 0, "Купить хлеб"],
      ["позвонить маме 15 ноября в 18:30", 15, 18, 30, "Позвонить маме"],
    ] as const) {
      const r = p(text);
      expect(r.due, text).toBe(kyiv(2026, 11, d, h, mi));
      expect(r.title, text).toBe(title);
    }
  });

  it("напомни мне завтра в 10:30 позвонить маме", () => {
    const r = p("напомни мне завтра в 10:30 позвонить маме");
    expect(r.title).toBe("Позвонить маме");
    expect(r.due).toBe(kyiv(2026, 11, 8, 10, 30));
  });

  it("через 20 минут проверить плиту", () => {
    const r = p("через 20 минут проверить плиту");
    expect(r.title).toBe("Проверить плиту");
    expect(r.due).toBe(NOW + 20 * MINUTE);
    expect(r.recipe).toBeNull();
  });

  it("через полчаса / через час / через 2 часа 30 минут / через 3 дня", () => {
    expect(p("через полчаса выключить").due).toBe(NOW + 30 * MINUTE);
    expect(p("через час выключить").due).toBe(NOW + 60 * MINUTE);
    expect(p("через 2 часа 30 минут выключить").due).toBe(NOW + 150 * MINUTE);
    expect(p("через 3 дня позвонить").due).toBe(kyiv(2026, 11, 10, 12, 0));
  });

  it("в пятницу в 15:00 отчёт", () => {
    const r = p("в пятницу в 15:00 отчёт");
    expect(r.title).toBe("Отчёт");
    expect(r.due).toBe(kyiv(2026, 11, 13, 15, 0));
  });

  it("в субботу (сегодня суббота): время прошло — следующая суббота", () => {
    expect(p("в субботу в 10:00 уборка").due).toBe(kyiv(2026, 11, 14, 10, 0));
    expect(p("в субботу в 18:00 уборка").due).toBe(kyiv(2026, 11, 7, 18, 0));
  });

  it("в следующую пятницу — пятница следующей недели", () => {
    expect(p("в следующую пятницу в 9 встреча").due).toBe(kyiv(2026, 11, 13, 9, 0));
    expect(p("в следующую субботу в 9 встреча").due).toBe(kyiv(2026, 11, 14, 9, 0));
  });

  it("только время: сегодня, если ещё впереди, иначе завтра", () => {
    expect(p("в 23:00 выключить свет").due).toBe(kyiv(2026, 11, 7, 23, 0));
    expect(p("в 9 утра зарядка").due).toBe(kyiv(2026, 11, 8, 9, 0));
  });

  it("части суток и «вечера»", () => {
    expect(p("завтра утром позвонить").due).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(p("сегодня вечером полить цветы").due).toBe(kyiv(2026, 11, 7, 19, 0));
    expect(p("завтра в 10 часов вечера отбой").due).toBe(kyiv(2026, 11, 8, 22, 0));
    expect(p("в 8 вечера ужин").due).toBe(kyiv(2026, 11, 7, 20, 0));
  });

  it("дата с месяцем и без часа: время по умолчанию 09:00", () => {
    expect(p("20 ноября оплатить ФОП").due).toBe(kyiv(2026, 11, 20, 9, 0));
    expect(p("15 марта 2027 в 10:00 отчёт").due).toBe(kyiv(2027, 3, 15, 10, 0));
    expect(p("11.14 в 10:00 стоматолог").due).toBe(kyiv(2026, 11, 14, 10, 0));
    expect(p("01.03 поздравить").due).toBe(kyiv(2027, 1, 3, 9, 0));
    // ввод американский: месяц.день[.год] (решение пользователя 2026-11-08)
    expect(p("11.20 оплатить ФОП").due).toBe(kyiv(2026, 11, 20, 9, 0));
    expect(p("11.20.2026 в 10:00 отчёт").due).toBe(kyiv(2026, 11, 20, 10, 0));
    expect(p("1.5.27 в 8:30 звонок").due).toBe(kyiv(2027, 1, 5, 8, 30));
    // «20.11» больше не дата (нет 20-го месяца): текст остаётся в названии, срока нет
    const bad = p("20.11 позвонить");
    expect(bad.due).toBeNull();
    expect(bad.title).toContain("20.11");
  });

  it("число месяца: 20-го — ближайшее", () => {
    expect(p("20-го оплатить аренду").due).toBe(kyiv(2026, 11, 20, 9, 0));
    expect(p("5-го оплатить аренду").due).toBe(kyiv(2026, 12, 5, 9, 0));
  });

  it("без времени: due = null, название сохранено", () => {
    const r = p("купить хлеб");
    expect(r.due).toBeNull();
    expect(r.title).toBe("Купить хлеб");
  });

  it("«в 5 магазинов» без даты — не время", () => {
    expect(p("зайти в 5 магазинов").due).toBeNull();
  });

  it("прошедшее время помечается", () => {
    const r = p("сегодня в 8:00 зарядка");
    expect(r.past).toBe(true);
  });

  it("parseWhen для «На…» и /snooze", () => {
    expect(parseWhen("завтра 10:30", { now: NOW, tz: TZ })?.due).toBe(kyiv(2026, 11, 8, 10, 30));
    expect(parseWhen("через 2 часа", { now: NOW, tz: TZ })?.due).toBe(NOW + 120 * MINUTE);
    expect(parseWhen("абракадабра", { now: NOW, tz: TZ })).toBeNull();
    expect(parseWhen("каждый день в 9", { now: NOW, tz: TZ })).toBeNull();
  });
});

describe("повторяющиеся и таймеры", () => {
  it("каждые 20 минут проверить плиту до 23:00 — таймер", () => {
    const r = p("каждые 20 минут проверить плиту до 23:00");
    expect(r.title).toBe("Проверить плиту");
    expect(r.timer).toBe(true);
    expect(r.recipe).toMatchObject({ freq: "minutes", interval: 20, until: kyiv(2026, 11, 7, 23, 0) });
    expect(r.due).toBe(NOW + 20 * MINUTE);
  });

  it("до 23:00 в начале фразы", () => {
    const r = p("каждые 30 минут до 22:00 проверять духовку");
    expect(r.title).toBe("Проверять духовку");
    expect(r.recipe?.until).toBe(kyiv(2026, 11, 7, 22, 0));
  });

  it("каждый месяц 20-го оплатить ФОП заранее за 7, 3 и 1 день", () => {
    const r = p("каждый месяц 20-го оплатить ФОП заранее за 7, 3 и 1 день");
    expect(r.title).toBe("Оплатить ФОП");
    expect(r.recipe).toMatchObject({ freq: "months", interval: 1, monthDay: 20, at: { h: 9, mi: 0 } });
    expect(r.due).toBe(kyiv(2026, 11, 20, 9, 0));
    expect(r.leadDays).toEqual([7, 3, 1]);
    expect(r.timer).toBe(false);
  });

  it("20-го числа каждого месяца в 10:00", () => {
    const r = p("20-го числа каждого месяца в 10:00 отчёт");
    expect(r.recipe).toMatchObject({ freq: "months", monthDay: 20, at: { h: 10, mi: 0 } });
    expect(r.title).toBe("Отчёт");
  });

  it("последний день месяца", () => {
    const r = p("в последний день месяца сдать табель");
    expect(r.recipe).toMatchObject({ freq: "months", monthDay: "last" });
    expect(r.due).toBe(kyiv(2026, 11, 30, 9, 0));
    expect(r.title).toBe("Сдать табель");
    const r2 = p("каждый месяц в последний день платёж");
    expect(r2.recipe).toMatchObject({ freq: "months", monthDay: "last" });
  });

  it("каждую вторую пятницу в 15:00 отчёт", () => {
    const r = p("каждую вторую пятницу в 15:00 отчёт");
    expect(r.recipe).toMatchObject({ freq: "weeks", interval: 2, weekdays: [5], at: { h: 15, mi: 0 } });
    expect(r.due).toBe(kyiv(2026, 11, 13, 15, 0));
    expect(r.title).toBe("Отчёт");
  });

  it("каждую последнюю пятницу месяца / в первый понедельник каждого месяца", () => {
    expect(p("в последнюю пятницу месяца отчёт").recipe).toMatchObject({ freq: "months", nth: { n: -1, weekday: 5 } });
    expect(p("в первый понедельник каждого месяца планёрка").recipe).toMatchObject({
      freq: "months",
      nth: { n: 1, weekday: 1 },
    });
  });

  it("каждый день в 8:00, по будням, по понедельникам и средам", () => {
    const d = p("каждый день в 8:00 таблетки");
    expect(d.recipe).toMatchObject({ freq: "days", interval: 1, at: { h: 8, mi: 0 } });
    expect(d.due).toBe(kyiv(2026, 11, 8, 8, 0));
    expect(p("по будням в 9 планёрка").recipe).toMatchObject({ freq: "weeks", weekdays: [1, 2, 3, 4, 5] });
    expect(p("по понедельникам и средам в 18:00 зал").recipe).toMatchObject({ freq: "weeks", weekdays: [1, 3] });
    expect(p("каждый понедельник планёрка").recipe).toMatchObject({ freq: "weeks", interval: 1, weekdays: [1] });
  });

  it("каждые две недели, каждый квартал, раз в полгода, каждый год 15 марта", () => {
    expect(p("каждые две недели уборка").recipe).toMatchObject({ freq: "weeks", interval: 2 });
    expect(p("каждый квартал отчёт").recipe).toMatchObject({ freq: "months", interval: 3 });
    expect(p("раз в полгода осмотр").recipe).toMatchObject({ freq: "months", interval: 6 });
    const y = p("каждый год 15 марта поздравить");
    expect(y.recipe).toMatchObject({ freq: "years", month: 3, monthDay: 15 });
    expect(y.due).toBe(kyiv(2027, 3, 15, 9, 0));
  });

  it("каждый час, каждые 2 часа, каждые полчаса", () => {
    expect(p("каждый час пить воду").recipe).toMatchObject({ freq: "hours", interval: 1 });
    expect(p("каждые 2 часа разминка").recipe).toMatchObject({ freq: "hours", interval: 2 });
    expect(p("каждые полчаса проверять").recipe).toMatchObject({ freq: "minutes", interval: 30 });
  });

  it("критичное — флаг", () => {
    const r = p("критично завтра в 7 рейс");
    expect(r.critical).toBe(true);
    expect(r.title).toBe("Рейс");
  });

  it("повтор, уже закончившийся до первого срабатывания, помечается", () => {
    const r = p("каждые 20 минут проверить плиту до 12:10");
    expect(r.seriesEmpty).toBe(true);
    expect(r.recipe).toBeNull();
  });
});

describe("вспомогательное", () => {
  it("normalizeEvery для /every", () => {
    expect(normalizeEvery("20 минут проверить плиту")).toBe("каждые 20 минут проверить плиту");
    expect(normalizeEvery("каждый час вода")).toBe("каждый час вода");
    expect(normalizeEvery("две недели уборка")).toBe("каждые две недели уборка");
  });

  it("cleanTitle", () => {
    expect(cleanTitle("  напомни, что  надо купить хлеб ,")).toBe("Надо купить хлеб");
    expect(cleanTitle("в на ")).toBe("");
  });

  it("подписи времени", () => {
    expect(formatWhen(kyiv(2026, 11, 8, 10, 0), NOW, TZ)).toBe("завтра, 10:00");
    expect(formatWhen(NOW + 20 * MINUTE, NOW, TZ)).toBe("через 20 мин, 12:20");
    expect(formatWhen(kyiv(2026, 11, 13, 15, 0), NOW, TZ)).toBe("в пятницу, 15:00");
    expect(formatWhen(kyiv(2026, 11, 20, 9, 0), NOW, TZ)).toBe("11.20.2026, 09:00");
    expect(formatWhen(kyiv(2027, 1, 5, 9, 0), NOW, TZ)).toBe("01.05.2027, 09:00");
  });

  it("описание правил повтора", () => {
    const d = (t: string) => describeRecipe(p(t).recipe!, TZ);
    expect(d("каждые 20 минут плита до 23:00")).toBe("каждые 20 минут, до 23:00");
    expect(d("каждый месяц 20-го оплатить")).toBe("каждый месяц 20-го в 09:00");
    expect(d("каждую вторую пятницу в 15:00 отчёт")).toBe("каждую вторую пятницу в 15:00");
    expect(d("по будням в 9 планёрка")).toBe("по будням в 09:00");
    expect(d("в последний день месяца табель")).toBe("каждый месяц в последний день в 09:00");
    expect(describeLead([7, 3, 1])).toBe("за 7, 3 и 1 день");
    expect(describeLead([3])).toBe("за 3 дня");
  });
});
