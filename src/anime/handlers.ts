// Аниме: действия — занесение фразой и из окна, кнопки списка и карточки, ответы на «посмотрели?».
// Ответы возвращаются как готовые тела сообщений (для cron) или как ответы Discord (для кнопок).
import { type Repo, deleteMeta, setMeta } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import type { MessageBody } from "../discord/types.ts";
import { wallOf } from "../time/tz.ts";
import type { Character } from "../flavor.ts";
import { headVoice, voiceText } from "../discord/ui.ts";
import {
  type Anime,
  type AnimePhrase,
  type AnimeStatus,
  CODE_STATUS,
  DROP_REASON,
  NOTICE_LIMIT,
  STATUS_CODE,
  STATUS_LABEL,
  clip,
  effective,
  findOwn,
  findOwnSeason,
  haru,
  likeWords,
  norm,
  noticeSet,
  progressText,
} from "./core.ts";
import { type AnimeDid, type MarkPhrase, scoreLabel } from "./mark.ts";
import type { Recommend } from "./recommend.ts";
import { type RecCtx, runRecommend } from "./recommendRun.ts";
import type { AnimeAsk, SayPhrase } from "./say.ts";
import { type Candidate, type FetchFn, getShikiFull, searchShiki } from "./sources.ts";
import { deleteOp, getAnime, listAnime, patchOp, upsertOp } from "./store.ts";
import {
  NOT_FOUND_TEXT,
  SOURCE_DOWN_TEXT,
  type AskItem,
  animeCardMessage,
  animeDeleteConfirm,
  animeDidText,
  animeListMessage,
  animeModal,
  animeNewsText,
  animeNextText,
  animeNotInList,
  askPickMessage,
  candidatesMessage,
  dropReasonMessage,
  epModal,
} from "./ui.ts";

export interface AnimeCtx {
  repo: Repo;
  now: number;
  tz: string;
  character: Character;
  fetchFn: FetchFn;
  rand?: () => number;
}

type Reply = Record<string, unknown>;
const update = (body: MessageBody): Reply => ({ type: 7, data: { embeds: [], ...body } });
const text = (content: string): MessageBody => ({ content, components: [], allowed_mentions: { parse: [] } });
const code = (s: AnimeStatus) => STATUS_CODE[s];
/** Местный час: на отметку серии ночью (с полуночи до пяти) Хару чаще шутит «пора спать». */
const hourOf = (c: AnimeCtx): number => wallOf(c.now, c.tz).h;

/** Что нажал хозяин в аниме: обнуляем счётчик «без ответа» и снимаем паузу вопросов. */
const touchOps = (): Op[] => [setMeta("anime_unanswered", "0"), deleteMeta("anime_ask_off"), deleteMeta("anime_ask_wait")];

const nav = (a: Anime): MessageBody["components"] => [
  { type: 1, components: [{ type: 2, style: 1, label: "Открыть", custom_id: `an:it:${a.id}:${code(a.status)}:0` }, { type: 2, style: 2, label: "🎬 К списку", custom_id: `an:ls:${code(a.status)}:0` }] },
];

function savedMessage(a: Anime, c: AnimeCtx, kind: "added" | "changed"): MessageBody {
  const e = effective(a, c.now);
  const where = `**${a.title_ru}** — ${STATUS_LABEL[a.status]}${a.watched ? `, серия ${a.watched}` : ""}`;
  const more = a.status === "watching" || a.status === "planned" ? `\n${progressText(a, c.now, c.tz)}${e.upcoming || a.src_status === "FINISHED" ? "" : ". Напомню, когда появится дата."}` : "";
  const line = haru(kind === "added" ? "added" : a.status === "dropped" ? "dropped" : "ep", c.character, c.rand, hourOf(c));
  return { content: `Записала: ${where}.${more}${line ? `\n${voiceText(line)}` : ""}`, components: nav(a), allowed_mentions: { parse: [] } };
}

/** Добавить тайтл: название и расписание — полным запросом Shikimori; не вышло — по данным поиска, расписание догонит ночь. */
export async function addCandidate(c: AnimeCtx, cand: Candidate | null, mal: number, status: AnimeStatus, episode: number | null): Promise<MessageBody> {
  const full = await getShikiFull(mal, c.fetchFn);
  const use = full?.cand ?? cand;
  if (!use) return text(SOURCE_DOWN_TEXT);
  await c.repo.exec([upsertOp({ cand: use, sch: full?.sch ?? null, status, episode, now: c.now }), ...touchOps()]);
  const a = await c.repo.first<Anime>("SELECT * FROM anime WHERE mal_id = ?", mal);
  return a ? savedMessage(a, c, "added") : text(SOURCE_DOWN_TEXT);
}

