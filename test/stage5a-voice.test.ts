// Один слой ответа (отзыв владельца 2026-11-10): ответ строится вокруг фразы Хару, смысл не теряется.
// Фраза первой обычным текстом, суть (название, время, итог) — хвостом в той же строке; нет фразы — прежняя обычная строка.
import { describe, expect, it } from "vitest";
import { PHRASES } from "../src/personality/phrases.ts";
import { MOODS } from "../src/personality/moodEngine.ts";
import { REPLY_UNKNOWN, applyReply } from "../src/reply.ts";
import { confirmMessage, doneMessage, draftMessage, factTail, headVoice, reminderMessage, snoozeQuestionMessage, snoozedMessage, voice, voiceText } from "../src/discord/ui.ts";
import type { OccView } from "../src/db/types.ts";
import { spriteCard } from "../src/personality/look.ts";
import { NOW } from "./helpers.ts";

const TITLE = "Купить хлеб";
const WHEN = "завтра, 10:00";

describe("voice / voiceText", () => {
  it("есть фраза — она первой, суть хвостом, одной строкой; нет фразы — прежняя строка", () => {
    expect(voice("Отменено: Хлеб", "Убрала. Вздох.", factTail("Хлеб", "отменено"))).toBe("Убрала. Вздох. **Хлеб** — отменено");
    expect(voice("Отменено: Хлеб", null, factTail("Хлеб", "отменено"))).toBe("Отменено: Хлеб");
    expect(voice("Отменено: Хлеб", "", factTail("Хлеб", "отменено"))).toBe("Отменено: Хлеб");
  });

  it("мелкая метка «-# » снимается, фраза с манга-звуком идёт в одну строку, монолог из трёх строк остаётся строками", () => {
    expect(voiceText("-# шёпот")).toBe("шёпот");
    expect(voiceText("Фраза.\nふむ")).not.toContain("\n");
    expect(voiceText("Раз.\nДва.\nТри.")).toBe("Раз.\nДва.\nТри.");
  });

  it("headVoice: фраза шапкой над длинным текстом", () => {
    expect(headVoice("Ну вот.", "**Висит**\n• дело")).toBe("Ну вот.\n**Висит**\n• дело");
    expect(headVoice(null, "текст")).toBe("текст");
  });
});

