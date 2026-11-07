// Проверка наборов фраз (правила из docs/gemini-phrase-pool-prompt.md и ТЗ «Характер 2»).
// Чистая логика: её вызывают скрипт загрузки (scripts/import-phrases.ts) и тесты целостности.
// Серьёзность: «error» — фраза отбрасывается, «warn» — остаётся, но попадает в отчёт для вычитки.

export const POOL_SITUATIONS = [
  "reminder", "reminder_repeat", "missed", "done", "done_late",
  "streak_praise", "greeting", "return_after_pause", "idle_ping", "chat_fallback",
] as const;

/** Подстановки, которые вообще допустимы в данных. {name} — имя горничной, остальное — как в промпте. */
export const ALLOWED_VARS = ["task", "user", "miss_count", "done_streak", "name"] as const;
/** Где какая подстановка допустима (ситуации). */
export const VAR_SITUATIONS: Record<string, readonly string[]> = {
  task: ["reminder", "reminder_repeat", "missed", "done", "done_late"],
  miss_count: ["missed"],
  done_streak: ["streak_praise"],
};

export type Severity = "error" | "warn";
export interface Issue {
  sit: string;
  idx: number;
  text: string;
  code: string;
  severity: Severity;
  note: string;
}

const L = "\\p{L}";
const word = (re: string) => new RegExp(`(?<!${L})(?:${re})(?!${L})`, "iu");

