// Ответ (Reply) на сообщение-напоминание обычным текстом и время отправки сообщения как точка отсчёта.
import { beforeEach, describe, expect, it } from "vitest";
import { parseReply } from "../src/reply.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

const AT = kyiv(2026, 11, 7, 17, 47) + 12_000; // 17:47:12
const ctx = { at: AT, tz: "Europe/Kyiv", defaultTime: 9 * 60 };
const min = (n: number) => NOW + n * MINUTE;

describe("parseReply: что значит текст ответа", () => {
  it("«напомни через 2 мин» и «через 7 мин» — от времени отправки", () => {
    expect(parseReply("напомни через 2 мин", ctx)).toEqual({ kind: "snooze", due: AT + 2 * MINUTE });
    expect(parseReply("через 7 мин", ctx)).toEqual({ kind: "snooze", due: AT + 7 * MINUTE });
  });

  it("«на час», «на 15 минут», «на полчаса», «отложи на 20 минут»", () => {
    expect(parseReply("на час", ctx)).toEqual({ kind: "snooze", due: AT + 60 * MINUTE });
    expect(parseReply("на 15 минут", ctx)).toEqual({ kind: "snooze", due: AT + 15 * MINUTE });
    expect(parseReply("на полчаса", ctx)).toEqual({ kind: "snooze", due: AT + 30 * MINUTE });
    expect(parseReply("Отложи на 20 минут!", ctx)).toEqual({ kind: "snooze", due: AT + 20 * MINUTE });
  });

  it("«на 18:30» — это время суток, а не длительность", () => {
    expect(parseReply("на 18:30", ctx)).toEqual({ kind: "snooze", due: kyiv(2026, 11, 7, 18, 30) });
  });

  it("дата и время: «завтра в 10», «завтра 10:30»", () => {
    expect(parseReply("завтра в 10", ctx)).toEqual({ kind: "snooze", due: kyiv(2026, 11, 8, 10, 0) });
    expect(parseReply("завтра 10:30", ctx)).toEqual({ kind: "snooze", due: kyiv(2026, 11, 8, 10, 30) });
  });

  it("«готово» в разных написаниях", () => {
    for (const t of ["готово", "Готово!", "сделано", "Сделал.", "напомни готово", "done"]) {
      expect(parseReply(t, ctx), t).toEqual({ kind: "done" });
    }
  });

  it("прошедшее время и непонятный текст", () => {
    expect(parseReply("сегодня в 8:00", ctx)).toEqual({ kind: "past" });
    expect(parseReply("ну ладно, спасибо", ctx)).toEqual({ kind: "unknown" });
    expect(parseReply("", ctx)).toEqual({ kind: "unknown" });
  });
});

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

/** Дело, сработавшее один раз; возвращает id дела и id живого сообщения-напоминания. */
async function firedReminder(): Promise<{ occId: number; msgId: string }> {
  const { occId } = await w.create("через 5 минут позвонить маме");
  await w.run(NOW); // первый запуск запоминает концы каналов
  await w.run(min(5));
  const live = w.discord.live(CH_REMIND);
  expect(live).toHaveLength(1);
  return { occId, msgId: live[0].id };
}

