// Проверка субботней подборки одной командой: npm run pick-check
//  1. настоящие запросы к Shikimori (только чтение): список сезона, карточка, «похожее», страница рейтинга: что ответил и как бот это разобрал;
//  2. вся подборка целиком на выдуманной таблице аниме (в памяти) с настоящим Shikimori. Сообщение печатается здесь, в Discord ничего не уходит,
//     настоящая база не трогается. Запросы идут не чаще трёх в секунду (у сайта лимит пять).
import { readSettings } from "../src/settings.ts";
import type { Anime } from "../src/anime/core.ts";
import { DEFAULT_PICK_CONFIG, PICK_FETCH_CAP } from "../src/anime/pick.ts";
import { runSaturdayPick } from "../src/anime/pickCron.ts";
import { classify } from "../src/anime/pickGenres.ts";
import { GENRE_IDS, excludeParam } from "../src/anime/pickGenres.ts";
import { type PickTitle, fetchDetail, fetchRanked, fetchSeasonGenre, fetchSimilarTo, seasonOf } from "../src/anime/pickSources.ts";
import { wallOf } from "../src/time/tz.ts";
import { FakeDiscord } from "../test/fakeDiscord.ts";

if (typeof process !== "undefined") process.stdout.setDefaultEncoding?.("utf8");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
const slow = (async (input: unknown, init?: RequestInit) => {
  await sleep(340);
  calls++;
  return fetch(input as string, init);
}) as typeof fetch;

const show = (t: PickTitle): string =>
  `${t.mal} «${t.ru}» ${t.kind}/${t.status}, серий ${t.episodes} (вышло ${t.epsAired}), оценка ${t.score ?? "нет"}, год ${t.year ?? "?"}, обложка ${t.image ? "есть" : "НЕТ"}, жанры: ${t.genres.length ? [...classify(t.genres).keys].join("+") || `(не наши: ${t.genres.slice(0, 4).join(", ")})` : "—"}`;

const now = Date.now();
const w = wallOf(now, "Europe/Kyiv");
const season = seasonOf(w.y, w.mo);
let bad = 0;

console.log(`1. Настоящий Shikimori (сезон ${season})\n`);
const ex = excludeParam(DEFAULT_PICK_CONFIG.avoid);
const list = await fetchSeasonGenre(season, GENRE_IDS.fantasy[0], ex, 10, slow);
if (!list) {
  console.log("   сезон, жанр «фэнтези» без ужасов, мехи, космоса и BL: НЕ ПРОЧИТАЛСЯ");
  bad++;
} else {
  console.log(`   сезон, жанр «фэнтези» (запрос «${GENRE_IDS.fantasy[0]},${ex}»): ${list.length} тайтлов; первые:`);
  for (const t of list.slice(0, 3)) console.log(`     ${show(t)}`);
  const d = list[0] ? await fetchDetail(list[0].mal, slow) : null;
  console.log(d ? `   карточка первого: ${show(d)}, семья «${d.franchise}»` : "   карточка первого: НЕ ПРОЧИТАЛАСЬ");
  if (!d || !d.genres.length) bad++;
}
const sim = await fetchSimilarTo(52991, slow); // Sousou no Frieren: общеизвестный тайтл, нужен только как образец
console.log(sim ? `   «похожее» на 52991: ${sim.length} тайтлов; первые: ${sim.slice(0, 2).map(show).join(" | ")}` : "   «похожее»: НЕ ПРОЧИТАЛОСЬ");
if (!sim) bad++;
const top = await fetchRanked(`2010_${w.y}`, 2, 20, ex, slow);
console.log(top ? `   рейтинг (стр. 2): ${top.length} тайтлов; первые: ${top.slice(0, 2).map(show).join(" | ")}` : "   рейтинг: НЕ ПРОЧИТАЛСЯ");
if (!top) bad++;

console.log("\n2. Вся подборка на выдуманной таблице (настоящий Shikimori, Discord поддельный)\n");
const row = (o: Partial<Anime>): Anime => ({
  id: 1, mal_id: 1, anilist_id: null, title_ru: "Тест", title_orig: null, status: "done", watched: 12, liked: 0, notify: 1, episodes: 12, src_status: "FINISHED",
  next_ep: null, next_at: null, aired_ep: 12, aired_at: null, asked_ep: 12, added_at: now - 90 * 86_400_000, updated_at: now - 7 * 86_400_000, drop_reason: null,
  last_move_at: null, voice_lag: null, voice_n: 0, voice_ep: 0, weekq_at: null, seq_at: null, start_asked: 0, ...o,
});
const table: Anime[] = [
  row({ id: 1, mal_id: 52991, title_ru: "Любимое (образец)", liked: 2 }),
  row({ id: 2, mal_id: 38000, title_ru: "Идёт сейчас", status: "watching", watched: 3, aired_ep: 6, aired_at: now - 6 * 3_600_000, src_status: "RELEASING", voice_lag: 120 }),
  row({ id: 3, mal_id: 40748, title_ru: "Давно в планах", status: "planned", watched: 0, aired_ep: 24, episodes: 24 }),
];
const discord = new FakeDiscord();
const settings = readSettings([{ key: "ch_remind", value: "1" }, { key: "character", value: "maid" }]);
const r = await runSaturdayPick(
  { api: discord, now, s: settings, meta: new Map(), away: false, quiet: false, minuteOfDay: 12 * 60, fetchFn: slow, rand: Math.random, room: () => true, spend: () => {}, note: () => {} },
  table,
  DEFAULT_PICK_CONFIG,
);
console.log(`   заметки: ${r.notes.join("; ") || "—"}; здорово: ${r.healthy}; записей в базу: ${r.ops.length}`);
const msg = discord.posted[0]?.body;
if (!msg) {
  console.log("   сообщение НЕ отправлено (сайт не ответил: подборка отложена)");
  bad++;
} else {
  console.log(`\n--- сообщение ---\n${msg.content}`);
  for (const e of msg.embeds ?? []) console.log(`\n[карточка] ${e.title}\n${e.url}\n${e.description}\n(обложка: ${e.thumbnail?.url ?? "нет"})`);
}
console.log(`\nОбращений к Shikimori за проверку: ${calls}; подборке по правилам можно не больше ${PICK_FETCH_CAP}.`);
if (bad) process.exitCode = 1;
