'use strict';

// Список недавних файлов: чистая часть, без файловой системы.
//
// Вынесено отдельно, потому что правила тут неочевидные и легко испортить
// молча: повторное открытие не должно плодить дубликаты, список не должен
// расти без предела, а самый свежий файл обязан быть первым.

const LIMIT = 12;

/**
 * Добавляет файл в начало списка и помечает временем открытия. Повторное
 * открытие метку обновляет: в списке стоит время последнего раза, а не первого.
 * Записи, сделанные до появления метки, остаются без неё — столбец времени у
 * них будет пуст, но открываются они по-прежнему.
 * @param {{path: string, name: string, openedAt?: number}[]} list
 * @param {{path: string, name: string}} item
 * @param {number} [limit]
 * @param {number} [now]
 */
function remember(list, item, limit = LIMIT, now = Date.now()) {
  if (!item?.path) return list;
  const rest = list.filter((x) => x.path !== item.path);
  return [{ path: item.path, name: item.name, openedAt: now }, ...rest].slice(0, limit);
}

/** Убирает то, чего больше нет на диске. */
function keepExisting(list, exists) {
  return list.filter((x) => exists(x.path));
}

module.exports = { remember, keepExisting, LIMIT };
