import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/discord/commands.ts";
import { type Interaction, handleInteraction, modalValues } from "../src/discord/interactions.ts";
import { verifySignature } from "../src/discord/verify.ts";
import worker, { type Env } from "../src/worker.ts";
import { MINUTE } from "../src/time/tz.ts";
import { FakeD1 } from "./d1shim.ts";
import { NOW, kyiv } from "./helpers.ts";
import { CH_BOT, CH_REMIND, OWNER, World } from "./world.ts";

type R = { type: number; data?: any };

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

async function call(i: Partial<Interaction>, opts: { now?: number; user?: string } = {}): Promise<R> {
  const repo = w.repo();
  const user = { id: opts.user ?? OWNER };
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user }, type: 2, ...i } as Interaction,
    { repo, api: w.discord, now: opts.now ?? NOW, env: {}, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r as R;
}

const cmd = (name: string, options: Record<string, unknown> = {}, extra: Partial<Interaction> = {}, o: { now?: number; user?: string } = {}) =>
  call({ type: 2, data: { name, type: 1, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) }, ...extra }, o);
const click = (custom_id: string, values?: string[], o: { now?: number } = {}) =>
  call({ type: 3, data: { custom_id, values }, message: { id: "m1" } }, o);
const submit = (custom_id: string, fields: Record<string, string | string[]>, o: { now?: number } = {}) =>
  call(
    {
      type: 5,
      data: {
        custom_id,
        components: Object.entries(fields).map(([id, v]) => ({
          type: 18,
          component: Array.isArray(v) ? { type: 3, custom_id: id, values: v } : { type: 4, custom_id: id, value: v },
        })),
      },
    },
    o,
  );

const flat = (r: R): string[] => (r.data?.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.custom_id));

beforeEach(async () => {
  w = new World();
  pending = [];
  await w.seed({ today: true, intake: true });
});

describe("доступ", () => {
  it("PING от Discord", async () => {
    expect((await call({ type: 1 })).type).toBe(1);
  });

  it("до /setup команды не работают, первый /setup назначает хозяина, чужим — отказ", async () => {
    w = new World();
    const before = await cmd("list");
    expect(before.data.content).toContain("/setup");
    const s = await cmd("setup", {}, {}, { user: "u-first" });
    expect(s.type).toBe(5); // отложенный ответ
    expect(w.d1.q("SELECT value FROM meta WHERE key = 'owner_id'")).toEqual([{ value: "u-first" }]);
    const stranger = await cmd("list", {}, {}, { user: "u-other" });
    expect(stranger.data.content).toBe("Этот бот личный.");
    expect((await cmd("list", {}, {}, { user: "u-first" })).data.content).toContain("Открытых дел нет");
  });

  it("/setup заводит три канала, второй раз — те же; id сохраняются, канал «бот» становится каналом приёма", async () => {
    w = new World();
    await cmd("setup");
    expect(w.discord.created.map((c) => c.name)).toEqual(["почта", "бот", "сегодня"]);
    expect(w.discord.originals[0].body.content).toContain("Готово");
    await cmd("setup");
    expect(w.discord.created).toHaveLength(3);
    const s = await w.settings();
    expect([s.chRemind, s.chBot, s.chToday].every(Boolean)).toBe(true);
    expect(s.intake).toEqual([s.chBot]);
  });

  it("/setup узнаёт прежний канал «напоминания» как «почту» и не заводит второй", async () => {
    w = new World();
    w.discord.channels.push({ id: "77", name: "напоминания", type: 0 });
    await cmd("setup");
    expect(w.discord.created.map((c) => c.name)).toEqual(["бот", "сегодня"]);
    expect((await w.settings()).chRemind).toBe("77");
  });

  it("/setup вне сервера — подсказка", async () => {
    w = new World();
    const r = await call({ type: 2, guild_id: undefined, data: { name: "setup", type: 1 } });
    expect(r.data.content).toContain("на сервере");
  });
});

