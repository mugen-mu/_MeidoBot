// Кнопочное меню: главный экран, дела постранично с карточкой, настройки по разделам. Здесь только вид (чистые функции);
// действия по кнопкам — в interactions.ts (`onMenu`). Идентификаторы кнопок: `mn:…` (меню внутри сообщения «только вам»),
// `pn:…` (постоянная панель в канале «бот»: нажатие открывает такой же экран отдельным сообщением «только вам»).
import { CHARACTER_LABELS } from "../flavor.ts";
import { PRESET_LABELS, describeSpec } from "../ladder.ts";
import type { AppSettings } from "../settings.ts";
import { describeRecipe, formatWhen } from "../time/format.ts";
import { MINUTE, fmtHHMM, startOfDay } from "../time/tz.ts";
import type { OccView } from "../db/types.ts";
import { styleSummary } from "../personality/styleReport.ts";
import { parseRecipe } from "../service.ts";
import { GAS_WORDS_HINT } from "../gas.ts";
import { WATER_WORDS_HINT } from "../water.ts";
import { describeWeekly, selectLabel, textLabel, modal } from "./ui.ts";
import type { ActionRow, Button, MessageBody, StringSelect } from "./types.ts";

const btn = (label: string, id: string, style: Button["style"] = 2, disabled = false): Button => ({
  type: 2,
  style,
  label,
  custom_id: id,
  ...(disabled ? { disabled: true } : {}),
});
const row = (...components: ActionRow["components"]): ActionRow => ({ type: 1, components });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const body = (content: string, components: ActionRow[]): MessageBody => ({ content, components, allowed_mentions: { parse: [] } });

// ---------- общие куски ----------

/** Нижняя строка кнопок результата: куда пойти дальше. */
export function navRow(): ActionRow {
  return row(btn("➕ Ещё дело", "mn:add"), btn("📋 К делам", "mn:ls:a:0"), btn("🏠 Меню", "mn:home"));
}

/** Добавить строку навигации к готовому сообщению (не больше 5 рядов). */
export function withNav(b: MessageBody): MessageBody {
  const rows = [...(b.components ?? [])];
  if (rows.length >= 5) return b;
  return { ...b, components: [...rows, navRow()] };
}

export const isBurning = (o: OccView) => o.state === "overdue" || o.state === "fired";
const at = (o: OccView) => (o.state === "snoozed" && o.next_fire_at ? o.next_fire_at : o.due_at);

// ---------- главный экран ----------

export interface HomeStats {
  open: number;
  hot: number;
  today: number;
  noDue: number;
}

export function homeStats(items: OccView[], now: number, tz: string): HomeStats {
  const t0 = startOfDay(now, tz);
  const t1 = t0 + 24 * 60 * MINUTE;
  return {
    open: items.length,
    hot: items.filter(isBurning).length,
    today: items.filter((o) => !isBurning(o) && o.state !== "draft" && at(o) !== null && (at(o) as number) >= t0 && (at(o) as number) < t1).length,
    noDue: items.filter((o) => o.state === "draft").length,
  };
}

/** Главный экран: три крупные кнопки (добавить, сегодня, висит) и «Все дела / Неделя / Аниме / Свет / Ещё». Счётчики — только у экрана в сообщении (панель их не знает). */
function homeButtons(prefix: "mn" | "pn", st?: HomeStats): ActionRow[] {
  const cnt = (n: number | undefined) => (n === undefined ? "" : ` ${n}`);
  return [
    row(btn("➕ Добавить дело", `${prefix}:add`, 3), btn(`📅 Сегодня${cnt(st?.today)}`, `${prefix}:ls:t:0`, 1), btn(`⏳ Висит${cnt(st?.hot)}`, `${prefix}:ls:h:0`, st && st.hot > 0 ? 4 : 2)),
    row(btn("📋 Все дела", `${prefix}:ls:a:0`), btn("🗓 Неделя", `${prefix}:wk`), btn("🎬 Аниме", `${prefix}:an`), btn("💡 Свет", `${prefix}:lt`), btn("⋯ Ещё", `${prefix}:more`)),
  ];
}

