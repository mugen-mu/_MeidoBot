// Этап 3 ретроспективы 2: хвост «Висит» и автозаморозка (B1–B9). Тесты написаны до кода (план docs/PLAN-RETRO-2.md, этап 3).
// Главное правило проекта (после решения владельца 2026-11-10): дело, на разбор которого нет ответа 30 дней, замораживается само;
// замороженное остаётся в базе, не напоминает, не стирается и возвращается кнопкой «Вернуть» как было.
import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "../src/cron.ts";
import { setMeta, setSetting } from "../src/db/repo.ts";
import { countedApi } from "../src/discord/api.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { summaryParts } from "../src/discord/ui.ts";
import type { OccView } from "../src/db/types.ts";
import { PHRASES } from "../src/personality/phrases.ts";
import { scrubOps } from "../src/service.ts";
import { FREEZE_DAYS, TAIL_DAYS, freezeCandidates, idleDays, isTail, shouldNoteTail, soonFrozen, tailInterval } from "../src/tail.ts";
import { MINUTE } from "../src/time/tz.ts";
import { NOW, kyiv } from "./helpers.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const DAY = 86_400_000;
const SAT_AM = kyiv(2026, 11, 7, 8, 5); // суббота
const MON_AM = kyiv(2026, 11, 9, 8, 5); // понедельник

const occ = (o: Partial<OccView> = {}): OccView =>
  ({
    id: 1, item_id: 1, kind: "main", state: "overdue", item_kind: "reminder", critical: 0, plain: 0, title: "дело",
    due_at: NOW - 10 * DAY, base_at: NOW - 10 * DAY, touched_at: null, created_at: NOW - 40 * DAY, snooze_count: 0, fire_count: 5, ...o,
  }) as unknown as OccView;

// ---------- чистая часть ----------

describe("хвост: давность и кандидаты на заморозку", () => {
  it("давность — от последнего касания (срок, срок после «отложить», нажатие)", () => {
    expect(idleDays(occ({ due_at: NOW - 10 * DAY, base_at: NOW - 10 * DAY }), NOW)).toBeCloseTo(10, 5);
    expect(idleDays(occ({ base_at: NOW - 10 * DAY, touched_at: NOW - 3 * DAY }), NOW)).toBeCloseTo(3, 5);
    expect(idleDays(occ({ due_at: NOW - 50 * DAY, base_at: NOW - 2 * DAY }), NOW)).toBeCloseTo(2, 5);
    expect(idleDays(occ({ due_at: null, base_at: null }), NOW)).toBeCloseTo(40, 5); // без срока — от создания
  });

  it("«давнее» — «висит» больше 7 дней: только просроченное главное дело-напоминание", () => {
    expect(TAIL_DAYS).toBe(7);
    expect(isTail(occ({ base_at: NOW - 7 * DAY - 1000 }), NOW)).toBe(true);
    expect(isTail(occ({ base_at: NOW - 6 * DAY }), NOW)).toBe(false);
    expect(isTail(occ({ state: "snoozed" }), NOW)).toBe(false);
    expect(isTail(occ({ state: "fired" }), NOW)).toBe(false);
    expect(isTail(occ({ state: "draft" }), NOW)).toBe(false);
    expect(isTail(occ({ kind: "lead" }), NOW)).toBe(false);
    expect(isTail(occ({ item_kind: "timer" }), NOW)).toBe(false);
  });

  it("заморозка: 30 дней без единого нажатия; критичные и недавно тронутые не замораживаются", () => {
    expect(FREEZE_DAYS).toBe(30);
    const old = occ({ id: 1, base_at: NOW - 31 * DAY, due_at: NOW - 31 * DAY });
    const edge = occ({ id: 2, base_at: NOW - 29 * DAY, due_at: NOW - 29 * DAY });
    const touched = occ({ id: 3, base_at: NOW - 60 * DAY, due_at: NOW - 60 * DAY, touched_at: NOW - 5 * DAY });
    const critical = occ({ id: 4, base_at: NOW - 60 * DAY, due_at: NOW - 60 * DAY, critical: 1 });
    const snoozedFuture = occ({ id: 5, state: "snoozed", base_at: NOW + DAY, due_at: NOW - 60 * DAY });
    const draft = occ({ id: 6, state: "draft", due_at: null, base_at: null });
    expect(freezeCandidates([old, edge, touched, critical, snoozedFuture, draft], NOW).map((o) => o.id)).toEqual([1]);
  });

  it("предупреждение: тем, кто заморозится до следующей субботы (23–30 дней)", () => {
    const a = occ({ id: 1, base_at: NOW - 22 * DAY });
    const b = occ({ id: 2, base_at: NOW - 24 * DAY });
    const c = occ({ id: 3, base_at: NOW - 29.5 * DAY });
    const d = occ({ id: 4, base_at: NOW - 31 * DAY });
    expect(soonFrozen([a, b, c, d], NOW).map((o) => o.id)).toEqual([2, 3]);
  });

  it("интервал «сколько висит» по будням: от 1 до 3 дней, от даты; показывается не раньше срока", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 120; i++) {
      const k = new Date(Date.UTC(2026, 0, 1) + i * DAY).toISOString().slice(0, 10);
      const n = tailInterval(k);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
      expect(tailInterval(k)).toBe(n);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(shouldNoteTail("2026-11-10", undefined)).toBe(true);
    expect(shouldNoteTail("2026-11-10", "2026-11-10")).toBe(false);
    // не раньше, чем через интервал дня, когда решаем
    const k = "2026-11-12";
    const n = tailInterval(k);
    const prev = new Date(Date.parse(k) - n * DAY).toISOString().slice(0, 10);
    expect(shouldNoteTail(k, prev)).toBe(true);
    const tooSoon = new Date(Date.parse(k) - (n - 1) * DAY).toISOString().slice(0, 10);
    if (n > 1) expect(shouldNoteTail(k, tooSoon)).toBe(false);
  });
});

