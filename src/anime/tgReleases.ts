// Выходы серий по-русски из публичных Telegram-каналов озвучек и сайтов (разведка 2026-11-19: docs/RECON-ANIME-RELEASES.md).
// Здесь чистые функции без базы и сети: разбор постов, сопоставление названия с тайтлом из списка, решение «что сказать», текст сообщения.
// Чтение страницы канала — `tgChannel.ts`, база и cron — `tgReleasesRun.ts`.
//
// Что принято (решения, чтобы не спорить заново):
//  • Telegram — главный источник «серия вышла по-русски». Shikimori остаётся для даты и номера следующей серии (в Японии), AniLibria (`voice_lag`) — для
//    «обычно озвучка через …»: это разные факты, не дублируются, а складываются в ответах «когда новая серия X» и «что вышло нового».
//  • Одна серия в нескольких озвучках — одно сообщение (первая вышедшая), остальные озвучки записываются тихо и видны в ответах; без шума.
//  • Чужие тайтлы (не из «Смотрю» и «В планах») молча пропускаются; сомнительное совпадение — тоже (лучше пропустить, чем сказать «вышла» не про то).
import type { Character } from "../flavor.ts";
import { voiceText } from "../discord/ui.ts";
import type { TgPost } from "../tgChannel.ts";
import { HOUR, MINUTE } from "../time/tz.ts";
import { type Anime, clip, norm, whenShort } from "./core.ts";

// ---------- разбор постов ----------

/** Серия вышла: название как в посте (русское), ромадзи (если канал его даёт), номер серии. */
export interface TgRelease {
  kind: "release";
  channel: string;
  postId: number;
  at: number;
  link: string;
  /** озвучка / сайт, как показываем людям: «AnimeVost», «AniDub» */
  voice: string;
  title: string;
  orig: string | null;
  ep: number;
}

/** Утреннее расписание AnimeVost: что и во сколько выйдет сегодня (время поста — МСК, у нас в UTC). */
export interface TgSchedule {
  kind: "schedule";
  channel: string;
  postId: number;
  at: number;
  voice: string;
  items: { title: string; at: number }[];
}

export type TgParsed = TgRelease | TgSchedule;

const MSK = 3 * HOUR; // Москва без перехода на летнее время с 2014 года
const firstLine = (t: string): string => t.split("\n", 1)[0].trim();

function release(p: TgPost, voice: string, title: string, ep: number, orig: string | null = null): TgRelease | null {
  const t = title.trim();
  if (!t || !Number.isInteger(ep) || ep < 1 || ep > 2000) return null;
  return { kind: "release", channel: p.channel, postId: p.id, at: p.at, link: p.link, voice, title: t, orig: orig?.trim() || null, ep };
}

/** AnimeVost: «Сасаки и Пи 2 сезон — 7 серия» + «Доступна новая серия…»; утром — «РАСПИСАНИЕ НА СЕГОДНЯ (четверг)» со строками «Название ~ (20:30)». */
export function parseAnimeVostPost(p: TgPost): TgParsed | null {
  const head = firstLine(p.text);
  if (/^РАСПИСАНИЕ\s+НА\s+СЕГОДНЯ/iu.test(head)) {
    const day = new Date(p.at + MSK);
    const items: TgSchedule["items"] = [];
    for (const line of p.text.split("\n").slice(1)) {
      const m = /^(.+?)\s*~\s*\((\d{1,2}):(\d{2})\)/u.exec(line.trim());
      if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) continue;
      items.push({ title: m[1].trim(), at: Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[2]), Number(m[3])) - MSK });
    }
    return items.length ? { kind: "schedule", channel: p.channel, postId: p.id, at: p.at, voice: "AnimeVost", items } : null;
  }
  if (!/Доступна\s+новая\s+серия/iu.test(p.text)) return null;
  const m = /^(.+?)\s+[—–-]\s+(\d{1,4})\s+серия(?:\s*\(.*\))?$/u.exec(head);
  return m ? release(p, "AnimeVost", m[1], Number(m[2])) : null;
}

