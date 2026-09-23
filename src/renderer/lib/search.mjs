// Поиск по тексту страницы.
//
// Чистая часть поиска: превратить куски текста от pdf.js в одну строку, найти в
// ней совпадения и сказать, какие куски их содержат. Подсветку рисует уже окно.
//
// Отдельным файлом — потому что именно здесь живут неочевидные правила
// (регистр, «ё», переносы между кусками), и проверять их руками на живом
// документе мучительно, а тестом — одна строчка.

/**
 * Приводит строку к виду, в котором сравниваем.
 * Длина не меняется: иначе найденные позиции перестали бы совпадать с исходным
 * текстом, и подсветка уехала бы на соседние буквы.
 */
export function fold(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/ /g, ' ');
}

/**
 * Склеивает куски текста страницы в одну строку, запоминая границы кусков.
 * @param {{items: {str: string, hasEOL?: boolean}[]}} content ответ pdf.js
 * @returns {{text: string, spans: {index: number, start: number, end: number}[]}}
 */
export function buildPageText(content) {
  const spans = [];
  let text = '';

  content.items.forEach((item, index) => {
    if (typeof item.str !== 'string') return;
    const start = text.length;
    text += item.str;
    spans.push({ index, start, end: text.length });
    // Конец строки в PDF не даёт пробела сам по себе: без этого «конец» и
    // «строки» склеились бы в одно слово и не нашлись по отдельности.
    if (item.hasEOL) text += '\n';
  });

  return { text, spans };
}

/**
 * Все вхождения запроса, без пересечений.
 * @returns {{start: number, end: number}[]} позиции в исходном тексте страницы
 */
export function findMatches(text, query) {
  const needle = fold(query.trim());
  if (!needle) return [];

  const haystack = fold(text);
  const out = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    out.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return out;
}

/**
 * Какие куски текста задевает совпадение и какая их часть попала внутрь.
 * Совпадение может лежать в нескольких кусках сразу: pdf.js режет строку там,
 * где в документе меняется шрифт или положение.
 * @returns {{index: number, from: number, to: number}[]} from и to — смещения внутри куска
 */
export function spansForMatch(spans, match) {
  const out = [];
  for (const span of spans) {
    if (span.end <= match.start || span.start >= match.end) continue;
    out.push({
      index: span.index,
      from: Math.max(0, match.start - span.start),
      to: Math.min(span.end, match.end) - span.start,
    });
  }
  return out;
}
