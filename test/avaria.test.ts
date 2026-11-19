// Канал аварийной службы Днепра вместо Укрэнерго: что за пост (свет, вода), выдержка, первое чтение, упоминания, cron и строка в сообщении «света нет».
import { beforeEach, describe, expect, it } from "vitest";
import {
  AVARIA_FRESH_FOR_OUTAGE,
  AVARIA_MAX_AGE,
  AVARIA_PING_GAP,
  type AvariaCfg,
  avariaAnnounceLine,
  avariaOn,
  coveredByVodokanal,
  groupTokens,
  isWaterPost,
  lightExcerpt,
  lightHit,
  lightMessage,
  parseAvariaLast,
  parseAvariaState,
  planAvaria,
  waterHit,
} from "../src/avaria.ts";
import { setMeta } from "../src/db/repo.ts";
import { applySignal, readPower } from "../src/power.ts";
import { parsePassport, statusText } from "../src/sources.ts";
import { parseTgChannel } from "../src/tgChannel.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import type { WaterAlert } from "../src/water.ts";
import * as F from "./avariaFixtures.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const TZ = "Europe/Kyiv";
const NOW = kyiv(2026, 11, 19, 12, 0);
const pageOf = (...p: [number, number, string | null][]) => F.avariaPage(p.map(([id, at, html]) => ({ id, at, html })));
const posts = (...p: [number, number, string | null][]) => parseTgChannel(pageOf(...p));
const textOf = (html: string): string => posts([1, NOW, html])[0].text;
const CFG: AvariaCfg = { group: "3", words: [], tz: TZ, waterAlerts: [] };
const kind = (html: string, group: string | null = "3") => lightHit(textOf(html), groupTokens(group))?.kind ?? null;

describe("канал аварийной службы: страница и очередь хозяина", () => {
  it("посты с текстом: номер, время, ссылка; пост-картинка пропущен; «&quot;» раскодирован", () => {
    const p = posts([27820, NOW - 2 * HOUR, F.EMERGENCY_CANCEL], [27821, NOW - HOUR, null], [27822, NOW, F.HEADS_UP]);
    expect(p.map((x) => x.id)).toEqual([27820, 27822]);
    expect(p[0]).toMatchObject({ channel: "avariykaaa", at: NOW - 2 * HOUR, link: "https://t.me/avariykaaa/27820" });
    expect(p[0].text).toContain('"Укренерго"');
    expect(p[0].text.endsWith("https://t.me/avariykaaa")).toBe(true);
  });

  it("очередь: «3» — это 3.1 и 3.2, «3.1» — одна; мусор — пусто (тогда только общегородское)", () => {
    expect(groupTokens("3")).toEqual(["3.1", "3.2"]);
    expect(groupTokens(" 3.1 ")).toEqual(["3.1"]);
    expect(groupTokens("6,2")).toEqual(["6.2"]);
    for (const bad of ["", "7", "3.3", "дом", "31", null]) expect(groupTokens(bad)).toEqual([]);
  });

  it("источник нужен, пока включён свет или вода", () => {
    expect(avariaOn({ lightGroup: "3", waterWords: [] })).toBe(true);
    expect(avariaOn({ lightGroup: null, waterWords: ["центральн"] })).toBe(true);
    expect(avariaOn({ lightGroup: null, waterWords: [] })).toBe(false);
  });
});

