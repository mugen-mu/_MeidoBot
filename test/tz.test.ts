import { describe, expect, it } from "vitest";
import {
  addDaysWall,
  fmtHHMM,
  nextTimeOfDay,
  offsetAt,
  parseHHMM,
  startOfDay,
  wallOf,
  wallToUtc,
} from "../src/time/tz.ts";
import { TZ, iso, kyiv } from "./helpers.ts";

describe("tz", () => {
  it("смещение Киева: зима +2, лето +3", () => {
    expect(offsetAt(Date.UTC(2026, 0, 15, 12), TZ)).toBe(2 * 3600_000);
    expect(offsetAt(Date.UTC(2026, 6, 15, 12), TZ)).toBe(3 * 3600_000);
  });

  it("стенное время -> UTC и обратно", () => {
    const t = kyiv(2026, 11, 7, 12, 0);
    expect(iso(t)).toBe("2026-11-07T10:00:00.000Z");
    const w = wallOf(t, TZ);
    expect([w.y, w.mo, w.d, w.h, w.mi, w.wd]).toEqual([2026, 11, 7, 12, 0, 6]);
  });

  it("перевод вперёд (29 марта 2026, 03:00 -> 04:00): несуществующее 03:30 сдвигается на 04:30", () => {
    const t = wallToUtc({ y: 2026, mo: 3, d: 29, h: 3, mi: 30 }, TZ);
    const w = wallOf(t, TZ);
    expect([w.h, w.mi]).toEqual([4, 30]);
  });

  it("перевод назад (25 октября 2026, 04:00 -> 03:00): повторяющееся 03:30 — раннее (летнее)", () => {
    const t = wallToUtc({ y: 2026, mo: 10, d: 25, h: 3, mi: 30 }, TZ);
    expect(iso(t)).toBe("2026-10-25T00:30:00.000Z"); // 03:30 EEST = 00:30 UTC
  });

  it("addDaysWall держит стенное время через переход на летнее", () => {
    const sat = kyiv(2026, 3, 28, 9, 0);
    const mon = addDaysWall(sat, 1, TZ); // 29 марта: сутки по 23 часа
    const w = wallOf(mon, TZ);
    expect([w.d, w.h]).toEqual([29, 9]);
    expect(mon - sat).toBe(23 * 3600_000);
  });

  it("startOfDay и nextTimeOfDay", () => {
    const t = kyiv(2026, 11, 7, 15, 40);
    expect(startOfDay(t, TZ)).toBe(kyiv(2026, 11, 7, 0, 0));
    expect(nextTimeOfDay(t, 8 * 60, TZ)).toBe(kyiv(2026, 11, 8, 8, 0));
    expect(nextTimeOfDay(t, 20 * 60, TZ)).toBe(kyiv(2026, 11, 7, 20, 0));
  });

  it("parseHHMM / fmtHHMM", () => {
    expect(parseHHMM("08:00")).toBe(480);
    expect(parseHHMM("8.30")).toBe(510);
    expect(parseHHMM("25:00")).toBeNull();
    expect(parseHHMM("выкл")).toBeNull();
    expect(fmtHHMM(75)).toBe("01:15");
  });
});
