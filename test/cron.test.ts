import { beforeEach, describe, expect, it } from "vitest";
import { event } from "../src/db/repo.ts";
import { doneOps, snoozeOps } from "../src/service.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, CH_TODAY, OWNER, World } from "./world.ts";

let w: World;
beforeEach(async () => {
  w = new World();
  await w.seed();
});

const min = (n: number) => NOW + n * MINUTE;

describe("cron: лестница настойчивости", () => {
  it("срок наступил: одно сообщение с упоминанием и кнопками, дело «сработало»", async () => {
    const { occId } = await w.create("через 5 минут позвонить маме");
    const rep = await w.run(min(5));
    expect(rep.sent).toBe(1);
    const msgs = w.discord.live(CH_REMIND);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body.content).toContain(`<@${OWNER}>`);
    expect(msgs[0].body.content).toContain("Позвонить маме");
    expect(msgs[0].body.allowed_mentions).toEqual({ users: [OWNER] });
    const ids = msgs[0].body.components![0].components.map((c) => c.custom_id);
    expect(ids).toEqual([`done:${occId}`, `snzm:${occId}`, `edit:${occId}`]);
    const o = w.occ(occId);
    expect([o.state, o.fire_count, o.next_fire_at, o.lock_token]).toEqual(["fired", 1, min(15), null]);
  });

  it("до срока ничего не отправляется", async () => {
    await w.create("через 30 минут позвонить");
    expect((await w.run(min(10))).sent).toBe(0);
    expect(w.discord.posted).toHaveLength(0);
  });

  it("повторы 0, +10, +20, +40: каждый раз новое сообщение, прежнее удаляется; потом «просрочено»", async () => {
    const { occId } = await w.create("через 5 минут оплатить счёт");
    const due = 5;
    for (const m of [0, 10, 20, 40]) await w.run(min(due + m));
    expect(w.discord.posted).toHaveLength(4);
    expect(w.discord.live(CH_REMIND)).toHaveLength(1); // в канале одно актуальное
    expect(w.discord.posted.slice(0, 3).every((p) => p.deleted)).toBe(true);
    expect(w.occ(occId).next_fire_at).toBe(min(due + 120));

    await w.run(min(due + 120));
    const last = w.discord.live(CH_REMIND)[0];
    expect(last.body.content).toContain("висит");
    expect(w.occ(occId).state).toBe("overdue");
    // ещё два «просрочено» раз в 2 часа, потом тишина до сводок
    await w.run(min(due + 240));
    await w.run(min(due + 360));
    expect(w.occ(occId).next_fire_at).toBeNull();
    const before = w.discord.posted.length;
    await w.run(min(due + 1000));
    expect(w.discord.posted.length).toBe(before);
    expect(w.occ(occId).state).toBe("overdue"); // дело не исчезает
  });

  it("повтор не уходит, пока дело не закрыто, а после «Готово» молчит", async () => {
    const { occId } = await w.create("через 5 минут позвонить");
    await w.run(min(5));
    const repo = w.repo();
    await repo.exec(doneOps((await repo.getOcc(occId))!, min(6)));
    await w.run(min(15));
    await w.run(min(60));
    expect(w.discord.posted).toHaveLength(1);
  });

  it("откладывание: лестница заново от нового времени", async () => {
    const { occId } = await w.create("через 5 минут позвонить");
    await w.run(min(5));
    const repo = w.repo();
    await repo.exec(snoozeOps((await repo.getOcc(occId))!, min(65), min(6)));
    await w.run(min(30)); // старое расписание не срабатывает
    expect(w.discord.posted).toHaveLength(1);
    await w.run(min(65));
    expect(w.discord.posted).toHaveLength(2);
    expect(w.discord.posted[1].body.content).toContain("отложено 1 р.");
    await w.run(min(75)); // +10 от нового времени
    expect(w.discord.posted).toHaveLength(3);
  });

  it("догонялка: после простоя одно сообщение за последний наступивший шаг, без серии", async () => {
    const { occId } = await w.create("через 5 минут важное дело");
    const rep = await w.run(min(5 + 5 * 60)); // бот не работал 5 часов
    expect(rep.sent).toBe(1);
    expect(w.discord.posted[0].body.content).toContain("висит");
    expect(w.discord.posted[0].body.content).toContain("Прошло: 5 ч");
    expect(w.occ(occId).state).toBe("overdue");
    expect(w.occ(occId).next_fire_at).toBe(min(5 + 360));
  });

  it("настойчивость дела: у каждого своя лестница", async () => {
    const strong = await w.create("через 5 минут первое");
    const repo = w.repo();
    await repo.exec([{ sql: "UPDATE items SET ladder = ? WHERE id = ?", params: ['{"preset":"strong"}', strong.itemId] }]);
    await w.run(min(5));
    expect(w.occ(strong.occId).next_fire_at).toBe(min(5 + 5)); // у «настойчиво» второй шаг через 5 минут
  });
});