/** Применить статус и серию к уже записанному тайтлу. */
async function applyOwn(c: AnimeCtx, a: Anime, status: AnimeStatus, episode: number | null): Promise<MessageBody> {
  const patch: Partial<Pick<Anime, "status" | "watched">> = { status };
  if (episode !== null) patch.watched = episode;
  else if (status === "done" && a.episodes) patch.watched = a.episodes;
  await c.repo.exec([patchOp(a.id, patch, c.now), ...touchOps()]);
  const fresh = (await getAnime(c.repo, a.id)) ?? { ...a, ...patch };
  return savedMessage(fresh, c, "changed");
}

/** Фраза «бот смотрю фрирен 3»: своё название — сразу; чужое — поиск; неясное — 2–3 кнопки. */
export async function handlePhrase(c: AnimeCtx, p: AnimePhrase): Promise<MessageBody> {
  const own = findOwn(await listAnime(c.repo), p.query);
  if (own) return applyOwn(c, own, p.status, p.episode);
  const cands = await searchShiki(p.query, c.fetchFn);
  if (cands === null) return text(SOURCE_DOWN_TEXT);
  if (!cands.length) return text(NOT_FOUND_TEXT);
  const q = norm(p.query);
  const exact = cands.filter((x) => norm(x.ru) === q || norm(x.orig) === q);
  const pick = cands.length === 1 ? cands[0] : exact.length === 1 ? exact[0] : null;
  if (pick) return addCandidate(c, pick, pick.mal, p.status, p.episode);
  return candidatesMessage(cands, p.status, p.episode, c.character, c.rand);
}

/**
 * Живая фраза хозяина («глянул последнюю серию Фрирен», «забил на ДжоДжо», «Фрирен надоело»).
 * Своё название — сразу; чужое — поиск и запись только после обращения «бот»/«аниме»/«Хару»; иначе null (это обычное дело).
 */
export async function handleSay(c: AnimeCtx, say: SayPhrase): Promise<MessageBody | null> {
  const own = findOwnSeason(await listAnime(c.repo), say.query, say.season ?? null);
  if (!own) return say.prefixed ? handlePhrase(c, { status: say.status, query: say.query, episode: say.episode }) : null;
  let status = say.status;
  let episode = say.episode;
  if (say.latest) {
    const aired = effective(own, c.now).airedEp;
    episode = aired > 0 ? aired : null;
  } else if (say.next) episode = own.watched + 1;
  else if (say.soft) {
    // «посмотрел / глянул Х» без слов о серии: у сериала в «Смотрю» это следующая серия, иначе — весь тайтл
    if (own.status === "watching") {
      status = "watching";
      episode = own.watched + 1;
    }
  }
  if (episode !== null && own.episodes !== null && episode > own.episodes) episode = own.episodes;
  if (status === "watching" && episode !== null && own.episodes !== null && episode >= own.episodes && own.src_status === "FINISHED") status = "done";
  return applyOwn(c, own, status, episode);
}

/**
 * Вопрос про своё аниме текстом: «что я смотрю», «что отложено», «что вышло нового», «когда новая серия Фрирен»,
 * «смотрел ли я Фрирен» / «что я поставил Фрирен». null — это был «слабый» вопрос про название, которого нет в списке: пусть остаётся делом.
 */
export async function handleAnimeAsk(c: AnimeCtx, q: AnimeAsk | AnimeDid): Promise<MessageBody | null> {
  const rows = await listAnime(c.repo);
  if (q.kind === "did") {
    const said = animeDidText(rows, q.query, q.season ?? null);
    return said !== null ? text(said) : q.sure ? text(animeNotInList(q.query)) : null;
  }
  if (q.kind === "watching" || q.kind === "planned") return animeListMessage(rows, q.kind, 0, c.now, c.tz, c.character, c.rand);
  return text(q.kind === "news" ? animeNewsText(rows, c.now, c.tz) : animeNextText(rows, q.query, c.now, c.tz));
}

