// Фактическое пропадание и возвращение света: телефон в обычной розетке шлёт запросы на адрес бота
// (приложение-автоматизация, например MacroDroid), бот пишет в канал «напоминания» с упоминанием.
// Состояние — в таблице meta (ключи power_*). Ключ доступа случайный, показывается только хозяину командой /power.
import { type Repo, event, setMeta } from "./db/repo.ts";
import type { Op } from "./db/types.ts";
import type { DiscordApi } from "./discord/types.ts";
import { type LightData, YASNO_ATTEMPTS, checkSchedule, fetchYasno } from "./light.ts";
import type { AppSettings } from "./settings.ts";
import { voiceText } from "./discord/ui.ts";
import { QUIET_META_KEY, isQuietNow } from "./personality/day.ts";
import { MoodSession, makeCtx } from "./personality/director.ts";
import type { Situation } from "./personality/phrases.ts";
import { MINUTE, fmtHHMM, wallOf } from "./time/tz.ts";
import { AVARIA_LAST_KEY, avariaAnnounceLine } from "./avaria.ts";

/** Моргание короче этого времени в канал не пишется: сообщение «пропал» уходит, только если света нет дольше. */
export const BLINK_MS = 60_000;

export type PowerSignal = "on" | "off";

export interface PowerState {
  state: "on" | "off" | null;
  /** когда состояние началось (мс) */
  since: number;
  /** сообщение «света нет» уже отправлено */
  announced: boolean;
}

export function readPower(meta: Map<string, string>): PowerState {
  const st = meta.get("power_state");
  return {
    state: st === "on" || st === "off" ? st : null,
    since: Number(meta.get("power_since") ?? 0) || 0,
    announced: meta.get("power_announced") === "1",
  };
}

