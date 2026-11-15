// Вес дела (пакет «оживление», 2026-11-15): чистая логика без базы и Discord.
// Повод — слова владельца: «поставил «выключить чайник» и сделал пять раз за день — она меня хвалит; а пропущу день рождения мамы —
// должен быть минус намного больше. Дела бывают разного веса».
//  • мелочь — рутина и пустяки: пропуск почти не злит, «Готово» не растит серию «подряд» и хвалится скупо или не хвалится;
//  • обычное — как раньше;
//  • важное — поздравления, даты, платежи, встречи, «заранее за N дней»: пропуск бьёт сильно, «Готово» хвалят тепло.
// Решает бот по тому, что у дела уже есть (повтор, «заранее», «критично», слова в названии); метка хозяина «мелочь» / «главное»
// (`items.weight`: 1 / 2) главнее любой догадки. Вес — только про слова и числа настроения: время и число напоминаний он не трогает никогда.
export type Weight = "minor" | "normal" | "major";

/** Что нужно знать о деле: достаточно полей OccView. */
export interface WeightInput {
  title: string;
  item_kind: string;
  critical?: number | boolean;
  rule_recipe?: string | null;
  rule_leads?: string | null;
  /** метка хозяина: 0 — решает бот, 1 — мелочь, 2 — главное */
  item_weight?: number;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

/** Слова, по которым дело считается важным: близкие, даты, поездки, платежи. Список короткий и осторожный: ошибку поправит метка «мелочь» / «главное». */
const MAJOR_WORDS = new RegExp(
  `${B}(?:день\\s+рождени\\p{L}*|дн[её]м\\s+рождени\\p{L}*|днюх\\p{L}*|юбиле\\p{L}*|годовщин\\p{L}*|поздрав\\p{L}*|подар\\p{L}*|свадьб\\p{L}*|экзамен\\p{L}*|собеседовани\\p{L}*|рейс\\p{L}*|вылет\\p{L}*|билет\\p{L}*|паспорт\\p{L}*|виз[аыуе]|налог\\p{L}*|платёж\\p{L}*|платеж\\p{L}*|оплат\\p{L}*|заплатить|квартплат\\p{L}*|аренд\\p{L}*|страховк\\p{L}*|дедлайн)${E}`,
  "iu",
);
/** Слова, по которым дело — пустяк: быт «на ходу». */
const MINOR_WORDS = new RegExp(
  `${B}(?:выключ\\p{L}*|включ\\p{L}*|закр\\p{L}*|открой|открыть)\\s+(?:чайник|утюг|плит\\p{L}*|свет|воду|кран|газ|окно|форточк\\p{L}*|дверь)${E}|${B}(?:полить|полив\\p{L}*|размя\\p{L}*|разминк\\p{L}*|потянуться|осанк\\p{L}*|моргн\\p{L}*|перерыв\\p{L}*|вынести\\s+мусор)${E}`,
  "iu",
);

interface Recipe {
  freq?: string;
  interval?: number;
}

/** Часто повторяющееся: каждые N минут или часов, «каждый день» — это привычка, а не событие. */
function isRoutine(recipeJson: string | null | undefined): boolean {
  if (!recipeJson) return false;
  try {
    const r = JSON.parse(recipeJson) as Recipe;
    if (r.freq === "minutes" || r.freq === "hours") return true;
    return r.freq === "days" && (r.interval ?? 1) <= 1;
  } catch {
    return false;
  }
}

function hasLeads(leadsJson: string | null | undefined): boolean {
  if (!leadsJson) return false;
  try {
    const v = JSON.parse(leadsJson);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}

/**
 * Вес дела. Порядок: метка хозяина → «критично» → важные слова → «заранее за N дней» → пустяковые слова → таймер и «каждый день» → обычное.
 * Важное перебивает рутину: «каждый год поздравить маму» остаётся важным.
 */
export function weightOf(o: WeightInput): Weight {
  if (o.item_weight === 1) return "minor";
  if (o.item_weight === 2) return "major";
  if (o.critical) return "major";
  if (MAJOR_WORDS.test(o.title)) return "major";
  if (hasLeads(o.rule_leads)) return "major";
  if (MINOR_WORDS.test(o.title)) return "minor";
  if (o.item_kind === "timer" || isRoutine(o.rule_recipe)) return "minor";
  return "normal";
}

export const WEIGHT_WORDS: Record<Weight, string> = { minor: "мелочь", normal: "обычное", major: "главное" };

/** Метка для БД из названия варианта в окне «Изменить». */
export function weightMark(choice: string): 0 | 1 | 2 | null {
  if (choice === "auto") return 0;
  if (choice === "minor") return 1;
  if (choice === "major") return 2;
  return null;
}
