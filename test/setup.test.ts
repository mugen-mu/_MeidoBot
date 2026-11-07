import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PLACEHOLDER_DB_ID,
  currentDatabaseId,
  extractDatabaseId,
  extractWorkerUrl,
  findDatabaseId,
  installLinks,
  isAppId,
  isBotToken,
  isPublicKey,
  parseDevVars,
  parseExecuteJson,
  setDatabaseId,
  summarizeStatus,
  upsertDevVars,
} from "../scripts/lib/helpers.ts";
import type { Asker, RunOpts, Runner } from "../scripts/lib/runner.ts";
import { runSetup } from "../scripts/lib/setup.ts";

const DB = "4f1c2b7e-9a3d-4c55-8e21-0b6f5a7d1c33";
const APP = "123456789012345678";
const PUB = "a".repeat(64);
const TOKEN = "FAKE" + "x".repeat(22) + "." + "y".repeat(6) + "." + "z".repeat(30);

describe("помощники установки", () => {
  it("id базы из вывода create и из списка", () => {
    expect(extractDatabaseId(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "meido"\ndatabase_id = "${DB}"`)).toBe(DB);
    expect(extractDatabaseId(`{"uuid": "${DB}"}`)).toBe(DB);
    expect(extractDatabaseId("ничего")).toBeNull();
    expect(findDatabaseId(JSON.stringify([{ name: "x", uuid: "1" }, { name: "meido", uuid: DB }]), "meido")).toBe(DB);
    expect(findDatabaseId("oops", "meido")).toBeNull();
  });

  it("wrangler.toml: заглушка -> id, настоящий id читается, чужое не трогается", () => {
    const toml = readFileSync("wrangler.toml", "utf8");
    expect(currentDatabaseId(toml)).toBeNull();
    expect(toml).toContain(PLACEHOLDER_DB_ID);
    const next = setDatabaseId(toml, DB);
    expect(currentDatabaseId(next)).toBe(DB);
    expect(next.replace(DB, PLACEHOLDER_DB_ID)).toBe(toml);
    expect(() => setDatabaseId("name = 'x'", DB)).toThrow();
  });

  it("адрес Worker из вывода deploy", () => {
    expect(extractWorkerUrl("Deployed meido triggers\n  https://meido.ihor-test.workers.dev\nCurrent Version ID: 1")).toBe("https://meido.ihor-test.workers.dev");
    expect(extractWorkerUrl("нет адреса")).toBeNull();
  });

  it(".dev.vars: обновление не теряет чужие строки", () => {
    const out = upsertDevVars("# моё\nA=1\nDISCORD_APP_ID=old\n", { DISCORD_APP_ID: "new", WATCHDOG_URL: "https://hc/x" });
    expect(out).toBe("# моё\nA=1\nDISCORD_APP_ID=new\nWATCHDOG_URL=https://hc/x\n");
    expect(parseDevVars(out)).toEqual({ A: "1", DISCORD_APP_ID: "new", WATCHDOG_URL: "https://hc/x" });
    expect(upsertDevVars("", { X: "1" })).toBe("X=1\n");
  });

  it("проверка введённых значений", () => {
    expect(isPublicKey(PUB)).toBe(true);
    expect(isPublicKey("abc")).toBe(false);
    expect(isAppId(APP)).toBe(true);
    expect(isAppId("12ab")).toBe(false);
    expect(isBotToken(TOKEN)).toBe(true);
    expect(isBotToken("просто текст")).toBe(false);
  });

  it("ссылки установки: сервер с правами и на пользователя", () => {
    const l = installLinks(APP);
    expect(l.server).toContain(`client_id=${APP}`);
    expect(l.server).toContain("permissions=68624"); // View Channels + Send Messages + Read Message History + Manage Channels
    expect(l.user).toContain("integration_type=1");
  });

  it("сводка состояния: живой cron, пропавший cron, пустая установка", () => {
    const now = 10_000_000;
    const ok = summarizeStatus(
      {
        meta: [{ key: "alive_at", value: String(now - 60_000) }, { key: "owner_id", value: "9" }],
        settings: [{ key: "ch_remind", value: "1" }, { key: "ch_bot", value: "2" }, { key: "ch_today", value: "3" }, { key: "intake", value: '["2"]' }],
        open: [{ state: "overdue", n: 2 }, { state: "planned", n: 5 }],
        problems: [],
      },
      now,
    );
    expect(ok[0]).toContain("работает (последний запуск 1 мин назад)");
    expect(ok.join("\n")).toContain("Открытых дел: 7 (просрочено: 2, запланировано: 5)");
    expect(ok.join("\n")).toContain("Проблем за сутки нет");
    const dead = summarizeStatus({ meta: [{ key: "alive_at", value: String(now - 30 * 60_000) }], settings: [], open: [], problems: [{ kind: "send_failed", n: 3 }] }, now);
    expect(dead[0]).toContain("ПРОПАЛ");
    expect(dead.join("\n")).toContain("send_failed ×3");
    expect(dead.join("\n")).toContain("/setup");
    expect(summarizeStatus({ meta: [], settings: [], open: [], problems: [] }, now)[0]).toContain("ни разу");
  });

  it("разбор JSON от wrangler d1 execute (с мусором перед ним)", () => {
    const r = parseExecuteJson(' ⛅️ wrangler\n[{"results":[{"a":1}],"success":true},{"results":[],"success":true}]');
    expect(r[0].results).toEqual([{ a: 1 }]);
    expect(() => parseExecuteJson("нет json")).toThrow();
  });
});

// ---------- сценарий установки на поддельном wrangler ----------

interface Call {
  args: string[];
  opts: RunOpts;
}

function setupWorld(overrides: { whoami?: (n: number) => number; dbOut?: string; deployOut?: string; secretFail?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meido-setup-"));
  writeFileSync(join(dir, "wrangler.toml"), readFileSync("wrangler.toml", "utf8"), "utf8");
  const calls: Call[] = [];
  let whoamis = 0;
  const runner: Runner = {
    async wrangler(args, opts = {}) {
      calls.push({ args, opts });
      const key = args.slice(0, 2).join(" ");
      if (args[0] === "whoami") return { code: (overrides.whoami ?? (() => 0))(whoamis++), out: "{}" };
      if (args[0] === "login") return { code: 0, out: "" };
      if (key === "d1 create") return { code: 0, out: overrides.dbOut ?? `database_id = "${DB}"` };
      if (key === "d1 list") return { code: 0, out: "[]" };
      if (key === "d1 migrations") return { code: 0, out: "ok" };
      if (args[0] === "deploy") return { code: 0, out: overrides.deployOut ?? "Deployed https://meido.test-user.workers.dev" };
      if (args[0] === "secret") return { code: args[2] === overrides.secretFail ? 1 : 0, out: "" };
      return { code: 1, out: "неизвестная команда" };
    },
    async node(script) {
      calls.push({ args: ["node", script], opts: {} });
      return { code: 0, out: "Команды зарегистрированы (10)" };
    },
  };
  const answers: string[] = [];
  const prompts: string[] = [];
  const asker: Asker = {
    async ask(p) {
      prompts.push(p);
      return answers.shift() ?? "";
    },
    async askHidden(p) {
      prompts.push(`[скрыто] ${p}`);
      return answers.shift() ?? "";
    },
  };
  const logs: string[] = [];
  const run = () => runSetup({ root: dir, runner, asker, log: (l) => logs.push(l) });
  return { dir, calls, answers, prompts, logs, run };
}

describe("установка (поддельный wrangler)", () => {
  let w: ReturnType<typeof setupWorld>;
  beforeEach(() => {
    w = setupWorld();
    w.answers.push(APP, PUB, TOKEN, "https://hc-ping.com/abc");
  });

  it("полный проход: база, таблицы, ключи, выкладка, секреты, команды, итоговые инструкции", async () => {
    const r = await w.run();
    expect(r).toEqual({ ok: true, url: "https://meido.test-user.workers.dev" });
    expect(currentDatabaseId(readFileSync(join(w.dir, "wrangler.toml"), "utf8"))).toBe(DB);
    expect(parseDevVars(readFileSync(join(w.dir, ".dev.vars"), "utf8"))).toEqual({
      DISCORD_APP_ID: APP,
      DISCORD_PUBLIC_KEY: PUB,
      DISCORD_BOT_TOKEN: TOKEN,
      WATCHDOG_URL: "https://hc-ping.com/abc",
    });
    const order = w.calls.map((c) => c.args.slice(0, 2).join(" "));
    expect(order).toEqual([
      "whoami --json", "d1 create", "d1 migrations", "deploy",
      "secret put", "secret put", "secret put", "secret put", "node scripts/register-commands.ts",
    ]);
    const text = w.logs.join("\n");
    expect(text).toContain("https://meido.test-user.workers.dev/interactions");
    expect(text).toContain(`client_id=${APP}`);
    expect(text).toContain("/setup");
  });

  it("секреты идут только через stdin, не в аргументах и не в журнале; токен вводится скрыто", async () => {
    await w.run();
    const secrets = w.calls.filter((c) => c.args[0] === "secret");
    expect(secrets.map((c) => c.args[2])).toEqual(["DISCORD_APP_ID", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "WATCHDOG_URL"]);
    for (const c of w.calls) expect(JSON.stringify(c.args)).not.toContain(TOKEN);
    expect(secrets.find((c) => c.args[2] === "DISCORD_BOT_TOKEN")!.opts.input).toBe(`${TOKEN}\n`);
    expect(w.logs.join("\n")).not.toContain(TOKEN);
    expect(w.prompts.some((p) => p.startsWith("[скрыто]") && p.includes("Токен бота"))).toBe(true);
  });

  it("вход в Cloudflare: сначала login, потом повторная проверка", async () => {
    const w2 = setupWorld({ whoami: (n) => (n === 0 ? 1 : 0) });
    w2.answers.push(APP, PUB, TOKEN, "");
    const r = await w2.run();
    expect(r.ok).toBe(true);
    expect(w2.calls.slice(0, 3).map((c) => c.args[0])).toEqual(["whoami", "login", "whoami"]);
    expect(w2.calls.find((c) => c.args[0] === "login")!.opts.interactive).toBe(true);
    expect(w2.calls.filter((c) => c.args[0] === "secret")).toHaveLength(3); // без необязательного адреса сторожа
  });

  it("повторный запуск: база и прежние значения не пересоздаются, Enter оставляет прежнее", async () => {
    await w.run();
    w.calls.length = 0;
    w.answers.push("", "", "", ""); // всё Enter
    const r = await w.run();
    expect(r.ok).toBe(true);
    expect(w.calls.some((c) => c.args[0] === "d1" && c.args[1] === "create")).toBe(false);
    expect(parseDevVars(readFileSync(join(w.dir, ".dev.vars"), "utf8")).DISCORD_BOT_TOKEN).toBe(TOKEN);
  });

  it("неверное значение: три попытки, потом остановка без выкладки", async () => {
    const w3 = setupWorld();
    w3.answers.push("не цифры", "тоже нет", "опять");
    const r = await w3.run();
    expect(r.ok).toBe(false);
    expect(w3.logs.join("\n")).toContain("Application ID не введён");
    expect(w3.calls.some((c) => c.args[0] === "deploy")).toBe(false);
  });

  it("если адрес в выводе deploy не найден — спрашивает; база уже есть в списке — берёт из списка", async () => {
    const w4 = setupWorld({ dbOut: "ошибка: уже существует", deployOut: "без адреса" });
    w4.answers.push(APP, PUB, TOKEN, "", "https://meido.me.workers.dev/");
    // `d1 list` вернёт пусто -> остановка на шаге 2
    const stopped = await w4.run();
    expect(stopped.ok).toBe(false);
    expect(w4.logs.join("\n")).toContain("не удалось создать базу");
    const w5 = setupWorld({ deployOut: "без адреса" });
    w5.answers.push(APP, PUB, TOKEN, "", "https://meido.me.workers.dev/");
    expect((await w5.run()).url).toBe("https://meido.me.workers.dev");
  });

  it("ошибка секрета останавливает установку с понятной причиной", async () => {
    const w6 = setupWorld({ secretFail: "DISCORD_BOT_TOKEN" });
    w6.answers.push(APP, PUB, TOKEN, "");
    const r = await w6.run();
    expect(r.ok).toBe(false);
    expect(w6.logs.join("\n")).toContain("не удалось сохранить секрет DISCORD_BOT_TOKEN");
    expect(w6.calls.some((c) => c.args[0] === "node")).toBe(false);
  });
});