describe("сводки: давнее не перечисляется, считается строкой", () => {
  const items = [
    occ({ id: 1, item_id: 1, title: "давнее дело", base_at: NOW - 12 * DAY, due_at: NOW - 12 * DAY }),
    occ({ id: 2, item_id: 2, title: "свежее дело", base_at: NOW - 2 * DAY, due_at: NOW - 2 * DAY }),
  ];
  const args = { items, now: NOW, tz: "Europe/Kyiv", ownerId: OWNER };

  it("утром: свежее — списком, давнее — одной строкой (когда пора), без названий", () => {
    const withNote = summaryParts("morning", { ...args, tailNote: true }).text;
    expect(withNote).toContain("свежее дело");
    expect(withNote).not.toContain("давнее дело");
    expect(withNote).toMatch(/Давнее висит: 1/);
    const without = summaryParts("morning", { ...args, tailNote: false }).text;
    expect(without).not.toContain("давнее дело");
    expect(without).not.toMatch(/Давнее висит/);
  });

  it("вечером давнее тоже не перечисляется; «Показать всё» (full) возвращает всё", () => {
    const ev = summaryParts("evening", { ...args, tailNote: true }).text;
    expect(ev).toContain("свежее дело");
    expect(ev).not.toContain("давнее дело");
    expect(summaryParts("morning", { ...args, full: true }).text).toContain("давнее дело");
    expect(summaryParts("return", args).text).toContain("давнее дело");
  });
});

// ---------- база, cron, кнопки ----------

let w: World;
let pending: Promise<unknown>[];
let seq = 0;

async function run(now: number, limit = 100) {
  const repo = w.repo(limit);
  return runCron({
    repo,
    api: countedApi(w.discord, repo.counter),
    now,
    env: {},
    rand: () => 0,
    fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
  });
}
async function call(i: Partial<Interaction>, now = NOW): Promise<any> {
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1", member: { user: { id: OWNER } }, type: 2, ...i } as Interaction,
    { repo: w.repo(100), api: w.discord, now, env: {}, rand: () => 0, defer: (p) => void pending.push(p) },
  );
  await Promise.all(pending.splice(0));
  return r;
}
const click = (custom_id: string, now = NOW) => call({ type: 3, data: { custom_id }, message: { id: "m1" } }, now);
const submit = (custom_id: string, fields: Record<string, string>, now = NOW) =>
  call({ type: 5, data: { custom_id, components: Object.entries(fields).map(([id, value]) => ({ type: 18, component: { type: 4, custom_id: id, value } })) } }, now);
const buttons = (r: any): { label?: string; custom_id?: string }[] => (r.data.components ?? []).flatMap((row: any) => row.components);
const ids = (r: any): string[] => buttons(r).map((b) => b.custom_id ?? "");

