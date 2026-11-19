// Чтение по ссылке: живые фразы хозяина со ссылкой на сайт, где он читает (чистые функции, без базы и сети).
//   «бот читаю <ссылка>», «бот читаю мангу <ссылка>», «хочу почитать <ссылка>»      — завести тайтл по ссылке;
//   «Кауру тут: <ссылка>», «бот Кауру читаю здесь <ссылка>», «ссылка на Кауру: <ссылка>» — привязать ссылку к тайтлу;
// Берём только ссылки на сайты из списка (src/reading/siteIds.ts): любая другая ссылка в сообщении — обычное дело, как раньше.
// Осторожность та же, что у остальных фраз чтения: фраза про чужое название без обращения («бот», «Хару») и без слов «читаю» / «манга» — обычное дело.
import type { ReadKind } from "./core.ts";
import { siteByHost } from "./siteIds.ts";

export interface ReadLinkSay {
  /** start — начать читать, plan — в планы, attach — только запомнить ссылку у названия, статус не менять */
  action: "start" | "plan" | "attach";
  /** ссылка, как в сообщении (очищенная от скобок и знаков в конце) */
  url: string;
  /** название, если хозяин его назвал */
  name: string | null;
  /** слово «манга» / «ранобэ» в фразе */
  kind: ReadKind | null;
  /** было обращение «бот» / «Хару» или слово «манга» / «ранобэ» */
  prefixed: boolean;
}

/** Самая длинная фраза без ссылки, символов: ссылки длинные, но слов вокруг них немного. */
const MAX_REST = 100;
const MAX_NAME = 70;

const URL_RE = /https?:\/\/[^\s<>«»"“”]+/giu;
const PREFIX = /^(?:бот|хару)(?![\p{L}\p{N}])\s*[,:;.\-–—]?\s*/iu;
const KIND_RE = /(?:^|\s)(?:(?:веб|лайт)[\s-]*)?(ранобэ|ранобе|новелл[уаые]|манг[уаие]|манхв[уаы]|маньхуа|вебтун)(?=\s|$|[,.:;])/iu;
const START = /^(?:читаю(?:\s+сейчас)?|читаем|начал[аи]?\s+читать|стал[аи]?\s+читать|продолжаю\s+читать|продолжил[аи]?\s+читать|взялся\s+за|взялась\s+за)(?![\p{L}\p{N}])\s*/iu;
const PLAN = /^(?:хочу\s+(?:почитать|прочитать|читать)|в\s+планах\s+(?:почитать|прочитать)|планирую\s+(?:почитать|прочитать|читать)|потом\s+(?:почитаю|прочитаю))(?![\p{L}\p{N}])\s*/iu;

/** Слова, которые стоят рядом с названием, но названием не являются: «тут», «здесь», «ссылка», «по ссылке», «на сайте». */
const FILL = new Set(["тут", "здесь", "вот", "ссылка", "ссылку", "ссылке", "ссылки", "по", "на", "в", "сайте", "читаю", "читаем", "тоже", "это", "уже"]);
const HERE = /(?:^|\s)(?:тут|здесь|ссылка|ссылку|ссылке|по\s+ссылке)(?![\p{L}\p{N}])/iu;

/** Убрать служебные слова и знаки с краёв названия; середину не трогаем («Атака на титанов» остаётся целой). */
function trimName(s: string): string {
  const w = s.replace(/[«»"“”]/gu, " ").replace(/[:;,]+/g, " ").replace(/\s[-–—]+(?=\s|$)|^[-–—]+\s/g, " ").split(/\s+/).filter(Boolean);
  while (w.length && FILL.has(w[0].toLowerCase())) w.shift();
  while (w.length && FILL.has(w[w.length - 1].toLowerCase())) w.pop();
  return w.join(" ").replace(/[.!?…\-–—]+$/u, "").trim();
}

/** Разобрать фразу со ссылкой на сайт чтения; null — это не она. */
export function parseReadLink(textIn: string): ReadLinkSay | null {
  const raw = textIn.trim();
  if (!raw || raw.length > 600 || /[\r\n]/.test(raw)) return null;
  let url: string | null = null;
  for (const m of raw.matchAll(URL_RE)) {
    const clean = m[0].replace(/[.,;:!?)\]}»”]+$/u, "");
    try {
      if (siteByHost(new URL(clean).hostname)) {
        url = clean;
        break;
      }
    } catch {
      // не ссылка
    }
  }
  if (!url) return null;
  let rest = raw.replace(url, " ").replace(/\s+/g, " ").trim();
  // остаток без ссылки бывает пустым или в скобках: «(ссылка)»
  rest = rest.replace(/^[(\[]+|[)\]]+$/g, "").trim();
  if (rest.length > MAX_REST) return null;
  const pm = PREFIX.exec(rest);
  const addressed = !!pm && pm[0].trim().length > 0;
  if (addressed) rest = rest.slice(pm![0].length).trim();
  let kind: ReadKind | null = null;
  const km = KIND_RE.exec(` ${rest} `);
  if (km) {
    kind = /ранобэ|ранобе|новелл/i.test(km[1]) ? "ranobe" : "manga";
    rest = ` ${rest} `.replace(KIND_RE, " ").replace(/\s+/g, " ").trim();
  }
  let action: ReadLinkSay["action"] | null = null;
  const sm = START.exec(rest);
  const pl = sm ? null : PLAN.exec(rest);
  if (sm) {
    action = "start";
    rest = rest.slice(sm[0].length);
  } else if (pl) {
    action = "plan";
    rest = rest.slice(pl[0].length);
  }
  const here = HERE.test(rest);
  const name = trimName(rest);
  if (name.length > MAX_NAME) return null;
  if (!action) {
    // без глагола: «Кауру тут: ссылка» (привязать) или «бот ссылка» / «бот <ссылка>» (завести)
    if (name && (here || addressed || kind)) action = "attach";
    else if (!name && addressed) action = "start";
    else return null;
  }
  return { action, url, name: name || null, kind, prefixed: addressed || !!kind || action === "start" || action === "plan" };
}
