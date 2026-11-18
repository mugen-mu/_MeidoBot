// Аниме: запасной разбор фразы языковой моделью (решение Ihor, анкета волны 4: «Да, всегда»).
// Когда ни одно правило (say.ts, mark.ts, вопросы, чтение, дела со временем) не узнало сообщение, а модель включена («⋯ Ещё» → «Понимание моделью»)
// и бесплатная норма нейронов не на исходе, спрашиваем модель одним вызовом: не про аниме ли это. Если да, действие выполняют те же обработчики, что и у правил
// (handleSay / handleMark / handleAnimeAsk), поэтому ответ честный: «Записала: …».
// Осторожность: модели не доверяем (ответ проверяется строго, название сверяется с текстом и со списком), секреты, фразы со временем,
// длинные и со ссылками в модель не уходят, любой сбой — молча «как раньше» (обычное дело), текст сообщения нигде не пишется.
import type { MessageBody } from "../discord/types.ts";
import { type AiBinding, LLM_MODEL, LLM_TIMEOUT_MS, extractJson, replyText } from "../llm.ts";
import { detectSecret } from "../secrets.ts";
import { type AppSettings, timeOpts } from "../settings.ts";
import { parseInput } from "../time/parse.ts";
import { type DayUsage, aiHasRoom } from "../usage.ts";
import { type Anime, type AnimeStatus, STATUS_LABEL, clip, findOwnSeason, likeWords, norm } from "./core.ts";
import { type AnimeCtx, handleAnimeAsk, handleMark, handleSay } from "./handlers.ts";
import type { Liked } from "./mark.ts";
import { MAX_QUERY, PREFIX, type SayPhrase } from "./say.ts";
import { listAnime } from "./store.ts";

/** Длиннее — это не короткая фраза про аниме: в модель не отправляем (и экономим нейроны). */
export const LLM_MAX_CHARS = 200;
/** Сколько раз за один запуск cron можно спросить модель про аниме: пачка сообщений не должна съесть норму и время запуска. */
export const LLM_PER_RUN = 6;

export type LlmAction = "episode" | "status" | "rate" | "ask_watching" | "ask_planned" | "ask_news" | "ask_next" | "ask_did";

export interface LlmAnime {
  action: LlmAction;
  /** название как в сообщении (проверено: оно действительно есть в тексте); null — не названо */
  title: string | null;
  /** номер серии, «last» — последняя вышедшая, «next» — следующая, null — не названа */
  episode: number | "last" | "next" | null;
  season: number | null;
  status: AnimeStatus | null;
  liked: Liked | null;
  /** модель уверена, что фраза про аниме */
  sure: boolean;
}

const ACTIONS: ReadonlySet<string> = new Set<LlmAction>(["episode", "status", "rate", "ask_watching", "ask_planned", "ask_news", "ask_next", "ask_did"]);
const STATUSES: ReadonlySet<string> = new Set<AnimeStatus>(["watching", "dropped", "planned", "done"]);

/** Как бот просит модель разобрать фразу: действия, поля и три примера. Время и дата не нужны (их разбирает обычный разбор). */
export function buildAnimePrompt(): string {
  return `Ты разбираешь короткие русские фразы хозяина бота про его аниме. Верни ТОЛЬКО JSON без пояснений:
{"action":"…","title":"…","episode":…,"season":…,"status":"…","liked":…,"sure":true}
action:
none — фраза НЕ про аниме из его списка (дело, покупка, напоминание, болтовня) или ты сомневаешься;
episode — посмотрел серию; episode: номер, или "last" (последняя вышедшая), или "next" (следующая, номер не назван);
status — статус тайтла; status: watching (смотрю), dropped (бросил), planned (в планах, на потом), done (посмотрел целиком);
rate — оценка тайтла словами или числом; liked: 2 (в восторге, 9–10), 1 (понравилось, 7–8), -1 (так себе, 5–6), -2 (не зашло, 4 и ниже);
ask_watching — что я смотрю сейчас; ask_planned — что отложено или в планах; ask_news — что вышло нового; ask_next — когда следующая серия (title или null); ask_did — смотрел ли я тайтл или какую оценку поставил.
title — название ровно как в фразе (по-русски, по-английски или ромадзи; падеж можно привести к начальному), без слов про серию, сезон и оценку; не выдумывать и не переводить; null, если не названо. season — номер сезона или null. Ненужные поля — null. sure — true, только если уверен, что фраза про аниме.
«Фрирен наконец досмотрел» → {"action":"status","title":"Фрирен","episode":null,"season":null,"status":"done","liked":null,"sure":true}
«Блич на 8 из 10» → {"action":"rate","title":"Блич","episode":null,"season":null,"status":null,"liked":1,"sure":true}
«купить хлеб» → {"action":"none","title":null,"episode":null,"season":null,"status":null,"liked":null,"sure":false}`;
}

