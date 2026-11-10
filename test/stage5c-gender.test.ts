// Хару — девушка: в её репликах и ответах бота нет мужского рода о себе (отзыв Ihor 2026-11-10: «понял» и другие глаголы в мужском роде).
import { describe, expect, it } from "vitest";
import { hasMasculineSelf } from "../src/personality/gender.ts";
import { PHRASES } from "../src/personality/phrases.ts";
import { cleanLine } from "../src/personality/liveLines.ts";
import { REPLY_UNKNOWN, REPLY_UNKNOWN_HINT } from "../src/reply.ts";
import { NOT_RECURRING_REPLY } from "../src/intake.ts";

describe("hasMasculineSelf", () => {
  it.each(["Не понял вас.", "Я так устал.", "Я не успел, простите.", "Я рад, что вы вернулись", "Записал. Не забуду.", "Ничего не понял, но старался.", "Я был занят"])("«%s» — мужской род", (t) => {
    expect(hasMasculineSelf(t)).toBe(true);
  });
  it.each(["Не поняла вас.", "Я так устала.", "Я не успела, простите.", "Я рада, что вы вернулись", "Записала. Не забуду.", "Вы не заметили, а я заметила.", "Я делаю чай.", "Я знаю.", "Хозяйка вернулась", "Я хочу чаю"])("«%s» — всё в порядке", (t) => {
    expect(hasMasculineSelf(t)).toBe(false);
  });
});

describe("в готовых фразах и ответах бота мужского рода нет", () => {
  it("все пулы фраз Хару", () => {
    const bad: string[] = [];
    // исключения — не ошибки рода: похвала хозяину-мужчине («Закрыл давний хвост!», «ты сделал») и мужское существительное («мой мозг … не понял»)
    const OK = ["Закрыл давний хвост", "ты всё-таки сделал", "мой мозг уже спит и не понял"];
    for (const [mood, sits] of Object.entries(PHRASES)) for (const [sit, list] of Object.entries(sits)) for (const p of list ?? []) if (hasMasculineSelf(p) && !OK.some((x) => p.includes(x))) bad.push(`${mood}.${sit}: ${p}`);
    expect(bad).toEqual([]);
  });

  it("постоянные ответы бота: «Не поняла», «Не нашла»", () => {
    for (const t of [REPLY_UNKNOWN, REPLY_UNKNOWN_HINT, NOT_RECURRING_REPLY]) expect(hasMasculineSelf(t)).toBe(false);
    expect(REPLY_UNKNOWN).toMatch(/^Не поняла/);
  });

  it("реплика модели с мужским родом отбраковывается (возьмётся готовая фраза), с женским — проходит", () => {
    expect(cleanLine("Ничего не понял, но старался.", { length: "short" })).toBeNull();
    expect(cleanLine("Ничего не поняла, но старалась.", { length: "short" })).not.toBeNull();
  });
});
