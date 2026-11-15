// Укрэнерго (ретроспектива «аварийные отключения», 2026-11-15, вариант B): публичная лента канала t.me/s/Ukrenergo.
// Что даёт: причина и масштаб, которых нет ни у Yasno (только слоты), ни у датчика света (только «у меня есть/нет»).
// Что берём: посты, где названа Днепропетровская область — «аварийные отключения» и «последствия атак»;
// остальное (планы по регионам без названий, новости компании) молча пропускаем: график опубликует Yasno.
// Бот ничего не пересказывает моделью: короткая выдержка из поста и ссылка на него (как у воды).
// Публичная страница читается без входа; запрос раз в 10 минут, один подзапрос. Сломался источник — виден на экране «Состояние».
import { decode } from "./water.ts";
import { whenText } from "./sources.ts";
import { HOUR, MINUTE } from "./time/tz.ts";

export const UKR_URL = "https://t.me/s/Ukrenergo";
export const UKR_CHECK_EVERY = 10 * MINUTE;
/** meta: когда читать ленту в следующий раз, до какого поста дошли, очередь сообщений, последний подходящий пост */
export const UKR_NEXT_KEY = "ukr_next";
export const UKR_STATE_KEY = "ukr_state";
export const UKR_OUTBOX_KEY = "ukr_outbox";
export const UKR_LAST_KEY = "ukr_last";
/** посты старше этого срока в канал не пересылаем (бот долго молчал или первый запуск): новость уже не новость */
export const UKR_MAX_AGE = 12 * HOUR;
/** подходящий пост «свежий» для строки в сообщении «света нет» */
export const UKR_FRESH_FOR_OUTAGE = 6 * HOUR;
const MAX_NOTICES_PER_RUN = 2;
const EXCERPT_MAX = 450;
const OUTAGE_EXCERPT_MAX = 240;

// ---------- разбор страницы ----------

export interface UkrPost {
  /** номер поста в канале: растёт со временем */
  id: number;
  /** момент публикации, мс UTC */
  at: number;
  text: string;
  link: string;
}

function cleanText(html: string): string {
  const text = decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))
    // невидимые знаки Telegram («•⁠ ⁠» у маркеров списка)
    .replace(/[⁠​­]/g, "")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * Страница t.me/s/<канал> -> посты с текстом. Разбор по `indexOf`, а не регулярками по всей странице (≈ 115 КБ):
 * на бесплатном плане процессорного времени на запуск мало. Посты без текста (одни картинки) пропускаются.
 */
export function parseUkrenergo(html: string): UkrPost[] {
  const out: UkrPost[] = [];
  const parts = html.split('data-post="');
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i];
    const ref = c.slice(0, Math.max(0, c.indexOf('"')));
    const m = /^([A-Za-z0-9_]+)\/(\d+)$/.exec(ref);
    if (!m) continue;
    const at = (() => {
      const t = c.indexOf('datetime="');
      if (t < 0) return NaN;
      return Date.parse(c.slice(t + 10, c.indexOf('"', t + 10)));
    })();
    const marker = c.indexOf("js-message_text");
    if (marker < 0 || !Number.isFinite(at)) continue;
    const start = c.indexOf(">", marker);
    const end = c.indexOf("</div>", start);
    if (start < 0 || end < 0) continue;
    const text = cleanText(c.slice(start + 1, end));
    if (text) out.push({ id: Number(m[2]), at, text, link: `https://t.me/${ref}` });
  }
  return out;
}