describe("канал аварийной службы: что за пост про свет (очередь 3)", () => {
  it.each([
    ["экстренные в Днепре (приказ НЕК)", F.EMERGENCY_CITY, "emergency"],
    ["отмена экстренных (ЦЕК)", F.EMERGENCY_CANCEL, "emergency_cancel"],
    ["отмена экстренных и графики списком", F.EMERGENCY_CANCEL_WITH_LIST, "emergency_cancel"],
    ["ДТЕК отменил графики для всех групп", F.ALL_CANCELLED, "schedule_cancel"],
    ["графики отменены для 3.1, 3.2 и 5.x", F.GROUPS_CANCELLED, "schedule_cancel"],
    ["изменения на сегодня, моя строка есть", F.CHANGE_TODAY, "change"],
    ["актуальный график без третьей группы", F.ACTUAL_WITHOUT_3, null],
    ["отключаются очереди — моей нет", F.QUEUES_OFF, null],
    ["отключаются очереди — моя в списке", F.QUEUES_OFF_WITH_3, "queues_off"],
    ["скоро отключения по группам", F.HEADS_UP, "heads_up"],
    ["аварийные работы на линии 3.1", F.GROUP_WORKS_3_1, "group_works"],
    ["восстановление группы 3.2", F.GROUP_RESTORE_3_2, "restore"],
    ["экстренные по адресам в Днепре, моя очередь", F.GROUP_EMERGENCY_3_1, "group_emergency"],
    ["то же, чужая очередь 5.1", F.GROUP_EMERGENCY_5_1, null],
    ["моя очередь, но список — сёла Павлоградского района", F.GROUP_WORKS_VILLAGES_3_1, null],
    ["экстренные в сёлах без Днепра", F.EMERGENCY_VILLAGES, null],
    ["Днепр, но список улиц", F.EMERGENCY_STREETS, null],
    ["очередь 4.1, Каменское и сёла", F.GROUP_EMERGENCY_4_1_VILLAGES, null],
    ["график на завтра — дело Yasno", F.TOMORROW_SCHEDULE, null],
    ["строки чужой очереди 2.1 и 2.2", F.OTHER_GROUP_LINE, null],
    ["новости про удары", F.NEWS_STRIKES, null],
    ["ситуация «остаётся сложной»", F.NEWS_SITUATION, null],
    ["вброс про отключение связи", F.SCARE, null],
    ["сбор денег", F.DONATION, null],
    ["погода", F.WEATHER, null],
  ])("%s", (_what, html, want) => {
    expect(kind(html)).toBe(want);
  });

  it("очередь 5: свои экстренные по адресам, «отключаются очереди» и строка в изменениях", () => {
    expect(kind(F.GROUP_EMERGENCY_5_1, "5")).toBe("group_emergency");
    expect(kind(F.QUEUES_OFF, "5")).toBe("queues_off");
    expect(kind(F.CHANGE_TODAY, "5")).toBe("change");
    expect(kind(F.GROUP_EMERGENCY_3_1, "5")).toBeNull();
  });

  it("очередь «3.1» не берёт строки только про 3.2", () => {
    expect(kind(F.GROUP_RESTORE_3_2, "3.1")).toBeNull();
    expect(kind(F.GROUP_WORKS_3_1, "3.1")).toBe("group_works");
    expect(kind(F.CHANGE_TODAY, "3.2")).toBe("change");
  });

  it("очередь в настройке не разобралась — только общегородское", () => {
    expect(kind(F.EMERGENCY_CITY, "дом")).toBe("emergency");
    expect(kind(F.EMERGENCY_CANCEL, "дом")).toBe("emergency_cancel");
    expect(kind(F.ALL_CANCELLED, "дом")).toBe("schedule_cancel");
    expect(kind(F.HEADS_UP, "дом")).toBe("heads_up");
    expect(kind(F.CHANGE_TODAY, "дом")).toBeNull();
    expect(kind(F.GROUPS_CANCELLED, "дом")).toBeNull();
    expect(kind(F.GROUP_WORKS_3_1, "дом")).toBeNull();
  });
});

