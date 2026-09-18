'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('reader', {
  /** Размер открытого документа; байты окно потом берёт кусками. */
  docSource: (id) => ipcRenderer.invoke('doc:source', id),

  /** Кусок документа [begin, end) — по нему pdf.js читает ровно нужное. */
  docRange: (id, begin, end) => ipcRenderer.invoke('doc:range', { id, begin, end }),

  /** Миниатюра из кэша на диске: data:URL или null. */
  thumbGet: (id, page, width) => ipcRenderer.invoke('thumb:get', { id, page, width }),
  thumbPut: (id, page, width, dataUrl) =>
    ipcRenderer.invoke('thumb:put', { id, page, width, dataUrl }),

  /** Диалог открытия файла и открытие по известному пути. */
  openDialog: () => ipcRenderer.send('cmd', { type: 'open' }),
  openPath: (path) => ipcRenderer.send('cmd', { type: 'openPath', payload: { path } }),

  /** Вкладку закрыли: главному процессу этот документ больше не нужен. */
  closeDoc: (id) => ipcRenderer.send('doc:close', id),

  /** Заголовок окна по активной вкладке; null — ни одного документа. */
  setTitle: (text) => ipcRenderer.send('cmd', { type: 'title', payload: { text } }),

  /** Печать перечисленных страниц, номера с единицы; поворот — как на экране. */
  print: (id, pages, rotation) => ipcRenderer.invoke('doc:print', { id, pages, rotation }),

  /** Страница печати сообщает, что все листы отрисованы. */
  printReady: () => ipcRenderer.send('print:ready'),

  /** Список недавних файлов для пустого экрана. */
  recent: () => ipcRenderer.invoke('recent:list'),

  /** Параметры программы: читаем при запуске, пишем при изменении. */
  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (patch) => ipcRenderer.send('prefs:set', patch),

  /** Где пользователь остановился в этом документе — чтобы вернуться туда же. */
  viewGet: (id) => ipcRenderer.invoke('view:get', id),
  viewSet: (id, view) => ipcRenderer.send('view:set', { id, view }),

  /** Полноэкранный режим окна. */
  setFullScreen: (on) => ipcRenderer.send('cmd', { type: 'fullscreen', payload: { on } }),

  /** Путь к файлу из drag&drop: File.path в Electron больше не доступен. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  /** Документ открыт в главном процессе — окну пора его загрузить. */
  onDocument: (cb) => {
    const h = (_e, doc) => cb(doc);
    ipcRenderer.on('document', h);
    return () => ipcRenderer.off('document', h);
  },

  /** Команда из меню. */
  onCommand: (cb) => {
    const h = (_e, msg) => cb(msg.type, msg.payload);
    ipcRenderer.on('command', h);
    return () => ipcRenderer.off('command', h);
  },
});