describe("команды записи", () => {
  it("/remind: «Записано», кнопки «Верно» и «Изменить», ответ виден только хозяину вне канала «бот»", async () => {
    const r = await cmd("remind", { text: "завтра в 10 купить хлеб" });
    expect(r.type).toBe(4);
    expect(r.data.content).toContain("Записано: **Купить хлеб** — завтра, 10:00");
    expect(r.data.flags).toBe(64);
    expect(flat(r).some((x) => x.startsWith("edit:"))).toBe(true);
    expect(flat(r).some((x) => x.startsWith("rm:"))).toBe(true);
    expect(flat(r).some((x) => x.startsWith("ok:") || x.startsWith("lad:"))).toBe(false); // подтверждение упрощено (2026-11-08)
    expect(w.d1.q("SELECT title, source FROM items")).toEqual([{ title: "Купить хлеб", source: "slash" }]);
  });

  it("в канале «бот» ответ виден всем", async () => {
    const r = await cmd("remind", { text: "завтра в 10 купить хлеб" }, { channel_id: CH_BOT });
    expect(r.data.flags).toBeUndefined();
  });

  it("/remind без времени: вопрос «когда?», дальше кнопка «Через час» ставит срок", async () => {
    const r = await cmd("remind", { text: "позвонить в налоговую" });
    expect(r.data.content).toContain("когда напомнить?");
    const occId = Number(flat(r).find((x) => x.startsWith("when:"))!.split(":")[1]);
    const u = await click(`when:${occId}:h1`);
    expect(u.type).toBe(7);
    expect(u.data.content).toContain("Записано: **Позвонить в налоговую** — сегодня, 13:00");
    expect(w.occ(occId).state).toBe("planned");
    expect(w.occ(occId).next_fire_at).toBe(NOW + 60 * MINUTE);
  });

  it("«Без срока» оставляет дело в списке, не теряет", async () => {
    const r = await cmd("remind", { text: "почитать про Rust" });
    const occId = Number(flat(r)[0].split(":")[1]);
    const u = await click(`nosd:${occId}`);
    expect(u.data.content).toContain("Сохранено без срока");
    expect(w.occ(occId).state).toBe("draft");
    expect((await cmd("list")).data.content).toContain("Почитать про Rust — без срока");
  });

  it("секрет не сохраняется", async () => {
    const r = await cmd("remind", { text: "пароль: Qw3rty!x7 завтра" });
    expect(r.data.content).toContain("Bitwarden");
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(0);
  });

  it("/every: повтор распознан, а фраза без повтора — подсказка", async () => {
    const ok = await cmd("every", { text: "20 минут проверить плиту до 23:00" });
    expect(ok.data.content).toContain("Повтор: каждые 20 минут, до 23:00");
    expect(flat(ok).some((x) => x.startsWith("lad:"))).toBe(false); // у таймера лестницы нет
    expect(w.d1.q("SELECT kind FROM items")).toEqual([{ kind: "timer" }]);
    const bad = await cmd("every", { text: "купить хлеб" });
    expect(bad.data.content).toContain("Не понял повтор");
    expect(w.d1.q("SELECT 1 FROM items")).toHaveLength(1);
  });

  it("меню сообщения «Напомнить об этом»: берёт текст сообщения и ссылку на него", async () => {
    const r = await call({
      type: 2,
      channel_id: "c-77",
      data: { name: "Напомнить об этом", type: 3, target_id: "m-5", resolved: { messages: { "m-5": { content: "завтра в 11 созвон с Антоном" } } } },
    });
    expect(r.data.content).toContain("Созвон с Антоном");
    expect(w.d1.q("SELECT body, source FROM items")).toEqual([{ body: "https://discord.com/channels/g1/c-77/m-5", source: "menu" }]);
    const empty = await call({ type: 2, data: { name: "Напомнить об этом", type: 3, target_id: "m-6", resolved: { messages: { "m-6": { content: " " } } } } });
    expect(empty.data.content).toContain("нет текста");
  });
});

