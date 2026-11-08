// Кнопочное меню: экраны, дела постранично, действия с делом, добавление через окно, настройки по разделам, панель.
import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/discord/commands.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { NOW } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

type R = { type: number; data?: any };

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

async function call(i: Partial<Interaction>, opts: { now?: number } = {}): Promise<R> {
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
    { repo: w.repo(), api: w.discord, now: opts.now ?? NOW, env: {}, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r as R;
}
const click = (custom_id: string, values?: string[]) => call({ type: 3, data: { custom_id, values }, message: { id: "m1" } });
const submit = (custom_id: string, fields: Record<string, string | string[]>) =>
  call({
    type: 5,
    data: {
      custom_id,
      components: Object.entries(fields).map(([id, v]) => ({
        type: 18,
        component: Array.isArray(v) ? { type: 3, custom_id: id, values: v } : { type: 4, custom_id: id, value: v },
      })),
    },
    message: { id: "m1" },
  });

const ids = (r: R): string[] => (r.data?.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.custom_id as string));
const labels = (r: R): string[] => (r.data?.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.label as string));

beforeEach(async () => {
  w = new World();
  pending = [];
  await w.seed({ intake: true });
});

describe("меню: главный экран и навигация", () => {
  it("/menu: экран «только вам» с цифрами и кнопками", async () => {
    await w.create("завтра в 10 купить хлеб");
    const r = await call({ type: 2, data: { name: "menu", type: 1 } });
    expect(r.type).toBe(4);
    expect(r.data.flags).toBe(64);
    expect(r.data.content).toContain("на сегодня **0**");
    expect(r.data.content).toContain("висит **0**");
    // главный экран: добавить, сегодня, висит; ниже — все дела, неделя, «Ещё»
    expect(ids(r)).toEqual(["mn:add", "mn:ls:t:0", "mn:ls:h:0", "mn:ls:a:0", "mn:wk", "mn:more"]);
    expect(labels(r)).toEqual(["➕ Добавить дело", "📅 Сегодня 0", "⏳ Висит 0", "📋 Все дела", "🗓 Неделя", "⋯ Ещё"]);
  });

  it("«Ещё»: свет, настроение, настройки (на экране и из панели)", async () => {
    const r = await click("mn:more");
    expect(r.type).toBe(7);
    expect(ids(r)).toEqual(["mn:lt", "mn:mo", "mn:st", "mn:home"]);
    const p = await click("pn:more");
    expect(p.type).toBe(4);
    expect(ids(p)).toEqual(["pn:lt", "pn:mo", "pn:st", "pn:home"]);
  });

  it("кнопка панели открывает тот же экран отдельным сообщением «только вам»", async () => {
    const r = await click("pn:ls:a:0");
    expect(r.type).toBe(4);
    expect(r.data.flags).toBe(64);
    const home = await click("pn:home");
    expect(home.type).toBe(4);
    expect(ids(home)[0]).toBe("mn:add");
  });

  it("кнопка меню обновляет то же сообщение (type 7)", async () => {
    const r = await click("mn:home");
    expect(r.type).toBe(7);
  });

  it("список: пагинация по 5, номера открывают карточки, фильтры считают дела", async () => {
    for (let i = 1; i <= 7; i++) await w.create(`завтра в 1${i} дело ${i}`);
    const p0 = await click("mn:ls:a:0");
    expect(p0.data.content).toContain("страница 1 из 2");
    expect(ids(p0).filter((x) => x.startsWith("mn:it:"))).toHaveLength(5);
    const p1 = await click("mn:ls:a:1");
    expect(p1.data.content).toContain("страница 2 из 2");
    expect(ids(p1).filter((x) => x.startsWith("mn:it:"))).toHaveLength(2);
    expect(labels(p0)).toEqual(expect.arrayContaining(["Все 7", "Висит 0"]));
    const hot = await click("mn:ls:h:0");
    expect(hot.data.content).toContain("Здесь пусто");
  });

  it("мусор в аргументах не ломает: неизвестный фильтр и страница", async () => {
    await w.create("завтра в 10 хлеб");
    const r = await click("mn:ls:zzz:99");
    expect(r.type).toBe(7);
    expect(r.data.content).toContain("Хлеб");
  });
});