describe("канал аварийной службы: выдержка и сообщение", () => {
  const msg = (html: string, id = 27823, at = NOW - 10 * MINUTE, group = "3"): string => {
    const p = posts([id, at, html])[0];
    const hit = lightHit(p.text, groupTokens(group));
    if (!hit) throw new Error("пост не подошёл");
    return lightMessage(p, hit, group, NOW, TZ);
  };

  it("изменения на сегодня: только строка очереди хозяина, без чужих очередей, значков и ссылки на канал; оператор в заголовке", () => {
    const m = msg(F.CHANGE_TODAY);
    expect(m.split("\n")).toEqual([
      "⚡ **Свет · сегодня 11:50 · график на сегодня изменился (очередь 3) · ЦЕК**",
      "> Черги 3.1 та 3.2 — 12:30–19:30",
      "<https://t.me/avariykaaa/27823>",
    ]);
  });

  it("отмена экстренных: шапка про отмену без номеров очередей и, если в посте есть графики, строка хозяина", () => {
    const m = msg(F.EMERGENCY_CANCEL_WITH_LIST, 27778);
    expect(m).toContain("экстренные отключения отменены");
    expect(m).toContain("> Екстрені відключення скасовані. Діють графіки погодинних відключень.");
    expect(m).toContain("> Групи 3.1 та 3.2 — 05:00–09:00, 15:30–19:30.");
    expect(m).not.toContain("Групи 1.1");
    expect(m).not.toContain("Група 4.1");
    const plain = msg(F.EMERGENCY_CANCEL, 27820);
    expect(plain).toContain("Повертаємося до ГРАФІКІВ ПОГОДИННИХ ВІДКЛЮЧЕНЬ‼️");
    expect(plain).toContain("· ЦЕК**");
  });

  it("экстренные по адресам: заголовок поста и строки про экстренные; длинное режется", () => {
    const m = msg(F.GROUP_EMERGENCY_3_1, 27812);
    expect(m).toContain("экстренные отключения у вашей очереди");
    expect(m).toContain("> По лінії групи ДТЕК 3.1 — м. Дніпро:");
    expect(m).toContain("екстрені відключення без застосування графіків");
    expect(m).toContain("· ДТЕК**");
    const p = posts([1, NOW, F.GROUP_EMERGENCY_3_1 + "<br/>" + "вул. Довга, 1, 2, 3, 4, 5, 6, 7, 8, 9; ".repeat(30)])[0];
    const hit = lightHit(p.text, groupTokens("3"));
    expect(lightExcerpt(p.text, hit!).length).toBeLessThanOrEqual(451);
  });

  it("общегородское без оператора и без очереди в заголовке", () => {
    expect(msg(F.EMERGENCY_CITY, 27808).split("\n")[0]).toBe("⚡ **Свет · сегодня 11:50 · экстренные отключения**");
    expect(msg(F.HEADS_UP, 27822).split("\n")[0]).toBe("⚡ **Свет · сегодня 11:50 · скоро отключения по группам**");
  });
});

describe("канал аварийной службы: вода", () => {
  const w = (html: string, words: string[]) => waterHit(posts([27784, NOW, html])[0], words);

  it("пост про воду узнаётся по капле или по словам про водопостачання; свет — нет", () => {
    expect(isWaterPost(textOf(F.WATER_CENTRAL))).toBe(true);
    expect(isWaterPost(textOf(F.WATER_LOW_PRESSURE))).toBe(true);
    expect(isWaterPost(textOf(F.WATER_DROP_NO_WORD))).toBe(true);
    expect(isWaterPost(textOf(F.EMERGENCY_CITY))).toBe(false);
    expect(isWaterPost(textOf(F.CHANGE_TODAY))).toBe(false);
  });

  it("слова места: улица названа — street; только район — district/maybe; чужой район — нет; слов нет — нет", () => {
    expect(w(F.WATER_CENTRAL, ["центральн", "княгині ольги"])?.match.hit).toBe("street");
    expect(w(F.WATER_CENTRAL, ["центральн"])?.match.hit).toBe("district");
    expect(w(F.WATER_CENTRAL_OTHER_STREET, ["центральн", "княгині ольги"])?.match.hit).toBe("maybe");
    expect(w(F.WATER_SOBORNYI, ["центральн", "княгині ольги"])).toBeNull();
    expect(w(F.WATER_OTHER_DISTRICT, ["центральн"])).toBeNull();
    expect(w(F.WATER_CENTRAL, [])).toBeNull();
  });

  it("район стоит в заголовке, а не в предложении про отключение — всё равно находится; улица «Центральна» районом не считается", () => {
    expect(w(F.WATER_SOBORNYI, ["соборн"])?.match.districts).toEqual({ Соборний: "off" });
    const street = br("💧Тимчасово припинено водопостачання по вул. Центральна, 5.");
    expect(w(street, ["центральн"])).toBeNull();
  });

  it("уровень берётся из текста: «припинено» — воды не будет, «знижено тиск» — давление снизится; капля вместо слова «вода» тоже читается", () => {
    expect(w(F.WATER_LOW_PRESSURE, ["слобожанськ"])?.match.level).toBe("low");
    expect(w(F.WATER_DROP_NO_WORD, ["слобожанськ"])?.match.level).toBe("low");
    expect(w(F.WATER_CENTRAL, ["княгині ольги"])?.match.level).toBe("off");
  });

  it("вернулась вода — отдельный вид", () => {
    expect(w(F.WATER_RESTORED, ["княгині ольги"])?.kind).toBe("restored");
  });

  it("водоканал уже предупредил про этот район за последние часы: «район совпал» не повторяем, названная улица — повторяем", () => {
    const alert = { id: 1, born: NOW - HOUR, districts: ["Центральний"] } as unknown as WaterAlert;
    const old = { ...alert, born: NOW - 7 * HOUR } as WaterAlert;
    const maybe = w(F.WATER_CENTRAL_OTHER_STREET, ["центральн"])!;
    const street = w(F.WATER_CENTRAL, ["центральн", "княгині ольги"])!;
    expect(coveredByVodokanal(maybe, [alert], NOW)).toBe(true);
    expect(coveredByVodokanal(maybe, [old], NOW)).toBe(false);
    expect(coveredByVodokanal(maybe, [], NOW)).toBe(false);
    expect(coveredByVodokanal(street, [alert], NOW)).toBe(false);
  });
});

