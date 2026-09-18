// Раскладка непрерывной ленты страниц.
//
// Вся арифметика прокрутки собрана здесь и не знает ни про DOM, ни про pdf.js:
// на входе размеры страниц и параметры окна, на выходе — где какая страница
// лежит и какие из них сейчас видно. Ошибка в этих формулах проявляется как
// «документ прыгает при зуме» или «страница не дорисовалась» — то есть плохо
// воспроизводится вручную, зато отлично проверяется тестами.
//
// Файл с расширением .mjs не случайно: так его импортируют и окно программы,
// и node --test, без сборки и без дублирования кода.

/** Поля вокруг ленты и зазор между страницами, в пикселях. */
export const GAP = 12;
export const PADDING = 16;

/**
 * Считает положение каждой страницы в ленте.
 *
 * У каждой страницы, кроме её прямоугольника, есть anchor — прокрутка, при
 * которой страница стоит «в начале вида». Это не то же самое, что top: в ленте
 * над страницей ещё поле, а в показе — половина пустоты, на которую страница
 * не дотянулась. Считать это на месте вызова значит рано или поздно разойтись
 * с раскладкой, поэтому величина живёт здесь, рядом с самой раскладкой.
 *
 * @param {{width: number, height: number}[]} sizes размеры страниц при масштабе 1
 * @param {{scale: number, viewportWidth: number, gap?: number, padding?: number,
 *          slide?: number}} opts slide — высота экрана в режиме показа
 * @returns {{pages: {top: number, left: number, width: number, height: number,
 *            anchor: number}[], totalHeight: number, totalWidth: number}}
 */
export function layoutPages(sizes, { scale, viewportWidth, gap = GAP, padding = PADDING, slide = 0 }) {
  const pages = [];
  let top = padding;
  let widest = 0;
  let cell = 0;

  for (const size of sizes) {
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    widest = Math.max(widest, width);

    if (slide) {
      // Показ: под каждую страницу отведён ровно экран, страница стоит в нём по
      // центру. Без этого страница, которая шире экрана по пропорции (слайд
      // 16:9 на экране 16:10), не занимала бы его по высоте, и снизу выглядывал
      // бы край следующей — вместо одного слайда получалось бы полтора.
      pages.push({
        top: cell + Math.max(0, Math.round((slide - height) / 2)),
        left: 0,
        width,
        height,
        anchor: cell,
      });
      cell += slide;
    } else {
      pages.push({ top, left: 0, width, height, anchor: top - padding });
      top += height + gap;
    }
  }

  // Узкий документ стоит по центру окна, широкий прижат к левому краю и
  // прокручивается вбок — иначе при зуме страница уезжала бы из вида.
  const contentWidth = widest + padding * 2;
  for (const page of pages) {
    page.left = Math.max(padding, Math.round((viewportWidth - page.width) / 2));
  }

  return {
    pages,
    totalHeight: slide ? cell : pages.length ? top - gap + padding : padding * 2,
    totalWidth: Math.max(viewportWidth, contentWidth),
  };
}

/**
 * Какие страницы попадают в окно. overscan задаёт запас сверху и снизу в
 * экранах: соседние страницы рисуются заранее, чтобы прокрутка не упиралась
 * в пустое место.
 * @returns {{first: number, last: number}} индексы с нуля, включительно
 */
export function visibleRange(pages, scrollTop, viewportHeight, overscan = 0.5) {
  if (!pages.length) return { first: 0, last: -1 };

  const margin = viewportHeight * overscan;
  const from = scrollTop - margin;
  const to = scrollTop + viewportHeight + margin;

  // Двоичный поиск: на документе в тысячу страниц линейный обход по каждому
  // событию прокрутки заметно съедал бы кадры.
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].top + pages[mid].height < from) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;

  let last = first;
  while (last + 1 < pages.length && pages[last + 1].top < to) last += 1;

  return { first, last };
}

/**
 * Номер страницы, которую считаем текущей: та, которой видно больше всего.
 * При равенстве побеждает верхняя — так номер не скачет туда-сюда на границе.
 * @returns {number} номер страницы, с единицы
 */
export function currentPage(pages, scrollTop, viewportHeight) {
  if (!pages.length) return 1;

  const { first, last } = visibleRange(pages, scrollTop, viewportHeight, 0);
  let best = first;
  let bestSeen = -1;

  for (let i = first; i <= last; i++) {
    const page = pages[i];
    const seen =
      Math.min(page.top + page.height, scrollTop + viewportHeight) - Math.max(page.top, scrollTop);
    if (seen > bestSeen) {
      bestSeen = seen;
      best = i;
    }
  }
  return best + 1;
}

/**
 * Масштаб под размер окна.
 * @param {{width: number, height: number}} size страница при масштабе 1
 * @param {{width: number, height: number}} viewport видимая область
 * @param {'width'|'page'} mode
 */
export function fitScale(size, viewport, mode, { gap = GAP, padding = PADDING } = {}) {
  const byWidth = (viewport.width - padding * 2) / size.width;
  if (mode === 'width') return clampScale(byWidth);
  const byHeight = (viewport.height - padding * 2 - gap) / size.height;
  return clampScale(Math.min(byWidth, byHeight));
}

/** Пределы масштаба: ниже нечитаемо, выше канва не влезает в память. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

export function clampScale(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Куда прокрутить, чтобы после смены масштаба под курсором осталась та же
 * точка документа. Без этого зум колесом уводит документ в сторону.
 * @param {number} anchor положение точки в окне, от его верха
 */
export function keepAnchor(scrollTop, anchor, oldScale, newScale) {
  const docPoint = (scrollTop + anchor) / oldScale;
  return Math.max(0, docPoint * newScale - anchor);
}
