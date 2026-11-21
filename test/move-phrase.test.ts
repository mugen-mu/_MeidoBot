// Перенос напоминания фразой («перенеси на завтра», «отложи на вечер»; решение H7 анкеты, волна 5): разбор фраз, выбор дела, сдвиг времени.
import { beforeEach, describe, expect, it } from "vitest";
import { cancelItemOps } from "../src/service.ts";
import { MOVE_ASK, MOVE_NO_TARGET, MOVE_PAST, looksLikeMove, parseMovePhrase, parseReply } from "../src/reply.ts";
import { applyReply } from "../src/reply.ts";
import { formatMoveTarget } from "../src/time/format.ts";
import { setSetting } from "../src/db/repo.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

// NOW — суббота 7 ноября 2026, 12:00 по Киеву
const ctx = { at: NOW, tz: TZ, defaultTime: 9 * 60, morningTime: 9 * 60, eveningTime: 19 * 60 };
const min = (n: number) => NOW + n * MINUTE;
const move = (text: string) => parseMovePhrase(text, ctx);
const moveDue = (text: string) => {
  const r = move(text);
  return r?.kind === "move" ? r.due : r;
};

describe("parseMovePhrase: что считаем просьбой перенести", () => {
  it("«перенеси напоминание на завтра», «перенеси на пятницу в 18:00», «перенеси на час», «отложи на вечер»", () => {
    expect(moveDue("перенеси напоминание на завтра")).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(moveDue("Перенеси на пятницу в 18:00")).toBe(kyiv(2026, 11, 13, 18, 0));
    expect(moveDue("перенеси на час")).toBe(NOW + HOUR);
    expect(moveDue("отложи на вечер")).toBe(kyiv(2026, 11, 7, 19, 0));
  });

  it("близкие формулировки: «это», «его», «дело», «до …», «пожалуйста», обращение", () => {
    expect(moveDue("перенеси это напоминание на завтра, пожалуйста")).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(moveDue("перенеси его на 2 часа")).toBe(NOW + 2 * HOUR);
    expect(moveDue("перенеси дело на послезавтра")).toBe(kyiv(2026, 11, 9, 9, 0));
    expect(moveDue("Хару, отложи на полчаса")).toBe(NOW + 30 * MINUTE);
    expect(moveDue("бот отложи на 15 минут!")).toBe(NOW + 15 * MINUTE);
    expect(moveDue("отложи до завтра")).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(moveDue("отложи до вечера")).toBe(kyiv(2026, 11, 7, 19, 0));
    expect(moveDue("отложи до пятницы")).toBe(kyiv(2026, 11, 13, 9, 0));
    expect(moveDue("сдвинь на сутки")).toBe(kyiv(2026, 11, 8, 12, 0));
    expect(moveDue("перенеси мне напоминание на завтра")).toBe(kyiv(2026, 11, 8, 9, 0));
  });

  it("время суток: «на 18:00», «на 9 утра», «на утро» (уже прошедшее — это следующие сутки)", () => {
    expect(moveDue("перенеси на 18:00")).toBe(kyiv(2026, 11, 7, 18, 0));
    expect(moveDue("перенеси на 9 утра")).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(moveDue("перенеси на 6 вечера")).toBe(kyiv(2026, 11, 7, 18, 0));
    expect(moveDue("отложи на утро")).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(moveDue("перенеси на сегодня вечером")).toBe(kyiv(2026, 11, 7, 19, 0));
    expect(moveDue("перенеси на завтра утром")).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(moveDue("перенеси в пятницу в 10")).toBe(kyiv(2026, 11, 13, 10, 0));
    expect(moveDue("перенеси на 25 ноября")).toBe(kyiv(2026, 11, 25, 9, 0));
    expect(moveDue("перенеси на следующую неделю")).toBe(kyiv(2026, 11, 9, 9, 0));
  });

  it("слова «утром» и «вечером» берутся из настроек хозяина", () => {
    const c = { ...ctx, morningTime: 8 * 60, eveningTime: 21 * 60 };
    expect(parseMovePhrase("отложи на вечер", c)).toEqual({ kind: "move", due: kyiv(2026, 11, 7, 21, 0) });
    expect(parseMovePhrase("отложи на утро", c)).toEqual({ kind: "move", due: kyiv(2026, 11, 8, 8, 0) });
  });

  it("время от отправки сообщения, а не от разбора", () => {
    const at = NOW - 30 * MINUTE;
    expect(parseMovePhrase("перенеси на час", { ...ctx, at })).toEqual({ kind: "move", due: at + HOUR });
  });

  it("время в прошлом — «past», а не перенос", () => {
    expect(move("перенеси на сегодня")).toEqual({ kind: "past" }); // сегодня в 09:00 уже было
    expect(move("перенеси на вчера")).toEqual({ kind: "past" });
  });

  it("просят перенести, а «на когда» не понято — «ask» (спросим одной строкой, ничего не меняя)", () => {
    for (const t of ["перенеси", "Перенеси напоминание", "отложи", "перенеси на потом", "отложи на позже", "перенеси это на когда-нибудь", "перенеси его куда-нибудь"]) {
      expect(move(t), t).toEqual({ kind: "ask" });
    }
  });

  it("ложные срабатывания: любое лишнее слово — это обычное дело, напоминаний не трогаем", () => {
    const notMoves = [
      "перенеси файл на диск D",
      "перенеси на диск D",
      "перенеси на 2 монитор",
      "отложи деньги на отпуск",
      "отложи на отпуск",
      "отложи на день рождения",
      "отложи 500 грн на отпуск",
      "перенеси встречу на пятницу",
      "перенеси на завтра встречу с врачом",
      "перенеси фото на флешку завтра",
      "перенеси #12 на завтра",
      "перенеси на каждый день",
      "перенести файл на диск D",
      "переношу на завтра",
      "неси на завтра",
      "отложил на завтра",
      "я отложу на завтра",
      "завтра перенести на диск D",
      "что перенесли на завтра",
      "перенеси на завтра пароль: Abc12345",
    ];
    for (const t of notMoves) expect(move(t), t).toBeNull();
  });

  it("looksLikeMove: дешёвая проверка начала фразы", () => {
    expect(looksLikeMove("Перенеси на завтра")).toBe(true);
    expect(looksLikeMove("перенеси файл на диск D")).toBe(true); // начало похоже, полный разбор потом скажет «нет»
    expect(looksLikeMove("перенести файл")).toBe(false);
    expect(looksLikeMove("завтра в 10 купить хлеб")).toBe(false);
    expect(looksLikeMove("готово")).toBe(false);
  });

  it("ответ без слов «перенеси / отложи» разбирается по-старому (parseReply не изменился)", () => {
    expect(parseReply("на час", { at: NOW, tz: TZ, defaultTime: 540 })).toEqual({ kind: "snooze", due: NOW + HOUR });
    expect(parseReply("на неделю", { at: NOW, tz: TZ, defaultTime: 540 })).toEqual({ kind: "snooze", due: kyiv(2026, 11, 14, 12, 0) });
    expect(parseReply("завтра 10:30", { at: NOW, tz: TZ, defaultTime: 540 })).toEqual({ kind: "snooze", due: kyiv(2026, 11, 8, 10, 30) });
  });
});

