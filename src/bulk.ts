// «отмени #15, #17, #19» / «готово #3» / «удали #7» обычным текстом в канале «бот»: действие по номерам дел (номера — «#N» из сообщений бота и /list).
// Раньше бот заводил из такого сообщения новое дело (живая проверка 2026-11-10). Осторожно: всё сообщение — глагол и номера с «#», больше ничего.
export type NumberAction = "cancel" | "delete" | "done";

/** Не больше номеров за раз (каждый — один подзапрос к базе). */
export const NUMBER_CMD_MAX = 12;

const VERBS: [RegExp, NumberAction][] = [
  [/^(?:отмени(?:ть|те)?|отмена)$/u, "cancel"],
  [/^(?:удали(?:ть|те)?)$/u, "delete"],
  [/^(?:готово|сделано|выполнено|закрой(?:те)?|закрыть)$/u, "done"],
];

export function parseNumberCommand(text: string): { action: NumberAction; ids: number[] } | null {
  const t = text.trim().toLowerCase().replace(/^(?:бот|хару)[,:]?\s+/u, "");
  const m = /^(\S+)\s+((?:#\d{1,6}(?:\s*(?:,|и)?\s*)?)+)$/u.exec(t);
  if (!m) return null;
  const verb = VERBS.find(([rx]) => rx.test(m[1]));
  if (!verb) return null;
  const ids = [...m[2].matchAll(/#(\d{1,6})/gu)].map((x) => Number(x[1]));
  if (ids.length === 0 || ids.length > NUMBER_CMD_MAX) return null;
  return { action: verb[1], ids: [...new Set(ids)] };
}
