// Аниме: отметка фразой («Фрирен в восторге», «поставил Блич понравилось», «Блич не зашло») и вопрос «смотрел ли я Фрирен» (2026-11-18).
// Без модели; без обращения («бот»/«аниме»/«Хару») — только про название из его списка, чужое остаётся обычным делом.
import { beforeEach, describe, expect, it } from "vitest";
import { type Anime, likeMark, likeWords, weekPicks } from "../src/anime/core.ts";
import { parseAnimeDid, parseAnimeMark } from "../src/anime/mark.ts";
import { parseAnimeAsk, parseAnimeSay } from "../src/anime/say.ts";
import { animeCardMessage, animeListMessage } from "../src/anime/ui.ts";
import { listAnime } from "../src/anime/store.ts";
import { MINUTE } from "../src/time/tz.ts";
import { parseTasksQuestion } from "../src/tasksAsk.ts";
import { kyiv } from "./helpers.ts";
import { CH_BOT, OWNER, World } from "./world.ts";

describe("parseAnimeMark: как он ставит отметку", () => {
  it.each([
    // отметка в конце
    ["Фрирен в восторге", { liked: 2, query: "Фрирен", prefixed: false }],
    ["фрирен в восторге!", { liked: 2, query: "фрирен", prefixed: false }],
    ["Фрирен в полном восторге", { liked: 2, query: "Фрирен", prefixed: false }],
    ["Фрирен обожаю", { liked: 2, query: "Фрирен", prefixed: false }],
    ["Фрирен — обожаю", { liked: 2, query: "Фрирен", prefixed: false }],
    ["Фрирен: шедевр", { liked: 2, query: "Фрирен", prefixed: false }],
    ["Фрирен понравилось", { liked: 1, query: "Фрирен", prefixed: false }],
    ["Блич понравился", { liked: 1, query: "Блич", prefixed: false }],
    ["Блич мне понравился", { liked: 1, query: "Блич", prefixed: false }],
    ["Блич зашёл", { liked: 1, query: "Блич", prefixed: false }],
    ["Фрирен зашло", { liked: 1, query: "Фрирен", prefixed: false }],
    ["Фрирен так себе", { liked: -1, query: "Фрирен", prefixed: false }],
    ["Фрирен, так себе.", { liked: -1, query: "Фрирен", prefixed: false }],
    ["Блич средне", { liked: -1, query: "Блич", prefixed: false }],
    ["Блич не очень", { liked: -1, query: "Блич", prefixed: false }],
    ["Фрирен не зашло", { liked: -2, query: "Фрирен", prefixed: false }],
    ["Блич не зашёл", { liked: -2, query: "Блич", prefixed: false }],
    ["Блич не понравился", { liked: -2, query: "Блич", prefixed: false }],
    ["Фрирен не понравилось", { liked: -2, query: "Фрирен", prefixed: false }],
    ["Блич — не понравилось", { liked: -2, query: "Блич", prefixed: false }],
    // отметка в начале
    ["мне понравился Блич", { liked: 1, query: "Блич", prefixed: false }],
    ["Мне не зашла Фрирен", { liked: -2, query: "Фрирен", prefixed: false }],
    ["обожаю Блич", { liked: 2, query: "Блич", prefixed: false }],
    ["в восторге от Блич", { liked: 2, query: "Блич", prefixed: false }],
    // с глаголом
    ["поставил Фрирен понравилось", { liked: 1, query: "Фрирен", prefixed: false }],
    ["поставил Фрирен в восторге", { liked: 2, query: "Фрирен", prefixed: false }],
    ["поставил Фрирен как понравилось", { liked: 1, query: "Фрирен", prefixed: false }],
    ["поставил оценку Фрирен — не зашло", { liked: -2, query: "Фрирен", prefixed: false }],
    ["оценил Блич в восторге", { liked: 2, query: "Блич", prefixed: false }],
    ["поставила Блич так себе", { liked: -1, query: "Блич", prefixed: false }],
    ["поставил Фрирен 2 сезон в восторге", { liked: 2, query: "Фрирен", prefixed: false, season: 2 }],
    // «досмотрел» — это ещё и «Просмотрено»; «посмотрел» статус не трогает
    ["досмотрел Фрирен, в восторге", { liked: 2, query: "Фрирен", prefixed: false, finished: true }],
    ["посмотрел Блич, понравилось", { liked: 1, query: "Блич", prefixed: false }],
    // с обращением
    ["бот Фрирен в восторге", { liked: 2, query: "Фрирен", prefixed: true }],
    ["Хару, Блич не зашло", { liked: -2, query: "Блич", prefixed: true }],
    ["аниме поставил Блич понравилось", { liked: 1, query: "Блич", prefixed: true }],
  ])("«%s»", (text, want) => {
    expect(parseAnimeMark(text)).toEqual(want);
  });

  it.each([
    "", "   ", "понравилось", "мне понравилось", "в восторге", "обожаю", "не зашло", "бот", "купить хлеб", "позвонить маме завтра",
    "Фрирен", "Фрирен надоело", "забил на Фрирен", "посмотрел Фрирен", // другие живые фразы — не отметки
    "обожаю тебя", "Хару, обожаю тебя", "Хару, ты мне не понравилась", "это понравилось", "мне это не зашло",
    "посмотрел 5 серию Фрирен в восторге", // номер серии в такой фразе не поддерживаем: пусть остаётся делом
    "харуки обожаю блич", "Фрирен\nв восторге", `очень длинное название ${"слово ".repeat(14)} в восторге`,
  ])("«%s» — не отметка", (text) => {
    expect(parseAnimeMark(text)).toBeNull();
  });

  it("не мешает прежним фразам: они по-прежнему разбираются как раньше", () => {
    expect(parseAnimeSay("забил на ДжоДжо")).toMatchObject({ status: "dropped", query: "ДжоДжо" });
    expect(parseAnimeSay("Фрирен надоело")).toMatchObject({ status: "dropped" });
    expect(parseAnimeSay("Фрирен в восторге")).toBeNull(); // это отметка, а не статус
    expect(parseAnimeSay("Фрирен не зашло")).toBeNull();
  });
});

