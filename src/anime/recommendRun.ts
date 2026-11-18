// Аниме: ответ на просьбу «посоветуй» (разбор — recommend.ts): сбор кандидатов на Shikimori за ограниченное число обращений и вид сообщения.
// Обращения идут по одному (у сайта лимит 5 запросов в секунду) и считаются в `repo.counter` (бесплатная норма Cloudflare — 50 подзапросов на запуск):
// не больше REC_FETCH_CAP на фразу, и только если после них остаётся запас на запись и ответ; иначе честно «сейчас не получится».
import { BudgetExceeded, type Counter, setMeta } from "../db/repo.ts";
import type { MessageBody } from "../discord/types.ts";
import { type Anime, clip, findOwnSeason, norm } from "./core.ts";
import type { AnimeCtx } from "./handlers.ts";
import { type PickConfig, type Rec, type Seen, judge, markSeen, orderCandidates, parseSeen, preCheck, recEmbed, seasonNow, similarWhy } from "./pick.ts";
import { WARN_GENRES, type GenreKey } from "./pickGenres.ts";
import { type PickTitle, fetchDetail, fetchMoodGenre, fetchSimilarTo } from "./pickSources.ts";
import { type Recommend, REC_SHOWN, chooseSome, familyKey, isSequel, mergeMood, moodExclude, moodPlan, moodWhy } from "./recommend.ts";
import { type Candidate, searchShiki } from "./sources.ts";
import { listAnime } from "./store.ts";

/** Не больше стольких обращений к Shikimori на одну фразу (на запуск Worker их 50, остальное делают другие части бота). */
export const REC_FETCH_CAP = 8;
/** Сколько подзапросов должно быть свободно, чтобы начать: чтение списка, запись «предлагала», все обращения к сайту, ответ и запись запуска. */
export const REC_NEED = REC_FETCH_CAP + 5;
/** Сколько оставить про запас после каждого обращения: запись «предлагала», ответ, запись запуска, пинг сторожу. */
const KEEP = 4;

export interface RecCtx extends AnimeCtx {
  /** настройки подборки: что любит и что не предлагаем (`pickGenres`, `pickAvoid`) */
  pickGenres: GenreKey[];
  pickAvoid: GenreKey[];
  /** что уже предлагали (meta `anime_pick_seen`) и как записать новое в память запуска, чтобы субботняя подборка в этот же запуск его не затёрла */
  seenRaw?: string;
  onSeen?: (value: string) => void;
}

const text = (content: string): MessageBody => ({ content, components: [], allowed_mentions: { parse: [] } });

export const REC_NO_ROOM = "Сейчас не получится подобрать: на эту минуту у бота кончился запас обращений (бесплатный лимит Cloudflare). Спросите ещё раз через минуту.";
export const REC_DOWN = "Shikimori сейчас не отвечает, подобрать не получилось. Спросите ещё раз позже.";

/** Обращения к Shikimori под счётчиком; два сбоя подряд — считаем, что сайт лёг, и больше не зовём. */
class Net {
  used = 0;
  misses = 0;
  down = false;
  dry = false;
  private counter: Counter;
  constructor(counter: Counter) {
    this.counter = counter;
  }
  async call<T>(f: () => Promise<T | null>): Promise<T | null> {
    if (this.down) return null;
    if (this.used >= REC_FETCH_CAP || !this.counter.can(1 + KEEP)) {
      this.dry = true;
      return null;
    }
    this.counter.spend(1);
    this.used++;
    const r = await f();
    if (r === null) {
      if (++this.misses >= 2) this.down = true;
    } else this.misses = 0;
    return r;
  }
  /** Почему нечего показать: сайт не отвечает или не хватило запаса (null — просто ничего не нашлось). */
  get why(): "down" | "dry" | null {
    return this.down ? "down" : this.dry ? "dry" : null;
  }
}

const failText = (why: "down" | "dry"): string => (why === "down" ? REC_DOWN : REC_NO_ROOM);
const cards = (recs: Rec[], c: RecCtx, rand: () => number): MessageBody["embeds"] => recs.map((r) => recEmbed(r, c.character, rand));

interface Reply {
  body: MessageBody | null;
  /** что предложили: запомним, чтобы не повторять (общая память с субботней подборкой) */
  recs: Rec[];
}