describe("formatMoveTarget: куда перенесли", () => {
  it("с предлогом и в винительном падеже", () => {
    expect(formatMoveTarget(kyiv(2026, 11, 8, 9, 0), NOW, TZ)).toBe("на завтра, 09:00");
    expect(formatMoveTarget(kyiv(2026, 11, 7, 19, 0), NOW, TZ)).toBe("на сегодня, 19:00");
    expect(formatMoveTarget(kyiv(2026, 11, 13, 18, 0), NOW, TZ)).toBe("на пятницу, 18:00");
    expect(formatMoveTarget(kyiv(2026, 11, 11, 18, 0), NOW, TZ)).toBe("на среду, 18:00");
    expect(formatMoveTarget(kyiv(2026, 11, 25, 9, 0), NOW, TZ)).toBe("на 11.25.2026, 09:00");
    expect(formatMoveTarget(NOW + 20 * MINUTE, NOW, TZ)).toBe("на 12:20 (через 20 мин)");
  });
});

// ---------- cron: вся цепочка ----------

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
});

const A = "через 5 минут позвонить маме";
const B = "через 6 минут выпить воду";
const MOVED_A = "Перенесла «Позвонить маме» на завтра, 09:00.";

/** Создать дела, дать им сработать: A в 12:05, B в 12:06 (если есть). Возвращает id срабатываний и живые сообщения. */
async function fired(texts: string[] = [A]): Promise<{ occ: number[]; item: number[]; msg: string[] }> {
  const occ: number[] = [];
  const item: number[] = [];
  for (const t of texts) {
    const r = await w.create(t);
    occ.push(r.occId);
    item.push(r.itemId);
  }
  await w.run(NOW); // первый запуск запоминает концы каналов
  for (let i = 0; i < texts.length; i++) await w.run(min(5 + i));
  const msg = occ.map((id) => String(w.d1.q<{ last_message_id: string }>("SELECT last_message_id FROM occurrences WHERE id = ?", id)[0].last_message_id));
  return { occ, item, msg };
}

