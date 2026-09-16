// Отрисовка страниц для печати в скрытом окне.
//
// На бумагу должен попасть документ, а не окно программы: печать того, что на
// экране, унесла бы с собой панель инструментов, боковую панель и полосы
// прокрутки. Поэтому страницы рисуются здесь заново, в размере под бумагу.
//
// Канвы не копятся: каждая страница сразу превращается в JPEG и освобождается.
// Иначе полсотни листов при 150 точках на дюйм заняли бы сотни мегабайт — на
// офисной машине это верный отказ печати.

import { loadDoc, renderPage } from './lib/pdfdoc.js';

/** Плотность печати. 150 точек на дюйм — обычный компромисс для документов. */
const DPI = 150;
const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;

const params = new URLSearchParams(location.search);
const id = params.get('id');
const pages = (params.get('pages') || '')
  .split(',')
  .map((n) => Number(n))
  .filter((n) => Number.isInteger(n) && n > 0);

const sheets = document.getElementById('sheets');

async function run() {
  if (!id || !pages.length) {
    window.reader.printReady();
    return;
  }

  const source = await window.reader.docSource(id);
  if (!source) {
    window.reader.printReady();
    return;
  }

  const doc = await loadDoc({ id, length: source.length });
  const first = await doc.getPage(pages[0]);
  const size = first.getViewport({ scale: 1 });
  first.cleanup();

  // Размер листа берём по первой печатаемой странице. Документы со смешанными
  // форматами лягут на ту же бумагу — Chromium впишет их по ширине.
  const mm = (pt) => (pt * MM_PER_INCH) / PT_PER_INCH;
  const style = document.createElement('style');
  style.textContent = `@page { size: ${mm(size.width).toFixed(1)}mm ${mm(size.height).toFixed(1)}mm; margin: 0; }`;
  document.head.appendChild(style);

  const cssWidth = (size.width / PT_PER_INCH) * DPI;

  for (const n of pages) {
    try {
      const out = await renderPage(doc, n, cssWidth);
      if (!out) continue;
      const img = new Image();
      img.src = out.canvas.toDataURL('image/jpeg', 0.92);
      await img.decode();
      // Освобождаем канву сразу: дальше нужна только картинка.
      out.canvas.width = out.canvas.height = 0;

      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.appendChild(img);
      sheets.appendChild(sheet);
    } catch (err) {
      console.error(`страница ${n} не отрисовалась для печати:`, err);
    }
  }

  // Ждём, пока раскладка встанет: печать, начатая раньше, поймала бы пустые места.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.reader.printReady();
}

run().catch((err) => {
  console.error('печать не подготовилась:', err);
  window.reader.printReady();
});
