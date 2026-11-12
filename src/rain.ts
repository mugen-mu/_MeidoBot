// «В Днепре начался дождь» (просьба владельца 2026-11-12): уведомление о начале и конце осадков, а не прогноз погоды.
// Источник — Open-Meteo (бесплатно, без ключа). Для Украины это интерполяция модели, а не радар, поэтому до минуты точность не ждём.
// Чистая логика без базы и Discord: время «сейчас» и ответ сайта приходят аргументами; в cron.ts — только проводка.
// Состояние (DRY / RAINING) лежит в таблице meta, ключ `rain_state`, JSON: у Worker нет файлов, а база переживает перезапуск и выкладку.
import { MINUTE, wallOf } from "./time/tz.ts";

// ---------- НАСТРОЙКИ (меняются здесь; включение/выключение и «заранее» — ещё и в /settings → «⋯ Ещё») ----------

export interface RainConfig {
  /** Широта и долгота: центр Днепра. */
  latitude: number;
  longitude: number;
  /** Пояс для ответа и для времени в журнале. Днепр живёт по киевскому. */
  timezone: string;
  /** Осадки за 15-минутный слот (мм), начиная с которых считаем «идёт дождь». 0.1 мм — первая заметная морось. */
  thresholdMm: number;
  /** Как часто спрашивать Open-Meteo, минут. Данные у них обновляются раз в 15 минут, чаще смысла почти нет. */
  checkEveryMinutes: number;
  /** Сколько проверок подряд без осадков нужно, чтобы считать, что дождь закончился (6 × 5 мин ≈ 30 мин). Защита от «то стихает, то снова идёт». */
  dryChecksToEnd: number;
  /** Предупреждение «скоро может пойти дождь» (EARLY_WARNING). Это значение по умолчанию; переключатель в /settings главнее. Выключено. */
  earlyWarning: boolean;
  /** Не чаще раза в N минут (предупреждение «скоро»). */
  earlyWarningEveryMinutes: number;
  /** Сколько 15-минутных слотов вперёд просить у Open-Meteo (4 = час). */
  forecastSlots: number;
  /** Таймаут одного запроса, мс. */
  requestTimeoutMs: number;
  /** Данные старше этого считаем негодными (сайт «завис» на старом срезе), минут. */
  staleDataMinutes: number;
  /** Если проверок не было дольше, минут, а бот считал, что идёт дождь, — состояние сбрасываем молча (конец дождя мы не видели). */
  maxGapMinutes: number;
  /** Сообщение не ушло (сбой Discord): повторять не дольше стольких минут, потом отбросить как устаревшее. */
  retryUnsentMinutes: number;
  /** Тексты сообщений: по виду осадков. */
  messages: Record<"start" | "end" | "early", Record<PrecipKind, string>>;
}

export const RAIN_CONFIG: RainConfig = {
  latitude: 48.4647,
  longitude: 35.0462,
  timezone: "Europe/Kyiv",
  thresholdMm: 0.1,
  checkEveryMinutes: 5,
  dryChecksToEnd: 6,
  earlyWarning: false,
  earlyWarningEveryMinutes: 120,
  forecastSlots: 4,
  requestTimeoutMs: 10_000,
  staleDataMinutes: 60,
  maxGapMinutes: 180,
  retryUnsentMinutes: 30,
  messages: {
    start: { rain: "🌧 В Днепре начался дождь", snow: "🌨 В Днепре пошёл снег", mixed: "🌨 В Днепре начались осадки: дождь со снегом" },
    end: { rain: "☀️ Дождь закончился", snow: "☀️ Снег закончился", mixed: "☀️ Осадки закончились" },
    early: { rain: "⚠️ Скоро может пойти дождь", snow: "⚠️ Скоро может пойти снег", mixed: "⚠️ Скоро могут начаться осадки" },
  },
};

