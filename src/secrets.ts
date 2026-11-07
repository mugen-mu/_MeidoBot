// Похоже ли сообщение на пароль, ключ или номер карты. Само значение нигде не сохраняем и не пишем в журнал:
// вызывающий код при `secret = true` не кладёт текст ни в базу, ни в events.

export type SecretKind = "card" | "keyword" | "token" | "pem";

const B = "(?<![\\p{L}\\p{N}])";

export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function hasCard(text: string): boolean {
  for (const m of text.matchAll(/(?<![\d])(?:\d[ -]?){13,19}(?![\d])/g)) {
    const d = m[0].replace(/[ -]/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return true;
  }
  return false;
}

/** Строка без пробелов, где вперемешку буквы, цифры и/или знаки — типично для ключа. */
function looksRandom(tok: string): boolean {
  if (tok.length < 20) return false;
  if (/^https?:\/\//i.test(tok)) return false;
  const classes =
    Number(/[a-z]/.test(tok)) + Number(/[A-Z]/.test(tok)) + Number(/\d/.test(tok)) + Number(/[^A-Za-z\d]/.test(tok));
  return classes >= 3 && /^[\x21-\x7e]+$/.test(tok);
}

/** Пароль/ключ/PIN сразу после слова-подсказки (само слово без значения — не секрет: «сменить пароль» допустимо). */
const KEYWORD_VALUE = new RegExp(
  `${B}(?:парол[ьяю]|password|passwd|pwd|pass|пин(?:-?код)?|pin|токен|token|секрет|secret|api[ _-]?key|ключ|cvv|cvc)\\s*(?:[:=—-]|\\sот\\s+\\S+\\s*[:=—-]?)\\s*(\\S{4,})`,
  "iu",
);

export function detectSecret(text: string): { secret: boolean; kind?: SecretKind } {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return { secret: true, kind: "pem" };
  if (hasCard(text)) return { secret: true, kind: "card" };
  if (/(?:^|[\s:=])(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/.test(text)) {
    return { secret: true, kind: "token" };
  }
  const kv = KEYWORD_VALUE.exec(text);
  if (kv && (/\d/.test(kv[1]) || /[^\p{L}\d]/u.test(kv[1]) || /[A-Z]/.test(kv[1]))) {
    return { secret: true, kind: "keyword" };
  }
  for (const tok of text.split(/\s+/)) {
    if (looksRandom(tok)) return { secret: true, kind: "token" };
  }
  return { secret: false };
}