const lastBot = (ch = CH_REMIND) => w.discord.live(ch).at(-1)!;
const snapshot = (id: number) => JSON.stringify(w.occ(id));

describe("cron: перенос без ответа — последнее напоминание", () => {
  it("«перенеси напоминание на завтра»: время сдвинулось, дело открыто, ответ коротко, живое сообщение без старых кнопок", async () => {
    const { occ, item, msg } = await fired();
    w.discord.say(CH_BOT, OWNER, "перенеси напоминание на завтра", { at: min(6) });
    const r = await w.run(min(7));
    expect(r.intake).toBe(1);
    const o = w.occ(occ[0]);
    expect([o.state, o.due_at, o.base_at, o.next_fire_at, o.fire_count, o.snooze_count]).toEqual(["snoozed", min(5), kyiv(2026, 11, 8, 9, 0), kyiv(2026, 11, 8, 9, 0), 0, 1]);
    expect(w.d1.q("SELECT archived_at FROM items WHERE id = ?", item[0])[0]).toEqual({ archived_at: null }); // дело не закрыто и не стёрто
    expect(o.closed_at ?? null).toBeNull();
    const edit = w.discord.edits.at(-1)!;
    expect(edit.id).toBe(msg[0]);
    expect(edit.channel).toBe(CH_REMIND);
    expect(edit.body.content).toContain("Отложено: **Позвонить маме** — до завтра, 09:00");
    const reply = lastBot(CH_BOT);
    expect(reply.body.content).toBe(MOVED_A);
    expect(reply.body.message_reference).toEqual({ message_id: expect.any(String), fail_if_not_exists: false });
    expect(reply.body.allowed_mentions).toEqual({ parse: [], replied_user: false });
    // лестница начинается заново от нового времени
    const sent = w.discord.posted.filter((p) => p.body.content?.includes(`<@${OWNER}>`)).length;
    await w.run(min(60));
    expect(w.discord.posted.filter((p) => p.body.content?.includes(`<@${OWNER}>`)).length).toBe(sent); // до завтра тихо
    await w.run(kyiv(2026, 11, 8, 9, 1));
    expect(w.discord.posted.filter((p) => p.body.content?.includes(`<@${OWNER}>`)).length).toBe(sent + 1);
    expect(w.occ(occ[0]).state).toBe("fired");
  });

  it("то же в канале напоминаний (а не только в приёме)", async () => {
    const { occ } = await fired();
    w.discord.say(CH_REMIND, OWNER, "отложи на вечер", { at: min(6) });
    const r = await w.run(min(7));
    expect(r.intake).toBe(1);
    expect(w.occ(occ[0]).next_fire_at).toBe(kyiv(2026, 11, 7, 19, 0));
    expect(lastBot(CH_REMIND).body.content).toBe("Перенесла «Позвонить маме» на сегодня, 19:00.");
  });

  it("с включённым настроением Хару: суть ответа на месте (фраза Хару, если она есть, идёт первой)", async () => {
    const w2 = new World();
    await w2.seed({ intake: true, settings: { mood_on: "1", summary_morning: "off", summary_evening: "off", weekly: "off" } });
    const { occId } = await w2.create(A);
    await w2.run(NOW);
    await w2.run(min(5));
    w2.discord.say(CH_BOT, OWNER, "перенеси на завтра", { at: min(6) });
    await w2.run(min(7));
    expect(w2.occ(occId).next_fire_at).toBe(kyiv(2026, 11, 8, 9, 0));
    const text = w2.discord.live(CH_BOT).at(-1)!.body.content!;
    expect(text === MOVED_A || text.endsWith("**Позвонить маме** — перенесено на завтра, 09:00.")).toBe(true);
  });

  it("если напоминания и приём — один канал (как в «Личке»), тоже работает", async () => {
    const w2 = new World();
    await w2.seed({ intake: true, settings: { ch_remind: CH_BOT, summary_morning: "off", summary_evening: "off", weekly: "off" } });
    const { occId } = await w2.create(A);
    await w2.run(NOW);
    await w2.run(min(5));
    w2.discord.say(CH_BOT, OWNER, "перенеси на час", { at: min(6) });
    await w2.run(min(7));
    expect(w2.occ(occId).next_fire_at).toBe(min(6) + HOUR); // от времени сообщения
    expect(w2.discord.live(CH_BOT).at(-1)!.body.content).toBe("Перенесла «Позвонить маме» на 13:06 (через 59 мин).");
  });

  it("из нескольких напоминаний переносится только последнее отправленное", async () => {
    const { occ } = await fired([A, B]);
    const beforeA = snapshot(occ[0]);
    w.discord.say(CH_BOT, OWNER, "перенеси на завтра", { at: min(7) });
    await w.run(min(8));
    expect(snapshot(occ[0])).toBe(beforeA);
    expect(w.occ(occ[1]).state).toBe("snoozed");
    expect(lastBot(CH_BOT).body.content).toBe("Перенесла «Выпить воду» на завтра, 09:00.");
  });

  it("ответ (Reply) на старое напоминание переносит именно его, а не последнее", async () => {
    const { occ, msg } = await fired([A, B]);
    const beforeB = snapshot(occ[1]);
    w.discord.say(CH_REMIND, OWNER, "перенеси на пятницу в 18:00", { ref: msg[0], at: min(7) });
    await w.run(min(8));
    expect(snapshot(occ[1])).toBe(beforeB);
    const o = w.occ(occ[0]);
    expect([o.state, o.next_fire_at]).toEqual(["snoozed", kyiv(2026, 11, 13, 18, 0)]);
    expect(lastBot(CH_REMIND).body.content).toBe("Перенесла «Позвонить маме» на пятницу, 18:00.");
  });

  it("повторяющееся дело: переносится только эта запись, серия живёт дальше", async () => {
    const r = await w.create("каждый день в 12:05 полить цветы");
    await w.run(NOW);
    await w.run(min(5));
    const mains = () => w.d1.q<{ id: number; state: string; due_at: number; next_fire_at: number | null }>("SELECT id, state, due_at, next_fire_at FROM occurrences WHERE item_id = ? AND kind = 'main' ORDER BY due_at", r.itemId);
    expect(mains()).toHaveLength(2); // сегодняшняя сработала, завтрашняя уже создана
    const tomorrow = mains()[1];
    w.discord.say(CH_BOT, OWNER, "перенеси на 18:00", { at: min(6) });
    await w.run(min(7));
    const [today, next] = mains();
    expect([today.state, today.next_fire_at]).toEqual(["snoozed", kyiv(2026, 11, 7, 18, 0)]);
    expect(next).toEqual(tomorrow); // завтрашняя запись не тронута
    expect(w.d1.q("SELECT archived_at FROM items WHERE id = ?", r.itemId)[0]).toEqual({ archived_at: null });
    expect(w.d1.q("SELECT 1 FROM rules WHERE item_id = ?", r.itemId)).toHaveLength(1);
  });

  it("тихие часы учитываются: напоминание, перенесённое на ночь, придёт утром", async () => {
    await w.repo().exec([setSetting("quiet_enabled", "1"), setSetting("quiet_from", "23:00"), setSetting("quiet_to", "07:00")]);
    const { occ } = await fired();
    w.discord.say(CH_BOT, OWNER, "перенеси на 23:30", { at: min(6) });
    await w.run(min(7));
    expect(w.occ(occ[0]).next_fire_at).toBe(kyiv(2026, 11, 7, 23, 30));
    const reminders = () => w.discord.posted.filter((p) => p.body.content?.includes(`<@${OWNER}>`)).length;
    const before = reminders();
    await w.run(kyiv(2026, 11, 7, 23, 31));
    expect(reminders()).toBe(before); // тихие часы: молчим
    expect(w.occ(occ[0]).next_fire_at).toBe(kyiv(2026, 11, 8, 7, 0));
    await w.run(kyiv(2026, 11, 8, 7, 1));
    expect(reminders()).toBe(before + 1);
  });

  it("«я в отъезде» учитывается: напоминание придёт, когда вы вернётесь", async () => {
    const { occ } = await fired(); // напоминание уже пришло, и только потом уехали
    const back = kyiv(2026, 11, 10, 9, 0);
    await w.repo().exec([setSetting("away_until", String(back))]);
    w.discord.say(CH_BOT, OWNER, "перенеси на завтра", { at: min(6) });
    await w.run(min(7));
    await w.run(kyiv(2026, 11, 8, 9, 1));
    expect(w.occ(occ[0]).next_fire_at).toBe(back);
    expect(w.occ(occ[0]).state).toBe("snoozed");
  });
});