/**
 * Отметка живой фразой («Фрирен в восторге», «поставил Блич понравилось», «Блич не зашло»): ставит liked (2 / 1 / -1 / -2).
 * Своё название — сразу; чужое — только после обращения «бот»/«аниме»/«Хару» и тогда честное «в списке нет»; иначе null (обычное дело).
 * Незнакомое название на Shikimori не ищем: оценка — про то, что уже в списке.
 */
export async function handleMark(c: AnimeCtx, mk: MarkPhrase): Promise<MessageBody | null> {
  const rows = await listAnime(c.repo);
  const own = findOwnSeason(rows, mk.query, mk.season ?? null);
  if (!own) {
    if (!mk.prefixed) return null;
    return text(animeDidText(rows, mk.query, mk.season ?? null) ?? animeNotInList(mk.query));
  }
  const patch: Partial<Pick<Anime, "liked" | "status" | "watched">> = { liked: mk.liked };
  const finishes = mk.finished === true && own.status !== "done";
  if (finishes) {
    patch.status = "done";
    if (own.episodes) patch.watched = own.episodes;
  }
  const name = `**${clip(own.title_ru, 80)}**`;
  const mine = mk.score !== undefined ? ` (ваши ${scoreLabel(mk.score)} из 10)` : ""; // оценка числом: храню отметкой по шкале, само число в ответе
  if (own.liked === mk.liked && !finishes) return { ...text(`Это уже записано: ${name} — ${likeWords(mk.liked)}${mine}.`), components: nav(own) };
  await c.repo.exec([patchOp(own.id, patch, c.now), ...touchOps()]);
  const fresh = { ...own, ...patch } as Anime;
  const line = mk.liked === 2 ? haru("loved", c.character, c.rand) : mk.liked > 0 ? haru("liked", c.character, c.rand) : mk.liked < 0 ? haru("meh", c.character, c.rand) : null;
  return {
    content: `Записала: ${name} — ${likeWords(mk.liked)}${mine}.${finishes ? " Отметила как просмотренное." : ""}${line ? `\n${voiceText(line)}` : ""}`,
    components: nav(fresh),
    allowed_mentions: { parse: [] },
  };
}

/**
 * Просьба «посоветуй» живой фразой («хочу что-то лёгкое», «похожее на Фрирен»): 2–3 карточки в виде субботней подборки, до 8 обращений к Shikimori.
 * Подробности — recommendRun.ts. null — это не про аниме (слабая форма с неизвестным названием), фраза остаётся делом.
 */
export const handleRecommend = (c: RecCtx, r: Recommend): Promise<MessageBody | null> => runRecommend(c, r);

/** Окно «＋ Добавить»: название, куда, серия. */
export async function handleAddModal(c: AnimeCtx, v: { name: string; st: string; ep: string }): Promise<Reply> {
  const status = (v.st in STATUS_LABEL ? v.st : "watching") as AnimeStatus;
  const ep = Number.parseInt(v.ep, 10);
  const body = await handlePhrase(c, { status, query: v.name.trim(), episode: Number.isFinite(ep) && ep >= 0 ? ep : null });
  return update(body);
}

export async function handleEpModal(c: AnimeCtx, id: number, cd: string, page: number, raw: string): Promise<Reply> {
  const a = await getAnime(c.repo, id);
  if (!a) return update(text("Этот тайтл уже убран."));
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 9999) return update(animeCardMessage(a, cd, page, c.now, c.tz, c.character, { note: "Не поняла номер серии, оставила как было.", rand: c.rand }));
  return setEpisode(c, a, n, cd, page);
}

async function setEpisode(c: AnimeCtx, a: Anime, n: number, cd: string, page: number): Promise<Reply> {
  const capped = a.episodes && n > a.episodes ? a.episodes : n;
  const finished = a.episodes !== null && capped >= a.episodes && a.src_status === "FINISHED";
  const patch: Partial<Pick<Anime, "status" | "watched">> = { watched: capped };
  if (finished && a.status === "watching") patch.status = "done";
  await c.repo.exec([patchOp(a.id, patch, c.now), ...touchOps()]);
  const fresh = { ...a, ...patch } as Anime;
  const note = patch.status === "done" ? "Досмотрели! Понравилось? Нажмите отметку." : haru("ep", c.character, c.rand, hourOf(c)) ?? undefined;
  return update(animeCardMessage(fresh, patch.status === "done" ? "d" : cd, patch.status === "done" ? 0 : page, c.now, c.tz, c.character, { note: note ? (patch.status === "done" ? note : voiceText(note)) : undefined, rand: c.rand }));
}

