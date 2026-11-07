// Разбор результатов: доля валидного JSON, попадание во время, повтор, латиница/длина реплик, сравнение с parseWhen.
import { readFileSync, readdirSync } from "node:fs";
import { parseInput } from "../../src/time/parse.ts";
const d = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));
const now = Date.parse(d.now);
const fmt = (t: number) => new Date(t + 2 * 3600e3).toISOString().slice(0, 16); // Киев зимой UTC+2
const base = d.tasks.map((x: any) => { const p = parseInput(x.t, { now, tz: d.tz }); return p; });
const exp = d.tasks.map((x: any) => x.due ? x.due : null);
function score(p: any, i: number) { // совпадение даты и часа
  const x = d.tasks[i];
  if (x.rep) return { date: p.recipe != null, hour: p.recipe != null };
  if (p.due == null) return { date: false, hour: false };
  const s = fmt(p.due); const okd = (x.alt ?? [x.due.slice(0, 10)]).includes(s.slice(0, 10)); return { date: okd, hour: okd && (x.alt ? true : s.slice(0, 13) === x.due.slice(0, 13)) };
}
const rows: string[] = [];
const b = base.map(score); const bd = b.filter((s: any) => s.date).length, bh = b.filter((s: any) => s.hour).length;
rows.push(`parseWhen (обычный разбор) на целой фразе | дата ${bd}/20 | дата+час ${bh}/20`);
for (const f of readdirSync(new URL("./results/", import.meta.url)).filter((f) => f.endsWith(".json"))) {
  const r = JSON.parse(readFileSync(new URL("./results/" + f, import.meta.url), "utf8"));
  let valid = 0, dateOk = 0, hourOk = 0, repOk = 0, titleLatin = 0; const misses: string[] = [];
  r.tasks.forEach((t: any, i: number) => {
    let j: any = null;
    try { j = JSON.parse(t.text.replace(/^```(?:json)?|```$/g, "").trim()); if (typeof j.title !== "string") j = null; } catch {}
    if (!j) { misses.push(`${i + 1}: не JSON «${t.text.slice(0, 50)}»`); return; }
    valid++;
    const x = d.tasks[i];
    const whenStr = [j.repeat, j.when_text].find((s) => typeof s === "string" && s && s !== "null");
    if ((!!j.repeat && j.repeat !== "null") === x.rep) repOk++;
    const p = parseInput(whenStr ? `${j.title} ${whenStr}` : j.title, { now, tz: d.tz });
    const sc = score(p, i); if (sc.date) dateOk++; else misses.push(`${i + 1}: «${x.t}» → when=${JSON.stringify(j.when_text)} rep=${JSON.stringify(j.repeat)}`); if (sc.hour) hourOk++;
    if (/[A-Za-z]/.test(j.title)) titleLatin++;
  });
  let isoValid = 0, isoDate = 0, isoHour = 0; const isoMiss: string[] = [];
  (r.iso ?? []).forEach((t: any, i: number) => {
    let j: any = null; try { j = JSON.parse(t.text.replace(/^```(?:json)?|```$/g, "").trim()); } catch {}
    if (!j) { isoMiss.push(`${i + 1}: не JSON`); return; } isoValid++;
    const x = d.tasks[i]; const w = typeof j.when_iso === "string" ? j.when_iso : null;
    if (x.rep) { if (j.repeat && j.repeat !== "null") { isoDate++; isoHour++; } else isoMiss.push(`${i + 1}: повтор не найден`); return; }
    if (!w) { isoMiss.push(`${i + 1}: «${x.t}» → null`); return; }
    const okd = (x.alt ?? [x.due.slice(0, 10)]).includes(w.slice(0, 10)); if (okd) isoDate++; else isoMiss.push(`${i + 1}: «${x.t}» → ${w}`);
    if (okd && (x.alt || w.slice(0, 13) === x.due.slice(0, 13))) isoHour++;
  });
  let lat = 0, long = 0, task = 0, star = 0;
  for (const p of r.replies) { if (/[A-Za-z]{2,}/.test(p.text.replace(/\*[^*]*\*/g, (m: string) => m))) lat++; if (p.text.split(/\s+/).length > 22) long++; if (!p.text) star++; }
  const all = [...r.tasks, ...r.replies];
  const neu = all.reduce((a: number, x: any) => a + (x.usage?.neurons ?? 0), 0);
  const ms = all.map((x: any) => x.ms).sort((a: number, b: number) => a - b);
  rows.push(`${r.model} | JSON ${valid}/20 | дата ${dateOk}/20 | дата+час ${hourOk}/20 | repeat ${repOk}/20 | латиница в репликах ${lat}/30 | длинные ${long} | пустые ${star} | ISO: JSON ${isoValid}/20 дата ${isoDate}/20 дата+час ${isoHour}/20 | нейроны ${neu.toFixed(0)} | задержка медиана ${ms[ms.length >> 1]} мс, макс ${ms.at(-1)} мс`);
  if (process.argv[2] === "-v") { rows.push("   промахи: " + misses.join(" || ")); rows.push("   ISO-промахи: " + isoMiss.join(" || ")); } rows.push("   ISO-промахи: " + isoMiss.join(" || "));
}
console.log(rows.join("\n"));