export function homeMessage(st: HomeStats): MessageBody {
  const parts = [`на сегодня **${st.today}**`, `висит **${st.hot}**`];
  if (st.noDue) parts.push(`без срока **${st.noDue}**`);
  return body(`**Meido — меню**\n${st.open === 0 ? "Открытых дел нет." : parts.join(" · ")}`, homeButtons("mn", st));
}

/** «Ещё»: то, что нужно реже (настроение горничной, настройки). Свет — на главном экране (с 2026-11-09). */
export function moreMessage(prefix: "mn" | "pn" = "mn"): MessageBody {
  return body("**Ещё**", [row(btn("🎭 Настроение", `${prefix}:mo`), btn("⚙ Настройки", `${prefix}:st`)), row(btn("🏠 Меню", `${prefix}:home`))]);
}

/**
 * «Добавить» с галочкой «Три последних дела» (C5): последние дела кнопками и «Новое…». Нажатие на дело создаёт такое же новое
 * (бот спросит время), «Новое…» открывает обычное окно. По умолчанию галочка выключена, «Добавить» сразу открывает окно.
 */
export function recentMessage(items: { id: number; title: string }[], prefix: "mn" | "pn" = "mn"): MessageBody {
  return body("**Добавить дело**\nПовторить недавнее или записать новое:", [
    row(...items.slice(0, 3).map((it) => btn(`↻ ${clip(it.title, 40)}`, `${prefix}:rc:${it.id}`))),
    row(btn("✏ Новое…", `${prefix}:addnew`, 3), btn("🏠 Меню", `${prefix}:home`)),
  ]);
}

/** Экран-справка (текст и «Назад»): слова Хару, подтверждения. */
export function infoMessage(text: string, backId: string, backLabel = "◀ Назад"): MessageBody {
  return body(text, [row(btn(backLabel, backId), btn("🏠 Меню", "mn:home"))]);
}

export function confirmResetMessage(): MessageBody {
  return body("Сбросить настроение, отношение, серии и выученные слова к начальным?", [row(btn("Да, сбросить", "mn:ry", 4), btn("Нет, оставить", "mn:s:a"))]);
}

/** Постоянная панель в канале «бот»: текст не меняется (цифры в нём устарели бы), кнопки открывают экраны «только вам». */
export function panelMessage(): MessageBody {
  return body("**Meido** — меню\nНажмите кнопку: экран откроется только для вас. Дело можно и просто написать сюда обычным текстом.", homeButtons("pn"));
}

// ---------- дела ----------

export type ListFilter = "a" | "h" | "t" | "n";
export const PAGE_SIZE = 5;
const FILTER_LABEL: Record<ListFilter, string> = { a: "Все", h: "Висит", t: "Сегодня", n: "Без срока" };

export const isFilter = (f: string): f is ListFilter => f === "a" || f === "h" || f === "t" || f === "n";

export function filterItems(items: OccView[], f: ListFilter, now: number, tz: string): OccView[] {
  const t0 = startOfDay(now, tz);
  const t1 = t0 + 24 * 60 * MINUTE;
  switch (f) {
    case "h":
      return items.filter(isBurning);
    case "t":
      return items.filter((o) => !isBurning(o) && o.state !== "draft" && at(o) !== null && (at(o) as number) >= t0 && (at(o) as number) < t1);
    case "n":
      return items.filter((o) => o.state === "draft");
    default:
      return items;
  }
}

const STATE_SHORT: Record<string, string> = { draft: "без срока", planned: "", snoozed: "отложено до", fired: "ждёт «Готово»", overdue: "висит" };

function line(o: OccView, n: number, now: number, tz: string): string {
  const rep = o.rule_recipe ? " ↻" : "";
  const when = at(o) === null ? "" : formatWhen(at(o) as number, now, tz);
  const st = STATE_SHORT[o.state] ?? o.state;
  const tail = [st, when].filter(Boolean).join(": ");
  return `**${n}.** ${clip(o.title, 60)}${rep}${tail ? ` — ${tail}` : ""}`;
}

