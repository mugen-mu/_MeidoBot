// «Режиссёр»: связывает движок настроения, подбор фраз и базу D1. Здесь нет Discord.
// Одна сессия на запрос (cron или нажатие кнопки): загрузили состояние один раз (один подзапрос),
// применили события, сказали фразы, записали всё одной пачкой вместе с остальными операциями.
import { type Repo, event, op } from "../db/repo.ts";
import type { AiBinding } from "../llm.ts";
import { detectSecret } from "../secrets.ts";
import type { OccView, Op } from "../db/types.ts";
import { type AppSettings, inQuietHours } from "../settings.ts";
import { wallOf } from "../time/tz.ts";
import {
  STYLE_DEFAULT,
  type StyleConfig,
  type StyleState,
  emptyStyleState,
  parseStyleState,
  renderStyled,
} from "./animeStyle.ts";
import { cinemaMoment } from "./cinema.ts";
import { MOOD_CONFIG, type MoodConfig } from "./config.ts";
import {
  type Mood,
  type MoodCtx,
  type MoodEvent,
  type MoodState,
  type StepResult,
  forceMood,
  initialState,
  isMood,
  isSeriousTopic,
  step,
} from "./moodEngine.ts";
import { LIVE_DAILY_CAP, type LineRequest, liveLine, pickAngle, pickLength } from "./liveLines.ts";
import { INTERESTS, INTEREST_CHANCE, type MonthDay, occasionFor } from "./occasions.ts";
import type { Situation } from "./phrases.ts";
import { type PhraseVars, fill, pickPhrase, remember } from "./speech.ts";
import { type UserWordId, wordReply } from "./userWords.ts";

const MINUTE = 60_000;

/** Настройки живых реплик через модель: без них (или при выключенной настройке) сессия говорит только готовыми фразами. */
export interface LiveCfg {
  ai: AiBinding;
  tz: string;
  /** сколько ждать модель: короче для кнопок (Discord ждёт ~3 с), длиннее для cron */
  timeoutMs: number;
  /** потолок вызовов в сутки; по умолчанию LIVE_DAILY_CAP */
  cap?: number;
  /** есть ли запас подзапросов Worker на вызов модели (в cron — счётчик подзапросов); нет — готовая фраза */
  gate?: () => boolean;
  /** вызов модели совершается: учесть его в счётчике подзапросов */
  spend?: () => void;
}

/** Обращение Хару к хозяину в этот раз: по настроению и уровню аниме-слоя; null — «в пустоту». */
export function pickAddress(mood: Mood, style: StyleConfig, base: string, rand: () => number): string | null {
  const rich = style.level >= 2 && style.honorifics;
  const from = <T>(xs: T[]): T => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];
  if (mood === "sulking") return rand() < 0.7 ? null : base;
  if (!rich) return base;
  switch (mood) {
    case "tsundere": return from(["х-хозяин", base]);
    case "yandere": return from(["госюдзин-сама~", "аната", base]);
    case "proud": return "госюдзин-сама";
    case "sleepy": return from([base, "госюдзин-сама"]);
    default: return from([base, "госюдзин-сама"]);
  }
}

/** Время, «ночь ли в этот миг» и пояс пользователя: ночью — по тихим часам из /settings, если они включены, иначе по config. */
export function makeCtx(now: number, s: Pick<AppSettings, "tz" | "quietEnabled" | "quietFrom" | "quietTo">, cfg: MoodConfig = MOOD_CONFIG): MoodCtx {
  const isNight = (ms: number): boolean => {
    const w = wallOf(ms, s.tz);
    const m = w.h * 60 + w.mi;
    if (s.quietEnabled) return inQuietHours(s as AppSettings, m);
    const { from, to } = cfg.night;
    return from < to ? m >= from && m < to : m >= from || m < to;
  };
  return { now, isNight };
}

/** Стиль выключается на критичных делах и серьёзных темах (здоровье, врачи, горе): остаётся обычный нейтральный текст. */
export const canStyle = (title: string, critical: boolean | number, plain: boolean | number = false): boolean => !critical && !plain && !isSeriousTopic(title);

