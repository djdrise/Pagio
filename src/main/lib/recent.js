'use strict';

// Список недавних файлов: чистая часть, без файловой системы.
//
// Вынесено отдельно, потому что правила тут неочевидные и легко испортить
// молча: повторное открытие не должно плодить дубликаты, список не должен
// расти без предела, а самый свежий файл обязан быть первым.

const LIMIT = 12;

/**
 * Добавляет файл в начало списка.
 * @param {{path: string, name: string}[]} list
 * @param {{path: string, name: string}} item
 * @param {number} [limit]
 */
function remember(list, item, limit = LIMIT) {
  if (!item?.path) return list;
  const rest = list.filter((x) => x.path !== item.path);
  return [{ path: item.path, name: item.name }, ...rest].slice(0, limit);
}

/** Убирает то, чего больше нет на диске. */
function keepExisting(list, exists) {
  return list.filter((x) => exists(x.path));
}

module.exports = { remember, keepExisting, LIMIT };
