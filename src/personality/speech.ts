// Выбор фразы: случайная из пула настроения и ситуации, без повторов последних N (ТЗ, раздел 8, режим A).
// Чистая логика: случайность приходит аргументом, чтобы тесты были предсказуемыми.
import { MOOD_CONFIG, type MoodConfig } from "./config.ts";
import type { Voice } from "./persona.ts";
import { RECENT_DAYS } from "./day.ts";
import { FALLBACK_SITUATION, PHRASES, type Phrases, type Situation } from "./phrases.ts";

export interface PhraseVars {
  user?: string;
  task?: string;
  miss_count?: number;
  done_streak?: number;
  name?: string;
  /** обращение для «зова» (запятая рядом, начало предложения); иначе user — аниме-слой ставит сюда «госюдзин-сама» */
  userVoc?: string;
  /** номер дела: от него и от даты считается «щепотка случайности» (этап 2); в текст фразы не подставляется */
  itemId?: number;
}

/** Короткий отпечаток текста фразы: по нему помним «последние 5», и он не ломается, когда пул пополняют. */
export function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function fill(text: string, vars: PhraseVars, cfg: MoodConfig = MOOD_CONFIG): string {
  const map: Record<string, string> = {
    user: vars.user ?? cfg.address,
    task: vars.task ?? "дело",
    miss_count: String(vars.miss_count ?? 0),
    done_streak: String(vars.done_streak ?? 0),
    name: vars.name ?? cfg.name,
  };
  // «{user}, …» в начале предложения подставляется с большой буквы: «Хозяин, …» (название дела {task} не трогаем)
  return text.replace(/\{(user|task|miss_count|done_streak|name)\}/gu, (_m, k: string, offset: number) => {
    let v = map[k];
    if (k === "user" && vars.userVoc !== undefined) {
      const before = text.slice(0, offset);
      const after = text.slice(offset + _m.length);
      const sentenceStart = offset === 0 || /(?:[.!?…]|\*)\s+$/u.test(before);
      if (/,\s*$/u.test(before) || (sentenceStart && /^(?:\s*$|\s*[,.!?…~])/u.test(after))) v = vars.userVoc;
    }
    const atStart = k !== "task" && (offset === 0 || /(?:[.!?…]|\*)\s+$/u.test(text.slice(0, offset)));
    return atStart ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  });
}

/** Список фраз для пары «настроение — ситуация» с учётом запасной ситуации; пусто — фраз нет. */
export function poolFor(mood: Voice, situation: Situation, bank: Phrases = PHRASES): string[] {
  const moodBank = bank[mood];
  if (!moodBank) return [];
  const direct = moodBank[situation];
  if (direct && direct.length) return direct;
  const fb = FALLBACK_SITUATION[situation];
  const alt = fb ? moodBank[fb] : undefined;
  return alt ?? [];
}

export interface Pick {
  text: string;
  /** фраза из пула до подстановок: из неё аниме-слой собирает итоговый текст */
  raw: string;
  /** отпечаток выбранной фразы (до подстановок) для списка последних */
  key: string;
}

/**
 * Выбрать фразу. recent — отпечатки последних использованных (самые свежие в конце).
 * Если все фразы пула недавно были, берём самую давнюю из использованных (без повтора подряд).
 */
export function pickPhrase(a: {
  mood: Voice;
  situation: Situation;
  vars?: PhraseVars;
  recent: string[];
  rand: () => number;
  bank?: Phrases;
  cfg?: MoodConfig;
  /** отпечаток → номер суток последнего использования; с `today` включает правило «не повторять 14 дней» (этап 2, D6) */
  used?: Record<string, number>;
  today?: number;
}): Pick | null {
  const cfg = a.cfg ?? MOOD_CONFIG;
  const pool = poolFor(a.mood, a.situation, a.bank);
  if (pool.length === 0) return null;
  const banned = new Set(a.recent.slice(-cfg.noRepeat));
  const fresh = (t: string): boolean => {
    const d = a.used?.[fingerprint(t)];
    return a.today === undefined || d === undefined || a.today - d >= RECENT_DAYS;
  };
  let candidates = pool.filter((t) => !banned.has(fingerprint(t)) && fresh(t));
  if (candidates.length === 0 && a.used && a.today !== undefined) {
    // весь пул звучал недавно: берём самую давнюю (не ту, что только что была)
    const last = a.recent[a.recent.length - 1];
    const ordered = pool.filter((t) => pool.length === 1 || fingerprint(t) !== last);
    const oldest = Math.min(...ordered.map((t) => a.used?.[fingerprint(t)] ?? -Infinity));
    candidates = ordered.filter((t) => (a.used?.[fingerprint(t)] ?? -Infinity) === oldest);
  }
  if (candidates.length === 0) {
    const last = a.recent[a.recent.length - 1];
    candidates = pool.length > 1 ? pool.filter((t) => fingerprint(t) !== last) : pool;
  }
  const text = candidates[Math.min(candidates.length - 1, Math.floor(a.rand() * candidates.length))];
  return { text: fill(text, a.vars ?? {}, cfg), raw: text, key: fingerprint(text) };
}

/** Добавить отпечаток к списку последних и оставить только N последних. */
export function remember(recent: string[], key: string, cfg: MoodConfig = MOOD_CONFIG): string[] {
  return [...recent.filter((k) => k !== key), key].slice(-Math.max(cfg.noRepeat, 1));
}
