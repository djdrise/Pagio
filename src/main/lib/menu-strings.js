'use strict';

// Строки меню и системных диалогов. Меню живёт в главном процессе, поэтому его
// словарь отдельный от оконного: общих строк там всего несколько, а связывать
// два процесса одним файлом пришлось бы через сборку — ни CommonJS, ни ES-модуль
// не читаются обоими напрямую.

const menu = {
  ru: {
    file: 'Файл',
    open: 'Открыть…',
    recent: 'Недавние',
    recentEmpty: 'Пусто',
    closeTab: 'Закрыть вкладку',
    print: 'Печать…',
    quit: 'Выход',
    edit: 'Правка',
    copy: 'Копировать',
    selectAll: 'Выделить всё',
    find: 'Найти…',
    findNext: 'Найти далее',
    view: 'Вид',
    zoomIn: 'Увеличить',
    zoomOut: 'Уменьшить',
    zoomReset: 'Исходный размер',
    fitWidth: 'По ширине страницы',
    fitPage: 'Страница целиком',
    rotateRight: 'Повернуть вправо',
    rotateLeft: 'Повернуть влево',
    sidebar: 'Боковая панель',
    fullScreen: 'Во весь экран',
    present: 'Показ (и Ctrl+L)',
    prefs: 'Параметры…',
    go: 'Переход',
    first: 'В начало',
    last: 'В конец',
    goPage: 'Перейти к странице…',
    nextTab: 'Следующая вкладка',
    prevTab: 'Предыдущая вкладка',
    openTitle: 'Открыть PDF',
    openError: 'Не удалось открыть файл',
  },
  en: {
    file: 'File',
    open: 'Open…',
    recent: 'Recent',
    recentEmpty: 'Empty',
    closeTab: 'Close tab',
    print: 'Print…',
    quit: 'Quit',
    edit: 'Edit',
    copy: 'Copy',
    selectAll: 'Select all',
    find: 'Find…',
    findNext: 'Find next',
    view: 'View',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Actual size',
    fitWidth: 'Fit page width',
    fitPage: 'Fit whole page',
    rotateRight: 'Rotate right',
    rotateLeft: 'Rotate left',
    sidebar: 'Sidebar',
    fullScreen: 'Full screen',
    present: 'Presentation (or Ctrl+L)',
    prefs: 'Settings…',
    go: 'Go',
    first: 'To the beginning',
    last: 'To the end',
    goPage: 'Go to page…',
    nextTab: 'Next tab',
    prevTab: 'Previous tab',
    openTitle: 'Open PDF',
    openError: 'Could not open the file',
  },
};

/** Словарь по коду языка; незнакомый код — русский. */
const pick = (lang) => menu[lang] || menu.ru;

module.exports = { menu, pick, LANGS: Object.keys(menu) };