interface Row {
  user_id: string;
  affection: number;
  irritation: number;
  miss_streak: number;
  done_streak: number;
  last_activity: number | null;
  current_mood: string;
  mood_since: number;
  updated_at: number;
  idle_penalty: number;
  recent: string;
  last_drama_at: number | null;
  yandere_cleared: number;
  style_data: string;
}

export function fromRow(r: Row, now: number): MoodState {
  let recent: string[] = [];
  try {
    const v = JSON.parse(r.recent);
    if (Array.isArray(v)) recent = v.map(String);
  } catch {
    /* повреждено: пусто */
  }
  return {
    affection: r.affection,
    irritation: r.irritation,
    missStreak: r.miss_streak,
    doneStreak: r.done_streak,
    lastActivity: r.last_activity ?? now,
    mood: isMood(r.current_mood) ? r.current_mood : "tired",
    moodSince: r.mood_since,
    updatedAt: r.updated_at,
    idlePenalty: r.idle_penalty,
    recent,
    lastDramaAt: r.last_drama_at,
    yandereCleared: r.yandere_cleared === 1,
  };
}

export function saveOp(userId: string, s: MoodState, style: StyleState = emptyStyleState()): Op {
  return op(
    `INSERT INTO mood_state (user_id, affection, irritation, miss_streak, done_streak, last_activity, current_mood, mood_since,
                             updated_at, idle_penalty, recent, last_drama_at, yandere_cleared, style_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       affection = excluded.affection, irritation = excluded.irritation, miss_streak = excluded.miss_streak,
       done_streak = excluded.done_streak, last_activity = excluded.last_activity, current_mood = excluded.current_mood,
       mood_since = excluded.mood_since, updated_at = excluded.updated_at, idle_penalty = excluded.idle_penalty,
       recent = excluded.recent, last_drama_at = excluded.last_drama_at, yandere_cleared = excluded.yandere_cleared,
       style_data = excluded.style_data`,
    userId, s.affection, s.irritation, s.missStreak, s.doneStreak, s.lastActivity, s.mood, s.moodSince,
    s.updatedAt, s.idlePenalty, JSON.stringify(s.recent), s.lastDramaAt, s.yandereCleared ? 1 : 0, JSON.stringify(style),
  );
}

/** /reset_mood: всё к значениям по умолчанию (строка удаляется, при следующем событии заводится заново). */
export const resetOps = (userId: string): Op[] => [op("DELETE FROM mood_state WHERE user_id = ?", userId)];

export class MoodSession {
  readonly repo: Repo;
  readonly userId: string;
  readonly ctx: MoodCtx;
  readonly cfg: MoodConfig;
  readonly rand: () => number;
  /** настройки аниме-слоя; без них — уровень 0 (обычный русский) */
  readonly style: StyleConfig;
  /** живые реплики через модель (необязательно) */
  readonly live: LiveCfg | null;
  /** до load() — null */
  state: MoodState | null = null;
  /** какие слова словаря использованы (подсказки перевода, паузы, /glossary); живёт в строке настроения */
  styleState: StyleState = emptyStyleState();
  /** последняя реплика say() оказалась «кино-моментом» (тогда показываем спрайт) */
  cinema = false;
  private pending: Op[] = [];
  private dirty = false;

  constructor(a: { repo: Repo; userId: string; ctx: MoodCtx; cfg?: MoodConfig; rand?: () => number; style?: StyleConfig; live?: LiveCfg | null }) {
    this.repo = a.repo;
    this.userId = a.userId;
    this.ctx = a.ctx;
    this.cfg = a.cfg ?? MOOD_CONFIG;
    this.rand = a.rand ?? Math.random;
    this.style = a.style ?? { ...STYLE_DEFAULT, level: 0 };
    this.live = a.live ?? null;
  }

  get loaded(): boolean {
    return this.state !== null;
  }

