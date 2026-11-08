// Проба качества живых реплик: node scripts/llm-probe/lines.ts [проходов]
// Нужен запущенный временный Worker пробы: npm run wrangler -- dev --remote --port 8788 -c scripts/llm-probe/wrangler.toml
// База не трогается: только вызовы Workers AI. Результат — таблица в консоль и results/lines.json.
import { writeFileSync } from "node:fs";
import { type LineRequest, buildLinePrompt, cleanLine, pickAngle, pickLength } from "../../src/personality/liveLines.ts";
import { LLM_MODEL } from "../../src/llm.ts";

const passes = Number(process.argv[2] ?? 1);
const INTERESTS = ["аниме"];

const base = { level: 3 as const, hour: 18, weekday: 3 };
const S: Partial<LineRequest>[] = [
  { mood: "tired", situation: "reminder", task: "Оплатить интернет", address: "хозяин" },
  { mood: "tsundere", situation: "reminder_repeat", task: "Позвонить маме", address: "х-хозяин", missStreak: 0 },
  { mood: "yandere", situation: "missed", task: "Вынести мусор", address: "аната", missStreak: 4 },
  { mood: "sulking", situation: "missed", task: "Отправить отчёт", address: null, missStreak: 2 },
  { mood: "proud", situation: "done", task: "Записаться к парикмахеру", address: "госюдзин-сама", doneStreak: 4 },
  { mood: "tired", situation: "done_late", task: "Купить хлеб", address: "хозяин" },
  { mood: "yandere", situation: "recorded", task: "Забрать посылку", address: "госюдзин-сама~" },
  { mood: "tsundere", situation: "summary_morning", address: "хозяин", facts: "на сегодня 3 дела, одно из них просрочено со вчера" },
  { mood: "sleepy", situation: "reminder", task: "Выпить воду", address: "хозяин", hour: 1 },
  { mood: "sulking", situation: "return_after_pause", address: "хозяин" },
  { mood: "tired", situation: "empty_list", address: "хозяин", facts: "список дел пуст" },
  { mood: "proud", situation: "streak_praise", address: "госюдзин-сама", doneStreak: 7 },
  { mood: "tsundere", situation: "summary_evening", address: "хозяин", facts: "сегодня выполнено 5 дел из 6" },
  { mood: "yandere", situation: "holiday", address: "хозяин", occasion: "Новый год" },
  { mood: "tired", situation: "thanks", address: "хозяин" },
];

async function call(messages: unknown[], max_tokens: number, temperature: number) {
  const body = { model: LLM_MODEL, messages, max_tokens, temperature, extra: { chat_template_kwargs: { enable_thinking: false } } };
  const r = (await fetch("http://127.0.0.1:8788", { method: "POST", body: JSON.stringify(body) }).then((x) => x.json())) as any;
  const m = r.out?.choices?.[0]?.message;
  return { ok: r.ok as boolean, ms: r.ms as number, text: String(m?.content ?? "").trim(), neurons: Number(r.out?.usage?.neurons ?? NaN), error: r.error };
}

const res: unknown[] = [];
let sumN = 0, nN = 0, sumMs = 0, bad = 0, total = 0;
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
for (let p = 0; p < passes; p++) {
  for (const s of S) {
    const r = { ...base, ...s, length: pickLength(rand), angle: pickAngle(rand), interests: rand() < 0.3 ? INTERESTS : [], noLead: rand() < 0.7, jaMax: rand() < 0.5 ? 1 : 2, action: rand() < 0.33 } as LineRequest;
    const out = await call([{ role: "system", content: buildLinePrompt(r) }, { role: "user", content: "Реплика:" }], r.length === "long" ? 110 : 70, 1.0);
    const line = out.ok ? cleanLine(out.text, r) : null;
    total++;
    if (!line) bad++;
    if (Number.isFinite(out.neurons)) { sumN += out.neurons; nN++; }
    sumMs += out.ms ?? 0;
    res.push({ mood: r.mood, situation: r.situation, length: r.length, angle: r.angle, ms: out.ms, neurons: out.neurons, raw: out.text, line, error: out.error });
    console.log(`[${r.mood}/${r.situation}/${r.length}] ${out.ms}мс ${out.neurons}н ${line ? "OK " : "БРАК"} ${line ?? out.text}`);
  }
}
console.log(`\nвызовов ${total}, брак ${bad}, среднее ${(sumMs / total).toFixed(0)} мс, нейронов в среднем ${(sumN / Math.max(1, nN)).toFixed(2)}`);
writeFileSync(new URL("./results/lines.json", import.meta.url), JSON.stringify(res, null, 1));
