'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { thumbKey, overBudget } = require('./lib/thumbcache');
const { remember, keepExisting } = require('./lib/recent');

const IS_DEV = process.argv.includes('--dev');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

/** @type {BrowserWindow|null} */ let win = null;
/** @type {{id: string, path: string, name: string, length: number}|null} */ let doc = null;
let nextDocId = 1;

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
// Недавние файлы и место, где пользователь остановился в каждом документе.
// Всё в одном файле: настроек мало, а отдельная база тут была бы лишней.

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { recent: [], views: {} };

function loadSettings() {
  try {
    const saved = JSON.parse(fsSync.readFileSync(settingsFile(), 'utf8'));
    settings = {
      recent: Array.isArray(saved.recent) ? saved.recent : [],
      views: saved.views && typeof saved.views === 'object' ? saved.views : {},
    };
  } catch {
    // Первый запуск или испорченный файл — начинаем с чистого листа.
  }
  settings.recent = keepExisting(settings.recent, (p) => fsSync.existsSync(p));
}

function saveSettings() {
  try {
    fsSync.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    // Не смогли сохранить — это не повод мешать работе с документом.
  }
}

/** Ключ документа для запомненного места: путь плюс время правки. */
const viewKey = (filePath) => {
  try {
    const st = fsSync.statSync(filePath);
    return `${filePath}:${Math.round(st.mtimeMs)}`;
  } catch {
    return filePath;
  }
};

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#f3f4f6',
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });

  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });
  // Ссылки из документа открываем во внешнем браузере, а не подменяем ими окно.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

const send = (type, payload) => () => win?.webContents.send('command', { type, payload });

// ---------------------------------------------------------------------------
// Открытие документа
// ---------------------------------------------------------------------------
async function openPath(filePath, { silent = false } = {}) {
  const full = path.resolve(filePath);
  let length;
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) throw new Error('это не файл');
    length = st.size;
  } catch (err) {
    if (!silent) dialog.showErrorBox('Не удалось открыть файл', `${full}\n\n${err.message}`);
    return false;
  }

  doc = { id: `d${nextDocId++}`, path: full, name: path.basename(full), length };
  settings.recent = remember(settings.recent, { path: full, name: doc.name });
  saveSettings();
  app.addRecentDocument(full);
  buildMenu(); // в подменю «Недавние» появился новый файл

  win?.webContents.send('document', {
    id: doc.id,
    name: doc.name,
    path: doc.path,
    length: doc.length,
    view: settings.views[viewKey(full)] || null,
  });
  win?.setTitle(`${doc.name} — PDFReader`);
  return true;
}

async function openDialog() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Открыть PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return;
  await openPath(res.filePaths[0]);
}

// ---------------------------------------------------------------------------
// Команды от окна
// ---------------------------------------------------------------------------
const commands = {
  open: () => openDialog(),
  openPath: ({ path: p }) => openPath(p),
  fullscreen: ({ on }) => win?.setFullScreen(Boolean(on)),
};

ipcMain.on('cmd', (_e, msg) => {
  commands[msg?.type]?.(msg.payload || {});
});

// ---------------------------------------------------------------------------
// Документ по кускам
// ---------------------------------------------------------------------------
ipcMain.handle('doc:source', (_e, id) => {
  if (!doc || doc.id !== id) return null;
  return { id: doc.id, name: doc.name, length: doc.length };
});

ipcMain.handle('doc:range', async (_e, { id, begin, end }) => {
  if (!doc || doc.id !== id) return null;
  let handle;
  try {
    handle = await fs.open(doc.path, 'r');
    const length = Math.max(0, end - begin);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, begin);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
});

// ---------------------------------------------------------------------------
// Недавние файлы и запомненное место
// ---------------------------------------------------------------------------
ipcMain.handle('recent:list', () => {
  settings.recent = keepExisting(settings.recent, (p) => fsSync.existsSync(p));
  return settings.recent;
});

ipcMain.handle('view:get', (_e, id) => {
  if (!doc || doc.id !== id) return null;
  return settings.views[viewKey(doc.path)] || null;
});

ipcMain.on('view:set', (_e, { id, view }) => {
  if (!doc || doc.id !== id || !view) return;
  settings.views[viewKey(doc.path)] = view;
  // Сохранений много не бывает, но и писать на каждый пиксель прокрутки незачем:
  // окно шлёт это редко, поэтому пишем сразу.
  saveSettings();
});

// ---------------------------------------------------------------------------
// Кэш миниатюр на диске
// ---------------------------------------------------------------------------
const thumbsDir = () => path.join(app.getPath('userData'), 'thumbs');
const statCache = new Map();

