// Аниме: оценка числом («Фрирен 9/10», «оценил Фрирен на 9», «оценка Фрирен 7», «поставил Фрирен 5»): шкала, осторожность, ответ (2026-11-18, волна 4 анкеты: «Да»).
// Без модели; без обращения («бот»/«аниме»/«Хару») — только про название из его списка, чужое остаётся обычным делом.
import { beforeEach, describe, expect, it } from "vitest";
import type { Anime } from "../src/anime/core.ts";
import { likedFromScore, parseAnimeDid, parseAnimeMark, scoreLabel } from "../src/anime/mark.ts";
import { parseAnimeAsk, parseAnimeSay } from "../src/anime/say.ts";
import { MINUTE } from "../src/time/tz.ts";
import { kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

describe("шкала: 9–10 в восторге, 7–8 понравилось, 5–6 так себе, 4 и ниже не зашло", () => {
  it.each([
    [10, 2], [9, 2], [9.5, 2], [8.9, 1], [8, 1], [7, 1], [6.9, -1], [6, -1], [5, -1], [4.9, -2], [4, -2], [1, -2], [0, -2],
  ])("%s → %s", (n, want) => {
    expect(likedFromScore(n)).toBe(want);
  });
  it("число для ответа: целое без запятой, дробное — с запятой", () => {
    expect([scoreLabel(9), scoreLabel(8.5), scoreLabel(10)]).toEqual(["9", "8,5", "10"]);
  });
});

describe("parseAnimeMark: оценка числом", () => {
  it.each([
    // «/10» и «из 10» — явная шкала, глагол не нужен
    ["Фрирен 9/10", { liked: 2, query: "Фрирен", prefixed: false, score: 9 }],
    ["Фрирен 10/10", { liked: 2, query: "Фрирен", prefixed: false, score: 10 }],
    ["Фрирен 9 / 10", { liked: 2, query: "Фрирен", prefixed: false, score: 9 }],
    ["Фрирен — 7/10", { liked: 1, query: "Фрирен", prefixed: false, score: 7 }],
    ["Фрирен: 6/10", { liked: -1, query: "Фрирен", prefixed: false, score: 6 }],
    ["Блич 3/10", { liked: -2, query: "Блич", prefixed: false, score: 3 }],
    ["Блич 8,5/10", { liked: 1, query: "Блич", prefixed: false, score: 8.5 }],
    ["Блич 8.5/10", { liked: 1, query: "Блич", prefixed: false, score: 8.5 }],
    ["Фрирен 8 из 10", { liked: 1, query: "Фрирен", prefixed: false, score: 8 }],
    ["фрирен 9 из 10!", { liked: 2, query: "фрирен", prefixed: false, score: 9 }],
    ["Фрирен, 5 из 10.", { liked: -1, query: "Фрирен", prefixed: false, score: 5 }],
    ["Класс превосходства 2 9/10", { liked: 2, query: "Класс превосходства 2", prefixed: false, score: 9 }],
    ["Фрирен 2 сезон 9/10", { liked: 2, query: "Фрирен", prefixed: false, season: 2, score: 9 }],
    // «оценка»
    ["оценка Фрирен 7", { liked: 1, query: "Фрирен", prefixed: false, score: 7 }],
    ["Оценка Фрирен: 9", { liked: 2, query: "Фрирен", prefixed: false, score: 9 }],
    ["оценка Блич 4", { liked: -2, query: "Блич", prefixed: false, score: 4 }],
    ["моя оценка Блич 6/10", { liked: -1, query: "Блич", prefixed: false, score: 6 }],
    ["оценка у Фрирен 8", { liked: 1, query: "Фрирен", prefixed: false, score: 8 }],
    ["Фрирен — оценка 8", { liked: 1, query: "Фрирен", prefixed: false, score: 8 }],
    ["Фрирен оценка 10", { liked: 2, query: "Фрирен", prefixed: false, score: 10 }],
    ["Блич, оценка: 5/10", { liked: -1, query: "Блич", prefixed: false, score: 5 }],
    // «оценил / поставил»: годится и голое число
    ["оценил Фрирен на 9", { liked: 2, query: "Фрирен", prefixed: false, score: 9 }],
    ["оценил Фрирен на 8 из 10", { liked: 1, query: "Фрирен", prefixed: false, score: 8 }],
    ["оценил Фрирен 9/10", { liked: 2, query: "Фрирен", prefixed: false, score: 9 }],
    ["оценила Блич на 4", { liked: -2, query: "Блич", prefixed: false, score: 4 }],
    ["поставил Фрирен 5", { liked: -1, query: "Фрирен", prefixed: false, score: 5 }],
    ["поставил Блич 10", { liked: 2, query: "Блич", prefixed: false, score: 10 }],
    ["поставил Блич на 7", { liked: 1, query: "Блич", prefixed: false, score: 7 }],
    ["поставил оценку Блич 3", { liked: -2, query: "Блич", prefixed: false, score: 3 }],
    ["поставил Фрирен 2 сезон на 9", { liked: 2, query: "Фрирен", prefixed: false, season: 2, score: 9 }],
    ["ставлю Блич 8", { liked: 1, query: "Блич", prefixed: false, score: 8 }],
    // «досмотрел» — ещё и «Просмотрено»
    ["досмотрел Фрирен, 9/10", { liked: 2, query: "Фрирен", prefixed: false, finished: true, score: 9 }],
    ["посмотрел Блич, оценка 6", { liked: -1, query: "Блич", prefixed: false, score: 6 }],
    // с обращением
    ["бот Фрирен 9/10", { liked: 2, query: "Фрирен", prefixed: true, score: 9 }],
    ["Хару, оценил Блич на 8", { liked: 1, query: "Блич", prefixed: true, score: 8 }],
    ["аниме оценка Блич 3", { liked: -2, query: "Блич", prefixed: true, score: 3 }],
  ])("«%s»", (text, want) => {
    expect(parseAnimeMark(text)).toEqual(want);
  });

  it.each([
    // голое число — не оценка (сезон, номер серии, год)
    "Фрирен 8", "Фрирен 2", "Фрирен 10", "Блич 5", "Фрирен 2 сезон", "Фрирен сезон 3", "Фрирен 24",
    // посмотрел — не «оценил»: голое число не оценка
    "посмотрел Фрирен 5", "досмотрел Фрирен 9",
    // шкала не та или число не оценка
    "Фрирен 11/10", "Фрирен 19/10", "Фрирен 100/10", "оценил Фрирен на 11", "оценил Фрирен на 100", "Фрирен 9/5", "Фрирен 9 из 12",
    // серия «5 из 10» и номер серии — это не оценка
    "Фрирен серия 5 из 10", "Фрирен 5 серия из 10", "оценил Фрирен 5 серию", "Фрирен 3 из 10 серий",
    // без названия и разговоры
    "9/10", "оценка 7", "оценил на 9", "бот 8 из 10", "это 9/10", "мне 8/10", "Хару, ты 9/10", "Хару, оценил меня на 9",
    // чужое
    "оценка сметы", "купить хлеб 3", "позвонить 9", "Фрирен\n9/10",
  ])("«%s» — не оценка", (text) => {
    expect(parseAnimeMark(text)).toBeNull();
  });

  it("«созвон 5 из 10» по виду оценка, но названия «созвон» нет в списке: в боте это остаётся делом (см. cron-тесты ниже)", () => {
    expect(parseAnimeMark("созвон 5 из 10")).toMatchObject({ query: "созвон", score: 5 });
  });

  it("слова по-прежнему работают как раньше, и вместе с числом — тоже понятно: число главнее", () => {
    expect(parseAnimeMark("Фрирен в восторге")).toEqual({ liked: 2, query: "Фрирен", prefixed: false });
    expect(parseAnimeMark("оценил Фрирен в восторге")).toEqual({ liked: 2, query: "Фрирен", prefixed: false });
    expect(parseAnimeMark("оценил Фрирен на 9")).toMatchObject({ liked: 2, score: 9 });
  });

  it("вопрос «оценка Фрирен» остаётся вопросом, а «оценка Фрирен 7» — уже оценка, а не вопрос про название «Фрирен 7»", () => {
    expect(parseAnimeDid("оценка Фрирен")).toEqual({ kind: "did", query: "фрирен", sure: false });
    expect(parseAnimeDid("моя оценка Фрирен?")).toEqual({ kind: "did", query: "фрирен", sure: false });
    expect(parseAnimeDid("оценка Фрирен 7")).toBeNull();
    expect(parseAnimeDid("бот, оценка Фрирен 7")).toBeNull();
    expect(parseAnimeDid("оценка Фрирен: 9/10")).toBeNull();
    expect(parseAnimeDid("что я поставил Фрирен")).toMatchObject({ query: "фрирен" });
  });

  it("другие живые фразы число не перехватывают", () => {
    expect(parseAnimeSay("поставил Фрирен 5")).toBeNull();
    expect(parseAnimeSay("оценка Фрирен 7")).toBeNull();
    expect(parseAnimeAsk("оценка Фрирен 7")).toBeNull();
    expect(parseAnimeSay("глянул последнюю серию Фрирен")).toMatchObject({ query: "Фрирен", latest: true });
  });
});

// ---------- в боте ----------

const D0 = kyiv(2026, 11, 9, 12, 0);
let w: World;
const anime = () => w.d1.q<Anime>("SELECT * FROM anime ORDER BY id");
const items = () => w.d1.q("SELECT 1 FROM items").length;
const replies = () => w.discord.posted.filter((p) => p.channel === CH_BOT);
const last = () => (replies().at(-1)?.body.content as string | undefined) ?? "";

async function say(text: string, at = D0 + MINUTE): Promise<void> {
  w.discord.say(CH_BOT, OWNER, text);
  await w.run(at);
}

beforeEach(async () => {
  w = new World();
  await w.seed({ intake: true, settings: { summary_morning: "off", summary_evening: "off", weekly: "off" } });
  w.d1.sqlite.exec(
    `INSERT INTO anime (mal_id, title_ru, title_orig, status, watched, episodes, src_status, next_ep, next_at, aired_ep, asked_ep, added_at, updated_at, liked)
       VALUES (1, 'Провожающая в последний путь Фрирен', 'Sousou no Frieren', 'watching', 4, 28, 'RELEASING', 7, ${kyiv(2026, 11, 9, 19, 0)}, 6, 6, 0, 0, 0),
              (2, 'Блич', 'Bleach', 'planned', 0, 12, 'FINISHED', NULL, NULL, 12, 0, 0, 0, 0),
              (3, 'ДжоДжо', 'JoJo', 'done', 12, 12, 'FINISHED', NULL, NULL, 12, 12, 0, 0, 1)`,
  );
  await w.run(D0); // первый запуск запоминает конец канала
});

describe("cron: оценка числом", () => {
  it("«Фрирен 9/10» — в восторге (2); ответ называет и отметку, и его число; дело не заводится", async () => {
    await say("Фрирен 9/10");
    expect(anime()[0].liked).toBe(2);
    expect(last()).toContain("Записала");
    expect(last()).toContain("🔥 в восторге (ваши 9 из 10)");
    expect(items()).toBe(0);
  });

  it("все четыре ступени шкалы: 8 из 10 → понравилось, поставил 5 → так себе, оценил на 3 → не зашло, оценка 10 → в восторге", async () => {
    await say("Блич 8 из 10");
    expect(anime()[1].liked).toBe(1);
    expect(last()).toContain("❤ понравилось (ваши 8 из 10)");
    await say("поставил Блич 5", D0 + 2 * MINUTE);
    expect(anime()[1].liked).toBe(-1);
    expect(last()).toContain("так себе (ваши 5 из 10)");
    await say("оценил Блич на 3", D0 + 3 * MINUTE);
    expect(anime()[1].liked).toBe(-2);
    expect(last()).toContain("👎 не зашло (ваши 3 из 10)");
    await say("оценка Блич 10", D0 + 4 * MINUTE);
    expect(anime()[1].liked).toBe(2);
    expect(items()).toBe(0);
  });

  it("оценка не трогает статус и серию, кроме «досмотрел»: «досмотрел Блич, 9/10» — ещё и «Просмотрено»", async () => {
    await say("оценил Фрирен на 7");
    expect(anime()[0]).toMatchObject({ liked: 1, status: "watching", watched: 4 });
    await say("досмотрел Блич, 9/10", D0 + 2 * MINUTE);
    expect(anime()[1]).toMatchObject({ liked: 2, status: "done", watched: 12 });
    expect(last()).toContain("Отметила как просмотренное");
  });

  it("то же число второй раз — «уже записано»", async () => {
    await say("Фрирен 8/10");
    await say("Фрирен 7 из 10", D0 + 2 * MINUTE); // та же ступень «понравилось»
    expect(last()).toContain("уже записано");
    expect(last()).toContain("(ваши 7 из 10)");
  });

  it("голое число — обычное дело, аниме не тронуто: «Фрирен 8», «Фрирен 2 сезон»", async () => {
    const before = JSON.stringify(anime());
    await say("Фрирен 8");
    await say("Фрирен 2 сезон", D0 + 2 * MINUTE);
    expect(JSON.stringify(anime())).toBe(before);
    expect(items()).toBe(2);
  });

  it("явная форма, но названия нет в списке — дело, как раньше: «созвон 5 из 10», «оценил смету на 7»", async () => {
    const before = JSON.stringify(anime());
    await say("созвон 5 из 10");
    await say("оценил смету на 7", D0 + 2 * MINUTE);
    expect(JSON.stringify(anime())).toBe(before);
    expect(items()).toBe(2);
  });

  it("чужое название без «бот» — дело, на Shikimori не ходим; с «Хару» — честно «в списке нет»", async () => {
    const fetches = w.animeFetches;
    await say("Нетакого 9/10");
    expect(items()).toBe(1);
    expect(w.animeFetches).toBe(fetches);
    await say("Хару, оценил Нетакого на 9", D0 + 2 * MINUTE);
    expect(last()).toContain("в вашем списке нет");
    expect(items()).toBe(1);
    expect(anime()).toHaveLength(3);
    expect(w.animeFetches).toBe(fetches);
  });

  it("«оценка Фрирен 7» — оценка, а «оценка Фрирен» — по-прежнему вопрос; «оценка сметы 5» остаётся делом", async () => {
    await say("оценка Фрирен 7");
    expect(anime()[0].liked).toBe(1);
    await say("оценка Фрирен", D0 + 2 * MINUTE);
    expect(last()).toContain("Оценка: ❤ понравилось");
    await say("оценка сметы 5", D0 + 3 * MINUTE);
    expect(items()).toBe(1);
  });

  it("с обращением и числом без названия в списке: «бот, оценка Нетакого 7» — честно «в списке нет», а не «Нетакого 7»", async () => {
    await say("бот, оценка Нетакого 7");
    expect(last()).toContain("в вашем списке нет");
    expect(last()).not.toContain("Нетакого 7");
    expect(items()).toBe(0);
  });
});