describe("кнопки напоминания", () => {
  async function fired(text = "через 5 минут позвонить") {
    const r = await w.create(text);
    await w.run(NOW + 5 * MINUTE);
    return r;
  }

  it("Готово: дело закрыто, повторов нет, кнопки убраны", async () => {
    const { occId } = await fired();
    const u = await click(`done:${occId}`, undefined, { now: NOW + 6 * MINUTE });
    expect(u.type).toBe(7);
    expect(u.data.content).toBe("Готово: Позвонить");
    expect(u.data.components).toEqual([]);
    expect(w.occ(occId).state).toBe("done");
    await w.run(NOW + 30 * MINUTE);
    expect(w.discord.live(CH_REMIND)).toHaveLength(1);
    expect((await click(`done:${occId}`)).data.content).toContain("уже закрыто"); // повторное нажатие не ломает
  });

  it("15 мин и 1 час: откладывание со счётчиком", async () => {
    const { occId } = await fired();
    const at = NOW + 6 * MINUTE;
    const u = await click(`snz:${occId}:15`, undefined, { now: at });
    expect(u.data.content).toContain("Отложено: **Позвонить**");
    expect([w.occ(occId).state, w.occ(occId).snooze_count, w.occ(occId).next_fire_at]).toEqual(["snoozed", 1, at + 15 * MINUTE]);
    await click(`snz:${occId}:60`, undefined, { now: at });
    expect(w.occ(occId).snooze_count).toBe(2);
    expect(w.occ(occId).next_fire_at).toBe(at + 60 * MINUTE);
  });

  it("на 3-й раз вопрос «сегодня / разбить на шаги / удалить»; «Сегодня» обнуляет счётчик", async () => {
    const { occId, itemId } = await fired();
    await click(`snz:${occId}:15`);
    await click(`snz:${occId}:15`);
    const q = await click(`snz:${occId}:15`);
    expect(q.data.content).toContain("в 3-й раз");
    expect(flat(q)).toEqual([`tdy:${occId}`, `split:${occId}`, `del:${itemId}`]);
    expect(w.occ(occId).snooze_count).toBe(2); // пока не откладывали
    const t = await click(`tdy:${occId}`, undefined, { now: NOW + 6 * MINUTE });
    expect(t.data.content).toContain("Отложено");
    expect(w.occ(occId).snooze_count).toBe(0);
    expect(w.occ(occId).next_fire_at).toBe(kyiv(2026, 11, 7, 19, 0));
  });

  it("«Разбить на шаги»: окно, потом новые дела, исходное закрыто", async () => {
    const { occId, itemId } = await fired("через 5 минут сделать отчёт");
    const m = await click(`split:${occId}`);
    expect(m.type).toBe(9);
    const u = await submit(`m_split:${occId}`, { steps: "собрать данные\nнаписать выводы завтра в 10\n" }, { now: NOW + 6 * MINUTE });
    expect(u.data.content).toContain("Разбито на шаги (2)");
    const items = w.d1.q<{ title: string; archived_at: number | null }>("SELECT title, archived_at FROM items ORDER BY id");
    expect(items.map((x) => x.title)).toEqual(["Сделать отчёт", "Собрать данные", "Написать выводы"]);
    expect(items[0].archived_at).not.toBeNull();
    expect(w.occ(occId).state).toBe("cancelled");
    expect(itemId).toBe(1);
    const due = w.d1.q<{ due_at: number }>("SELECT due_at FROM occurrences WHERE item_id IN (2, 3) ORDER BY item_id");
    expect(due.map((d) => d.due_at)).toEqual([kyiv(2026, 11, 7, 19, 0), kyiv(2026, 11, 8, 10, 0)]);
  });

  it("«Удалить» и «Отменить» закрывают дело целиком", async () => {
    const { itemId, occId } = await fired();
    const u = await click(`del:${itemId}`);
    expect(u.data.content).toBe("Удалено: Позвонить");
    expect(w.occ(occId).state).toBe("cancelled");
  });

  it("Стоп у таймера обрывает ряд", async () => {
    const { itemId } = await w.create("каждые 20 минут плита до 23:00");
    await w.run(NOW + 20 * MINUTE);
    const u = await click(`stop:${itemId}`);
    expect(u.data.content).toContain("Остановлено: Плита");
    await w.run(NOW + 60 * MINUTE);
    expect(w.discord.posted.filter((p) => p.channel === CH_REMIND)).toHaveLength(1);
  });

  it("выбор настойчивости под «Записано» меняет лестницу этого дела", async () => {
    const r = await cmd("remind", { text: "завтра в 10 созвон" });
    const occId = Number(flat(r).find((x) => x.startsWith("edit:"))!.split(":")[1]);
    const u = await click(`lad:${occId}`, ["strong"]); // выбор в подтверждении убран, но у старых сообщений он работает
    expect(u.data.content).toContain("Настойчивость: настойчиво");
    expect(w.d1.q("SELECT ladder FROM items")).toEqual([{ ladder: '{"preset":"strong"}' }]);
    const ok = await click(`ok:${occId}`);
    expect(ok.data.components).toEqual([]);
  });

  it("«Изменить»: окно с текущими значениями; сохранение меняет название, время и свои числа", async () => {
    const { occId } = await w.create("завтра в 10 созвон");
    const m = await click(`edit:${occId}`);
    expect(m.type).toBe(9);
    const fields = modalValues(m.data.components.map((l: any) => ({ ...l, component: { ...l.component, value: l.component.value } })));
    expect(fields.get("title")).toBe("Созвон");
    expect(fields.get("when")).toBe("11.08 10:00");
    const u = await submit(`m_edit:${occId}`, { title: "Созвон с командой", when: "завтра 11:30", ladder: ["custom"], nums: "0 5 15" });
    expect(u.data.content).toContain("Записано: **Созвон с командой** — завтра, 11:30");
    expect(u.data.content).toContain("свои числа: 0, 5, 15 мин");
    expect(w.occ(occId).next_fire_at).toBe(kyiv(2026, 11, 8, 11, 30));
    // ошибки не портят дело
    expect((await submit(`m_edit:${occId}`, { title: "x", when: "абракадабра", ladder: ["keep"], nums: "" })).data.content).toContain("Не понял время");
    expect((await submit(`m_edit:${occId}`, { title: "x", when: "", ladder: ["custom"], nums: "abc" })).data.content).toContain("Для «свои числа»");
    expect((await submit(`m_edit:${occId}`, { title: "пароль: Qw3rty!x7", when: "", ladder: ["keep"], nums: "" })).data.content).toContain("Bitwarden");
  });

  it("«На…»: быстрый вариант, своя строка (она важнее) и ошибки", async () => {
    const { occId } = await fired();
    expect((await click(`snzat:${occId}`)).type).toBe(9);
    const at = NOW + 6 * MINUTE;
    const a = await submit(`m_snz:${occId}`, { quick: "tom", text: "" }, { now: at });
    expect(a.data.content).toContain("Отложено: **Позвонить** — до завтра, 09:00");
    const b = await submit(`m_snz:${occId}`, { quick: "tom", text: "в пятницу 15:00" }, { now: at });
    expect(b.data.content).toContain("до в пятницу, 15:00".replace("до в", "до в"));
    expect((await submit(`m_snz:${occId}`, { quick: "", text: "" }, { now: at })).data.content).toContain("Выберите вариант");
    expect((await submit(`m_snz:${occId}`, { text: "когда-нибудь" }, { now: at })).data.content).toContain("Не понял время");
    expect((await submit(`m_snz:${occId}`, { text: "сегодня в 8:00" }, { now: at })).data.content).toContain("уже прошло");
  });

  it("радио из окна приходит строкой в `value`, список — в `values`", () => {
    const v = modalValues([
      { type: 18, component: { type: 21, custom_id: "quick", value: "h3" } },
      { type: 18, component: { type: 3, custom_id: "ladder", values: ["soft"] } },
      { type: 18, component: { type: 4, custom_id: "text", value: "завтра" } },
      { type: 18, component: { type: 21, custom_id: "none", value: null } },
    ]);
    expect([v.get("quick"), v.get("ladder"), v.get("text"), v.has("none")]).toEqual(["h3", ["soft"], "завтра", false]);
  });
});

