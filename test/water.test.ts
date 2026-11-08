// Вода: разбор записей водоканала на сокращённых публичных текстах (23 сентября — 4 ноября 2026), совпадение со словами и план сообщений.
import { describe, expect, it } from "vitest";
import {
  type WaterPost,
  dueWater,
  emptyWaterState,
  failWater,
  matchWater,
  parseWaterPosts,
  parseWaterState,
  parseWaterTimes,
  parseWaterWords,
  planWater,
  waterDistricts,
  waterKind,
  waterSummaryLines,
} from "../src/water.ts";
import { localDate, wallOf } from "../src/time/tz.ts";
import { MAP, TEXTS, post } from "./waterFixtures.ts";

const TZ = "Europe/Kyiv";
const wp = (title: string, text: string, date: string, over = {}): WaterPost => parseWaterPosts([post(title, text, date, over)])[0];
const at = (iso: string) => Date.parse(iso); // UTC; осень: Киев = UTC+2 (с 25 октября 2026 зимнее время)

describe("разбор ленты", () => {
  it("достаёт заголовок, текст без тегов, ссылку на карту и время публикации", () => {
    const [p] = parseWaterPosts([post("Аварійно&#8211;відновлювальні роботи", TEXTS.nov2, "2026-11-02T11:20:11")]);
    expect(p.title).toBe("Аварійно–відновлювальні роботи");
    expect(p.text).toContain("Новокодацького");
    expect(p.text).not.toContain("<p>");
    expect(p.mapUrl).toBe(MAP);
    expect(p.date).toBe(at("2026-11-02T11:20:11Z"));
  });
  it("не массив или мусор — пусто (источник «сломан»)", () => {
    expect(parseWaterPosts({ error: 1 })).toEqual([]);
    expect(parseWaterPosts([{ id: "x" }, null])).toEqual([]);
  });
});

describe("вид записи", () => {
  it("отключения — outage, отмена — cancel, вернулась — restored", () => {
    expect(waterKind(wp("Аварійно-відновлювальні роботи на правобережжі", TEXTS.nov2, "2026-11-02T11:20:11"))).toBe("outage");
    expect(waterKind(wp("Зміна дати проведення робіт на правобережжі!", TEXTS.oct30, "2026-10-30T16:45:22"))).toBe("outage");
    expect(waterKind(wp("Скасування робіт на правобережжі", TEXTS.cancel, "2026-10-31T16:22:06"))).toBe("cancel");
    expect(waterKind(wp("Водопостачання відновлено", TEXTS.restored, "2026-11-07T09:00:00"))).toBe("restored");
  });
  it("боржники и абонплата — не наша тема", () => {
    expect(waterKind(wp("Відключення боржників приватного сектору", TEXTS.debtors, "2026-11-04T08:07:05"))).toBe("ignore");
    expect(waterKind(wp("Інформуємо щодо абонплати", TEXTS.fee, "2026-11-04T09:40:43"))).toBe("ignore");
  });
  it("«буде відновлено» в объявлении — не «вернулась»", () => {
    expect(waterKind(wp("Увага", "На час робіт буде припинено водопостачання в Чечелівському районі, водопостачання буде відновлено до 12:00.", "2026-11-02T11:00:00"))).toBe("outage");
  });
});

describe("районы", () => {
  it("«припинено» и «знижений тиск» в одном предложении различаются", () => {
    expect(waterDistricts(TEXTS.nov2)).toEqual({ Новокодацький: "off", Чечелівський: "off", Соборний: "low", Центральний: "low", Шевченківський: "low" });
  });
  it("отдельные предложения", () => {
    expect(waterDistricts(TEXTS.oct27)).toEqual({ Новокодацький: "off", Чечелівський: "off", Соборний: "low", Центральний: "low", Шевченківський: "low" });
  });
  it("«відсутнє або зниження» — осторожно: снижение, а предложение про восстановление районы не добавляет", () => {
    const d = waterDistricts(TEXTS.sep26);
    expect(d.Чечелівський).toBe("low");
    expect(Object.keys(d)).toHaveLength(4);
  });
});

