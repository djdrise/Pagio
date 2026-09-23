'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/search.mjs');

const content = (...strings) => ({
  items: strings.map((str) => (typeof str === 'string' ? { str } : str)),
});

test('куски текста склеиваются в одну строку', async () => {
  const { buildPageText } = await load();
  const { text, spans } = buildPageText(content('Общий ', 'отдел'));
  assert.equal(text, 'Общий отдел');
  assert.deepEqual(spans[1], { index: 1, start: 6, end: 11 });
});

test('конец строки даёт перевод, иначе слова слипаются', async () => {
  const { buildPageText, findMatches } = await load();
  const { text } = buildPageText(content({ str: 'конец', hasEOL: true }, 'строки'));
  assert.equal(text, 'конец\nстроки');
  assert.equal(findMatches(text, 'конецстроки').length, 0);
});

test('поиск не зависит от регистра', async () => {
  const { findMatches } = await load();
  assert.equal(findMatches('Приказ по учреждению', 'приказ').length, 1);
  assert.equal(findMatches('приказ', 'ПРИКАЗ').length, 1);
});

test('ё и е считаются одной буквой', async () => {
  const { findMatches } = await load();
  // В документах пишут и так, и так; человек, ищущий «учет», ждёт «учёт».
  assert.equal(findMatches('бухгалтерский учёт', 'учет').length, 1);
  assert.equal(findMatches('бухгалтерский учет', 'учёт').length, 1);
});

test('позиции указывают на исходный текст, а не на приведённый', async () => {
  const { findMatches } = await load();
  const text = 'Сведения об УЧЁТЕ';
  const [hit] = findMatches(text, 'учёте');
  assert.equal(text.slice(hit.start, hit.end), 'УЧЁТЕ');
});

test('совпадения не пересекаются', async () => {
  const { findMatches } = await load();
  const hits = findMatches('ааааа', 'аа');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { start: 0, end: 2 });
  assert.deepEqual(hits[1], { start: 2, end: 4 });
});

test('пустой запрос ничего не находит', async () => {
  const { findMatches } = await load();
  assert.deepEqual(findMatches('любой текст', '   '), []);
  assert.deepEqual(findMatches('любой текст', ''), []);
});

test('совпадение внутри одного куска подсвечивает его часть', async () => {
  const { buildPageText, findMatches, spansForMatch } = await load();
  const { text, spans } = buildPageText(content('Отдел кадров'));
  const [hit] = findMatches(text, 'кадров');
  assert.deepEqual(spansForMatch(spans, hit), [{ index: 0, from: 6, to: 12 }]);
});

test('совпадение через границу кусков задевает оба', async () => {
  const { buildPageText, findMatches, spansForMatch } = await load();
  // pdf.js режет строку там, где меняется шрифт: «Приказ» может оказаться
  // разорванным, и подсветить нужно обе половины.
  const { text, spans } = buildPageText(content('При', 'каз № 12'));
  const [hit] = findMatches(text, 'приказ');
  const parts = spansForMatch(spans, hit);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { index: 0, from: 0, to: 3 });
  assert.deepEqual(parts[1], { index: 1, from: 0, to: 3 });
});

test('куски без текста не ломают разбор', async () => {
  const { buildPageText } = await load();
  const { text, spans } = buildPageText({ items: [{ str: 'а' }, {}, { str: 'б' }] });
  assert.equal(text, 'аб');
  assert.equal(spans.length, 2);
});