describe("cron: ответ на напоминание", () => {
  it("«через 2 мин» в ответе: дело отложено от времени ответа, сообщение стало «Отложено», бот ответил коротко", async () => {
    const { occId, msgId } = await firedReminder();
    w.discord.say(CH_REMIND, OWNER, "напомни через 2 мин", { ref: msgId, at: min(6) });
    const r = await w.run(min(7)); // бот прочитал через минуту после отправки
    expect(r.intake).toBe(1);
    const o = w.occ(occId);
    expect([o.state, o.next_fire_at, o.snooze_count]).toEqual(["snoozed", min(6) + 2 * MINUTE, 1]); // от 12:06, а не от 12:07
    const edit = w.discord.edits.at(-1)!;
    expect(edit.id).toBe(msgId);
    expect(edit.body.content).toContain("Отложено: **Позвонить маме**");
    const reply = w.discord.live(CH_REMIND).at(-1)!;
    expect(reply.body.content).toBe("Отложено: **Позвонить маме**. Напомню: через 1 мин, 12:08.");
    expect(reply.body.message_reference).toEqual({ message_id: expect.any(String), fail_if_not_exists: false });
    expect(reply.body.allowed_mentions).toEqual({ parse: [], replied_user: false });
    // снова сработает в новое время, а не по старой лестнице
    await w.run(min(8));
    expect(w.discord.posted.filter((p) => p.body.content?.includes(`<@${OWNER}>`))).toHaveLength(2);
  });

  it("ответ на уже удалённую копию тоже находит дело", async () => {
    const { occId, msgId: first } = await firedReminder();
    await w.run(min(15)); // лестница: вторая копия, первая удалена
    expect(w.discord.posted.find((p) => p.id === first)!.deleted).toBe(true);
    w.discord.say(CH_REMIND, OWNER, "на час", { ref: first, at: min(16) });
    await w.run(min(17));
    const o = w.occ(occId);
    expect([o.state, o.next_fire_at]).toEqual(["snoozed", min(16) + 60 * MINUTE]);
  });

  it("«готово»: дело закрыто, живое сообщение без кнопок, повторов нет", async () => {
    const { occId, msgId } = await firedReminder();
    w.discord.say(CH_REMIND, OWNER, "готово", { ref: msgId, at: min(6) });
    await w.run(min(7));
    const o = w.occ(occId);
    expect([o.state, o.closed_reason, o.next_fire_at]).toEqual(["done", null, null].map((v, i) => (i === 1 ? "done" : v)));
    expect(w.discord.edits.at(-1)!.body.content).toContain("Готово: Позвонить маме");
    expect(w.discord.edits.at(-1)!.body.components).toEqual([]);
    const before = w.discord.posted.length;
    await w.run(min(15));
    await w.run(min(60));
    expect(w.discord.posted.length).toBe(before);
  });

  it("непонятный ответ: дело не меняется, бот подсказывает формат", async () => {
    const { occId, msgId } = await firedReminder();
    const before = w.occ(occId);
    w.discord.say(CH_REMIND, OWNER, "ну ладно", { ref: msgId, at: min(6) });
    await w.run(min(7));
    expect(w.occ(occId)).toEqual(before);
    expect(w.discord.live(CH_REMIND).at(-1)!.body.content).toContain("Не понял");
  });

  it("ответ на закрытое дело: «уже закрыто», ничего не меняется", async () => {
    const { occId, msgId } = await firedReminder();
    w.discord.say(CH_REMIND, OWNER, "готово", { ref: msgId, at: min(6) });
    await w.run(min(7));
    w.discord.say(CH_REMIND, OWNER, "через 5 минут", { ref: msgId, at: min(8) });
    await w.run(min(9));
    expect(w.occ(occId).state).toBe("done");
    expect(w.discord.live(CH_REMIND).at(-1)!.body.content).toBe("Это дело уже закрыто.");
  });

  it("не ответы игнорируются: обычный текст, чужие, ответ на постороннее сообщение, пустое", async () => {
    const { occId, msgId } = await firedReminder();
    const before = w.occ(occId);
    const posted = w.discord.posted.length;
    w.discord.say(CH_REMIND, OWNER, "завтра в 10 купить хлеб", { at: min(6) }); // не Reply: дело не создаётся
    w.discord.say(CH_REMIND, "555", "готово", { ref: msgId, at: min(6) }); // чужой
    w.discord.say(CH_REMIND, OWNER, "готово", { ref: "424242", at: min(6) }); // Reply на не наше сообщение
    w.discord.say(CH_REMIND, OWNER, "", { ref: msgId, at: min(6) }); // без текста
    await w.run(min(7));
    expect(w.occ(occId)).toEqual(before);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(1);
    expect(w.discord.posted.length).toBe(posted);
  });

  it("первый запуск не разбирает старые ответы в канале напоминаний", async () => {
    const { occId } = await w.create("через 5 минут позвонить маме");
    w.discord.say(CH_REMIND, OWNER, "готово", { ref: "1001", at: NOW - MINUTE });
    await w.run(NOW);
    expect(w.occ(occId).state).toBe("planned");
  });
});

