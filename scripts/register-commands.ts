// Регистрация команд бота в Discord (глобально; обновление занимает до часа, обычно секунды).
// Запуск: npm run register. Значения DISCORD_APP_ID и DISCORD_BOT_TOKEN берутся из окружения или из .dev.vars.
import { existsSync, readFileSync } from "node:fs";
import { COMMANDS } from "../src/discord/commands.ts";

function fromDevVars(): Record<string, string> {
  if (!existsSync(".dev.vars")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const vars = { ...fromDevVars(), ...process.env };
const appId = vars.DISCORD_APP_ID;
const token = vars.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error("Нужны DISCORD_APP_ID и DISCORD_BOT_TOKEN (в окружении или в файле .dev.vars).");
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(COMMANDS),
});
if (!res.ok) {
  console.error(`Discord ответил ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const list = (await res.json()) as { name: string }[];
console.log(`Команды зарегистрированы (${list.length}): ${list.map((c) => c.name).join(", ")}`);