export const RAIN_STATE_KEY = "rain_state";
export const RAIN_NEXT_KEY = "rain_next";
export const RAIN_OUTBOX_KEY = "rain_outbox";
/** Запас на дрожание cron (запуск «в начале минуты» бывает на секунды раньше/позже): иначе пятиминутный интервал вырастет до шести. */
export const RAIN_SLACK_MS = 30_000;

/** Выкл / вкл / вкл + «скоро» — одно значение настройки `rain`. */
export type RainMode = "off" | "on" | "early";
export const RAIN_MODES: RainMode[] = ["on", "early", "off"];
export const nextRainMode = (m: RainMode): RainMode => RAIN_MODES[(RAIN_MODES.indexOf(m) + 1) % RAIN_MODES.length];
export const rainModeWord = (m: RainMode): string => (m === "off" ? "выкл" : m === "early" ? "вкл + «скоро»" : "вкл");

// ---------- чтение ответа Open-Meteo ----------

export type PrecipKind = "rain" | "snow" | "mixed";

export interface RainSlot {
  /** метка слота, мс UTC */
  at: number;
  mm: number;
  kind: PrecipKind;
}

export interface RainReading {
  /** время среза модели (метка 15-минутного слота), мс UTC */
  at: number;
  /** осадки в срезе, мм */
  mm: number;
  kind: PrecipKind;
  /** слоты `minutely_15` (первый обычно — текущий срез) */
  slots: RainSlot[];
}

export type RainFetch = { ok: true; reading: RainReading } | { ok: false; why: string };

export function rainUrl(cfg: RainConfig = RAIN_CONFIG): string {
  const vars = "precipitation,rain,showers,snowfall";
  const q = [
    `latitude=${cfg.latitude}`,
    `longitude=${cfg.longitude}`,
    `current=${vars}`,
    `minutely_15=${vars}`,
    `forecast_minutely_15=${cfg.forecastSlots}`,
    `timezone=${encodeURIComponent(cfg.timezone)}`,
    "timeformat=unixtime",
  ];
  return `https://api.open-meteo.com/v1/forecast?${q.join("&")}`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Время из ответа: unixtime (секунды) — как просим мы; строка ISO «2026-11-12T14:30» (формат по умолчанию у Open-Meteo) — со сдвигом пояса. */
function timeMs(v: unknown, utcOffsetSec: number): number | null {
  const n = num(v);
  if (n !== null) return n * 1000;
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - utcOffsetSec * 1000;
  }
  return null;
}

/** Дождь, снег или «дождь со снегом» — по долям воды. `snowfall` в сантиметрах снега, вода — остаток от общей суммы. */
export function kindOf(mm: number, rain: number | null, showers: number | null, snowfall: number | null): PrecipKind {
  if (!(snowfall !== null && snowfall > 0) || rain === null) return "rain";
  const liquid = rain + (showers ?? 0);
  const snowWater = Math.max(0, mm - liquid);
  if (snowWater <= 0.001) return "rain";
  return snowWater >= liquid ? "snow" : "mixed";
}

/** Ответ Open-Meteo -> показание. Нужного нет или оно не число — «не разобралось». */
export function parseRain(json: unknown): RainFetch {
  if (!json || typeof json !== "object") return { ok: false, why: "ответ не JSON-объект" };
  const j = json as Record<string, unknown>;
  if (j.error === true) return { ok: false, why: `Open-Meteo: ${String(j.reason ?? "ошибка")}`.slice(0, 160) };
  const cur = j.current as Record<string, unknown> | undefined;
  if (!cur || typeof cur !== "object") return { ok: false, why: "в ответе нет блока current" };
  const offset = num(j.utc_offset_seconds) ?? 0;
  const mm = num(cur.precipitation);
  const at = timeMs(cur.time, offset);
  if (mm === null || mm < 0) return { ok: false, why: "в current нет осадков (precipitation)" };
  if (at === null) return { ok: false, why: "в current нет времени" };
  const kind = kindOf(mm, num(cur.rain), num(cur.showers), num(cur.snowfall));
  const slots: RainSlot[] = [];
  const m15 = j.minutely_15 as Record<string, unknown> | undefined;
  if (m15 && Array.isArray(m15.time) && Array.isArray(m15.precipitation)) {
    const arr = (k: string): unknown[] => (Array.isArray(m15[k]) ? (m15[k] as unknown[]) : []);
    const rain = arr("rain"), showers = arr("showers"), snow = arr("snowfall");
    for (let i = 0; i < m15.time.length; i++) {
      const t = timeMs(m15.time[i], offset);
      const p = num(m15.precipitation[i]);
      if (t === null || p === null) continue;
      slots.push({ at: t, mm: p, kind: kindOf(p, num(rain[i]), num(showers[i]), num(snow[i])) });
    }
  }
  return { ok: true, reading: { at, mm, kind, slots } };
}