/** Сравнение строк за одинаковое время (ключ не должен угадываться по скорости ответа). */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function newPowerKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Сколько не было света: «23 мин», «1 ч 35 мин», «2 дн. 3 ч». */
export function fmtOffTime(ms: number): string {
  const min = Math.max(1, Math.round(ms / MINUTE));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} ч ${m} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} дн. ${h % 24} ч` : `${d} дн.`;
}

const hhmm = (ms: number, tz: string) => {
  const w = wallOf(ms, tz);
  return fmtHHMM(w.h * 60 + w.mi);
};

export type PowerAction = "ignored" | "started" | "blink" | "restored";

/**
 * Что делать с сигналом. Повторный «пропал» подряд и «появился» без «пропал» игнорируются.
 * «Появился» после моргания (сообщение «нет света» ещё не уходило) молча сбрасывает состояние.
 */
export function applySignal(p: PowerState, signal: PowerSignal, now: number): { action: PowerAction; ops: Op[]; offMs?: number; offAt?: number } {
  if (signal === "off") {
    if (p.state === "off") return { action: "ignored", ops: [] };
    return {
      action: "started",
      ops: [setMeta("power_state", "off"), setMeta("power_since", String(now)), setMeta("power_announced", "0"), event(now, "power_off")],
    };
  }
  if (p.state !== "off") {
    // «появился» без «пропал» (например, телефон уже стоял на зарядке): только запоминаем
    return { action: "ignored", ops: p.state === null ? [setMeta("power_state", "on"), setMeta("power_since", String(now))] : [] };
  }
  const ops = [setMeta("power_state", "on"), setMeta("power_since", String(now)), setMeta("power_announced", "0"), event(now, "power_on", null, `ms=${now - p.since}`)];
  // cron объявляет «света нет» раз в минуту, поэтому при отключении дольше минуты, но раньше следующего запуска,
  // «появился» тоже считается возвращением (иначе настоящее отключение прошло бы молча)
  return p.announced || p.state === "off" && now - p.since >= BLINK_MS
    ? { action: "restored", ops, offMs: now - p.since, offAt: p.since }
    : { action: "blink", ops, offMs: now - p.since, offAt: p.since };
}

/** Текст «Света нет с 17:42 (по графику: да, 17:30–20:30)». */
export function offMessage(a: { ownerId: string; since: number; tz: string; schedule: string | null }): string {
  const tail = a.schedule ? ` (${a.schedule})` : "";
  return `<@${a.ownerId}> Света нет с ${hhmm(a.since, a.tz)}${tail}`;
}

export function onMessage(a: { ownerId: string; now: number; offMs: number; tz: string }): string {
  return `<@${a.ownerId}> Свет вернулся в ${hhmm(a.now, a.tz)}, не было ${fmtOffTime(a.offMs)}`;
}

/**
 * Фраза Хару к объявлению про свет (просьба Ihor 2026-11-10): готовая из пула, без модели (объявление идёт и из запроса телефона, и из cron, ждать модель нельзя).
 * Нет характера (выключен в /settings), «тихий день» или пула нет — null: остаются одни факты. Состояние (память «не повторять») сохраняется здесь же.
 */
export async function powerLine(d: { repo: Repo; now: number; ownerId: string | null; s: AppSettings; meta: Map<string, string> }, situation: Situation): Promise<string | null> {
  if (!d.s.moodOn || !d.ownerId) return null;
  const m = new MoodSession({ repo: d.repo, userId: d.ownerId, ctx: makeCtx(d.now, d.s), rand: Math.random, style: d.s.style, live: null });
  if (isQuietNow(d.meta.get(QUIET_META_KEY), d.now)) m.silent = true;
  await m.load();
  const line = m.say(situation);
  const ops = m.ops();
  if (ops.length) await d.repo.exec(ops);
  return line;
}

/** Фраза Хару первой после упоминания, дальше факты: «@вы Фраза. Свет вернулся …». */
const withPhrase = (text: string, ownerId: string, line: string | null): string => (line ? text.replace(`<@${ownerId}> `, () => `<@${ownerId}> ${voiceText(line)} `) : text);

/**
 * Сверка с графиком: подпись для сообщения и метка для журнала отключений (`sched=` в событии power_announced).
 * Метка: none — группа не задана; unavailable — Yasno не ответил; иначе вердикт checkSchedule (yes / no / mixed / unknown / emergency).
 * Подпись null — группа в настройках не задана, ничего не пишем.
 */
export function scheduleInfo(at: number, s: AppSettings, data: LightData | null): { note: string | null; tag: string } {
  if (!s.lightGroup) return { note: null, tag: "none" };
  if (!data) return { note: "график недоступен", tag: "unavailable" };
  const r = checkSchedule(at, s.lightGroup, data, s.tz);
  switch (r.verdict) {
    case "yes":
      return { note: `по графику: да, ${r.range}`, tag: "yes" };
    case "no":
      // света нет, а график в это время отключений не обещал (или Yasno пишет «отключений нет»): это уже не по плану
      return { note: "вне графика, похоже на аварийное отключение", tag: "no" };
    case "emergency":
      return { note: "Yasno: аварийные отключения, графики не действуют", tag: "emergency" };
    case "mixed":
      return { note: "по графику: зависит от подгруппы", tag: "mixed" };
    default:
      return { note: "график на это время неизвестен", tag: "unknown" };
  }
}

export const scheduleNote = (at: number, s: AppSettings, data: LightData | null): string | null => scheduleInfo(at, s, data).note;

export interface PowerDeps {
  repo: Repo;
  api: DiscordApi;
  now: number;
  ownerId: string | null;
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * Запрос от телефона: /power/<ключ>/off или /power/<ключ>/on (GET или POST).
 * Неверный или ненастроенный ключ — 401, чужой путь — 404; ключ нигде не пишется в журнал.
 */
export async function handlePower(request: Request, d: PowerDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return text(405, "method not allowed");
  // Предпросмотр ссылок (Discord, мессенджеры) не должен менять состояние света.
  if (/discordbot|slackbot|telegrambot|facebookexternalhit|whatsapp|twitterbot|linkedinbot|skypeuripreview/i.test(request.headers.get("user-agent") ?? "")) return text(403, "forbidden");
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "power" || (parts[2] !== "on" && parts[2] !== "off")) return text(404, "not found");
  const { settings: s, meta } = await d.repo.loadConfig();
  const key = meta.get("power_key");
  if (!key || !safeEqual(parts[1], key)) return text(401, "unauthorized");
  const owner = meta.get("owner_id") ?? d.ownerId;
  const r = applySignal(readPower(meta), parts[2], d.now);
  if (r.ops.length) await d.repo.exec(r.ops);
  if (r.action === "restored" && owner && s.chRemind) {
    try {
      const line = await powerLine({ repo: d.repo, now: d.now, ownerId: owner, s, meta }, "power_on");
      await d.api.postMessage(s.chRemind, {
        content: withPhrase(onMessage({ ownerId: owner, now: d.now, offMs: r.offMs as number, tz: s.tz }), owner, line),
        allowed_mentions: { users: [owner] },
      });
    } catch {
      return text(502, "recorded, message failed");
    }
  }
  return text(200, r.action);
}

/**
 * Для cron: свет пропал и пора сообщить (прошло больше BLINK_MS, сообщение ещё не уходило).
 * Возвращает операции для записи; null — сообщать нечего. Сообщение отправляется здесь же.
 */
export async function announceOutage(d: PowerDeps & { meta: Map<string, string>; s: AppSettings; fetchFn?: typeof fetch; spend: () => void }): Promise<Op[] | null> {
  const p = readPower(d.meta);
  if (p.state !== "off" || p.announced || d.now - p.since < BLINK_MS) return null;
  if (!d.ownerId || !d.s.chRemind) return null;
  let data: LightData | null = null;
  if (d.s.lightGroup) {
    for (let i = 0; i < YASNO_ATTEMPTS; i++) d.spend();
    data = await fetchYasno(d.fetchFn ?? fetch);
  }
  const line = await powerLine({ repo: d.repo, now: d.now, ownerId: d.ownerId, s: d.s, meta: d.meta }, "power_off");
  const sched = scheduleInfo(p.since, d.s, data);
  // свежий пост канала аварийной службы про свет (до 6 часов): причина и масштаб, которых нет ни у Yasno, ни у датчика
  const avaria = avariaAnnounceLine(d.meta.get(AVARIA_LAST_KEY), d.now, d.s.tz);
  await d.api.postMessage(d.s.chRemind, {
    content: withPhrase(offMessage({ ownerId: d.ownerId, since: p.since, tz: d.s.tz, schedule: sched.note }), d.ownerId, line) + (avaria ? `\n${avaria}` : ""),
    allowed_mentions: { users: [d.ownerId] },
  });
  // отметка «сообщили» ставится, только пока свет всё ещё считается пропавшим (гонка с запросом «появился»)
  return [
    {
      sql: "UPDATE meta SET value = '1' WHERE key = 'power_announced' AND EXISTS (SELECT 1 FROM meta WHERE key = 'power_state' AND value = 'off')",
      params: [],
    },
    // метка сверки с графиком нужна журналу отключений (сводка «за сутки … из них вне графика», src/outages.ts)
    event(d.now, "power_announced", null, `sched=${sched.tag}`),
  ];
}
