// Обёртка над pdf.js: загрузка документа, кэш разобранных страниц, отрисовка.
//
// legacy-сборка: в обычной pdf.js 5.7 использует Map.prototype.getOrInsertComputed,
// которого ещё нет в V8 у Electron 38. В legacy этот метод полифиллится.
import * as pdfjs from '../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs';

const BASE = new URL('../../../node_modules/pdfjs-dist/', import.meta.url);

pdfjs.GlobalWorkerOptions.workerSrc = new URL('legacy/build/pdf.worker.mjs', BASE).href;

const DOC_OPTS = {
  cMapUrl: new URL('cmaps/', BASE).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('standard_fonts/', BASE).href,
  wasmUrl: new URL('wasm/', BASE).href,
  iccUrl: new URL('iccs/', BASE).href,
  // Документ читается кусками по мере надобности; без этого pdf.js дотягивает
  // файл до конца в фоне, а на томе в сотню мегабайт это заметно.
  disableAutoFetch: true,
};

export const TextLayer = pdfjs.TextLayer;

/**
 * Чтение документа кусками через главный процесс.
 *
 * Обычное чтение по ссылке не подходит: pdf.js включает запрос диапазонов
 * только для http-адресов, а файл на диске под такой не подходит. Зато у
 * библиотеки есть штатный для встраивания приём — свой транспорт, который сам
 * решает, откуда брать байты.
 */
class IpcRange extends pdfjs.PDFDataRangeTransport {
  constructor(id, length) {
    // progressiveDone: потока «вдогонку» не будет, всё приходит ответами на запросы.
    super(length, new Uint8Array(0), true);
    this.id = id;
  }

  requestDataRange(begin, end) {
    window.reader
      .docRange(this.id, begin, end)
      .then((chunk) => {
        if (chunk) this.onDataRange(begin, chunk);
      })
      .catch(() => {});
  }
}

/**
 * @param {{id?: string, length?: number, data?: Uint8Array}} source
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
export function loadDoc(source) {
  if (source.data) return pdfjs.getDocument({ data: source.data, ...DOC_OPTS }).promise;
  const range = new IpcRange(source.id, source.length);
  return pdfjs.getDocument({ range, ...DOC_OPTS }).promise;
}

// ---------------------------------------------------------------------------
// Горячие страницы
// ---------------------------------------------------------------------------
// page.cleanup() выбрасывает разобранную страницу, а одну и ту же страницу мы
// трогаем не раз: рисуем в ленту, кладём текстовый слой, ищем по тексту, делаем
// миниатюру. Поэтому несколько последних держим разобранными и чистим только
// те, что сейчас никем не заняты, — иначе cleanup обрывает чужую отрисовку.

const HOT_PAGES = 16;
const caches = new WeakMap();
let clock = 0;

export async function acquirePage(doc, n) {
  let cache = caches.get(doc);
  if (!cache) {
    cache = new Map();
    caches.set(doc, cache);
  }
  let entry = cache.get(n);
  if (!entry) {
    entry = { promise: doc.getPage(n), refs: 0, used: 0 };
    cache.set(n, entry);
  }
  entry.refs += 1;
  entry.used = ++clock;
  try {
    return await entry.promise;
  } catch (err) {
    cache.delete(n);
    entry.refs -= 1;
    throw err;
  }
}

export function releasePage(doc, n) {
  const cache = caches.get(doc);
  const entry = cache?.get(n);
  if (!entry) return;
  entry.refs -= 1;
  if (cache.size <= HOT_PAGES) return;

  const idle = [...cache.entries()]
    .filter(([, e]) => e.refs <= 0)
    .sort((a, b) => a[1].used - b[1].used);
  for (const [num, e] of idle) {
    if (cache.size <= HOT_PAGES) break;
    cache.delete(num);
    e.promise.then((page) => page.cleanup()).catch(() => {});
  }
}

/** Плотность пикселей канвы. Выше двух не поднимаем: память растёт квадратично. */
export const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

/**
 * Рисует страницу в канву заданной ширины в CSS-пикселях.
 * Прерывается по signal: пролистнули дальше — доводить нечего.
 * @param {number} [rotation] поворот в градусах, кратный 90; складывается с
 *   собственным поворотом страницы, который задан в самом документе
 * @returns {Promise<{canvas: HTMLCanvasElement, viewport: object}|null>} null, если отменили
 */
export async function renderPage(doc, n, cssWidth, signal, rotation = 0) {
  if (signal?.aborted) return null;
  const page = await acquirePage(doc, n);
  if (signal?.aborted) {
    releasePage(doc, n);
    return null;
  }

  // Ширину считаем от повёрнутой страницы: у лежащей на боку она другая.
  const base = page.getViewport({ scale: 1, rotation: page.rotate + rotation });
  const ratio = dpr();
  const viewport = page.getViewport({
    scale: (cssWidth / base.width) * ratio,
    rotation: page.rotate + rotation,
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const task = page.render({ canvas, canvasContext: ctx, viewport });
  const stop = () => task.cancel();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return null;
    throw err;
  } finally {
    signal?.removeEventListener('abort', stop);
    releasePage(doc, n);
  }
  return {
    canvas,
    viewport: page.getViewport({
      scale: cssWidth / base.width,
      rotation: page.rotate + rotation,
    }),
  };
}

/** Размеры страницы при масштабе 1 — по ним строится лента. */
export async function pageSize(doc, n, rotation = 0) {
  const page = await acquirePage(doc, n);
  try {
    const v = page.getViewport({ scale: 1, rotation: page.rotate + rotation });
    return { width: v.width, height: v.height };
  } finally {
    releasePage(doc, n);
  }
}

/** Текст страницы: нужен и для поиска, и для слоя выделения. */
export async function textContent(doc, n) {
  const page = await acquirePage(doc, n);
  try {
    return await page.getTextContent();
  } finally {
    releasePage(doc, n);
  }
}
