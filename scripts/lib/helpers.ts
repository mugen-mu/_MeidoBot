// Чистые помощники для скриптов установки и проверки (тесты — test/setup.test.ts).

import { parseUsage, statusLines } from "../../src/usage.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const PLACEHOLDER_DB_ID = "REPLACE_WITH_D1_DATABASE_ID";

/** id базы из вывода `wrangler d1 create` (кусок для toml или JSON). */
export function extractDatabaseId(text: string): string | null {
  const m = new RegExp(`database_id["']?\\s*[=:]\\s*["'](${UUID})["']`, "i").exec(text) ?? new RegExp(UUID, "i").exec(text);
  return m ? (m[1] ?? m[0]) : null;
}

/** id базы из `wrangler d1 list --json` по имени. */
export function findDatabaseId(listJson: string, name: string): string | null {
  try {
    const arr = JSON.parse(listJson) as { name?: string; uuid?: string; database_id?: string }[];
    const row = arr.find((d) => d.name === name);
    return row?.uuid ?? row?.database_id ?? null;
  } catch {
    return null;
  }
}

/** Текущий database_id из wrangler.toml или null, если ещё заглушка. */
export function currentDatabaseId(toml: string): string | null {
  const m = /^\s*database_id\s*=\s*"([^"]*)"/m.exec(toml);
  if (!m || m[1] === PLACEHOLDER_DB_ID || m[1] === "") return null;
  return m[1];
}

export function setDatabaseId(toml: string, id: string): string {
  if (!/^\s*database_id\s*=\s*"[^"]*"/m.test(toml)) throw new Error("в wrangler.toml нет строки database_id");
  return toml.replace(/^(\s*database_id\s*=\s*)"[^"]*"/m, `$1"${id}"`);
}

/** Рабочие почтовые домены: Cloudflare/Discord этого бота — только личные (правило проекта). */
export const WORK_EMAIL_DOMAINS = ["b-eng-s.com"];

export function isWorkEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return WORK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Кто вошёл в Cloudflare: из вывода `wrangler whoami --json` (перед JSON может быть шапка wrangler). */
export function parseWhoami(text: string): { loggedIn: boolean; email: string | null } {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) return { loggedIn: false, email: null };
  try {
    const j = JSON.parse(text.slice(a, b + 1)) as { loggedIn?: boolean; email?: unknown };
    return { loggedIn: j.loggedIn === true, email: typeof j.email === "string" && j.email ? j.email : null };
  } catch {
    return { loggedIn: false, email: null };
  }
}

export function extractWorkerUrl(text: string): string | null {
  const m = /https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.workers\.dev/i.exec(text);
  return m ? m[0] : null;
}

/** Обновить значения в .dev.vars, не трогая чужие строки. */
export function upsertDevVars(content: string, entries: Record<string, string>): string {
  const lines = content === "" ? [] : content.split(/\r?\n/);
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (m && m[1] in entries) {
      done.add(m[1]);
      return `${m[1]}=${entries[m[1]]}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(entries)) if (!done.has(k)) out.push(`${k}=${v}`);
  return `${out.join("\n")}\n`;
}

export function parseDevVars(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// ---------- проверка введённых значений ----------

export const isPublicKey = (s: string): boolean => /^[0-9a-f]{64}$/i.test(s.trim());
export const isAppId = (s: string): boolean => /^\d{17,20}$/.test(s.trim());
export const isBotToken = (s: string): boolean => /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(s.trim());
export const isWatchdogUrl = (s: string): boolean => /^https:\/\/[^\s]+$/i.test(s.trim());

/**
 * Права бота: View Channels, Send Messages, Read Message History, Manage Channels (для /setup),
 * плюс Embed Links и Add Reactions (для характера: embed с цветом настроения, реакции): чтобы потом не добавлять бота заново.
 */
export const BOT_PERMISSIONS = 1024 + 2048 + 65536 + 16 + 16384 + 64;

export function installLinks(appId: string): { server: string; user: string } {
  const base = `https://discord.com/oauth2/authorize?client_id=${appId}`;
  return {
    server: `${base}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}&integration_type=0`,
    user: `${base}&scope=applications.commands&integration_type=1`,
  };
}

// ---------- сводка «всё ли работает» (npm run status) ----------

export interface StatusRows {
  meta: { key: string; value: string }[];
  settings: { key: string; value: string }[];
  open: { state: string; n: number }[];
  problems: { kind: string; n: number }[];
}

const STATE_RU: Record<string, string> = {
  draft: "без срока",
  planned: "запланировано",
  snoozed: "отложено",
  fired: "ждут «Готово»",
  overdue: "просрочено",
};

export function summarizeStatus(rows: StatusRows, now: number): string[] {
  const meta = new Map(rows.meta.map((r) => [r.key, r.value]));
  const set = new Map(rows.settings.map((r) => [r.key, r.value]));
  const out: string[] = [];
  const alive = Number(meta.get("alive_at") ?? 0);
  if (!alive) out.push("Cron: ещё ни разу не запускался (проверьте, что Worker выложен и cron включён).");
  else {
    const min = Math.round((now - alive) / 60_000);
    out.push(min <= 3 ? `Cron: работает (последний запуск ${min} мин назад).` : `Cron: ПРОПАЛ — последний запуск ${min} мин назад.`);
  }
  // запас бесплатных лимитов Cloudflare (бот считает сам, src/usage.ts): сегодня и худшее за неделю
  out.push(...statusLines(parseUsage(meta.get("usage")), now));
  out.push(meta.get("owner_id") ? "Хозяин бота: назначен." : "Хозяин бота: не назначен (выполните /setup в Discord).");
  out.push(
    set.get("ch_remind") && set.get("ch_bot") && set.get("ch_today")
      ? "Каналы: заведены."
      : "Каналы: не заведены (выполните /setup на сервере).",
  );
  let intake: string[] = [];
  try {
    intake = JSON.parse(set.get("intake") ?? "[]");
  } catch {
    /* пусто */
  }
  out.push(`Каналы приёма текста: ${intake.length}${meta.get("dm_channel_id") && intake.includes(meta.get("dm_channel_id") as string) ? " (включая личку)" : ""}.`);
  const total = rows.open.reduce((a, r) => a + r.n, 0);
  out.push(total ? `Открытых дел: ${total} (${rows.open.map((r) => `${STATE_RU[r.state] ?? r.state}: ${r.n}`).join(", ")}).` : "Открытых дел нет.");
  out.push(
    rows.problems.length
      ? `Проблемы за сутки: ${rows.problems.map((r) => `${r.kind} ×${r.n}`).join(", ")}.`
      : "Проблем за сутки нет.",
  );
  return out;
}

/** Результаты `wrangler d1 execute --json` с несколькими запросами -> строки. */
export function parseExecuteJson(text: string): { results: Record<string, unknown>[] }[] {
  const start = text.indexOf("[");
  if (start < 0) throw new Error("в ответе wrangler нет JSON");
  return JSON.parse(text.slice(start)) as { results: Record<string, unknown>[] }[];
}
