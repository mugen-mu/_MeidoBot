// Публичная лента Telegram-канала `https://t.me/s/<канал>`: чтение без входа и ключей (общий кирпич для Укрэнерго, аварийных каналов, озвучек).
// Бот ничего не пересказывает моделью: берёт текст постов, номер, время и ссылку; что с ними делать, решает тот, кто читает.
// Бесплатный план: страница ≈ 115 КБ, процессорного времени на запуск мало, поэтому разбор по `indexOf`, а не регулярками по всей странице;
// один канал = один подзапрос, а как часто его читать, решает вызывающий (не чаще раза в несколько минут).
import { decode } from "./water.ts";

export interface TgPost {
  /** канал без @ (как в ссылке) */
  channel: string;
  /** номер поста в канале: растёт со временем */
  id: number;
  /** момент публикации, мс UTC */
  at: number;
  text: string;
  link: string;
}

export const tgUrl = (channel: string): string => `https://t.me/s/${channel}`;

function cleanText(html: string): string {
  const text = decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))
    // невидимые знаки Telegram («•⁠ ⁠» у маркеров списка)
    .replace(/[⁠​­]/g, "")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Страница t.me/s/<канал> -> посты с текстом. Посты без текста (одни картинки) пропускаются. Порядок — как на странице (старые первыми). */
export function parseTgChannel(html: string): TgPost[] {
  const out: TgPost[] = [];
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
    if (text) out.push({ channel: m[1], id: Number(m[2]), at, text, link: `https://t.me/${ref}` });
  }
  return out;
}

/** Чтение ленты канала. null — не ответила, не 200 или страница не разобралась (источник «сломан»); канал с выключенным просмотром даст null. */
export async function fetchTgChannel(channel: string, fetchFn: typeof fetch = fetch): Promise<TgPost[] | null> {
  try {
    const res = await fetchFn(tgUrl(channel), { headers: { accept: "text/html", "user-agent": "MeidoBot (personal, 0.1)" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const posts = parseTgChannel(await res.text());
    return posts.length ? posts : null;
  } catch {
    return null;
  }
}
