import { readFileSync, readdirSync } from "node:fs";
for (const f of readdirSync("results")) { const r = JSON.parse(readFileSync("results/" + f, "utf8")); console.log("## " + r.model);
 r.replies.forEach((p, i) => { if (i % 10 < 4 || (i%10==7)) console.log(`${p.mood[0]}${i%10}`, p.text.replace(/\n/g, " ")); }); }
