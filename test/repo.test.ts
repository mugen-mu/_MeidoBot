import { beforeEach, describe, expect, it } from "vitest";
import { Counter, Repo, event, setMeta, setSetting, updateOcc } from "../src/db/repo.ts";
import { readSettings } from "../src/settings.ts";
import {
  cancelItemOps,
  doneOps,
  newItemOps,
  nextSeriesOps,
  rescheduleOps,
  scrubOps,
  snoozeOps,
} from "../src/service.ts";
import { parseInput } from "../src/time/parse.ts";
import { MINUTE } from "../src/time/tz.ts";
import { FakeD1 } from "./d1shim.ts";
import { NOW, TZ, kyiv } from "./helpers.ts";

const settings = readSettings([]);
let d1: FakeD1;
let repo: Repo;

async function create(text: string, now = NOW) {
  const parsed = parseInput(text, { now, tz: TZ });
  const { ops, mainIndex } = newItemOps({ parsed, source: "slash", settings, now });
  const res = await repo.exec(ops);
  return { itemId: Number(res[0].meta.last_row_id), occId: Number(res[mainIndex].meta.last_row_id), parsed };
}

beforeEach(() => {
  d1 = new FakeD1();
  repo = new Repo(d1.asD1, new Counter(50));
});

describe("база", () => {
  it("создание дела одной пачкой: дело, правило, срабатывание и «заранее»", async () => {
    const before = d1.calls;
    const { itemId, occId } = await create("каждый месяц 20-го оплатить ФОП заранее за 7, 3 и 1 день");
    expect(d1.calls - before).toBe(1); // один batch = один подзапрос
    expect(d1.q("SELECT kind, title FROM items WHERE id = ?", itemId)).toEqual([{ kind: "reminder", title: "Оплатить ФОП" }]);
    expect(d1.q("SELECT item_id FROM rules")).toEqual([{ item_id: itemId }]);
    const occ = d1.q<{ id: number; kind: string; lead_days: number | null }>("SELECT id, kind, lead_days FROM occurrences ORDER BY id");
    expect(occ.map((o) => [o.kind, o.lead_days])).toEqual([["main", null], ["lead", 7], ["lead", 3], ["lead", 1]]);
    expect(occ[0].id).toBe(occId);
  });

  it("«заранее», время которого уже прошло, не создаётся", async () => {
    await create("20 ноября оплатить заранее за 30 дней");
    expect(d1.q("SELECT 1 FROM occurrences WHERE kind = 'lead'")).toHaveLength(0);
  });

  it("дело без времени — черновик без срока", async () => {
    const { occId } = await create("купить хлеб");
    expect(d1.q("SELECT state, due_at, next_fire_at FROM occurrences WHERE id = ?", occId)).toEqual([
      { state: "draft", due_at: null, next_fire_at: null },
    ]);
  });

  it("batch атомарный: ошибка откатывает всю пачку", async () => {
    await expect(
      repo.exec([setMeta("a", "1"), { sql: "INSERT INTO nope VALUES (1)", params: [] }]),
    ).rejects.toThrow();
    expect(d1.q("SELECT * FROM meta WHERE key = 'a'")).toHaveLength(0);
  });

  it("prelude: замок, порядок, один подзапрос; повторный запуск не берёт то же", async () => {
    await create("через 5 минут первое");
    await create("через 5 минут критично второе");
    await create("через 90 минут позже");
    const t = NOW + 6 * MINUTE;
    const calls = d1.calls;
    const a = await repo.prelude(t, 35, "tok-a");
    expect(d1.calls - calls).toBe(1);
    expect(a.claimed.map((o) => o.title)).toEqual(["Второе", "Первое"]); // критичное первым
    expect(d1.q("SELECT value FROM meta WHERE key = 'alive_at'")).toEqual([{ value: String(t) }]);
    const b = await repo.prelude(t, 35, "tok-b");
    expect(b.claimed).toHaveLength(0); // под замком
    const c = await repo.prelude(t + 3 * MINUTE, 35, "tok-c"); // замок живёт 2 минуты
    expect(c.claimed).toHaveLength(2);
  });

  it("лимит числа за запуск", async () => {
    for (let i = 0; i < 5; i++) await create(`через 1 минуту дело ${i}`);
    const p = await repo.prelude(NOW + 2 * MINUTE, 3, "t");
    expect(p.claimed).toHaveLength(3);
  });

  it("счётчик подзапросов не даёт превысить лимит", async () => {
    const r = new Repo(d1.asD1, new Counter(2));
    await r.exec([setMeta("x", "1")]);
    await r.all("SELECT 1 AS a");
    await expect(r.all("SELECT 1 AS a")).rejects.toThrow(/лимит/);
  });

  it("настройки: запись и чтение", async () => {
    await repo.exec([setSetting("quiet_enabled", "1"), setSetting("summary_morning", "07:30"), setSetting("summary_evening", "off")]);
    const { settings: s } = await repo.loadConfig();
    expect(s.quietEnabled).toBe(true);
    expect(s.morning).toBe(450);
    expect(s.evening).toBeNull();
    expect(s.tz).toBe("Europe/Kyiv");
  });
});