  /** Загрузить состояние (один подзапрос) и сразу пересчитать спад и настроение к текущему моменту. */
  async load(): Promise<MoodState> {
    if (this.state) return this.state;
    const row = await this.repo.first<Row>("SELECT * FROM mood_state WHERE user_id = ?", this.userId);
    this.state = row ? fromRow(row, this.ctx.now) : initialState(this.ctx.now, this.cfg);
    this.styleState = row ? parseStyleState(row.style_data) : emptyStyleState();
    this.dirty = !row;
    this.apply({ type: "tick" });
    return this.state;
  }

  /** Применить событие к загруженному состоянию. Переход настроения пишется в журнал событий. */
  apply(ev: MoodEvent): StepResult {
    if (!this.state) throw new Error("MoodSession: сначала load()");
    const r = step(this.state, ev, this.ctx, this.cfg);
    this.state = r.state;
    this.dirty = true;
    if (r.change) {
      // журнал перехода: старое → новое и причина (чисел и текстов дел тут нет)
      this.pending.push(event(this.ctx.now, "mood", null, `${r.change.from}>${r.change.to}: ${r.change.reason}`.slice(0, 200)));
    }
    return r;
  }

  /** Принудительное настроение (/mood set). */
  force(mood: Mood): void {
    if (!this.state) throw new Error("MoodSession: сначала load()");
    const from = this.state.mood;
    this.state = forceMood(this.state, mood, this.ctx.now, this.cfg);
    this.dirty = true;
    this.pending.push(event(this.ctx.now, "mood", null, `${from}>${mood}: вручную`));
  }

  /** Фраза для ситуации в текущем настроении или null (пула нет, или пауза «драмы»). Запоминает её, чтобы не повторять. */
  say(situation: Situation, vars: PhraseVars = {}, mood?: Mood): string | null {
    if (!this.state) throw new Error("MoodSession: сначала load()");
    this.cinema = false;
    const st = this.state;
    const dramatic = situation === "missed" && st.missStreak >= this.cfg.thresholds.yandereMiss + 1;
    if (dramatic && st.lastDramaAt !== null && this.ctx.now - st.lastDramaAt < this.cfg.dramaCooldownMinutes * MINUTE) return null;
    const p = pickPhrase({
      mood: mood ?? st.mood,
      situation,
      vars: { miss_count: st.missStreak, done_streak: st.doneStreak, ...vars },
      recent: st.recent,
      rand: this.rand,
      cfg: this.cfg,
    });
    if (!p) return null;
    this.state = { ...st, recent: remember(st.recent, p.key, this.cfg), lastDramaAt: dramatic ? this.ctx.now : st.lastDramaAt };
    this.dirty = true;
    // «кино-момент» (Х3): редкий длинный монолог вместо обычной фразы, только на уровне 3 и с паузой
    const cin = cinemaMoment({ mood: mood ?? st.mood, situation, style: this.style, state: this.styleState, now: this.ctx.now, rand: this.rand, vars, cfg: this.cfg });
    if (cin) {
      this.styleState = cin.state;
      this.cinema = true;
      return cin.text;
    }
    // аниме-слой (Х2): поверх выбранной фразы; на уровне 0 это обычная подстановка без вставок
    const r = renderStyled({
      template: p.raw,
      mood: mood ?? st.mood,
      situation,
      style: this.style,
      state: this.styleState,
      vars: { miss_count: st.missStreak, done_streak: st.doneStreak, ...vars },
      rand: this.rand,
      cfg: this.cfg,
    });
    this.styleState = r.state;
    return r.text;
  }

