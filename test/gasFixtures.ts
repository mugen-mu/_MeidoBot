// Образцы для тестов газа: публичный текст ноябрьского графика Дніпровської філії «Газмережі» (сокращён) и сборка .docx «на лету»,
// чтобы бинарный файл не лежал в репозитории.
import { crc32, deflateRawSync } from "node:zlib";

export const GAS_PARAS = [
  "Дніпровська філія «Газмережі» інформує про проведення ремонтних робіт у листопаді 2026 року",
  "У зв'язку з виконанням ремонтних робіт на системі газопостачання буде тимчасово обмежено розподіл природного газу для мешканців ряду житлових будинків:",
  "м. Дніпро",
  "02.11.2026 року",
  "вул. Данила Галицького, 18",
  "вул. Олександра Кошиця, 14",
  "03.11.2026 року",
  "вул. Олександра Кошиця, 38, 46",
  "вул. Орловська, 24, 24а",
  "04.11.2026 року",
  "вул. Аудиторна, 33в",
  "пров. Широкий, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 16, 18, 18/1, 20, 22",
  "10.11.2026 року",
  "просп. Героїв, 35, під’їзд № 11",
  "12.11.2026 року",
  "вул. Козака Мамая, 12",
  "ЗВЕРНІТЬ УВАГУ!",
  "Відновлення розподілу газу буде виконано після закінчення робіт.",
  "17.11.2026 року",
  "вул. Не-та-що, 1",
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export const docXml = (paras: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>${paras.map((p) => `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;

/** Минимальный zip: файлы по списку; `deflate` — сжимать (как делает Word) или хранить как есть. */
export function makeZip(files: { name: string; data: Uint8Array }[], deflate = true): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data);
    const body = deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

export const makeDocx = (paras: string[], deflate = true): Uint8Array =>
  makeZip([{ name: "word/media/image1.png", data: new Uint8Array([1, 2, 3]) }, { name: "word/document.xml", data: new TextEncoder().encode(docXml(paras)) }], deflate);

export const GAS_LINK = "https://dp.grmu.com.ua/wp-content/uploads/2026/11/Графік-виконання-робіт-на-системі-газопостачання-у-листопаді-2026-року-1.docx";

export const GAS_HOME = `<html><body><article>
<p><strong>Дніпровська філія «Газмережі» інформує про проведення ремонтних робіт у листопаді 2026 року</strong></p>
<p>Адреси таких будинків можна переглянути у приєднаному нижче файлі:</p>
<p><a href="${GAS_LINK}">Графік виконання робіт на системі газопостачання у листопаді 2026 року</a></p>
<hr /><p><strong><em>22 жовтня 2026 року</em></strong></p>
<p><a href="https://dp.grmu.com.ua/wp-content/uploads/2026/10/Графік-виконання-робіт-на-системі-газопостачання-у-жовтні-2026-року-1-1.docx">Графік виконання робіт на системі газопостачання у жовтні 2026 року</a></p>
</article></body></html>`;
