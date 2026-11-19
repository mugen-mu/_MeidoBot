// Канал аварийной службы Днепра (t.me/s/avariykaaa, «Дніпро Аварійна служба», украинский): свет и вода, только то, что касается хозяина.
// Заменил пересылку постов Укрэнерго (решение Ihor 2026-11-19: те сообщения «не несут смысла»; родители пользуются этим каналом).
// Канал пёстрый: график на завтра, списки сёл и улиц, вода водоканала, сбор денег, погода, вбросы. Поэтому правило одно: пересылаем только то,
// что по тексту узнаётся как одно из перечисленных ниже, и только если оно про Днепр (или про очередь хозяина из настройки «Свет: группа»).
// Бот ничего не пересказывает моделью: короткая выдержка (своя строка очереди, а не весь список) и ссылка на пост.
// Публичная страница читается без входа через `tgChannel.ts`; один подзапрос раз в 10 минут. Сломался источник — виден на экране «Состояние».
import { whenText } from "./sources.ts";
import { type TgPost, fetchTgChannel } from "./tgChannel.ts";
import { HOUR, MINUTE } from "./time/tz.ts";
import { DISTRICTS, HIT_NOTE, LEVEL_WORD, type DistrictLevel, type DistrictMap, type WaterAlert, type WaterMatch, type WaterPost, matchWater, waterKind } from "./water.ts";

export const AVARIA_CHANNEL = "avariykaaa";
export const AVARIA_CHECK_EVERY = 10 * MINUTE;
/** meta: когда читать ленту в следующий раз, до какого поста дошли, очередь сообщений, последний пост про свет */
export const AVARIA_NEXT_KEY = "avaria_next";
export const AVARIA_STATE_KEY = "avaria_state";
export const AVARIA_OUTBOX_KEY = "avaria_outbox";
export const AVARIA_LAST_KEY = "avaria_last";
/** ключи прежней пересылки Укрэнерго: больше не нужны, cron их удаляет */
export const AVARIA_OLD_KEYS = ["ukr_next", "ukr_state", "ukr_outbox", "ukr_last"];
/** посты старше этого срока в канал не пересылаем (бот долго молчал или первый запуск): новость уже не новость */
export const AVARIA_MAX_AGE = 12 * HOUR;
/** пост про свет «свежий» для строки в сообщении «света нет» */
export const AVARIA_FRESH_FOR_OUTAGE = 6 * HOUR;
/** упоминание (push) не чаще раза в час: в день отключений канал пишет про «экстренные» каждые несколько минут */
export const AVARIA_PING_GAP = HOUR;
/** воду от водоканала в этом окне считаем уже объявленной, если совпал район и улица не названа */
export const AVARIA_WATER_DEDUPE = 6 * HOUR;
const MAX_NOTICES_PER_RUN = 2;
const EXCERPT_MAX = 450;
const OUTAGE_EXCERPT_MAX = 240;

export const fetchAvaria = (fetchFn: typeof fetch = fetch): Promise<TgPost[] | null> => fetchTgChannel(AVARIA_CHANNEL, fetchFn);

/** Источник нужен, пока включён свет (группа) или вода (слова места); оба выключены — в сеть не ходим. */
export const avariaOn = (s: { lightGroup: string | null; waterWords: string[] }): boolean => !!s.lightGroup || s.waterWords.length > 0;

// ---------- очередь хозяина ----------

/** «3» -> 3.1 и 3.2, «3.1» -> одна. Не разобралось (мусор в настройке) — пусто: тогда берём только общегородское. */
export function groupTokens(group: string | null): string[] {
  const m = /^\s*([1-6])(?:\s*[.,]\s*([12]))?\s*$/.exec(group ?? "");
  if (!m) return [];
  return m[2] ? [`${m[1]}.${m[2]}`] : [`${m[1]}.1`, `${m[1]}.2`];
}

/** «3.1» как отдельное слово: не «13.1», не «3.12», не дата «3.1.2026». */
const tokenRe = (t: string): RegExp => new RegExp(String.raw`(?<![\d.])${t.replace(".", String.raw`\.`)}(?!\d|\.\d)`);
const hasToken = (s: string, t: string): boolean => tokenRe(t).test(s);
const ANY_TOKEN = /(?<![\d.])[1-6]\.[12](?!\d|\.\d)/;
const TIME = /\d{1,2}:\d{2}/;

// ---------- текст поста ----------