/** дело, которое «висит» idleDays суток: создаём «в прошлом» и правим базу напрямую */
async function hang(title: string, idle: number, o: { now?: number; touched?: number | null; critical?: boolean; text?: string } = {}) {
  const now = o.now ?? NOW;
  const r = await w.create(o.text ?? `через 5 минут ${title}`, now - 60 * DAY);
  const due = now - idle * DAY;
  w.d1.q("UPDATE occurrences SET state='overdue', due_at=?, base_at=?, next_fire_at=NULL, fire_count=5, touched_at=? WHERE id=?", due, due, o.touched ?? null, r.occId);
  if (o.critical) w.d1.q("UPDATE items SET critical = 1 WHERE id = ?", w.occ(r.occId).item_id);
  return { occId: r.occId, itemId: w.occ(r.occId).item_id as number };
}
const row = (id: number) => w.occ(id) as Record<string, any>;
const count = (sql: string, ...p: unknown[]) => (w.d1.q<{ n: number }>(sql, ...p)[0]?.n ?? 0) as number;
const meta = (k: string) => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const msgs = () => w.discord.live(CH_REMIND).map((m) => m.body);
const reviews = () => msgs().filter((b) => String(b.content).startsWith("**Разбор «Висит»**"));

beforeEach(async () => {
  w = new World();
  pending = [];
  seq = 0;
  await w.seed({ today: true, intake: true, settings: { summary_morning: "08:00", summary_evening: "off", weekly: "off" } });
});

describe("«касание» дела", () => {
  it("«отложить», новое время и правка названия обновляют touched_at (так дело не замёрзнет)", async () => {
    const a = await hang("пробное", 40);
    const at = MON_AM;
    await submit(`m_snz:${a.occId}`, { quick: "tom", text: "" }, at);
    expect(row(a.occId).touched_at).toBe(at);
    w.d1.q("UPDATE occurrences SET touched_at = NULL, state = 'overdue' WHERE id = ?", a.occId);
    await submit(`m_edit:${a.occId}`, { title: "новое имя", ladder: "keep", plain: "keep" }, at + MINUTE);
    expect(row(a.occId).touched_at).toBe(at + MINUTE);
  });
});

describe("автозаморозка (B7): ничего не стирается", () => {
  it("через 30 дней без нажатий дело замораживается; остаётся в базе с названием; события пишутся", async () => {
    const a = await hang("древнее дело", 31, { now: MON_AM });
    const before = count("SELECT COUNT(*) AS n FROM occurrences");
    await run(MON_AM);
    const r = row(a.occId);
    expect([r.state, r.closed_reason]).toEqual(["cancelled", "frozen"]);
    expect(r.closed_at).toBe(MON_AM);
    expect(r.next_fire_at).toBeNull();
    expect(w.d1.q<{ title: string; archived_at: number | null }>("SELECT title, archived_at FROM items WHERE id = ?", a.itemId)[0]).toEqual({ title: "Древнее дело", archived_at: null });
    expect(count("SELECT COUNT(*) AS n FROM occurrences")).toBe(before);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'frozen' AND occ_id = ?", a.occId)).toBe(1);
    expect(meta("last_freeze")).toBe("2026-11-09");
    // повторный запуск того же дня — ничего нового
    await run(MON_AM + MINUTE);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'frozen'")).toBe(1);
  });

  it("не замораживаются: тронутое за 30 дней, критичное, 29 дней, в режиме «я в отъезде»", async () => {
    const touched = await hang("бумаги", 60, { now: MON_AM, touched: MON_AM - 5 * DAY });
    const critical = await hang("отчёты", 60, { now: MON_AM, critical: true });
    const edge = await hang("шкаф", 29, { now: MON_AM });
    await run(MON_AM);
    for (const x of [touched, critical, edge]) expect(row(x.occId).state).toBe("overdue");
    // отъезд: заморозки нет, даже когда пора
    const old = await hang("гараж", 40, { now: MON_AM });
    await w.repo().exec([setSetting("away_until", String(MON_AM + 3 * DAY))]);
    await run(MON_AM + 2 * MINUTE);
    expect(row(old.occId).state).toBe("overdue");
  });

  it("раньше 06:00 заморозка не идёт (ночью cron не должен ничего менять в списках)", async () => {
    const a = await hang("ночное", 40, { now: kyiv(2026, 11, 9, 3, 0) });
    await run(kyiv(2026, 11, 9, 3, 0));
    expect(row(a.occId).state).toBe("overdue");
  });

  it("замороженное не попадает в списки, сводки и панель «Горит»; текст не стирается через 90 дней", async () => {
    const a = await hang("древнее дело", 31, { now: MON_AM });
    await run(MON_AM);
    const open = await w.repo().openMain(100);
    expect(open.some((o) => o.id === a.occId)).toBe(false);
    expect(msgs().some((b) => String(b.content).includes("Древнее дело"))).toBe(false);
    await w.repo().exec(scrubOps(MON_AM + 400 * DAY));
    expect(w.d1.q<{ title: string }>("SELECT title FROM items WHERE id = ?", a.itemId)[0].title).toBe("Древнее дело");
  });

  it("повторяющееся дело: замораживается пропущенное повторение, ряд и правило остаются", async () => {
    const a = await hang("проверить", 45, { now: MON_AM, text: "каждый день в 10:00 проверить плиту" });
    const rules = count("SELECT COUNT(*) AS n FROM rules WHERE item_id = ?", a.itemId);
    expect(rules).toBe(1);
    await run(MON_AM);
    expect(row(a.occId).closed_reason).toBe("frozen");
    expect(count("SELECT COUNT(*) AS n FROM rules WHERE item_id = ?", a.itemId)).toBe(1);
    expect(w.d1.q<{ archived_at: number | null }>("SELECT archived_at FROM items WHERE id = ?", a.itemId)[0].archived_at).toBeNull();
  });

  it("время напоминаний не трогаем: запланированное дело и его срабатывания те же", async () => {
    const f = await w.create("завтра в 10 позвонить маме", MON_AM);
    const before = JSON.stringify(row(f.occId));
    await hang("древнее", 40, { now: MON_AM });
    await run(MON_AM);
    expect(JSON.stringify(row(f.occId))).toBe(before);
  });
});

