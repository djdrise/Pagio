'use strict';

// Давность в списке недавних: границы суток и года руками не проверить —
// пришлось бы переводить часы. Формат выбирается по календарным полям, а не
// по разности в миллисекундах, поэтому проверяются именно переходы.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/when.mjs');

/** Местное время: программа показывает даты в поясе того, кто смотрит. */
const at = (iso) => new Date(iso).getTime();

test('открытое сегодня показывает только время', async () => {
  const { whenKind } = await load();
  const now = at('2026-09-18T10:30:00');
  assert.equal(whenKind(at('2026-09-18T00:00:00'), now), 'time');
  assert.equal(whenKind(at('2026-09-18T09:59:00'), now), 'time');
});

test('вчерашнее и позавчерашнее — с числом и месяцем', async () => {
  const { whenKind } = await load();
  const now = at('2026-09-18T00:05:00');
  // Пять минут назад, но уже другие сутки: разность мала, формат другой.
  assert.equal(whenKind(at('2026-09-17T23:59:00'), now), 'day');
  assert.equal(whenKind(at('2026-01-01T12:00:00'), now), 'day');
});

test('прошлый год — с годом, даже если это было вчера', async () => {
  const { whenKind } = await load();
  const now = at('2026-01-01T00:30:00');
  assert.equal(whenKind(at('2025-12-31T23:30:00'), now), 'year');
});

test('метка из будущего не считается сегодняшней', async () => {
  const { whenKind } = await load();
  const now = at('2026-09-18T10:30:00');
  // Часы на машине могли уйти вперёд: показываем дату, а не пустоту.
  assert.equal(whenKind(at('2026-09-19T10:30:00'), now), 'day');
  assert.equal(whenKind(at('2027-01-05T10:30:00'), now), 'year');
});

test('без метки столбец пуст', async () => {
  const { whenKind, formatWhen, formatFull } = await load();
  const now = at('2026-09-18T10:30:00');
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, '1758000000000']) {
    assert.equal(whenKind(bad, now), null, String(bad));
    assert.equal(formatWhen(bad, 'ru', now), '');
    assert.equal(formatFull(bad, 'ru'), '');
  }
});

test('язык выбирает написание даты, незнакомый код — русский', async () => {
  const { formatWhen } = await load();
  const now = at('2026-09-18T10:30:00');
  const ts = at('2026-03-02T14:00:00');
  assert.match(formatWhen(ts, 'ru', now), /мар/);
  assert.match(formatWhen(ts, 'en', now), /Mar/);
  assert.equal(formatWhen(ts, 'xx', now), formatWhen(ts, 'ru', now));
});

test('повторное открытие обновляет время, а не плодит запись', async () => {
  const { remember } = require('../src/main/lib/recent');
  const first = remember([], { path: '/a.pdf', name: 'a.pdf' }, 12, 1000);
  const again = remember(first, { path: '/a.pdf', name: 'a.pdf' }, 12, 5000);
  assert.equal(again.length, 1);
  assert.equal(again[0].openedAt, 5000);
});

test('старая запись без времени открывается по-прежнему', async () => {
  const { remember } = require('../src/main/lib/recent');
  const list = remember([{ path: '/old.pdf', name: 'old.pdf' }], { path: '/new.pdf', name: 'new.pdf' }, 12, 7000);
  assert.deepEqual(list.map((x) => x.name), ['new.pdf', 'old.pdf']);
  assert.equal(list[1].openedAt, undefined);
});