describe("parseAnimeDid: «смотрел ли я», «что я поставил»", () => {
  it.each([
    ["смотрел ли я Фрирен", { kind: "did", query: "фрирен", sure: true }],
    ["Смотрел ли я Фрирен?", { kind: "did", query: "фрирен", sure: true }],
    ["смотрел ли я Блич", { kind: "did", query: "блич", sure: true }],
    ["видел ли я Блич?", { kind: "did", query: "блич", sure: true }],
    ["смотрела ли я аниме Блич", { kind: "did", query: "блич", sure: true }],
    ["Хару, смотрел ли я Блич", { kind: "did", query: "блич", sure: true }],
    ["смотрел ли я класс превосходства 2 сезон", { kind: "did", query: "класс превосходства", sure: true, season: 2 }],
    ["понравился ли мне Блич", { kind: "did", query: "блич", sure: true }],
    ["на какой серии Фрирен", { kind: "did", query: "фрирен", sure: true }],
    ["на какой я серии Фрирен", { kind: "did", query: "фрирен", sure: true }],
    ["где я остановился в Фрирен", { kind: "did", query: "фрирен", sure: false }],
    ["что я поставил Фрирен", { kind: "did", query: "фрирен", sure: false }],
    ["что я поставил на Фрирен?", { kind: "did", query: "фрирен", sure: false }],
    ["что поставил Блич", { kind: "did", query: "блич", sure: false }],
    ["какую оценку я поставил Блич", { kind: "did", query: "блич", sure: false }],
    ["какая у меня оценка у Фрирен", { kind: "did", query: "фрирен", sure: false }],
    ["как я оценил Блич?", { kind: "did", query: "блич", sure: false }],
    ["оценка Фрирен", { kind: "did", query: "фрирен", sure: false }],
    ["моя оценка Фрирен?", { kind: "did", query: "фрирен", sure: false }],
    ["Фрирен я смотрел?", { kind: "did", query: "фрирен", sure: false }],
    ["бот, что я поставил Фрирен", { kind: "did", query: "фрирен", sure: true }], // с обращением — «в списке нет», если нет
  ])("«%s»", (text, want) => {
    expect(parseAnimeDid(text)).toEqual(want);
  });

  it.each([
    "", "смотрел ли я", "смотрел ли", "я смотрел Фрирен", "купить хлеб", "что я поставил", "оценка", "что поставить на ужин", "что я смотрю",
    "что у меня горит", "какие у меня дела", "что на сегодня", "что на неделю", "что со светом", "когда свет", "какой прогноз на завтра",
    "смотрел ли я его", "Хару, смотрел ли ты", "смотрел\nли я Фрирен",
  ])("«%s» — не вопрос про название", (text) => {
    expect(parseAnimeDid(text)).toBeNull();
  });

  it("вопросы про дела и свет остаются вопросами про дела и свет", () => {
    for (const t of ["что у меня горит", "какие у меня дела", "что на сегодня", "что на неделю"]) {
      expect(parseTasksQuestion(t)).not.toBeNull();
      expect(parseAnimeDid(t)).toBeNull();
      expect(parseAnimeAsk(t)).toBeNull();
    }
    for (const t of ["что со светом", "когда дадут свет", "будет ли свет"]) {
      expect(parseAnimeDid(t)).toBeNull();
      expect(parseAnimeAsk(t)).toBeNull();
    }
  });
});