describe("время", () => {
  const day = (ms: number | null) => (ms === null ? null : `${localDate(ms, TZ)} ${String(wallOf(ms, TZ).h).padStart(2, "0")}:${String(wallOf(ms, TZ).mi).padStart(2, "0")}`);
  it("4.11.2026 … 6.11.2026 и «07. 11.2026»", () => {
    const t = parseWaterTimes(TEXTS.nov2, at("2026-11-02T11:20:11Z"), TZ);
    expect([day(t.start), day(t.end), day(t.restore)]).toEqual(["2026-11-04 22:00", "2026-11-06 22:00", "2026-11-07 12:00"]);
  });
  it("«31 жовтня … 2 листопада 2026 року» (год только у конца)", () => {
    const t = parseWaterTimes(TEXTS.oct30, at("2026-10-30T16:45:22Z"), TZ);
    expect([day(t.start), day(t.end)]).toEqual(["2026-10-31 22:00", "2026-11-02 22:00"]);
  });
  it("«з 22:00 години 30 жовтня до 22:00 години 1 листопада», восстановление «до 12:00 години 2 листопада» (год по дате записи)", () => {
    const t = parseWaterTimes(TEXTS.oct27, at("2026-10-27T11:38:23Z"), TZ);
    expect([day(t.start), day(t.end), day(t.restore)]).toEqual(["2026-10-30 22:00", "2026-11-01 22:00", "2026-11-02 12:00"]);
  });
  it("«26 вересня 2026 року з 01:00 до 23:00» — дата стоит перед «з»", () => {
    const t = parseWaterTimes(TEXTS.sep26, at("2026-09-23T10:00:00Z"), TZ);
    expect([day(t.start), day(t.end), day(t.restore)]).toEqual(["2026-09-26 01:00", "2026-09-26 23:00", "2026-09-27 14:00"]);
  });
  it("запись в декабре про январь без года — следующий год", () => {
    const t = parseWaterTimes("Роботи з 22:00 3 січня до 22:00 4 січня.", at("2026-12-30T10:00:00Z"), TZ);
    expect([day(t.start), day(t.end)]).toEqual(["2027-01-03 22:00", "2027-01-04 22:00"]);
  });
  it("не разобралось — null (неподтверждено), без выдуманных чисел", () => {
    expect(parseWaterTimes("Увага! Аварійно-відновлювальні роботи, водопостачання тимчасово припинено.", at("2026-11-02T11:20:11Z"), TZ)).toEqual({ start: null, end: null, restore: null });
    // «з 4.11.2026» — это дата, а не время 04:11
    expect(parseWaterTimes("З 4.11.2026 до 6.11.2026 буде припинено водопостачання.", at("2026-11-02T11:20:11Z"), TZ).start).toBeNull();
  });
});

describe("слова места", () => {
  const nov2 = wp("Аварійно-відновлювальні роботи", TEXTS.nov2, "2026-11-02T11:20:11");
  it("слова из настроек: нижний регистр, без пустых, не больше пяти", () => {
    expect(parseWaterWords(" Чечелівськ, , Могилевськ ;Чечелівськ, аб")).toEqual(["чечелівськ", "могилевськ"]);
    expect(parseWaterWords("а1а, б2б, в3в, г4г, д5д, е6е, ж7ж")).toHaveLength(5);
  });
  it("район без окончания совпадает; уровень — по району", () => {
    expect(matchWater(nov2, ["чечелівськ"])).toMatchObject({ hit: "district", level: "off" });
    expect(matchWater(nov2, ["соборн"])).toMatchObject({ hit: "district", level: "low" });
  });
  it("улица названа в тексте — совпало; района и улицы нет — молчим", () => {
    const debtorsLike = wp("Аварія на Могилевській", "Буде припинено водопостачання на вул. Могилевська, 2 (Чечелівський район).", "2026-11-02T11:20:11");
    expect(matchWater(debtorsLike, ["могилевськ"])).toMatchObject({ hit: "street" });
    expect(matchWater(nov2, ["самарськ"])).toBeNull();
    expect(matchWater(nov2, [])).toBeNull();
  });
  it("район совпал, а улица из слов не названа — «может коснуться»", () => {
    expect(matchWater(nov2, ["чечелівськ", "могилевськ"])).toMatchObject({ hit: "maybe", level: "off" });
  });
});