/** Кнопки `an:…` (кроме открытия экрана из меню). Возвращает ответ Discord или null, если кнопка не наша. */
export async function handleAnimeButton(c: AnimeCtx, parts: string[]): Promise<Reply | null> {
  const route = parts[1];
  const stOf = (x: string | undefined): AnimeStatus => CODE_STATUS[x ?? ""] ?? "watching";
  const pageOf = (x: string | undefined) => Math.max(0, Number.parseInt(x ?? "0", 10) || 0);
  const goneReply = update(text("Этот тайтл уже убран из коллекции."));
  const card = async (id: number, cd: string, p: number, note?: string): Promise<Reply> => {
    const a = await getAnime(c.repo, id);
    return a ? update(animeCardMessage(a, cd, p, c.now, c.tz, c.character, { note, rand: c.rand })) : goneReply;
  };
  switch (route) {
    case "ls": {
      const st = stOf(parts[2]);
      return update(animeListMessage(await listAnime(c.repo), st, pageOf(parts[3]), c.now, c.tz, c.character, c.rand));
    }
    case "it":
      return card(Number(parts[2]), parts[3] ?? "w", pageOf(parts[4]));
    case "ep": {
      const a = await getAnime(c.repo, Number(parts[2]));
      if (!a) return goneReply;
      return setEpisode(c, a, a.watched + 1, parts[3] ?? "w", pageOf(parts[4]));
    }
    case "epm": {
      const a = await getAnime(c.repo, Number(parts[2]));
      if (!a) return goneReply;
      return { type: 9, data: epModal(a, parts[3] ?? "w", pageOf(parts[4])).data };
    }
    case "lk": {
      const a = await getAnime(c.repo, Number(parts[2]));
      if (!a) return goneReply;
      const v = Number(parts[3]) === 2 ? 2 : 1;
      const liked = a.liked === v ? 0 : v;
      await c.repo.exec([patchOp(a.id, { liked }, c.now)]);
      const line = liked ? haru(liked === 2 ? "loved" : "liked", c.character, c.rand) : null;
      return update(animeCardMessage({ ...a, liked }, parts[4] ?? "w", pageOf(parts[5]), c.now, c.tz, c.character, { note: line ? voiceText(line) : undefined, rand: c.rand }));
    }
    case "nt": {
      const a = await getAnime(c.repo, Number(parts[2]));
      if (!a) return goneReply;
      const notify = a.notify ? 0 : 1;
      await c.repo.exec([patchOp(a.id, { notify }, c.now)]);
      return update(animeCardMessage({ ...a, notify }, parts[3] ?? "w", pageOf(parts[4]), c.now, c.tz, c.character, { rand: c.rand }));
    }
    case "st": {
      const a = await getAnime(c.repo, Number(parts[2]));
      if (!a) return goneReply;
      const status = stOf(parts[3]);
      const patch: Partial<Pick<Anime, "status" | "watched">> = { status };
      if (status === "done" && a.episodes) patch.watched = a.episodes;
      await c.repo.exec([patchOp(a.id, patch, c.now), ...touchOps()]);
      const line = status === "dropped" ? haru("dropped", c.character, c.rand) : null;
      return update(animeCardMessage({ ...a, ...patch } as Anime, parts[4] ?? "w", pageOf(parts[5]), c.now, c.tz, c.character, { note: line ? voiceText(line) : undefined, rand: c.rand }));
    }
    case "dl": {
      const a = await getAnime(c.repo, Number(parts[2]));
      return a ? update(animeDeleteConfirm(a, parts[3] ?? "w", pageOf(parts[4]))) : goneReply;
    }
    case "dy": {
      const a = await getAnime(c.repo, Number(parts[2]));
      if (!a) return goneReply;
      await c.repo.exec([deleteOp(a.id)]);
      return update(animeListMessage(await listAnime(c.repo), stOf(parts[3]), pageOf(parts[4]), c.now, c.tz, c.character, c.rand));
    }
    case "ad":
      return { type: 9, data: animeModal().data };
    case "pk": {
      const ep = Number(parts[4]);
      return update(await addCandidate(c, null, Number(parts[2]), stOf(parts[3]), ep > 0 ? ep : null));
    }
    case "no":
      return update(text("Хорошо, ничего не записываю. Попробуйте назвать иначе."));
    case "pz": {
      if (parts[2] === "on") {
        await c.repo.exec(touchOps());
        return update(text("Хорошо, продолжаю спрашивать раз в день."));
      }
      await c.repo.exec([setMeta("anime_ask_off", "1"), setMeta("anime_unanswered", "0"), deleteMeta("anime_ask_wait")]);
      return update(text("Хорошо, вопросы про серии на паузе. Они вернутся, когда вы отметите любую серию в «🎬 Аниме»."));
    }
    case "sn":
      return handleAsk(c, parts);
    case "wq":
      return handleWeek(c, parts);
    case "ss":
      return handleStart(c, parts);
    default:
      return null;
  }
}