const row = (id: number, ru: string, o: Partial<Anime> = {}): Anime => ({
  id, mal_id: id, anilist_id: null, title_ru: ru, title_orig: null, status: "done", watched: 0, liked: 0, notify: 1, episodes: null, src_status: null,
  next_ep: null, next_at: null, aired_ep: 0, aired_at: null, asked_ep: 0, added_at: 0, updated_at: 0, drop_reason: null, last_move_at: null, voice_lag: null,
  voice_n: 0, voice_ep: 0, weekq_at: null, seq_at: null, start_asked: 0, ...o,
});

describe("отметка -2 «не зашло»: список, карточка, вопрос недели", () => {
  const NOW = kyiv(2026, 11, 18, 12, 0);
  it("словами и значком: -2 — 👎, -1 — без значка, как раньше", () => {
    expect(likeWords(2)).toBe("🔥 в восторге");
    expect(likeWords(1)).toBe("❤ понравилось");
    expect(likeWords(-1)).toBe("так себе");
    expect(likeWords(-2)).toBe("👎 не зашло");
    expect(likeWords(0)).toBe("");
    expect([2, 1, 0, -1, -2].map((n) => likeMark(row(1, "X", { liked: n })))).toEqual(["🔥 ", "❤ ", "", "", "👎 "]);
  });

  it("в списке «Просмотрено» у -2 значок 👎, у загруженных отметок нет «серия 0»", () => {
    const rows = [row(1, "Любимое", { liked: 2 }), row(2, "Нелюбимое", { liked: -2 }), row(3, "Бросил", { status: "dropped", liked: 1 })];
    const done = animeListMessage(rows, "done", 0, NOW, "Europe/Kyiv", "neutral").content as string;
    expect(done).toContain("🔥 Любимое — просмотрено");
    expect(done).toContain("👎 Нелюбимое — просмотрено");
    expect(done).not.toContain("серия 0");
    const dropped = animeListMessage(rows, "dropped", 0, NOW, "Europe/Kyiv", "neutral").content as string;
    expect(dropped).toContain("❤ Бросил — бросил");
    expect(dropped).not.toContain("на 0");
  });

  it("в карточке: «Отметка: 👎 не зашло», кнопок не прибавилось", () => {
    const ids = (a: Anime) => (animeCardMessage(a, "d", 0, NOW, "Europe/Kyiv", "neutral").components ?? []).flatMap((r) => r.components.map((b) => b.custom_id));
    const bad = animeCardMessage(row(1, "Блич", { liked: -2 }), "d", 0, NOW, "Europe/Kyiv", "neutral");
    expect(bad.content).toContain("Отметка: 👎 не зашло");
    expect(bad.content).not.toContain("так себе");
    expect(bad.content).toContain("Статус: Просмотрено");
    expect(bad.content).not.toContain("серия 0");
    expect(ids(row(1, "Блич", { liked: -2 }))).toEqual(ids(row(1, "Блич", { liked: 0 })));
    expect(animeCardMessage(row(1, "Блич", { liked: -1 }), "d", 0, NOW, "Europe/Kyiv", "neutral").content).toContain("Отметка: так себе");
  });

  it("вопрос недели: про оценку не спрашивает тех, кому уже поставил -2; про продолжение того, что не зашло, не спрашивает", () => {
    const rows = [row(1, "Оценён", { liked: -2, updated_at: 3 }), row(2, "Так себе", { liked: -1, updated_at: 2 }), row(3, "Любимое", { liked: 2, updated_at: 1 }), row(4, "Без оценки", { updated_at: 0 })];
    const p = weekPicks(rows, NOW);
    expect(p.liked?.id).toBe(4);
    expect(p.seq.map((a) => a.id)).toEqual([3, 4]);
  });
});

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