/** Чтение ленты. null — не ответила или страница не разобралась (источник «сломан»). */
export async function fetchUkrenergo(fetchFn: typeof fetch = fetch): Promise<UkrPost[] | null> {
  try {
    const res = await fetchFn(UKR_URL, { headers: { accept: "text/html", "user-agent": "MeidoBot (personal, 0.1)" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const posts = parseUkrenergo(await res.text());
    return posts.length ? posts : null;
  } catch {
    return null;
  }
}

// ---------- что подходит ----------

export type UkrKind = "emergency" | "region";

// Область: «Дніпропетровська/-ській/-щина»; «Дніпро» как слово (не «Дніпровськ…»: там после «дніпро» идёт буква).
const REGION = /дніпропетровськ|дніпропетровщин|(?<![\p{L}])дніпр(?:о|і|а|у|ом|ові)(?![\p{L}])/iu;
const ALL = /по\s+всій\s+(?:території\s+)?(?:україн[иі]|країн[иі])|(?:усієї|всієї)\s+(?:україни|країни)|(?:у|в)\s+(?:усіх|всіх)\s+(?:областях|регіонах)|(?:усі|всі)\s+області/iu;
// «аварійні відключення», «екстрені обмеження»; без «аварійно-відновлювальні роботи» (так пишут про ремонтників)
const EMERGENCY = /(?:аварійн|екстрен)\S*\s+(?:відключ|вимкнен|обмежен)\S*/iu;
const TOPIC = /відключ|знеструмлен|електропостачан|електроенерг|світл|енергосистем|обмежен|атак/iu;

const paragraphs = (text: string): string[] => text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);

/**
 * emergency — аварийные отключения названы вместе с нашей областью (или «по всій країні») в одном абзаце;
 * region — пост называет нашу область и говорит про электроснабжение (последствия атак, срок восстановления).
 * null — не про нас.
 */
export function ukrKind(text: string): UkrKind | null {
  const paras = paragraphs(text);
  if (paras.some((p) => EMERGENCY.test(p) && (REGION.test(p) || ALL.test(p)))) return "emergency";
  if (REGION.test(text) && TOPIC.test(text)) return "region";
  return null;
}

/** Обрезка по концу предложения, иначе по слову. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > max * 0.5) return cut.slice(0, end + 1);
  const sp = cut.lastIndexOf(" ");
  return `${cut.slice(0, sp > 0 ? sp : max)}…`;
}

/**
 * Выдержка: сначала абзацы про аварийные отключения у нас (или «по всій країні») — они причина сообщения и в длинном посте
 * часто стоят в конце, — потом остальные абзацы про нашу область; ничего такого нет — первый абзац.
 */
export function ukrExcerpt(text: string, max = EXCERPT_MAX): string {
  const paras = paragraphs(text);
  const hot = paras.filter((p) => EMERGENCY.test(p) && (REGION.test(p) || ALL.test(p)));
  const rest = paras.filter((p) => REGION.test(p) && !hot.includes(p));
  const focus = [...hot, ...rest];
  return clip((focus.length ? focus : paras.slice(0, 1)).join("\n"), max);
}

// ---------- состояние и сообщения ----------

export interface UkrState {
  /** номер последнего просмотренного поста */
  last: number;
}

export interface UkrLast {
  id: number;
  at: number;
  kind: UkrKind;
  text: string;
  link: string;
}

export interface UkrNotice {
  text: string;
  mention: boolean;
}

export function parseUkrState(raw: string | undefined): UkrState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<UkrState>;
    return typeof v.last === "number" && Number.isFinite(v.last) ? { last: v.last } : null;
  } catch {
    return null;
  }
}

export function parseUkrLast(raw: string | undefined): UkrLast | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<UkrLast>;
    return typeof v.at === "number" && typeof v.text === "string" && typeof v.link === "string" && (v.kind === "emergency" || v.kind === "region") ? (v as UkrLast) : null;
  } catch {
    return null;
  }
}

const KIND_LABEL: Record<UkrKind, string> = { emergency: "аварийные отключения", region: "что с электроснабжением в области" };

/** Сообщение в «почту»: заголовок с временем поста, выдержка цитатой, ссылка без предпросмотра. */
export function ukrMessage(p: UkrPost, kind: UkrKind, now: number, tz: string): string {
  const quote = ukrExcerpt(p.text)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return [`⚡ **Укрэнерго · ${whenText(p.at, now, tz)} · ${KIND_LABEL[kind]}**`, quote, `<${p.link}>`].join("\n");
}

/**
 * Что делать с прочитанной лентой. Первое чтение: запоминаем, до какого поста дошли, и молчим (старые новости не вываливаем).
 * Дальше: новые подходящие посты — в очередь (не больше двух за раз, свежее важнее), с упоминанием только «аварийные».
 */
export function planUkrenergo(
  state: UkrState | null,
  posts: UkrPost[],
  now: number,
  tz: string,
  prevLast: UkrLast | null,
): { state: UkrState; notices: UkrNotice[]; last: UkrLast | null } {
  const sorted = [...posts].sort((a, b) => a.id - b.id);
  const maxId = sorted.length ? sorted[sorted.length - 1].id : state?.last ?? 0;
  const next: UkrState = { last: Math.max(state?.last ?? 0, maxId) };
  const relevant = sorted.flatMap((p) => {
    const kind = ukrKind(p.text);
    return kind ? [{ p, kind }] : [];
  });
  const newest = relevant.length ? relevant[relevant.length - 1] : null;
  const lastOf = (r: { p: UkrPost; kind: UkrKind }): UkrLast => ({ id: r.p.id, at: r.p.at, kind: r.kind, text: ukrExcerpt(r.p.text), link: r.p.link });
  // «последний подходящий пост» (для строки в сообщении «света нет») обновляем и на первом чтении
  const last = newest && (!prevLast || newest.p.id >= prevLast.id) ? lastOf(newest) : prevLast;
  if (!state) return { state: next, notices: [], last };
  const fresh = relevant.filter((r) => r.p.id > state.last && now - r.p.at <= UKR_MAX_AGE).slice(-MAX_NOTICES_PER_RUN);
  return { state: next, notices: fresh.map((r) => ({ text: ukrMessage(r.p, r.kind, now, tz), mention: r.kind === "emergency" })), last };
}

/** Строка в сообщение «Света нет»: свежий подходящий пост Укрэнерго (до 6 часов); иначе null. */
export function ukrAnnounceLine(raw: string | undefined, now: number, tz: string): string | null {
  const l = parseUkrLast(raw);
  if (!l || now - l.at > UKR_FRESH_FOR_OUTAGE || now < l.at) return null;
  return `⚡ Укрэнерго, ${whenText(l.at, now, tz)}: «${clip(l.text.replace(/\s*\n\s*/g, " "), OUTAGE_EXCERPT_MAX)}» <${l.link}>`;
}