const br = (...l: string[]) => l.join("<br/>");

describe("канал аварийной службы: что делать с прочитанной лентой", () => {
  it("первое чтение молчит и запоминает номер; последний пост про свет (любой давности) запомнен для строки «света нет»", () => {
    const r = planAvaria(null, posts([27800, NOW - 30 * HOUR, F.EMERGENCY_CITY], [27801, NOW - HOUR, F.NEWS_STRIKES]), NOW, CFG, null);
    expect(r.notices).toEqual([]);
    expect(r.state).toEqual({ last: 27801 });
    expect(r.last).toMatchObject({ id: 27800, kind: "emergency", link: "https://t.me/avariykaaa/27800" });
  });

  it("новые подходящие — сообщения; экстренное с упоминанием, график и отмена тихо; чужое, старое и виденное молчит", () => {
    const state = { last: 27800 };
    const p = posts(
      [27799, NOW - MINUTE, F.EMERGENCY_CITY], // уже видели (номер не больше state.last)
      [27801, NOW - 14 * HOUR, F.HEADS_UP], // старше 12 часов
      [27802, NOW - 5 * MINUTE, F.NEWS_STRIKES],
      [27803, NOW - 4 * MINUTE, F.TOMORROW_SCHEDULE],
      [27804, NOW - 3 * MINUTE, F.EMERGENCY_CITY],
    );
    const r = planAvaria(state, p, NOW, CFG, null);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].mention).toBe(true);
    expect(r.notices[0].text).toContain("экстренные отключения");
    expect(r.notices[0].text).toContain("<https://t.me/avariykaaa/27804>");
    expect(r.state).toEqual({ last: 27804, ping: NOW });
    const quiet = planAvaria({ last: 27800 }, posts([27810, NOW - MINUTE, F.CHANGE_TODAY]), NOW, CFG, null);
    expect(quiet.notices).toHaveLength(1);
    expect(quiet.notices[0].mention).toBe(false);
    expect(quiet.state.ping).toBeUndefined();
  });

  it("срок: ровно 12 часов ещё идёт, дольше — нет", () => {
    expect(planAvaria({ last: 1 }, posts([2, NOW - AVARIA_MAX_AGE, F.EMERGENCY_CITY]), NOW, CFG, null).notices).toHaveLength(1);
    expect(planAvaria({ last: 1 }, posts([2, NOW - AVARIA_MAX_AGE - MINUTE, F.EMERGENCY_CITY]), NOW, CFG, null).notices).toHaveLength(0);
  });

  it("упоминание не чаще раза в час: второе «экстренное» в тот же час приходит тихо, через час — снова с упоминанием", () => {
    const a = planAvaria({ last: 10 }, posts([11, NOW - MINUTE, F.EMERGENCY_CITY]), NOW, CFG, null);
    expect(a.notices[0].mention).toBe(true);
    const b = planAvaria(a.state, posts([12, NOW + 20 * MINUTE, F.EMERGENCY_CITY]), NOW + 21 * MINUTE, CFG, null);
    expect(b.notices).toHaveLength(1);
    expect(b.notices[0].mention).toBe(false);
    expect(b.state.ping).toBe(NOW);
    const c = planAvaria(b.state, posts([13, NOW + AVARIA_PING_GAP + 5 * MINUTE, F.EMERGENCY_CITY]), NOW + AVARIA_PING_GAP + 6 * MINUTE, CFG, null);
    expect(c.notices[0].mention).toBe(true);
  });

  it("в одном запуске «отменены» вытесняет «экстренные»: сообщение одно, без упоминания", () => {
    const r = planAvaria({ last: 10 }, posts([11, NOW - 12 * MINUTE, F.EMERGENCY_CITY], [12, NOW - 2 * MINUTE, F.EMERGENCY_CANCEL]), NOW, CFG, null);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].text).toContain("экстренные отключения отменены");
    expect(r.notices[0].mention).toBe(false);
    expect(r.state.ping).toBeUndefined();
  });

  it("в «графике» строка про очередь хозяина важнее общего «скоро отключения», даже если общее новее", () => {
    const r = planAvaria({ last: 10 }, posts([11, NOW - 6 * MINUTE, F.QUEUES_OFF_WITH_3], [12, NOW - 2 * MINUTE, F.HEADS_UP]), NOW, CFG, null);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].text).toContain("отключаются очереди, среди них ваша");
    const generalOnly = planAvaria({ last: 10 }, posts([12, NOW - 2 * MINUTE, F.HEADS_UP]), NOW, CFG, null);
    expect(generalOnly.notices[0].text).toContain("скоро отключения по группам");
  });

  it("не больше двух сообщений за запуск: «статус» и вода идут раньше «графика»; порядок — по времени поста", () => {
    const cfg = { ...CFG, words: ["центральн", "княгині ольги"] };
    const r = planAvaria(
      { last: 10 },
      posts([11, NOW - 9 * MINUTE, F.CHANGE_TODAY], [12, NOW - 6 * MINUTE, F.WATER_CENTRAL], [13, NOW - 3 * MINUTE, F.EMERGENCY_CITY]),
      NOW,
      cfg,
      null,
    );
    expect(r.notices).toHaveLength(2);
    expect(r.notices[0].text).toContain("💧");
    expect(r.notices[1].text).toContain("экстренные отключения");
    expect(r.state.last).toBe(13);
  });

  it("свет выключен (группы нет) — про свет молчим, вода идёт; воды нет — наоборот", () => {
    const p = posts([11, NOW - 5 * MINUTE, F.EMERGENCY_CITY], [12, NOW - 4 * MINUTE, F.WATER_CENTRAL]);
    const onlyWater = planAvaria({ last: 10 }, p, NOW, { ...CFG, group: null, words: ["княгині ольги"] }, null);
    expect(onlyWater.notices).toHaveLength(1);
    expect(onlyWater.notices[0].text).toContain("💧 **Вода");
    expect(onlyWater.last).toBeNull();
    const onlyLight = planAvaria({ last: 10 }, p, NOW, CFG, null);
    expect(onlyLight.notices).toHaveLength(1);
    expect(onlyLight.notices[0].text).toContain("⚡ **Свет");
  });

  it("вода: сообщение в стиле water.ts, с упоминанием; вернулась — отдельное; чужой район молчит", () => {
    const cfg = { ...CFG, group: null, words: ["центральн", "княгині ольги"] };
    const r = planAvaria({ last: 10 }, posts([11, NOW - 5 * MINUTE, F.WATER_CENTRAL], [12, NOW - 4 * MINUTE, F.WATER_SOBORNYI], [13, NOW - 3 * MINUTE, F.WATER_RESTORED]), NOW, cfg, null);
    expect(r.notices).toHaveLength(2);
    expect(r.notices[0].mention).toBe(true);
    expect(r.notices[0].text.split("\n")[0]).toBe("💧 **Вода · сегодня 11:55 · воды не будет (Центральний)** Адрес из ваших слов назван в тексте.");
    expect(r.notices[0].text).toContain("> Центральний район!");
    expect(r.notices[0].text).toContain("<https://t.me/avariykaaa/11>");
    expect(r.notices[1].text.split("\n")[0]).toBe("💧 **Вода · сегодня 11:57 · вода вернулась (Центральний)**");
  });

  it("вода, которую водоканал только что объявил для этого района, из канала не повторяется", () => {
    const alert = { id: 1, born: NOW - HOUR, districts: ["Центральний"] } as unknown as WaterAlert;
    const cfg = { ...CFG, group: null, words: ["центральн"], waterAlerts: [alert] };
    expect(planAvaria({ last: 10 }, posts([11, NOW - MINUTE, F.WATER_CENTRAL_OTHER_STREET]), NOW, cfg, null).notices).toHaveLength(0);
    const withStreet = { ...cfg, words: ["центральн", "княгині ольги"] };
    expect(planAvaria({ last: 10 }, posts([11, NOW - MINUTE, F.WATER_CENTRAL]), NOW, withStreet, null).notices).toHaveLength(1);
  });

  it("последний пост про свет обновляется только вперёд", () => {
    const a = planAvaria({ last: 10 }, posts([11, NOW - HOUR, F.EMERGENCY_CITY]), NOW, CFG, null);
    const b = planAvaria(a.state, posts([5, NOW - 2 * HOUR, F.HEADS_UP]), NOW, CFG, a.last);
    expect(b.last?.id).toBe(11);
    const c = planAvaria(b.state, posts([12, NOW - 10 * MINUTE, F.GROUP_WORKS_3_1]), NOW, CFG, b.last);
    expect(c.last).toMatchObject({ id: 12, kind: "group_works" });
  });
});