/** AniDub: «Голубая шкатулка 2 / Ao no Hako Season 2 [06 из 12]» — название по-русски и ромадзи, серия «N из M» (у идущих «из XX»). */
export function parseAniDubPost(p: TgPost): TgParsed | null {
  const m = /^(.+?)\s*\[(\d{1,4})\s+из\s+[^\]]+\]/u.exec(firstLine(p.text));
  if (!m) return null;
  const names = m[1].split(/\s+\/\s+/);
  return release(p, "AniDub", names[0], Number(m[2]), names.slice(1).join(" / "));
}

/** AniLibria (дубляж по заказу DEEP): три формы поста; анонсы «выйдет в пятницу» сюда не попадают (нужно прошедшее время). */
export function parseAniLibriaPost(p: TgPost): TgParsed | null {
  const head = firstLine(p.text);
  const a = /^Вышла\s+(\d{1,4})-?я?\s+серия\s+аниме\s+["«“„](.+?)["»”“]/u.exec(head);
  if (a) return release(p, "AniLibria", a[2], Number(a[1]));
  const h = /^["«“„](.+?)["»”“]\s+(?:[—–-]\s+)?(?:в\s+)?(?:официальном\s+)?дубляже\s+AniLibria/iu.exec(head);
  if (!h) return null;
  const b = /Вышла\s+(\d{1,4})-?я?\s+серия/u.exec(p.text);
  if (b) return release(p, "AniLibria", h[1], Number(b[1]));
  const c = /можно\s+посмотреть\s+(\d{1,4})-?ю\s+серию(?:\s+(\d{1,2})-?го\s+сезона)?/u.exec(p.text);
  return c ? release(p, "AniLibria", c[2] ? `${h[1]} ${c[2]} сезон` : h[1], Number(c[1])) : null;
}

/** AniMedia (Amedia): «Вышла новая серия «Вечная воля 4» [20 из 46]» (в одной строке с шутками и объявлениями — ищем по всему посту). */
export function parseAniMediaPost(p: TgPost): TgParsed | null {
  const m = /Вышла\s+новая\s+серия\s+«(.+?)»\s*\[(\d{1,4})\s+из\s+[^\]]+\]/u.exec(p.text);
  return m ? release(p, "AniMedia", m[1], Number(m[2])) : null;
}

export interface TgChannelSpec {
  /** имя канала в ссылке t.me/s/<канал> */
  channel: string;
  /** как называем озвучку / сайт в сообщении */
  voice: string;
  /** как часто читать этот канал (раз за запуск читаем не больше одного канала) */
  every: number;
  parse: (p: TgPost) => TgParsed | null;
}

/** Стартовый список (какие каналы годятся и почему — docs/RECON-ANIME-RELEASES.md). Выключить канал без выкладки: meta `anime_tg_off`. */
export const TG_CHANNELS: TgChannelSpec[] = [
  { channel: "animevost", voice: "AnimeVost", every: 15 * MINUTE, parse: parseAnimeVostPost },
  { channel: "anidub", voice: "AniDub", every: 15 * MINUTE, parse: parseAniDubPost },
  { channel: "anilibria_tv", voice: "AniLibria", every: 30 * MINUTE, parse: parseAniLibriaPost },
  { channel: "AnimeMediaNews", voice: "AniMedia", every: 30 * MINUTE, parse: parseAniMediaPost },
];

/** meta `anime_tg_off`: «all» — не читать вовсе; иначе названия каналов через запятую. */
export function parseTgOff(raw: string | undefined): { all: boolean; set: Set<string> } {
  const parts = (raw ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { all: parts.includes("all"), set: new Set(parts) };
}

// ---------- название: сезон и основа ----------

export interface Canon {
  /** основа названия без номера сезона и коротких слов, слова обрезаны до 5 букв (склонения) */
  stems: string[];
  /** номер сезона, если он есть в названии */
  season: number | null;
}

const ORD: Record<string, number> = { второй: 2, третий: 3, четвертый: 4, пятый: 5, шестой: 6, седьмой: 7, восьмой: 8, девятый: 9, десятый: 10, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 };
const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4 };

const seasonNumber = (t: string): number | null => {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  const n = m ? Number(m[1]) : ORD[t];
  return n !== undefined && n >= 1 && n <= 20 ? n : null;
};