describe("действия над делами", () => {
  it("следующее срабатывание ряда создаётся один раз", async () => {
    const { occId } = await create("каждый месяц 20-го оплатить ФОП заранее за 3 дня");
    const occ = (await repo.getOcc(occId))!;
    await repo.exec(nextSeriesOps(occ, NOW));
    await repo.exec(nextSeriesOps(occ, NOW)); // повтор не плодит дубли
    const mains = d1.q<{ due_at: number }>("SELECT due_at FROM occurrences WHERE kind = 'main' ORDER BY due_at");
    expect(mains.map((m) => m.due_at)).toEqual([kyiv(2026, 11, 20, 9), kyiv(2026, 12, 20, 9)]);
    expect(d1.q("SELECT 1 FROM occurrences WHERE kind = 'lead'")).toHaveLength(2); // 17 нояб и 17 дек
  });

  it("таймер: следующее срабатывание — после «сейчас», пропущенные не копятся", async () => {
    const { occId } = await create("каждые 20 минут плита");
    const occ = (await repo.getOcc(occId))!;
    await repo.exec(nextSeriesOps(occ, NOW + 5 * 3600_000));
    const next = d1.q<{ due_at: number }>("SELECT due_at FROM occurrences WHERE id <> ?", occId);
    expect(next).toEqual([{ due_at: NOW + 5 * 3600_000 + 20 * MINUTE }]); // сетка :20, :40, :00 не сбивается
  });

  it("«Готово» закрывает дело и его «заранее», но не «заранее» следующего срока", async () => {
    const { occId } = await create("каждый месяц 20-го оплатить заранее за 3 дня");
    const occ = (await repo.getOcc(occId))!;
    await repo.exec(nextSeriesOps(occ, NOW));
    await repo.exec(doneOps(occ, NOW + 1000));
    expect(d1.q("SELECT state FROM occurrences WHERE id = ?", occId)).toEqual([{ state: "done" }]);
    const leads = d1.q<{ state: string; due_at: number }>("SELECT state, due_at FROM occurrences WHERE kind = 'lead' ORDER BY due_at");
    expect(leads.map((l) => l.state)).toEqual(["done", "planned"]);
    expect(d1.q("SELECT kind FROM events")).toEqual([{ kind: "done" }]);
  });

  it("отложить: лестница от нового времени, счётчик +1", async () => {
    const { occId } = await create("через 5 минут позвонить");
    const occ = (await repo.getOcc(occId))!;
    await repo.exec(snoozeOps(occ, NOW + 60 * MINUTE, NOW));
    const o = (await repo.getOcc(occId))!;
    expect([o.state, o.snooze_count, o.fire_count, o.next_fire_at, o.base_at]).toEqual([
      "snoozed", 1, 0, NOW + 60 * MINUTE, NOW + 60 * MINUTE,
    ]);
    expect(o.due_at).toBe(NOW + 5 * MINUTE); // срок остаётся исходным
  });

  it("черновик становится запланированным", async () => {
    const { occId } = await create("купить хлеб");
    await repo.exec(rescheduleOps((await repo.getOcc(occId))!, NOW + 3600_000, NOW));
    const o = (await repo.getOcc(occId))!;
    expect([o.state, o.next_fire_at]).toEqual(["planned", NOW + 3600_000]);
  });

  it("отмена дела закрывает все срабатывания серии и архивирует дело", async () => {
    const { itemId, occId } = await create("каждый день в 9 таблетки");
    await repo.exec(nextSeriesOps((await repo.getOcc(occId))!, NOW));
    await repo.exec(cancelItemOps(itemId, NOW));
    expect(d1.q("SELECT DISTINCT state FROM occurrences")).toEqual([{ state: "cancelled" }]);
    expect(d1.q<{ archived_at: number }>("SELECT archived_at FROM items")[0].archived_at).toBe(NOW);
    expect(await repo.openMain()).toHaveLength(0);
  });

  it("стирание текста закрытых дел через 90 дней", async () => {
    const { occId } = await create("через 5 минут секретное дело");
    await repo.exec(doneOps((await repo.getOcc(occId))!, NOW));
    await repo.exec(scrubOps(NOW + 89 * 86400_000));
    expect(d1.q<{ title: string }>("SELECT title FROM items")[0].title).toBe("Секретное дело");
    await repo.exec(scrubOps(NOW + 91 * 86400_000));
    expect(d1.q("SELECT title, scrubbed_at FROM items")[0].title).toBe("(стёрто)");
  });

  it("журнал событий не содержит текста дел", async () => {
    const { occId } = await create("через 5 минут очень личное название");
    await repo.exec([event(NOW, "sent", occId, "n=1"), updateOcc(occId, { fire_count: 1 })]);
    const text = JSON.stringify(d1.q("SELECT * FROM events"));
    expect(text).not.toContain("личное");
  });
});
