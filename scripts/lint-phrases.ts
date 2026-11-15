// Проверка файлов фраз пакета «оживление» (2026-11-15): правила poolCheck.ts + «сколько ещё не хватает до нормы» (poolSpec.ts).
// Запуск:
//   node scripts/lint-phrases.ts <группа>           проверить одну группу (persona.playful, persona.prim, persona.bright, weight, rain, polish.tired, polish.tsundere, polish.proud)
//   node scripts/lint-phrases.ts all                все группы
//   node scripts/lint-phrases.ts --show <голос> <ситуация>   показать ИТОГОВЫЙ пул (старые + новые), чтобы не повторять уже сказанное
//   добавьте -v, чтобы увидеть и предупреждения (warn), не только ошибки
// Код выхода 1, если есть ошибки, нехватка фраз до нормы, повторы или лишние голоса/ситуации в файле группы.
import { ADDITION_GROUPS, PHRASES, PHRASES_BASE, type Situation } from "../src/personality/phrases.ts";
import { lintPhrase } from "../src/personality/poolCheck.ts";
import { GROUP_SPEC } from "../src/personality/poolSpec.ts";

const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
const args = process.argv.slice(2);
const verbose = args.includes("-v");
const rest = args.filter((a) => a !== "-v");

if (rest[0] === "--show") {
  const [, voice, sit] = rest;
  const list = PHRASES[voice]?.[sit as Situation] ?? [];
  const base = new Set((PHRASES_BASE[voice]?.[sit as Situation] ?? []).map(norm));
  console.log(`${voice}.${sit}: ${list.length} фраз (из них новых: ${list.filter((t) => !base.has(norm(t))).length})`);
  list.forEach((t, i) => console.log(`${String(i + 1).padStart(3)}. ${base.has(norm(t)) ? " " : "+"} ${t}`));
  process.exit(0);
}

const names = rest[0] === "all" ? Object.keys(ADDITION_GROUPS) : rest.filter((a) => a in ADDITION_GROUPS);
if (names.length === 0) {
  console.log(`Укажите группу: ${Object.keys(ADDITION_GROUPS).join(", ")} или all. Или: --show <голос> <ситуация>`);
  process.exit(2);
}

let failed = false;
for (const name of names) {
  const data = ADDITION_GROUPS[name];
  const spec = GROUP_SPEC[name];
  const errors: string[] = [];
  const warns: string[] = [];
  const deficits: string[] = [];
  let total = 0;

  for (const [voice, sits] of Object.entries(data)) {
    if (!spec[voice]) {
      errors.push(`лишний голос «${voice}» в файле группы ${name} (ожидаются: ${Object.keys(spec).join(", ")})`);
      continue;
    }
    // повторы внутри голоса: между собой и со старыми фразами этого голоса (в любых ситуациях)
    const seen = new Map<string, string>();
    for (const [s, list] of Object.entries(PHRASES_BASE[voice] ?? {})) for (const t of list ?? []) seen.set(norm(t), `старая ${voice}.${s}`);
    for (const [sit, list] of Object.entries(sits) as [Situation, string[]][]) {
      if (!(sit in spec[voice])) {
        errors.push(`лишняя ситуация ${voice}.${sit} (ожидаются: ${Object.keys(spec[voice]).join(", ")})`);
        continue;
      }
      let tasks = 0;
      let users = 0;
      const starts = new Map<string, number>();
      let actions = 0;
      list.forEach((t, i) => {
        total++;
        const at = `${voice}.${sit}[${i}]`;
        for (const is of lintPhrase(t, voice, sit)) (is.severity === "error" ? errors : warns).push(`${at} ${is.code}: ${is.note} — «${t}»`);
        const k = norm(t);
        if (seen.has(k)) errors.push(`${at} повтор (${seen.get(k)}): «${t}»`);
        seen.set(k, at);
        if (t.includes("{task}")) tasks++;
        if (t.includes("{user}")) users++;
        if (/\*[^*]+\*/.test(t)) actions++;
        const w = /^[^\p{L}]*(\p{L}+)/u.exec(t)?.[1]?.toLowerCase() ?? "";
        starts.set(w, (starts.get(w) ?? 0) + 1);
      });
      if (tasks > Math.max(1, Math.floor(list.length / 3))) errors.push(`${voice}.${sit}: {task} в ${tasks} фразах из ${list.length} (допустимо не больше трети)`);
      if (users > 2) warns.push(`${voice}.${sit}: {user} в ${users} фразах (лучше не больше двух)`);
      if (actions > Math.ceil(list.length * 0.4)) warns.push(`${voice}.${sit}: действий в звёздочках ${actions} из ${list.length} (до 40%)`);
      for (const [w, c] of starts) if (c > 2 && w) warns.push(`${voice}.${sit}: «${w}» начинает ${c} фраз (лучше не больше двух)`);
    }
  }

  for (const [voice, need] of Object.entries(spec)) {
    for (const [sit, min] of Object.entries(need) as [Situation, number][]) {
      const have = PHRASES[voice]?.[sit]?.length ?? 0;
      const before = PHRASES_BASE[voice]?.[sit]?.length ?? 0;
      if (have < min) deficits.push(`${voice}.${sit}: сейчас ${have} (было до новых ${before}), нужно минимум ${min} — добавьте ещё ${min - have}`);
    }
  }

  console.log(`\n=== ${name}: новых фраз в файле ${total}`);
  for (const e of errors) console.log(`  ОШИБКА  ${e}`);
  for (const d of deficits) console.log(`  МАЛО    ${d}`);
  if (verbose) for (const w of warns) console.log(`  warn    ${w}`);
  else if (warns.length) console.log(`  (предупреждений: ${warns.length}; -v — показать)`);
  if (!errors.length && !deficits.length) console.log("  ок");
  if (errors.length || deficits.length) failed = true;
}
process.exit(failed ? 1 : 0);