describe("cron: нет подходящего напоминания — честный ответ, ничего не меняется", () => {
  const said = () => lastBot(CH_BOT).body.content;

  it("напоминаний ещё не было", async () => {
    const { occId } = await w.create("завтра в 10 купить хлеб"); // дело есть, но бот о нём ещё не напоминал
    await w.run(NOW);
    const before = snapshot(occId);
    w.discord.say(CH_BOT, OWNER, "перенеси на завтра", { at: min(1) });
    const r = await w.run(min(2));
    expect(r.intake).toBe(1);
    expect(said()).toBe(MOVE_NO_TARGET);
    expect(said()).toBe("Не вижу, какое перенести: ответьте на нужное напоминание.");
    expect(snapshot(occId)).toBe(before);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(1); // и нового дела из фразы не завели
  });

  it("последнее напоминание закрыто «Готово»: другое вместо него не берём", async () => {
    const { occ, msg } = await fired([A, B]);
    w.discord.say(CH_REMIND, OWNER, "готово", { ref: msg[1], at: min(7) });
    await w.run(min(8));
    expect(w.occ(occ[1]).state).toBe("done");
    const beforeA = snapshot(occ[0]);
    w.discord.say(CH_BOT, OWNER, "перенеси на завтра", { at: min(9) });
    await w.run(min(10));
    expect(said()).toBe(MOVE_NO_TARGET);
    expect(snapshot(occ[0])).toBe(beforeA); // А осталась как была: наугад не переносим
  });

  it("дело удалено", async () => {
    const { item, occ } = await fired();
    await w.repo().exec(cancelItemOps(item[0], min(6)));
    w.discord.say(CH_BOT, OWNER, "отложи на вечер", { at: min(7) });
    await w.run(min(8));
    expect(said()).toBe(MOVE_NO_TARGET);
    expect(w.occ(occ[0]).state).toBe("cancelled");
  });

  /** Дать лестнице дойти до конца (стандартная: последняя отправка через 6 часов), дальше бот молчит. */
  async function ladderToEnd(): Promise<number> {
    const { occ } = await fired();
    for (const m of [15, 25, 45, 125, 245, 365]) await w.run(min(m));
    expect(w.occ(occ[0]).next_fire_at).toBeNull();
    return occ[0];
  }

  it("с последнего напоминания прошло больше суток", async () => {
    const id = await ladderToEnd();
    const before = snapshot(id);
    w.discord.say(CH_BOT, OWNER, "перенеси на завтра", { at: min(365) + 25 * HOUR });
    await w.run(min(365) + 25 * HOUR + MINUTE);
    expect(said()).toBe(MOVE_NO_TARGET);
    expect(snapshot(id)).toBe(before);
  });

  it("меньше суток: ещё «висящее» напоминание переносится", async () => {
    const id = await ladderToEnd();
    w.discord.say(CH_BOT, OWNER, "перенеси на завтра", { at: min(365) + 20 * HOUR });
    await w.run(min(365) + 20 * HOUR + MINUTE);
    expect(w.occ(id).state).toBe("snoozed");
    expect(said()).toContain("Перенесла «Позвонить маме» на ");
  });

  it("ответ на постороннее сообщение: не угадываем, а просим ответить на нужное напоминание", async () => {
    const { occ } = await fired();
    const before = snapshot(occ[0]);
    w.discord.say(CH_REMIND, OWNER, "перенеси на завтра", { ref: "424242", at: min(6) });
    await w.run(min(7));
    expect(lastBot(CH_REMIND).body.content).toBe(MOVE_NO_TARGET);
    expect(snapshot(occ[0])).toBe(before);
  });

  it("ответ на закрытое напоминание: «уже закрыто», ничего не меняется", async () => {
    const { occ, msg } = await fired();
    w.discord.say(CH_REMIND, OWNER, "готово", { ref: msg[0], at: min(6) });
    await w.run(min(7));
    w.discord.say(CH_REMIND, OWNER, "перенеси на завтра", { ref: msg[0], at: min(8) });
    await w.run(min(9));
    expect(w.occ(occ[0]).state).toBe("done");
    expect(lastBot(CH_REMIND).body.content).toBe("Это дело уже закрыто.");
  });
});

