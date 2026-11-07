// Загрузка пула фраз из Gemini: достаёт итоговый JSON из текстовых файлов, проверяет по правилам, пишет данные для бота.
// Запуск: node scripts/import-phrases.ts <папка с tired.txt, tsundere.txt, …> [--write]
//   без --write — только сводка; с --write — ещё src/personality/phrases.generated.ts и docs/personality/phrase-pool-report.md.
// Файлы Gemini — «стенограмма»: черновики, код проверки на Python, пояснения и в конце готовый JSON.
// Берём ПОСЛЕДНИЙ объект вида {"mood": …, "phrases": {…}}, который разбирается как JSON.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupPool } from "../src/personality/poolCleanup.ts";
import { type Issue, type MoodData, POOL_SITUATIONS, checkMood } from "../src/personality/poolCheck.ts";

const MOODS = ["tired", "tsundere", "yandere", "sulking", "proud", "sleepy"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Конец JSON-объекта, начавшегося с `{` в позиции start (с учётом строк и экранирования), или -1. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export function extractLastJson(text: string): { data: MoodData | null; candidates: number; note: string } {
  const re = /\{\s*"mood"\s*:/g;
  let m: RegExpExecArray | null;
  let found: MoodData | null = null;
  let candidates = 0;
  let note = "JSON не найден";
  while ((m = re.exec(text))) {
    const end = matchBrace(text, m.index);
    if (end < 0) {
      note = "последний объект обрезан (нет закрывающей скобки)";
      continue;
    }
    const chunk = text.slice(m.index, end + 1);
    for (const attempt of [chunk, chunk.replace(/,(\s*[\]}])/g, "$1")]) {
      try {
        const obj = JSON.parse(attempt);
        if (obj && typeof obj.mood === "string" && obj.phrases && typeof obj.phrases === "object") {
          found = obj as MoodData;
          candidates++;
          note = "ок";
        }
        break;
      } catch (e) {
        note = `JSON не разобрался: ${(e as Error).message.slice(0, 60)}`;
      }
    }
  }
  return { data: found, candidates, note };
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  const write = args.includes("--write");
  // --show=код,код — показать фразы с этими замечаниями (например, --show=serious,threat,jp-word)
  const show = (args.find((a) => a.startsWith("--show="))?.slice(7) ?? "").split(",").filter(Boolean);
  if (!dir) {
    console.error("Укажите папку с файлами Gemini: node scripts/import-phrases.ts <папка> [--write]");
    process.exit(2);
  }
  const generated: Record<string, Record<string, string[]>> = {};
  const report: string[] = [];
  const allIssues: Record<string, Issue[]> = {};
  const globalSeen = new Map<string, string>();
  let crossDup = 0;
  const table: string[] = [];

  for (const mood of MOODS) {
    const file = [".json", ".txt"].map((e) => join(dir, mood + e)).find(existsSync);
    if (!file) {
      table.push(`${mood.padEnd(9)} нет файла`);
      continue;
    }
    const { data, candidates, note } = extractLastJson(readFileSync(file, "utf8"));
    if (!data) {
      table.push(`${mood.padEnd(9)} ${note}`);
      continue;
    }
    if (data.mood !== mood) report.push(`${mood}: внутри файла mood="${data.mood}" — не то настроение, файл пропущен`);
    if (data.mood !== mood) continue;
    const res = checkMood(data);
    allIssues[mood] = res.issues;
    for (const i of res.issues) if (i.idx >= 0 && show.includes(i.code)) console.log(`  ${mood}/${i.sit}/${i.code}: ${i.text.slice(0, 130)}`);
    const errors = res.issues.filter((i) => i.severity === "error");
    const warns = res.issues.filter((i) => i.severity === "warn");
    const kept = POOL_SITUATIONS.reduce((n, s) => n + res.kept[s].length, 0);
    const byCode: Record<string, number> = {};
    for (const i of res.issues) byCode[`${i.severity === "error" ? "!" : "?"}${i.code}`] = (byCode[`${i.severity === "error" ? "!" : "?"}${i.code}`] ?? 0) + 1;
    table.push(
      `${mood.padEnd(9)} JSON(${candidates} кандидатов, взят последний): оставлено ${kept}/100; отброшено ${errors.filter((e) => e.idx >= 0).length}; замечаний ${warns.length}. ` +
        Object.entries(byCode).map(([k, v]) => `${k}×${v}`).join(" "),
    );
    generated[mood] = res.kept;
    for (const s of POOL_SITUATIONS)
      for (const t of res.kept[s]) {
        const k = t.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
        const prev = globalSeen.get(k);
        if (prev && prev !== mood) crossDup++;
        else globalSeen.set(k, mood);
      }
  }
  console.log(table.join("\n"));
  if (crossDup) console.log(`Повторы между настроениями: ${crossDup}`);
  for (const r of report) console.log(r);

  if (!write) return;
  // чистка поверх проверки: обращение → {user}, ручные замены (poolCleanup.ts); так повторная загрузка не откатывает правки
  const cleaned = cleanupPool(generated);
  console.log(`Чистка: обращений заменено ${cleaned.report.addressReplaced}, ручных замен ${cleaned.report.fixesApplied}`);
  for (const f of cleaned.report.fixesStale) console.log(`  правка не нашла фразу (пул изменился): ${f.mood}/${f.situation} «${f.from}»`);
  const body =
    `// Пул фраз из Gemini после проверки (scripts/import-phrases.ts) и чистки (poolCleanup.ts). Файл создаётся скриптом — руками не править:\n` +
    `// пополнять набор лучше в phrases.base.ts, а новый пул загружать скриптом заново.\n` +
    `import type { Phrases } from "./phrases.ts";\n\n` +
    `export const GENERATED: Phrases = ${JSON.stringify(cleaned.pool, null, 2)};\n`;
  writeFileSync(join(root, "src/personality/phrases.generated.ts"), body, "utf8");

  const lines = ["# Отчёт загрузки пула фраз (автоматически, scripts/import-phrases.ts)", "", "```", ...table, "```", ""];
  for (const mood of MOODS) {
    const iss = (allIssues[mood] ?? []).filter((i) => i.severity === "warn" && i.idx >= 0);
    if (!iss.length) continue;
    lines.push(`## ${mood}: замечания к вычитке (фразы оставлены)`, "");
    for (const i of iss.slice(0, 40)) lines.push(`- \`${i.sit}\` ${i.code}: ${i.text.slice(0, 110)}`);
    lines.push("");
  }
  writeFileSync(join(root, "docs/personality/phrase-pool-report.md"), lines.join("\n"), "utf8");
  console.log("Записано: src/personality/phrases.generated.ts, docs/personality/phrase-pool-report.md");
}

if (process.argv[1]?.endsWith("import-phrases.ts")) main();
