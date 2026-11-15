// Газ: ссылка на график на главной, чтение .docx, разбор дат и адресов, совпадение со словами, план сообщений.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addressMatches,
  docxParagraphs,
  dueGas,
  emptyGasState,
  failGas,
  findGasLink,
  gasSummaryLines,
  matchGasSchedule,
  parseGasSchedule,
  parseGasState,
  planGas,
  unzipEntry,
} from "../src/gas.ts";
import { GAS_HOME, GAS_LINK, GAS_PARAS, docXml, makeDocx, makeZip } from "./gasFixtures.ts";
import { kyiv } from "./helpers.ts";

const TZ = "Europe/Kyiv";
const schedule = () => parseGasSchedule(GAS_PARAS);

describe("ссылка на график", () => {
  it("берёт самую новую (первую) ссылку на .docx", () => {
    expect(findGasLink(GAS_HOME)).toBe(new URL(GAS_LINK).href);
  });
  it("нет ссылки или не .docx — null", () => {
    expect(findGasLink("<p>Графік виконання робіт</p>")).toBeNull();
    expect(findGasLink('<a href="https://x.ua/a.pdf">Графік виконання робіт</a>')).toBeNull();
    expect(findGasLink("")).toBeNull();
  });
});

describe(".docx", () => {
  it("достаёт document.xml из сжатого и из несжатого zip, абзацы без тегов", async () => {
    for (const deflate of [true, false]) {
      const xml = await unzipEntry(makeDocx(GAS_PARAS, deflate), "word/document.xml");
      expect(xml).not.toBeNull();
      const paras = docxParagraphs(new TextDecoder().decode(xml!));
      expect(paras).toEqual(GAS_PARAS.map((p) => p.replace(/\s+/g, " ")));
    }
  });
  it("нет файла в архиве или это не zip — null, без исключений", async () => {
    expect(await unzipEntry(makeZip([{ name: "a.txt", data: new Uint8Array([65]) }]), "word/document.xml")).toBeNull();
    expect(await unzipEntry(new Uint8Array([1, 2, 3, 4, 5]), "word/document.xml")).toBeNull();
    expect(await unzipEntry(new TextEncoder().encode("<html>не архив, а страница ошибки</html>"), "word/document.xml")).toBeNull();
  });
  it("амперсанды в тексте раскодируются", () => {
    expect(docxParagraphs(docXml(["вул. Ірпінська & Ко, 1"]))).toEqual(["вул. Ірпінська & Ко, 1"]);
  });
});