/** Ответы на «Новые серии — посмотрели?»: all / no / pick / <id>; в конце списка тайтлов через точку. */
async function handleAsk(c: AnimeCtx, parts: string[]): Promise<Reply> {
  const what = parts[2];
  const ids = (parts[3] ?? "").split(".").map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const toItems = (rows: Anime[]): AskItem[] => rows.map((a) => ({ a, airedEp: effective(a, c.now).airedEp, airedAt: effective(a, c.now).airedAt }));
  const load = async (list: number[]): Promise<Anime[]> => (list.length ? c.repo.all<Anime>(`SELECT * FROM anime WHERE id IN (${list.map(() => "?").join(",")}) ORDER BY id`, ...list) : []);
  if (what === "no") {
    await c.repo.exec(touchOps());
    return update(text("Хорошо. Отмечу, когда скажете. Больше сегодня не спрашиваю."));
  }
  if (what === "pick") {
    return update(askPickMessage(toItems(await load(ids)), c.now, c.tz));
  }
  if (what === "all") {
    const rows = await load(ids);
    await c.repo.exec([...rows.map((a) => patchOp(a.id, { watched: effective(a, c.now).airedEp }, c.now)), ...touchOps()]);
    return update(text(`Отмечено: ${rows.map((a) => `${a.title_ru} — ${effective(a, c.now).airedEp}-я`).join("; ")}.`));
  }
  const one = Number(what);
  const a = (await load([one]))[0];
  if (!a) return update(text("Этот тайтл уже убран."));
  await c.repo.exec([patchOp(a.id, { watched: effective(a, c.now).airedEp }, c.now), ...touchOps()]);
  const rest = await load(ids.filter((x) => x !== one));
  if (!rest.length) return update(text(`Отмечено: ${a.title_ru} — ${effective(a, c.now).airedEp}-я.`));
  const items = toItems(rest);
  return update({ ...askPickMessage(items, c.now, c.tz), content: `Отмечено: ${a.title_ru}.\n${askPickMessage(items, c.now, c.tz).content}` });
}

// ---------- «между прочим» (an:wq:<вид>:<id>:<ответ>) ----------

/** Ответ на вопрос недели обнуляет счётчик «без ответа», но не снимает паузу утренних вопросов. */
const weekTouch = (): Op[] => [setMeta("anime_unanswered", "0")];