  /**
   * Реплика с попыткой «живой» версии от модели; без модели, при сбое, таймауте или исчерпанном дневном лимите — готовая фраза из пула
   * (say). Модель получает настроение, ситуацию, время суток, интересы хозяина и (если нет секрета) название дела.
   * Дневной потолок вызовов хранится в состоянии стиля (сутки UTC, как у лимита Workers AI); вызов считается и при неудаче.
   */
  async sayLive(situation: Situation, vars: PhraseVars & { facts?: string; occasion?: string; task?: string } = {}, mood?: Mood): Promise<string | null> {
    if (!this.state) throw new Error("MoodSession: сначала load()");
    const lc = this.live;
    if (!lc) return this.say(situation, vars, mood);
    const st = this.state;
    const dramatic = situation === "missed" && st.missStreak >= this.cfg.thresholds.yandereMiss + 1;
    if (dramatic && st.lastDramaAt !== null && this.ctx.now - st.lastDramaAt < this.cfg.dramaCooldownMinutes * MINUTE) return null;
    const day = Math.floor(this.ctx.now / 86_400_000);
    const used = this.styleState.lv?.d === day ? this.styleState.lv.n : 0;
    if (used >= (lc.cap ?? LIVE_DAILY_CAP) || (lc.gate && !lc.gate())) return this.say(situation, vars, mood);
    // повторные напоминания частые: половину из них озвучиваем готовой фразой, чтобы беречь лимит модели
    if (situation === "reminder_repeat" && this.rand() < 0.5) return this.say(situation, vars, mood);
    lc.spend?.();
    this.styleState = { ...this.styleState, lv: { d: day, n: used + 1 } };
    this.dirty = true;
    const m = mood ?? st.mood;
    const w = wallOf(this.ctx.now, lc.tz);
    const req: LineRequest = {
      mood: m,
      situation,
      level: this.style.level,
      address: pickAddress(m, this.style, this.cfg.address, this.rand),
      task: vars.task && !detectSecret(vars.task).secret && !isSeriousTopic(vars.task) ? vars.task.slice(0, 120) : undefined,
      missStreak: st.missStreak,
      doneStreak: st.doneStreak,
      hour: w.h,
      weekday: w.wd,
      length: pickLength(this.rand),
      interests: this.rand() < INTEREST_CHANCE ? INTERESTS : [],
      occasion: vars.occasion,
      facts: vars.facts,
      angle: pickAngle(this.rand),
      noLead: this.rand() < 0.7,
      jaMax: this.rand() < 0.5 ? 1 : 2,
      action: this.rand() < 0.33,
    };
    const line = await liveLine(lc.ai, req, { timeoutMs: lc.timeoutMs });
    if (!line) return this.say(situation, vars, mood);
    this.cinema = false;
    this.state = { ...this.state!, lastDramaAt: dramatic ? this.ctx.now : this.state!.lastDramaAt };
    return line;
  }

  /** Кино-момент по требованию (/mood show:cinema): обходит шанс, паузу и уровень; паузу при этом не заводит. */
  forceCinema(situation: Situation = "reminder", vars: PhraseVars = {}): string {
    if (!this.state) throw new Error("MoodSession: сначала load()");
    const r = cinemaMoment({ mood: this.state.mood, situation, style: this.style, state: this.styleState, now: this.ctx.now, rand: this.rand, vars, cfg: this.cfg, force: true });
    return r!.text;
  }

  /** Можно ли засчитать симпатию за аниме-слово хозяина: раз в cooldownHours (ТЗ, 5Д). */
  wordBonusReady(): boolean {
    return this.ctx.now - (this.styleState.bon ?? 0) >= this.cfg.events.userWord.cooldownHours * 3_600_000;
  }

  /** Событие «хозяин сказал аниме-слово»: активность (+симпатия, если пауза прошла) и ответ в тон настроению. */
  hearWord(id: UserWordId): string {
    if (!this.state) throw new Error("MoodSession: сначала load()");
    const bonus = this.wordBonusReady() ? this.cfg.events.userWord.affection : 0;
    this.apply({ type: "activity", bonus });
    if (bonus) this.styleState = { ...this.styleState, bon: this.ctx.now };
    this.dirty = true;
    return fill(wordReply(id, this.state.mood, this.rand), { user: this.cfg.address }, this.cfg);
  }

