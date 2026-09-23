// Когда документ открывали — короткой строкой для списка недавних.
//
// Полная дата в столбце избыточна: у файла, открытого час назад, важно время,
// у прошлогоднего — год, а месяц с числом нужны между тем и другим. Поэтому
// формат выбирается по давности, и в списке остаётся ровно то, что различает
// строки между собой. Полная дата с временем есть в подсказке под курсором.
//
// Разбор давности — отдельная функция: границы суток и года легко испортить
// молча, а часовой пояс и переход на летнее время делают арифметику «в
// миллисекундах» неверной. Сравниваются календарные поля, а не разности.

/** Метка времени, которой можно верить: у старых записей её просто нет. */
const valid = (ts) => typeof ts === 'number' && Number.isFinite(ts) && ts > 0;

/** Один и тот же календарный день. */
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * Насколько давно это было: 'time' — сегодня, 'day' — в этом году,
 * 'year' — раньше. Для пустой или испорченной метки — null.
 * @param {unknown} ts метка времени в миллисекундах
 * @param {number} [now]
 * @returns {'time' | 'day' | 'year' | null}
 */
export function whenKind(ts, now = Date.now()) {
  if (!valid(ts)) return null;
  const then = new Date(ts);
  const today = new Date(now);
  if (sameDay(then, today)) return 'time';
  if (then.getFullYear() === today.getFullYear()) return 'day';
  return 'year';
}

/** Что показывать при каждой давности. */
const PARTS = {
  time: { hour: '2-digit', minute: '2-digit' },
  day: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  year: { day: 'numeric', month: 'short', year: 'numeric' },
};

const FULL = {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** Язык словаря — он же язык даты; незнакомый код — русский, как и строки. */
const locale = (lang) => (lang === 'en' ? 'en' : 'ru');

/**
 * Короткая строка для столбца. Неизвестную метку показывать нечем — тогда
 * столбец у этой строки остаётся пустым.
 * @param {unknown} ts
 * @param {string} [lang]
 * @param {number} [now]
 */
export function formatWhen(ts, lang = 'ru', now = Date.now()) {
  const kind = whenKind(ts, now);
  if (!kind) return '';
  return new Intl.DateTimeFormat(locale(lang), PARTS[kind]).format(new Date(ts));
}

/** Полная дата с временем — для подсказки под курсором. */
export function formatFull(ts, lang = 'ru') {
  if (!valid(ts)) return '';
  return new Intl.DateTimeFormat(locale(lang), FULL).format(new Date(ts));
}
