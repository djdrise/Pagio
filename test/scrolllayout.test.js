'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Модуль общий для окна и тестов, поэтому импортируется динамически.
const load = () => import('../src/renderer/lib/scrolllayout.mjs');

const A4 = { width: 612, height: 792 };
const sizes = (n, size = A4) => Array.from({ length: n }, () => ({ ...size }));

test('страницы идут одна за другой с зазором', async () => {
  const { layoutPages, GAP, PADDING } = await load();
  const { pages } = layoutPages(sizes(3), { scale: 1, viewportWidth: 1000 });

  assert.equal(pages[0].top, PADDING);
  assert.equal(pages[1].top, PADDING + 792 + GAP);
  assert.equal(pages[2].top, PADDING + (792 + GAP) * 2);
});

test('общая высота учитывает поля и зазоры, но не лишний зазор в конце', async () => {
  const { layoutPages, GAP, PADDING } = await load();
  const { totalHeight } = layoutPages(sizes(3), { scale: 1, viewportWidth: 1000 });
  assert.equal(totalHeight, PADDING * 2 + 792 * 3 + GAP * 2);
});

test('узкий документ стоит по центру, широкий прижат к полю', async () => {
  const { layoutPages, PADDING } = await load();
  const narrow = layoutPages(sizes(1), { scale: 1, viewportWidth: 1000 });
  assert.equal(narrow.pages[0].left, Math.round((1000 - 612) / 2));

  const wide = layoutPages(sizes(1), { scale: 3, viewportWidth: 400 });
  assert.equal(wide.pages[0].left, PADDING);
});

test('страницы разной высоты не сбивают смещения', async () => {
  const { layoutPages, GAP, PADDING } = await load();
  const mixed = [A4, { width: 612, height: 1008 }, A4];
  const { pages } = layoutPages(mixed, { scale: 1, viewportWidth: 1000 });

  assert.equal(pages[1].top, PADDING + 792 + GAP);
  assert.equal(pages[2].top, PADDING + 792 + GAP + 1008 + GAP);
});

test('anchor ставит страницу в начало вида, а не под поле', async () => {
  const { layoutPages, GAP } = await load();
  const { pages } = layoutPages(sizes(3), { scale: 1, viewportWidth: 1000 });

  assert.equal(pages[0].anchor, 0, 'первая страница видна целиком с самого верха');
  assert.equal(pages[1].anchor, 792 + GAP);
});

test('в показе под каждую страницу отведён ровно экран', async () => {
  const { layoutPages } = await load();
  const slide = 900;
  const { pages, totalHeight } = layoutPages(sizes(4), {
    scale: 1,
    viewportWidth: 1400,
    gap: 0,
    padding: 0,
    slide,
  });

  assert.deepEqual(
    pages.map((p) => p.anchor),
    [0, slide, slide * 2, slide * 3],
  );
  assert.equal(totalHeight, slide * 4, 'лишней пустоты в конце быть не должно');
});

test('слайд 16:9 на экране другой пропорции не пускает в кадр соседа', async () => {
  const { layoutPages, fitScale } = await load();
  // Слайд 16:9 на экране 16:10: по высоте страница до края не достаёт, и
  // раньше в остаток снизу заглядывала следующая.
  const slide169 = { width: 960, height: 540 };
  const view = { width: 1470, height: 923 };
  const box = { gap: 0, padding: 0, slide: view.height };
  const scale = fitScale(slide169, view, 'page', box);
  const { pages } = layoutPages([slide169, slide169], {
    scale,
    viewportWidth: view.width,
    ...box,
  });

  const [first, second] = pages;
  assert.ok(first.height < view.height, 'проверяем именно случай, когда страница ниже экрана');

  // Встали на первую страницу: её видно целиком, второй не видно вовсе.
  const screen = { top: first.anchor, bottom: first.anchor + view.height };
  assert.ok(first.top >= screen.top, 'верх страницы не должен уезжать за край экрана');
  assert.ok(first.top + first.height <= screen.bottom, 'низ страницы должен помещаться');
  assert.ok(second.top >= screen.bottom, 'следующая страница обязана быть за краем экрана');

  // И стоит по центру: пустота сверху и снизу поровну.
  const above = first.top - screen.top;
  const below = screen.bottom - (first.top + first.height);
  assert.ok(Math.abs(above - below) <= 1, `поля неравные: ${above} и ${below}`);
});