const URL_LINE = /^\s*https?:\/\/\S+\s*$/;
/** Начало строки без значков (⚡️, ❗️, 🔹, 🚱…): в выдержке они только мешают. Маркер списка «•» остаётся. */
const tidy = (l: string): string => l.replace(/^[^\p{L}\p{N}«"'(•–—-]+/u, "").trim();
/** Строки поста без пустых и без последней строки-ссылки на канал. */
const bodyLines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l && !URL_LINE.test(l));

/** Обрезка по концу предложения, иначе по слову. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > max * 0.5) return cut.slice(0, end + 1);
  const sp = cut.lastIndexOf(" ");
  return `${cut.slice(0, sp > 0 ? sp : max)}…`;
}

const quote = (s: string): string =>
  s
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

// ---------- свет: что это за пост ----------

export type LightKind = "emergency" | "emergency_cancel" | "schedule_cancel" | "group_emergency" | "group_works" | "restore" | "change" | "queues_off" | "heads_up";

/** status — «что сейчас у города/очереди» (новый пост вытесняет прежние за один запуск), schedule — «что в графике». */
const FAMILY: Record<LightKind, "status" | "schedule"> = {
  emergency: "status",
  emergency_cancel: "status",
  schedule_cancel: "status",
  group_emergency: "status",
  group_works: "status",
  restore: "schedule",
  change: "schedule",
  queues_off: "schedule",
  heads_up: "schedule",
};
/** с упоминанием — только экстренное, что касается хозяина; остальное тихо */
const LOUD: ReadonlySet<LightKind> = new Set(["emergency", "group_emergency", "group_works"]);

const TOMORROW = /(?<![\p{L}])завтра(?![\p{L}])/iu;
// «екстрені/аварійні відключення»; «аварійні роботи» и «аварійно-відновлювальні» сюда не относятся — так пишут про ремонтників
const EMERG = /(?:екстрен|аварійн)\S*\s+(?:відключ|вимкнен)/iu;
const EMERG_CANCEL = /скасов\S*[^.!?\n]{0,60}?(?:екстрен|аварійн)\S*\s+відключ|(?:екстрен|аварійн)\S*\s+відключ\S*[^.!?\n]{0,40}?скасов/iu;
const SCHEDULE_CANCEL = /графік\S*[^.!?\n]{0,80}?скасов|скасув\S*\s+графік|скасов\S*[^.!?\n]{0,40}?графік/iu;
const ALL_GROUPS = /(?:всіх|усіх)\s+(?:груп|черг)|(?:всі|усі)\s+(?:групи|черги)|для\s+всіх(?![\p{L}])/iu;
const WORKS = /аварійн\S*\s+(?:роботи|ремонт)|аварійно-(?:відновлю|ремонт)/iu;
const RESTORE = /відновлен/iu;
const QUEUES_OFF = /відключа(?:ються|ють)\s+(?:черги|групи)|відключення\s+(?:черг|груп)/iu;
const HEADS_UP = /(?:відключ|вимкнен)[^.!?\n]{0,60}?(?:за\s+групами|по\s+групах|за\s+чергами)|(?:за\s+групами|по\s+групах)[^.!?\n]{0,60}?(?:відключ|вимкнен)/iu;
// Днепр: слово «Дніпро» (не «Дніпровськ…»: после «дніпро» идёт буква), область (город в ней), ЦЕК
const DNIPRO = /(?<![\p{L}])дніпр(?:о|і|а|у|ом|ові)(?![\p{L}])|дніпропетровськ|дніпропетровщин|(?<![\p{L}])цек(?![\p{L}])/iu;
const PLACE_MARK = /(?<![\p{L}])(?:м\.|с\.|с-ще|смт|селищ\S*|район\S*|р-н\S*|област\S*)/iu;
// «за адресами», «вул. …»: список улиц — адрес хозяина боту неизвестен, такие посты не берём
const ADDR = /за\s+адрес|(?<![\p{L}])(?:вул|просп|пров|бульв|наб)\.|вулиц[яіюь](?![\p{L}])|проспект/iu;

/** Про Днепр, если он назван; если назван только чужой населённый пункт или область — нет; если место не названо — это канал Днепра, да. */
const placeOk = (low: string): boolean => DNIPRO.test(low) || !PLACE_MARK.test(low);

export interface LightHit {
  kind: LightKind;
  /** строки поста про очередь хозяина (для выдержки) */
  lines: string[];
}

/**
 * Что значит пост для света хозяина. null — не про нас (завтрашний график, списки улиц, чужие очереди, деньги, новости).
 * Порядок проверок важен: сначала «отменено», потом «экстренное», потом очередь хозяина.
 */
export function lightHit(text: string, tokens: string[]): LightHit | null {
  const low = text.toLowerCase();
  // график на завтра (в том числе картинкой с подписью) — дело вечерней сводки по данным Yasno
  if (TOMORROW.test(low)) return null;
  const mine = tokens.some((t) => hasToken(low, t));
  // чужая очередь: в посте названы очереди, а хозяина среди них нет (и «всех» тоже нет)
  const scoped = tokens.length > 0 && ANY_TOKEN.test(low) && !mine;
  const lines = mine ? bodyLines(text).filter((l) => tokens.some((t) => hasToken(l, t)) && TIME.test(l)).map(tidy) : [];

  if (EMERG_CANCEL.test(low)) return (!scoped || ALL_GROUPS.test(low)) && placeOk(low) ? { kind: "emergency_cancel", lines } : null;
  if (SCHEDULE_CANCEL.test(low)) return (mine || ALL_GROUPS.test(low)) && placeOk(low) ? { kind: "schedule_cancel", lines: [] } : null;
  if (EMERG.test(low)) {
    if (mine) return placeOk(low) ? { kind: "group_emergency", lines: [] } : null;
    if (scoped || ADDR.test(low)) return null;
    return placeOk(low) ? { kind: "emergency", lines: [] } : null;
  }
  if (mine) {
    if (!placeOk(low)) return null;
    if (WORKS.test(low)) return { kind: "group_works", lines: [] };
    if (RESTORE.test(low)) return { kind: "restore", lines: [] };
    if (QUEUES_OFF.test(low) && lines.length) return { kind: "queues_off", lines };
    if (lines.length) return { kind: "change", lines };
    return null;
  }
  if (!scoped && HEADS_UP.test(low) && TIME.test(low) && placeOk(low)) return { kind: "heads_up", lines: [] };
  return null;
}

const OPERATOR = /(?<![\p{L}])(цек|дтек)(?![\p{L}])/iu;

/** Выдержка для сообщения: своя строка очереди, а не весь список; без значков и ссылки на канал. */
export function lightExcerpt(text: string, hit: LightHit, max = EXCERPT_MAX): string {
  const all = bodyLines(text).map(tidy).filter(Boolean);
  if (hit.kind === "change" || hit.kind === "queues_off") return clip(hit.lines.join("\n"), max);
  if (hit.kind === "emergency_cancel" || hit.kind === "schedule_cancel") {
    // шапка про отмену (до трёх строк без номеров очередей) и, если пост перечисляет графики, строка хозяина
    const head = all.filter((l) => !ANY_TOKEN.test(l)).slice(0, 3);
    return clip([...head, ...hit.lines].join("\n"), max);
  }
  return clip(all.join("\n"), max);
}

const HEAD: Record<LightKind, string> = {
  emergency: "экстренные отключения",
  emergency_cancel: "экстренные отключения отменены",
  schedule_cancel: "графики отключений отменены",
  group_emergency: "экстренные отключения у вашей очереди",
  group_works: "аварийные работы у вашей очереди",
  restore: "восстановление света у вашей очереди",
  change: "график на сегодня изменился",
  queues_off: "отключаются очереди, среди них ваша",
  heads_up: "скоро отключения по группам",
};

/** Сообщение в «почту»: заголовок с временем поста, выдержка цитатой, ссылка без предпросмотра. */
export function lightMessage(p: TgPost, hit: LightHit, group: string, now: number, tz: string): string {
  const op = OPERATOR.exec(p.text)?.[1].toUpperCase();
  const grp = hit.kind === "change" || hit.kind === "queues_off" || hit.kind === "restore" ? ` (очередь ${group})` : "";
  return [`⚡ **Свет · ${whenText(p.at, now, tz)} · ${HEAD[hit.kind]}${grp}${op ? ` · ${op}` : ""}**`, quote(lightExcerpt(p.text, hit)), `<${p.link}>`].join("\n");
}

// ---------- вода: что это за пост ----------

/** Пост про воду: значок капли/«нет воды» в начале или слова про водопостачання. Свет с водой не пересекается. */
export const isWaterPost = (text: string): boolean =>
  /^[^\p{L}\p{N}]*[💧🚱🚰]/u.test(text) || /водопостач|подач\S*\s+вод|тиск\S*\s+(?:води|у\s+системі\s+водо)/iu.test(text);

/** Районы, названные словом «район»: «Центральний район», «У Центральному районі», «Амур-Нижньодніпровський район» (улица «Центральна» — не район). */
export function channelDistricts(text: string, level: DistrictLevel): DistrictMap {
  const out: DistrictMap = {};
  for (const d of DISTRICTS) if (new RegExp(String.raw`${d.stem}[\p{L}'’ʼ-]*\s+(?:район|р-н)`, "iu").test(text)) out[d.name] = level;
  return out;
}

export interface WaterHit {
  kind: "outage" | "restored";
  match: WaterMatch;
}

/** Совпадение поста про воду со словами хозяина (те же правила, что у `water.ts`: район, улица). */
export function waterHit(p: TgPost, words: string[]): WaterHit | null {
  if (!words.length || !isWaterPost(p.text)) return null;
  const lines = bodyLines(p.text).map(tidy).filter(Boolean);
  // «💧Дніпро – знижено тиск на верхніх поверхах» слова «вода» не содержит: капля в начале говорит это за пост
  const drop = /^[^\p{L}\p{N}]*[💧🚱🚰]/u.test(p.text) ? "Вода: " : "";
  const wp: WaterPost = { id: p.id, date: p.at, modified: "", link: p.link, title: `${drop}${lines[0] ?? ""}`, text: lines.join(" "), mapUrl: null };
  const kind = waterKind(wp);
  if (kind !== "outage" && kind !== "restored") return null;
  const low = wp.text.toLowerCase();
  const level: DistrictLevel = kind === "restored" || /припин|призупин|відсутн|відключ/.test(low) ? "off" : "low";
  const match = matchWater(wp, words, channelDistricts(p.text, level));
  // уровень по тексту всего поста: без названного района `matchWater` по умолчанию сказал бы «воды не будет» и про «знижено тиск»
  return match ? { kind, match: { ...match, level } } : null;
}

/** Водоканал (`water.ts`) за последние часы уже объявил про этот район — второе сообщение «район совпал» только шумит. Улица, названная в тексте, всегда проходит. */
export function coveredByVodokanal(hit: WaterHit, alerts: WaterAlert[], now: number): boolean {
  if (hit.match.hit === "street") return false;
  const names = Object.keys(hit.match.districts);
  return alerts.some((a) => now - a.born < AVARIA_WATER_DEDUPE && a.districts.some((n) => names.includes(n)));
}

export function waterMessage(p: TgPost, hit: WaterHit, now: number, tz: string): string {
  const names = Object.keys(hit.match.districts);
  const where = names.length ? ` (${names.join(", ")})` : "";
  const what = hit.kind === "restored" ? "вода вернулась" : LEVEL_WORD[hit.match.level];
  const lines = bodyLines(p.text).map(tidy).filter(Boolean);
  return [
    `💧 **Вода · ${whenText(p.at, now, tz)} · ${what}${where}**${hit.kind === "restored" ? "" : HIT_NOTE[hit.match.hit]}`,
    quote(clip(lines.join("\n"), EXCERPT_MAX)),
    `<${p.link}>`,
  ].join("\n");
}

// ---------- состояние и сообщения ----------

export interface AvariaState {
  /** номер последнего просмотренного поста */
  last: number;
  /** когда в последний раз упоминали хозяина (мс) */
  ping?: number;
}

export interface AvariaLast {
  id: number;
  at: number;
  kind: LightKind;
  text: string;
  link: string;
}

export interface AvariaNotice {
  text: string;
  mention: boolean;
}

export function parseAvariaState(raw: string | undefined): AvariaState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AvariaState>;
    if (typeof v.last !== "number" || !Number.isFinite(v.last)) return null;
    return typeof v.ping === "number" && Number.isFinite(v.ping) ? { last: v.last, ping: v.ping } : { last: v.last };
  } catch {
    return null;
  }
}