describe("списки, отмена, откладывание и отъезд командами", () => {
  it("/list, /week, /cancel, /snooze, автодополнение номера", async () => {
    const a = await w.create("завтра в 10 созвон");
    const b = await w.create("каждый месяц 20-го оплатить ФОП");
    const list = (await cmd("list")).data.content;
    expect(list).toContain(`#${a.itemId} Созвон — запланировано: завтра, 10:00`);
    expect(list).toContain(`#${b.itemId} Оплатить ФОП ↻`);
    const week = (await cmd("week")).data.content;
    expect(week).toContain("**завтра**");
    expect(week).toContain("10:00 Созвон");

    const ac = await call({ type: 4, data: { name: "cancel", options: [{ name: "id", value: "", focused: true }] } });
    expect(ac.data.choices.map((c: any) => c.value)).toEqual([a.itemId, b.itemId]);

    const sn = await cmd("snooze", { id: a.itemId, when: "завтра 12:00" });
    expect(sn.data.content).toContain("до завтра, 12:00");
    expect(w.occ(a.occId).next_fire_at).toBe(kyiv(2026, 11, 8, 12, 0));
    expect((await cmd("snooze", { id: 999 })).data.content).toContain("Открытого дела");
    expect((await cmd("snooze", { id: a.itemId, when: "когда-нибудь" })).data.content).toContain("Не понял время");

    const c = await cmd("cancel", { id: b.itemId });
    expect(c.data.content).toBe("Отменено: Оплатить ФОП");
    expect((await cmd("cancel", { id: b.itemId })).data.content).toContain("Такого дела нет");
  });

  it("/snooze для дела без срока ставит срок", async () => {
    const r = await w.create("почитать");
    await cmd("snooze", { id: r.itemId, when: "завтра 9:00" });
    expect(w.occ(r.occId).state).toBe("planned");
  });

  it("/away: включить, посмотреть, выключить", async () => {
    expect((await cmd("away")).data.content).toContain("не в отъезде");
    expect((await cmd("away", { days: 3 })).data.content).toContain("Бот молчит до");
    expect((await w.settings()).awayUntil).toBe(NOW + 3 * 86400_000);
    expect((await cmd("away")).data.content).toContain("Вы в отъезде до");
    expect((await cmd("away", { days: 0 })).data.content).toContain("выключен");
    expect((await w.settings()).awayUntil).toBe(0);
  });
});

