// Подготовка загрузки прошлых отметок Ihor из анкеты вкусов в таблицу `anime` (2026-11-18). К базе не обращается: только читает файлы и пишет SQL.
// Запуск: node scripts/import-taste-marks.ts [--data <папка с wave1 и wave3>] [--now <мс>]
//   читает <data>/wave1/lists/*.json, <data>/wave3/lists/*.json и <data>/wave5/lists/*.json (личное, в git не попадает) и названия из design/taste/titles.json, design/taste/w3/titles.json, design/taste/w5/titles.json;
//   пишет <data>/import-anime.sql и печатает сводку. Применение к настоящей базе — только по слову владельца (см. docs в отчёте / LIVE-CHECKS.md).
// По умолчанию <data> — data/taste в корне проекта; из рабочей копии (worktree) укажите --data D:/_MeidoBot/data/taste.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type TasteList, buildRows, collectTitles, renderSql, summarize } from "./lib/tasteMarks.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const data = resolve(arg("--data") ?? join(root, "data", "taste"));
const now = arg("--now") ? Number(arg("--now")) : Date.now();
if (!Number.isFinite(now) || now <= 0) {
  console.error("--now: нужно число (мс от 1970 года).");
  process.exit(1);
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

const lists: TasteList[] = [];
for (const wave of ["wave1", "wave3", "wave5"]) {
  const dir = join(data, wave, "lists");
  if (!existsSync(dir)) {
    console.error(`Не нашла ${dir}. Укажите папку с ответами анкеты: --data <папка с wave1, wave3 и wave5>.`);
    process.exit(1);
  }
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) lists.push(readJson(join(dir, f)) as TasteList);
}

const pages = [join(root, "design", "taste", "titles.json"), join(root, "design", "taste", "w3", "titles.json"), join(root, "design", "taste", "w5", "titles.json")].filter(existsSync).map(readJson);
const report = buildRows(lists, collectTitles(pages));
const out = join(data, "import-anime.sql");
writeFileSync(out, renderSql(report.rows, now), "utf8");
for (const line of summarize(report)) console.log(line);
console.log(`\nSQL записан: ${out} (${report.rows.length} вставок, в базу ничего не отправлено).`);