describe("cron: отметка фразой", () => {
  it("«Фрирен в восторге» — liked 2; дело не заводится; список и кнопки те же", async () => {
    await say("Фрирен в восторге");
    expect(anime()[0].liked).toBe(2);
    expect(last()).toContain("Записала");
    expect(last()).toContain("🔥 в восторге");
    expect(items()).toBe(0);
  });

  it("«поставил Блич понравилось» — 1, «Блич не зашло» — -2, «Блич так себе» — -1, потом «обожаю Блич» — снова 2", async () => {
    await say("поставил Блич понравилось");
    expect(anime()[1].liked).toBe(1);
    await say("Блич не зашло", D0 + 2 * MINUTE);
    expect(anime()[1].liked).toBe(-2);
    expect(last()).toContain("👎 не зашло");
    await say("Блич так себе", D0 + 3 * MINUTE);
    expect(anime()[1].liked).toBe(-1);
    await say("обожаю Блич", D0 + 4 * MINUTE);
    expect(anime()[1].liked).toBe(2);
    expect(items()).toBe(0);
  });

  it("отметка не меняет статус и серию тайтла (кроме «досмотрел»)", async () => {
    await say("Фрирен не зашло");
    expect(anime()[0]).toMatchObject({ liked: -2, status: "watching", watched: 4 });
    await say("посмотрел Блич, понравилось", D0 + 2 * MINUTE);
    expect(anime()[1]).toMatchObject({ liked: 1, status: "planned", watched: 0 });
  });

  it("«досмотрел Блич, в восторге» — отметка и «Просмотрено» (серия — все 12)", async () => {
    await say("досмотрел Блич, в восторге");
    expect(anime()[1]).toMatchObject({ liked: 2, status: "done", watched: 12 });
    expect(last()).toContain("Отметила как просмотренное");
  });

  it("та же отметка второй раз — «уже записано», ничего не меняется", async () => {
    await say("Фрирен в восторге");
    const before = JSON.stringify(anime());
    await say("Фрирен в восторге", D0 + 2 * MINUTE);
    expect(last()).toContain("уже записано");
    expect(JSON.stringify(anime())).toBe(before);
  });

  it("отметка в карточке и фраза друг друга не ломают: кнопка «❤ Понравилось» переключает как раньше", async () => {
    await say("ДжоДжо не зашло");
    expect(anime()[2].liked).toBe(-2);
    w.discord.say(CH_BOT, OWNER, "ДжоДжо понравилось");
    await w.run(D0 + 2 * MINUTE);
    expect(anime()[2].liked).toBe(1);
  });

  it("чужое название без «бот» — обычное дело, как раньше: аниме не тронуто, на Shikimori не ходили", async () => {
    const before = JSON.stringify(anime());
    const fetches = w.animeFetches;
    await say("Нетакого в восторге");
    expect(JSON.stringify(anime())).toBe(before);
    expect(items()).toBe(1);
    expect(w.animeFetches).toBe(fetches);
  });

  it("обычные дела с «понравилось»/«обожаю» остаются делами", async () => {
    await say("купить торт, маме понравится");
    await say("обожаю кофе", D0 + 2 * MINUTE);
    expect(items()).toBe(2);
    expect(anime().map((a) => a.liked)).toEqual([0, 0, 1]);
  });

  it("с обращением незнакомое название — честно «в списке нет», дело не заводится, Shikimori не трогаем", async () => {
    const fetches = w.animeFetches;
    await say("Хару, Нетакого в восторге");
    expect(last()).toContain("в вашем списке нет");
    expect(items()).toBe(0);
    expect(anime()).toHaveLength(3);
    expect(w.animeFetches).toBe(fetches);
  });

  it("вопросы про дела и свет рядом с отметками работают как раньше", async () => {
    await say("что у меня горит");
    expect(replies().some((p) => p.body.content?.includes("Ничего не висит"))).toBe(true);
    await say("Фрирен в восторге", D0 + 2 * MINUTE);
    expect(anime()[0].liked).toBe(2);
  });
});