  /** Снимок на случай неудачной отправки: откатить изменения этой сессии, чтобы не посчитать событие дважды. */
  snapshot(): { state: MoodState | null; pending: number; dirty: boolean; styleState: StyleState } {
    return { state: this.state, pending: this.pending.length, dirty: this.dirty, styleState: this.styleState };
  }

  restore(snap: { state: MoodState | null; pending: number; dirty: boolean; styleState: StyleState }): void {
    this.state = snap.state;
    this.styleState = snap.styleState;
    this.pending = this.pending.slice(0, snap.pending);
    this.dirty = snap.dirty;
  }

  /** Операции для записи: состояние (если менялось) и журнал переходов. Вызывать один раз перед repo.exec. */
  ops(): Op[] {
    const out = [...this.pending];
    if (this.dirty && this.state) out.push(saveOp(this.userId, this.state, this.styleState));
    this.pending = [];
    this.dirty = false;
    return out;
  }
}

/**
 * «Готово» по делу: событие для настроения и фраза для сообщения (или null — стиль выключен / фраз нет).
 * Выполнение главного напоминания до просрочки — «вовремя», после — «с опозданием»; остальное (таймеры, «заранее») — просто активность.
 * Приоритет фраз: особая похвала за серию → «наконец-то» после пропусков → редкая скупая похвала → обычная для настроения.
 */
export async function recordDone(m: MoodSession, occ: Pick<OccView, "kind" | "item_kind" | "state" | "title" | "critical"> & { plain?: number }): Promise<string | null> {
  const counts = occ.kind === "main" && occ.item_kind === "reminder";
  const r = m.apply(counts ? { type: "done", onTime: occ.state !== "overdue" } : { type: "activity" });
  if (!canStyle(occ.title, occ.critical, occ.plain ?? 0)) return null;
  const vars = { task: occ.title };
  if (counts && r.milestone !== null) return m.sayLive("streak_praise", vars, "proud");
  if (counts && r.relief) return m.sayLive("relief", vars);
  if (counts && m.rand() < m.cfg.randomPraiseChance) return m.sayLive("done", vars, "proud");
  return m.sayLive(counts && occ.state === "overdue" ? "done_late" : "done", vars);
}

/** Реплика к подтверждению «Записано …»: null на серьёзных темах и критичных делах (стиль там выключен) или когда пула нет. */
export async function recordedLine(m: MoodSession, title: string, critical: boolean | number): Promise<string | null> {
  if (!m.loaded || !canStyle(title, critical)) return null;
  return m.sayLive("recorded", { task: title });
}

/** Шанс реплики под сводкой («почти в каждом сообщении, но без перебора»). Праздник и пустой день — всегда. */
export const SUMMARY_LINE_CHANCE = { morning: 0.85, evening: 0.75, weekly: 1 } as const;

/**
 * Реплика Хару под сводкой: праздник или день рождения (утром) → особая; пустой день → «дел нет»; иначе обычная по шансу.
 * Возвращает null, если реплику решили не ставить (шанс) или пула нет.
 */
export async function summaryLine(
  m: MoodSession,
  a: { kind: "morning" | "evening" | "weekly"; open: number; done?: number; wall: { y: number; mo: number; d: number }; birthday: MonthDay | null },
): Promise<string | null> {
  if (!m.loaded) return null;
  const occ = a.kind === "morning" ? occasionFor(a.wall, a.birthday) : null;
  if (occ) return m.sayLive(occ.situation, { occasion: occ.label });
  if (a.kind === "morning" && a.open === 0) return m.sayLive("empty_today", { facts: "на сегодня дел нет" });
  if (m.rand() >= SUMMARY_LINE_CHANCE[a.kind]) return null;
  if (a.kind === "morning") return m.sayLive("summary_morning", { facts: `открытых дел: ${a.open}` });
  if (a.kind === "evening") return m.sayLive("summary_evening", { facts: a.open === 0 ? "незакрытых дел нет" : `незакрытых дел: ${a.open}` });
  return m.sayLive("summary_weekly", { facts: `закрыто за неделю: ${a.done ?? 0}, открыто: ${a.open}` });
}