/**
 * Подбор по настроению: по одному запросу на жанр (до трёх), ответ — до трёх карточек в виде субботней подборки.
 * Карточки целиком берутся из списков сайта (обложка, серии, оценка): отдельных запросов на карточку не нужно, обращений 1–6.
 */
async function moodReply(c: RecCtx, net: Net, r: Extract<Recommend, { kind: "mood" }>, known: Set<number>, seen: Seen, avoid: GenreKey[], rand: () => number): Promise<Reply> {
  const plan = moodPlan(r.moods, avoid);
  if (plan.blocked) return { body: text(`«${plan.label}» у вас в списке «не предлагать» (настройки подборки), поэтому не ищу.`), recs: [] };
  const exclude = moodExclude(avoid, plan.skip);
  const era = `2010_${seasonNow(c.now, c.tz).year}`;
  const lists: { genre: (typeof plan.genres)[number]; items: PickTitle[] }[] = [];
  const ask = async (page: number): Promise<void> => {
    for (const genre of plan.genres) {
      const items = await net.call(() => fetchMoodGenre(era, genre.id, exclude, page, 50, c.fetchFn));
      if (items) lists.push({ genre, items });
      else if (net.down) break;
    }
  };
  const page = 1 + (Math.floor(rand() * 3) % 3); // повтор просьбы не должен давать ту же страницу рейтинга
  await ask(page);
  let cands = mergeMood(lists, plan, known, seen, c.now, new Set());
  if (cands.length < REC_SHOWN && !net.why) {
    await ask(page === 1 ? 2 : 1);
    cands = mergeMood(lists, plan, known, seen, c.now, new Set());
  }
  const picks = chooseSome(cands, REC_SHOWN, rand);
  if (!picks.length) {
    const why = !lists.length ? net.why : null;
    return { body: text(why ? failText(why) : `Под настроение «${plan.label}» ничего нового не нашла: всё подходящее уже в вашем списке или я это недавно предлагала. Попробуйте другое настроение.`), recs: [] };
  }
  const recs: Rec[] = picks.map((p) => ({ kind: "mood", t: p.t, why: moodWhy(plan, p.labels), warn: [] }));
  const head = [`**🎬 Подбор: ${plan.label}**`, `Искала: ${plan.genres.map((g) => g.label).join(", ")} · не длиннее ${plan.maxEp} серий.`];
  if (recs.length < 2) head.push("Больше подходящего не нашла.");
  return { body: { content: head.join("\n"), embeds: cards(recs, c, rand), allowed_mentions: { parse: [] } }, recs };
}

/** «Какое из них»: обычным текстом, без кнопок на виду (правило кнопок). */
function choiceText(cands: Candidate[]): string {
  const rows = cands.slice(0, 4).map((x) => {
    const extra = [x.year, x.episodes > 0 ? `${x.episodes} сер.` : null].filter(Boolean).join(", ");
    return `• ${clip(x.ru, 70)}${extra ? ` (${extra})` : ""}`;
  });
  return `Нашла несколько, про какое из них? Напишите точнее, например «похожее на ${clip(cands[0].ru, 60)}».\n${rows.join("\n")}`;
}