describe("cron: непонятное время и ложные срабатывания", () => {
  it("«перенеси напоминание» без времени: одна короткая строка с вопросом, ничего не записано", async () => {
    const { occ } = await fired();
    const before = snapshot(occ[0]);
    const items = w.d1.q("SELECT 1 FROM items").length;
    w.discord.say(CH_BOT, OWNER, "перенеси напоминание", { at: min(6) });
    const r = await w.run(min(7));
    expect(r.intake).toBe(1);
    expect(lastBot(CH_BOT).body.content).toBe(MOVE_ASK);
    expect(MOVE_ASK.includes("\n")).toBe(false);
    expect(snapshot(occ[0])).toBe(before);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(items);
  });

  it("прошедшее время: «Это время уже прошло», дело не меняется", async () => {
    const { occ } = await fired();
    const before = snapshot(occ[0]);
    w.discord.say(CH_BOT, OWNER, "перенеси на вчера", { at: min(6) });
    await w.run(min(7));
    expect(lastBot(CH_BOT).body.content).toBe(MOVE_PAST);
    expect(snapshot(occ[0])).toBe(before);
  });

  it("«перенеси файл на диск D» — обычное дело: напоминание не тронуто, бот не отвечает про перенос", async () => {
    const { occ } = await fired();
    const before = snapshot(occ[0]);
    const posted = w.discord.posted.length;
    w.discord.say(CH_BOT, OWNER, "перенеси файл на диск D", { at: min(6) });
    w.discord.say(CH_BOT, OWNER, "отложи деньги на отпуск", { at: min(6) });
    await w.run(min(7));
    expect(snapshot(occ[0])).toBe(before);
    const titles = w.d1.q<{ title: string }>("SELECT title FROM items ORDER BY id").map((r) => r.title);
    expect(titles).toEqual(["Позвонить маме", "Перенеси файл на диск D", "Отложи деньги на отпуск"]);
    expect(w.discord.live(CH_BOT).some((p) => p.body.content === MOVE_NO_TARGET || p.body.content === MOVE_ASK)).toBe(false);
    expect(w.discord.posted.length).toBeGreaterThan(posted); // ответы «Записано» на новые дела
  });

  it("секрет в сообщении: перенос не срабатывает (пароль уходит в обычный разбор, где его не сохраняют)", async () => {
    const { occ } = await fired();
    const before = snapshot(occ[0]);
    w.discord.say(CH_BOT, OWNER, "перенеси на завтра пароль: Abc12345", { at: min(6) });
    await w.run(min(7));
    expect(snapshot(occ[0])).toBe(before);
    expect(JSON.stringify(w.d1.q("SELECT * FROM events"))).not.toContain("Abc12345");
  });
});