export function listMessage(items: OccView[], f: ListFilter, page: number, now: number, tz: string): MessageBody {
  const all = items;
  const shown = filterItems(all, f, now, tz);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = shown.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  const head = `**${FILTER_LABEL[f]}** · дел: ${shown.length}${pages > 1 ? ` · страница ${p + 1} из ${pages}` : ""}`;
  const text = slice.length ? `${head}\nНажмите номер, чтобы открыть дело.\n${slice.map((o, i) => line(o, i + 1, now, tz)).join("\n")}` : `${head}\nЗдесь пусто.`;
  const rows: ActionRow[] = [];
  if (slice.length) rows.push(row(...slice.map((o, i) => btn(String(i + 1), `mn:it:${o.id}:${f}:${p}`, 1))));
  const count = (k: ListFilter) => filterItems(all, k, now, tz).length;
  rows.push(row(...(["a", "h", "t", "n"] as const).map((k) => btn(`${FILTER_LABEL[k]} ${count(k)}`, `mn:ls:${k}:0`, k === f ? 1 : 2))));
  rows.push(
    row(
      btn("◀", `mn:ls:${f}:${p - 1}`, 2, p === 0),
      btn("▶", `mn:ls:${f}:${p + 1}`, 2, p >= pages - 1),
      btn("➕ Добавить", "mn:add", 3),
      btn("🏠 Меню", "mn:home"),
    ),
  );
  return body(text, rows);
}

/** Карточка дела: подробности и действия. `f`/`p` — откуда пришли (кнопка «К списку» вернёт туда же). */
export function cardMessage(o: OccView, f: ListFilter, p: number, now: number, tz: string, defaultLadder: string): MessageBody {
  const recipe = parseRecipe(o);
  const lines = [`**${o.title}**`];
  const when = at(o);
  const st = STATE_SHORT[o.state] ?? o.state;
  lines.push(`${st ? `${st[0].toUpperCase()}${st.slice(1)}` : "Запланировано"}${when !== null ? `: ${formatWhen(when, now, tz)}` : ""}`);
  if (recipe) lines.push(`Повтор: ${describeRecipe(recipe, tz)}`);
  lines.push(`Как часто напоминать: ${defaultLadder} · #${o.item_id}`);
  const ctx = `${o.id}:${f}:${p}`;
  const repeats = o.item_kind === "timer" || o.rule_recipe !== null;
  const rows: ActionRow[] = [
    row(btn("✅ Готово", `mn:dn:${ctx}`, 3), btn("⏰ Через час", `mn:sz:${o.id}:h1:${f}:${p}`), btn("🌆 Вечером", `mn:sz:${o.id}:eve:${f}:${p}`), btn("🌅 Завтра", `mn:sz:${o.id}:tom:${f}:${p}`), btn("🕒 На…", `mn:sa:${ctx}`)),
    row(
      btn("✏ Изменить", `mn:ed:${ctx}`),
      ...(repeats ? [btn("⛔ Остановить повтор", `mn:sp:${o.item_id}:${f}:${p}`)] : []),
      btn("🗑 Удалить", `mn:dl:${o.item_id}:${o.id}:${f}:${p}`, 4),
      btn("◀ К списку", `mn:ls:${f}:${p}`),
    ),
  ];
  return body(lines.join("\n"), rows);
}

export function confirmDeleteMessage(title: string, itemId: number, occId: number, f: ListFilter, p: number): MessageBody {
  return body(`Удалить **${title}** целиком? Повторяющееся дело удалится со всеми повторами.`, [
    row(btn("🗑 Да, удалить", `mn:dy:${itemId}:${f}:${p}`, 4), btn("Нет, оставить", `mn:it:${occId}:${f}:${p}`)),
  ]);
}

/** Результат действия с делом: короткая подпись и кнопки «куда дальше». */
export function resultMessage(text: string, f: ListFilter = "a", p = 0): MessageBody {
  return body(text, [row(btn("📋 К делам", `mn:ls:${f}:${p}`, 1), btn("➕ Ещё дело", "mn:add"), btn("🏠 Меню", "mn:home"))]);
}

// ---------- добавление ----------

export const REPEAT_CHOICES = [
  { value: "day", label: "Каждый день", phrase: "каждый день" },
  { value: "wd", label: "По будням", phrase: "по будням" },
  { value: "wk", label: "Каждую неделю", phrase: "каждую неделю" },
  { value: "mo", label: "Каждый месяц", phrase: "каждый месяц" },
  { value: "yr", label: "Каждый год (впишите дату выше)", phrase: "каждый год" },
] as const;

