'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { thumbKey, overBudget } = require('./lib/thumbcache');
const { remember, keepExisting } = require('./lib/recent');
const { pick: menuText, LANGS } = require('./lib/menu-strings');

const IS_DEV = process.argv.includes('--dev');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');
// Значок окна нужен Windows и Linux во время работы; в собранной программе
// его же берёт панель задач. macOS берёт значок из бандла и это поле не читает.
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon-256.png');

/** @type {BrowserWindow|null} */ let win = null;

// Открытых документов может быть несколько: в окне у каждого своя вкладка.
// Главный процесс держит только сведения о файле — сам PDF разбирает окно.
/** @type {Map<string, {id: string, path: string, name: string, length: number}>} */
const docs = new Map();
let nextDocId = 1;

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
// Недавние файлы и место, где пользователь остановился в каждом документе.
// Всё в одном файле: настроек мало, а отдельная база тут была бы лишней.

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

/** Параметры программы и их значения по умолчанию. */
const DEFAULT_PREFS = {
  /** Чем заливать пустоту вокруг слайда в режиме показа: 'black' | 'white'. */
  presentBg: 'black',
  /** Язык программы: 'ru' | 'en'. */
  lang: 'ru',
  /** Открывать при запуске документы, что были открыты в прошлый раз. */
  reopen: false,
};

let settings = {
  recent: [],
  views: {},
  prefs: { ...DEFAULT_PREFS },
  /** Размер и положение окна с прошлого раза. */
  window: null,
  /** Что было открыто во вкладках, когда программу закрыли. */
  session: [],
};

/**
 * Оставляет из прочитанного только известные значения. Файл настроек правят
 * руками, и чужая строка не должна дойти до окна: там она попадёт в селектор
 * и уронит применение параметров целиком.
 */
function cleanPrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (PREF_VALUES[key]?.includes(value)) out[key] = value;
  }
  return out;
}

function loadSettings() {
  try {
    const saved = JSON.parse(fsSync.readFileSync(settingsFile(), 'utf8'));
    settings = {
      recent: Array.isArray(saved.recent) ? saved.recent : [],
      views: saved.views && typeof saved.views === 'object' ? saved.views : {},
      prefs: cleanPrefs(saved.prefs),
      window: saved.window && typeof saved.window === 'object' ? saved.window : null,
      session: Array.isArray(saved.session) ? saved.session.filter((p) => typeof p === 'string') : [],
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
/**
 * Годится ли запомненное положение сейчас. Монитор могли отключить, а
 * разрешение сменить: окно, открытое за краем рабочего стола, пользователь не
 * увидит и не достанет.
 */
function onScreen(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    // Треть окна на виду — этого хватает, чтобы его схватить мышью.
    return overlapX > bounds.width / 3 && overlapY > 40;
  });
}

/** Пишем размеры не на каждый пиксель перетаскивания, а когда оно закончилось. */
let boundsTimer = null;

function rememberBounds() {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isFullScreen()) return;
    settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveSettings();
  }, 500);
}