describe("меню: действия с делом", () => {
  async function one(text = "завтра в 10 позвонить маме") {
    const { occId, itemId } = await w.create(text);
    return { occId, itemId };
  }

  it("карточка → Готово: дело закрыто, показаны кнопки «куда дальше»", async () => {
    const { occId } = await one();
    const card = await click(`mn:it:${occId}:a:0`);
    expect(card.data.content).toContain("Позвонить маме");
    expect(ids(card)).toContain(`mn:dn:${occId}:a:0`);
    const done = await click(`mn:dn:${occId}:a:0`);
    expect(done.data.content).toContain("Готово: Позвонить маме");
    expect(ids(done)).toContain("mn:home");
    expect(w.occ(occId).state).toBe("done");
    // повторное нажатие: «уже закрыто», без падения
    const again = await click(`mn:dn:${occId}:a:0`);
    expect(again.data.content).toContain("уже закрыто");
  });

  it("быстрое откладывание: через час / вечером / завтра", async () => {
    const { occId } = await one();
    const r = await click(`mn:sz:${occId}:h1:a:0`);
    expect(r.data.content).toContain("Отложено");
    expect(w.occ(occId).state).toBe("snoozed");
    expect(w.occ(occId).next_fire_at).toBe(NOW + 60 * 60_000);
    const t = await click(`mn:sz:${occId}:tom:a:0`);
    expect(t.data.content).toContain("Отложено");
  });

  it("«На…» открывает окно, ответ из окна возвращает экран с навигацией", async () => {
    const { occId } = await one();
    const m = await click(`mn:sa:${occId}:a:0`);
    expect(m.type).toBe(9);
    expect(m.data.custom_id).toBe(`m_snz:${occId}:mn`);
    const r = await submit(`m_snz:${occId}:mn`, { quick: ["h3"], text: "" });
    expect(r.type).toBe(7);
    expect(r.data.content).toContain("Отложено");
    expect(ids(r)).toContain("mn:home");
  });

  it("«Изменить» открывает окно, сохранение меняет название", async () => {
    const { occId } = await one();
    const m = await click(`mn:ed:${occId}:a:0`);
    expect(m.type).toBe(9);
    expect(m.data.custom_id).toBe(`m_edit:${occId}:mn`);
    const r = await submit(`m_edit:${occId}:mn`, { title: "Позвонить папе", when: "", ladder: ["keep"], nums: "" });
    expect(r.type).toBe(7);
    expect(r.data.content).toContain("Позвонить папе");
    expect(ids(r)).toContain("mn:home");
  });

  it("удаление: сначала вопрос, потом «Да»; «Нет» возвращает карточку", async () => {
    const { occId, itemId } = await one();
    const ask = await click(`mn:dl:${itemId}:${occId}:a:0`);
    expect(ask.data.content).toContain("Удалить");
    expect(w.occ(occId).state).not.toBe("cancelled");
    const no = await click(`mn:it:${occId}:a:0`);
    expect(no.data.content).toContain("Позвонить маме");
    const yes = await click(`mn:dy:${itemId}:a:0`);
    expect(yes.data.content).toContain("Удалено");
    expect(w.occ(occId).state).toBe("cancelled");
    expect(w.occ(occId).closed_reason).toBe("delete");
  });

  it("повторяющееся дело: кнопка «Остановить повтор» есть и работает", async () => {
    const { occId, itemId } = await one("каждый день в 9:00 зарядка");
    const card = await click(`mn:it:${occId}:a:0`);
    expect(ids(card)).toContain(`mn:sp:${itemId}:a:0`);
    const r = await click(`mn:sp:${itemId}:a:0`);
    expect(r.data.content).toContain("Повтор остановлен");
    expect(w.occ(occId).state).toBe("cancelled");
  });

  it("закрытое дело: карточка говорит «уже закрыто»", async () => {
    const { occId } = await one();
    await click(`mn:dn:${occId}:a:0`);
    const r = await click(`mn:it:${occId}:a:0`);
    expect(r.data.content).toContain("уже закрыто");
  });
});