/** Окно «Добавить дело»: что, когда (необязательно), повтор. `tag` — откуда открыто: `mn` (меню в сообщении) или `pn` (панель). */
export function addModal(tag: "mn" | "pn") {
  return modal(`m_add:${tag}`, "Добавить дело", [
    textLabel("Что нужно сделать", "what", { max: 200, placeholder: "купить хлеб" }),
    textLabel("Когда (можно не писать)", "when", { required: false, max: 60, placeholder: "завтра в 10:00" }),
    selectLabel("Повторять", "repeat", [{ value: "none", label: "Не повторять" }, ...REPEAT_CHOICES.map((r) => ({ value: r.value, label: r.label }))]),
  ]);
}

/** Из полей окна — одна фраза для обычного разбора: «каждый день в 10:00 купить хлеб». */
export function menuPhrase(a: { what: string; when: string; repeat: string }): { text: string; recurring: boolean } {
  const rep = REPEAT_CHOICES.find((r) => r.value === a.repeat);
  const parts = [rep?.phrase, a.when.trim(), a.what.trim()].filter(Boolean) as string[];
  return { text: parts.join(" "), recurring: !!rep };
}

// ---------- настройки по разделам ----------

export type Section = "q" | "m" | "l" | "c" | "a" | "s";
export const isSection = (s: string): s is Section => s === "q" || s === "m" || s === "l" || s === "c" || s === "a" || s === "s";

const onOff = (v: boolean) => (v ? "вкл" : "выкл");

export function settingsHomeMessage(s: AppSettings, now: number): MessageBody {
  const away = s.awayUntil > now ? `до ${formatWhen(s.awayUntil, now, s.tz)}` : "нет";
  const text = [
    "**Настройки**",
    `🌙 Тишина: тихие часы ${onOff(s.quietEnabled)} (${fmtHHMM(s.quietFrom)}–${fmtHHMM(s.quietTo)}), отъезд: ${away}`,
    `📰 Сводки и коммуналка: утром ${s.morning === null ? "выкл" : fmtHHMM(s.morning)}, вечером ${s.evening === null ? "выкл" : fmtHHMM(s.evening)}; свет: ${s.lightGroup ? `группа ${s.lightGroup}` : "выкл"}; вода: ${s.waterWords.length ? "вкл" : "выкл"}; газ: ${s.gasWords.length ? "вкл" : "выкл"}`,
    `🔁 Как часто напоминать: ${describeSpec(s.defaultLadder)}`,
    `🎭 Характер: ${CHARACTER_LABELS[s.character]}; настроение ${onOff(s.moodOn)}`,
  ].join("\n");
  return body(text, [
    row(btn("🌙 Тишина", "mn:s:q"), btn("📰 Сводки и коммуналка", "mn:s:m"), btn("🔁 Как часто напоминать", "mn:s:l"), btn("🎭 Характер", "mn:s:c"), btn("⋯ Ещё", "mn:s:a")),
    row(btn("🏠 Меню", "mn:home")),
  ]);
}

const SFX_NEXT = { kana: "cyrillic", cyrillic: "off", off: "kana" } as const;
const KAO_NEXT = { auto: "on", on: "off", off: "auto" } as const;
export const nextSfx = (v: keyof typeof SFX_NEXT) => SFX_NEXT[v];
export const nextKaomoji = (v: keyof typeof KAO_NEXT) => KAO_NEXT[v];
const SFX_WORD = { kana: "кана", cyrillic: "кириллица", off: "выкл" };
const KAO_WORD = { auto: "на уровне 3", on: "вкл", off: "выкл" };