/** «Похожее на Х»: Х — из его списка или с Shikimori; потом «похожее» у сайта, карточки лучших по оценке без того, что уже в списке, и без красных линий. */
async function similarReply(c: RecCtx, net: Net, r: Extract<Recommend, { kind: "similar" }>, rows: Anime[], known: Set<number>, seen: Seen, cfg: PickConfig, rand: () => number): Promise<Reply> {
  const own = findOwnSeason(rows, r.query, r.season ?? null);
  let base: { mal: number; name: string; orig: string };
  if (own) base = { mal: own.mal_id, name: own.title_ru, orig: own.title_orig ?? "" };
  else {
    const found = await net.call(() => searchShiki(r.query, c.fetchFn));
    if (found === null) return { body: text(failText(net.why ?? "down")), recs: [] };
    const q = norm(r.query);
    // «посоветуй как приготовить борщ» — не про аниме: слабая форма с названием, которого нет на сайте, остаётся делом
    const cands = r.weak ? found.filter((x) => norm(x.ru).includes(q) || norm(x.orig).includes(q)) : found;
    if (!cands.length) return { body: r.weak ? null : text(`Не нашла «${clip(r.query, 60)}» на Shikimori. Напишите название по-русски или как в оригинале.`), recs: [] };
    const exact = cands.filter((x) => norm(x.ru) === q || norm(x.orig) === q);
    const pick = cands.length === 1 ? cands[0] : exact.length === 1 ? exact[0] : null;
    if (!pick) return { body: text(choiceText(cands)), recs: [] };
    base = { mal: pick.mal, name: pick.ru, orig: pick.orig };
  }
  const list = await net.call(() => fetchSimilarTo(base.mal, c.fetchFn));
  if (list === null) return { body: text(failText(net.why ?? "down")), recs: [] };
  const name = clip(base.name, 60);
  if (!list.length) return { body: text(`У Shikimori нет похожих на «${name}».`), recs: [] };
  const baseFamily = familyKey(base.orig || base.name);
  const taken = new Set<number>([base.mal]);
  const cands = orderCandidates(
    list.filter((t) => t.mal !== base.mal && !isSequel(t) && familyKey(t.orig || t.ru) !== baseFamily && preCheck(t, "similar", known, seen, c.now, taken)),
    "similar",
    rand,
  );
  const why = own && own.liked >= 1 ? similarWhy(own) : `Похоже на «${name}».`;
  const recs: Rec[] = [];
  const families = new Set<string>([baseFamily]);
  const franchises = new Set<string>();
  for (const t of cands) {
    if (recs.length >= REC_SHOWN) break;
    const fam = familyKey(t.orig || t.ru);
    if (families.has(fam)) continue;
    const d = await net.call(() => fetchDetail(t.mal, c.fetchFn));
    if (!d) {
      if (net.why) break;
      continue; // карточки нет (404): пропускаем, это не «сайт не отвечает»
    }
    const v = judge(d, cfg); // ужасы, меха и всё из «не предлагать» — мимо
    if (!v || (d.franchise !== null && franchises.has(d.franchise))) continue;
    families.add(fam);
    if (d.franchise) franchises.add(d.franchise);
    recs.push({ kind: "similar", t: d, why, warn: v.warn });
  }
  if (!recs.length) {
    const fail = net.why;
    return {
      body: text(fail ? failText(fail) : `Похожего на «${name}» подходящего не нашла: что нашлось у сайта, уже в вашем списке, я это недавно предлагала или это не ваше (ужасы, меха и всё из «не предлагать»).`),
      recs: [],
    };
  }
  const head = [`**🎬 Похожее на «${name}»**`];
  if (recs.length < 2 && net.why === "dry") head.push("Дальше искать не хватило запаса обращений: спросите ещё раз чуть позже.");
  else if (recs.length < 2) head.push("Больше подходящего не нашла.");
  return { body: { content: head.join("\n"), embeds: cards(recs, c, rand), allowed_mentions: { parse: [] } }, recs };
}

/**
 * Просьба «посоветуй»: по настроению или похожее на название. null — это не про аниме (слабая форма с неизвестным названием), фраза остаётся делом.
 * В память «что предлагали» (общая с субботней подборкой, `anime_pick_seen`) записывает показанное: через неделю то же не вернётся.
 */
export async function runRecommend(c: RecCtx, r: Recommend): Promise<MessageBody | null> {
  if (!c.repo.counter.can(REC_NEED)) return text(REC_NO_ROOM);
  const rows = await listAnime(c.repo);
  const rand = c.rand ?? Math.random;
  const net = new Net(c.repo.counter);
  const known = new Set(rows.map((a) => a.mal_id));
  const seen = parseSeen(c.seenRaw);
  const cfg: PickConfig = { likes: c.pickGenres, avoid: c.pickAvoid, warn: WARN_GENRES };
  const out = r.kind === "mood" ? await moodReply(c, net, r, known, seen, cfg.avoid, rand) : await similarReply(c, net, r, rows, known, seen, cfg, rand);
  if (out.recs.length) {
    const next = JSON.stringify(markSeen(seen, out.recs.map((x) => x.t.mal), [], c.now));
    try {
      await c.repo.exec([setMeta("anime_pick_seen", next)]);
      c.onSeen?.(next);
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e; // не записали «предлагала» — не страшно, ответ важнее
    }
  }
  return out.body;
}