describe("cron: «смотрел ли я», «что я поставил»", () => {
  it("«смотрел ли я Фрирен» — статус, серия и оценка словами", async () => {
    await say("смотрел ли я Фрирен");
    expect(last()).toContain("Провожающая в последний путь Фрирен");
    expect(last()).toContain("Смотрю: серия 4 из 28");
    expect(last()).toContain("Оценка: не ставили");
    expect(items()).toBe(0);
  });

  it("«что я поставил ДжоДжо» после отметки; «оценка Блич» у «В планах»", async () => {
    await say("что я поставил ДжоДжо");
    expect(last()).toContain("Просмотрено (12 сер.)");
    expect(last()).toContain("Оценка: ❤ понравилось");
    await say("Блич не зашло", D0 + 2 * MINUTE);
    await say("оценка Блич", D0 + 3 * MINUTE);
    expect(last()).toContain("В планах, ещё не смотрели");
    expect(last()).toContain("Оценка: 👎 не зашло");
  });

  it("«смотрел ли я Нетакого» — честно: в списке нет (а не «не смотрел»)", async () => {
    await say("смотрел ли я Нетакого");
    expect(last()).toContain("в вашем списке нет");
    expect(last()).toContain("не значит, что вы не смотрели");
    expect(last()).not.toContain("Не смотрели");
    expect(items()).toBe(0);
  });

  it("слабая форма без названия из списка — обычное дело: «оценка сметы», «что я поставил в духовку»", async () => {
    await say("оценка сметы");
    await say("что я поставил в духовку", D0 + 2 * MINUTE);
    expect(items()).toBe(2);
  });

  it("с обращением слабая форма тоже отвечает «в списке нет»", async () => {
    await say("бот, оценка Нетакого");
    expect(last()).toContain("в вашем списке нет");
    expect(items()).toBe(0);
  });

  it("несколько подходящих — просит назвать точнее", async () => {
    w.d1.sqlite.exec(`INSERT INTO anime (mal_id, title_ru, status, added_at, updated_at) VALUES (9, 'Блич: тысячелетняя кровавая война', 'done', 0, 0)`);
    await say("смотрел ли я блич");
    // «Блич» совпадает с названием целиком, это не неоднозначность: берём точное
    expect(last()).toContain("**Блич** —");
    await say("смотрел ли я кровавая", D0 + 2 * MINUTE);
    expect(last()).toContain("Просмотрено");
  });
});

describe("store: список не обрезается на сотнях тайтлов", () => {
  it("listAnime отдаёт все 600 строк (раньше — не больше 400, и самые новые пропадали)", async () => {
    const stmts = Array.from({ length: 600 }, (_, i) => `(${1000 + i}, 'Тайтл ${i}', 'done', 0, 0)`).join(",");
    w.d1.sqlite.exec(`INSERT INTO anime (mal_id, title_ru, status, added_at, updated_at) VALUES ${stmts}`);
    expect((await listAnime(w.repo(2000))).length).toBe(603);
  });
});