describe("субботний разбор (B2, B3, B6, B9)", () => {
  it("отдельным сообщением после утренней сводки: всё давнее списком, свежее — нет; одна кнопка «Разобрать»; без упоминания", async () => {
    await hang("старое дело", 10, { now: SAT_AM });
    await hang("давнее второе", 20, { now: SAT_AM });
    await hang("свежее дело", 2, { now: SAT_AM });
    await run(SAT_AM);
    const all = msgs();
    const summary = all.find((b) => String(b.content).includes("Сводка на сегодня"))!;
    expect(String(summary.content)).toContain("Свежее дело");
    expect(String(summary.content)).not.toContain("Старое дело");
    expect(String(summary.content)).not.toMatch(/Давнее висит/); // в субботу это делает разбор
    const rv = reviews();
    expect(rv).toHaveLength(1);
    const text = String(rv[0].content);
    expect(text).toContain("Старое дело");
    expect(text).toContain("Давнее второе");
    expect(text).not.toContain("Свежее дело");
    expect(text).not.toContain("<@");
    const bts = rv[0].components![0].components;
    expect(bts).toHaveLength(1);
    expect(bts[0].custom_id).toBe("pn:ls:r:0");
    expect((rv[0].components as unknown[]).length).toBe(1);
  });

  it("разбор — раз за субботу; в другие дни его нет", async () => {
    await hang("старое дело", 10, { now: SAT_AM });
    await run(SAT_AM);
    await run(SAT_AM + MINUTE);
    expect(reviews()).toHaveLength(1);
    expect(meta("last_review")).toBe("2026-11-07");
    const w2 = new World();
    await w2.seed({ today: true, settings: { summary_morning: "08:00", summary_evening: "off", weekly: "off" } });
    w = w2;
    await hang("старое дело", 10, { now: MON_AM });
    await run(MON_AM);
    expect(reviews()).toHaveLength(0);
  });

  it("предупреждение «заморожу до следующей субботы» и строка про уже замороженное", async () => {
    await hang("старое дело", 10, { now: SAT_AM });
    await hang("скоро заморожу", 25, { now: SAT_AM });
    const f = await hang("уже замёрзло", 40, { now: SAT_AM });
    w.d1.q("UPDATE occurrences SET state='cancelled', closed_reason='frozen', closed_at=?, touched_at=NULL WHERE id=?", SAT_AM - 2 * DAY, f.occId);
    await run(SAT_AM);
    const text = String(reviews()[0].content);
    expect(text).toMatch(/заморожу/i);
    expect(text).toContain("Скоро заморожу");
    expect(text).toMatch(/Заморожено за неделю: 1/);
    expect(text).toContain("Ещё");
  });

  it("«Висит» = 0: раз в неделю одна тёплая строка; если висит только свежее — разбора и строки нет", async () => {
    await run(SAT_AM);
    const calm = msgs().filter((b) => /Ничего не висит/.test(String(b.content)) && !String(b.content).includes("Сводка"));
    expect(calm).toHaveLength(1);
    expect(reviews()).toHaveLength(0);
    const w2 = new World();
    await w2.seed({ today: true, settings: { summary_morning: "08:00", summary_evening: "off", weekly: "off" } });
    w = w2;
    await hang("свежее", 2, { now: SAT_AM });
    await run(SAT_AM);
    expect(reviews()).toHaveLength(0);
    expect(msgs().some((b) => /Ничего не висит/.test(String(b.content)) && !String(b.content).includes("Сводка"))).toBe(false);
  });

  it("укладывается в бюджет подзапросов (много дел, заморозка и разбор в один запуск)", async () => {
    for (let i = 0; i < 12; i++) await hang(`давнее ${i}`, 8 + i, { now: SAT_AM });
    await hang("древнее", 40, { now: SAT_AM });
    const rep = await run(SAT_AM, 50);
    expect(rep.subrequests).toBeLessThanOrEqual(16);
    expect(reviews()).toHaveLength(1);
  });
});

