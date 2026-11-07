// Языковая модель (Cloudflare Workers AI, gemma-4): запасной путь понимания фразы, когда обычный разбор не нашёл время.
// Шаг 1 по решению пользователя 2026-11-08: режим выключен по умолчанию (/settings), при ЛЮБОМ сбое молча работаем как раньше.
// В модель уходит только текст самого дела (секреты отсеиваются в intake.ts до вызова); ответ проверяется и никогда не пишется в журнал.
import { type Parsed, parseInput } from "./time/parse.ts";
import { wallOf, wallToUtc } from "./time/tz.ts";

/** Минимум, который мы требуем от привязки AI (в Worker — env.AI; в тестах — заглушка). */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export const LLM_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Ответ на команду Discord должен уйти за 3 с, поэтому ждём модель недолго (медиана в пробе — 0,9 с). */
export const LLM_TIMEOUT_MS = 2000;

const WEEKDAY = ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const pad = (n: number) => String(n).padStart(2, "0");

export function buildPrompt(now: number, tz: string): string {
  const w = wallOf(now, tz);
  const stamp = `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
  return `Ты разбираешь короткие русские заметки о делах для бота-напоминалки. Сейчас ${WEEKDAY[w.wd]}, ${stamp}.
Верни ТОЛЬКО JSON без пояснений: {"title": "...", "when_iso": "...", "repeat": "..."}
title — суть дела с большой буквы, без слов о времени, слова пользователя не выдумывать. when_iso — время первого срабатывания в виде 2026-11-14T14:00 или null, если времени нет или оно неясно. Если время суток не названо — 09:00; «утром» 09:00, «в обед» 13:00, «после обеда» 14:00, «вечером» 19:00. Даты пользователь пишет в американском порядке: месяц.день. repeat — если дело повторяется, фраза вида «каждый понедельник в 9:00», иначе null.`;
}

/** Достаёт текст ответа из двух возможных форм ответа Workers AI. */
function replyText(out: unknown): string | null {
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  if (!o || typeof o !== "object") return null;
  const t = o.response ?? o.choices?.[0]?.message?.content;
  return typeof t === "string" && t.trim() ? t : null;
}

/** Название от модели годится: не пусто, не длинное, по-русски. */
export function titleOk(title: unknown, original: string): title is string {
  if (typeof title !== "string") return false;
  const t = title.trim();
  if (t.length === 0 || t.length > 120 || /[\r\n`]|https?:/i.test(t)) return false;
  const cyr = (t.match(/[А-Яа-яЁёІіЇїЄєҐґ]/g) ?? []).length;
  const latinWords = t.match(/[A-Za-z]+/g) ?? [];
  if (cyr === 0 && latinWords.length === 0) return false;
  // название по-русски; латинские слова допустимы, только если они были в самой фразе (иначе модель «переводит» или выдумывает)
  const orig = original.toLowerCase();
  return latinWords.every((x) => orig.includes(x.toLowerCase()));
}

/** Достаёт первый JSON-объект из ответа (модель иногда оборачивает его в ```). */
export function extractJson(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/** Превращает ответ модели в готовый разбор или null (тогда бот работает как раньше). Чистая функция — тестируется без сети. */
export function interpretReply(text: string, original: string, o: { now: number; tz: string; defaultTime: number }): Parsed | null {
  const j = extractJson(text);
  if (!j || !titleOk(j.title, original)) return null;
  const title = (j.title as string).trim();
  const rep = typeof j.repeat === "string" && j.repeat.trim() && j.repeat.trim().toLowerCase() !== "null" ? j.repeat.trim() : null;
  if (rep) {
    // повтор разбирает наш обычный разбор: так рецепт повтора всегда «родной»; не поняли — молча как раньше
    const p = parseInput(`${rep} ${title}`, { now: o.now, tz: o.tz, defaultTime: o.defaultTime });
    if (!p.recipe || p.due === null || p.seriesEmpty || p.past || !p.title) return null;
    return { ...p, title };
  }
  const m = typeof j.when_iso === "string" ? ISO_RE.exec(j.when_iso.trim()) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const due = wallToUtc({ y, mo, d, h, mi }, o.tz);
  // назад во времени и «через три года» — явная ошибка модели
  if (!(due > o.now) || due > o.now + 3 * 365 * 24 * 3600_000) return null;
  const back = wallOf(due, o.tz);
  if (back.d !== d || back.mo !== mo) return null; // 31 ноября и подобное
  return { title, due, past: false, recipe: null, leadDays: [], critical: false, timer: false, seriesEmpty: false };
}

/**
 * Понять фразу моделью. Любой сбой (нет привязки, таймаут, ошибка, лимит, неверный ответ) — null.
 * Не бросает исключений: вызывающий просто продолжает по-старому.
 */
export async function understandPhrase(
  ai: AiBinding | undefined,
  text: string,
  o: { now: number; tz: string; defaultTime: number; timeoutMs?: number },
): Promise<Parsed | null> {
  if (!ai) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = ai.run(LLM_MODEL, {
      messages: [
        { role: "system", content: buildPrompt(o.now, o.tz) },
        { role: "user", content: text.slice(0, 500) },
      ],
      max_tokens: 200,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), o.timeoutMs ?? LLM_TIMEOUT_MS);
    });
    const out = await Promise.race([call, timeout]);
    call.catch(() => undefined); // поздний сбой после таймаута не должен ронять Worker
    const reply = out === null ? null : replyText(out);
    return reply ? interpretReply(reply, text, o) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
