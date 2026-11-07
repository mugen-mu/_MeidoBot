// Прогон моделей: node run.mjs <modelId> [tasks|replies|both]. Результат — results/<модель>.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const d = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));
const model = process.argv[2];
const part = process.argv[3] ?? "both";
const NOTHINK = !/llama|mistral|sea-lion/.test(model);
async function call(messages, max_tokens, temperature) {
  const body = { model, messages, max_tokens, temperature, extra: NOTHINK ? { chat_template_kwargs: { enable_thinking: false } } : undefined };
  for (let k = 0; k < 2; k++) {
    const r = await fetch("http://127.0.0.1:8788", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json()).catch((e) => ({ ok: false, ms: 0, error: String(e) }));
    if (r.ok || k) {
      const m = r.out?.choices?.[0]?.message;
      return { ok: r.ok, ms: r.ms, text: (m?.content ?? "").trim(), error: r.error, usage: r.out?.usage };
    }
  }
}
const SYS_TASK = `Ты разбираешь короткие русские заметки о делах для бота-напоминалки. Сегодня суббота, 7 ноября 2026, 12:00.
Верни ТОЛЬКО JSON без пояснений и без форматирования: {"title": "...", "when_text": "...", "repeat": "..."}
title — суть дела с большой буквы, без слов о времени.
when_text — время первого срабатывания простой русской фразой вида «завтра в 9:00», «14 ноября в 14:00», «через 2 дня», «в понедельник в 9:00»; если времени нет — null. Слова «утром» = 9:00, «в обед» = 13:00, «после обеда» = 14:00, «вечером» = 19:00, если время не названо.
repeat — если дело повторяется, фраза вида «каждый понедельник в 9:00», «каждый день в 22:30», «раз в месяц 1 числа в 9:00»; иначе null.`;
const MOOD = {
  tired: "усталая, сухая, ворчливая; вздохи, жалобы на сверхурочные, мечты о чае",
  tsundere: "цундере: «я не переживаю!», притворно холодная, но на самом деле заботится",
  sleepy: "ночь, сонная: зевает, путается в словах, но всё равно работает",
};
const SYS_ISO = `Ты разбираешь короткие русские заметки о делах для бота-напоминалки. Сейчас суббота, 2026-11-07 12:00 (Киев).
Верни ТОЛЬКО JSON без пояснений: {"title": "...", "when_iso": "...", "repeat": "..."}
title — суть дела с большой буквы, без слов о времени. when_iso — время первого срабатывания в виде 2026-11-14T14:00 или null, если времени нет. Если время суток не названо — 09:00; «утром» 09:00, «в обед» 13:00, «после обеда» 14:00, «вечером» 19:00. repeat — если дело повторяется, фраза вида «каждый понедельник в 9:00», иначе null.`;
const out = { model, tasks: [], replies: [], iso: [] };
if (part === "iso") { for (const x of d.tasks) out.iso.push({ input: x.t, ...(await call([{ role: "system", content: SYS_ISO }, { role: "user", content: x.t }], 200, 0.1)) }); }
if (part === "both" || part === "tasks") for (const x of d.tasks) out.tasks.push({ input: x.t, ...(await call([{ role: "system", content: SYS_TASK }, { role: "user", content: x.t }], 200, 0.1)) });
if (part === "both" || part === "replies") for (const mood of d.moods) for (const s of d.situations) {
  const sys = `Ты — Хару, аниме-горничная и личный бот-напоминалка. Настроение сейчас: ${MOOD[mood]}. Обращайся к хозяину на «вы». Напиши ОДНУ короткую реплику (до 15 слов) по-русски, только на русском, без английских слов и без эмодзи. Можно одно действие в звёздочках. Не называй само дело и время: их бот добавит сам. Никаких угроз и давления. Верни только реплику.`;
  out.replies.push({ mood, situation: s, ...(await call([{ role: "system", content: sys }, { role: "user", content: `Ситуация: ${s}` }], 80, 0.8)) });
}
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const f = new URL(`./results/${model.split("/").pop()}.json`, import.meta.url);
if (part === "iso") { const g = new URL(`./results/${model.split("/").pop()}.json`, import.meta.url); const prev = JSON.parse(readFileSync(g, "utf8")); prev.iso = out.iso; writeFileSync(g, JSON.stringify(prev, null, 1)); console.log(model, "iso done", out.iso.reduce((a, r) => a + (r.usage?.neurons ?? 0), 0).toFixed(1)); process.exit(0); }
writeFileSync(f, JSON.stringify(out, null, 1));
const all = [...out.tasks, ...out.replies];
const neurons = all.reduce((a, r) => a + (r.usage?.neurons ?? 0), 0);
const ms = all.map((r) => r.ms).sort((a, b) => a - b);
console.log(model, "calls", all.length, "ok", all.filter((r) => r.ok).length, "neurons", neurons.toFixed(1), "median ms", ms[ms.length >> 1], "max", ms.at(-1));