/** «Сасаки и Пи (второй сезон)», «Sasaki to Pii-chan Season 2», «Ранма ½ (2024) 3» → основа + номер сезона. */
export function canon(title: string): Canon {
  const toks = norm(title.replace(/(\d)\s*-\s*(?:й|ой|го|ый)(?![\p{L}])/giu, "$1")).split(" ").filter(Boolean);
  let season: number | null = null;
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const nx = toks[i + 1];
    if ((nx === "сезон" || nx === "season") && seasonNumber(t) !== null) {
      season = seasonNumber(t);
      i++;
    } else if ((t === "сезон" || t === "season") && nx !== undefined && /^\d{1,2}$/.test(nx)) {
      season = Number(nx);
      i++;
    } else out.push(t);
  }
  if (season === null && out.length >= 2) {
    const last = out[out.length - 1];
    if (/^[2-9]$/.test(last)) {
      season = Number(last);
      out.pop();
    } else if (ROMAN[last] !== undefined) {
      season = ROMAN[last];
      out.pop();
    }
  }
  const words = out.filter((w) => w.length > 1); // однобуквенные «и», «в», «с» не слова названия
  return { stems: (words.length ? words : out).map((w) => (w.length > 5 ? w.slice(0, 5) : w)), season };
}

/**
 * Одно и то же название: сезон совпал (нет номера = первый), слова совпали целиком или почти (три из четырёх); либо в одном названии
 * все слова другого плюс не больше одного лишнего («Сасаки и Пи» — «Сасаки и Пи-тян»). Подзаголовок из нескольких слов — уже другая часть, не совпадение.
 */
export function sameTitle(a: Canon, b: Canon): boolean {
  if ((a.season ?? 1) !== (b.season ?? 1) || !a.stems.length || !b.stems.length) return false;
  const sb = new Set(b.stems);
  const sa = new Set(a.stems);
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  const union = sa.size + sb.size - inter;
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  if (inter === small.size && small.size >= 2 && big.size <= small.size + 1) return true;
  return inter === union || (inter >= 2 && inter / union >= 0.75);
}

export interface TitleIndex {
  rows: { a: Anime; ru: Canon; orig: Canon | null }[];
}

/** Тайтлы, которым нужны выходы: «Смотрю» и «В планах» (законченные и брошенные молча пропускаем). */
export function buildIndex(rows: Anime[]): TitleIndex {
  return {
    rows: rows
      .filter((a) => a.status === "watching" || a.status === "planned")
      .map((a) => ({ a, ru: canon(a.title_ru), orig: a.title_orig ? canon(a.title_orig) : null })),
  };
}

/**
 * Какому тайтлу из списка принадлежит пост: по русскому названию и/или ромадзи, с проверкой номера сезона и того, что серия
 * не больше известного числа серий. Единственное совпадение — оно; несколько — «Смотрю» важнее «В планах»; всё ещё несколько — никому.
 */
export function matchTitle(index: TitleIndex, title: string, orig: string | null, ep: number): Anime | null {
  const t = canon(title);
  const o = orig ? canon(orig) : null;
  const hits = index.rows.filter(
    (r) =>
      (!r.a.episodes || ep === 0 || ep <= r.a.episodes) &&
      (sameTitle(t, r.ru) || (r.orig !== null && sameTitle(t, r.orig)) || (o !== null && (sameTitle(o, r.ru) || (r.orig !== null && sameTitle(o, r.orig))))),
  );
  if (hits.length <= 1) return hits[0]?.a ?? null;
  const watching = hits.filter((r) => r.a.status === "watching");
  return watching.length === 1 ? watching[0].a : null;
}

// ---------- что известно и что сказать ----------

/** Строка таблицы `anime_ru`: последняя серия, вышедшая по-русски. ep = 0 — серий не видели (есть только время из расписания). */
export interface RuRow {
  anime_id: number;
  ep: number;
  at: number;
  /** озвучки этой серии через запятую */
  voices: string;
  link: string;
  /** когда AnimeVost обещал серию сегодня (мс UTC) */
  next_at: number | null;
  updated_at: number;
}

/** Посты старше этого срока в чат не пересылаем (долго молчала, тихие часы, первый запуск): «вышла» про позавчера — не новость. */
export const TG_MAX_AGE = 12 * HOUR;

export interface RuNotice {
  a: Anime;
  /** новые серии (по возрастанию), которых мы ещё не видели */
  eps: number[];
  voices: string[];
  link: string;
  at: number;
}

