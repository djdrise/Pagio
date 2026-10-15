'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const load = () => import('../src/renderer/lib/imagemeta.mjs');

// Минимальный PNG: подпись, IHDR, пустой IDAT, IEND — разбору этого хватает.
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR = chunk('IHDR', Buffer.from([0, 0, 0, 4, 0, 0, 0, 3, 8, 2, 0, 0, 0]));
const IDAT = chunk('IDAT', zlib.deflateSync(Buffer.alloc(4 * 3 * 3 + 3)));
const IEND = chunk('IEND', Buffer.alloc(0));
const png = (...chunks) => new Uint8Array(Buffer.concat([SIGNATURE, ...chunks]));

function chunks(bytes) {
  const buf = Buffer.from(bytes);
  const out = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    const crc = buf.readUInt32BE(at + 8 + length);
    out.push({ type, data, crcOk: crc === zlib.crc32(buf.subarray(at + 4, at + 8 + length)) });
    at += 12 + length;
  }
  return out;
}

test('в PNG разрешение встаёт блоком pHYs сразу за IHDR', async () => {
  const { withDpi } = await load();
  const list = chunks(withDpi(png(IHDR, IDAT, IEND), 'image/png', 300));
  assert.deepEqual(list.map((c) => c.type), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  const phys = list[1];
  assert.ok(phys.crcOk, 'контрольная сумма pHYs верна');
  // 300 dpi = 11811 точек на метр, единица — метр.
  assert.equal(phys.data.readUInt32BE(0), 11811);
  assert.equal(phys.data.readUInt32BE(4), 11811);
  assert.equal(phys.data[8], 1);
});

test('прежний pHYs в PNG заменяется, а не дублируется', async () => {
  const { withDpi } = await load();
  const once = withDpi(png(IHDR, IDAT, IEND), 'image/png', 72);
  const list = chunks(withDpi(once, 'image/png', 600));
  assert.equal(list.filter((c) => c.type === 'pHYs').length, 1);
  assert.equal(list.find((c) => c.type === 'pHYs').data.readUInt32BE(0), 23622);
  assert.ok(list.every((c) => c.crcOk));
});

test('данные картинки в PNG не трогаются', async () => {
  const { withDpi } = await load();
  const out = chunks(withDpi(png(IHDR, IDAT, IEND), 'image/png', 150));
  assert.deepEqual(out.find((c) => c.type === 'IDAT').data, IDAT.subarray(8, IDAT.length - 4));
});

// JPEG здесь — только заголовок: SOI, сегмент и EOI. Разметке больше не нужно.
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];

test('в JPEG с заголовком JFIF правятся единицы и плотность', async () => {
  const { withDpi } = await load();
  const out = withDpi(new Uint8Array([...SOI, ...JFIF, ...EOI]), 'image/jpeg', 300);
  assert.equal(out.length, 2 + JFIF.length + 2, 'длина не меняется');
  assert.equal(out[13], 1, 'единицы — точки на дюйм');
  assert.equal((out[14] << 8) | out[15], 300);
  assert.equal((out[16] << 8) | out[17], 300);
});

test('в JPEG без JFIF заголовок вставляется сразу за SOI', async () => {
  const { withDpi } = await load();
  const exif = [0xff, 0xe1, 0x00, 0x04, 0x00, 0x00];
  const out = withDpi(new Uint8Array([...SOI, ...exif, ...EOI]), 'image/jpeg', 150);
  assert.deepEqual([...out.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(String.fromCharCode(...out.subarray(6, 11)), 'JFIF\0');
  assert.equal(out[13], 1);
  assert.equal((out[14] << 8) | out[15], 150);
  assert.deepEqual([...out.subarray(20)], [...exif, ...EOI], 'остальное идёт следом без изменений');
});

test('непонятный файл возвращается как есть', async () => {
  const { withDpi } = await load();
  const junk = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(withDpi(junk, 'image/png', 300), junk);
  assert.equal(withDpi(junk, 'image/jpeg', 300), junk);
  // Обрезанный PNG: длина блока уходит за конец файла.
  const cut = png(IHDR).subarray(0, 20);
  assert.equal(withDpi(cut, 'image/png', 300), cut);
});

test('размер в пикселях: A4 в ходовых разрешениях', async () => {
  const { exportPixels } = await load();
  const a4 = { width: 595.28, height: 841.89 };
  assert.deepEqual(exportPixels(a4, 72), { width: 595, height: 841, fits: true });
  assert.deepEqual(exportPixels(a4, 150), { width: 1240, height: 1753, fits: true });
  assert.deepEqual(exportPixels(a4, 300), { width: 2480, height: 3507, fits: true });
  assert.deepEqual(exportPixels(a4, 600), { width: 4960, height: 7015, fits: true });
});

test('слишком крупная картинка помечается, а не обрезается', async () => {
  const { exportPixels, MAX_SIDE } = await load();
  // A0 в 600 dpi: около 20 тысяч на 28 — больше и по стороне, и по площади.
  const a0 = exportPixels({ width: 2383.94, height: 3370.39 }, 600);
  assert.equal(a0.fits, false);
  assert.ok(a0.height > MAX_SIDE);
  // Длинная лента: сторона за пределом при скромной площади.
  assert.equal(exportPixels({ width: 100, height: 20000 }, 72).fits, false);
});
