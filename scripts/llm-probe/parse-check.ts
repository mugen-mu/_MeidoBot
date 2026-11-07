// Прогон обычного разбора по 20 фразам (без модели).
import { readFileSync } from "node:fs";
import { parseInput } from "../../src/time/parse.ts";
const d = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));
const now = Date.parse(d.now);
for (const x of d.tasks) {
  const p = parseInput(x.t, { now, tz: d.tz });
  console.log(`${p.due===null?"—":new Date(p.due).toISOString()} rec=${p.recipe?"Y":"n"} | ${x.t} => «${p.title}»`);
}
