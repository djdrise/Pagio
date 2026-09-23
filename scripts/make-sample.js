#!/usr/bin/env node
'use strict';

// Генератор тестового PDF без зависимостей.
//
// Нужен для ручных проверок и для тестов: документ с предсказуемым текстом на
// каждой странице позволяет убедиться, что поиск нашёл именно то, что нужно, а
// прокрутка встала на нужную страницу. Держать бинарный PDF в репозитории ради
// этого не хочется — проще собрать его на месте.
//
//   node scripts/make-sample.js [файл] [страниц]

const fs = require('node:fs');

const file = process.argv[2] || 'sample.pdf';
const pages = Number(process.argv[3]) || 60;

const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length;
};

const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

/** Страницы намеренно разной высоты: так видно, что лента считает смещения. */
const heightOf = (n) => (n % 10 === 0 ? 1008 : 792);

const contents = [];
for (let n = 1; n <= pages; n++) {
  const h = heightOf(n);
  const lines = [
    `0.93 0.95 0.98 rg 30 30 552 ${h - 60} re f 0 g`,
    `BT /F1 30 Tf 60 ${h - 90} Td (Page ${n} of ${pages}) Tj ET`,
    // Метка для проверки поиска: встречается ровно на одной странице.
    `BT /F1 14 Tf 60 ${h - 130} Td (marker-page-${n}) Tj ET`,
  ];
  for (let l = 0; l < 24; l++) {
    lines.push(
      `BT /F1 11 Tf 60 ${h - 170 - l * 22} Td ` +
        `(Line ${l + 1}: the quick brown fox jumps over the lazy dog) Tj ET`,
    );
  }
  const stream = lines.join('\n');
  contents.push(add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
}

const pagesId = objects.length + pages + 1;
const pageIds = contents.map((content, i) =>
  add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 ${heightOf(i + 1)}] ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
  ),
);
const tree = add(
  `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`,
);
const catalog = add(`<< /Type /Catalog /Pages ${tree} 0 R >>`);

let out = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(out));
  out += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(out);
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

fs.writeFileSync(file, out, 'latin1');
console.log(`${file} — ${pages} страниц`);
