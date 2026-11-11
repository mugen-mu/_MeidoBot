// Установка одним действием: вход в Cloudflare, база, миграции, секреты, выкладка, регистрация команд.
// Можно запускать повторно: уже сделанное не ломается. Секреты уходят только через stdin, в журнал не печатаются.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentDatabaseId,
  extractDatabaseId,
  extractWorkerUrl,
  findDatabaseId,
  installLinks,
  isAppId,
  isBotToken,
  isPublicKey,
  isWatchdogUrl,
  isWorkEmail,
  parseDevVars,
  parseWhoami,
  setDatabaseId,
  upsertDevVars,
} from "./helpers.ts";
import type { Asker, Runner } from "./runner.ts";

export interface SetupDeps {
  root: string;
  runner: Runner;
  asker: Asker;
  log: (line: string) => void;
}

export interface SetupResult {
  ok: boolean;
  url?: string;
}

const STEPS = 7;

export async function runSetup(d: SetupDeps): Promise<SetupResult> {
  const { root, runner, asker, log } = d;
  const tomlPath = join(root, "wrangler.toml");
  const varsPath = join(root, ".dev.vars");
  let step = 0;
  const head = (t: string) => log(`\nШаг ${++step} из ${STEPS}. ${t}`);
  const stop = (why: string): SetupResult => {
    log(`\nОстановлено на шаге ${step}: ${why}`);
    log("Запустите setup.cmd ещё раз: уже сделанное повторно не сломается.");
    return { ok: false };
  };

  // 1. Cloudflare
  head("Вход в Cloudflare");
  let who = await runner.wrangler(["whoami", "--json"], { quiet: true });
  if (who.code !== 0) {
    log("Сейчас откроется браузер: войдите в свой личный аккаунт Cloudflare и нажмите «Allow».");
    const l = await runner.wrangler(["login"], { interactive: true });
    who = await runner.wrangler(["whoami", "--json"], { quiet: true });
    if (l.code !== 0 || who.code !== 0) return stop("вход в Cloudflare не выполнен.");
  }
  // Бот — только на личном аккаунте. Вход здесь отдельный (см. wranglerEnv), но проверяем, кто именно вошёл.
  const email = parseWhoami(who.out).email;
  if (isWorkEmail(email)) {
    await runner.wrangler(["logout"], { quiet: true });
    log(`Вы вошли как ${email}: это рабочий аккаунт. Бот должен жить на личном аккаунте Cloudflare.`);
    return stop("вход выполнен рабочим аккаунтом (я его отключил). В браузере откройте личный аккаунт Cloudflare и запустите установку снова.");
  }
  log(`Вы вошли как ${email ?? "(почта не определена)"}.`);
  const mine = await asker.ask("Это ваш ЛИЧНЫЙ аккаунт Cloudflare? Enter — да, n — войти другим аккаунтом: ");
  if (/^\s*(n|no|н|нет)/i.test(mine)) {
    await runner.wrangler(["logout"], { quiet: true });
    return stop("вы вышли из этого аккаунта. Откройте в браузере нужный (личный) аккаунт Cloudflare и запустите установку снова.");
  }
  log("Вход выполнен.");

  // 2. База
  head("База данных D1");
  let toml = readFileSync(tomlPath, "utf8");
  let dbId = currentDatabaseId(toml);
  if (dbId) log("База уже подключена, пропускаю.");
  else {
    const c = await runner.wrangler(["d1", "create", "meido", "--location", "eeur"], { quiet: true });
    dbId = extractDatabaseId(c.out);
    if (!dbId) {
      const list = await runner.wrangler(["d1", "list", "--json"], { quiet: true });
      dbId = findDatabaseId(list.out, "meido");
    }
    if (!dbId) return stop(`не удалось создать базу.\n${c.out.trim().slice(0, 400)}`);
    toml = setDatabaseId(toml, dbId);
    writeFileSync(tomlPath, toml, "utf8");
    log("База «meido» создана и записана в wrangler.toml.");
  }

  // 3. Миграции
  head("Таблицы в базе");
  const m = await runner.wrangler(["d1", "migrations", "apply", "meido", "--remote"], {});
  if (m.code !== 0) return stop("не удалось создать таблицы (см. сообщение выше).");

  // 4. Ключи
  head("Ключи из Discord Developer Portal");
  const existing = existsSync(varsPath) ? parseDevVars(readFileSync(varsPath, "utf8")) : {};
  const get = async (
    name: string,
    label: string,
    ok: (s: string) => boolean,
    o: { hidden?: boolean; optional?: boolean } = {},
  ): Promise<string | null> => {
    const keep = existing[name];
    for (let attempt = 0; attempt < 3; attempt++) {
      const hint = keep ? " (Enter — оставить прежнее)" : o.optional ? " (Enter — пропустить)" : "";
      const prompt = `${label}${hint}: `;
      const v = o.hidden ? await asker.askHidden(prompt) : await asker.ask(prompt);
      if (v === "") {
        if (keep) return keep;
        if (o.optional) return "";
      } else if (ok(v)) return v.trim();
      log("Не похоже на правильное значение. Скопируйте его ещё раз из Developer Portal.");
    }
    return null;
  };
  const appId = await get("DISCORD_APP_ID", "Application ID (17–20 цифр, General Information)", isAppId);
  if (appId === null) return stop("Application ID не введён.");
  const publicKey = await get("DISCORD_PUBLIC_KEY", "Public Key (64 символа, General Information)", isPublicKey);
  if (publicKey === null) return stop("Public Key не введён.");
  const token = await get("DISCORD_BOT_TOKEN", "Токен бота (вкладка Bot → Reset Token; при вводе не виден)", isBotToken, { hidden: true });
  if (token === null) return stop("токен бота не введён.");
  const watchdog = await get("WATCHDOG_URL", "Адрес проверки healthchecks.io (необязательно, можно позже)", isWatchdogUrl, { optional: true });
  if (watchdog === null) return stop("адрес healthchecks.io не распознан.");
  const entries: Record<string, string> = { DISCORD_APP_ID: appId, DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: token };
  if (watchdog) entries.WATCHDOG_URL = watchdog;
  writeFileSync(varsPath, upsertDevVars(existsSync(varsPath) ? readFileSync(varsPath, "utf8") : "", entries), "utf8");
  log("Значения сохранены в файле .dev.vars (только на этом компьютере, в git не попадает).");

  // 5. Выкладка
  head("Выкладка бота в Cloudflare");
  const dep = await runner.wrangler(["deploy"], { interactive: true, capture: true });
  if (dep.code !== 0) return stop("выкладка не удалась (см. сообщение выше).");
  let url = extractWorkerUrl(dep.out);
  if (!url) {
    url = (await asker.ask("Не нашёл адрес бота в ответе. Вставьте адрес вида https://meido.….workers.dev: ")).replace(/\/+$/, "");
    if (!/^https:\/\/\S+$/.test(url)) return stop("адрес бота не получен.");
  }

  // 6. Секреты
  head("Секреты Worker");
  for (const [name, value] of Object.entries(entries)) {
    const r = await runner.wrangler(["secret", "put", name], { input: `${value}\n`, quiet: true });
    if (r.code !== 0) return stop(`не удалось сохранить секрет ${name}.`);
    log(`  ${name}: сохранён.`);
  }

  // 7. Команды
  head("Команды в Discord");
  const reg = await runner.node("scripts/register-commands.ts", []);
  if (reg.code !== 0) return stop("регистрация команд не удалась (проверьте токен и Application ID).");

  const links = installLinks(appId);
  log("\nГотово. Осталось три действия в Discord:");
  log(`1) Developer Portal → ваше приложение → General Information → Interactions Endpoint URL: вставьте\n   ${url}/interactions\n   и нажмите Save Changes (Discord проверит адрес; ошибка значит, что Public Key введён неверно).`);
  log(`2) Добавьте бота на свой сервер по ссылке:\n   ${links.server}`);
  log(`   и (по желанию) на свой аккаунт, чтобы команды работали в любом чате:\n   ${links.user}`);
  log("3) На своём сервере выполните команду /setup — бот заведёт каналы «почта» и «бот».");
  log("Проверка состояния в любой момент: npm run status");
  return { ok: true, url };
}