describe("настройки", () => {
  it("/settings показывает текущие значения; по умолчанию тихие часы выключены", async () => {
    const r = await cmd("settings");
    expect(r.data.content).toContain("Тихие часы: выкл (23:00–07:00)");
    expect(r.data.content).toContain("утром 08:00, вечером 20:00");
    expect(r.data.flags).toBe(64);
    expect(flat(r)).toEqual(["s_lad", "s_q", "s_qt", "s_away", "s_summ", "s_ladn", "s_dm", "s_light", "s_char", "s_mood", "s_llm"]);
  });

  it("переключатель тихих часов, время, сводки, отъезд, лестница по умолчанию, личка", async () => {
    expect((await click("s_q")).data.content).toContain("Тихие часы: вкл");
    expect((await click("s_q")).data.content).toContain("Тихие часы: выкл");
    expect((await click("s_qt")).type).toBe(9);
    expect((await submit("m_quiet", { from: "22:30", to: "6:45" })).data.content).toContain("22:30–06:45");
    expect((await submit("m_quiet", { from: "25:00", to: "07:00" })).data.content).toContain("ЧЧ:ММ");

    const s = await submit("m_summ", { morning: "07:30", evening: "выкл", weekly: "суббота 18:00", tz: "Europe/Warsaw" });
    expect(s.data.content).toContain("утром 07:30, вечером выкл; итоги недели: суббота 18:00");
    expect(s.data.content).toContain("Часовой пояс: Europe/Warsaw");
    expect((await submit("m_summ", { morning: "рано", evening: "20:00", weekly: "выкл", tz: "Nowhere/City" })).data.content).toContain("Часовой пояс");

    expect((await submit("m_away", { days: "2" })).data.content).toContain("Я в отъезде: до");
    expect((await submit("m_away", { days: "много" })).data.content).toContain("от 0 до 90");

    expect((await click("s_lad", ["strong"])).data.content).toContain("по умолчанию: настойчиво");
    expect((await submit("m_ladn", { nums: "0 3 9" })).data.content).toContain("свои числа: 0, 3, 9 мин");

    const dmOn = await click("s_dm");
    expect(dmOn.data.content).toContain("личка: вкл");
    expect((await w.settings()).intake).toContain(`dm-${OWNER}`);
    expect((await click("s_dm")).data.content).toContain("личка: выкл");
    expect((await w.settings()).intake).not.toContain(`dm-${OWNER}`);
  });

  it("график света: окно, группа, «выкл», неверное значение", async () => {
    expect((await cmd("settings")).data.content).toContain("График света (Днепр): выкл");
    expect((await click("s_light")).type).toBe(9);
    expect((await submit("m_light", { group: "3" })).data.content).toContain("График света (Днепр): группа 3");
    expect((await w.settings()).lightGroup).toBe("3");
    expect((await submit("m_light", { group: "3,1" })).data.content).toContain("группа 3.1");
    expect((await submit("m_light", { group: "9" })).data.content).toContain("Нужна группа");
    expect((await w.settings()).lightGroup).toBe("3.1");
    expect((await submit("m_light", { group: "выкл" })).data.content).toContain("График света (Днепр): выкл");
    expect((await w.settings()).lightGroup).toBeNull();
  });

  it("новое значение подхватывается cron: тихие часы из настроек действуют", async () => {
    await click("s_q");
    await w.create("завтра в 2:30 дело");
    await w.run(kyiv(2026, 11, 8, 2, 30));
    expect(w.discord.posted.filter((p) => p.channel === CH_REMIND)).toHaveLength(0);
  });
});