describe("«сколько висит» по будням (B8)", () => {
  it("строка о давнем — раз в 1–3 дня, не в субботу; список давнего в сводках не повторяется", async () => {
    await hang("старое дело", 8, { now: MON_AM });
    const shown: string[] = [];
    for (let k = 0; k < 14; k++) {
      const at = MON_AM + k * DAY;
      await run(at);
      const last = msgs().filter((b) => String(b.content).includes("Сводка на сегодня")).pop()!;
      const day = new Date(at + 3 * 3600_000).toISOString().slice(0, 10);
      expect(String(last.content), day).not.toContain("Старое дело");
      if (/Давнее висит/.test(String(last.content))) shown.push(day);
    }
    expect(shown.length).toBeGreaterThanOrEqual(4);
    expect(shown.length).toBeLessThanOrEqual(12);
    expect(shown).not.toContain("2026-11-14"); // суббота
    expect(shown).not.toContain("2026-11-21");
    for (let i = 1; i < shown.length; i++) {
      const gap = (Date.parse(shown[i]) - Date.parse(shown[i - 1])) / DAY;
      expect(gap).toBeGreaterThanOrEqual(1);
      expect(gap).toBeLessThanOrEqual(4); // 3 + пропущенная суббота
    }
  });
});

describe("кнопки: «Давнее», «Не нужно», «Заморожено», «Вернуть»", () => {
  it("кнопка разбора открывает «Давнее» только вам; в списке и карточке — Готово, Не нужно, Отложить, без «Изменить»", async () => {
    const a = await hang("старое дело", 10);
    await hang("свежее дело", 2);
    const list = await click("pn:ls:r:0");
    expect(list.data.flags).toBe(64);
    expect(String(list.data.content)).toContain("Старое дело");
    expect(String(list.data.content)).not.toContain("Свежее дело");
    const card = await click(`mn:it:${a.occId}:r:0`);
    const cid = ids(card);
    expect(cid.some((x) => x.startsWith("mn:dn:"))).toBe(true);
    expect(cid.some((x) => x.startsWith("mn:nn:"))).toBe(true);
    expect(cid.some((x) => x.startsWith("mn:sz:") && x.includes(":tom:"))).toBe(true);
    expect(cid.some((x) => x.startsWith("mn:sa:"))).toBe(true);
    expect(cid.some((x) => x.startsWith("mn:ed:"))).toBe(false);
  });

  it("«Не нужно»: закрывает дело (в базе остаётся, причина — «не нужно»), у повторяющегося ряд живёт", async () => {
    const a = await hang("старое дело", 10);
    const r = await click(`mn:nn:${a.occId}:r:0`);
    expect(String(r.data.content)).toContain("Старое дело");
    expect([row(a.occId).state, row(a.occId).closed_reason]).toEqual(["cancelled", "not_needed"]);
    expect(w.d1.q<{ archived_at: number | null }>("SELECT archived_at FROM items WHERE id = ?", a.itemId)[0].archived_at).not.toBeNull();
    const rec = await hang("плита", 10, { text: "каждый день в 10:00 проверить плиту" });
    await click(`mn:nn:${rec.occId}:r:0`);
    expect(row(rec.occId).closed_reason).toBe("not_needed");
    expect(w.d1.q<{ archived_at: number | null }>("SELECT archived_at FROM items WHERE id = ?", rec.itemId)[0].archived_at).toBeNull();
  });

  it("«Отложить на завтра» из карточки разбора — обычное откладывание (дело больше не в «Давнем»)", async () => {
    const a = await hang("старое дело", 10);
    await click(`mn:sz:${a.occId}:tom:r:0`, MON_AM);
    expect(row(a.occId).state).toBe("snoozed");
    expect(row(a.occId).touched_at).toBe(MON_AM);
  });

  it("«Ещё»: кнопка «Заморожено N» есть только когда есть что показывать; список → карточка с «Вернуть»", async () => {
    expect(ids(await click("mn:more"))).not.toContain("mn:ls:z:0");
    const a = await hang("древнее дело", 40, { now: MON_AM });
    await run(MON_AM);
    const more = await click("mn:more", MON_AM);
    const b = buttons(more).find((x) => x.custom_id === "mn:ls:z:0");
    expect(b?.label).toMatch(/Заморожено 1/);
    const list = await click("mn:ls:z:0", MON_AM);
    expect(String(list.data.content)).toContain("Древнее дело");
    const card = await click(`mn:it:${a.occId}:z:0`, MON_AM);
    const cid = ids(card);
    expect(cid.some((x) => x.startsWith("mn:fv:"))).toBe(true);
    expect(cid.some((x) => x.startsWith("mn:ed:"))).toBe(false);
    expect(cid.some((x) => x.startsWith("mn:dn:"))).toBe(false);
  });

  it("«Вернуть» восстанавливает дело как было и не замораживает его снова сразу", async () => {
    const a = await hang("древнее дело", 40, { now: MON_AM });
    const before = row(a.occId);
    await run(MON_AM);
    const back = await click(`mn:fv:${a.occId}:z:0`, MON_AM + 5 * MINUTE);
    expect(String(back.data.content)).toContain("Древнее дело");
    const r = row(a.occId);
    expect(r.state).toBe("overdue");
    expect(r.closed_at).toBeNull();
    expect(r.closed_reason).toBeNull();
    for (const k of ["due_at", "base_at", "fire_count", "snooze_count", "item_id", "kind"]) expect(r[k], k).toBe(before[k]);
    expect(r.touched_at).toBe(MON_AM + 5 * MINUTE);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE kind = 'unfrozen' AND occ_id = ?", a.occId)).toBe(1);
    await run(MON_AM + DAY); // на следующий день: до 30 дней далеко
    expect(row(a.occId).state).toBe("overdue");
    const open = await w.repo().openMain(100);
    expect(open.some((o) => o.id === a.occId)).toBe(true);
  });

  it("удалить замороженное из его карточки — насовсем (дело уходит и из «Заморожено»)", async () => {
    const a = await hang("древнее дело", 40, { now: MON_AM });
    await run(MON_AM);
    await click(`mn:dy:${a.itemId}:z:0`, MON_AM);
    expect(row(a.occId).closed_reason).toBe("delete");
    const list = await click("mn:ls:z:0", MON_AM);
    expect(String(list.data.content)).toMatch(/Здесь пусто|дел: 0/);
  });
});

describe("пулы фраз этапа 3", () => {
  it("для «тихой недели» и разбора есть фразы у пяти настроений (яндере говорит как цундере), без латиницы", () => {
    for (const s of ["tail_clear", "tail_review"] as const) {
      for (const m of ["tired", "tsundere", "sulking", "proud", "sleepy"]) {
        const pool = PHRASES[m][s] ?? [];
        expect(pool.length, `${m}.${s}`).toBeGreaterThanOrEqual(3);
        for (const t of pool) {
          expect(t.replace(/\{[a-z_]+\}/g, ""), t).not.toMatch(/[A-Za-z]/);
          expect(t.length).toBeLessThanOrEqual(160);
        }
      }
    }
  });
});