// ---------- проверка ответа модели ----------

/** «Фрирена» ≈ «Фрирен», «битву» ≈ «битва»: слова близки, если одно начинается с основы другого (основа — слово без двух последних букв; короткие слова точно). */
const stem = (w: string): string => (w.length <= 4 ? w : w.slice(0, -2));
const near = (a: string, b: string): boolean => a === b || a.startsWith(stem(b)) || b.startsWith(stem(a));
const words = (s: string): string[] => norm(s).split(" ").filter(Boolean);

/** Название от модели годится: непустое, не длинное, без служебных символов и действительно есть в сообщении (иначе модель его выдумала или перевела). */
export function titleInMessage(title: unknown, original: string): title is string {
  if (typeof title !== "string") return false;
  const t = title.trim();
  if (t.length < 2 || t.length > MAX_QUERY || /[\r\n`]|https?:/i.test(t)) return false;
  const q = words(t);
  if (!q.length || norm(t).length < 2) return false;
  const have = words(original);
  return q.every((x) => have.some((w) => near(x, w)));
}

const intIn = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "string" && /^\d{1,4}$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const absent = (v: unknown): boolean => v === null || v === undefined || v === "";

/** Оценка числом (на случай, если модель вернула балл, а не liked): 9–10 → 2, 7–8 → 1, 5–6 → −1, ≤4 → −2. */
function likedFromScore(v: unknown): Liked | null {
  const n = intIn(v, 1, 10);
  return n === null ? null : n >= 9 ? 2 : n >= 7 ? 1 : n >= 5 ? -1 : -2;
}

/**
 * Превращает ответ модели в разобранное действие или null («none», мусор, неизвестное действие, неверные значения, выдуманное название) —
 * тогда сообщение идёт дальше как раньше. Чистая функция: проверяется без сети.
 */
export function interpretAnimeReply(text: string, original: string): LlmAnime | null {
  const j = extractJson(text);
  if (!j) return null;
  const action = typeof j.action === "string" ? j.action.trim().toLowerCase() : "";
  if (!ACTIONS.has(action)) return null;
  const a = action as LlmAction;
  let title: string | null = null;
  if (!absent(j.title)) {
    if (!titleInMessage(j.title, original)) return null;
    title = (j.title as string).trim();
  }
  if (title === null && a !== "ask_watching" && a !== "ask_planned" && a !== "ask_news" && a !== "ask_next") return null;
  let season: number | null = null;
  if (!absent(j.season)) {
    season = intIn(j.season, 1, 30);
    if (season === null) return null;
  }
  let episode: LlmAnime["episode"] = null;
  if (!absent(j.episode)) {
    const e = typeof j.episode === "string" ? j.episode.trim().toLowerCase() : j.episode;
    if (e === "last" || e === "next") episode = e;
    else {
      const n = intIn(e, 1, 3000);
      if (n === null) return null;
      episode = n;
    }
  }
  let status: AnimeStatus | null = null;
  if (a === "status") {
    const s = typeof j.status === "string" ? j.status.trim().toLowerCase() : "";
    if (!STATUSES.has(s)) return null;
    status = s as AnimeStatus;
  }
  let liked: Liked | null = null;
  if (a === "rate") {
    const n = typeof j.liked === "string" && /^-?\d$/.test(j.liked.trim()) ? Number(j.liked.trim()) : j.liked;
    liked = n === 2 || n === 1 || n === -1 || n === -2 ? n : absent(j.liked) ? likedFromScore(j.score) : null;
    if (liked === null) return null;
  }
  return { action: a, title, episode, season, status, liked, sure: j.sure === true };
}

// ---------- вызов модели ----------

/** Ответ классификатора: `failed` — модель не ответила или ответила не JSON (счётчик сбоев в запуске); `found` — разобранное действие или null («не про аниме»). */
export async function classifyAnime(ai: AiBinding, text: string, timeoutMs: number = LLM_TIMEOUT_MS): Promise<{ failed: boolean; found: LlmAnime | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = ai.run(LLM_MODEL, {
      messages: [
        { role: "system", content: buildAnimePrompt() },
        { role: "user", content: text.trim().slice(0, LLM_MAX_CHARS) },
      ],
      max_tokens: 120,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const out = await Promise.race([call, timeout]);
    call.catch(() => undefined); // поздний сбой после таймаута не должен ронять Worker
    const reply = out === null ? null : replyText(out);
    if (!reply || !extractJson(reply)) return { failed: true, found: null };
    return { failed: false, found: interpretAnimeReply(reply, text) };
  } catch {
    return { failed: true, found: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- когда можно спрашивать модель ----------

/** Оценка числом «Блич 10/10» обычный разбор принимает за дату (10 октября): такие фразы всё же показываем модели. */
const SCORE = /(?:^|\s)\d{1,2}\s*\/\s*10(?=$|[\s.,!?…)])/u;
const LINK = /https?:|www\./i;

/**
 * Можно ли отправлять сообщение в модель. Нет, если: секрет (пароль, ключ, карта), длиннее LLM_MAX_CHARS, несколько строк, ссылка,
 * обычный разбор уже понял время или повтор (это дело со своим путём, расход не удваиваем), бесплатная норма нейронов от WARN_AT.
 */
export function animeLlmGate(text: string, o: { now: number; at: number; settings: AppSettings; days: DayUsage[]; neurons: number }): boolean {
  const t = text.trim();
  if (!t || t.length > LLM_MAX_CHARS || /[\r\n]/.test(t) || LINK.test(t)) return false;
  if (detectSecret(t).secret) return false;
  if (!aiHasRoom(o.days, o.now, o.neurons)) return false;
  const p = parseInput(t, { now: o.at, ...timeOpts(o.settings) });
  if (!p.title || p.seriesEmpty) return false;
  const dated = p.recipe !== null || p.timer || (p.due !== null && !p.past);
  return !dated || SCORE.test(t);
}

// ---------- сверка названия со списком ----------

export type Resolved = { kind: "own"; row: Anime } | { kind: "several"; rows: Anime[] } | { kind: "none" };

const fuzzyHit = (a: Anime, title: string): boolean => {
  const q = words(title);
  if (!q.length) return false;
  const have = words(`${a.title_ru} ${a.title_orig ?? ""}`);
  return q.every((t) => have.some((w) => near(t, w)));
};

/**
 * Название от модели → запись его списка. Сначала как правила (findOwnSeason, сезон учитывается), затем с поправкой на падеж («Фрирена»).
 * Нашлась ровно одна запись — own; несколько — several; ни одной — none. Новых названий здесь не заводим.
 */
export function resolveOwn(rows: Anime[], title: string, season: number | null): Resolved {
  let row = findOwnSeason(rows, title, season);
  if (!row) {
    const fz = rows.filter((a) => fuzzyHit(a, title));
    if (fz.length > 1) return { kind: "several", rows: fz };
    if (fz.length === 0) return { kind: "none" };
    row = fz[0];
  }
  // обработчики сами ищут запись по названию: убедимся, что по полному названию они найдут именно эту, а не соседний сезон
  if (findOwnSeason(rows, row.title_ru, season)?.id !== row.id) {
    const q = norm(row.title_ru);
    return { kind: "several", rows: rows.filter((a) => norm(a.title_ru).includes(q) || norm(a.title_orig ?? "").includes(q)) };
  }
  return { kind: "own", row };
}

// ---------- ответы ----------

const text = (content: string): MessageBody => ({ content, components: [], allowed_mentions: { parse: [] } });
const NOTE = "-# поняла по смыслу";
/** Пометка под записью: подсказывает, что фраза понята моделью, а не правилом (чтобы поправить, если не так). Длинный ответ не трогаем. */
const noted = (b: MessageBody): MessageBody => {
  const c = b.content ?? "";
  return c && c.length + NOTE.length + 1 < 1990 ? { ...b, content: `${c}\n${NOTE}` } : b;
};
const severalText = (rows: Anime[]): string => `Подходит несколько: ${rows.slice(0, 4).map((h) => `«${clip(h.title_ru, 40)}»`).join(", ")}. Напишите название точнее.`;
const missingText = (title: string): string => `«${clip(title, 40)}» в вашем списке нет. Если это аниме, добавьте: «бот смотрю ${clip(title, 40)}».`;

const MARK_WORD: Record<Liked, string> = { 2: "в восторге", 1: "понравилось", [-1]: "так себе", [-2]: "не зашло" };
/** Фраза с «бот» в начале, которую поймут правила: так хозяин одним сообщением подтверждает догадку. */
function confirmPhrase(f: LlmAnime, title: string): string {
  if (f.action === "rate") return `бот ${title} ${MARK_WORD[f.liked as Liked]}`;
  if (f.action === "episode") {
    if (typeof f.episode === "number") return `бот смотрю ${title} серия ${f.episode}`;
    return f.episode === "last" ? `бот глянул последнюю серию ${title}` : `бот посмотрел серию ${title}`;
  }
  const verb = { watching: "смотрю", dropped: "бросил", planned: "хочу", done: "посмотрел" }[f.status as AnimeStatus];
  return `бот ${verb} ${title}`;
}

/** «Так?»: модель не уверена, а название в списке есть. Ничего не записываем, один раз спрашиваем и подсказываем ответ. */
function guessText(f: LlmAnime, own: Anime): string {
  const what =
    f.action === "rate"
      ? likeWords(f.liked as Liked)
      : f.action === "episode"
        ? typeof f.episode === "number" ? `серия ${f.episode}` : f.episode === "last" ? "последняя серия" : "следующая серия"
        : STATUS_LABEL[f.status as AnimeStatus].toLowerCase();
  return `Так? **${clip(own.title_ru, 60)}** — ${what}. Если да, напишите «${confirmPhrase(f, clip(f.title as string, 40))}».`;
}

export const hasPrefix = (raw: string): boolean => {
  const t = raw.trim();
  const pm = PREFIX.exec(t);
  return !!pm && pm[0].trim().length > 0 && t.length > pm[0].length;
};

function sayOf(f: LlmAnime, query: string, prefixed: boolean): SayPhrase {
  if (f.action === "episode") {
    const out: SayPhrase = { status: "watching", query, episode: typeof f.episode === "number" ? f.episode : null, prefixed };
    if (f.episode === "last") out.latest = true;
    else if (f.episode === null || f.episode === "next") out.next = true;
    if (f.season !== null) out.season = f.season;
    return out;
  }
  const status = f.status as AnimeStatus;
  const out: SayPhrase = { status, query, episode: (status === "watching" || status === "dropped") && typeof f.episode === "number" ? f.episode : null, prefixed };
  if (f.season !== null) out.season = f.season;
  return out;
}

/** Выполнить разобранное действие теми же обработчиками, что и правила. null — это всё же не наше сообщение (идём дальше как дело). */
export async function runAnimeLlm(c: AnimeCtx, f: LlmAnime, original: string): Promise<MessageBody | null> {
  const ask = f.action.startsWith("ask_");
  if (ask && !f.sure) return null; // вопрос без уверенности — скорее болтовня или дело
  const prefixed = hasPrefix(original);
  if (f.action === "ask_watching" || f.action === "ask_planned" || f.action === "ask_news") {
    return handleAnimeAsk(c, { kind: f.action === "ask_watching" ? "watching" : f.action === "ask_planned" ? "planned" : "news" });
  }
  if (f.title === null) return handleAnimeAsk(c, { kind: "next", query: null }); // ask_next без названия: ближайшие серии
  const rows = await listAnime(c.repo);
  const r = resolveOwn(rows, f.title, f.season);
  if (r.kind === "several") return f.sure ? text(severalText(r.rows)) : null;
  const season = f.season ?? undefined;
  if (r.kind === "none") {
    if (!f.sure) return null; // не уверена и названия в списке нет — это обычное дело
    if (f.action === "ask_did") return handleAnimeAsk(c, { kind: "did", query: f.title, season, sure: true });
    if (f.action === "ask_next") return handleAnimeAsk(c, { kind: "next", query: f.title });
    if (!prefixed) return text(missingText(f.title)); // новые названия без обращения сами не добавляем
    const reply = f.action === "rate"
      ? await handleMark(c, { liked: f.liked as Liked, query: f.title, prefixed: true, ...(season ? { season } : {}) })
      : await handleSay(c, sayOf(f, f.title, true));
    return reply ? noted(reply) : null;
  }
  const own = r.row;
  if (f.action === "ask_did") return handleAnimeAsk(c, { kind: "did", query: own.title_ru, season, sure: true });
  if (f.action === "ask_next") return handleAnimeAsk(c, { kind: "next", query: own.title_ru });
  if (!f.sure) return text(guessText(f, own));
  const reply = f.action === "rate"
    ? await handleMark(c, { liked: f.liked as Liked, query: own.title_ru, prefixed, ...(season ? { season } : {}) })
    : await handleSay(c, sayOf(f, own.title_ru, prefixed));
  return reply ? noted(reply) : null;
}

/** Состояние внутри одного запуска cron: сколько раз спросили модель и не упала ли она (после сбоя до конца запуска не спрашиваем). */
export interface AnimeLlmRun {
  calls: number;
  down: boolean;
}

/**
 * Запасной путь для сообщения, которое не узнали правила. Возвращает готовое тело ответа или null (идти дальше обычным делом).
 * Не бросает исключений из-за модели; BudgetExceeded и ошибки базы в обработчиках пробрасываются, как у правил.
 */
export async function animeViaModel(a: {
  ai: AiBinding;
  text: string;
  /** сейчас (по часам запуска) и время отправки сообщения */
  now: number;
  at: number;
  settings: AppSettings;
  days: DayUsage[];
  /** нейроны, уже потраченные в этом запуске (repo.counter.neurons) */
  neurons: number;
  run: AnimeLlmRun;
  ctx: AnimeCtx;
  spend: (n: number) => void;
  timeoutMs?: number;
}): Promise<MessageBody | null> {
  if (a.run.down || a.run.calls >= LLM_PER_RUN) return null;
  if (!animeLlmGate(a.text, { now: a.now, at: a.at, settings: a.settings, days: a.days, neurons: a.neurons })) return null;
  a.run.calls++;
  a.spend(1); // обращение к модели считаем подзапросом
  const out = await classifyAnime(a.ai, a.text, a.timeoutMs);
  if (out.failed) {
    a.run.down = true;
    return null;
  }
  return out.found ? runAnimeLlm(a.ctx, out.found, a.text) : null;
}