export function sectionMessage(s: AppSettings, sec: Section, now: number, dmOn: boolean): MessageBody {
  const back = row(btn("◀ Настройки", "mn:st"), btn("🏠 Меню", "mn:home"));
  switch (sec) {
    case "q": {
      const away = s.awayUntil > now ? `до ${formatWhen(s.awayUntil, now, s.tz)}` : "нет";
      return body(
        [`**🌙 Тишина**`, `Тихие часы: ${onOff(s.quietEnabled)} (${fmtHHMM(s.quietFrom)}–${fmtHHMM(s.quietTo)}). В это время бот не напоминает, а копит до утра.`, `Бот молчит (отъезд или выходной): ${away}.`].join("\n"),
        [
          row(
            btn(s.quietEnabled ? "Тихие часы: выключить" : "Тихие часы: включить", "mn:tg:q:q", s.quietEnabled ? 3 : 2),
            btn("Время тишины…", "mn:md:qt:q"),
            btn("Я в отъезде…", "mn:md:aw:q"),
            btn("Выходной на 4 ч", "mn:tg:qh:q"),
          ),
          back,
        ],
      );
    }
    case "m":
      return body(
        [
          "**📰 Сводки и коммуналка**",
          `Утренняя сводка: ${s.morning === null ? "выкл" : fmtHHMM(s.morning)}; вечерняя: ${s.evening === null ? "выкл" : fmtHHMM(s.evening)}; итоги недели: ${describeWeekly(s)}.`,
          `Часовой пояс: ${s.tz}. «Утром» — ${fmtHHMM(s.wordMorning)}, «вечером» — ${fmtHHMM(s.wordEvening)} (так бот понимает эти слова в делах).`,
          `График света (Днепр): ${s.lightGroup ? `группа ${s.lightGroup}` : "выкл"}.`,
          s.waterWords.length
            ? `Вода (Днепр): слежу по словам «${s.waterWords.join(", ")}». Предупреждаю сразу, накануне вечером и за 2 часа; если отключений нет — молчу.`
            : `Вода (Днепр): выкл. ${WATER_WORDS_HINT}`,
          s.gasWords.length
            ? `Газ (Днепр): слежу по словам «${s.gasWords.join(", ")}». Предупреждаю накануне вечером и утром в день работ; если вашего адреса в графике нет — молчу.`
            : `Газ (Днепр): выкл. ${GAS_WORDS_HINT}`,
        ].join("\n"),
        [
          row(
            btn(s.morning === null ? "Утро: включить" : "Утро: выключить", "mn:tg:sa:m", s.morning === null ? 2 : 3),
            btn(s.evening === null ? "Вечер: включить" : "Вечер: выключить", "mn:tg:se:m", s.evening === null ? 2 : 3),
            btn("Время и пояс…", "mn:md:sm:m"),
          ),
          row(btn("Свет: группа…", "mn:md:lt:m"), btn("Вода: слова…", "mn:md:wt:m"), btn("Газ: слова…", "mn:md:gs:m"), btn("Ссылки для телефона", "mn:pw"), btn("Новый ключ ссылок", "mn:pw:new", 4)),
          row(btn("«Утром» и «вечером»…", "mn:md:dw:m")),
          back,
        ],
      );
    case "l": {
      const preset = "preset" in s.defaultLadder ? s.defaultLadder.preset : "";
      const select: StringSelect = {
        type: 3,
        custom_id: "mn:ld",
        placeholder: "Как часто напоминать",
        options: (["soft", "standard", "strong"] as const).map((k) => ({
          label: PRESET_LABELS[k][0].toUpperCase() + PRESET_LABELS[k].slice(1),
          value: k,
          default: k === preset,
        })),
      };
      return body(
        [`**🔁 Как часто напоминать**`, `Как часто бот повторяет напоминание, пока дело не закрыто: ${describeSpec(s.defaultLadder)}.`, "Для одного дела можно поменять в его карточке («Изменить»)."].join("\n"),
        [row(select), row(btn("Свои числа…", "mn:md:ln:l")), back],
      );
    }
    case "c":
      return body(
        [
          "**🎭 Характер**",
          `Характер: ${CHARACTER_LABELS[s.character]}.`,
          `Настроение горничной: ${onOff(s.moodOn)} (меняется от того, как вы закрываете дела).`,
          `Стиль речи: ${styleSummary(s.style)}.`,
          `Живые реплики через модель: ${onOff(s.liveOn)}. Хару сочиняет фразу под настроение и ситуацию; если модель молчит или лимит на сегодня кончился, говорит готовыми фразами.`,
          "Для отдельного дела стиль выключается в «Изменить» → «Реплики Хару».",
        ].join("\n"),
        [
          row(
            btn(s.character === "maid" ? "Характер: нейтральный" : "Характер: уставшая горничная", "mn:tg:ch:c"),
            btn(s.moodOn ? "Настроение: выключить" : "Настроение: включить", "mn:tg:mo:c", s.moodOn ? 3 : 2),
            btn(s.liveOn ? "Живые реплики: выключить" : "Живые реплики: включить", "mn:tg:lv:c", s.liveOn ? 3 : 2),
            btn("Стиль речи…", "mn:s:s"),
          ),
          back,
        ],
      );
    case "s": {
      const lvl: StringSelect = {
        type: 3,
        custom_id: "mn:sv",
        placeholder: "Сколько в речи аниме",
        options: [
          { label: "0 — обычный русский", value: "0", default: s.style.level === 0 },
          { label: "1 — лёгкие вставки", value: "1", default: s.style.level === 1 },
          { label: "2 — фансаб-стиль", value: "2", default: s.style.level === 2 },
          { label: "3 — полный отаку", value: "3", default: s.style.level === 3 },
        ],
      };
      const script: StringSelect = {
        type: 3,
        custom_id: "mn:sw",
        placeholder: "Как писать японские слова",
        options: [
          { label: "Кириллицей (ара-ара)", value: "cyrillic", default: s.style.script === "cyrillic" },
          { label: "Латиницей (ara ara)", value: "latin", default: s.style.script === "latin" },
          { label: "Вперемешку", value: "mixed", default: s.style.script === "mixed" },
        ],
      };
      return body(
        [
          "**🎭 Стиль речи**",
          styleSummary(s.style),
          "Подсказки перевода (слово в скобках) по умолчанию скрыты: включите, если хотите видеть значение новых слов.",
          "Стиль работает, пока включено «Настроение».",
        ].join("\n"),
        [
          row(
            btn(`Обращения: ${onOff(s.style.honorifics)}`, "mn:tg:ho:s", s.style.honorifics ? 3 : 2),
            btn(`Подсказки перевода: ${onOff(s.style.hints)}`, "mn:tg:hi:s", s.style.hints ? 3 : 2),
            btn(`Манга-звуки: ${SFX_WORD[s.style.sfx]}`, "mn:tg:sx:s"),
            btn(`Каомодзи: ${KAO_WORD[s.style.kaomoji]}`, "mn:tg:km:s"),
          ),
          row(lvl),
          row(script),
          row(btn("◀ Характер", "mn:s:c"), btn("🏠 Меню", "mn:home")),
        ],
      );
    }
    default:
      return body(
        [
          "**⋯ Ещё**",
          `Понимание фраз моделью: ${onOff(s.llmOn)}. Если бот не понял время, он спросит языковую модель; такую запись стоит проверить.`,
          `Личка: ${onOff(dmOn)}. Канал «бот»: ${s.chBot ? "заведён" : "не создан (/setup)"}.`,
          `Недавние дела в «Добавить»: ${onOff(s.recentOn)}. Нажали «Добавить» — три последних дела кнопками, чтобы повторить в два касания.`,
          `Звук для всего: ${onOff(s.soundAll)}. Выкл — упоминание (звук) только у настоящих напоминаний; вкл — и у сводок, подтверждений и реплик Хару.`,
        ].join("\n"),
        [
          row(
            btn(s.llmOn ? "Понимание моделью: выключить" : "Понимание моделью: включить", "mn:tg:llm:a", s.llmOn ? 3 : 2),
            btn(dmOn ? "Личка: выключить" : "Личка: включить", "mn:tg:dm:a", dmOn ? 3 : 2),
            btn(s.recentOn ? "Недавние дела: выключить" : "Недавние дела: включить", "mn:tg:rc:a", s.recentOn ? 3 : 2),
            btn(s.soundAll ? "Звук для всего: выключить" : "Звук для всего: включить", "mn:tg:snd:a", s.soundAll ? 3 : 2),
          ),
          row(btn("Слова Хару", "mn:gl"), btn("Сбросить настроение…", "mn:rs", 4)),
          back,
        ],
      );
  }
}