describe("applyReply: перенос не обрывает ряд", () => {
  it("не начавшееся повторяющееся дело при переносе оставляет следующее повторение (иначе ряд оборвался бы)", async () => {
    const r = await w.create("каждый день в 10:00 выпить воду");
    const repo = w.repo();
    const planned = (await repo.getOcc(r.occId))!;
    expect(planned.state).toBe("planned");
    const res = applyReply(planned, { kind: "snooze", due: kyiv(2026, 11, 8, 18, 0) }, await w.settings(), NOW, null, true);
    await w.repo().exec(res.ops);
    const mains = w.d1.q<{ state: string }>("SELECT state FROM occurrences WHERE item_id = ? AND kind = 'main' ORDER BY id", r.itemId);
    expect(mains.map((o) => o.state)).toEqual(["snoozed", "planned"]);
    // повторный перенос ничего не дублирует
    await w.repo().exec(res.ops);
    expect(w.d1.q("SELECT 1 FROM occurrences WHERE item_id = ? AND kind = 'main'", r.itemId)).toHaveLength(2);
  });

  it("текст ответа: «Перенесла …» при просьбе словами, «Отложено …» при коротком ответе", async () => {
    const r = await w.create(A);
    const occ = (await w.repo().getOcc(r.occId))!;
    const s = await w.settings();
    const due = kyiv(2026, 11, 8, 9, 0);
    expect(applyReply(occ, { kind: "snooze", due }, s, NOW, null, true).text).toBe(MOVED_A);
    expect(applyReply(occ, { kind: "snooze", due }, s, NOW, null, false).text).toBe("Отложено: **Позвонить маме**. Напомню: завтра, 09:00.");
    expect(applyReply(occ, { kind: "ask" }, s, NOW, null, true).text).toBe(MOVE_ASK);
  });
});

