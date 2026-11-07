// Чистка уже загруженного пула фраз: обращение → {user}, ручные замены (src/personality/poolCleanup.ts).
// Запуск: node scripts/clean-phrases.ts [--write]. Без --write — только сводка. Повторный запуск безопасен.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED } from "../src/personality/phrases.generated.ts";
import { cleanupPool } from "../src/personality/poolCleanup.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { pool, report } = cleanupPool(GENERATED);
console.log(`Обращений заменено на {user}: ${report.addressReplaced}; ручных замен выполнено: ${report.fixesApplied}`);
for (const f of report.fixesStale) console.log(`  правка не нашла фразу: ${f.mood}/${f.situation} «${f.from}»`);
if (process.argv.includes("--write")) {
  const body =
    `// Пул фраз из Gemini после проверки (scripts/import-phrases.ts) и чистки (src/personality/poolCleanup.ts).\n` +
    `// Файл создаётся скриптом — руками не править: ручные правки — в poolCleanup.ts, свои фразы — в phrases.base.ts.\n` +
    `import type { Phrases } from "./phrases.ts";\n\n` +
    `export const GENERATED: Phrases = ${JSON.stringify(pool, null, 2)};\n`;
  writeFileSync(join(root, "src/personality/phrases.generated.ts"), body.replace(/\n/g, "\r\n"), "utf8");
  console.log("Записано: src/personality/phrases.generated.ts");
}