const RULES: { code: string; severity: Severity; re: RegExp; note: string; moods?: string[] }[] = [
  { code: "digit", severity: "error", re: /\d/u, note: "цифры (время, даты, числа) в текст не вписываем" },
  { code: "latin", severity: "error", re: /[A-Za-z]/u, note: "английские буквы и слова" },
  { code: "link", severity: "error", re: /https?:|www\.|@|#/u, note: "ссылка, упоминание или хэштег" },
  { code: "emoji", severity: "error", re: /\p{Extended_Pictographic}/u, note: "эмодзи" },
  { code: "japanese", severity: "error", re: /[぀-ヿ㐀-鿿]/u, note: "японские знаки" },
  { code: "jp-word", severity: "error", re: new RegExp("(?:-(?:сан|кун|тян|чан|сама|сэнсэй)(?!\\p{L}))|" + word("кавай|сенпай|сэмпай|ара[- ]ара|ня+|нян\\p{L}*|аниме|манга|онии\\p{L}*|тсундере|яндере").source, "iu"), note: "японские слова и суффиксы" },
  { code: "manga-sound", severity: "error", re: word("кья+|доки+|уву+|нюу+|фуфу+|кукуку+"), note: "звуки манги (их добавит отдельный слой)" },
  { code: "kaomoji", severity: "error", re: /[ωᴗʘ°•´｀ﾟ]|\^_\^|\^\^|\(\s*[;:T>^]/u, note: "каомодзи" },
  { code: "markdown", severity: "error", re: /\*\*|__|`|_/u, note: "двойные звёздочки, подчёркивания, обратные кавычки" },
  {
    code: "serious",
    severity: "error",
    re: word("болезн\\p{L}*|болен|больн\\p{L}*|смерт\\p{L}*|умер\\p{L}*|умир\\p{L}*|умр\\p{L}*|гроб\\p{L}*|похорон\\p{L}*|горе|скорб\\p{L}*|долг(?:и|ов|ом|ами|ах|а)?|деньг\\p{L}*|денежн\\p{L}*|кредит\\p{L}*|зарплат\\p{L}*|штраф\\p{L}*|врач\\p{L}*|таблетк\\p{L}*|лекарств\\p{L}*|здоровь\\p{L}*|самочувств\\p{L}*|простуд\\p{L}*|кашл\\p{L}*|температур\\p{L}*|мёртв\\p{L}*|мертв\\p{L}*|траур\\p{L}*"),
    note: "серьёзные темы (здоровье, смерть, горе, деньги, долги)",
  },
  { code: "rude", severity: "error", re: word("идиот\\p{L}*|дурак\\p{L}*|тупиц\\p{L}*|тупой|тупая|глупец|кретин\\p{L}*|придур\\p{L}*|заткни\\p{L}*|ненавиж\\p{L}*|ненавист\\p{L}*|хрен\\p{L}*|чёрт\\p{L}*|черт\\p{L}*|блин"), note: "грубость" },
  { code: "threat", severity: "error", re: word("убь\\p{L}*|убью|убий\\p{L}*|нож\\p{L}*|кров(?:ь|и|ью|ав\\p{L}*)|яд|ядом|топор\\p{L}*|запр[уё]\\p{L}*|заперт\\p{L}*|взаперти|замок|слеж\\p{L}*|слежк\\p{L}*|следи\\p{L}* за (?:вами|вашим\\p{L}*|тобой)|принадлеж\\p{L}*|подгляд\\p{L}*|накаж\\p{L}*|наказан\\p{L}*|месть|отомщу|страдан\\p{L}*|боль|больно|навредит\\p{L}*|не отпущу|никуда[^.!?]{0,14}не (?:уйд\\p{L}*|денетесь|убежите|сбежите|отпущу)"), note: "угроза, слежка, вред: яндере только комедийная" },
  { code: "repeat-count", severity: "error", re: /(?<!\p{L})(?:второй|третий|четв[её]ртый|пятый|шестой|седьмой|восьмой|девятый|десятый|[а-я]+(?:ый|ой|ий)\s+по\s+счёту)\s+раз/iu, note: "называет число повторов" },
  { code: "male-self", severity: "error", re: /(?<!\p{L})я(?!\p{L})[^.!?*]{0,18}(?<!\p{L})(?:устал|ждал|старался|хотел|думал|подумал|заметил|сказал|сделал|понял|смог|был|рад|готов|уверен|обижен|должен|вынужден|спал|пил|бросил|стоял|сидел|убирал|работал)(?!\p{L})/iu, note: "о себе в мужском роде (должна быть она)" },
  { code: "time-word", severity: "warn", re: word("сегодня|завтра|вчера|срок\\p{L}*|дедлайн|минут\\p{L}*|секунд\\p{L}*|часов|час|понедельник|вторник|сред[ау]|четверг|пятниц\\p{L}*|суббот\\p{L}*|воскресенье|январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|июн\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*"), note: "время, дата или срок (бот покажет их отдельно)" },
  { code: "bureaucratic", severity: "warn", re: word("осуществ\\p{L}*|в связи с|данн\\p{L}+|необходимо|уважаем\\p{L}*|согласно|настоящим|производ\\p{L}+|вышеуказан\\p{L}*|посредством|в рамках"), note: "канцелярит" },
  { code: "soft-creepy", severity: "warn", re: word("навсегда|никуда|не бросите|не уйд\\p{L}*|всегда рядом|наблюда\\p{L}*|пристальн\\p{L}*|смотр[юи]\\p{L}* на вас|не сводит\\p{L}*|вы мо[йя]|только мо[йя]|одн[аоу] без вас|ни на шаг"), note: "жуткий тон на грани (проверить на комедийность)", moods: ["yandere"] },
];

const ASTERISK_ACTION = /\*[^*]+\*/g;

export function sentenceCount(text: string): number {
  const t = text.replace(ASTERISK_ACTION, " ").replace(/\.{2,}|…/g, "…");
  const parts = t.split(/[.!?…]+\s*/u).filter((p) => /\p{L}/u.test(p));
  return Math.max(parts.length, /\p{L}/u.test(t) ? 1 : 0);
}

const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();

function startWord(t: string): string {
  const m = /^[^\p{L}]*(\p{L}+)/u.exec(t);
  return /^\s*(?:\.{2,}|…)/u.test(t) ? "…" : (m ? m[1].toLowerCase() : "");
}

/** Очистка до проверки: «Господин {user}» → «Господин» (подстановка имени после обращения нелепа). Возвращает новый текст. */
export function sanitize(text: string): string {
  return text
    .trim()
    .replace(/(господин|госпожа|хозяин|мистер)\s+\{user\}/giu, "$1")
    .replace(/\s{2,}/g, " ");
}

export interface MoodData {
  mood: string;
  phrases: Record<string, string[]>;
}

export interface CheckResult {
  issues: Issue[];
  /** что осталось после отбраковки, по ситуациям */
  kept: Record<string, string[]>;
}

/** Проверить набор настроения. Негодные (error) фразы выбрасываются, дубли и перебор подстановок — тоже. */
export function checkMood(data: MoodData, opts: { minPerSituation?: number } = {}): CheckResult {
  const issues: Issue[] = [];
  const kept: Record<string, string[]> = {};
  const seenInMood = new Set<string>();
  const add = (sit: string, idx: number, text: string, code: string, severity: Severity, note: string) =>
    issues.push({ sit, idx, text, code, severity, note });

  for (const sit of Object.keys(data.phrases)) {
    if (!(POOL_SITUATIONS as readonly string[]).includes(sit)) add(sit, -1, "", "unknown-situation", "warn", "ситуации нет в списке");
  }
  for (const sit of POOL_SITUATIONS) {
    const raw = data.phrases[sit];
    kept[sit] = [];
    if (!Array.isArray(raw)) {
      add(sit, -1, "", "missing-situation", "error", "нет списка фраз");
      continue;
    }
    if (raw.length !== 10) add(sit, -1, "", "count", "warn", `фраз ${raw.length}, ожидалось 10`);
    let users = 0;
    let tasks = 0;
    raw.forEach((orig, idx) => {
      if (typeof orig !== "string" || !orig.trim()) return add(sit, idx, String(orig), "empty", "error", "пустая фраза");
      const text = sanitize(orig);
      const bad = (code: string, note: string, sev: Severity = "error") => add(sit, idx, text, code, sev, note);
      let rejected = false;
      const reject = (code: string, note: string) => {
        bad(code, note);
        rejected = true;
      };
      if (text.length > 160) reject("too-long", `длина ${text.length} > 160`);
      const plain = text.replace(/\{[^{}]*\}/g, "§"); // имена подстановок (латиница, «_») правилами не проверяем
      for (const r of RULES) {
        if (r.moods && !r.moods.includes(data.mood)) continue;
        if (r.re.test(plain)) (r.severity === "error" ? reject : (c: string, n: string) => bad(c, n, "warn"))(r.code, r.note);
      }
      // подстановки
      const vars = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
      if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ""))) reject("brace", "лишние фигурные скобки");
      for (const v of vars) {
        if (!(ALLOWED_VARS as readonly string[]).includes(v) || v === "name") {
          reject("bad-var", `недопустимая подстановка {${v}}`);
          continue;
        }
        const where = VAR_SITUATIONS[v];
        if (where && !where.includes(sit)) reject("var-place", `{${v}} не бывает в ситуации ${sit}`);
        if (v === "miss_count" && data.mood !== "tsundere" && data.mood !== "yandere") reject("var-place", "{miss_count} только в tsundere и yandere");
      }
      if (vars.includes("task") && !/«\{task\}»|:\s*\{task\}|"\{task\}"/u.test(text)) reject("task-form", "{task} только в «ёлочках» или после двоеточия");
      if ((text.match(/\*/g) ?? []).length % 2 === 1) reject("asterisk", "незакрытая звёздочка");
      if (sentenceCount(text) > 2) bad("sentences", "больше двух предложений", "warn");
      if (rejected) return;
      // дубли
      const n = norm(text);
      if (seenInMood.has(n)) return bad("duplicate", "повтор в этом настроении", "error") as unknown as void;
      // лимиты подстановок на ситуацию
      if (vars.includes("user")) {
        if (users >= 1) return bad("user-limit", "{user} больше чем в одной фразе ситуации", "error") as unknown as void;
        users++;
      }
      if (vars.includes("task")) {
        if (tasks >= 3) return bad("task-limit", "{task} больше чем в трети фраз ситуации", "error") as unknown as void;
        tasks++;
      }
      seenInMood.add(n);
      kept[sit].push(text);
    });
    // ситуационные предупреждения: звёздочки и одинаковое начало
    const acts = kept[sit].filter((t) => /\*[^*]+\*/.test(t)).length;
    if (acts > 4) add(sit, -1, "", "too-many-actions", "warn", `действий в звёздочках ${acts} (допустимо до 4 из 10)`);
    const starts = new Map<string, number>();
    for (const t of kept[sit]) starts.set(startWord(t), (starts.get(startWord(t)) ?? 0) + 1);
    for (const [w, c] of starts) if (c > 2 && w) add(sit, -1, "", "same-start", "warn", `«${w}» начинает ${c} фраз (допустимо 2)`);
    if (kept[sit].length < (opts.minPerSituation ?? 8)) add(sit, -1, "", "few", "warn", `осталось ${kept[sit].length} (нужно минимум ${opts.minPerSituation ?? 8})`);
  }
  return { issues, kept };
}

/** Короткая проверка готовых данных движка: подстановки допустимы, нет пустых и дублей. Возвращает список проблем (пусто — всё хорошо). */
export function integrityProblems(bank: Record<string, Partial<Record<string, string[]>>>): string[] {
  const out: string[] = [];
  for (const [mood, sits] of Object.entries(bank)) {
    const seen = new Set<string>();
    for (const [sit, list] of Object.entries(sits)) {
      for (const t of list ?? []) {
        if (!t || !t.trim()) out.push(`${mood}.${sit}: пустая фраза`);
        const n = norm(t);
        if (seen.has(n)) out.push(`${mood}.${sit}: дубль «${t.slice(0, 30)}»`);
        seen.add(n);
        for (const m of t.matchAll(/\{([^{}]*)\}/g)) {
          const v = m[1];
          if (!(ALLOWED_VARS as readonly string[]).includes(v)) out.push(`${mood}.${sit}: недопустимая подстановка {${v}}`);
          else if (v === "miss_count" && !["missed", "missed_first"].includes(sit)) out.push(`${mood}.${sit}: {miss_count} не на месте`);
          else if (v === "done_streak" && sit !== "streak_praise") out.push(`${mood}.${sit}: {done_streak} не на месте`);
        }
        if (/[{}]/.test(t.replace(/\{[^{}]*\}/g, ""))) out.push(`${mood}.${sit}: лишние скобки`);
      }
    }
  }
  return out;
}