test('видимыми считаются только страницы в окне и запасе', async () => {
  const { layoutPages, visibleRange } = await load();
  const { pages } = layoutPages(sizes(50), { scale: 1, viewportWidth: 1000 });

  // Смотрим на первый экран: сотня страниц ниже попасть в список не должна.
  const top = visibleRange(pages, 0, 800, 0);
  assert.equal(top.first, 0);
  assert.ok(top.last <= 1, `ожидали одну-две страницы, получили ${top.last + 1}`);

  // Прокрутили к двадцатой — первые девятнадцать больше не нужны.
  const page20 = pages[19];
  const mid = visibleRange(pages, page20.top, 800, 0);
  assert.equal(mid.first, 19);
});

test('запас расширяет диапазон в обе стороны', async () => {
  const { layoutPages, visibleRange } = await load();
  const { pages } = layoutPages(sizes(50), { scale: 1, viewportWidth: 1000 });
  const at = pages[19].top;

  const tight = visibleRange(pages, at, 800, 0);
  const loose = visibleRange(pages, at, 800, 1);
  assert.ok(loose.first < tight.first, 'запас должен захватывать предыдущую страницу');
  assert.ok(loose.last > tight.last, 'запас должен захватывать следующую страницу');
});

test('текущая страница — та, которой видно больше', async () => {
  const { layoutPages, currentPage } = await load();
  const { pages } = layoutPages(sizes(10), { scale: 1, viewportWidth: 1000 });

  assert.equal(currentPage(pages, 0, 800), 1);
  // Встали так, что вторая страница занимает почти весь экран.
  assert.equal(currentPage(pages, pages[1].top + 10, 700), 2);
});

test('пустой документ не роняет расчёты', async () => {
  const { layoutPages, visibleRange, currentPage } = await load();
  const { pages, totalHeight } = layoutPages([], { scale: 1, viewportWidth: 1000 });
  assert.deepEqual(pages, []);
  assert.ok(totalHeight > 0);
  assert.deepEqual(visibleRange([], 0, 800), { first: 0, last: -1 });
  assert.equal(currentPage([], 0, 800), 1);
});

test('масштаб по ширине вписывает страницу в окно', async () => {
  const { fitScale, PADDING } = await load();
  const scale = fitScale(A4, { width: 1000, height: 700 }, 'width');
  assert.equal(scale, (1000 - PADDING * 2) / 612);
});

test('масштаб по странице учитывает и высоту', async () => {
  const { fitScale } = await load();
  const byPage = fitScale(A4, { width: 1000, height: 400 }, 'page');
  const byWidth = fitScale(A4, { width: 1000, height: 400 }, 'width');
  assert.ok(byPage < byWidth, 'при низком окне ограничение даёт высота');
});

test('масштаб не выходит за пределы', async () => {
  const { clampScale, MIN_SCALE, MAX_SCALE } = await load();
  assert.equal(clampScale(0), 1, 'бессмысленное значение заменяем единицей');
  assert.equal(clampScale(-3), 1);
  assert.equal(clampScale(NaN), 1);
  assert.equal(clampScale(0.001), MIN_SCALE);
  assert.equal(clampScale(100), MAX_SCALE);
});

test('точка под курсором остаётся на месте при зуме', async () => {
  const { keepAnchor } = await load();
  // Точка документа, которая была под курсором на 200 px от верха окна,
  // обязана оказаться там же и после удвоения масштаба.
  const before = 1000;
  const anchor = 200;
  const after = keepAnchor(before, anchor, 1, 2);
  assert.equal((before + anchor) / 1, (after + anchor) / 2);
});

test('прокрутка не уходит в минус при уменьшении', async () => {
  const { keepAnchor } = await load();
  assert.equal(keepAnchor(10, 200, 4, 0.5), 0);
});