describe("описание команд для Discord", () => {
  it("имена, описания и параметры укладываются в правила Discord", () => {
    expect(COMMANDS.filter((c) => c.type === 1).length).toBeLessThanOrEqual(100);
    expect(COMMANDS.filter((c) => c.type === 3).length).toBeLessThanOrEqual(15);
    for (const c of COMMANDS) {
      expect(c.name.length).toBeLessThanOrEqual(32);
      if (c.type === 1) {
        expect(c.name).toMatch(/^[a-z0-9_-]+$/);
        expect(c.description!.length).toBeGreaterThan(0);
        expect(c.description!.length).toBeLessThanOrEqual(100);
        const o = (c as { options?: { required?: boolean; description: string }[] }).options ?? [];
        // обязательные параметры идут раньше необязательных
        expect(o.map((x) => Boolean(x.required))).toEqual([...o.map((x) => Boolean(x.required))].sort((a, b) => Number(b) - Number(a)));
        for (const x of o) expect(x.description.length).toBeLessThanOrEqual(100);
      } else {
        expect("description" in c).toBe(false);
      }
      expect(c.integration_types).toContain(c.name === "setup" ? 0 : 1);
    }
    expect(COMMANDS.map((c) => c.name)).toEqual(["remind", "every", "list", "week", "cancel", "snooze", "settings", "away", "power", "mood", "reset_mood", "style", "hints", "glossary", "quiet", "light", "menu", "setup", "Напомнить об этом"]);
  });
});

describe("подпись и Worker", () => {
  async function keys() {
    const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const sign = async (text: string) => hex(new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(text))));
    return { pub: hex(raw), sign };
  }

  it("verifySignature: верная подпись проходит, подделка и мусор — нет", async () => {
    const { pub, sign } = await keys();
    const body = '{"type":1}';
    const sig = await sign("1700000000" + body);
    expect(await verifySignature(pub, sig, "1700000000", body)).toBe(true);
    expect(await verifySignature(pub, sig, "1700000001", body)).toBe(false);
    expect(await verifySignature(pub, sig, "1700000000", body + " ")).toBe(false);
    expect(await verifySignature(pub, "zz", "1700000000", body)).toBe(false);
    expect(await verifySignature("", sig, "1700000000", body)).toBe(false);
    expect(await verifySignature(pub, sig, "", body)).toBe(false);
  });

  it("Worker: ответ на PING с подписью, 401 без неё, команда /list проходит весь путь", async () => {
    const { pub, sign } = await keys();
    const d1 = new FakeD1();
    const env = { DB: d1.asD1, DISCORD_PUBLIC_KEY: pub, DISCORD_BOT_TOKEN: "t", OWNER_ID: OWNER } as unknown as Env;
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const post = async (payload: unknown, goodSig = true) => {
      const body = JSON.stringify(payload);
      const ts = "1700000000";
      const sig = goodSig ? await sign(ts + body) : "00".repeat(64);
      return worker.fetch(
        new Request("https://meido.example/interactions", { method: "POST", body, headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts } }),
        env,
        ctx,
      );
    };
    const ping = await post({ type: 1 });
    expect(await ping.json()).toEqual({ type: 1 });
    expect((await post({ type: 1 }, false)).status).toBe(401);
    const list = await post({ id: "1", type: 2, token: "t", member: { user: { id: OWNER } }, data: { name: "list", type: 1 } });
    expect(((await list.json()) as { data: { content: string } }).data.content).toMatch(/^Открытых дел нет\./); // дальше короткая фраза горничной (характер включён по умолчанию)
    expect((await worker.fetch(new Request("https://meido.example/other"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://meido.example/"), env, ctx)).status).toBe(200);
  });
});