describe("смысл не теряется при любой фразе из пулов (6 настроений)", () => {
  const sits = (sit: string) => MOODS.flatMap((m) => (PHRASES[m][sit as keyof (typeof PHRASES)[string]] ?? []).map((p) => [m, p] as const));

  it("записано: название, срок, номер и слово «записано» в первой строке; второй мелкой строки нет", () => {
    for (const [mood, line] of sits("recorded")) {
      const m = confirmMessage({ occId: 1, itemId: 7, title: TITLE, whenText: WHEN, line });
      const first = String(m.content).split("\n")[0];
      expect(first, `${mood}: ${line}`).toContain(`**${TITLE}** — записано: ${WHEN} · #7`);
      expect(first).toContain(voiceText(line));
      expect(String(m.content)).not.toMatch(/\n-# /);
    }
  });

  it("готово: название и «готово»", () => {
    for (const [mood, line] of sits("done")) {
      const m = doneMessage(TITLE, "neutral", 0, line);
      expect(String(m.content), `${mood}: ${line}`).toContain(`**${TITLE}** — готово`);
      expect(String(m.content)).not.toContain("-# ");
    }
  });

  it("отложено: название и до какого времени", () => {
    for (const [mood, line] of sits("snoozed")) {
      const m = snoozedMessage({ occId: 1, title: TITLE, whenText: "18:00", itemId: 7, line });
      expect(String(m.content), `${mood}: ${line}`).toContain(`**${TITLE}** — отложено до 18:00 · #7`);
    }
  });

  it("отменено / удалено: название и итог", () => {
    for (const [sit, status] of [["cancelled", "отменено"], ["deleted", "удалено"]] as const)
      for (const [mood, line] of sits(sit)) {
        const text = voice(`Plain: ${TITLE}`, line, factTail(TITLE, status));
        expect(text, `${mood}: ${line}`).toContain(`**${TITLE}** — ${status}`);
        expect(text).toContain(voiceText(line));
      }
  });

  it("черновик: вопрос «когда напомнить?», название и номер для ответа-Reply (последний «#N»)", () => {
    for (const [mood, line] of sits("draft")) {
      const m = draftMessage({ occId: 1, itemId: 9, title: TITLE, line });
      expect(String(m.content), `${mood}: ${line}`).toContain(`**${TITLE}** — когда напомнить? · #9`);
      expect([...String(m.content).matchAll(/#(\d+)/g)].at(-1)![1]).toBe("9");
    }
  });

  it("пятое откладывание: вопрос «Что делаем?» с названием и числом", () => {
    for (const [mood, line] of sits("snooze_5")) {
      const m = snoozeQuestionMessage({ occId: 1, itemId: 9, title: TITLE, count: 5, line });
      expect(String(m.content), `${mood}: ${line}`).toContain(`Откладываешь «${TITLE}» в 5-й раз. Что делаем?`);
    }
  });

  it("не поняла в ответе: подсказка с примерами остаётся", () => {
    const occ = { id: 1, item_id: 9, title: TITLE, state: "fired", snooze_count: 0 } as unknown as OccView;
    for (const [mood, line] of sits("reply_unknown")) {
      const r = applyReply(occ, { kind: "unknown" }, { tz: "Europe/Kyiv" } as never, NOW, line);
      expect(r.text, `${mood}: ${line}`).toContain("«через 15 минут»");
      expect(r.text).toContain("«отмени»");
    }
    // без фразы — прежний текст целиком
    expect(applyReply(occ, { kind: "unknown" }, { tz: "Europe/Kyiv" } as never, NOW, null).text).toBe(REPLY_UNKNOWN);
  });

  it("отмена Reply-ом: название и «отменено»", () => {
    const occ = { id: 1, item_id: 9, title: TITLE, state: "fired", snooze_count: 0 } as unknown as OccView;
    for (const [mood, line] of sits("cancelled")) {
      const r = applyReply(occ, { kind: "cancel" }, { tz: "Europe/Kyiv" } as never, NOW, line);
      expect(r.text, `${mood}: ${line}`).toContain(`**${TITLE}** — отменено`);
      expect(String(r.edit?.content)).toContain(`**${TITLE}** — отменено`);
    }
  });
});

describe("напоминание: фраза между упоминанием и названием", () => {
  const occ = { id: 3, item_id: 9, title: TITLE, kind: "main", item_kind: "task", state: "fired", due_at: NOW, snooze_count: 0, critical: 0 } as unknown as OccView;
  const plan = { phase: "first", ordinal: 1, total: 1, lateMinutes: 0 } as never;

  it("с фразой: «@ Фраза **Название**» + срок отдельной строкой, мелкой строки нет, упоминание на месте", () => {
    const m = reminderMessage({ occ, plan, ownerId: "42", tz: "Europe/Kyiv", now: NOW, flavor: "Пора, хозяин." });
    const lines = String(m.content).split("\n");
    expect(lines[0]).toBe(`<@42> Пора, хозяин. **${TITLE}**`);
    expect(lines[1]).toContain("Срок:");
    expect(m.allowed_mentions).toEqual({ users: ["42"] });
    expect(m.embeds).toBeUndefined();
  });

  it("без фразы — как раньше; со спрайтом — карточка только с картинкой, без текста", () => {
    const m = reminderMessage({ occ, plan, ownerId: "42", tz: "Europe/Kyiv", now: NOW, flavor: null });
    expect(String(m.content).split("\n")[0]).toBe(`<@42> **${TITLE}**`);
    const card = spriteCard({ mood: "tired", origin: "https://x.example", sprite: true });
    expect(card).toHaveLength(1);
    expect(card![0].description).toBeUndefined();
    expect(card![0].thumbnail?.url).toBe("https://x.example/sprites/tired.jpg");
    expect(spriteCard({ mood: "tired", origin: "https://x.example", sprite: false })).toBeUndefined();
    expect(spriteCard({ mood: "tired", origin: null, sprite: true })).toBeUndefined();
  });
});