describe("меню: добавление", () => {
  it("окно из меню и из панели — разные метки", async () => {
    expect((await click("mn:add")).data.custom_id).toBe("m_add:mn");
    expect((await click("pn:add")).data.custom_id).toBe("m_add:pn");
  });

  it("«что + когда»: дело записано, ответ — обновление с навигацией", async () => {
    const r = await submit("m_add:mn", { what: "купить хлеб", when: "завтра в 10:00", repeat: ["none"] });
    expect(r.type).toBe(7);
    expect(r.data.content).toContain("Записано");
    expect(ids(r)).toContain("mn:home");
    expect((await w.repo().openMain(10)).map((o) => o.title)).toEqual(["Купить хлеб"]);
  });

  it("из панели ответ — новое сообщение «только вам»", async () => {
    const r = await submit("m_add:pn", { what: "купить хлеб", when: "завтра в 10:00", repeat: [] });
    expect(r.type).toBe(4);
    expect(r.data.flags).toBe(64);
  });

  it("без времени: черновик с вопросом «когда напомнить»", async () => {
    const r = await submit("m_add:mn", { what: "подумать про отпуск", when: "", repeat: [] });
    expect(r.data.content).toContain("когда напомнить");
    expect((await w.repo().openMain(10))[0].state).toBe("draft");
  });

  it("повтор: «каждый день» + время — повторяющееся дело", async () => {
    for (const rep of ["day", "wd", "wk", "mo"]) {
      const r = await submit("m_add:mn", { what: `дело ${rep}`, when: "в 9:00", repeat: [rep] });
      expect(r.data.content, rep).toContain("Записано");
    }
    expect((await w.repo().openMain(10)).filter((o) => o.rule_recipe).length).toBe(4);
  });

  it("пустое «что» и секрет не записываются", async () => {
    const e = await submit("m_add:mn", { what: " ", when: "", repeat: [] });
    expect(e.data.content).toContain("Напишите");
    expect((await w.repo().openMain(10)).length).toBe(0);
  });
});

describe("меню: неделя, свет, настроение", () => {
  it("неделя и настроение отвечают экраном с навигацией", async () => {
    await w.create("завтра в 10 хлеб");
    const wk = await click("mn:wk");
    expect(wk.type).toBe(7);
    expect(ids(wk)).toContain("mn:home");
    const mo = await click("mn:mo");
    expect(mo.type).toBe(7);
    expect(mo.data.embeds).toHaveLength(1);
  });

  it("свет без группы: подсказка; с группой — ожидание и правка сообщения", async () => {
    const none = await click("mn:lt");
    expect(none.data.content).toContain("Группа света не задана");
    await w.repo().exec([(await import("../src/db/repo.ts")).setSetting("light", "3")]);
    const sent: any[] = [];
    const api = Object.assign(Object.create(w.discord), { editInteractionOriginal: async (_a: string, _t: string, b: unknown) => void sent.push(b) });
    const defer: Promise<unknown>[] = [];
    const fetchFn = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const mk = (custom_id: string) =>
      handleInteraction(
        { id: "9", token: "t", application_id: "a", channel_id: "c", member: { user: { id: OWNER } }, type: 3, data: { custom_id }, message: { id: "m" } } as unknown as Interaction,
        { repo: w.repo(), api, now: NOW, env: {}, defer: (p) => void defer.push(p), fetchFn },
      ) as Promise<R>;
    const inMsg = await mk("mn:lt");
    expect(inMsg.type).toBe(6);
    await Promise.all(defer.splice(0));
    expect(sent.at(-1).content).toContain("Yasno не отвечает");
    expect(JSON.stringify(sent.at(-1).components)).toContain("mn:home");
    const inPanel = await mk("pn:lt");
    expect(inPanel).toEqual({ type: 5, data: { flags: 64 } });
    await Promise.all(defer.splice(0));
    expect(sent).toHaveLength(2);
  });
});

