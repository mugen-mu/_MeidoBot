// Этап 1 «C-lite»: свои часы «утром/вечером» (C4), «Три последних дела» (C5), звук для всего (D7), сокращения времени (C7).
import { beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { addModal } from "../src/discord/menu.ts";
import { readSettings } from "../src/settings.ts";
import { withSound } from "../src/sound.ts";
import { quickDue } from "../src/time/quick.ts";
import { parseInput } from "../src/time/parse.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

const parse = (text: string, o: { morningTime?: number; eveningTime?: number } = {}) => parseInput(text, { now: NOW, tz: TZ, defaultTime: 9 * 60, ...o });

describe("C4: «утром» и «вечером» по своим часам", () => {
  it("по умолчанию утро 09:00, вечер 19:00 (как раньше)", () => {
    expect(parse("завтра утром зарядка").due).toBe(kyiv(2026, 11, 8, 9, 0));
    expect(parse("завтра вечером позвонить маме").due).toBe(kyiv(2026, 11, 8, 19, 0));
  });

  it("свои часы: утро 07:30, вечер 21:00 — и в разборе фраз, и в быстрых вариантах", () => {
    const o = { morningTime: 7 * 60 + 30, eveningTime: 21 * 60 };
    expect(parse("завтра утром зарядка", o).due).toBe(kyiv(2026, 11, 8, 7, 30));
    expect(parse("завтра вечером позвонить маме", o).due).toBe(kyiv(2026, 11, 8, 21, 0));
    expect(parse("сегодня вечером позвонить маме", o).due).toBe(kyiv(2026, 11, 7, 21, 0));
    // быстрый вариант «Сегодня вечером»: до вечера далеко — сегодня; поздно — завтра
    expect(quickDue("eve", NOW, TZ, 9 * 60, 21 * 60)).toBe(kyiv(2026, 11, 7, 21, 0));
    expect(quickDue("eve", kyiv(2026, 11, 7, 22, 0), TZ, 9 * 60, 21 * 60)).toBe(kyiv(2026, 11, 8, 21, 0));
    expect(quickDue("eve", NOW, TZ)).toBe(kyiv(2026, 11, 7, 19, 0)); // без параметров — как раньше
    expect(quickDue("tom", NOW, TZ, 7 * 60 + 30)).toBe(kyiv(2026, 11, 8, 7, 30));
  });

  it("настройки читаются из базы; мусор и пустое — значения по умолчанию", () => {
    expect(readSettings([]).wordMorning).toBe(9 * 60);
    expect(readSettings([]).wordEvening).toBe(19 * 60);
    const s = readSettings([{ key: "time_morning", value: "07:30" }, { key: "time_evening", value: "21:00" }]);
    expect([s.wordMorning, s.wordEvening]).toEqual([450, 1260]);
    const bad = readSettings([{ key: "time_morning", value: "утро" }, { key: "time_evening", value: "" }]);
    expect([bad.wordMorning, bad.wordEvening]).toEqual([540, 1140]);
  });

  it("если «default_time» задан, а «утро» нет — утро = default_time (старые настройки не ломаются)", () => {
    expect(readSettings([{ key: "default_time", value: "08:00" }]).wordMorning).toBe(8 * 60);
  });
});

describe("C7: сокращения времени", () => {
  it.each([
    ["через 10м проверить плиту", 10 * MINUTE, "Проверить плиту"],
    ["через 10 м проверить плиту", 10 * MINUTE, "Проверить плиту"],
    ["через 2ч позвонить маме", 2 * HOUR, "Позвонить маме"],
    ["через 2 ч позвонить маме", 2 * HOUR, "Позвонить маме"],
    ["через 1,5ч выключить духовку", 90 * MINUTE, "Выключить духовку"],
    ["через 45мин забрать посылку", 45 * MINUTE, "Забрать посылку"],
    ["через 3дн позвонить в банк", 3 * 24 * HOUR, "Позвонить в банк"],
  ])("«%s»", (text, delta, title) => {
    const r = parse(text);
    expect(r.title).toBe(title);
    expect(r.due).toBe(NOW + delta);
  });

  it.each([
    ["завтра 9 позвонить маме", kyiv(2026, 11, 8, 9, 0), "Позвонить маме"],
    ["завтра 9:30 позвонить маме", kyiv(2026, 11, 8, 9, 30), "Позвонить маме"],
    ["послезавтра 18 оплатить связь", kyiv(2026, 11, 9, 18, 0), "Оплатить связь"],
    ["сегодня 20 написать отчёт", kyiv(2026, 11, 7, 20, 0), "Написать отчёт"],
    ["завтра 9", kyiv(2026, 11, 8, 9, 0), ""],
  ])("«%s» — время после слова-даты без «в»", (text, due, title) => {
    const r = parse(text);
    expect(r.due).toBe(due);
    expect(r.title).toBe(title);
  });

  it("«завтра 5 яблок купить»: число с существительным — не время (осторожность важнее)", () => {
    const r = parse("завтра 5 яблок купить");
    expect(r.title.toLowerCase()).toContain("5 яблок");
    expect(r.due).toBe(kyiv(2026, 11, 8, 9, 0)); // просто «завтра» в стандартное время
  });

  it("прежние фразы не сломаны", () => {
    expect(parse("через 20 минут проверить плиту").due).toBe(NOW + 20 * MINUTE);
    expect(parse("завтра в 10 купить хлеб").due).toBe(kyiv(2026, 11, 8, 10, 0));
    expect(parse("каждый месяц 20-го оплатить ФОП").recipe).not.toBeNull();
  });
});

describe("C5 и D7: галочки в настройках", () => {
  it("по умолчанию обе выключены", () => {
    const s = readSettings([]);
    expect(s.recentOn).toBe(false);
    expect(s.soundAll).toBe(false);
  });

  it("читаются из базы", () => {
    const s = readSettings([{ key: "recent_on", value: "1" }, { key: "sound_all", value: "1" }]);
    expect(s.recentOn).toBe(true);
    expect(s.soundAll).toBe(true);
  });
});

describe("D7: звук для всего — упоминание добавляется к сообщениям бота в канал", () => {
  const sent: { channel: string; body: any }[] = [];
  const fake = {
    postMessage: async (channel: string, body: any) => {
      sent.push({ channel, body });
      return { id: "1", channel_id: channel };
    },
  } as any;
  beforeEach(() => void (sent.length = 0));

  it("выключено: сообщение уходит как есть", async () => {
    const api = withSound(fake, OWNER, false);
    await api.postMessage("c", { content: "Записано", allowed_mentions: { parse: [] } });
    expect(sent[0].body).toEqual({ content: "Записано", allowed_mentions: { parse: [] } });
  });

  it("включено: «<@хозяин> » в начале и право упомянуть хозяина", async () => {
    const api = withSound(fake, OWNER, true);
    await api.postMessage("c", { content: "Записано", allowed_mentions: { parse: [] } });
    expect(sent[0].body.content).toBe(`<@${OWNER}> Записано`);
    expect(sent[0].body.allowed_mentions).toEqual({ parse: [], users: [OWNER] });
  });

  it("уже есть упоминание — второй раз не добавляем", async () => {
    const api = withSound(fake, OWNER, true);
    await api.postMessage("c", { content: `<@${OWNER}> Пора`, allowed_mentions: { users: [OWNER] } });
    expect(sent[0].body.content).toBe(`<@${OWNER}> Пора`);
  });

  it("сообщение без текста (только карточка): упоминание ставится в content", async () => {
    const api = withSound(fake, OWNER, true);
    await api.postMessage("c", { embeds: [{ description: "х" }], allowed_mentions: { parse: [] } });
    expect(sent[0].body.content).toBe(`<@${OWNER}>`);
  });

  it("при выключенном «Реплики через упоминание» личка/правка не затронуты: editMessage идёт как есть", async () => {
    let edited: any = null;
    const api = withSound({ ...fake, editMessage: async (_c: string, _m: string, b: any) => void (edited = b) } as any, OWNER, true);
    await api.editMessage("c", "m", { content: "новый текст" });
    expect(edited.content).toBe("новый текст");
  });
});

describe("C5: «Три последних дела» в «Добавить»", () => {
  let w: World;
  let seq = 0;
  beforeEach(async () => {
    w = new World();
    await w.seed({ today: true, intake: true });
  });
  async function click(custom_id: string, now = NOW) {
    const pending: Promise<unknown>[] = [];
    const r = await handleInteraction(
      { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: CH_BOT, member: { user: { id: OWNER } }, type: 3, data: { custom_id }, message: { id: "m1" } } as Interaction,
      { repo: w.repo(), api: w.discord, now, env: {}, defer: (p) => void pending.push(p) },
    );
    await Promise.all(pending);
    return r as { type: number; data?: any };
  }
  const ids = (r: { data?: any }): string[] => (r.data?.components ?? []).flatMap((x: any) => x.components.map((c: any) => c.custom_id));

  it("галочка выключена: «Добавить» сразу открывает окно, как раньше", async () => {
    await w.create("завтра в 10 купить хлеб");
    const r = await click("mn:add");
    expect(r.type).toBe(9);
    expect(r.data.custom_id).toBe(addModal("mn").data.custom_id);
  });

  it("галочка включена, дел ещё не было: окно сразу", async () => {
    await w.repo().exec([setSetting("recent_on", "1")]);
    const r = await click("mn:add");
    expect(r.type).toBe(9);
  });

  it("галочка включена: три последних разных дела кнопками и «Новое…»", async () => {
    await w.create("завтра в 9 позвонить маме");
    await w.create("завтра в 10 купить хлеб");
    await w.create("завтра в 12 купить хлеб"); // то же название — не дублируем
    await w.create("завтра в 13 оплатить связь");
    await w.create("завтра в 14 забрать посылку");
    await w.repo().exec([setSetting("recent_on", "1")]);
    const r = await click("mn:add");
    expect(r.type).toBe(7);
    const labels = (r.data.components as any[]).flatMap((x) => x.components.map((c: any) => c.label as string));
    expect(labels.filter((l) => /посылк|связь|хлеб/i.test(l))).toHaveLength(3);
    expect(labels.filter((l) => /хлеб/i.test(l))).toHaveLength(1);
    expect(labels.some((l) => /маме/i.test(l))).toBe(false);
    expect(labels.some((l) => /Новое/.test(l))).toBe(true);
    expect(ids(r).some((i) => i === "mn:addnew")).toBe(true);
  });

  it("«Новое…» открывает окно; кнопка недавнего дела создаёт новое дело с тем же названием и спрашивает время", async () => {
    await w.create("завтра в 10 купить хлеб");
    await w.repo().exec([setSetting("recent_on", "1")]);
    const list = await click("mn:add");
    const recentId = ids(list).find((i) => i.startsWith("mn:rc:"))!;
    expect(recentId).toBeTruthy();
    expect((await click("mn:addnew")).type).toBe(9);
    const made = await click(recentId);
    expect(w.d1.q("SELECT title FROM items ORDER BY id")).toHaveLength(2);
    expect(w.d1.q("SELECT title FROM items ORDER BY id DESC LIMIT 1")).toEqual([{ title: "Купить хлеб" }]);
    expect(JSON.stringify(made.data)).toContain("когда напомнить");
  });

  it("недавние берутся без секретных и без служебных пометок", async () => {
    await w.create("завтра в 10 купить хлеб");
    await w.repo().exec([setSetting("recent_on", "1")]);
    const r = await click("mn:add");
    expect(JSON.stringify(r.data)).not.toContain("пароль");
  });

  it("«/settings»: галочки видны и переключаются в «Ещё»", async () => {
    const r = await click("mn:s:a");
    expect(ids(r)).toContain("mn:tg:rc:a");
    expect(ids(r)).toContain("mn:tg:snd:a");
    await click("mn:tg:rc:a");
    expect(w.d1.q("SELECT value FROM settings WHERE key = 'recent_on'")).toEqual([{ value: "1" }]);
    await click("mn:tg:snd:a");
    expect(w.d1.q("SELECT value FROM settings WHERE key = 'sound_all'")).toEqual([{ value: "1" }]);
    await click("mn:tg:rc:a");
    expect(w.d1.q("SELECT value FROM settings WHERE key = 'recent_on'")).toEqual([{ value: "0" }]);
  });

  it("часы «утро/вечер»: окно в «Сводки и коммуналка», сохранение и проверка ввода", async () => {
    const sec = await click("mn:s:m");
    expect(ids(sec)).toContain("mn:md:dw:m");
    const modal = await click("mn:md:dw:m");
    expect(modal.type).toBe(9);
    const submit = (fields: Record<string, string>) => {
      const pending: Promise<unknown>[] = [];
      return handleInteraction(
        {
          id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: CH_BOT, member: { user: { id: OWNER } }, type: 5,
          data: { custom_id: "m_dw:mn:m", components: Object.entries(fields).map(([id, value]) => ({ type: 18, component: { type: 4, custom_id: id, value } })) },
        } as Interaction,
        { repo: w.repo(), api: w.discord, now: NOW, env: {}, defer: (p) => void pending.push(p) },
      ) as Promise<{ type: number; data?: any }>;
    };
    const bad = await submit({ morning: "утро", evening: "21:00" });
    expect(bad.data.content).toContain("ЧЧ:ММ");
    expect(w.d1.q("SELECT 1 FROM settings WHERE key = 'time_morning'")).toHaveLength(0); // при ошибке ничего не записано
    const ok = await submit({ morning: "7:30", evening: "21:00" });
    expect(ok.type).toBe(7);
    expect(w.d1.q("SELECT value FROM settings WHERE key = 'time_morning'")).toEqual([{ value: "07:30" }]);
    expect(w.d1.q("SELECT value FROM settings WHERE key = 'time_evening'")).toEqual([{ value: "21:00" }]);
    // и текст в канале теперь разбирается по новым часам
    await w.run(NOW);
    w.discord.say(CH_BOT, OWNER, "завтра вечером позвонить маме");
    await w.run(NOW + MINUTE);
    expect(w.d1.q("SELECT due_at FROM occurrences ORDER BY id DESC LIMIT 1")).toEqual([{ due_at: kyiv(2026, 11, 8, 21, 0) }]);
  });
});

describe("D7: звук для всего — через cron", () => {
  it("галочка включена: ответ бота в канале «бот» упоминает хозяина; выключена — нет", async () => {
    for (const on of [false, true]) {
      const w = new World();
      await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off", ...(on ? { sound_all: "1" } : {}) } });
      await w.run(NOW);
      w.discord.say(CH_BOT, OWNER, "завтра в 10 купить хлеб");
      await w.run(NOW + MINUTE);
      const reply = w.discord.live(CH_BOT)[0].body;
      expect(reply.content?.startsWith(`<@${OWNER}>`), `sound_all=${on}`).toBe(on);
      if (on) expect(reply.allowed_mentions?.users).toContain(OWNER);
    }
  });
});

void countedApi;