export interface RuWrite {
  a: Anime;
  ep: number;
  at: number;
  voices: string[];
  link: string;
  /** только добавилась озвучка к уже известной серии */
  voicesOnly: boolean;
}

export interface RuPlan {
  notices: RuNotice[];
  writes: RuWrite[];
  /** время «сегодня выйдет» из расписания AnimeVost */
  nexts: { a: Anime; at: number }[];
}

const voicesOf = (r: RuRow | undefined): string[] => (r?.voices ? r.voices.split(",").map((s) => s.trim()).filter(Boolean) : []);

/**
 * Свежие посты → что записать в `anime_ru` и о чём сказать.
 * Говорим: только не на первом чтении канала; серия новее известной; пост не старше 12 часов; для «Смотрю» — с колокольчиком и среди первых
 * пяти (как остальные аниме-уведомления) и если вы ещё не отметили эту серию; для «В планах» — только первая серия.
 * Серия в другой озвучке — тихо добавляем озвучку; серия старее известной — игнорируем.
 */
export function planReleases(a: {
  index: TitleIndex;
  noticeIds: Set<number>;
  known: Map<number, RuRow>;
  parsed: TgParsed[];
  now: number;
  /** первое чтение канала: записываем всё, но молчим */
  silent: boolean;
}): RuPlan {
  const plan: RuPlan = { notices: [], writes: [], nexts: [] };
  // расписание: сначала, чтобы вышедшая позже серия сняла «ждём сегодня»
  for (const p of a.parsed) {
    if (p.kind !== "schedule") continue;
    for (const it of p.items) {
      const m = matchTitle(a.index, it.title, null, 0);
      const k = m ? a.known.get(m.id) : undefined;
      if (m && it.at > a.now - 2 * HOUR && !(k && k.at > p.at)) plan.nexts.push({ a: m, at: it.at });
    }
  }
  const byTitle = new Map<number, { a: Anime; rels: TgRelease[] }>();
  for (const p of a.parsed) {
    if (p.kind !== "release") continue;
    const m = matchTitle(a.index, p.title, p.orig, p.ep);
    if (!m) continue;
    const g = byTitle.get(m.id) ?? { a: m, rels: [] };
    g.rels.push(p);
    byTitle.set(m.id, g);
  }
  for (const { a: anime, rels } of byTitle.values()) {
    const cur = a.known.get(anime.id);
    const curEp = cur?.ep ?? 0;
    const maxEp = Math.max(...rels.map((r) => r.ep));
    if (maxEp < curEp) continue;
    const top = rels.filter((r) => r.ep === maxEp).sort((x, y) => x.at - y.at);
    const voices = [...new Set([...(maxEp === curEp ? voicesOf(cur) : []), ...top.map((r) => r.voice)])];
    if (maxEp === curEp) {
      if (voices.length > voicesOf(cur).length) plan.writes.push({ a: anime, ep: maxEp, at: cur?.at ?? top[0].at, voices, link: cur?.link ?? top[0].link, voicesOnly: true });
      continue;
    }
    const eps = [...new Set(rels.filter((r) => r.ep > curEp).map((r) => r.ep))].sort((x, y) => x - y);
    plan.writes.push({ a: anime, ep: maxEp, at: top[0].at, voices, link: top[0].link, voicesOnly: false });
    const wanted = anime.status === "watching" ? a.noticeIds.has(anime.id) && anime.watched < maxEp : maxEp === 1 && curEp === 0;
    if (!a.silent && wanted && a.now - top[0].at <= TG_MAX_AGE) plan.notices.push({ a: anime, eps, voices, link: top[0].link, at: top[0].at });
  }
  return plan;
}

// ---------- сообщения ----------

const joinVoices = (v: string[]): string => (v.length === 2 ? `${v[0]} и ${v[1]}` : v.join(", "));

/** «Вышла 7-я серия», «Вышли 7-я и 8-я серии», «Вышли серии 7, 8, 9». */
export function epsText(eps: number[]): string {
  if (eps.length === 1) return `Вышла ${eps[0]}-я серия`;
  if (eps.length === 2) return `Вышли ${eps[0]}-я и ${eps[1]}-я серии`;
  return `Вышли серии ${eps.join(", ")}`;
}