describe("cron: повторяющиеся дела и таймеры", () => {
  it("первое срабатывание порождает следующее (одно, без дублей)", async () => {
    const { itemId } = await w.create("каждый день в 13:00 таблетки");
    await w.run(kyiv(2026, 11, 7, 13, 0));
    await w.run(kyiv(2026, 11, 7, 13, 10));
    const mains = w.d1.q<{ due_at: number; state: string }>("SELECT due_at, state FROM occurrences WHERE item_id = ? ORDER BY due_at", itemId);
    expect(mains.map((m) => [m.due_at, m.state])).toEqual([
      [kyiv(2026, 11, 7, 13, 0), "fired"],
      [kyiv(2026, 11, 8, 13, 0), "planned"],
    ]);
  });

  it("вчерашнее остаётся «просрочено», сегодняшнее приходит отдельным делом", async () => {
    const { itemId } = await w.create("каждый день в 13:00 таблетки");
    await w.run(kyiv(2026, 11, 7, 13, 0)); // не закрыто
    await w.run(kyiv(2026, 11, 8, 13, 0));
    const rows = w.d1.q<{ due_at: number; state: string }>("SELECT due_at, state FROM occurrences WHERE item_id = ? ORDER BY due_at", itemId);
    expect(rows.map((r) => r.state)).toEqual(["overdue", "fired", "planned"]);
  });

  it("таймер: каждое срабатывание — одно сообщение, прошлое удаляется, прежнее срабатывание закрыто", async () => {
    const { itemId } = await w.create("каждые 20 минут проверить плиту до 13:00");
    await w.run(min(20));
    await w.run(min(40));
    expect(w.discord.posted).toHaveLength(2);
    expect(w.discord.live(CH_REMIND)).toHaveLength(1);
    const ids = w.discord.live(CH_REMIND)[0].body.components![0].components.map((c) => c.custom_id);
    expect(ids[0]).toMatch(/^done:/);
    expect(ids[2]).toBe(`stop:${itemId}`);
    const states = w.d1.q<{ state: string }>("SELECT state FROM occurrences WHERE item_id = ? ORDER BY due_at", itemId).map((r) => r.state);
    expect(states.slice(0, 2)).toEqual(["done", "fired"]);
    // до 13:00 (через 60 минут) — последний; после границы ряд кончается
    await w.run(min(60));
    await w.run(min(80));
    const total = w.d1.q("SELECT 1 FROM occurrences WHERE item_id = ?", itemId).length;
    expect(total).toBe(3);
  });

  it("«заранее»: отдельные предупреждения, одно сообщение без лестницы", async () => {
    await w.seed({ settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
    await w.create("20 ноября оплатить ФОП заранее за 7, 3 и 1 день");
    await w.run(kyiv(2026, 11, 13, 9, 0));
    const m = w.discord.live(CH_REMIND);
    expect(m).toHaveLength(1);
    expect(m[0].body.content).toContain("Скоро срок");
    expect(m[0].body.content).toContain("через 7 дн.");
    await w.run(kyiv(2026, 11, 13, 10, 0));
    expect(w.discord.posted).toHaveLength(1); // не повторяется
  });
});

describe("cron: тихие часы и отъезд (настройки, по умолчанию выключены)", () => {
  it("по умолчанию тихих часов нет: ночью напоминание приходит", async () => {
    await w.create("в 3 ночи дело");
    await w.run(kyiv(2026, 11, 8, 3, 0));
    expect(w.discord.posted).toHaveLength(1);
  });

  it("включены: ночное откладывается до конца тихих часов, «пробивающее» приходит сразу", async () => {
    await w.seed({ settings: { quiet_enabled: "1" } });
    const a = await w.create("завтра в 2:30 обычное");
    const b = await w.create("критично завтра в 2:30 срочное");
    await w.run(kyiv(2026, 11, 8, 2, 30));
    expect(w.discord.posted).toHaveLength(1);
    expect(w.discord.posted[0].body.content).toContain("Срочное");
    expect(w.occ(a.occId).next_fire_at).toBe(kyiv(2026, 11, 8, 7, 0));
    expect(w.occ(b.occId).state).toBe("fired");
    await w.run(kyiv(2026, 11, 8, 7, 0));
    // в 07:00 уходит «Обычное» и догоняющее повторение «Срочного» (его шаги +10, +20, +40 уже позади — одно сообщение)
    expect(w.discord.posted).toHaveLength(3);
    expect(w.discord.posted.slice(1).map((p) => p.body.content).join("|")).toContain("Обычное");
  });

  it("«я в отъезде»: тишина, возврат — одна сводка, потом всё приходит", async () => {
    const back = kyiv(2026, 11, 10, 9, 0);
    await w.seed({ settings: { away_until: String(back), summary_morning: "off", summary_evening: "off", weekly: "off" } });
    const { occId } = await w.create("через 5 минут позвонить");
    await w.run(min(5));
    await w.run(kyiv(2026, 11, 9, 12, 0));
    expect(w.discord.posted).toHaveLength(0);
    expect(w.occ(occId).next_fire_at).toBe(back);
    await w.run(back);
    // в этот запуск уходит сообщение дела и одна сводка «С возвращением»
    const texts = w.discord.posted.map((p) => p.body.content);
    expect(texts.some((t) => t?.includes("С возвращением"))).toBe(true);
    expect(texts.filter((t) => t?.includes("С возвращением"))).toHaveLength(1);
    expect((await w.settings()).awayUntil).toBe(0);
    await w.run(back + MINUTE);
    expect(w.discord.posted.filter((p) => p.body.content?.includes("С возвращением"))).toHaveLength(1);
  });
});

describe("cron: сбои, замок и лимиты", () => {
  it("Discord 5xx: ничего не потеряно, на следующей минуте уйдёт", async () => {
    const { occId } = await w.create("через 5 минут позвонить");
    w.discord.failPost = { status: 503, times: 1 };
    const r1 = await w.run(min(5), { watchdogUrl: "https://hc.example/ping" });
    expect(r1.failed).toBe(1);
    expect(w.occ(occId).fire_count).toBe(0);
    expect(w.occ(occId).lock_token).toBeNull();
    expect(w.d1.q("SELECT kind FROM events WHERE kind = 'send_failed'")).toHaveLength(1);
    await w.run(min(6));
    expect(w.discord.posted).toHaveLength(1);
  });

  it("429: останавливаемся до следующей минуты, дело не тронуто", async () => {
    await w.create("через 5 минут первое");
    await w.create("через 5 минут второе");
    w.discord.failPost = { status: 429, times: 1 };
    const r = await w.run(min(5));
    expect(r.sent).toBe(0);
    expect(w.d1.q("SELECT kind FROM events WHERE kind = 'rate_limited'")).toHaveLength(1);
    const r2 = await w.run(min(6));
    expect(r2.sent).toBe(2);
  });

  it("недоступный канал (403): повтор реже, раз в 10 минут", async () => {
    const { occId } = await w.create("через 5 минут позвонить");
    w.discord.failPost = { status: 403, times: 1 };
    await w.run(min(5));
    expect(w.occ(occId).next_fire_at).toBe(min(15));
  });

  it("лимит подзапросов: не больше 50 за запуск, остальное уйдёт следующей минутой", async () => {
    for (let i = 0; i < 60; i++) await w.create(`через 5 минут дело ${i}`);
    const r1 = await w.run(min(5));
    expect(r1.subrequests).toBeLessThanOrEqual(50);
    expect(r1.sent).toBeLessThanOrEqual(35);
    expect(r1.sent).toBeGreaterThan(20);
    const r2 = await w.run(min(6));
    expect(r2.subrequests).toBeLessThanOrEqual(50);
    expect(r1.sent + r2.sent).toBe(60); // второй запуск добирает остальное, ничего не потеряно и не продублировано
    expect(w.d1.q("SELECT 1 FROM occurrences WHERE fire_count = 0")).toHaveLength(0);
    // 60 напоминаний + одно предупреждение «запас лимитов Cloudflare»: запуск дошёл почти до 50 подзапросов (usage.ts, от 70%)
    const isLimitWarning = (p: { body: { content?: string } }) => String(p.body.content ?? "").includes("лимитов Cloudflare");
    expect(w.discord.posted.filter((p) => !isLimitWarning(p))).toHaveLength(60);
    expect(w.discord.posted.filter(isLimitWarning)).toHaveLength(1);
  });

  it("запуск под замком: параллельный запуск не дублирует отправку", async () => {
    await w.create("через 5 минут позвонить");
    const repo1 = w.repo();
    const pre = await repo1.prelude(min(5), 35, "чужой-запуск");
    expect(pre.claimed).toHaveLength(1);
    const r = await w.run(min(5));
    expect(r.claimed).toBe(0);
    expect(w.discord.posted).toHaveLength(0);
  });

  it("нет канала напоминаний (до /setup): дела не теряются", async () => {
    const w2 = new World();
    await w2.seed({ remind: false });
    const { occId } = await w2.create("через 5 минут позвонить");
    const r = await w2.run(min(5));
    expect(r.sent).toBe(0);
    expect(r.notes.join(" ")).toContain("/setup");
    expect(w2.occ(occId).state).toBe("planned");
    expect(w2.occ(occId).lock_token).toBeNull();
  });
});

describe("cron: сводки, панель, сторож", () => {
  it("утренняя сводка: один раз в день, после настроенного времени, со строкой «Бот на месте»", async () => {
    await w.create("завтра в 10 купить хлеб");
    const day = (h: number, m = 0) => kyiv(2026, 11, 8, h, m);
    await w.run(day(7, 59));
    expect(w.discord.posted).toHaveLength(0);
    const r = await w.run(day(8, 0));
    expect(r.summaries).toEqual(["morning"]);
    const t = w.discord.posted[0].body.content!;
    expect(t).toContain("Сводка на сегодня");
    expect(t).toContain("10:00 Купить хлеб");
    expect(t).toContain("Бот на месте");
    await w.run(day(8, 1));
    await w.run(day(9, 0));
    expect(w.discord.posted.filter((p) => p.body.content?.includes("Сводка на сегодня"))).toHaveLength(1);
  });

  it("время сводок настраивается и сводку можно выключить", async () => {
    await w.seed({ settings: { summary_morning: "07:30", summary_evening: "off", weekly: "off" } });
    const r = await w.run(kyiv(2026, 11, 8, 7, 30));
    expect(r.summaries).toEqual(["morning"]);
    const r2 = await w.run(kyiv(2026, 11, 8, 20, 30));
    expect(r2.summaries).toEqual([]);
  });

  it("сводка не приходит сильно позже своего окна (бот был выключен весь день)", async () => {
    const r = await w.run(kyiv(2026, 11, 8, 14, 0));
    expect(r.summaries).toEqual([]);
  });

  it("вечерняя сводка просит закрыть или перенести незакрытое", async () => {
    await w.create("через 5 минут позвонить");
    await w.run(min(5)); // сработало, не закрыто
    const r = await w.run(kyiv(2026, 11, 7, 20, 0));
    expect(r.summaries).toContain("evening");
    const t = w.discord.posted.find((p) => p.body.content?.includes("Вечерняя сводка"))!.body.content!;
    expect(t).toContain("закройте или перенесите");
    expect(t).toContain("Позвонить");
  });

  it("итоги недели: воскресенье 19:00", async () => {
    const sunday = kyiv(2026, 11, 8, 19, 0);
    const r = await w.run(sunday);
    expect(r.summaries).toContain("weekly");
    expect(w.discord.posted.some((p) => p.body.content?.includes("Итоги недели"))).toBe(true);
  });

  it("панель «Горит»: создаётся, правится на месте и только при изменении", async () => {
    await w.seed({ today: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
    const t0 = kyiv(2026, 11, 7, 12, 0); // минута кратна 5
    await w.create("через 5 минут позвонить");
    await w.run(t0);
    expect(w.discord.live(CH_TODAY)).toHaveLength(1);
    expect(w.discord.live(CH_TODAY)[0].body.content).toContain("Ничего не висит");
    await w.run(t0 + 5 * MINUTE); // дело сработало -> в панели
    expect(w.discord.live(CH_TODAY)).toHaveLength(1); // то же сообщение
    expect(w.discord.edits).toHaveLength(1);
    expect(w.discord.edits[0].body.content).toContain("Позвонить");
    await w.run(t0 + 10 * MINUTE); // без изменений — не трогаем
    expect(w.discord.edits).toHaveLength(1);
  });

  it("сторож: пинг раз в 10 минут, при ошибке — /fail", async () => {
    const env = { watchdogUrl: "https://hc.example/abc" };
    await w.run(kyiv(2026, 11, 7, 12, 0), env);
    await w.run(kyiv(2026, 11, 7, 12, 1), env);
    expect(w.pings).toEqual(["https://hc.example/abc"]);
    await w.create("через 5 минут позвонить", kyiv(2026, 11, 7, 12, 10));
    w.discord.failPost = { status: 500, times: 1 };
    await w.run(kyiv(2026, 11, 7, 12, 20), env);
    expect(w.pings.at(-1)).toBe("https://hc.example/abc/fail");
  });

  it("отметка «жив» пишется в базу каждый запуск", async () => {
    await w.run(NOW);
    expect(w.d1.q("SELECT value FROM meta WHERE key = 'alive_at'")).toEqual([{ value: String(NOW) }]);
  });

  it("журнал событий без текста дел", async () => {
    await w.create("через 5 минут очень личное название");
    await w.run(min(5));
    await w.repo().exec([event(NOW, "x")]);
    expect(JSON.stringify(w.d1.q("SELECT * FROM events"))).not.toContain("личное");
  });
});

describe("cron: приём обычного текста из канала «бот»", () => {
  beforeEach(async () => {
    await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  });

  it("первый запуск запоминает конец канала и старое не разбирает", async () => {
    w.discord.say(CH_BOT, OWNER, "завтра в 10 старое сообщение");
    await w.run(NOW);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    expect(w.d1.q("SELECT 1 FROM meta WHERE key = ?", `intake_last:${CH_BOT}`)).toHaveLength(1);
  });

  it("новое сообщение хозяина -> дело и ответ «Верно / Изменить»; чужие и бота игнорируются", async () => {
    await w.run(NOW);
    w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб");
    w.discord.say(CH_BOT, "555", "завтра в 11 чужое");
    w.discord.say(CH_BOT, "777", "ответ бота", { bot: true });
    const r = await w.run(NOW + MINUTE);
    expect(r.intake).toBe(1);
    expect(w.d1.q("SELECT title FROM items")).toEqual([{ title: "Купить хлеб" }]);
    const reply = w.discord.live(CH_BOT)[0];
    expect(reply.body.content).toContain("Записано: **Купить хлеб** — завтра, 10:00");
    const rows = reply.body.components!;
    const ids = rows.flatMap((x) => x.components.map((c) => c.custom_id));
    expect(ids.some((i) => i.startsWith("edit:"))).toBe(true);
    expect(ids.some((i) => i.startsWith("rm:"))).toBe(true);
    expect(ids.some((i) => i.startsWith("ok:") || i.startsWith("lad:"))).toBe(false); // подтверждение упрощено (2026-11-08)
    await w.run(NOW + 2 * MINUTE); // повторно не разбирается
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(1);
  });

  it("текст без времени -> черновик и вопрос «когда?»", async () => {
    await w.run(NOW);
    w.discord.say(CH_BOT, OWNER, "позвонить в налоговую");
    await w.run(NOW + MINUTE);
    const reply = w.discord.live(CH_BOT)[0];
    expect(reply.body.content).toContain("когда напомнить?");
    expect(w.d1.q("SELECT state FROM occurrences")).toEqual([{ state: "draft" }]);
  });

  it("пароль не сохраняется и не попадает в журнал", async () => {
    await w.run(NOW);
    w.discord.say(CH_BOT, OWNER, "пароль: Qw3rty!x7");
    await w.run(NOW + MINUTE);
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
    expect(w.discord.live(CH_BOT)[0].body.content).toContain("Bitwarden");
    const dump = JSON.stringify(w.d1.q("SELECT * FROM events")) + JSON.stringify(w.d1.q("SELECT * FROM meta"));
    expect(dump).not.toContain("Qw3rty");
  });

  it("канал без доступа к тексту: один раз в день подсказка, а не молчание", async () => {
    await w.run(NOW);
    w.discord.say(CH_BOT, OWNER, "");
    await w.run(NOW + MINUTE);
    expect(w.discord.live(CH_BOT)[0].body.content).toContain("Message Content Intent");
    w.discord.say(CH_BOT, OWNER, "");
    await w.run(NOW + 2 * MINUTE);
    expect(w.discord.live(CH_BOT)).toHaveLength(1);
  });
});