describe("канал аварийной службы: строка в «Света нет» и разбор записей меты", () => {
  const last = (at: number) => JSON.stringify({ id: 5, at, kind: "emergency", text: "Діють екстрені відключення.", link: "https://t.me/avariykaaa/5" });

  it("свежий пост — строка со временем и ссылкой; старше 6 часов, из будущего и сломанное значение — нет", () => {
    expect(avariaAnnounceLine(last(NOW - 20 * MINUTE), NOW, TZ)).toBe("⚡ Аварийная служба, сегодня 11:40: «Діють екстрені відключення.» <https://t.me/avariykaaa/5>");
    expect(avariaAnnounceLine(last(NOW - AVARIA_FRESH_FOR_OUTAGE - MINUTE), NOW, TZ)).toBeNull();
    expect(avariaAnnounceLine(last(NOW + HOUR), NOW, TZ)).toBeNull();
    expect(avariaAnnounceLine("{не json", NOW, TZ)).toBeNull();
    expect(avariaAnnounceLine(undefined, NOW, TZ)).toBeNull();
  });

  it("запись о состоянии и последнем посте: сломанное — null", () => {
    expect(parseAvariaState('{"last":5,"ping":9}')).toEqual({ last: 5, ping: 9 });
    expect(parseAvariaState('{"last":5}')).toEqual({ last: 5 });
    expect(parseAvariaState("{}")).toBeNull();
    expect(parseAvariaState("мусор")).toBeNull();
    expect(parseAvariaLast("{}")).toBeNull();
    expect(parseAvariaLast(last(NOW))?.kind).toBe("emergency");
  });
});

