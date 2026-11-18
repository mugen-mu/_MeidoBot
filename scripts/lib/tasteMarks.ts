// Загрузка прошлых отметок Ihor из анкеты вкусов в таблицу `anime` (2026-11-18): чистые функции без чтения файлов и базы.
// Коды анкеты: now смотрю сейчас, love в восторге, like понравилось, seen смотрел, meh так себе, dislike не понравилось, drop бросил,
// plan отложил на потом, none не смотрел. В волне 1 у тайтла один код (строка), в волне 3 — несколько (массив).

export type TasteCode = "now" | "love" | "like" | "meh" | "seen" | "dislike" | "drop" | "plan" | "none";
export type TasteStatus = "watching" | "planned" | "done" | "dropped";

const CODES = new Set<string>(["now", "love", "like", "meh", "seen", "dislike", "drop", "plan", "none"]);
/** Отметки, из которых видно, что тайтл смотрели (и оценка из них же). */
const WATCHED = new Set<string>(["love", "like", "seen", "meh", "dislike"]);
const RATING: Record<string, number> = { love: 2, like: 1, meh: -1, dislike: -2 };

export interface TasteMark {
  status: TasteStatus;
  /** anime.liked: 2 в восторге, 1 понравилось, -1 так себе, -2 не зашло, 0 — оценки нет */
  liked: number;
  /** что пришлось решать по правилам (для сводки): «plan+seen», «rating-conflict», … */
  notes: string[];
}

/**
 * Коды одного тайтла → статус и оценка; null — загружать нечего (только «не смотрел» / пусто / неизвестные коды).
 * Приоритет статуса: drop → now → любая «смотрел/оценка» → plan. «none» рядом с другим кодом ничего не значит («не смотрел» + «в планах» = планы).
 * Противоречивые оценки (например, «понравилось» и «не понравилось») — оценку не ставим (0), тайтл всё равно загружаем.
 */
export function mapCodes(input: readonly string[] | string): TasteMark | null {
  const codes = new Set((Array.isArray(input) ? input : [input]).filter((c): c is string => typeof c === "string" && CODES.has(c)));
  const watched = [...codes].some((c) => WATCHED.has(c));
  const notes: string[] = [];
  let status: TasteStatus;
  if (codes.has("drop")) {
    status = "dropped";
    if (codes.has("now")) notes.push("drop+now");
    if (codes.has("plan")) notes.push("drop+plan");
  } else if (codes.has("now")) {
    status = "watching";
    if (codes.has("plan")) notes.push("now+plan");
  } else if (watched) {
    status = "done";
    if (codes.has("plan")) notes.push("plan+seen");
  } else if (codes.has("plan")) {
    status = "planned";
  } else {
    return null;
  }
  const ratings = [...new Set([...codes].filter((c) => c in RATING).map((c) => RATING[c]))];
  if (ratings.length > 1) notes.push("rating-conflict");
  return { status, liked: ratings.length === 1 ? ratings[0] : 0, notes };
}

// Список из файла анкеты (data/taste, папки волн, lists, файлы .json): нужны только списки тайтлов — kind «title» (волна 1) и «anime2» (волна 3).
export interface TasteList {
  kind?: string;
  states?: Record<string, string[] | string>;
  names?: Record<string, string>;
}

export const TITLE_KINDS = new Set(["title", "anime2"]);

/** Данные о тайтле из design/taste/titles.json и design/taste/w3/titles.json. */
export interface TitleInfo {
  ru: string;
  orig: string | null;
  episodes: number | null;
}

/** Собрать названия из страниц анкеты: `{lists: [{items: [{id, ru, orig, episodes?}]}]}`. Первый встреченный тайтл не перезаписывается. */
export function collectTitles(pages: unknown[]): Map<number, TitleInfo> {
  const out = new Map<number, TitleInfo>();
  for (const page of pages) {
    const lists = (page as { lists?: { items?: unknown[] }[] } | null)?.lists;
    for (const l of Array.isArray(lists) ? lists : []) {
      for (const it of Array.isArray(l.items) ? (l.items as Record<string, unknown>[]) : []) {
        const id = Number(it?.id);
        const ru = typeof it?.ru === "string" ? it.ru.trim() : "";
        if (!Number.isInteger(id) || id <= 0 || !ru || out.has(id)) continue;
        const orig = typeof it.orig === "string" && it.orig.trim() ? it.orig.trim() : null;
        const ep = Number(it.episodes);
        out.set(id, { ru, orig, episodes: Number.isInteger(ep) && ep > 0 ? ep : null });
      }
    }
  }
  return out;
}

export interface ImportRow {
  mal_id: number;
  title_ru: string;
  title_orig: string | null;
  status: TasteStatus;
  /** серий хозяин не отмечал: всегда 0 */
  watched: 0;
  liked: number;
  /** только для «Просмотрено» и только если известно из titles.json */
  episodes: number | null;
}

export interface ImportReport {
  rows: ImportRow[];
  /** сколько тайтлов в списках всего и сколько из них без отметки / только «не смотрел» */
  seen: number;
  skippedNone: number;
  /** есть отметка, но нет названия ни в titles.json, ни в самом списке — не загружаем */
  noTitle: number;
  /** тайтл встретился в нескольких списках: коды сложены вместе */
  merged: number;
  notes: Record<string, number>;
}

/**
 * Все списки → строки для загрузки. Один тайтл в нескольких списках — коды складываются (пересечений в живых данных нет, но так надёжнее).
 * Названия — из titles.json, запасной вариант — имя из самого списка анкеты.
 */
