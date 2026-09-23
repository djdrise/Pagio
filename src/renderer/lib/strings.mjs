// Строки окна на двух языках.
//
// Русский — основной: он же записан в разметке, поэтому при сбое словаря окно
// останется работоспособным. Английский — перевод. Строки с подстановками
// хранятся функциями: порядок слов в языках разный, и склеивать их на месте
// вызова значило бы переводить по частям.

/** @type {Record<string, Record<string, string | Function>>} */
export const dict = {
  ru: {
    'tool.sidebar': 'Боковая панель (F4)',
    'tool.sidebarAria': 'Боковая панель',
    'tool.open': 'Открыть (Ctrl+O)',
    'tool.openAria': 'Открыть',
    'tool.prev': 'Предыдущая страница',
    'tool.next': 'Следующая страница',
    'tool.pageAria': 'Номер страницы',
    'tool.zoomOut': 'Уменьшить (Ctrl+-)',
    'tool.zoomIn': 'Увеличить (Ctrl+=)',
    'tool.zoomAria': 'Масштаб',
    'tool.rotate': 'Повернуть вправо (Ctrl+Shift+R)',
    'tool.rotateAria': 'Повернуть вправо',
    'tool.find': 'Найти (Ctrl+F)',
    'tool.findAria': 'Найти',
    'tool.print': 'Печать (Ctrl+P)',
    'tool.printAria': 'Печать',
    'tool.full': 'Во весь экран (F11)',
    'tool.prefs': 'Параметры',
    'tool.help': 'Справка',

    'zoom.fitWidth': 'По ширине',
    'zoom.fitPage': 'Страница целиком',

    'find.ph': 'Найти в документе',
    'find.prev': 'Предыдущее совпадение',
    'find.next': 'Следующее совпадение',
    'find.close': 'Закрыть поиск',
    'find.searching': 'поиск…',
    'find.none': 'не найдено',
    'find.count': (i, n) => `${i} из ${n}`,
    'find.counting': (i, n) => `${i} из ${n}…`,
    'find.scan': (n, total) => `поиск… ${n}/${total}`,

    'tabs.aria': 'Открытые документы',
    'tab.new': 'Открыть документ (Ctrl+O)',
    'tab.newAria': 'Открыть документ',
    'tab.close': 'Закрыть вкладку (Ctrl+W)',
    'tab.closeAria': (name) => `Закрыть ${name}`,

    'side.pages': 'Страницы',
    'side.outline': 'Оглавление',
    'outline.empty': 'В документе нет оглавления.',
    'outline.untitled': '(без названия)',

    'empty.text': 'Откройте документ или перетащите его в окно.',
    'empty.open': 'Открыть PDF',
    'recent.title': 'Недавние',
    'doc.error': (name) => `Не удалось открыть «${name}». Возможно, файл повреждён.`,

    'print.title': 'Печать',
    'print.all': 'Все страницы',
    'print.current': 'Текущая страница',
    'print.from': 'С',
    'print.to': 'по',
    'print.fromAria': 'С какой страницы',
    'print.toAria': 'По какую страницу',
    'print.cancel': 'Отмена',
    'print.go': 'Печать',
    'print.range': (n) => `Укажите страницы от 1 до ${n}, начало не больше конца.`,

    'prefs.title': 'Параметры',
    'prefs.bg': 'Фон в режиме показа',
    'prefs.black': 'Чёрный',
    'prefs.white': 'Белый',
    'prefs.startup': 'При запуске',
    'prefs.reopen': 'Открывать последние документы',
    'prefs.lang': 'Язык программы',
    'prefs.langRu': 'Русский',
    'prefs.langEn': 'Английский',
    'prefs.done': 'Готово',

    'help.about':
      'Просмотрщик PDF: непрерывная лента страниц, вкладки, поиск по тексту, ' +
      'печать и показ на весь экран.',
    'help.keys': [
      ['Ctrl+O', 'открыть документ'],
      ['Ctrl+W', 'закрыть вкладку'],
      ['Ctrl+Tab', 'следующая вкладка'],
      ['→ ←', 'следующая, предыдущая страница'],
      ['Пробел', 'экран вперёд'],
      ['Ctrl+F · F3', 'найти, следующее совпадение'],
      ['Ctrl+= · Ctrl+− · Ctrl+0', 'масштаб: больше, меньше, исходный'],
      ['Ctrl+P', 'печать'],
      ['Ctrl+Shift+R · Ctrl+Shift+L', 'повернуть вправо, влево'],
      ['F4', 'боковая панель: страницы и оглавление'],
      ['F5 · Ctrl+L', 'показ: одна страница на весь экран'],
      ['F11', 'во весь экран'],
      ['Esc', 'закрыть поиск, выйти из показа'],
    ],
  },

  en: {
    'tool.sidebar': 'Sidebar (F4)',
    'tool.sidebarAria': 'Sidebar',
    'tool.open': 'Open (Ctrl+O)',
    'tool.openAria': 'Open',
    'tool.prev': 'Previous page',
    'tool.next': 'Next page',
    'tool.pageAria': 'Page number',
    'tool.zoomOut': 'Zoom out (Ctrl+-)',
    'tool.zoomIn': 'Zoom in (Ctrl+=)',
    'tool.zoomAria': 'Zoom',
    'tool.rotate': 'Rotate right (Ctrl+Shift+R)',
    'tool.rotateAria': 'Rotate right',
    'tool.find': 'Find (Ctrl+F)',
    'tool.findAria': 'Find',
    'tool.print': 'Print (Ctrl+P)',
    'tool.printAria': 'Print',
    'tool.full': 'Full screen (F11)',
    'tool.prefs': 'Settings',
    'tool.help': 'Help',

    'zoom.fitWidth': 'Fit width',
    'zoom.fitPage': 'Fit page',

    'find.ph': 'Find in document',
    'find.prev': 'Previous match',
    'find.next': 'Next match',
    'find.close': 'Close find',
    'find.searching': 'searching…',
    'find.none': 'not found',
    'find.count': (i, n) => `${i} of ${n}`,
    'find.counting': (i, n) => `${i} of ${n}…`,
    'find.scan': (n, total) => `searching… ${n}/${total}`,

    'tabs.aria': 'Open documents',
    'tab.new': 'Open document (Ctrl+O)',
    'tab.newAria': 'Open document',
    'tab.close': 'Close tab (Ctrl+W)',
    'tab.closeAria': (name) => `Close ${name}`,

    'side.pages': 'Pages',
    'side.outline': 'Outline',
    'outline.empty': 'This document has no outline.',
    'outline.untitled': '(untitled)',

    'empty.text': 'Open a document or drop one into the window.',
    'empty.open': 'Open PDF',
    'recent.title': 'Recent',
    'doc.error': (name) => `Could not open “${name}”. The file may be damaged.`,

    'print.title': 'Print',
    'print.all': 'All pages',
    'print.current': 'Current page',
    'print.from': 'From',
    'print.to': 'to',
    'print.fromAria': 'First page',
    'print.toAria': 'Last page',
    'print.cancel': 'Cancel',
    'print.go': 'Print',
    'print.range': (n) => `Enter pages from 1 to ${n}, the first not after the last.`,

    'prefs.title': 'Settings',
    'prefs.bg': 'Presentation background',
    'prefs.black': 'Black',
    'prefs.white': 'White',
    'prefs.startup': 'On start',
    'prefs.reopen': 'Reopen last documents',
    'prefs.lang': 'Language',
    'prefs.langRu': 'Russian',
    'prefs.langEn': 'English',
    'prefs.done': 'Done',

    'help.about':
      'A PDF viewer: continuous page ribbon, tabs, text search, printing and ' +
      'full-screen presentation.',
    'help.keys': [
      ['Ctrl+O', 'open a document'],
      ['Ctrl+W', 'close the tab'],
      ['Ctrl+Tab', 'next tab'],
      ['→ ←', 'next, previous page'],
      ['Space', 'one screen forward'],
      ['Ctrl+F · F3', 'find, next match'],
      ['Ctrl+= · Ctrl+− · Ctrl+0', 'zoom in, out, reset'],
      ['Ctrl+P', 'print'],
      ['Ctrl+Shift+R · Ctrl+Shift+L', 'rotate right, left'],
      ['F4', 'sidebar: pages and outline'],
      ['F5 · Ctrl+L', 'presentation: one page per screen'],
      ['F11', 'full screen'],
      ['Esc', 'close find, leave presentation'],
    ],
  },
};

export const LANGS = Object.keys(dict);

/** Словарь по коду языка; незнакомый код — русский. */
export const pick = (lang) => dict[lang] || dict.ru;