describe("cron: время сообщения в канале «бот» — от отправки, не от прочтения", () => {
  it("«через 5 минут» отсчитывается от времени отправки сообщения", async () => {
    await w.run(NOW);
    const sentAt = NOW + 10_000;
    w.discord.say(CH_BOT, OWNER, "через 5 минут проверка", { at: sentAt });
    await w.run(NOW + 100_000); // бот прочитал спустя 90 секунд
    const o = w.d1.q<{ due_at: number }>("SELECT due_at FROM occurrences")[0];
    expect(o.due_at).toBe(sentAt + 5 * MINUTE);
  });

  it("запоздалое «через 1 минуту», срок которого уже прошёл к моменту чтения: сработает на следующей минуте, а не спросит «когда»", async () => {
    await w.run(NOW);
    const sentAt = NOW + 5_000;
    w.discord.say(CH_BOT, OWNER, "через 1 минуту проверка", { at: sentAt });
    await w.run(NOW + 100_000);
    const o = w.d1.q<{ state: string; due_at: number }>("SELECT state, due_at FROM occurrences")[0];
    expect([o.state, o.due_at]).toEqual(["planned", sentAt + MINUTE]);
    await w.run(NOW + 160_000);
    expect(w.discord.live(CH_REMIND)).toHaveLength(1);
  });
});

describe("Reply на «Записано …» в канале приёма (отзыв пользователя 2026-11-08)", () => {
  async function recorded(text = "завтра в 10 записать ребёнка к неврологу") {
    await w.run(NOW); // запомнить конец канала
    w.discord.say(CH_BOT, OWNER, text, { at: NOW + MINUTE });
    await w.run(NOW + 2 * MINUTE);
    const confirm = w.discord.live(CH_BOT).at(-1)!;
    expect(confirm.body.content).toContain("Записано");
    const item = (await w.repo().openMain(10))[0];
    return { confirm, occId: item.id };
  }

  it("parseReply: «отмени» и близкие слова", () => {
    for (const t of ["отмени", "Отмена!", "удали", "не надо", "отменить это"]) expect(parseReply(t, ctx), t).toEqual({ kind: "cancel" });
  });

  it("«отмени» в ответ на «Записано»: дело отменено, не создаётся новое «Отмени»", async () => {
    const { confirm, occId } = await recorded();
    w.discord.say(CH_BOT, OWNER, "отмени", { ref: confirm.id, at: NOW + 3 * MINUTE });
    await w.run(NOW + 4 * MINUTE);
    expect(w.occ(occId).state).toBe("cancelled");
    expect(await w.repo().openMain(10)).toHaveLength(0);
    expect(w.discord.edits.at(-1)!.id).toBe(confirm.id);
    expect(w.discord.edits.at(-1)!.body.content).toContain("Отменено");
    expect(w.discord.live(CH_BOT).at(-1)!.body.content).toContain("Отменено");
  });

  it("«на час» и «готово» в ответ на «Записано» тоже работают", async () => {
    const a = await recorded();
    w.discord.say(CH_BOT, OWNER, "на час", { ref: a.confirm.id, at: NOW + 3 * MINUTE });
    await w.run(NOW + 4 * MINUTE);
    expect(w.occ(a.occId).state).toBe("snoozed");
    w.discord.say(CH_BOT, OWNER, "готово", { ref: a.confirm.id, at: NOW + 5 * MINUTE });
    await w.run(NOW + 6 * MINUTE);
    expect(w.occ(a.occId).state).toBe("done");
  });

  it("ответ на постороннее сообщение бота и обычный текст со ссылкой — запись нового дела как раньше", async () => {
    await w.run(NOW);
    w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб", { ref: "123456", at: NOW + MINUTE });
    await w.run(NOW + 2 * MINUTE);
    expect((await w.repo().openMain(10)).map((o) => o.title)).toEqual(["Купить хлеб"]);
  });
});
