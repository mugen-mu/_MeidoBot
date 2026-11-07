// Копия всей базы в файл (дела, настройки, журнал). Запуск: npm run export. Файл — в backups/ (в git не попадает).
import { mkdirSync } from "node:fs";
import { realRunner } from "./lib/runner.ts";

mkdirSync("backups", { recursive: true });
const d = new Date();
const name = `backups/meido-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.sql`;
const r = await realRunner().wrangler(["d1", "export", "meido", "--remote", "--output", name, "--skip-confirmation"], {});
if (r.code !== 0) {
  console.error("Не удалось сделать копию. Выполнена ли установка (setup.cmd: вход в Cloudflare)?");
  process.exit(1);
}
console.log(`Копия сохранена: ${name}. Хранить в надёжном месте: в ней ваши дела.`);
