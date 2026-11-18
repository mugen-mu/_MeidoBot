// Загрузка отметок из анкеты кладёт в таблицу anime сотни просмотренных и брошенных: ночное обновление, вечерняя сводка, вопрос недели
// и список не должны из-за этого ходить в Shikimori по каждому тайтлу или ломаться. Данные ВЫДУМАННЫЕ.
import { beforeEach, describe, expect, it } from "vitest";
import { type Anime, noticeSet, weekPicks } from "../src/anime/core.ts";
import { ANIME_PAGE, animeListMessage } from "../src/anime/ui.ts";
import { HOUR } from "../src/time/tz.ts";
import { type TasteList, buildRows, renderSql } from "../scripts/lib/tasteMarks.ts";
import { kyiv } from "./helpers.ts";
import { CH_REMIND, World } from "./world.ts";

const T = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);
const DAY = 24 * HOUR;
const SUN = T(15, 19, 10);

/** Как у настоящих данных: 1 «смотрю», 12 «в планах», 132 «просмотрено» (разные оценки), 49 «бросил». ids 5000+. */
function invented(): { lists: TasteList[]; titles: Map<number, { ru: string; orig: string | null; episodes: number | null }> } {
  const states: Record<string, string | string[]> = {};
  const titles = new Map<number, { ru: string; orig: string | null; episodes: number | null }>();
  let id = 5000;
  const add = (n: number, codes: (i: number) => string | string[]): void => {
    for (let i = 0; i < n; i++, id++) {
      states[String(id)] = codes(i);
      titles.set(id, { ru: `Тайтл ${String(id).padStart(4, "0")}`, orig: `Title ${id}`, episodes: null });
    }
  };
  add(1, () => ["like", "now"]);
  add(12, () => "plan");
  add(132, (i) => (["love", "like", "like", "meh", "seen", "dislike"] as const)[i % 6]);
  add(49, (i) => (i % 2 ? ["like", "drop"] : "drop"));
  add(260, () => "none"); // «не смотрел» — не загружаются
  return { lists: [{ kind: "anime2", states }], titles };
}

let w: World;
const rows = () => w.d1.q<Anime>("SELECT * FROM anime ORDER BY id");

beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off" } });
  const { lists, titles } = invented();
  const rep = buildRows(lists, titles);
  expect(rep.rows).toHaveLength(194);
  w.d1.sqlite.exec(renderSql(rep.rows, T(10, 1)));
});