describe("канал аварийной службы: cron", () => {
  let w: World;
  const base: Record<string, string> = { light: "3", summary_morning: "off", summary_evening: "off", weekly: "off" };
  beforeEach(async () => {
    w = new World();
    // `w.ukr` в test/world.ts — страница любого канала t.me/s/…, здесь это avariykaaa
    w.ukr = pageOf([27800, NOW - 3 * HOUR, F.NEWS_STRIKES]);
    await w.seed({ settings: base });
  });
  const posted = (needle: string) => w.discord.posted.filter((p) => p.body.content?.includes(needle));
  const meta = async () => (await w.repo().loadConfig()).meta;

  it("ни света, ни воды не включено — в сеть не ходим", async () => {
    await w.seed({ settings: { light: "off", water: "off" } });
    await w.run(NOW);
    expect(w.ukrFetches).toBe(0);
  });

  it("первое чтение молчит; чтение раз в 10 минут; новое экстренное — одно сообщение с упоминанием, повтора нет", async () => {
    await w.run(NOW);
    expect(w.ukrFetches).toBe(1);
    expect(posted("⚡ **Свет")).toHaveLength(0);
    await w.run(NOW + 5 * MINUTE);
    expect(w.ukrFetches).toBe(1);
    w.ukr = pageOf([27800, NOW - 3 * HOUR, F.NEWS_STRIKES], [27801, NOW + 8 * MINUTE, F.EMERGENCY_CITY]);
    await w.run(NOW + 10 * MINUTE);
    expect(w.ukrFetches).toBe(2);
    const m = posted("⚡ **Свет");
    expect(m).toHaveLength(1);
    expect(m[0].channel).toBe(CH_REMIND);
    expect(m[0].body.content).toContain(`<@${OWNER}>`);
    expect(m[0].body.content).toContain("экстренные отключения");
    expect(m[0].body.content).toContain("<https://t.me/avariykaaa/27801>");
    expect(m[0].body.allowed_mentions).toEqual({ users: [OWNER] });
    await w.run(NOW + 20 * MINUTE);
    await w.run(NOW + 30 * MINUTE);
    expect(w.ukrFetches).toBe(4);
    expect(posted("⚡ **Свет")).toHaveLength(1);
  });

  it("изменение графика на сегодня приходит тихо и только со строкой своей очереди", async () => {
    await w.run(NOW);
    w.ukr = pageOf([27800, NOW - 3 * HOUR, F.NEWS_STRIKES], [27801, NOW + 5 * MINUTE, F.CHANGE_TODAY]);
    await w.run(NOW + 10 * MINUTE);
    const m = posted("⚡ **Свет");
    expect(m).toHaveLength(1);
    expect(m[0].body.content).not.toContain(`<@${OWNER}>`);
    expect(m[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(m[0].body.content).toContain("> Черги 3.1 та 3.2 — 12:30–19:30");
    expect(m[0].body.content).not.toContain("Черги 4.1");
  });

  it("только вода включена (света нет): читаем, пересылаем воду по словам, световые посты молчат", async () => {
    await w.seed({ settings: { ...base, light: "off", water: "княгині ольги" } });
    await w.run(NOW);
    expect(w.ukrFetches).toBe(1);
    w.ukr = pageOf([27800, NOW - 3 * HOUR, F.NEWS_STRIKES], [27801, NOW + 4 * MINUTE, F.EMERGENCY_CITY], [27802, NOW + 5 * MINUTE, F.WATER_CENTRAL]);
    await w.run(NOW + 10 * MINUTE);
    expect(posted("⚡ **Свет")).toHaveLength(0);
    const m = posted("💧 **Вода");
    expect(m).toHaveLength(1);
    expect(m[0].body.content).toContain(`<@${OWNER}>`);
    expect(m[0].body.content).toContain("воды не будет");
  });

  it("Discord не принял сообщение — оно ждёт в очереди и уходит ровно один раз", async () => {
    await w.run(NOW);
    w.ukr = pageOf([27800, NOW - 3 * HOUR, F.NEWS_STRIKES], [27801, NOW + 5 * MINUTE, F.EMERGENCY_CITY]);
    w.discord.failPost = { status: 500, times: 1 };
    await w.run(NOW + 10 * MINUTE);
    expect(posted("⚡ **Свет")).toHaveLength(0);
    await w.run(NOW + 11 * MINUTE);
    expect(posted("⚡ **Свет")).toHaveLength(1);
    await w.run(NOW + 12 * MINUTE);
    expect(posted("⚡ **Свет")).toHaveLength(1);
  });

  it("лента не отвечает: в чат ничего, на экране «Состояние» — «не отвечает» после трёх неудач", async () => {
    w.ukr = null;
    for (let i = 0; i < 3; i++) await w.run(NOW + i * 10 * MINUTE);
    expect(posted("⚡ **Свет")).toHaveLength(0);
    const text = statusText(parsePassport((await meta()).get("src_passport")), { avaria: true }, NOW + 30 * MINUTE, TZ);
    expect(text).toMatch(/канал аварийной службы[^\n]*не отвечает/);
    expect(text).not.toMatch(/Укрэнерго/);
  });

  it("свежий пост про свет попадает в сообщение «Света нет»", async () => {
    w.ukr = pageOf([27800, NOW - 3 * HOUR, F.NEWS_STRIKES], [27801, NOW - 20 * MINUTE, F.EMERGENCY_CITY]);
    await w.run(NOW); // первое чтение: молчит, но запоминает последний пост про свет
    expect(posted("⚡ **Свет")).toHaveLength(0);
    await w.repo().exec(applySignal(readPower(await meta()), "off", NOW + MINUTE).ops);
    w.light = {};
    await w.run(NOW + 3 * MINUTE);
    const m = w.discord.posted.find((p) => p.body.content?.includes("Света нет с"));
    expect(m?.body.content).toContain("⚡ Аварийная служба, сегодня 11:40");
    expect(m?.body.content).toContain("<https://t.me/avariykaaa/27801>");
    expect(m?.body.allowed_mentions).toEqual({ users: [OWNER] });
  });

  it("записи прежней пересылки Укрэнерго (ukr_*) из меты убираются", async () => {
    await w.repo().exec([setMeta("ukr_state", '{"last":5}'), setMeta("ukr_next", "1"), setMeta("ukr_outbox", "[]"), setMeta("ukr_last", "{}")]);
    await w.run(NOW);
    const m = await meta();
    for (const k of ["ukr_state", "ukr_next", "ukr_outbox", "ukr_last"]) expect(m.has(k)).toBe(false);
    expect(m.has("avaria_state")).toBe(true);
  });
});
