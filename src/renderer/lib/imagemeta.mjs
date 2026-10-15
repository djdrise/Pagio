// Страница как картинка: размер в пикселях и разрешение внутри файла.
//
// Кодировщик браузера (canvas.toBlob) разрешения не пишет: PNG выходит без
// блока pHYs, JPEG — с плотностью «1 к 1» без единиц. Такой файл Word или
// фоторедактор вставят в 72 или 96 dpi, и страница, сохранённая в 300 dpi,
// окажется вчетверо крупнее листа. Поэтому разрешение дописываем сами — прямо в
// байты готового файла, без перекодирования.
//
// Файл .mjs, как и прочая чистая логика: его читают и окно, и node --test.

/** Разрешения на выбор и разрешение по умолчанию. */
export const EXPORT_DPI = [72, 96, 150, 200, 300, 600];
export const DEFAULT_DPI = 150;

/**
 * Пределы картинки. Сторона — по возможностям канвы с запасом, площадь — по
 * памяти: 100 мегапикселей — это 400 МБ одной канвы, да ещё столько же на
 * кодирование. Лист A4 в 600 dpi — около 35 мегапикселей, A3 — около 70.
 */
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 100e6;

/**
 * Размер картинки в пикселях для страницы данного размера.
 * Округление вниз — так же, как pdf.js считает размер канвы.
 * @param {{width: number, height: number}} size страница в пунктах (1/72 дюйма)
 * @returns {{width: number, height: number, fits: boolean}}
 */
export function exportPixels(size, dpi) {
  const width = Math.max(1, Math.floor((size.width * dpi) / 72));
  const height = Math.max(1, Math.floor((size.height * dpi) / 72));
  const fits = width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
  return { width, height, fits };
}

// ---------------------------------------------------------------------------
// Разрешение внутри файла
// ---------------------------------------------------------------------------

/**
 * Возвращает файл с записанным разрешением. Непонятный файл возвращается как
 * есть: картинка без разрешения лучше, чем несохранённая.
 * @param {Uint8Array} bytes готовый PNG или JPEG
 * @param {'image/png'|'image/jpeg'} mime
 * @param {number} dpi
 * @returns {Uint8Array}
 */
export function withDpi(bytes, mime, dpi) {
  if (!(bytes instanceof Uint8Array) || !(dpi > 0)) return bytes;
  try {
    if (mime === 'image/png') return pngWithDpi(bytes, dpi);
    if (mime === 'image/jpeg') return jpegWithDpi(bytes, dpi);
  } catch {
    // Повреждённый или неожиданный файл: отдаём без изменений.
  }
  return bytes;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * В PNG разрешение — блок pHYs: пикселей на метр по обеим осям и единица
 * «метр». Стоит после IHDR и до данных; если уже есть — заменяем.
 */
function pngWithDpi(bytes, dpi) {
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const ppm = Math.round(dpi / 0.0254);
  const data = new Uint8Array(9);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, ppm);
  dv.setUint32(4, ppm);
  data[8] = 1;
  const phys = pngChunk('pHYs', data);

  // Обходим блоки: запоминаем конец IHDR и место прежнего pHYs, если он есть.
  let offset = 8;
  let afterIhdr = -1;
  let old = null;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) return bytes;
    if (type === 'IHDR') afterIhdr = end;
    if (type === 'pHYs') old = [offset, end];
    if (type === 'IDAT' || type === 'IEND') break;
    offset = end;
  }
  if (afterIhdr < 0) return bytes;

  const [from, to] = old ?? [afterIhdr, afterIhdr];
  return concat(bytes.subarray(0, from), phys, bytes.subarray(to));
}

/**
 * В JPEG разрешение — поля плотности в заголовке JFIF (блок APP0): единица
 * «точек на дюйм» и плотность по осям. Заголовок обычно идёт сразу за SOI;
 * если его нет — вставляем стандартный.
 */
function jpegWithDpi(bytes, dpi) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const density = Math.min(0xffff, Math.round(dpi));
  const isJfif =
    bytes[2] === 0xff && bytes[3] === 0xe0 &&
    String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0';

  if (isJfif) {
    const out = bytes.slice();
    out[13] = 1; // единицы: точки на дюйм
    out[14] = density >> 8;
    out[15] = density & 0xff;
    out[16] = density >> 8;
    out[17] = density & 0xff;
    return out;
  }

  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, // APP0, длина 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // «JFIF\0»
    0x01, 0x01, // версия 1.1
    0x01, // единицы: точки на дюйм
    density >> 8, density & 0xff,
    density >> 8, density & 0xff,
    0x00, 0x00, // без миниатюры
  ]);
  return concat(bytes.subarray(0, 2), app0, bytes.subarray(2));
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
