// Характер бота (настройка «Характер» в /settings). По умолчанию нейтральный: тексты как раньше.
// «Уставшая горничная» добавляет пару слов только в мелочах (пустые списки, «Готово», подписи сводок, /setup),
// сами напоминания и факты в сообщениях не меняются.
export type Character = "neutral" | "maid";

export const parseCharacter = (v: string | null | undefined): Character => (v === "maid" ? "maid" : "neutral");

export const CHARACTER_LABELS: Record<Character, string> = { neutral: "нейтральный", maid: "уставшая горничная" };

export type FlavorKey = "listEmpty" | "panelEmpty" | "weekEmpty" | "done" | "morningSign" | "eveningSign" | "weeklySign" | "setupDone";

const LINES: Record<FlavorKey, string[]> = {
  // дописываются после обычного текста
  listEmpty: ["…Можно немного поспать.", "…Наконец-то тихо.", "…Я бы вздремнула."],
  panelEmpty: ["…Наконец-то тихо.", "…Можно выдохнуть.", "…Я присяду на минутку."],
  weekEmpty: ["…Горничная не против отдохнуть.", "…Тихая неделя. Подозрительно.", "…Можно и подремать."],
  done: ["…ещё одним делом меньше.", "…можно выдохнуть.", "…вы молодец. Правда."],
  eveningSign: ["…На сегодня, кажется, всё.", "…Я бы уже спать.", "…День почти закончился."],
  weeklySign: ["…Неделя прошла. Я тоже.", "…Спасибо за неделю. Я, кажется, засыпаю."],
  setupDone: ["…Теперь можно и вздремнуть.", "…Всё готово. Я немного посижу тут."],
  // заменяет обычную подпись
  morningSign: ["Бот на месте… почти проснулась.", "Бот на месте… кофе бы.", "Бот на месте… Доброе утро."],
};

/** Фраза для характера или null (нейтральный — ничего не добавляем). seed делает выбор предсказуемым. */
export function tired(ch: Character, key: FlavorKey, seed = 0): string | null {
  if (ch !== "maid") return null;
  const list = LINES[key];
  return list[Math.abs(Math.trunc(seed)) % list.length];
}