describe("разбор графика", () => {
  it("даты -> адреса; всё после «ЗВЕРНІТЬ УВАГУ» отбрасывается", () => {
    const s = schedule();
    expect(Object.keys(s)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-10", "2026-11-12"]);
    expect(s["2026-11-03"]).toEqual(["вул. Олександра Кошиця, 38, 46", "вул. Орловська, 24, 24а"]);
    expect(s["2026-11-10"]).toEqual(["просп. Героїв, 35, під’їзд № 11"]);
  });
  it("другие населённые пункты не берём", () => {
    const s = parseGasSchedule(["м. Дніпро", "05.11.2026 року", "вул. Сугака, 4", "смт Слобожанське", "06.11.2026 року", "вул. Центральна, 1", "м. Дніпро", "07.11.2026 року", "вул. Коржева, 10"]);
    expect(s).toEqual({ "2026-11-05": ["вул. Сугака, 4"], "2026-11-07": ["вул. Коржева, 10"] });
  });
  it("мусор — пустой график", () => {
    expect(parseGasSchedule(["Привіт", "ще текст"])).toEqual({});
  });
  const real = "D:/_MeidoBot/data/recon/gas_dp_schedule_2026-11.docx";
  it.skipIf(!existsSync(real))("настоящий ноябрьский файл (лежит только локально): 8 дат", async () => {
    const xml = await unzipEntry(new Uint8Array(readFileSync(real)), "word/document.xml");
    const s = parseGasSchedule(docxParagraphs(new TextDecoder().decode(xml!)));
    expect(Object.keys(s)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-10", "2026-11-12", "2026-11-17", "2026-11-18"]);
  });
});

describe("слова адреса", () => {
  it("улица без окончания; регистр не важен", () => {
    expect(addressMatches("просп. Героїв, 35, під’їзд № 11", "героїв")).toBe(true);
    expect(addressMatches("вул. Козака Мамая, 12", "КОЗАКА МАМАЯ")).toBe(true);
    expect(addressMatches("вул. Сугака, 4", "героїв")).toBe(false);
  });
  it("улица и дом: дом назван в списке; 35 не путается с 350, 35а и номером подъезда", () => {
    const l = "вул. Олександра Кошиця, 38, 46";
    expect(addressMatches(l, "кошиця 46")).toBe(true);
    expect(addressMatches(l, "кошиця 38")).toBe(true);
    expect(addressMatches(l, "кошиця 4")).toBe(false);
    expect(addressMatches("просп. Героїв, 350", "героїв 35")).toBe(false);
    expect(addressMatches("просп. Героїв, 35а", "героїв 35")).toBe(false);
    expect(addressMatches("просп. Героїв, 35а", "героїв 35а")).toBe(true);
    expect(addressMatches("просп. Героїв, 35, під’їзд № 11", "героїв 11")).toBe(false);
    expect(addressMatches("пров. Широкий, 1, 2, 18/1, 20", "широкий 18/1")).toBe(true);
  });
  it("слишком короткое слово не совпадает ни с чем", () => {
    expect(addressMatches("вул. Орловська, 24", "ор")).toBe(false);
  });
  it("только даты с сегодняшней и позже", () => {
    expect(matchGasSchedule(schedule(), ["кошиця"], "2026-11-03")).toEqual({ "2026-11-03": ["вул. Олександра Кошиця, 38, 46"] });
  });
});

describe("план сообщений", () => {
  const NOW = kyiv(2026, 11, 1, 12, 0);
  const words = ["кошиця", "героїв 35"];
  it("новый график с вашим адресом — одно сообщение с упоминанием; тот же график — тишина", () => {
    const r = planGas(emptyGasState(), GAS_LINK, schedule(), words, NOW, TZ);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toMatchObject({ kind: "found", mention: true });
    expect(r.notices[0].text).toContain("Кошиця");
    expect(r.notices[0].text).toContain("11.10.2026");
    expect(r.notices[0].text).toContain("Времени суток");
    expect(r.state.items.map((i) => i.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-10"]);
    expect(planGas(r.state, GAS_LINK, schedule(), words, NOW + 3_600_000, TZ).notices).toEqual([]);
  });
  it("вашего адреса нет — тишина", () => {
    expect(planGas(emptyGasState(), GAS_LINK, schedule(), ["сугака"], kyiv(2026, 11, 6), TZ).notices).toEqual([]);
    expect(planGas(emptyGasState(), GAS_LINK, schedule(), ["героїв 36"], NOW, TZ).notices).toEqual([]);
  });
  it("файл не перечитывали — меняется только ссылка", () => {
    const st = planGas(emptyGasState(), GAS_LINK, schedule(), words, NOW, TZ).state;
    const r = planGas(st, GAS_LINK, null, words, NOW + 1000, TZ);
    expect(r.notices).toEqual([]);
    expect(r.state.items).toHaveLength(3);
  });
  it("в графике правка: другой адрес в ту же дату — «график изменился»; дата убрана — сообщение без упоминания", () => {
    const st = planGas(emptyGasState(), GAS_LINK, schedule(), words, NOW, TZ).state;
    const edited = { ...schedule(), "2026-11-03": ["вул. Олександра Кошиця, 38, 46", "вул. Олександра Кошиця, 50"] };
    delete (edited as Record<string, unknown>)["2026-11-10"];
    const r = planGas(st, GAS_LINK, edited, words, NOW + 3_600_000, TZ);
    expect(r.notices.map((n) => [n.kind, n.mention])).toEqual([["changed", false], ["changed", false]]);
    expect(r.notices[1].text).toContain("убрана дата");
    expect(r.state.items.map((i) => i.date)).toEqual(["2026-11-02", "2026-11-03"]);
  });
  it("состояние читается из meta; мусор — пустое", () => {
    expect(parseGasState("не json")).toEqual(emptyGasState());
    const st = planGas(emptyGasState(), GAS_LINK, schedule(), words, NOW, TZ).state;
    expect(parseGasState(JSON.stringify(st)).items).toHaveLength(3);
  });
});

describe("напоминания по времени", () => {
  const EVE = 20 * 60;
  const MORN = 8 * 60;
  const base = (born = kyiv(2026, 11, 1, 12, 0)) => planGas(emptyGasState(), GAS_LINK, schedule(), ["героїв 35"], born, TZ).state;
  it("накануне вечером — один раз без упоминания; утром в день работ — один раз с упоминанием", () => {
    let st = base();
    expect(dueGas(st, kyiv(2026, 11, 9, 19, 59), TZ, EVE, MORN).notices).toEqual([]);
    let r = dueGas(st, kyiv(2026, 11, 9, 20, 1), TZ, EVE, MORN);
    expect(r.notices.map((n) => [n.kind, n.mention])).toEqual([["eve", false]]);
    expect(r.notices[0].text).toContain("Завтра газ");
    st = r.state;
    expect(dueGas(st, kyiv(2026, 11, 9, 22, 0), TZ, EVE, MORN).notices).toEqual([]);
    r = dueGas(st, kyiv(2026, 11, 10, 8, 2), TZ, EVE, MORN);
    expect(r.notices.map((n) => [n.kind, n.mention])).toEqual([["morning", true]]);
    expect(r.notices[0].text).toContain("Сегодня газ");
    expect(dueGas(r.state, kyiv(2026, 11, 10, 9, 0), TZ, EVE, MORN).notices).toEqual([]);
  });
  it("график увидели вечером накануне позже обычного — «накануне» не шлём, утром — шлём", () => {
    const st = base(kyiv(2026, 11, 9, 21, 0));
    expect(dueGas(st, kyiv(2026, 11, 9, 21, 5), TZ, EVE, MORN).notices).toEqual([]);
    expect(dueGas(st, kyiv(2026, 11, 10, 8, 5), TZ, EVE, MORN).notices.map((n) => n.kind)).toEqual(["morning"]);
  });
  it("график увидели утром в день работ — одно «нашли», остальное уже поздно", () => {
    const st = base(kyiv(2026, 11, 10, 9, 0));
    expect(dueGas(st, kyiv(2026, 11, 10, 9, 5), TZ, EVE, MORN).notices).toEqual([]);
  });
  it("после даты запись забывается", () => {
    expect(dueGas(base(), kyiv(2026, 11, 13, 9, 0), TZ, EVE, MORN).state.items).toEqual([]);
  });
  it("сводка «Коммуналка»: сегодня и завтра; дальше — нет", () => {
    const st = base();
    expect(gasSummaryLines(st, kyiv(2026, 11, 9, 8, 0), TZ)[0]).toContain("Газ завтра");
    expect(gasSummaryLines(st, kyiv(2026, 11, 10, 8, 0), TZ)[0]).toContain("Газ сегодня");
    expect(gasSummaryLines(st, kyiv(2026, 11, 5, 8, 0), TZ)).toEqual([]);
  });
});

describe("сбой источника", () => {
  it("после трёх неудач подряд — одно сообщение", () => {
    let st = emptyGasState();
    const kinds: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const r = failGas(st);
      st = r.state;
      kinds.push(r.notice?.kind);
    }
    expect(kinds).toEqual([undefined, undefined, "source", undefined, undefined]);
  });
});