describe("меню: настройки по разделам", () => {
  it("главный экран настроек и разделы", async () => {
    const st = await click("mn:st");
    expect(ids(st)).toEqual(expect.arrayContaining(["mn:s:q", "mn:s:m", "mn:s:l", "mn:s:c", "mn:s:a"]));
    for (const sec of ["q", "m", "l", "c", "a"]) {
      const r = await click(`mn:s:${sec}`);
      expect(r.type, sec).toBe(7);
      expect(ids(r), sec).toContain("mn:st");
    }
  });

  it("переключатели меняют настройку и остаются в своём разделе", async () => {
    const q0 = (await w.settings()).quietEnabled;
    const r = await click("mn:tg:q:q");
    expect((await w.settings()).quietEnabled).toBe(!q0);
    expect(r.data.content).toContain("Тишина");
    const ch = await click("mn:tg:ch:c");
    expect((await w.settings()).character).toBe("maid");
    expect(ch.data.content).toContain("Характер");
    await click("mn:tg:mo:c");
    expect((await w.settings()).moodOn).toBe(true);
    await click("mn:tg:llm:a");
    expect((await w.settings()).llmOn).toBe(true);
  });

  it("личка: включается и выключается, создаётся канал", async () => {
    const on = await click("mn:tg:dm:a");
    expect(on.data.content).toContain("Личка: вкл");
    expect((await w.settings()).intake).toContain(`dm-${OWNER}`);
    const off = await click("mn:tg:dm:a");
    expect(off.data.content).toContain("Личка: выкл");
    expect((await w.settings()).intake).not.toContain(`dm-${OWNER}`);
  });

  it("настойчивость: выбор из списка", async () => {
    const r = await click("mn:ld", ["strong"]);
    expect(r.type).toBe(7);
    expect((await w.settings()).defaultLadder).toEqual({ preset: "strong" });
  });

  it("окна из настроек: возвращают экран своего раздела", async () => {
    const m = await click("mn:md:qt:q");
    expect(m.type).toBe(9);
    expect(m.data.custom_id).toBe("m_quiet:mn:q");
    const r = await submit("m_quiet:mn:q", { from: "22:30", to: "07:00" });
    expect(r.type).toBe(7);
    expect(r.data.content).toContain("22:30");
    expect(ids(r)).toContain("mn:st");
    const l = await submit("m_light:mn:m", { group: "3" });
    expect(l.data.content).toContain("группа 3");
    const a = await submit("m_away:mn:q", { days: "2" });
    expect(a.data.content).toContain("отъезд");
    const n = await submit("m_ladn:mn:l", { nums: "0 5 10" });
    expect(n.data.content).toContain("Как часто напоминать");
    // окно без раздела (из /settings) возвращает главный экран настроек
    const old = await submit("m_quiet", { from: "23:00", to: "06:00" });
    expect(old.data.content).toContain("Настройки");
  });

  it("плохой ввод в окне: понятная ошибка, настройка не меняется", async () => {
    const r = await submit("m_quiet:mn:q", { from: "ночью", to: "07:00" });
    expect(r.data.content).toContain("ЧЧ:ММ");
  });
});

describe("команда /menu panel", () => {
  const panel = () => call({ type: 2, data: { name: "menu", type: 1, options: [{ name: "panel", value: true }] } });

  it("описана в списке команд", () => {
    expect(COMMANDS.find((c) => c.name === "menu")).toBeTruthy();
  });

  it("без канала «бот»: подсказка про /setup", async () => {
    w = new World();
    await w.seed();
    const r = await panel();
    expect(r.data.content).toContain("/setup");
  });

  it("первый раз — пост и закрепление; второй — правка того же сообщения", async () => {
    const r = await panel();
    expect(r.data.content).toContain("закреплена");
    expect(w.discord.posted).toHaveLength(1);
    expect(w.discord.posted[0].channel).toBe(CH_BOT);
    expect(JSON.stringify(w.discord.posted[0].body.components)).toContain("pn:add");
    expect(w.discord.pins).toEqual([{ channel: CH_BOT, id: w.discord.posted[0].id }]);
    const r2 = await panel();
    expect(r2.data.content).toContain("обновлена");
    expect(w.discord.posted).toHaveLength(1);
    expect(w.discord.edits).toHaveLength(1);
  });

  it("панель удалили руками — ставится новая", async () => {
    await panel();
    w.discord.posted.length = 0; // как будто сообщения больше нет (правка вернёт 404)
    const r = await panel();
    expect(r.data.content).toContain("закреплена");
    expect(w.discord.posted).toHaveLength(1);
  });

  it("закрепить не вышло: пост остаётся, пользователю подсказка", async () => {
    w.discord.pinMessage = async () => {
      throw new Error("403");
    };
    const r = await panel();
    expect(r.data.content).toContain("Закрепить не вышло");
    expect(w.discord.posted).toHaveLength(1);
  });
});