/** Запрос к Open-Meteo с таймаутом. Никогда не бросает: любой сбой — `{ ok: false, why }` (в чат об этом не пишем). */
export async function fetchRain(fetchFn: typeof fetch, now: number, cfg: RainConfig = RAIN_CONFIG): Promise<RainFetch> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.requestTimeoutMs);
  try {
    const res = await fetchFn(rainUrl(cfg), { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, why: `Open-Meteo ответил HTTP ${res.status}` };
    const got = parseRain(await res.json());
    if (got.ok && now - got.reading.at > cfg.staleDataMinutes * MINUTE) {
      return { ok: false, why: `данные устарели: срез от ${Math.round((now - got.reading.at) / MINUTE)} мин назад` };
    }
    return got;
  } catch (e) {
    const name = (e as Error)?.name;
    return { ok: false, why: name === "AbortError" ? `нет ответа за ${cfg.requestTimeoutMs / 1000} с` : `сбой запроса: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- состояние и переходы ----------

export interface RainState {
  mode: "dry" | "raining";
  /** сколько проверок подряд без осадков (считаем только пока идёт дождь) */
  dryStreak: number;
  /** вид идущих осадков: от него слова в сообщении «закончился» */
  kind: PrecipKind;
  /** когда началось текущее состояние (мс UTC) */
  since: number;
  /** последняя удачная проверка (мс UTC) */
  lastOk: number;
  /** когда в последний раз слали «скоро может пойти» (мс UTC), 0 — не слали */
  lastEarly: number;
}

export function parseRainState(raw: string | undefined): RainState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RainState>;
    if ((v.mode !== "dry" && v.mode !== "raining") || !Number.isFinite(v.lastOk)) return null;
    const kind: PrecipKind = v.kind === "snow" || v.kind === "mixed" ? v.kind : "rain";
    return {
      mode: v.mode,
      dryStreak: Math.max(0, Math.floor(num(v.dryStreak) ?? 0)),
      kind,
      since: num(v.since) ?? (v.lastOk as number),
      lastOk: v.lastOk as number,
      lastEarly: num(v.lastEarly) ?? 0,
    };
  } catch {
    return null;
  }
}

export const serializeRainState = (s: RainState): string =>
  JSON.stringify({ mode: s.mode, dryStreak: s.dryStreak, kind: s.kind, since: s.since, lastOk: s.lastOk, lastEarly: s.lastEarly });

export type RainNoticeKind = "start" | "end" | "early";

export interface RainNotice {
  kind: RainNoticeKind;
  text: string;
  /** упомянуть хозяина (звук): начало и «скоро» — да, конец — нет */
  loud: boolean;
}

export interface RainPlan {
  state: RainState;
  notices: RainNotice[];
  /** строки для журнала: что решено и почему (время — в cron) */
  log: string[];
}

/** Осадки в ближайшем будущем слоте (метка строго позже «сейчас»), если слот есть. */
export function nextSlot(reading: RainReading, now: number): RainSlot | null {
  return reading.slots.filter((s) => s.at > now).sort((a, b) => a.at - b.at)[0] ?? null;
}

/**
 * Один шаг автомата DRY ⇄ RAINING по свежему показанию.
 * Первый запуск (состояния нет) и «потерянный» дождь после долгой паузы принимаются молча: ложного «начался» после перезапуска не бывает.
 */
export function planRain(prev: RainState | null, reading: RainReading, now: number, earlyOn: boolean, cfg: RainConfig = RAIN_CONFIG): RainPlan {
  const wet = reading.mm >= cfg.thresholdMm;
  const log: string[] = [];
  const base = (mode: RainState["mode"], over: Partial<RainState> = {}): RainState => ({
    mode, dryStreak: 0, kind: wet ? reading.kind : "rain", since: now, lastOk: now, lastEarly: prev?.lastEarly ?? 0, ...over,
  });
  if (!prev) {
    log.push(`первое чтение, состояние принято молча: ${wet ? "RAINING" : "DRY"} (${reading.mm} мм)`);
    return { state: base(wet ? "raining" : "dry"), notices: [], log };
  }
  const gap = now - prev.lastOk;
  if (prev.mode === "raining" && gap > cfg.maxGapMinutes * MINUTE) {
    log.push(`проверок не было ${Math.round(gap / MINUTE)} мин: состояние принято молча как ${wet ? "RAINING" : "DRY"}`);
    return { state: base(wet ? "raining" : "dry"), notices: [], log };
  }
  const notices: RainNotice[] = [];
  const state: RainState = { ...prev, lastOk: now };
  if (prev.mode === "dry") {
    if (wet) {
      state.mode = "raining";
      state.dryStreak = 0;
      state.kind = reading.kind;
      state.since = now;
      notices.push({ kind: "start", text: cfg.messages.start[reading.kind], loud: true });
      log.push(`DRY -> RAINING (${reading.mm} мм, ${reading.kind})`);
    } else if (earlyOn) {
      const slot = nextSlot(reading, now);
      if (slot && slot.mm >= cfg.thresholdMm && now - prev.lastEarly >= cfg.earlyWarningEveryMinutes * MINUTE) {
        state.lastEarly = now;
        notices.push({ kind: "early", text: cfg.messages.early[slot.kind], loud: true });
        log.push(`DRY: в ближайшем слоте ${slot.mm} мм — предупреждение «скоро»`);
      }
    }
    return { state, notices, log };
  }
  // RAINING
  if (wet) {
    state.dryStreak = 0;
    state.kind = reading.kind;
  } else {
    state.dryStreak = prev.dryStreak + 1;
    log.push(`сухая проверка ${state.dryStreak} из ${cfg.dryChecksToEnd}`);
    if (state.dryStreak >= cfg.dryChecksToEnd) {
      state.mode = "dry";
      state.dryStreak = 0;
      state.since = now;
      notices.push({ kind: "end", text: cfg.messages.end[prev.kind], loud: false });
      log.push("RAINING -> DRY");
    }
  }
  return { state, notices, log };
}

// ---------- очередь неотправленного ----------

export interface RainOutboxItem {
  text: string;
  mention: boolean;
  /** когда сообщение появилось (мс UTC): старше `retryUnsentMinutes` не отправляем — «начался» про дождь получасовой давности вводит в заблуждение */
  at: number;
}

export function parseRainOutbox(raw: string | undefined, now: number, cfg: RainConfig = RAIN_CONFIG): RainOutboxItem[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (m): m is RainOutboxItem => !!m && typeof m.text === "string" && typeof m.mention === "boolean" && Number.isFinite(m.at) && now - m.at <= cfg.retryUnsentMinutes * MINUTE,
    ).slice(-3);
  } catch {
    return [];
  }
}

/** Время для журнала по Киеву: «2026-11-12 14:35». */
export function logStamp(now: number, tz: string = RAIN_CONFIG.timezone): string {
  const w = wallOf(now, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.mo)}-${p(w.d)} ${p(w.h)}:${p(w.mi)}`;
}