export function parseAvariaLast(raw: string | undefined): AvariaLast | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AvariaLast>;
    return typeof v.at === "number" && typeof v.text === "string" && typeof v.link === "string" && typeof v.kind === "string" ? (v as AvariaLast) : null;
  } catch {
    return null;
  }
}

export interface AvariaCfg {
  /** «Свет: группа» из настроек; null — свет выключен */
  group: string | null;
  /** «Вода: слова места»; пусто — вода выключена */
  words: string[];
  tz: string;
  /** открытые предупреждения водоканала (`water_state.alerts`): чтобы не повторять их из канала */
  waterAlerts: WaterAlert[];
}

type Item =
  | { p: TgPost; family: "status" | "schedule"; hit: LightHit }
  | { p: TgPost; family: "water"; hit: WaterHit };

/**
 * Что делать с прочитанной лентой. Первое чтение: запоминаем, до какого поста дошли, и молчим (старые новости не вываливаем).
 * Дальше: новые подходящие посты не старше 12 часов. Внутри одного запуска свежее вытесняет прежнее («экстренные» -> «отменены»);
 * не больше двух сообщений; упоминание только у «экстренного» и не чаще раза в час, вода — как у `water.ts`.
 */
export function planAvaria(
  state: AvariaState | null,
  posts: TgPost[],
  now: number,
  cfg: AvariaCfg,
  prevLast: AvariaLast | null,
): { state: AvariaState; notices: AvariaNotice[]; last: AvariaLast | null } {
  const sorted = [...posts].sort((a, b) => a.id - b.id);
  const maxId = sorted.length ? sorted[sorted.length - 1].id : state?.last ?? 0;
  const next: AvariaState = { last: Math.max(state?.last ?? 0, maxId), ...(state?.ping !== undefined ? { ping: state.ping } : {}) };
  const tokens = groupTokens(cfg.group);
  const items = sorted.flatMap((p): Item[] => {
    if (isWaterPost(p.text)) {
      const hit = waterHit(p, cfg.words);
      return hit ? [{ p, family: "water", hit }] : [];
    }
    const hit = cfg.group ? lightHit(p.text, tokens) : null;
    return hit ? [{ p, family: FAMILY[hit.kind], hit }] : [];
  });
  // «последний пост про свет» (для строки в сообщении «света нет») обновляем и на первом чтении
  const lights = items.filter((i): i is Extract<Item, { family: "status" | "schedule" }> => i.family !== "water");
  const newest = lights.length ? lights[lights.length - 1] : null;
  const last: AvariaLast | null =
    newest && (!prevLast || newest.p.id >= prevLast.id)
      ? { id: newest.p.id, at: newest.p.at, kind: newest.hit.kind, text: lightExcerpt(newest.p.text, newest.hit), link: newest.p.link }
      : prevLast;
  if (!state) return { state: next, notices: [], last };

  const fresh = items.filter((i) => i.p.id > state.last && now - i.p.at <= AVARIA_MAX_AGE);
  // по одному посту «статуса» (новейший: «отменены» вытесняет «экстренные») и «графика» (строка про очередь хозяина важнее общего
  // предупреждения «скоро отключения по группам», при равенстве новейший); воды — все
  const keep = new Set<Item>();
  const general = (i: Item): number => (i.family !== "water" && i.hit.kind === "heads_up" ? 0 : 1);
  for (const fam of ["status", "schedule"] as const) {
    const of = fresh.filter((i) => i.family === fam);
    if (!of.length) continue;
    keep.add(fam === "status" ? of[of.length - 1] : [...of].sort((a, b) => general(b) - general(a) || b.p.id - a.p.id)[0]);
  }
  for (const i of fresh) if (i.family === "water") keep.add(i);
  const rank = (i: Item): number => (i.family === "status" ? 2 : i.family === "water" ? 1 : 0);
  // больше двух за раз не шлём: сначала «статус», потом вода, потом график; при равенстве свежее важнее
  const chosen = [...keep].sort((a, b) => rank(b) - rank(a) || b.p.id - a.p.id).slice(0, MAX_NOTICES_PER_RUN).sort((a, b) => a.p.id - b.p.id);

  const notices: AvariaNotice[] = [];
  for (const i of chosen) {
    if (i.family === "water") {
      if (coveredByVodokanal(i.hit, cfg.waterAlerts, now)) continue;
      notices.push({ text: waterMessage(i.p, i.hit, now, cfg.tz), mention: true });
      continue;
    }
    const loud = LOUD.has(i.hit.kind) && now - (next.ping ?? 0) >= AVARIA_PING_GAP;
    if (loud) next.ping = now;
    notices.push({ text: lightMessage(i.p, i.hit, cfg.group ?? "", now, cfg.tz), mention: loud });
  }
  return { state: next, notices, last };
}

/** Строка в сообщение «Света нет»: свежий пост канала про свет (до 6 часов); иначе null. */
export function avariaAnnounceLine(raw: string | undefined, now: number, tz: string): string | null {
  const l = parseAvariaLast(raw);
  if (!l || now - l.at > AVARIA_FRESH_FOR_OUTAGE || now < l.at) return null;
  return `⚡ Аварийная служба, ${whenText(l.at, now, tz)}: «${clip(l.text.replace(/\s*\n\s*/g, " "), OUTAGE_EXCERPT_MAX)}» <${l.link}>`;
}