describe("план сообщений", () => {
  const NOW = at("2026-11-02T12:00:00Z");
  const words = ["чечелівськ"];
  const nov2 = post("Аварійно-відновлювальні роботи на правобережжі", TEXTS.nov2, "2026-11-02T11:20:11", { id: 6530 });
  const posts = (...p: Record<string, unknown>[]) => parseWaterPosts(p);

  it("новое объявление про ваш район — сразу, с упоминанием и временем; повторная проверка молчит", () => {
    const r = planWater(emptyWaterState(), posts(nov2), words, NOW, TZ);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ kind: "alert", mention: true });
    expect(r.notices[0].text).toContain("Чечелівський");
    expect(r.notices[0].text).toContain("22:00");
    expect(r.notices[0].text).toContain(MAP);
    expect(planWater(r.state, posts(nov2), words, NOW, TZ).notices).toEqual([]);
  });
  it("чужой район, боржники и абонплата — тишина", () => {
    const r = planWater(emptyWaterState(), posts(nov2, post("Відключення боржників", TEXTS.debtors, "2026-11-04T08:07:05"), post("Абонплата", TEXTS.fee, "2026-11-04T09:40:43")), ["самарськ"], NOW, TZ);
    expect(r.notices).toEqual([]);
  });
  it("время не разобралось — «неподтверждено» и выдержка, без выдуманных часов", () => {
    const p = post("Увага! Аварійно-відновлювальні роботи!", "Аварійно-відновлювальні роботи. Буде припинено водопостачання в Чечелівському районі.", "2026-11-02T11:30:00");
    const r = planWater(emptyWaterState(), posts(p), words, NOW, TZ);
    expect(r.notices[0].text).toContain("неподтверждено");
    expect(r.notices[0].text).toContain("Чечелівському районі");
  });
  it("запись про уже прошедшее отключение не поднимает тревогу", () => {
    const old = post("Роботи", TEXTS.sep26, "2026-09-23T10:00:00");
    expect(planWater(emptyWaterState(), posts(old), ["чечелівськ"], NOW, TZ).notices).toEqual([]);
  });
  it("перенос даты заменяет прежнее объявление: «Обновление», в состоянии одно", () => {
    const first = planWater(emptyWaterState(), posts(post("Аварійно-відновлювальні роботи!", TEXTS.oct27, "2026-10-27T11:38:23", { id: 6492 })), words, at("2026-10-27T12:00:00Z"), TZ);
    expect(first.notices[0].kind).toBe("alert");
    const moved = planWater(first.state, posts(post("Зміна дати проведення робіт!", TEXTS.oct30, "2026-10-30T16:45:22", { id: 6519 })), words, at("2026-10-30T17:00:00Z"), TZ);
    expect(moved.notices).toHaveLength(1);
    expect(moved.notices[0].kind).toBe("update");
    expect(moved.notices[0].text).toContain("Обновление");
    expect(moved.state.alerts.map((a) => a.id)).toEqual([6519]);
  });
  it("отмена закрывает прежнее объявление; отмена без прежнего — тишина", () => {
    const a = planWater(emptyWaterState(), posts(post("Аварійно-відновлювальні роботи", TEXTS.oct30, "2026-10-30T16:45:22", { id: 6519 })), words, at("2026-10-30T17:00:00Z"), TZ);
    const c = planWater(a.state, posts(post("Скасування робіт на правобережжі", TEXTS.cancel, "2026-10-31T16:22:06", { id: 6526 })), words, at("2026-10-31T17:00:00Z"), TZ);
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0].kind).toBe("cancel");
    expect(c.state.alerts).toEqual([]);
    expect(planWater(emptyWaterState(), posts(post("Скасування робіт", TEXTS.cancel, "2026-10-31T16:22:06")), words, at("2026-10-31T17:00:00Z"), TZ).notices).toEqual([]);
  });
  it("правка записи без изменения срока молчит; срок изменился — «Обновление» без push", () => {
    const a = planWater(emptyWaterState(), posts(nov2), words, NOW, TZ);
    const typo = post("Аварійно-відновлювальні роботи на правобережжі", TEXTS.nov2 + " ", "2026-11-02T11:20:11", { id: 6530, modified: "2026-11-02T11:24:57" });
    const same = planWater(a.state, posts(typo), words, NOW, TZ);
    expect(same.notices).toEqual([]);
    const shifted = post("Аварійно-відновлювальні роботи на правобережжі", TEXTS.nov2.replace("до 22:00 години 6.11.2026", "до 23:00 години 6.11.2026"), "2026-11-02T11:20:11", { id: 6530, modified: "2026-11-02T13:00:00" });
    const upd = planWater(same.state, posts(shifted), words, NOW, TZ);
    expect(upd.notices).toHaveLength(1);
    expect(upd.notices[0]).toMatchObject({ kind: "update", mention: false });
  });
  it("«вода вернулась» закрывает объявление одним сообщением", () => {
    const a = planWater(emptyWaterState(), posts(nov2), words, NOW, TZ);
    const r = planWater(a.state, posts(post("Водопостачання відновлено", TEXTS.restored, "2026-11-06T18:00:00", { id: 6600 })), words, at("2026-11-06T19:00:00Z"), TZ);
    expect(r.notices.map((n) => n.kind)).toEqual(["restored"]);
    expect(r.state.alerts).toEqual([]);
  });
  it("seen не растёт бесконечно", () => {
    let st = emptyWaterState();
    for (let i = 0; i < 45; i++) st = planWater(st, posts(post("Нічого", "Просто новина.", "2026-11-02T10:00:00", { id: 100 + i })), words, NOW, TZ).state;
    expect(Object.keys(st.seen).length).toBeLessThanOrEqual(30);
  });
});