async function docStat(target) {
  const cached = statCache.get(target.id);
  if (cached) return cached;
  const st = await fs.stat(target.path);
  const value = { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
  statCache.set(target.id, value);
  return value;
}

ipcMain.handle('thumb:get', async (_e, { id, page, width }) => {
  if (!doc || doc.id !== id) return null;
  try {
    const file = path.join(thumbsDir(), thumbKey(await docStat(doc), page, width));
    const data = await fs.readFile(file);
    fs.utimes(file, new Date(), new Date()).catch(() => {});
    return `data:image/jpeg;base64,${data.toString('base64')}`;
  } catch {
    return null; // промах кэша — обычное дело
  }
});

let writesSinceSweep = 0;

ipcMain.handle('thumb:put', async (_e, { id, page, width, dataUrl }) => {
  if (!doc || doc.id !== id || typeof dataUrl !== 'string') return false;
  try {
    const dir = thumbsDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, thumbKey(await docStat(doc), page, width));
    await fs.writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    if ((writesSinceSweep += 1) >= 200) {
      writesSinceSweep = 0;
      sweepThumbs().catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
});

async function sweepThumbs() {
  const dir = thumbsDir();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const files = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      files.push({ name, size: st.size, atimeMs: st.atimeMs });
    } catch {}
  }
  for (const name of overBudget(files)) {
    await fs.unlink(path.join(dir, name)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Печать
// ---------------------------------------------------------------------------
// Печатаем не то, что на экране, а сам документ: отдельное скрытое окно рисует
// нужные страницы в полном размере и уходит в системный диалог печати. Иначе на
// бумагу попали бы полосы прокрутки и боковая панель.

/** @type {BrowserWindow|null} */ let printWin = null;

ipcMain.handle('doc:print', async (_e, { id, pages }) => {
  if (!doc || doc.id !== id) return { ok: false, error: 'документ не открыт' };
  if (printWin) return { ok: false, error: 'печать уже идёт' };
  if (!Array.isArray(pages) || !pages.length) return { ok: false, error: 'нечего печатать' };

  printWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });

  const ready = new Promise((resolve) => {
    ipcMain.once('print:ready', resolve);
    // Не ждём вечно: сломанная страница не должна подвешивать печать.
    setTimeout(resolve, 30000);
  });

  const query = new URLSearchParams({ id, pages: pages.join(',') });
  await printWin.loadFile(path.join(RENDERER, 'print.html'), { search: query.toString() });
  await ready;

  return new Promise((resolve) => {
    printWin.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
      printWin?.destroy();
      printWin = null;
      resolve({ ok, error: ok ? null : reason });
    });
  });
});

// ---------------------------------------------------------------------------
// Меню
// ---------------------------------------------------------------------------
function buildMenu() {
  const recentItems = settings.recent.length
    ? settings.recent.map((item) => ({ label: item.name, click: () => openPath(item.path) }))
    : [{ label: 'Пусто', enabled: false }];

  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { label: 'Недавние', submenu: recentItems },
        { type: 'separator' },
        { label: 'Печать…', accelerator: 'CmdOrCtrl+P', click: send('print') },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'copy', label: 'Копировать' },
        { role: 'selectAll', label: 'Выделить всё' },
        { type: 'separator' },
        { label: 'Найти…', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: 'Найти далее', accelerator: 'F3', click: send('find:next') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Увеличить', accelerator: 'CmdOrCtrl+=', click: send('zoom:in') },
        { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: send('zoom:out') },
        { label: 'Исходный размер', accelerator: 'CmdOrCtrl+0', click: send('zoom:reset') },
        { type: 'separator' },
        { label: 'По ширине страницы', click: send('fit:width') },
        { label: 'Страница целиком', click: send('fit:page') },
        { type: 'separator' },
        { label: 'Боковая панель', accelerator: 'F4', click: send('sidebar:toggle') },
        { label: 'Во весь экран', accelerator: 'F11', click: send('fullscreen:toggle') },
        ...(IS_DEV ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Переход',
      submenu: [
        { label: 'В начало', accelerator: 'CmdOrCtrl+Home', click: send('go:first') },
        { label: 'В конец', accelerator: 'CmdOrCtrl+End', click: send('go:last') },
        { type: 'separator' },
        { label: 'Перейти к странице…', accelerator: 'CmdOrCtrl+G', click: send('go:prompt') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Жизненный цикл
// ---------------------------------------------------------------------------
let pendingFile = process.argv.slice(1).find((a) => a.toLowerCase().endsWith('.pdf')) || null;

app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (app.isReady()) openPath(filePath);
  else pendingFile = filePath;
});

if (process.platform === 'win32') app.setAppUserModelId('dev.pautov.pdfreader');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = argv.find((a) => a.toLowerCase().endsWith('.pdf'));
    if (file) openPath(file);
    win?.focus();
  });
}

app.whenReady().then(() => {
  loadSettings();
  sweepThumbs().catch(() => {});
  createWindow();
  buildMenu();

  if (pendingFile) {
    win.webContents.once('did-finish-load', () => openPath(pendingFile));
  }
});

app.on('window-all-closed', () => app.quit());