export function buildRows(lists: TasteList[], titles: Map<number, TitleInfo>): ImportReport {
  const codes = new Map<number, string[]>();
  const names = new Map<number, string>();
  let merged = 0;
  for (const l of lists) {
    if (!l || !TITLE_KINDS.has(String(l.kind))) continue; // «taste», «need», «read»: не тайтлы
    for (const [key, v] of Object.entries(l.states ?? {})) {
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0) continue;
      const add = Array.isArray(v) ? v : [v];
      const had = codes.get(id);
      if (had) merged++;
      codes.set(id, [...(had ?? []), ...add]);
      const nm = l.names?.[key];
      if (typeof nm === "string" && nm.trim() && !names.has(id)) names.set(id, nm.trim());
    }
  }
  const rows: ImportRow[] = [];
  const notes: Record<string, number> = {};
  let skippedNone = 0;
  let noTitle = 0;
  for (const [id, cs] of codes) {
    const mark = mapCodes(cs);
    if (!mark) {
      skippedNone++;
      continue;
    }
    const info = titles.get(id);
    const ru = info?.ru ?? names.get(id);
    if (!ru) {
      noTitle++;
      continue;
    }
    for (const n of mark.notes) notes[n] = (notes[n] ?? 0) + 1;
    rows.push({
      mal_id: id,
      title_ru: ru,
      title_orig: info?.orig ?? null,
      status: mark.status,
      watched: 0,
      liked: mark.liked,
      episodes: mark.status === "done" ? (info?.episodes ?? null) : null,
    });
  }
  return { rows: orderRows(rows), seen: codes.size, skippedNone, noTitle, merged, notes };
}

const byTitle = (a: ImportRow, b: ImportRow): number => a.title_ru.localeCompare(b.title_ru, "ru") || a.mal_id - b.mal_id;
const GROUPS: TasteStatus[] = ["watching", "planned", "done", "dropped"];

/**
 * Порядок вставки = порядок номеров (id) в таблице, а список бота показывает «Смотрю» и «В планах» по возрастанию id, а «Просмотрено» и «Бросил» —
 * по убыванию. Поэтому в первых двух — сначала любимое, по алфавиту; в последних — наоборот, чтобы на первой странице были самые любимые.
 */
export function orderRows(rows: ImportRow[]): ImportRow[] {
  const out: ImportRow[] = [];
  for (const st of GROUPS) {
    const g = rows.filter((r) => r.status === st);
    if (st === "watching" || st === "planned") g.sort((a, b) => b.liked - a.liked || byTitle(a, b));
    else g.sort((a, b) => a.liked - b.liked || byTitle(b, a));
    out.push(...g);
  }
  return out;
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * SQL для `wrangler d1 execute meido --remote --file=…`: одна вставка на строку, без BEGIN/COMMIT (D1 их в файле не принимает).
 * `ON CONFLICT(mal_id) DO NOTHING` — повторный запуск и уже записанное в боте (серии, оценки, статус) не затираются.
 * Остальные колонки берут значения по умолчанию: notify = 1, aired_ep = 0, asked_ep = 0, src_status — пусто (догонит ночное обновление).
 */
export function renderSql(rows: ImportRow[], now: number): string {
  const head = [
    "-- Meido: отметки из анкеты вкусов (волны 1 и 3) в таблицу anime. Сделано scripts/import-taste-marks.ts.",
    "-- Повторный запуск безопасен: ON CONFLICT(mal_id) DO NOTHING не трогает уже записанное.",
  ];
  const stmts = rows.map(
    (r) =>
      `INSERT INTO anime (mal_id, title_ru, title_orig, status, watched, liked, episodes, added_at, updated_at) VALUES (${r.mal_id}, ${q(r.title_ru)}, ${r.title_orig ? q(r.title_orig) : "NULL"}, ${q(r.status)}, ${r.watched}, ${r.liked}, ${r.episodes ?? "NULL"}, ${now}, ${now}) ON CONFLICT(mal_id) DO NOTHING;`,
  );
  return `${[...head, ...stmts].join("\n")}\n`;
}

/** Сводка для экрана: сколько каких статусов, оценок и что пропущено. Названий тайтлов не содержит. */
export function summarize(rep: ImportReport): string[] {
  const by = (st: TasteStatus) => rep.rows.filter((r) => r.status === st);
  const likedCount = (rows: ImportRow[], n: number) => rows.filter((r) => r.liked === n).length;
  const lines = [
    `Тайтлов в списках анкеты: ${rep.seen}; к загрузке: ${rep.rows.length}.`,
    `  Смотрю: ${by("watching").length} · В планах: ${by("planned").length} · Просмотрено: ${by("done").length} · Бросил: ${by("dropped").length}`,
  ];
  for (const [label, st] of [["Просмотрено", "done"], ["Бросил", "dropped"], ["Смотрю", "watching"]] as const) {
    const g = by(st);
    if (!g.length) continue;
    lines.push(`  ${label}: 🔥 в восторге ${likedCount(g, 2)} · ❤ понравилось ${likedCount(g, 1)} · без оценки ${likedCount(g, 0)} · так себе ${likedCount(g, -1)} · 👎 не зашло ${likedCount(g, -2)}`);
  }
  lines.push(`  У «Просмотрено» известно число серий: ${by("done").filter((r) => r.episodes !== null).length} из ${by("done").length}`);
  lines.push(`Пропущено: «не смотрел»/без отметки ${rep.skippedNone}; без названия ${rep.noTitle}. Тайтл в нескольких списках: ${rep.merged}.`);
  const nt = Object.entries(rep.notes).sort();
  if (nt.length) lines.push(`Спорные сочетания (решено по правилам): ${nt.map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  return lines;
}