describe("напоминания по времени", () => {
  const words = ["чечелівськ"];
  const NOW = at("2026-11-02T12:00:00Z");
  const base = () => planWater(emptyWaterState(), parseWaterPosts([post("Аварійно-відновлювальні роботи", TEXTS.nov2, "2026-11-02T11:20:11", { id: 6530 })]), words, NOW, TZ).state;
  const EVE = 20 * 60;
  it("до вечера накануне — тишина; вечером накануне — один раз; за 2 часа — один раз (с push); после срока — один раз", () => {
    let st = base();
    // 11.03 19:00 по Киеву: ещё рано
    expect(dueWater(st, at("2026-11-03T17:00:00Z"), TZ, EVE).notices).toEqual([]);
    // 11.03 20:05
    let r = dueWater(st, at("2026-11-03T18:05:00Z"), TZ, EVE);
    expect(r.notices.map((n) => n.kind)).toEqual(["eve"]);
    expect(r.notices[0].mention).toBe(false);
    st = r.state;
    expect(dueWater(st, at("2026-11-03T18:30:00Z"), TZ, EVE).notices).toEqual([]);
    // 11.04 20:00 по Киеву (старт 22:00)
    r = dueWater(st, at("2026-11-04T18:00:00Z"), TZ, EVE);
    expect(r.notices.map((n) => n.kind)).toEqual(["soon"]);
    expect(r.notices[0].mention).toBe(true);
    st = r.state;
    expect(dueWater(st, at("2026-11-04T18:10:00Z"), TZ, EVE).notices).toEqual([]);
    // после обещанного восстановления (11.07 12:00)
    r = dueWater(st, at("2026-11-07T10:30:00Z"), TZ, EVE);
    expect(r.notices.map((n) => n.kind)).toEqual(["back"]);
    expect(dueWater(r.state, at("2026-11-07T10:40:00Z"), TZ, EVE).notices).toEqual([]);
  });
  it("объявили за три часа до начала: «накануне вечером» уже поздно — не шлём, но «за 2 часа» шлём", () => {
    const st = planWater(emptyWaterState(), parseWaterPosts([post("Роботи", TEXTS.nov2, "2026-11-04T15:00:00", { id: 6531 })]), words, at("2026-11-04T15:05:00Z"), TZ).state;
    expect(dueWater(st, at("2026-11-04T15:10:00Z"), TZ, EVE).notices).toEqual([]);
    expect(dueWater(st, at("2026-11-04T18:00:00Z"), TZ, EVE).notices.map((n) => n.kind)).toEqual(["soon"]);
  });
  it("сводка «Коммуналка»: идущее или завтрашнее — строкой; прошедшее и далёкое — нет", () => {
    const st = base();
    expect(waterSummaryLines(st, at("2026-11-04T06:00:00Z"), TZ)[0]).toContain("Вода:");
    expect(waterSummaryLines(st, at("2026-11-10T06:00:00Z"), TZ)).toEqual([]);
    expect(waterSummaryLines(planWater(emptyWaterState(), parseWaterPosts([post("Роботи", TEXTS.nov2.replace(/4\.11\.2026/g, "20.11.2026").replace(/6\.11\.2026/g, "21.11.2026"), "2026-11-02T11:20:11", { id: 1 })]), words, NOW, TZ).state, NOW, TZ)).toEqual([]);
  });
});

describe("сбой источника", () => {
  it("после трёх неудач подряд — одно сообщение, дальше молчим", () => {
    let st = emptyWaterState();
    const notices: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      const r = failWater(st);
      st = r.state;
      notices.push(r.notice?.kind);
    }
    expect(notices).toEqual([undefined, undefined, "source", undefined, undefined, undefined]);
  });
  it("состояние читается из meta; мусор — пустое", () => {
    expect(parseWaterState("не json")).toEqual(emptyWaterState());
    const r = planWater(emptyWaterState(), parseWaterPosts([post("Роботи", TEXTS.nov2, "2026-11-02T11:20:11", { id: 7 })]), ["чечелівськ"], at("2026-11-02T12:00:00Z"), TZ);
    expect(parseWaterState(JSON.stringify(r.state)).alerts).toHaveLength(1);
  });
});
