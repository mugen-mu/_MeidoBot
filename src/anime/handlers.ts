// Аниме: действия — занесение фразой и из окна, кнопки списка и карточки, ответы на «посмотрели?».
// Ответы возвращаются как готовые тела сообщений (для cron) или как ответы Discord (для кнопок).
import { type Repo, deleteMeta, setMeta } from "../db/repo.ts";
import type { Op } from "../db/types.ts";
import type { MessageBody } from "../discord/types.ts";
import type { Character } from "../flavor.ts";
import { subtext } from "../discord/ui.ts";
import {
  type Anime,
  type AnimePhrase,
  type AnimeStatus,
  CODE_STATUS,
  STATUS_CODE,
  STATUS_LABEL,
  effective,
  findOwn,
  haru,
  norm,
  progressText,
} from "./core.ts";
import { type Candidate, type FetchFn, getShikiFull, searchShiki } from "./sources.ts";
import { deleteOp, getAnime, listAnime, patchOp, upsertOp } from "./store.ts";
import {
  NOT_FOUND_TEXT,
  SOURCE_DOWN_TEXT,
  type AskItem,
  animeCardMessage,
  animeDeleteConfirm,
  animeListMessage,
  animeModal,
  askPickMessage,
  candidatesMessage,
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

/** Что нажал хозяин в аниме: обнуляем счётчик «без ответа» и снимаем паузу вопросов. */
const touchOps = (): Op[] => [setMeta("anime_unanswered", "0"), deleteMeta("anime_ask_off"), deleteMeta("anime_ask_wait")];

const nav = (a: Anime): MessageBody["components"] => [
  { type: 1, components: [{ type: 2, style: 1, label: "Открыть", custom_id: `an:it:${a.id}:${code(a.status)}:0` }, { type: 2, style: 2, label: "🎬 К списку", custom_id: `an:ls:${code(a.status)}:0` }] },
];

function savedMessage(a: Anime, c: AnimeCtx, kind: "added" | "changed"): MessageBody {
  const e = effective(a, c.now);
  const where = `**${a.title_ru}** — ${STATUS_LABEL[a.status]}${a.watched ? `, серия ${a.watched}` : ""}`;
  const more = a.status === "watching" || a.status === "planned" ? `\n${progressText(a, c.now, c.tz)}${e.upcoming || a.src_status === "FINISHED" ? "" : ". Напомню, когда появится дата."}` : "";
  const line = haru(kind === "added" ? "added" : a.status === "dropped" ? "dropped" : "ep", c.character, c.rand);
  return { content: `Записала: ${where}.${more}${line ? `\n${subtext(line)}` : ""}`, components: nav(a), allowed_mentions: { parse: [] } };
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
  const note = patch.status === "done" ? "Досмотрели! Понравилось? Нажмите отметку." : haru("ep", c.character, c.rand) ?? undefined;
  return update(animeCardMessage(fresh, patch.status === "done" ? "d" : cd, patch.status === "done" ? 0 : page, c.now, c.tz, c.character, { note: note ? (patch.status === "done" ? note : subtext(note)) : undefined, rand: c.rand }));
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
      const line = liked ? haru("liked", c.character, c.rand) : null;
      return update(animeCardMessage({ ...a, liked }, parts[4] ?? "w", pageOf(parts[5]), c.now, c.tz, c.character, { note: line ? subtext(line) : undefined, rand: c.rand }));
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
      return update(animeCardMessage({ ...a, ...patch } as Anime, parts[4] ?? "w", pageOf(parts[5]), c.now, c.tz, c.character, { note: line ? subtext(line) : undefined, rand: c.rand }));
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


