// Чистка пула фраз: единое обращение, ручные замены, идемпотентность и устойчивость к повторной загрузке.
import { describe, expect, it } from "vitest";
import { BASE_PHRASES } from "../src/personality/phrases.base.ts";
import { GENERATED } from "../src/personality/phrases.generated.ts";
import { PHRASE_FIXES, cleanupPool, normalizeAddress } from "../src/personality/poolCleanup.ts";
import { fill } from "../src/personality/speech.ts";
import { MOOD_CONFIG } from "../src/personality/config.ts";

const all = (bank: Record<string, Partial<Record<string, string[]>>>) =>
  Object.entries(bank).flatMap(([mood, sits]) => Object.entries(sits).flatMap(([sit, list]) => (list ?? []).map((t) => ({ mood, sit, t }))));

describe("чистка фраз: обращение", () => {
  it("«господин» и «хозяин» заменяются на {user}", () => {
    expect(normalizeAddress("Господин, вы пропустили.")).toBe("{user}, вы пропустили.");
    expect(normalizeAddress("Пора работать, хозяин.")).toBe("Пора работать, {user}.");
    expect(normalizeAddress("Вы лучший хозяин во всём мире")).toBe("Вы лучший {user} во всём мире");
    expect(normalizeAddress("Господин {user}, идите")).toBe("{user}, идите");
    expect(normalizeAddress("нет обращения")).toBe("нет обращения");
  });

  it("в готовых данных нет вшитых «господин»/«хозяин»", () => {
    for (const { mood, sit, t } of [...all(GENERATED), ...all(BASE_PHRASES)]) expect(t, `${mood}.${sit}`).not.toMatch(/господин|хозяин/iu);
  });

  it("после подстановки обращение — одно, из config.address", () => {
    const out = fill("{user}, пора за делом.", {}, { ...MOOD_CONFIG, address: "мастер" });
    expect(out).toBe("Мастер, пора за делом.");
  });
});

describe("чистка фраз: ручные замены", () => {
  it("каждая правка применена к текущему пулу", () => {
    const { report } = cleanupPool(GENERATED);
    expect(report.fixesStale.map((f) => `${f.mood}/${f.situation}/${f.from}`)).toEqual([]);
    expect(report.fixesApplied).toBe(PHRASE_FIXES.length);
  });

  it("чистка идемпотентна: повторный запуск ничего не меняет", () => {
    const once = cleanupPool(GENERATED);
    expect(once.report.addressReplaced).toBe(0);
    expect(once.pool).toEqual(GENERATED);
  });

  it("повторная загрузка «сырого» пула снова даёт те же данные", () => {
    // сырой пул: вернуть обращение и старый текст одной из правок
    const raw = structuredClone(GENERATED);
    const list = raw.yandere.reminder!;
    const fix = PHRASE_FIXES.find((f) => f.mood === "yandere" && f.situation === "reminder")!;
    list[list.indexOf(fix.to)] = fix.from + " …";
    list[0] = list[0].replace(/\{user\}/g, "Господин");
    const { pool } = cleanupPool(raw);
    expect(pool.yandere.reminder).toContain(fix.to);
    expect(pool.yandere.reminder!.join(" ")).not.toMatch(/господин/iu);
  });

  it("нет выдуманного «просрочек» в именительном падеже и «сегодня» в пропусках", () => {
    for (const { mood, sit, t } of all(GENERATED)) {
      expect(t, `${mood}.${sit}`).not.toMatch(/(?<!без )просрочек/iu);
      if (["missed", "missed_first", "done_late", "relief"].includes(sit)) expect(t, `${mood}.${sit}`).not.toMatch(/сегодня/iu);
    }
  });

  it("яндере остаётся безопасной: без слежки, угроз и принадлежности", () => {
    const bad = /(я вижу ваш|слышу ваше|замкну|заперт|вы мой|вы моя|вы принадлежите|найду вас|искать вас|не отпущу|от вас не отойду|навсегда с вами)/iu;
    for (const { sit, t } of all(GENERATED).filter((x) => x.mood === "yandere")) expect(t, sit).not.toMatch(bad);
  });

  it("новые фразы не длиннее 160 символов и без латиницы", () => {
    for (const f of PHRASE_FIXES) {
      expect(f.to.length, f.to).toBeLessThanOrEqual(160);
      expect(f.to.replace(/\{[a-z_]+\}/g, ""), f.to).not.toMatch(/[A-Za-z]/);
    }
  });
});