async function handleWeek(c: AnimeCtx, parts: string[]): Promise<Reply> {
  const kind = parts[2];
  const val = parts[4] ?? "";
  const clear = deleteMeta("anime_weekq");
  const gone = update(text("Этот тайтл уже убран."));
  const line = (k: "weekThanks" | "liked" | "dropped"): string => {
    const l = haru(k, c.character, c.rand);
    return l ? `\n${voiceText(l)}` : "";
  };
  if (kind === "q") {
    // продолжение сезона: parts[3] — номер MyAnimeList продолжения, а не наш id
    if (val !== "y") {
      await c.repo.exec([clear, ...weekTouch()]);
      return update(text("Хорошо, не добавляю."));
    }
    await c.repo.exec([clear, ...weekTouch()]);
    return update(await addCandidate(c, null, Number(parts[3]), "planned", null));
  }
  const a = await getAnime(c.repo, Number(parts[3]));
  if (!a) return gone;
  const name = `**${a.title_ru}**`;
  switch (kind) {
    case "e": {
      if (val === "2") {
        // «Ещё ниже»: окно с номером; ответ окна заменит вопрос карточкой
        await c.repo.exec([clear]);
        return { type: 9, data: epModal(a, code(a.status), 0).data };
      }
      let n = val === "1" ? a.watched + 1 : a.watched;
      if (a.episodes && n > a.episodes) n = a.episodes;
      const finished = a.episodes !== null && n >= a.episodes && a.src_status === "FINISHED" && a.status === "watching";
      const patch: Partial<Pick<Anime, "status" | "watched">> = { watched: n };
      if (finished) patch.status = "done";
      await c.repo.exec([patchOp(a.id, patch, c.now), clear, ...weekTouch()]);
      return update(text(`Записала: ${name} — серия ${n}.${finished ? " Досмотрели! Понравилось? Отметка — в карточке." : ""}${line("weekThanks")}`));
    }
    case "l": {
      const liked = val === "2" ? 2 : val === "1" ? 1 : val === "3" ? -1 : 0;
      await c.repo.exec([...(liked ? [patchOp(a.id, { liked }, c.now)] : []), clear, ...weekTouch()]);
      return update(text(liked > 0 ? `Записала: ${name} — ${liked === 2 ? "🔥 в восторге" : "❤ понравилось"}.${line("liked")}` : liked < 0 ? `Записала: ${name} — так себе.` : "Хорошо, про это больше не спрашиваю."));
    }
    case "c": {
      if (val === "d") {
        // «Бросил»: статус меняем сразу, причину спрашиваем тем же сообщением (вопрос не снимаем, пока не ответят)
        await c.repo.exec([patchOp(a.id, { status: "dropped" }, c.now), ...weekTouch()]);
        return update(dropReasonMessage({ ...a, status: "dropped" }, c.character, c.rand));
      }
      if (val === "p") {
        await c.repo.exec([patchOp(a.id, { notify: 0 }, c.now), clear, ...weekTouch()]);
        return update(text(`Поставила ${name} на паузу: уведомления выключены. Включить их можно в карточке тайтла.`));
      }
      await c.repo.exec([patchOp(a.id, { last_move_at: c.now }, c.now), clear, ...weekTouch()]);
      return update(text(`Хорошо, продолжаем ${name}.${line("weekThanks")}`));
    }
    case "r": {
      const reason = DROP_REASON[val];
      await c.repo.exec([...(reason ? [patchOp(a.id, { drop_reason: reason }, c.now)] : []), clear, ...weekTouch()]);
      return update(text(reason ? `Записала причину.${line("dropped")}` : "Хорошо, не спрашиваю."));
    }
    case "p": {
      if (val === "n") {
        await c.repo.exec([deleteOp(a.id), clear, ...weekTouch()]);
        return update(text(`Убрала ${name} из планов.`));
      }
      await c.repo.exec([patchOp(a.id, { last_move_at: c.now }, c.now), clear, ...weekTouch()]);
      return update(text(`Хорошо, ${name} остаётся в планах.${line("weekThanks")}`));
    }
    default:
      return update(text("Эта кнопка устарела."));
  }
}

// ---------- начало сезона (an:ss:<id>:<w|l|n>) ----------

async function handleStart(c: AnimeCtx, parts: string[]): Promise<Reply> {
  const a = await getAnime(c.repo, Number(parts[2]));
  if (!a) return update(text("Этот тайтл уже убран."));
  const name = `**${a.title_ru}**`;
  if (parts[3] === "n") {
    await c.repo.exec([deleteOp(a.id), ...weekTouch()]);
    return update(text(`Убрала ${name} из планов.`));
  }
  if (parts[3] !== "w") return update(text(`Хорошо, ${name} остаётся в планах.`));
  await c.repo.exec([patchOp(a.id, { status: "watching", notify: 1, start_asked: 1 }, c.now), ...weekTouch()]);
  const rows = (await listAnime(c.repo)).map((r) => (r.id === a.id ? { ...r, status: "watching" as const, notify: 1 } : r));
  const noticed = noticeSet(rows).some((r) => r.id === a.id);
  return update(text(`Записала: ${name} — смотрю. ${noticed ? "Буду сообщать о новых сериях." : `Уведомления идут только по первым ${NOTICE_LIMIT} тайтлам, этот пока без них.`}`));
}
