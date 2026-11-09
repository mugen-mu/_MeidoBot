// Аниме, выкладка 2: озвучка AniLibria, «между прочим» (воскресенье вечером), начало сезона.
import { beforeEach, describe, expect, it } from "vitest";
import { type Anime, lagText, seasonStart, voiceAverage, voiceObservation, weekPicks } from "../src/anime/core.ts";
import { parseVoice } from "../src/anime/sources.ts";
import { type Interaction, handleInteraction } from "../src/discord/interactions.ts";
import { HOUR, MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { setSetting } from "../src/db/repo.ts";
import { CH_REMIND, OWNER, World } from "./world.ts";

const T = (d: number, h: number, mi = 0) => kyiv(2026, 11, d, h, mi);
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const SUN = T(15, 19, 10); // воскресенье, 19:10
const shiki = (id: number, ru: string, name: string, o: Record<string, unknown> = {}) => ({ id, russian: ru, name, kind: "tv", status: "ongoing", episodes: 12, aired_on: "2026-10-08", ...o });

type R = { type: number; data?: any };
let w: World;
let seq = 0;
let nowCall = SUN;

async function call(i: Partial<Interaction>): Promise<R> {
  const pending: Promise<unknown>[] = [];
  const r = await handleInteraction(
    { id: String(++seq), token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c-other", member: { user: { id: OWNER } }, type: 3, message: { id: "m1" }, ...i } as Interaction,
    {
      repo: w.repo(),
      api: w.discord,
      now: nowCall,
      env: {},
      defer: (p) => void pending.push(p),
      fetchFn: (async (u: unknown) => {
        const one = /\/api\/animes\/(\d+)$/.exec(String(u));
        return one && w.shikiById[Number(one[1])] ? Response.json(w.shikiById[Number(one[1])]) : new Response("n", { status: 404 });
      }) as unknown as typeof fetch,
    },
  );
  await Promise.all(pending);
  return r as R;
}
const click = (custom_id: string) => call({ data: { custom_id } });
const rows = () => w.d1.q<Anime>("SELECT * FROM anime ORDER BY id");
const meta = (k: string) => w.d1.q<{ value: string }>("SELECT value FROM meta WHERE key = ?", k)[0]?.value;
const remind = () => w.discord.posted.filter((p) => p.channel === CH_REMIND);
const weekMsgs = () => remind().filter((p) => p.body.content?.includes("Между прочим"));
const btnIds = (p: { body: { components?: { components: { custom_id?: string }[] }[] } }) => (p.body.components ?? []).flatMap((r) => r.components.map((c) => c.custom_id));

/** Строка «Смотрю»: серия, вышло, давность последнего движения. */
function addWatching(id: number, o: { watched: number; aired: number; idleDays: number; notify?: number; title?: string }): void {
  w.d1.sqlite.exec(
    `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, next_ep, next_at, aired_ep, aired_at, asked_ep, notify, added_at, updated_at, last_move_at)
     VALUES (${id}, '${o.title ?? `Тайтл ${id}`}', 'watching', ${o.watched}, 24, 'RELEASING', ${o.aired + 1}, ${SUN + 5 * DAY}, ${o.aired}, ${SUN - 3 * DAY}, ${o.aired}, ${o.notify ?? 1}, 0, 0, ${SUN - o.idleDays * DAY})`,
  );
}
function addOther(id: number, status: "done" | "planned", o: { liked?: number; addedDaysAgo?: number; title?: string } = {}): void {
  w.d1.sqlite.exec(
    `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, liked, added_at, updated_at)
     VALUES (${id}, '${o.title ?? `Тайтл ${id}`}', '${status}', ${status === "done" ? 12 : 0}, 12, 'FINISHED', ${o.liked ?? 0}, ${SUN - (o.addedDaysAgo ?? 3) * DAY}, ${SUN - (o.addedDaysAgo ?? 3) * DAY})`,
  );
}

beforeEach(async () => {
  w = new World();
  nowCall = SUN;
  await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off" } });
});

describe("озвучка: чистые функции", () => {
  it("время словами, с шагом в полчаса", () => {
    expect(lagText(40)).toBe("~40 мин");
    expect(lagText(60)).toBe("~1 час");
    expect(lagText(150)).toBe("~2,5 часа");
    expect(lagText(300)).toBe("~5 часов");
    expect(lagText(12 * 60)).toBe("~12 часов");
    expect(lagText(22 * 60)).toBe("~22 часа");
  });

  it("замер: серии должны совпасть, время известно, разница правдоподобна; среднее весит прежние замеры", () => {
    const a = { id: 1, status: "watching", watched: 6, next_ep: 8, next_at: T(21, 19), aired_ep: 7, aired_at: T(14, 19), voice_ep: 0 } as Anime;
    const v = (nextEp: number | null, fresh: number | null) => ({ mal: 1, freshAt: fresh, nextEp, ongoing: true });
    expect(voiceObservation(a, v(8, T(14, 19) + 150 * MINUTE), T(15, 12))).toBe(150);
    expect(voiceObservation(a, v(7, T(14, 19) + 150 * MINUTE), T(15, 12))).toBeNull(); // озвучена только 6-я
    expect(voiceObservation(a, v(8, T(14, 19) - MINUTE), T(15, 12))).toBeNull(); // раньше выхода — не замер
    expect(voiceObservation(a, v(8, T(14, 19) + 4 * DAY), T(15, 12))).toBeNull(); // дольше трёх суток — не «обычная» задержка
    expect(voiceObservation(a, v(null, T(14, 19) + HOUR), T(15, 12))).toBeNull();
    expect(voiceObservation({ ...a, voice_ep: 7 }, v(8, T(14, 19) + HOUR), T(15, 12))).toBeNull(); // уже мерили
    expect(voiceObservation({ ...a, aired_at: null }, v(8, T(14, 19) + HOUR), T(15, 12))).toBeNull(); // время выхода неизвестно
    expect(voiceAverage(null, 0, 100)).toBe(100);
    expect(voiceAverage(100, 1, 200)).toBe(150);
    expect(voiceAverage(100, 3, 200)).toBe(125);
  });

  it("разбор ответа AniLibria терпит пропуски", () => {
    expect(parseVoice({})).toBeNull();
    const out = parseVoice([{ release: { mal: { id: 5 }, fresh_at: "2026-11-08T01:05:12+00:00", is_ongoing: true }, next_release_episode_number: 19 }, { release: {} }, null]);
    expect(out).toEqual([{ mal: 5, freshAt: Date.parse("2026-11-08T01:05:12+00:00"), nextEp: 19, ongoing: true }]);
  });
});

describe("озвучка в cron: замер ночью, строка вечером", () => {
  beforeEach(() => {
    // 7-я серия вышла в субботу 14-го в 19:00; следующая — в субботу 21-го; AniLibria озвучила 7-ю через 2,5 часа
    w.d1.sqlite.exec(
      `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, next_ep, next_at, aired_ep, aired_at, asked_ep, added_at, updated_at)
       VALUES (10, 'Меч', 'watching', 7, 24, 'RELEASING', 8, ${T(21, 19)}, 7, ${T(14, 19)}, 7, 0, 0),
              (11, 'Без озвучки', 'watching', 3, 24, 'RELEASING', 4, ${T(21, 19)}, 3, ${T(14, 19)}, 3, 0, 0)`,
    );
    w.voice = [{ release: { mal: { id: 10 }, fresh_at: iso(T(14, 19) + 150 * MINUTE), is_ongoing: true, publish_day: { value: 6 } }, next_release_episode_number: 8 }];
  });

  it("раз в сутки, отдельным запуском после расписания; тайтлу не из AniLibria — ничего", async () => {
    await w.run(T(16, 3, 5));
    expect(w.voiceFetches).toBe(0); // расписание — один запуск, озвучка — следующий
    await w.run(T(16, 3, 15));
    expect(w.voiceFetches).toBe(1);
    expect(rows()[0]).toMatchObject({ voice_lag: 150, voice_n: 1, voice_ep: 7 });
    expect(rows()[1].voice_lag).toBeNull();
    await w.run(T(16, 3, 30));
    await w.run(T(16, 12, 0));
    expect(w.voiceFetches).toBe(1);
  });

  it("вечером под серией — «озвучка обычно через …», у тайтла без озвучки строки нет; в карточке тоже", async () => {
    await w.run(T(16, 3, 5));
    await w.run(T(16, 3, 15));
    w.d1.sqlite.exec(`UPDATE anime SET next_ep = 8, next_at = ${T(16, 21)} WHERE id IN (1, 2)`);
    await w.run(T(16, 20, 5));
    const s = w.discord.posted.find((p) => p.body.content?.includes("Вечерняя сводка"));
    expect(s?.body.content).toContain("21:00 Меч — 8-я серия");
    expect(s?.body.content).toContain("озвучка AniLibria обычно через ~2,5 часа");
    expect(s?.body.content?.match(/озвучка AniLibria/g)).toHaveLength(1);
    const card = await click("an:it:1:w:0");
    expect(card.data.content).toContain("Озвучка AniLibria обычно через ~2,5 часа");
    expect((await click("an:it:2:w:0")).data.content).not.toContain("Озвучка");
  });

  it("AniLibria не отвечает: три попытки за день, сообщений нет, до завтра не пробуем", async () => {
    w.voice = null;
    await w.run(T(16, 3, 5));
    for (const [h, m] of [[3, 15], [4, 20], [5, 25], [6, 30], [12, 0]]) await w.run(T(16, h, m));
    expect(w.voiceFetches).toBe(3);
    expect(remind().filter((p) => p.body.content?.includes("AniLibria"))).toHaveLength(0);
    w.voice = [];
    await w.run(T(17, 3, 5));
    await w.run(T(17, 3, 15));
    expect(w.voiceFetches).toBe(4);
  });
});

describe("«между прочим»: выбор вопроса", () => {
  it("по ситуации: давно не двигал → продолжать ли; чуть меньше → на какой серии; пауза не тревожит", () => {
    const mk = (id: number, o: Partial<Anime>): Anime => ({ id, mal_id: id, status: "watching", watched: 5, notify: 1, liked: 0, episodes: 12, src_status: "RELEASING", next_ep: 9, next_at: SUN + DAY, aired_ep: 8, aired_at: SUN - DAY, added_at: 0, updated_at: 0, last_move_at: SUN - 10 * DAY, weekq_at: null, seq_at: null, ...o }) as Anime;
    expect(weekPicks([mk(1, {})], SUN).ep?.id).toBe(1);
    expect(weekPicks([mk(1, { last_move_at: SUN - 30 * DAY })], SUN)).toMatchObject({ cont: { id: 1 }, ep: null });
    expect(weekPicks([mk(1, { last_move_at: SUN - 2 * DAY })], SUN).ep).toBeNull();
    expect(weekPicks([mk(1, { notify: 0 })], SUN).ep).toBeNull();
    expect(weekPicks([mk(1, { watched: 8 })], SUN).ep).toBeNull(); // всё досмотрено — не за чем спрашивать
    expect(weekPicks([mk(1, { weekq_at: SUN - 5 * DAY })], SUN).ep).toBeNull(); // недавно спрашивали
  });

  it("начало сезона: только сегодня, только из «В планах», один раз", () => {
    const a = { id: 1, status: "planned", next_ep: 1, next_at: T(15, 19), aired_ep: 0, aired_at: null, start_asked: 0 } as Anime;
    expect(seasonStart(a, T(15, 9), "Europe/Kyiv")).toBe(T(15, 19));
    expect(seasonStart({ ...a, next_at: T(16, 19) }, T(15, 9), "Europe/Kyiv")).toBeNull();
    expect(seasonStart({ ...a, start_asked: 1 }, T(15, 9), "Europe/Kyiv")).toBeNull();
    expect(seasonStart({ ...a, status: "watching" }, T(15, 9), "Europe/Kyiv")).toBeNull();
    // первая серия вышла этой ночью (02:30), расписание уже обновилось
    expect(seasonStart({ ...a, next_ep: 2, next_at: T(22, 2), aired_ep: 1, aired_at: T(15, 2, 30) }, T(15, 9), "Europe/Kyiv")).toBe(T(15, 2, 30));
    expect(seasonStart({ ...a, next_ep: 2, next_at: T(22, 2), aired_ep: 1, aired_at: T(10, 2, 30) }, T(15, 9), "Europe/Kyiv")).toBeNull();
  });
});

describe("«между прочим»: воскресный вопрос", () => {
  it("на какой серии: один вопрос в неделю, ответы кнопками", async () => {
    addWatching(1, { watched: 6, aired: 8, idleDays: 10, title: "Меч" });
    await w.run(T(15, 19, 5)); // рано
    expect(weekMsgs()).toHaveLength(0);
    await w.run(SUN);
    const q = weekMsgs();
    expect(q).toHaveLength(1);
    expect(q[0].body.content).toContain("6-й серии «Меч»");
    expect(btnIds(q[0])).toEqual(["an:wq:e:1:0", "an:wq:e:1:1", "an:wq:e:1:2"]);
    await w.run(T(15, 19, 11));
    await w.run(T(15, 21, 0));
    expect(weekMsgs()).toHaveLength(1);
    expect(meta("anime_week")).toBe("2026-11-15");
    expect(rows()[0].weekq_at).toBe(SUN);

    const r = await click("an:wq:e:1:1"); // «Уже на 7-й»
    expect(r.data.content).toContain("серия 7");
    expect(rows()[0].watched).toBe(7);
    expect(meta("anime_weekq")).toBeUndefined();
  });

  it("«Ещё ниже» открывает окно с номером; «Да, на 6-й» только подтверждает", async () => {
    addWatching(1, { watched: 6, aired: 8, idleDays: 10 });
    await w.run(SUN);
    const m = await click("an:wq:e:1:2");
    expect(m.type).toBe(9);
    expect(m.data.custom_id).toMatch(/^m_anep:1:/);
    expect(meta("anime_weekq")).toBeUndefined();
    const before = rows()[0].last_move_at;
    nowCall = SUN + HOUR;
    await click("an:wq:e:1:0");
    expect(rows()[0].watched).toBe(6);
    expect(rows()[0].last_move_at).toBeGreaterThan(before!);
  });

  it("не двигается три недели: «продолжаем?»; «Бросил» спрашивает причину, ответ записывается", async () => {
    addWatching(1, { watched: 2, aired: 8, idleDays: 25, title: "Небеса" });
    await w.run(SUN);
    const q = weekMsgs()[0];
    expect(q.body.content).toContain("«Небеса» не двигается уже 4 недели");
    expect(btnIds(q)).toEqual(["an:wq:c:1:c", "an:wq:c:1:p", "an:wq:c:1:d"]);
    const d = await click("an:wq:c:1:d");
    expect(rows()[0].status).toBe("dropped");
    expect(d.data.content).toContain("А почему?");
    expect(d.data.components[0].components.map((c: any) => c.custom_id)).toEqual(["an:wq:r:1:b", "an:wq:r:1:u", "an:wq:r:1:l", "an:wq:r:1:n", "an:wq:r:1:s"]);
    await click("an:wq:r:1:u");
    expect(rows()[0]).toMatchObject({ status: "dropped", drop_reason: "busy" });
    expect((await click("an:it:1:x:0")).data.content).toContain("Причина: не успеваю");
  });

  it("«Продолжаю» сбрасывает счёт, «Пауза» выключает уведомления и больше не тревожит", async () => {
    addWatching(1, { watched: 2, aired: 8, idleDays: 25 });
    await w.run(SUN);
    await click("an:wq:c:1:c");
    expect(rows()[0]).toMatchObject({ status: "watching", last_move_at: SUN });
    w.discord.posted.length = 0;
    w.d1.sqlite.exec(`UPDATE anime SET last_move_at = ${SUN - 40 * DAY}, weekq_at = NULL`);
    await click("an:wq:c:1:p");
    expect(rows()[0]).toMatchObject({ status: "watching", notify: 0 });
    expect(weekPicks(rows(), SUN + 7 * DAY).cont).toBeNull();
  });

  it("сезон досмотрен без отметки: «понравилось?»; «Так себе» запоминается, «Не хочу» больше не спрашивает", async () => {
    addOther(1, "done", { title: "Блич" });
    await w.run(SUN);
    const q = weekMsgs()[0];
    expect(q.body.content).toContain("«Блич» вам понравилось?");
    expect(btnIds(q)).toEqual(["an:wq:l:1:2", "an:wq:l:1:1", "an:wq:l:1:3", "an:wq:l:1:0"]);
    await click("an:wq:l:1:3");
    expect(rows()[0].liked).toBe(-1);
    expect((await click("an:it:1:d:0")).data.content).toContain("Отметка: так себе");
    // через неделю про тот же тайтл не спрашиваем
    w.d1.sqlite.exec("UPDATE anime SET liked = 0");
    nowCall = T(22, 19, 10);
    await w.run(T(22, 19, 10));
    expect(weekMsgs()).toHaveLength(1);
    await click("an:wq:l:1:2");
    expect(rows()[0].liked).toBe(2);
  });

  it("давний тайтл в «В планах» (полгода): «ещё хочется?»; «Уже нет» убирает", async () => {
    addOther(1, "planned", { addedDaysAgo: 200, title: "Давнее" });
    addOther(2, "planned", { addedDaysAgo: 20 });
    await w.run(SUN);
    const q = weekMsgs()[0];
    expect(q.body.content).toContain("«Давнее» лежит в «В планах» ещё с апреля");
    expect(btnIds(q)).toEqual(["an:wq:p:1:y", "an:wq:p:1:n"]);
    await click("an:wq:p:1:n");
    expect(rows().map((r) => r.mal_id)).toEqual([2]);
  });

  it("анонс продолжения: спросили, «Добавить» кладёт в планы; уже имеющееся продолжение не предлагаем", async () => {
    addOther(1, "done", { liked: 2, title: "Первый сезон" });
    w.shikiRelated[1] = [
      { relation: "Prequel", anime: shiki(5, "До", "Before", { status: "released" }) },
      { relation: "Sequel", anime: shiki(777, "Второй сезон", "Part 2", { status: "anons", episodes: 0 }) },
    ];
    w.shikiById[777] = shiki(777, "Второй сезон", "Part 2", { status: "anons", episodes: 0 });
    await w.run(SUN);
    const q = weekMsgs()[0];
    expect(q.body.content).toContain("у «Первый сезон» анонсировано продолжение: «Второй сезон»");
    expect(btnIds(q)).toEqual(["an:wq:q:777:y", "an:wq:q:777:n"]);
    expect(rows()[0].seq_at!).toBeGreaterThan(SUN + 100 * DAY);
    const r = await click("an:wq:q:777:y");
    expect(r.data.content).toContain("Записала");
    expect(rows().map((x) => [x.mal_id, x.status])).toEqual([[1, "done"], [777, "planned"]]);

    // у кого продолжение уже в коллекции — молчим (вопрос «понравилось?» не задаём: оценка уже стоит)
    const w2 = new World();
    w = w2;
    await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off" } });
    addOther(1, "done", { liked: 1 });
    addOther(777, "planned", { addedDaysAgo: 2 });
    w.shikiRelated[1] = [{ relation: "Sequel", anime: shiki(777, "Второй сезон", "Part 2", { status: "anons" }) }];
    await w.run(SUN);
    expect(weekMsgs()).toHaveLength(0);
    expect(rows()[0].seq_at).toBe(SUN);
  });

  it("порядок важности: «продолжаем?» → серия → продолжение → давний план → оценка; нечего спросить — тишина", async () => {
    addWatching(1, { watched: 6, aired: 8, idleDays: 10, title: "А" });
    addWatching(2, { watched: 2, aired: 8, idleDays: 25, title: "Б" });
    addOther(3, "done", { title: "В" });
    await w.run(SUN);
    expect(weekMsgs()[0].body.content).toContain("«Б» не двигается"); // давнее важнее
    expect(w.relatedFetches).toBe(0); // до поиска продолжений не дошли: сеть зря не трогаем

    const w2 = new World();
    w = w2;
    await w.seed({ intake: true, settings: { summary_morning: "09:00", summary_evening: "20:00", weekly: "off" } });
    addOther(1, "done", { liked: 1 });
    w.d1.sqlite.exec("UPDATE anime SET seq_at = " + SUN);
    await w.run(SUN);
    expect(weekMsgs()).toHaveLength(0);
    expect(meta("anime_week")).toBe("2026-11-15");
  });

  it("только в воскресенье вечером; не в тихие часы и не в «Я в отъезде»", async () => {
    addWatching(1, { watched: 6, aired: 8, idleDays: 10 });
    await w.run(T(14, 19, 10)); // суббота
    await w.run(T(15, 23, 30)); // воскресенье, позже окна
    expect(weekMsgs()).toHaveLength(0);
    await w.repo().exec([setSetting("away_until", String(SUN + 5 * MINUTE))]);
    await w.run(SUN);
    expect(weekMsgs()).toHaveLength(0);
    await w.repo().exec([setSetting("quiet_enabled", "1"), setSetting("quiet_from", "19:00"), setSetting("quiet_to", "19:30")]);
    await w.run(SUN + 10 * MINUTE);
    expect(weekMsgs()).toHaveLength(0);
    await w.run(SUN + 25 * MINUTE); // тихие часы кончились, окно ещё открыто
    expect(weekMsgs()).toHaveLength(1);
  });

  it("без ответа через сутки кнопки снимаются, на неделе второй раз не спрашиваем", async () => {
    addWatching(1, { watched: 6, aired: 8, idleDays: 10 });
    await w.run(SUN);
    const id = weekMsgs()[0].id;
    await w.run(SUN + 12 * HOUR);
    expect(w.discord.edits).toHaveLength(0);
    await w.run(SUN + DAY + MINUTE);
    expect(w.discord.edits).toHaveLength(1);
    expect(w.discord.edits[0]).toMatchObject({ id, channel: CH_REMIND });
    expect(w.discord.edits[0].body.components).toEqual([]);
    expect(meta("anime_weekq")).toBeUndefined();
    await w.run(SUN + DAY + 2 * MINUTE);
    expect(w.discord.edits).toHaveLength(1);
    expect(weekMsgs()).toHaveLength(1);
  });
});

describe("начало сезона", () => {
  beforeEach(() => {
    w.d1.sqlite.exec(
      `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, next_ep, next_at, aired_ep, asked_ep, added_at, updated_at)
       VALUES (10, 'Магия 2', 'planned', 0, 12, 'NOT_YET_RELEASED', 1, ${T(16, 19)}, 0, 0, 0, 0)`,
    );
  });
  const starts = () => remind().filter((p) => p.body.content?.includes("Начинается"));

  it("утром в день старта — одно отдельное сообщение с тремя кнопками, повторно не пишем", async () => {
    await w.run(T(15, 9, 5));
    await w.run(T(15, 9, 6));
    expect(starts()).toHaveLength(0); // старт завтра
    await w.run(T(16, 9, 5)); // утренняя сводка
    await w.run(T(16, 9, 6));
    expect(starts()).toHaveLength(1);
    expect(starts()[0].body.content).toContain("Магия 2");
    expect(starts()[0].body.content).toContain("Сегодня первая серия (в 19:00)");
    expect(btnIds(starts()[0])).toEqual(["an:ss:1:w", "an:ss:1:l", "an:ss:1:n"]);
    await w.run(T(16, 9, 7));
    await w.run(T(16, 12, 0));
    expect(starts()).toHaveLength(1);
    expect(rows()[0].start_asked).toBe(1);
    expect(meta("anime_start")).toBe("2026-11-16");
  });

  it("«Смотрю» переводит в «Смотрю» с уведомлениями; «Позже» оставляет; «Не буду» убирает", async () => {
    await w.run(T(16, 9, 5));
    await w.run(T(16, 9, 6));
    nowCall = T(16, 9, 10);
    const l = await click("an:ss:1:l");
    expect(l.data.content).toContain("остаётся в планах");
    expect(rows()[0].status).toBe("planned");
    const r = await click("an:ss:1:w");
    expect(r.data.content).toContain("Буду сообщать о новых сериях");
    expect(rows()[0]).toMatchObject({ status: "watching", notify: 1 });
    await click("an:ss:1:n");
    expect(rows()).toHaveLength(0);
  });

  it("шестой тайтл «Смотрю» — честно сказать, что уведомлений по нему не будет", async () => {
    w.d1.sqlite.exec("DELETE FROM anime");
    for (let i = 20; i < 25; i++) {
      w.d1.sqlite.exec(`INSERT INTO anime (mal_id, title_ru, status, watched, added_at, updated_at) VALUES (${i}, 'Т${i}', 'watching', 1, 0, 0)`);
    }
    w.d1.sqlite.exec(`INSERT INTO anime (mal_id, title_ru, status, watched, added_at, updated_at) VALUES (10, 'Шестой', 'planned', 0, 0, 0)`);
    nowCall = T(16, 9, 10);
    const r = await click(`an:ss:${rows().find((x) => x.mal_id === 10)!.id}:w`);
    expect(r.data.content).toContain("только по первым 5");
  });

  it("в «Я в отъезде» сообщения нет, день не сгорает: после возвращения напишет", async () => {
    await w.run(T(16, 9, 5));
    await w.repo().exec([setSetting("away_until", String(T(16, 9, 5) + 30 * MINUTE))]);
    await w.run(T(16, 9, 6));
    expect(starts()).toHaveLength(0);
    await w.run(T(16, 10, 0));
    await w.run(T(16, 10, 1));
    expect(starts()).toHaveLength(1);
  });

  it("в тихие часы не пишем", async () => {
    await w.repo().exec([setSetting("quiet_enabled", "1"), setSetting("quiet_from", "09:00"), setSetting("quiet_to", "09:30")]);
    await w.run(T(16, 9, 5));
    await w.run(T(16, 9, 6));
    expect(starts()).toHaveLength(0);
    await w.run(T(16, 9, 40));
    expect(starts()).toHaveLength(1);
  });
});

describe("подзапросы: пределы бесплатного плана (50 за запуск)", () => {
  it("воскресенье: вопрос + три поиска продолжений — сильно меньше предела", async () => {
    for (let i = 1; i <= 3; i++) addOther(i, "done", { liked: 1 });
    addOther(4, "done");
    const r = await w.run(SUN);
    expect(w.relatedFetches).toBe(3);
    expect(weekMsgs()).toHaveLength(1); // нашлась оценка: «понравилось?»
    expect(r.subrequests).toBeLessThanOrEqual(15);
  });

  it("утро старта: сводка + «посмотрели?» + два «начинается» за один запуск или два подряд — в пределе", async () => {
    w.d1.sqlite.exec(
      `INSERT INTO anime (mal_id, title_ru, status, watched, episodes, src_status, next_ep, next_at, aired_ep, asked_ep, added_at, updated_at)
       VALUES (10, 'А', 'planned', 0, 12, 'NOT_YET_RELEASED', 1, ${T(16, 19)}, 0, 0, 0, 0), (11, 'Б', 'planned', 0, 12, 'NOT_YET_RELEASED', 1, ${T(16, 20)}, 0, 0, 0, 0),
              (12, 'В', 'planned', 0, 12, 'NOT_YET_RELEASED', 1, ${T(16, 21)}, 0, 0, 0, 0)`,
    );
    const a = await w.run(T(16, 9, 5));
    const b = await w.run(T(16, 9, 6));
    const c = await w.run(T(16, 9, 7));
    expect(Math.max(a.subrequests, b.subrequests, c.subrequests)).toBeLessThanOrEqual(25);
    expect(remind().filter((p) => p.body.content?.includes("Начинается"))).toHaveLength(3); // два в первый запуск, третий в следующий
    expect(meta("anime_start")).toBe("2026-11-16");
  });
});
