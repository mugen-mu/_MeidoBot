import { describe, expect, it } from "vitest";
import {
  PRESETS,
  SINGLE,
  describeSpec,
  firstFireAt,
  ladderFromSpec,
  needsSnoozeQuestion,
  parseCustomSteps,
  parseSpec,
  planFire,
  schedule,
} from "../src/ladder.ts";
import { MINUTE } from "../src/time/tz.ts";

const base = 1_800_000_000_000;
const std = PRESETS.standard;

describe("лестница настойчивости", () => {
  it("стандарт: 0, +10, +20, +40, потом просрочено через 2 ч и повторы раз в 2 ч (3 раза)", () => {
    expect(schedule(std)).toEqual([0, 10, 20, 40, 120, 240, 360]);
  });

  it("шаг за шагом: следующий момент и номера", () => {
    let fc = 0;
    const times: number[] = [];
    let now = base;
    for (let i = 0; i < 20; i++) {
      const p = planFire(std, base, fc, now);
      if (!p) break;
      times.push(Math.round((now - base) / MINUTE));
      fc = p.index + 1;
      if (p.nextAt === null) break;
      now = p.nextAt;
    }
    expect(times).toEqual([0, 10, 20, 40, 120, 240, 360]);
  });

  it("фазы: первые четыре — лестница, дальше — просрочено", () => {
    expect(planFire(std, base, 0, base)?.phase).toBe("ladder");
    expect(planFire(std, base, 3, base + 40 * MINUTE)?.ordinal).toBe(4);
    const p = planFire(std, base, 4, base + 120 * MINUTE);
    expect(p?.phase).toBe("overdue");
    expect(p?.ordinal).toBe(1);
  });

  it("после последнего «просрочено» дальше только сводки (nextAt = null), потом плана нет", () => {
    const last = planFire(std, base, 6, base + 360 * MINUTE);
    expect(last?.nextAt).toBeNull();
    expect(planFire(std, base, 7, base + 9999 * MINUTE)).toBeNull();
  });

  it("догонялка: после простоя одно сообщение за последний наступивший шаг, а не серия", () => {
    const p = planFire(std, base, 0, base + 5 * 60 * MINUTE); // молчали 5 часов
    expect(p?.index).toBe(5); // 240 мин: второе «просрочено»
    expect(p?.phase).toBe("overdue");
    expect(p?.nextAt).toBe(base + 360 * MINUTE);
    expect(p?.lateMinutes).toBe(300);
  });

  it("одна отправка без повторов (таймеры, «заранее»)", () => {
    expect(schedule(SINGLE)).toEqual([0]);
    expect(planFire(SINGLE, base, 0, base)?.nextAt).toBeNull();
  });

  it("firstFireAt", () => {
    expect(firstFireAt(std, base)).toBe(base);
  });

  it("свои числа: 0 добавляется, порядок и мусор", () => {
    expect(parseCustomSteps("5 15, 30")).toEqual([0, 5, 15, 30]);
    expect(parseCustomSteps("30 10 10")).toEqual([0, 10, 30]);
    expect(parseCustomSteps("abc")).toBeNull();
    expect(parseCustomSteps("-5")).toBeNull();
    expect(parseCustomSteps("")).toBeNull();
    const l = ladderFromSpec({ custom: [0, 5, 15] });
    expect(l.steps).toEqual([0, 5, 15]);
    expect(l.overdueAfter).toBe(75);
  });

  it("настройка хранится JSON, битая -> null", () => {
    expect(parseSpec('{"preset":"strong"}')).toEqual({ preset: "strong" });
    expect(parseSpec('{"custom":[0,5]}')).toEqual({ custom: [0, 5] });
    expect(parseSpec("{oops")).toBeNull();
    expect(parseSpec(null)).toBeNull();
    expect(describeSpec({ preset: "soft" })).toBe("мягко");
  });

  it("на 3-е откладывание бот спрашивает", () => {
    expect(needsSnoozeQuestion(0)).toBe(false);
    expect(needsSnoozeQuestion(1)).toBe(false);
    expect(needsSnoozeQuestion(2)).toBe(true);
  });
});