function createWindow() {
  const saved = settings.window;
  const useSaved = onScreen(saved);

  win = new BrowserWindow({
    width: saved?.width || 1200,
    height: saved?.height || 820,
    ...(useSaved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#f3f4f6',
    icon: ICON,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  if (saved?.maximized) win.maximize();

  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);

  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Окно загрузилось заново — в режиме разработки по F5 или после сбоя
  // отрисовки. Вкладки исчезли вместе с ним, поэтому и список открытых
  // документов надо забыть: иначе повторное открытие того же файла ушло бы
  // переходом в несуществующую вкладку, и файл больше не открылся бы вовсе.
  win.webContents.on('did-finish-load', () => {
    docs.clear();
    statCache.clear();
  });

  win.on('closed', () => {
    win = null;
  });
  // Полноэкранный режим включают не только из программы: есть кнопка заголовка
  // и системные сочетания. Сообщаем окну о каждой смене, иначе его
  // представление о себе разойдётся с действительностью и следующее нажатие
  // F11 пришлось бы делать дважды.
  const fullScreen = (on) => () =>
    win?.webContents.send('command', { type: 'fullscreen:state', payload: { on } });
  win.on('enter-full-screen', fullScreen(true));
  win.on('leave-full-screen', fullScreen(false));

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
    if (!silent) dialog.showErrorBox(menuText(settings.prefs.lang).openError, `${full}\n\n${err.message}`);
    return false;
  }

  settings.recent = remember(settings.recent, { path: full, name: path.basename(full) });
  saveSettings();
  app.addRecentDocument(full);
  buildMenu(); // в подменю «Недавние» появился новый файл

  // Тот же файл уже открыт — вторая вкладка с ним ни к чему, просто идём в неё.
  const already = [...docs.values()].find((d) => d.path === full);
  if (already) {
    win?.webContents.send('command', { type: 'tab:focus', payload: { id: already.id } });
    return true;
  }

  const doc = { id: `d${nextDocId++}`, path: full, name: path.basename(full), length };
  docs.set(doc.id, doc);
  rememberSession();

  win?.webContents.send('document', {
    id: doc.id,
    name: doc.name,
    path: doc.path,
    length: doc.length,
    view: settings.views[viewKey(full)] || null,
  });
  return true;
}

async function openDialog() {
  const res = await dialog.showOpenDialog(win, {
    title: menuText(settings.prefs.lang).openTitle,
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
  // Заголовок окна ведёт активная вкладка: какой документ смотрят, знает окно.
  title: ({ text }) => win?.setTitle(text ? `${text} — Pagio` : 'Pagio'),
};

ipcMain.on('cmd', (_e, msg) => {
  commands[msg?.type]?.(msg.payload || {});
});

// ---------------------------------------------------------------------------
// Документ по кускам
// ---------------------------------------------------------------------------
ipcMain.handle('doc:source', (_e, id) => {
  const doc = docs.get(id);
  if (!doc) return null;
  return { id: doc.id, name: doc.name, length: doc.length };
});

ipcMain.handle('doc:range', async (_e, { id, begin, end }) => {
  const doc = docs.get(id);
  if (!doc) return null;
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

// Вкладку закрыли — файл больше не нужен ни окну, ни нам.
ipcMain.on('doc:close', (_e, id) => {
  docs.delete(id);
  statCache.delete(id);
  rememberSession();
});

/** Что открыто сейчас — чтобы при следующем запуске открыть то же самое. */
function rememberSession() {
  settings.session = [...docs.values()].map((d) => d.path);
  saveSettings();
}

// ---------------------------------------------------------------------------
// Недавние файлы и запомненное место
// ---------------------------------------------------------------------------
ipcMain.handle('recent:list', () => {
  settings.recent = keepExisting(settings.recent, (p) => fsSync.existsSync(p));
  return settings.recent;
});

ipcMain.handle('view:get', (_e, id) => {
  const doc = docs.get(id);
  if (!doc) return null;
  return settings.views[viewKey(doc.path)] || null;
});

ipcMain.on('view:set', (_e, { id, view }) => {
  const doc = docs.get(id);
  if (!doc || !view) return;
  settings.views[viewKey(doc.path)] = view;
  // Сохранений много не бывает, но и писать на каждый пиксель прокрутки незачем:
  // окно шлёт это редко, поэтому пишем сразу.
  saveSettings();
});

// ---------------------------------------------------------------------------
// Параметры программы
// ---------------------------------------------------------------------------
// Значения проверяем на входе: файл настроек правят руками, и мусор из него не
// должен доходить до окна.
const PREF_VALUES = { presentBg: ['black', 'white'], lang: LANGS, reopen: [true, false] };

ipcMain.handle('prefs:get', () => settings.prefs);

ipcMain.on('prefs:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (PREF_VALUES[key]?.includes(value) && settings.prefs[key] !== value) {
      settings.prefs[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  saveSettings();
  buildMenu(); // язык мог измениться — меню собирается заново
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
  const doc = docs.get(id);
  if (!doc) return null;
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
  const doc = docs.get(id);
  if (!doc || typeof dataUrl !== 'string') return false;
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

ipcMain.handle('doc:print', async (_e, { id, pages, rotation = 0 }) => {
  const doc = docs.get(id);
  if (!doc) return { ok: false, error: 'документ не открыт' };
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

  const query = new URLSearchParams({ id, pages: pages.join(','), rotation: String(rotation) });
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
  const m = menuText(settings.prefs.lang);
  const recentItems = settings.recent.length
    ? settings.recent.map((item) => ({ label: item.name, click: () => openPath(item.path) }))
    : [{ label: m.recentEmpty, enabled: false }];

  const template = [
    {
      label: m.file,
      submenu: [
        { label: m.open, accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { label: m.recent, submenu: recentItems },
        { type: 'separator' },
        { label: m.closeTab, accelerator: 'CmdOrCtrl+W', click: send('tab:close') },
        { type: 'separator' },
        { label: m.print, accelerator: 'CmdOrCtrl+P', click: send('print') },
        { type: 'separator' },
        { role: 'quit', label: m.quit },
      ],
    },
    {
      label: m.edit,
      submenu: [
        { role: 'copy', label: m.copy },
        { role: 'selectAll', label: m.selectAll },
        { type: 'separator' },
        { label: m.find, accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: m.findNext, accelerator: 'F3', click: send('find:next') },
      ],
    },
    {
      label: m.view,
      submenu: [
        { label: m.zoomIn, accelerator: 'CmdOrCtrl+=', click: send('zoom:in') },
        { label: m.zoomOut, accelerator: 'CmdOrCtrl+-', click: send('zoom:out') },
        { label: m.zoomReset, accelerator: 'CmdOrCtrl+0', click: send('zoom:reset') },
        { type: 'separator' },
        { label: m.fitWidth, click: send('fit:width') },
        { label: m.fitPage, click: send('fit:page') },
        { type: 'separator' },
        { label: m.rotateRight, accelerator: 'CmdOrCtrl+Shift+R', click: send('rotate:right') },
        { label: m.rotateLeft, accelerator: 'CmdOrCtrl+Shift+L', click: send('rotate:left') },
        { type: 'separator' },
        { label: m.sidebar, accelerator: 'F4', click: send('sidebar:toggle') },
        { label: m.fullScreen, accelerator: 'F11', click: send('fullscreen:toggle') },
        // Ctrl+L для того же показа разбирает само окно: у пункта меню
        // сочетание может быть только одно.
        { label: m.present, accelerator: 'F5', click: send('present:toggle') },
        { type: 'separator' },
        { label: m.prefs, click: send('prefs:open') },
        ...(IS_DEV ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: m.go,
      submenu: [
        { label: m.first, accelerator: 'CmdOrCtrl+Home', click: send('go:first') },
        { label: m.last, accelerator: 'CmdOrCtrl+End', click: send('go:last') },
        { type: 'separator' },
        { label: m.goPage, accelerator: 'CmdOrCtrl+G', click: send('go:prompt') },
        { type: 'separator' },
        // Именно Ctrl, а не CmdOrCtrl: Cmd+Tab на macOS занят переключением
        // программ, а Ctrl+Tab листает вкладки одинаково во всех системах.
        { label: m.nextTab, accelerator: 'Ctrl+Tab', click: send('tab:next') },
        { label: m.prevTab, accelerator: 'Ctrl+Shift+Tab', click: send('tab:prev') },
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

if (process.platform === 'win32') app.setAppUserModelId('dev.pautov.pagio');

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

  win.webContents.once('did-finish-load', async () => {
    // Сперва прошлые вкладки, потом файл из командной строки: он открывается
    // последним и оказывается активным — открывали ведь именно его.
    if (settings.prefs.reopen) {
      for (const file of [...settings.session]) await openPath(file, { silent: true });
    }
    if (pendingFile) await openPath(pendingFile);
  });
});

// На macOS программа переживает закрытие окна: там её закрывают через меню,
// а щелчок по значку в доке должен вернуть окно. На остальных системах
// последнее закрытое окно означает выход.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (win) win.focus();
  else {
    createWindow();
    buildMenu(); // меню собрано под окно, которого больше нет
  }
});