const LINES = [
  "Свежая серия, хозяин. Чай заварила, я рядом.",
  "Я не смотрю, я докладываю. Но выглядит заманчиво.",
  "Вышло по-русски. Не благодарите, я просто стояла рядом.",
];

/** Сообщение «🎧 Вышла серия …»: одна серия — одно предложение со ссылкой на пост, несколько тайтлов — список. Строка Хару — только при характере «горничная». */
export function releaseMessage(notices: RuNotice[], ch: Character, rand: () => number = Math.random): string {
  const mark = (n: RuNotice): string => (n.a.status === "planned" ? " (из ваших планов)" : "");
  let text: string;
  if (notices.length === 1) {
    const n = notices[0];
    text = `🎧 ${epsText(n.eps)} «${clip(n.a.title_ru, 70)}» в озвучке ${joinVoices(n.voices)}${mark(n)}\n<${n.link}>`;
  } else {
    const lines = notices.slice(0, 8).map((n) => `• **${clip(n.a.title_ru, 60)}** — ${n.eps.length === 1 ? `${n.eps[0]}-я серия` : `серии ${n.eps.join(", ")}`}, озвучка ${joinVoices(n.voices)}${mark(n)} <${n.link}>`);
    text = `🎧 **Вышло по-русски**\n${lines.join("\n")}${notices.length > 8 ? `\n…и ещё ${notices.length - 8}` : ""}`;
  }
  return ch === "maid" ? `${text}\n${voiceText(LINES[Math.floor(rand() * LINES.length) % LINES.length])}` : text;
}

/** Хвост строки «что вышло нового»: какая озвучка и до какой серии дошли (пусто, если по-русски ничего не видели). */
export function ruNewsTail(r: RuRow | undefined, airedEp: number): string {
  if (!r || r.ep < 1) return "";
  return r.ep >= airedEp ? ` · 🎧 ${joinVoices(voicesOf(r))}` : ` · 🎧 по-русски пока ${r.ep}-я`;
}

/** Строки к ответу «когда новая серия X»: что вышло по-русски и (если AnimeVost назвал время) когда ждать сегодня. Пусто, если данных нет. */
export function ruNextLines(r: RuRow | undefined, now: number, tz: string): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (r.ep >= 1) out.push(`🎧 По-русски вышла ${r.ep}-я: ${joinVoices(voicesOf(r))}, ${whenShort(r.at, now, tz)}.`);
  if (r.next_at !== null && r.next_at > now - 2 * HOUR) out.push(`🎧 По расписанию AnimeVost следующая: ${whenShort(r.next_at, now, tz)}${r.next_at < now ? " (пока не вышла)" : ""}.`);
  return out;
}

// ---------- состояние чтения каналов (meta `anime_tg`) ----------

/** По каналу: до какого поста дошли (null — ещё не читали), когда читать в следующий раз, сколько неудач подряд. */
export interface TgChanState {
  last: number | null;
  next: number;
  fails: number;
}
export type TgState = Record<string, TgChanState>;

export function parseTgState(raw: string | undefined): TgState {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: TgState = {};
    for (const [k, x] of Object.entries(v)) {
      if (!Array.isArray(x)) continue;
      const [l, n, f] = x as unknown[];
      out[k] = { last: typeof l === "number" && Number.isFinite(l) ? l : null, next: typeof n === "number" && Number.isFinite(n) ? n : 0, fails: typeof f === "number" && f > 0 ? Math.floor(f) : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

export const serializeTgState = (s: TgState): string => JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, x]) => [k, [x.last, x.next, x.fails]])));

/** Какой канал читать сейчас: у кого срок вышел раньше всех (за запуск — один канал, чтобы нагрузка не копилась). */
export function dueChannel(specs: TgChannelSpec[], state: TgState, now: number): TgChannelSpec | null {
  let best: TgChannelSpec | null = null;
  for (const s of specs) {
    const n = state[s.channel]?.next ?? 0;
    if (n <= now && (!best || n < (state[best.channel]?.next ?? 0))) best = s;
  }
  return best;
}

/** Через сколько пробовать канал снова после неудачи: срок удваивается с каждой неудачей подряд, но не больше 6 часов. */
export const retryAfter = (every: number, fails: number): number => Math.min(every * 2 ** Math.min(fails, 6), 6 * HOUR);