describe("сотни загруженных тайтлов: нагрузка", () => {
  it("загружено 194 строки, а в «уведомления» попадает не больше пяти «Смотрю»; done/dropped туда не входят", () => {
    expect(rows()).toHaveLength(194);
    expect(noticeSet(rows())).toHaveLength(1);
    expect(rows().filter((a) => a.status === "done" || a.status === "dropped").every((a) => a.notify === 1)).toBe(true); // колокольчик у них не работает: уведомления только у «Смотрю»
  });

  it("ночное обновление: запросов в Shikimori не больше девяти за ночь (календарь + 8 добора), на просмотренные и брошенные — ни одного", async () => {
    // Shikimori знает и «в планах» (вышло), и «смотрю»
    for (const a of rows().filter((r) => r.status === "planned" || r.status === "watching")) {
      w.shikiById[a.mal_id] = { id: a.mal_id, russian: a.title_ru, name: a.title_orig, kind: "tv", status: "released", episodes: 12, episodes_aired: 12, aired_on: "2020-01-01" };
    }
    const f0 = w.animeFetches;
    await w.run(T(10, 3, 5));
    expect(w.animeFetches - f0).toBeLessThanOrEqual(9);
    expect(w.animeFetches - f0).toBeGreaterThanOrEqual(2);
    const night1 = w.animeFetches;
    await w.run(T(11, 3, 5));
    expect(w.animeFetches - night1).toBeLessThanOrEqual(9);
    const night2 = w.animeFetches;
    await w.run(T(12, 3, 5)); // всё живое уже обновлено и закончилось: запросов нет
    await w.run(T(13, 3, 5));
    expect(w.animeFetches - night2).toBe(0);
    // обновились только «Смотрю»/«В планах»; у done/dropped расписания нет и не будет
    expect(rows().filter((a) => a.status === "done" || a.status === "dropped").every((a) => a.src_status === null)).toBe(true);
    expect(rows().filter((a) => a.status === "planned").every((a) => a.src_status === "FINISHED")).toBe(true);
  });

  it("законченные «В планах» не занимают места добора: новый тайтл обновляется в ту же ночь", async () => {
    w.d1.sqlite.exec("UPDATE anime SET src_status = 'FINISHED' WHERE status = 'planned'"); // дюжина давно известных законченных
    w.d1.sqlite.exec(`INSERT INTO anime (mal_id, title_ru, status, added_at, updated_at) VALUES (9999, 'Новый анонс', 'planned', ${T(10, 2)}, ${T(10, 2)})`);
    w.shikiById[9999] = { id: 9999, russian: "Новый анонс", name: "New", kind: "tv", status: "anons", episodes: 12, episodes_aired: 0, next_episode_at: new Date(T(20, 19)).toISOString(), aired_on: "2026-12-01" };
    const f0 = w.animeFetches;
    await w.run(T(10, 3, 5));
    expect(w.animeFetches - f0).toBeLessThanOrEqual(3); // календарь + он один
    const fresh = rows().find((a) => a.mal_id === 9999);
    expect(fresh).toMatchObject({ src_status: "NOT_YET_RELEASED", next_ep: 1 });
  });

  it("вечерняя сводка с сотнями строк: без запросов в источник, не падает", async () => {
    await w.run(T(10, 3, 5)); // ночное обновление этих суток уже прошло
    const f0 = w.animeFetches;
    await w.run(T(10, 20, 5));
    expect(w.animeFetches).toBe(f0);
    expect(w.discord.posted.some((p) => p.channel === CH_REMIND && p.body.content?.includes("Вечерняя сводка"))).toBe(true);
  });

  it("воскресный вопрос недели: не больше трёх запросов за раз, про продолжения спрашивают сначала самых любимых; «не зашло» не трогают", async () => {
    w.d1.sqlite.exec("UPDATE anime SET status = 'done' WHERE status = 'watching'"); // чтобы не было вопроса «продолжаем?»
    await w.run(SUN);
    expect(w.relatedFetches).toBeLessThanOrEqual(3);
    const checked = rows().filter((a) => a.seq_at !== null);
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.length).toBeLessThanOrEqual(3);
    expect(checked.every((a) => a.liked === 2)).toBe(true);
    // ещё несколько воскресений подряд: у «не зашло» и «так себе» продолжения так и не проверяются
    for (let k = 1; k <= 6; k++) await w.run(SUN + 7 * k * DAY);
    expect(w.relatedFetches).toBeLessThanOrEqual(3 * 7);
    expect(rows().filter((a) => a.liked < 0).every((a) => a.seq_at === null)).toBe(true);
    // вопросов за воскресенье — не больше одного
    expect(w.discord.posted.filter((p) => p.channel === CH_REMIND && p.body.content?.includes("Между прочим")).length).toBeLessThanOrEqual(7);
  });

  it("вопрос «понравилось?» не лезет к тем, у кого оценка уже есть, и задаётся про безоценочные", () => {
    const p = weekPicks(rows(), SUN);
    expect(p.liked?.liked).toBe(0);
    expect(p.liked?.status).toBe("done");
    expect(p.seq).toHaveLength(3);
  });
});

describe("сотни загруженных тайтлов: список", () => {
  it("«Просмотрено»: на первой странице самые любимые по алфавиту; «Бросил» — тоже; без «серия 0»", () => {
    const done = animeListMessage(rows(), "done", 0, SUN, "Europe/Kyiv", "neutral");
    const text = done.content as string;
    expect(text).toContain("(132)");
    expect(text).toContain(`страница 1 из ${Math.ceil(132 / ANIME_PAGE)}`);
    const lines = text.split("\n").filter((l) => /^\*\*\d\./.test(l));
    expect(lines).toHaveLength(ANIME_PAGE);
    expect(lines.every((l) => l.includes("🔥"))).toBe(true);
    expect(lines.map((l) => /Тайтл (\d{4})/.exec(l)![1])).toEqual([...lines.map((l) => /Тайтл (\d{4})/.exec(l)![1])].sort());
    expect(text).not.toContain("серия 0");
    const dropped = animeListMessage(rows(), "dropped", 0, SUN, "Europe/Kyiv", "neutral").content as string;
    expect(dropped).toContain("(49)");
    expect(dropped).not.toContain("остановился на 0");
    // последняя страница «Просмотрено»: хвост — «не зашло» и «так себе» последними
    const lastPage = animeListMessage(rows(), "done", Math.ceil(132 / ANIME_PAGE) - 1, SUN, "Europe/Kyiv", "neutral").content as string;
    expect(lastPage).toMatch(/👎|—/);
  });
});
