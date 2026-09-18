// Окно просмотрщика: вкладки открытых документов, непрерывная лента страниц,
// масштаб, боковая панель, поиск и печать.
//
// Устройство ленты. Страницы не лежат в потоке одна за другой: их положение
// считает scrolllayout.mjs, а в DOM живут только те, что сейчас видно, плюс
// небольшой запас. Документ на тысячу страниц иначе не открыть — тысяча канв
// съест память до того, как пользователь доберётся до второй страницы.
//
// Устройство вкладок. Каждый открытый документ — отдельный сеанс со своим
// слоем ленты, своими миниатюрами, оглавлением, поиском и местом прокрутки.
// Всё это остаётся в DOM и при переходе на другую вкладку просто прячется:
// возврат тогда мгновенный, страницы уже нарисованы. Общими остаются панель
// инструментов и боковая панель — они показывают активный сеанс, на который
// указывает state.

import { loadDoc, renderPage, pageSize, textContent, TextLayer } from './lib/pdfdoc.js';
import {
  layoutPages,
  visibleRange,
  currentPage,
  fitScale,
  clampScale,
  keepAnchor,
  GAP,
  PADDING,
} from './lib/scrolllayout.mjs';
import { RenderQueue } from './lib/renderqueue.js';
import { ThumbStore } from './lib/thumbstore.js';
import { buildPageText, findMatches, spansForMatch } from './lib/search.mjs';
import { pick as pickDict } from './lib/strings.mjs';
import { formatWhen, formatFull } from './lib/when.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  scroller: $('scroller'),
  sidebar: $('sidebar'),
  thumbsHost: $('thumbs-host'),
  outlineHost: $('outline-host'),
  tabThumbs: $('tab-thumbs'),
  tabOutline: $('tab-outline'),
  tabbar: $('tabbar'),
  tabNew: $('tab-new'),
  pageInput: $('page-input'),
  pageCount: $('page-count'),
  zoom: $('zoom-select'),
  empty: $('empty'),
  emptyRecent: $('empty-recent'),
  findBox: $('find-box'),
  findInput: $('find-input'),
  findStatus: $('find-status'),
  printDialog: $('print-dialog'),
  printFrom: $('print-from'),
  printTo: $('print-to'),
  printError: $('print-error'),
  prefsDialog: $('prefs-dialog'),
  helpDialog: $('help-dialog'),
};

/** Все окна, которые закрываются по Esc и не должны быть открыты вдвоём. */
const DIALOGS = [els.printDialog, els.prefsDialog, els.helpDialog];

/** Кнопки и поля, которым нужен открытый документ. */
const DOC_TOOLS = [
  'btn-prev', 'btn-next', 'btn-zoom-in', 'btn-zoom-out', 'btn-rotate', 'btn-find', 'btn-print',
];

/** Ширина миниатюры в боковой панели, в CSS-пикселях. */
const THUMB_WIDTH = 180;
/** Сколько экранов страниц держим нарисованными сверх видимого. */
const OVERSCAN = 0.6;
/**
 * Сколько вкладок держат страницы нарисованными: та, что на виду, и та, с
 * которой на неё пришли. Канва страницы в масштабе «по ширине» весит десятки
 * мегабайт, и хранить её для каждой открытой вкладки нельзя — на десятке
 * документов окно съело бы полгигабайта. Остальные вкладки помнят своё место и
 * раскладку, а страницы рисуют заново при возвращении: это доли секунды.
 */
const KEEP_RENDERED = 2;

const pageQueue = new RenderQueue(4);
const thumbQueue = new RenderQueue(2);
const thumbs = new ThumbStore();

/** Открытые документы в порядке вкладок. @type {object[]} */
const tabs = [];
/** Активный сеанс; null — ни одного документа не открыто. @type {object|null} */
let state = null;
/** Общее для всех вкладок: боковая панель показывает активный документ. */
const ui = { sidebar: false, sidebarTab: 'thumbs', present: false };

/**
 * Поля вокруг ленты. В показе их нет, а под каждую страницу отведён ровно
 * экран: страница стоит в нём по центру, соседние оказываются точно за краями.
 * Это и даёт один слайд на экран при любой пропорции страницы — и у 16:9, и
 * у А4.
 */
const frame = () =>
  ui.present
    ? { gap: 0, padding: 0, slide: els.scroller.clientHeight }
    : { gap: GAP, padding: PADDING };

/**
 * Параметры программы. Общие для всех вкладок и хранятся в главном процессе:
 * окно получает их при запуске и сообщает туда каждое изменение.
 */
const prefs = { presentBg: 'black', lang: 'ru', reopen: false };

/** Текущий словарь. Русский лежит и в разметке — окно останется читаемым,
 *  даже если строка потеряется. */
let t = pickDict('ru');

/**
 * Что в разметке переводится: элемент, что именно у него менять и по какому
 * ключу. Держать это одной таблицей надёжнее, чем сорока атрибутами по
 * разметке: забытый элемент видно сразу, весь список перед глазами.
 */
const UI = [
  ['#btn-sidebar', 'title', 'tool.sidebar'], ['#btn-sidebar', 'aria', 'tool.sidebarAria'],
  ['#btn-open', 'title', 'tool.open'], ['#btn-open', 'aria', 'tool.openAria'],
  ['#btn-prev', 'title', 'tool.prev'], ['#btn-prev', 'aria', 'tool.prev'],
  ['#btn-next', 'title', 'tool.next'], ['#btn-next', 'aria', 'tool.next'],
  ['#page-input', 'aria', 'tool.pageAria'],
  ['#btn-zoom-out', 'title', 'tool.zoomOut'], ['#btn-zoom-out', 'aria', 'tool.zoomOut'],
  ['#btn-zoom-in', 'title', 'tool.zoomIn'], ['#btn-zoom-in', 'aria', 'tool.zoomIn'],
  ['#zoom-select', 'aria', 'tool.zoomAria'],
  ['#zoom-select option[value="fit-width"]', 'text', 'zoom.fitWidth'],
  ['#zoom-select option[value="fit-page"]', 'text', 'zoom.fitPage'],
  ['#btn-rotate', 'title', 'tool.rotate'], ['#btn-rotate', 'aria', 'tool.rotateAria'],
  ['#find-input', 'ph', 'find.ph'], ['#find-input', 'aria', 'find.ph'],
  ['#find-prev', 'title', 'find.prev'], ['#find-prev', 'aria', 'find.prev'],
  ['#find-next', 'title', 'find.next'], ['#find-next', 'aria', 'find.next'],
  ['#find-close', 'title', 'find.close'], ['#find-close', 'aria', 'find.close'],
  ['#btn-find', 'title', 'tool.find'], ['#btn-find', 'aria', 'tool.findAria'],
  ['#btn-print', 'title', 'tool.print'], ['#btn-print', 'aria', 'tool.printAria'],
  ['#btn-fullscreen', 'title', 'tool.full'], ['#btn-fullscreen', 'aria', 'tool.full'],
  ['#btn-prefs', 'title', 'tool.prefs'], ['#btn-prefs', 'aria', 'tool.prefs'],
  ['#btn-help', 'title', 'tool.help'], ['#btn-help', 'aria', 'tool.help'],
  ['#tabbar', 'aria', 'tabs.aria'],
  ['#tab-new', 'title', 'tab.new'], ['#tab-new', 'aria', 'tab.newAria'],
  ['#tab-thumbs', 'text', 'side.pages'], ['#tab-outline', 'text', 'side.outline'],
  ['#empty .empty-card p', 'text', 'empty.text'], ['#empty-open', 'text', 'empty.open'],
  ['#print-dialog h2', 'text', 'print.title'],
  ['#print-all-label', 'text', 'print.all'],
  ['#print-current-label', 'text', 'print.current'],
  ['#print-from', 'aria', 'print.fromAria'], ['#print-to', 'aria', 'print.toAria'],
  ['#print-cancel', 'text', 'print.cancel'], ['#print-go', 'text', 'print.go'],
  ['#prefs-title', 'text', 'prefs.title'],
  ['#prefs-bg-legend', 'text', 'prefs.bg'],
  ['#prefs-bg-black', 'text', 'prefs.black'], ['#prefs-bg-white', 'text', 'prefs.white'],
  ['#prefs-startup-legend', 'text', 'prefs.startup'],
  ['#prefs-reopen-label', 'text', 'prefs.reopen'],
  ['#prefs-lang-legend', 'text', 'prefs.lang'],
  ['#prefs-lang-ru', 'text', 'prefs.langRu'], ['#prefs-lang-en', 'text', 'prefs.langEn'],
  ['#prefs-close', 'text', 'prefs.done'], ['#help-close', 'text', 'prefs.done'],
  ['#help-about', 'text', 'help.about'],
  ['#print-dialog .modal-card', 'aria', 'print.title'],
  ['#prefs-dialog .modal-card', 'aria', 'prefs.title'],
  ['#help-dialog .modal-card', 'aria', 'tool.help'],
];

/** Подписи «С» и «по» в диалоге печати стоят вокруг полей — по порядку. */
const PRINT_RANGE_KEYS = ['print.from', 'print.to'];

function applyLang() {
  t = pickDict(prefs.lang);
  document.documentElement.lang = prefs.lang;

  for (const [selector, what, key] of UI) {
    const el = document.querySelector(selector);
    const value = t[key];
    if (!el || typeof value !== 'string') continue;
    if (what === 'text') el.textContent = value;
    else if (what === 'title') el.title = value;
    else if (what === 'aria') el.setAttribute('aria-label', value);
    else if (what === 'ph') el.placeholder = value;
  }

  const range = document.querySelectorAll('#print-dialog .radio:last-of-type span');
  range.forEach((el, i) => {
    const value = t[PRINT_RANGE_KEYS[i]];
    if (typeof value === 'string') el.textContent = value;
  });

  buildHelpKeys();
  const radio = document.querySelector(`input[name="lang"][value="${prefs.lang}"]`);
  if (radio) radio.checked = true;

  // Строки, которые уже нарисованы: их язык надо обновить сейчас, а не при
  // следующем событии.
  for (const session of tabs) {
    session.tabEl.querySelector('.tab-close').title = t['tab.close'];
    session.tabEl.querySelector('.tab-close').setAttribute('aria-label', t['tab.closeAria'](session.name));
    const empty = session.outlineEl.querySelector('.outline-empty');
    if (empty) empty.textContent = t['outline.empty'];
    const failed = session.sheet.querySelector('.doc-error');
    if (failed) failed.textContent = t['doc.error'](session.name);
  }
  if (state) showFindStatus(state);
  showRecent();
}

/** Список сочетаний в справке: два набора строк, поэтому строится из словаря. */
function buildHelpKeys() {
  const list = $('help-keys');
  if (!list) return;
  list.replaceChildren();
  for (const [keys, what] of t['help.keys']) {
    const dt = document.createElement('dt');
    // «Ctrl+O» и «Ctrl+F · F3» разбираем на отдельные клавиши: так они
    // выглядят клавишами, а не строкой текста.
    for (const part of keys.split(' ')) {
      if (part === '·') {
        dt.append(document.createTextNode(' · '));
        continue;
      }
      part.split('+').forEach((key, i) => {
        if (i) dt.append(document.createTextNode('+'));
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        dt.append(kbd);
      });
      dt.append(document.createTextNode(' '));
    }
    const dd = document.createElement('dd');
    dd.textContent = what;
    list.append(dt, dd);
  }
}

/** Чем заливать пустоту вокруг слайда: пропорция слайда редко равна экрану. */
const PRESENT_BG = { black: '#0b0d10', white: '#ffffff' };

function applyPrefs() {
  document.documentElement.style.setProperty(
    '--present-bg',
    PRESENT_BG[prefs.presentBg] || PRESENT_BG.black,
  );
  const radio = document.querySelector(`input[name="present-bg"][value="${prefs.presentBg}"]`);
  if (radio) radio.checked = true;
  $('prefs-reopen').checked = Boolean(prefs.reopen);
  applyLang();
}

function setPref(key, value) {
  if (prefs[key] === value) return;
  prefs[key] = value;
  applyPrefs();
  window.reader.prefsSet({ [key]: value });
}

// ---------------------------------------------------------------------------
// Окна поверх документа
// ---------------------------------------------------------------------------
function openDialog(dialog) {
  for (const other of DIALOGS) other.hidden = other !== dialog;
}

/** Закрывает открытое окно, если оно было. @returns {boolean} закрыли ли */
function closeDialogs() {
  const open = DIALOGS.find((d) => !d.hidden);
  if (open) open.hidden = true;
  return Boolean(open);
}

// ---------------------------------------------------------------------------
// Сеанс документа
// ---------------------------------------------------------------------------
function createSession(info) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.hidden = true;
  els.scroller.appendChild(sheet);

  const thumbsEl = document.createElement('div');
  thumbsEl.className = 'thumbs';
  thumbsEl.hidden = true;
  els.thumbsHost.appendChild(thumbsEl);

  const outlineEl = document.createElement('div');
  outlineEl.className = 'outline';
  outlineEl.hidden = true;
  els.outlineHost.appendChild(outlineEl);

  const session = {
    id: info.id,
    name: info.name,
    path: info.path,
    length: info.length,
    doc: null,
    pageCount: 0,
    /** Размеры страниц при масштабе 1; сначала все по первой странице. */
    sizes: [],
    layout: { pages: [], totalHeight: 0, totalWidth: 0 },
    scale: 1,
    /** 'fit-width' | 'fit-page' | 'custom' */
    mode: 'fit-width',
    /** Поворот документа на экране: 0, 90, 180 или 270 градусов. */
    rotation: 0,
    page: 1,
    scrollTop: 0,
    /** Страница → {el, canvas, textLayer, cancel, scale} */
    nodes: new Map(),
    find: { query: '', hits: [], index: -1, token: 0, open: false, stat: null },
    thumbNodes: new Map(),
    thumbJobs: new Map(),
    thumbsBuilt: false,
    /** @type {IntersectionObserver|null} следит за плитками панели миниатюр */
    thumbObserver: null,
    /** Отложенные дела этой вкладки: запись места и запуск поиска. */
    saveTimer: null,
    findTimer: null,
    /** Документ не открылся — показывать «…» вместо числа страниц незачем. */
    failed: false,
    /** Место, куда вернуться при открытии; забываем, как только вернулись. */
    restoreView: info.view || null,
    /** Когда на вкладке были в последний раз — по этому решаем, чьи страницы отпустить. */
    usedAt: 0,
    /** Раскладка устарела, пока вкладка была в стороне. */
    dirty: false,
    laidOut: false,
    closed: false,
    sheet,
    thumbsEl,
    outlineEl,
    tabEl: null,
  };
  session.tabEl = createTabEl(session);
  return session;
}

function destroySession(session) {
  session.closed = true;
  clearTimeout(session.saveTimer);
  clearTimeout(session.findTimer);
  releaseNodes(session);
  session.thumbObserver?.disconnect();
  session.thumbObserver = null;
  for (const cancel of session.thumbJobs.values()) cancel();
  session.thumbJobs.clear();
  session.thumbNodes.clear();
  thumbs.dropDoc(session.id);
  session.sheet.remove();
  session.thumbsEl.remove();
  session.outlineEl.remove();
  session.tabEl.remove();
  session.doc?.destroy?.();
  session.doc = null;
}

/** Отпускает нарисованные страницы сеанса, не трогая его место и раскладку. */
function releaseNodes(session) {
  for (const node of session.nodes.values()) {
    node.cancel?.();
    node.textLayer?.cancel?.();
    node.el.remove();
  }
  session.nodes.clear();
}

/** Оставляет канвы только у недавних вкладок — см. KEEP_RENDERED. */
function trimBackground() {
  const byUse = [...tabs].sort((a, b) => b.usedAt - a.usedAt);
  for (const session of byUse.slice(KEEP_RENDERED)) releaseNodes(session);
}

// ---------------------------------------------------------------------------
// Вкладки
// ---------------------------------------------------------------------------
function createTabEl(session) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.title = session.path || session.name;

  const label = document.createElement('button');
  label.className = 'tab-label';
  label.type = 'button';
  label.textContent = session.name;
  label.addEventListener('click', () => activate(session));

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.type = 'button';
  close.title = t['tab.close'];
  close.setAttribute('aria-label', t['tab.closeAria'](session.name));
  close.appendChild(closeIcon());
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(session);
  });

  // Средняя кнопка мыши закрывает вкладку — как принято везде, где есть вкладки.
  el.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    closeTab(session);
  });

  el.append(label, close);
  els.tabbar.insertBefore(el, els.tabNew);
  return el;
}

function closeIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('d', 'm5 5 10 10M15 5 5 15');
  svg.appendChild(path);
  return svg;
}

function renderTabs() {
  els.tabbar.hidden = !tabs.length;
  for (const session of tabs) {
    const current = session === state;
    session.tabEl.classList.toggle('current', current);
    session.tabEl.setAttribute('aria-selected', String(current));
  }
}

let useClock = 0;

/** Переключает окно на сеанс: прячет чужое, возвращает своё место прокрутки. */
function activate(session) {
  if (state === session) return;
  // Показ идёт для одного документа: уходим с него — показ закончен, и прежний
  // масштаб возвращается той вкладке, с которой его начинали.
  if (ui.present) togglePresent(false);
  if (state) state.scrollTop = els.scroller.scrollTop;

  state = session;
  session.usedAt = ++useClock;
  for (const other of tabs) {
    const current = other === session;
    other.sheet.hidden = !current;
    other.thumbsEl.hidden = !current;
    other.outlineEl.hidden = !current;
  }

  els.empty.hidden = true;
  // Высота ленты уже посчитана, поэтому прокрутка встаёт на прежнее место.
  els.scroller.scrollTop = session.scrollTop;

  if (session.doc && session.dirty) {
    session.dirty = false;
    if (session.laidOut) applyLayout({ keepPage: true });
    else firstLayout();
  }
  if (ui.sidebar && session.doc && !session.thumbsBuilt) buildThumbs();

  updateVisible();
  markCurrentThumb();
  syncChrome();
  renderTabs();
  trimBackground();
}

function closeTab(session) {
  const i = tabs.indexOf(session);
  if (i === -1) return;
  // Закрыли вкладку прямо из показа: сперва выходим из него, пока сеанс цел, —
  // иначе окно осталось бы без панелей и без документа под клавишами.
  if (ui.present && (session === state || tabs.length === 1)) togglePresent(false);

  tabs.splice(i, 1);
  // Порядок важен: место записываем, пока документ ещё открыт в главном
  // процессе, и только потом просим его закрыть.
  flushView(session);
  window.reader.closeDoc(session.id);
  destroySession(session);

  if (state === session) {
    state = null;
    // Уходим на соседнюю вкладку: сперва правую, потом левую.
    const next = tabs[i] || tabs[i - 1] || null;
    if (next) activate(next);
    else showEmpty();
  }
  renderTabs();
}

function stepTab(delta) {
  if (tabs.length < 2 || !state) return;
  const i = tabs.indexOf(state);
  activate(tabs[(i + delta + tabs.length) % tabs.length]);
}

function showEmpty() {
  els.empty.hidden = false;
  els.pageCount.textContent = '—';
  els.pageInput.value = '—';
  els.findBox.hidden = true;
  setDocTools(false);
  window.reader.setTitle(null);
  showRecent();
}

function setDocTools(on) {
  for (const id of DOC_TOOLS) $(id).disabled = !on;
  els.pageInput.disabled = !on;
  els.zoom.disabled = !on;
}

/** Приводит панель инструментов в соответствие с активным сеансом. */
function syncChrome() {
  if (!state) return;
  setDocTools(Boolean(state.doc));
  els.pageCount.textContent = state.doc ? String(state.pageCount) : state.failed ? '—' : '…';
  if (document.activeElement !== els.pageInput) {
    els.pageInput.value = state.doc ? String(state.page) : '—';
  }
  els.findBox.hidden = !state.find.open;
  els.findInput.value = state.find.query;
  showFindStatus(state);
  updateZoomControl();
  window.reader.setTitle(state.name);
}

// ---------------------------------------------------------------------------
// Открытие документа
// ---------------------------------------------------------------------------
async function openDocument(info) {
  const session = createSession(info);
  tabs.push(session);
  renderTabs();
  activate(session);

  let doc;
  try {
    doc = await loadDoc({ id: info.id, length: info.length });
  } catch (err) {
    showDocError(session, err);
    return;
  }
  if (session.closed) {
    doc.destroy?.();
    return;
  }

  session.doc = doc;
  session.pageCount = doc.numPages;

  // Размеры: сперва берём первую страницу и считаем остальные такими же —
  // документ открывается мгновенно. Настоящие размеры подтягиваем в фоне, и
  // лента перестраивается, если они отличаются.
  // Поворот восстанавливаем прежде размеров: они от него зависят.
  const view = session.restoreView;
  session.rotation = [90, 180, 270].includes(view?.rotation) ? view.rotation : 0;

  const first = await pageSize(doc, 1, session.rotation);
  if (session.closed) return;
  session.sizes = Array.from({ length: doc.numPages }, () => ({ ...first }));
  session.thumbsEl.style.setProperty('--page-aspect', `${first.width} / ${first.height}`);

  session.mode = view?.mode || 'fit-width';
  session.scale = view?.scale || 1;

  if (session === state) {
    syncChrome();
    firstLayout();
    if (ui.sidebar) buildThumbs();
  } else {
    session.dirty = true;
  }

  refineSizes(session);
  loadOutline(session);
}

/** Первая раскладка документа: сюда же возвращаем запомненное место. */
function firstLayout() {
  const view = state.restoreView;
  state.restoreView = null;
  state.laidOut = true;
  applyLayout({ keepPage: false });
  if (view?.page) goToPage(view.page, { save: false });
}

function showDocError(session, err) {
  console.error('не удалось открыть документ:', err);
  session.failed = true;
  session.sheet.replaceChildren();
  const box = document.createElement('p');
  box.className = 'doc-error';
  box.textContent = t['doc.error'](session.name);
  session.sheet.appendChild(box);
  if (session === state) syncChrome();
}

/**
 * Уточняет размеры страниц в фоне. Документы с однородными страницами — а это
 * почти все — от этого не меняются вовсе; смешанные (портрет и альбом вперемешку)
 * перестраиваются по мере поступления.
 */
async function refineSizes(session) {
  const doc = session.doc;
  const known = new Map();
  for (let n = 1; n <= doc.numPages; n++) {
    if (session.closed) return;
    try {
      const size = await pageSize(doc, n, session.rotation);
      const before = session.sizes[n - 1];
      if (Math.abs(before.width - size.width) > 0.5 || Math.abs(before.height - size.height) > 0.5) {
        known.set(n, size);
      }
    } catch {
      // Битая страница не должна останавливать остальные.
    }
    // Перестраиваем не на каждую страницу, а пачками: иначе лента дёргалась бы
    // под курсором всё время, пока идёт уточнение.
    if (known.size >= 8 || n === doc.numPages) {
      if (known.size) {
        for (const [num, size] of known) session.sizes[num - 1] = size;
        known.clear();
        relayout(session, { keepPage: true });
      }
    }
  }
}

/** Раскладывает сеанс, если он на виду; иначе откладывает до переключения. */
function relayout(session, opts) {
  if (session === state) applyLayout(opts);
  else session.dirty = true;
}

// ---------------------------------------------------------------------------
// Раскладка и прокрутка
// ---------------------------------------------------------------------------
function viewportSize() {
  return { width: els.scroller.clientWidth, height: els.scroller.clientHeight };
}

/** Пересчитывает масштаб под режим и раскладывает страницы заново. */
function applyLayout({ keepPage = true } = {}) {
  if (!state) return;
  if (!state.pageCount) {
    state.sheet.style.height = '0px';
    return;
  }

  const view = viewportSize();
  const box = frame();
  const anchorPage = keepPage ? state.page : 1;
  const anchorOffset = keepPage ? offsetInPage(anchorPage) : 0;

  if (state.mode !== 'custom') {
    const fit = state.mode === 'fit-page' ? 'page' : 'width';
    state.scale = fitScale(state.sizes[anchorPage - 1], view, fit, box);
  }

  state.layout = layoutPages(state.sizes, { scale: state.scale, viewportWidth: view.width, ...box });
  state.sheet.style.height = `${state.layout.totalHeight}px`;
  state.sheet.style.width = `${state.layout.totalWidth}px`;

  for (const [n, node] of state.nodes) placeNode(n, node);

  if (keepPage) {
    const page = state.layout.pages[anchorPage - 1];
    if (page) els.scroller.scrollTop = page.anchor + anchorOffset * state.scale;
  }

  updateVisible();
  updateZoomControl();
  if (document.activeElement !== els.pageInput) els.pageInput.value = String(state.page);
}

/** Насколько глубоко мы внутри текущей страницы, в единицах документа. */
function offsetInPage(n) {
  const page = state.layout.pages[n - 1];
  if (!page) return 0;
  return (els.scroller.scrollTop - page.anchor) / (state.scale || 1);
}

function placeNode(n, node) {
  const page = state.layout.pages[n - 1];
  if (!page) return;
  node.el.style.top = `${page.top}px`;
  node.el.style.left = `${page.left}px`;
  node.el.style.width = `${page.width}px`;
  node.el.style.height = `${page.height}px`;
}

let visibleScheduled = false;

function scheduleVisible() {
  if (visibleScheduled) return;
  visibleScheduled = true;
  requestAnimationFrame(() => {
    visibleScheduled = false;
    updateVisible();
  });
}

function updateVisible() {
  if (!state?.pageCount) return;
  const view = viewportSize();
  const { first, last } = visibleRange(state.layout.pages, els.scroller.scrollTop, view.height, OVERSCAN);

  for (let i = first; i <= last; i++) ensureNode(i + 1);

  // Всё, что уехало за пределы запаса, отпускаем: канвы — самая тяжёлая часть
  // окна, и держать их на весь документ нельзя.
  for (const [n] of state.nodes) {
    if (n - 1 < first - 1 || n - 1 > last + 1) dropNode(n);
  }

  const page = currentPage(state.layout.pages, els.scroller.scrollTop, view.height);
  if (page !== state.page) {
    state.page = page;
    if (document.activeElement !== els.pageInput) els.pageInput.value = String(page);
    markCurrentThumb();
  }
}

function ensureNode(n) {
  const existing = state.nodes.get(n);
  if (existing) {
    // Масштаб сменился — перерисовываем в новом размере.
    if (existing.scale !== state.scale) renderNode(state, n, existing);
    return;
  }

  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.page = String(n);
  const node = { el, canvas: null, textLayer: null, cancel: null, scale: null };
  state.nodes.set(n, node);
  placeNode(n, node);
  state.sheet.appendChild(el);
  renderNode(state, n, node);
}

function dropNode(n) {
  const node = state.nodes.get(n);
  if (!node) return;
  node.cancel?.();
  node.textLayer?.cancel?.();
  node.el.remove();
  state.nodes.delete(n);
}

function renderNode(session, n, node) {
  node.cancel?.();
  const wanted = session.scale;
  const width = session.layout.pages[n - 1]?.width;
  if (!width) return;

  node.scale = wanted;
  node.cancel = pageQueue.add(
    async (signal) => {
      // Работа идёт для своего сеанса: перешли на другую вкладку — страница
      // всё равно дорисуется и будет ждать возвращения уже готовой.
      const out = await renderPage(session.doc, n, width, signal, session.rotation);
      if (!out || session.closed || node.scale !== wanted) return;

      node.canvas?.remove();
      node.canvas = out.canvas;
      node.el.prepend(out.canvas);
      await addTextLayer(session, n, node, out.viewport, signal);
    },
    // Ближе к текущей странице — раньше в очередь: пользователь смотрит туда.
    { priority: 1000 - Math.abs(n - session.page) },
  );
}

/**
 * Прозрачный слой текста поверх картинки. Он и даёт выделение мышью,
 * копирование и подсветку поиска — рисовать это руками по канве не пришлось бы
 * только ценой собственного движка разметки.
 */
async function addTextLayer(session, n, node, viewport, signal) {
  let content;
  try {
    content = await textContent(session.doc, n);
  } catch {
    return;
  }
  if (signal.aborted || session.closed) return;

  node.textLayer?.cancel?.();
  node.el.querySelector('.text-layer')?.remove();

  const container = document.createElement('div');
  container.className = 'text-layer';
  // Контракт pdf.js: размеры слоя и шрифтов считаются от этих переменных.
  container.style.setProperty('--total-scale-factor', String(viewport.scale));
  container.style.setProperty('--scale-round-x', '1px');
  container.style.setProperty('--scale-round-y', '1px');
  node.el.appendChild(container);

  const layer = new TextLayer({ textContentSource: content, container, viewport });
  node.textLayer = layer;
  try {
    await layer.render();
  } catch {
    return;
  }
  highlightPage(session, n, node);
}

// ---------------------------------------------------------------------------
// Переходы и масштаб
// ---------------------------------------------------------------------------
function goToPage(n, { save = true } = {}) {
  if (!state?.pageCount) return;
  const page = state.layout.pages[Math.min(state.pageCount, Math.max(1, n)) - 1];
  if (!page) return;
  els.scroller.scrollTop = page.anchor;
  updateVisible();
  if (save) saveView();
}

function setScale(scale, anchor = null) {
  // В показе масштаб задан экраном: своя величина развалила бы соответствие
  // «одна страница — один экран».
  if (!state?.pageCount || ui.present) return;
  const next = clampScale(scale);
  if (Math.abs(next - state.scale) < 0.001) return;

  const before = state.scale;
  state.mode = 'custom';
  state.scale = next;
  state.layout = layoutPages(state.sizes, {
    scale: next,
    viewportWidth: els.scroller.clientWidth,
    ...frame(),
  });
  state.sheet.style.height = `${state.layout.totalHeight}px`;
  state.sheet.style.width = `${state.layout.totalWidth}px`;
  for (const [n, node] of state.nodes) placeNode(n, node);

  // При зуме колесом точка под курсором должна остаться на месте.
  const point = anchor ?? els.scroller.clientHeight / 2;
  els.scroller.scrollTop = keepAnchor(els.scroller.scrollTop, point, before, next);

  updateVisible();
  updateZoomControl();
  saveView();
}

/**
 * Поворачивает документ. Сканы часто приходят лёжа, и без этого их не прочесть.
 *
 * Размеры страниц при повороте на четверть меняются местами — спрашивать их
 * заново у pdf.js незачем. Канвы и миниатюры при этом больше не годятся:
 * их рисуют заново.
 */
function rotate(delta) {
  if (!state?.doc) return;
  state.rotation = (((state.rotation + delta) % 360) + 360) % 360;

  if (delta % 180 !== 0) {
    state.sizes = state.sizes.map(({ width, height }) => ({ width: height, height: width }));
  }

  releaseNodes(state);
  thumbs.dropDoc(state.id);
  if (state.thumbsBuilt) {
    state.thumbsBuilt = false;
    if (ui.sidebar) buildThumbs();
  }

  applyLayout({ keepPage: true });
  saveView();
}

function setMode(mode) {
  if (!state || ui.present) return;
  state.mode = mode;
  applyLayout({ keepPage: true });
  saveView();
}

function updateZoomControl() {
  if (!state) return;
  if (state.mode === 'fit-width') els.zoom.value = 'fit-width';
  else if (state.mode === 'fit-page') els.zoom.value = 'fit-page';
  else {
    const exact = [...els.zoom.options].find((o) => Number(o.value) === Number(state.scale.toFixed(2)));
    if (exact) {
      els.zoom.value = exact.value;
    } else {
      const custom = els.zoom.querySelector('option[value="custom"]');
      custom.hidden = false;
      custom.textContent = `${Math.round(state.scale * 100)}%`;
      els.zoom.value = 'custom';
    }
  }
}

function saveView() {
  if (!state?.doc || ui.present) return;
  const session = state;
  // Таймер у каждой вкладки свой: общий сбрасывался бы при переходе на соседнюю
  // вкладку, и место в покинутом документе не записывалось бы вовсе.
  clearTimeout(session.saveTimer);
  session.saveTimer = setTimeout(() => flushView(session), 600);
}

/** Записывает место немедленно — перед закрытием вкладки или окна. */
function flushView(session) {
  clearTimeout(session.saveTimer);
  session.saveTimer = null;
  if (!session.doc) return;
  // В показе масштаб задан экраном и документу не принадлежит: запоминаем тот,
  // с которым в показ вошли, иначе документ открылся бы в «странице целиком».
  const view = ui.present && beforePresent?.session === session ? beforePresent : session;
  window.reader.viewSet(session.id, {
    page: session.page,
    scale: view.scale,
    mode: view.mode,
    rotation: session.rotation,
  });
}

// ---------------------------------------------------------------------------
// Боковая панель: миниатюры и оглавление
// ---------------------------------------------------------------------------
function toggleSidebar(on = !ui.sidebar) {
  ui.sidebar = on;
  els.sidebar.hidden = !on;
  $('btn-sidebar').classList.toggle('active', on);
  if (on && state?.doc && !state.thumbsBuilt) buildThumbs();
  applyLayout({ keepPage: true });
}

function buildThumbs() {
  const session = state;
  session.thumbsBuilt = true;
  session.thumbsEl.replaceChildren();
  session.thumbNodes.clear();

  const frag = document.createDocumentFragment();
  for (let n = 1; n <= session.pageCount; n++) {
    const btn = document.createElement('button');
    btn.className = 'thumb';
    btn.type = 'button';
    btn.dataset.page = String(n);
    const ph = document.createElement('div');
    ph.className = 'ph';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(n);
    btn.append(ph, num);
    btn.addEventListener('click', () => goToPage(n));
    frag.appendChild(btn);
    session.thumbNodes.set(n, btn);
  }
  session.thumbsEl.appendChild(frag);
  markCurrentThumb();

  // Наблюдение не снимаем: уехавшая из панели плитка отдаёт свою канву обратно.
  // Иначе после прохода по тысяче страниц в панели остаётся тысяча канв —
  // сотни мегабайт, которые ThumbStore освободить не может, потому что их
  // держит сам DOM.
  session.thumbObserver?.disconnect();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const page = Number(e.target.dataset.page);
        if (e.isIntersecting) renderThumb(session, page, e.target);
        else releaseThumb(session, page, e.target);
      }
    },
    { root: session.thumbsEl, rootMargin: '300px' },
  );
  // Наблюдатель держит все плитки панели, поэтому закрывается вместе с вкладкой.
  session.thumbObserver = observer;
  for (const btn of session.thumbNodes.values()) observer.observe(btn);
}

function renderThumb(session, n, el) {
  if (session.thumbJobs.has(n)) return;

  const ready = thumbs.get(session.id, THUMB_WIDTH, n);
  if (ready) {
    place(el, ready);
    return;
  }

  const cancel = thumbQueue.add(async (signal) => {
    try {
      // Кэш на диске хранит миниатюры без поворота: повёрнутому документу он
      // не годится, и туда же ничего не пишем.
      const cached = session.rotation
        ? null
        : await window.reader.thumbGet(session.id, n, THUMB_WIDTH);
      if (session.closed || signal.aborted) return;

      if (cached) {
        const img = new Image();
        img.src = cached;
        await img.decode();
        place(el, img);
        return;
      }

      const out = await renderPage(session.doc, n, THUMB_WIDTH, signal, session.rotation);
      if (!out || session.closed) return;
      place(el, out.canvas);
      thumbs.put(session.id, THUMB_WIDTH, n, out.canvas);
      if (!session.rotation) {
        window.reader.thumbPut(session.id, n, THUMB_WIDTH, out.canvas.toDataURL('image/jpeg', 0.75));
      }
    } finally {
      // Только если в списке всё ещё наша задача: пока мы ходили за кэшем,
      // плитка могла вернуться в панель и завести новую.
      if (session.thumbJobs.get(n) === cancel) session.thumbJobs.delete(n);
    }
  });
  session.thumbJobs.set(n, cancel);

  function place(target, media) {
    target.querySelector(':scope > .ph, :scope > canvas, :scope > img')?.replaceWith(media);
  }
}

/** Возвращает плитке заглушку: сама картинка остаётся в ThumbStore. */
function releaseThumb(session, n, el) {
  session.thumbJobs.get(n)?.();
  session.thumbJobs.delete(n);
  const media = el.querySelector(':scope > canvas, :scope > img');
  if (!media) return;
  const ph = document.createElement('div');
  ph.className = 'ph';
  media.replaceWith(ph);
}

function markCurrentThumb() {
  if (!state) return;
  for (const [n, el] of state.thumbNodes) el.classList.toggle('current', n === state.page);
  if (ui.sidebar && ui.sidebarTab === 'thumbs') {
    state.thumbNodes.get(state.page)?.scrollIntoView({ block: 'nearest' });
  }
}

async function loadOutline(session) {
  let outline = null;
  try {
    outline = await session.doc.getOutline();
  } catch {
    outline = null;
  }
  if (session.closed) return;

  session.outlineEl.replaceChildren();
  if (!outline || !outline.length) {
    const empty = document.createElement('p');
    empty.className = 'outline-empty';
    empty.textContent = t['outline.empty'];
    session.outlineEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  const walk = (items, depth) => {
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'outline-item';
      btn.type = 'button';
      btn.style.paddingLeft = `${6 + depth * 12}px`;
      btn.textContent = item.title || t['outline.untitled'];
      btn.addEventListener('click', () => jumpToDest(session, item.dest));
      frag.appendChild(btn);
      if (item.items?.length) walk(item.items, depth + 1);
    }
  };
  walk(outline, 0);
  session.outlineEl.appendChild(frag);
}

/** Пункт оглавления указывает на место в документе, а не на номер страницы. */
async function jumpToDest(session, dest) {
  if (!session.doc || !dest) return;
  try {
    const target = typeof dest === 'string' ? await session.doc.getDestination(dest) : dest;
    if (!Array.isArray(target) || !target[0]) return;
    const index = await session.doc.getPageIndex(target[0]);
    if (session !== state) return; // ушли на другую вкладку, пока искали место
    goToPage(index + 1);
  } catch {
    // Битая ссылка в оглавлении — не повод падать.
  }
}

function switchSidebarTab(tab) {
  ui.sidebarTab = tab;
  els.tabThumbs.classList.toggle('active', tab === 'thumbs');
  els.tabOutline.classList.toggle('active', tab === 'outline');
  els.thumbsHost.hidden = tab !== 'thumbs';
  els.outlineHost.hidden = tab !== 'outline';
}

// ---------------------------------------------------------------------------
// Поиск
// ---------------------------------------------------------------------------
// Поиск свой у каждой вкладки: запрос, найденное и текущее совпадение уходят
// вместе с документом и возвращаются вместе с ним.

function openFind() {
  if (!state) return;
  state.find.open = true;
  els.findBox.hidden = false;
  els.findInput.focus();
  els.findInput.select();
}

function closeFind() {
  if (!state) return;
  clearTimeout(state.findTimer);
  els.findBox.hidden = true;
  state.find = { query: '', hits: [], index: -1, token: state.find.token + 1, open: false, stat: null };
  els.findInput.value = '';
  els.findStatus.textContent = '';
  for (const [n, node] of state.nodes) highlightPage(state, n, node);
}

/**
 * Что показывать в строке поиска. Храним частями, а не готовым текстом: язык
 * могут переключить, пока результат на экране, — тогда его надо перебрать
 * заново, а не оставить на прежнем языке.
 */
function setFindStat(session, stat) {
  session.find.stat = stat;
  if (session === state) showFindStatus(session);
}

function showFindStatus(session) {
  const stat = session.find.stat;
  if (!stat) {
    els.findStatus.textContent = '';
    return;
  }
  const say = t[`find.${stat.kind}`];
  els.findStatus.textContent =
    typeof say === 'function' ? say(stat.a, stat.b) : typeof say === 'string' ? say : '';
}

/**
 * Ищет по всему документу. Страницы читаются по очереди, а не разом: на
 * большом документе это единственный способ не подвесить окно, и первые
 * совпадения появляются сразу.
 */
async function runFind(session, query) {
  if (!session?.doc) return;
  const token = ++session.find.token;
  session.find.query = query;
  session.find.hits = [];
  session.find.index = -1;

  if (!query.trim()) {
    setFindStat(session, null);
    for (const [n, node] of session.nodes) highlightPage(session, n, node);
    return;
  }

  setFindStat(session, { kind: 'searching' });

  for (let n = 1; n <= session.pageCount; n++) {
    if (token !== session.find.token || session.closed) return;
    let content;
    try {
      content = await textContent(session.doc, n);
    } catch {
      continue;
    }
    const { text, spans } = buildPageText(content);
    for (const match of findMatches(text, query)) {
      session.find.hits.push({ page: n, match, spans });
    }
    if (session.find.hits.length && session.find.index === -1) {
      // Первое совпадение показываем, не дожидаясь конца поиска.
      session.find.index = 0;
      showHit(session, 0);
    }
    setFindStat(
      session,
      session.find.hits.length
        ? {
            kind: n < session.pageCount ? 'counting' : 'count',
            a: session.find.index + 1,
            b: session.find.hits.length,
          }
        : { kind: 'scan', a: n, b: session.pageCount },
    );
  }

  setFindStat(
    session,
    session.find.hits.length
      ? { kind: 'count', a: session.find.index + 1, b: session.find.hits.length }
      : { kind: 'none' },
  );
}

function stepHit(delta) {
  if (!state) return;
  const { hits } = state.find;
  if (!hits.length) return;
  state.find.index = (state.find.index + delta + hits.length) % hits.length;
  showHit(state, state.find.index);
  setFindStat(state, { kind: 'count', a: state.find.index + 1, b: hits.length });
}

function showHit(session, i) {
  const hit = session.find.hits[i];
  if (!hit || session !== state) return;
  if (hit.page !== session.page) goToPage(hit.page, { save: false });
  for (const [n, node] of session.nodes) highlightPage(session, n, node);
}

/** Раскрашивает совпадения в уже отрисованном слое текста этой страницы. */
function highlightPage(session, n, node) {
  const layer = node.el.querySelector('.text-layer');
  if (!layer) return;

  // Снимаем прежнюю подсветку: mark разворачиваем обратно в текст.
  for (const mark of [...layer.querySelectorAll('mark')]) {
    mark.replaceWith(document.createTextNode(mark.textContent));
  }
  for (const div of layer.children) div.normalize();

  if (!session.find.query) return;
  const divs = node.textLayer?.textDivs || [];
  const active = session.find.hits[session.find.index];

  for (let i = 0; i < session.find.hits.length; i++) {
    const hit = session.find.hits[i];
    if (hit.page !== n) continue;
    for (const part of spansForMatch(hit.spans, hit.match)) {
      const div = divs[part.index];
      if (!div || div.childNodes.length !== 1 || div.firstChild.nodeType !== Node.TEXT_NODE) continue;
      const text = div.firstChild.nodeValue;
      const mark = document.createElement('mark');
      mark.textContent = text.slice(part.from, part.to);
      if (hit === active) mark.classList.add('active');
      div.replaceChildren(
        document.createTextNode(text.slice(0, part.from)),
        mark,
        document.createTextNode(text.slice(part.to)),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Печать
// ---------------------------------------------------------------------------
function openPrintDialog() {
  if (!state?.doc) return;
  els.printFrom.max = String(state.pageCount);
  els.printTo.max = String(state.pageCount);
  els.printFrom.value = '1';
  els.printTo.value = String(state.pageCount);
  els.printError.hidden = true;
  openDialog(els.printDialog);
}

async function doPrint() {
  if (!state?.doc) return;
  const session = state;
  const mode = document.querySelector('input[name="print-range"]:checked')?.value;
  let pages;
  if (mode === 'current') {
    pages = [session.page];
  } else if (mode === 'range') {
    const from = Number(els.printFrom.value);
    const to = Number(els.printTo.value);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > session.pageCount || from > to) {
      els.printError.textContent = t['print.range'](session.pageCount);
      els.printError.hidden = false;
      return;
    }
    pages = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  } else {
    pages = Array.from({ length: session.pageCount }, (_, i) => i + 1);
  }

  els.printDialog.hidden = true;
  const res = await window.reader.print(session.id, pages, session.rotation);
  if (res && res.ok === false && res.error) {
    els.printError.textContent = String(res.error);
    els.printError.hidden = false;
    els.printDialog.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Ввод
// ---------------------------------------------------------------------------
function bindUi() {
  els.scroller.addEventListener('scroll', () => {
    scheduleVisible();
    saveView();
  });

  // Размер области просмотра меняется не только от resize окна: её сдвигает
  // боковая панель, а при открытии документа окно может быть ещё не разложено —
  // тогда clientWidth равен нулю, и масштаб «по ширине» посчитался бы впустую.
  let lastView = { width: 0, height: 0 };
  const observer = new ResizeObserver(() => {
    const view = viewportSize();
    if (!view.width || !view.height) return;
    // Появление полосы прокрутки меняет ширину на пиксель-другой; без порога
    // раскладка могла бы бесконечно переключаться между двумя состояниями.
    if (Math.abs(view.width - lastView.width) < 2 && Math.abs(view.height - lastView.height) < 2) {
      return;
    }
    lastView = view;
    // Вкладки в стороне разложим при переходе на них: считать ленту документа,
    // которого не видно, незачем.
    for (const session of tabs) if (session !== state) session.dirty = true;
    if (state?.pageCount) applyLayout({ keepPage: true });
  });
  observer.observe(els.scroller);

  $('btn-open').addEventListener('click', () => window.reader.openDialog());
  $('empty-open').addEventListener('click', () => window.reader.openDialog());
  els.tabNew.addEventListener('click', () => window.reader.openDialog());
  $('btn-sidebar').addEventListener('click', () => toggleSidebar());
  $('btn-prev').addEventListener('click', () => goToPage(state ? state.page - 1 : 1));
  $('btn-next').addEventListener('click', () => goToPage(state ? state.page + 1 : 1));
  $('btn-zoom-in').addEventListener('click', () => state && setScale(state.scale * 1.25));
  $('btn-zoom-out').addEventListener('click', () => state && setScale(state.scale / 1.25));
  $('btn-rotate').addEventListener('click', () => rotate(90));
  $('btn-find').addEventListener('click', openFind);
  $('btn-print').addEventListener('click', openPrintDialog);
  $('btn-fullscreen').addEventListener('click', toggleFullScreen);
  $('btn-prefs').addEventListener('click', () => openDialog(els.prefsDialog));
  $('btn-help').addEventListener('click', () => openDialog(els.helpDialog));
  $('prefs-close').addEventListener('click', closeDialogs);
  $('help-close').addEventListener('click', closeDialogs);

  for (const radio of document.querySelectorAll('input[name="present-bg"]')) {
    radio.addEventListener('change', () => radio.checked && setPref('presentBg', radio.value));
  }
  for (const radio of document.querySelectorAll('input[name="lang"]')) {
    radio.addEventListener('change', () => radio.checked && setPref('lang', radio.value));
  }
  $('prefs-reopen').addEventListener('change', (e) => setPref('reopen', e.target.checked));

  // Щелчок по затемнению вокруг окна закрывает его — привычно и быстрее, чем
  // целиться в кнопку.
  for (const dialog of DIALOGS) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.hidden = true;
    });
  }

  els.tabThumbs.addEventListener('click', () => switchSidebarTab('thumbs'));
  els.tabOutline.addEventListener('click', () => switchSidebarTab('outline'));

  els.zoom.addEventListener('change', () => {
    const value = els.zoom.value;
    if (value === 'fit-width' || value === 'fit-page') setMode(value);
    else if (value !== 'custom') setScale(Number(value));
  });

  els.pageInput.addEventListener('change', () => {
    const n = Number(els.pageInput.value.replace(/[^\d]/g, ''));
    if (n) goToPage(n);
    els.pageInput.value = state ? String(state.page) : '—';
  });
  els.pageInput.addEventListener('focus', () => els.pageInput.select());

  els.findInput.addEventListener('input', () => {
    if (!state) return;
    // Запрос запоминаем сразу: пока ждём паузу в наборе, вкладка может
    // смениться, и поле будет показывать уже чужой поиск.
    const session = state;
    const query = els.findInput.value;
    clearTimeout(session.findTimer);
    session.findTimer = setTimeout(() => {
      if (session === state) runFind(session, query);
    }, 250);
  });
  els.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') stepHit(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') closeFind();
  });
  $('find-next').addEventListener('click', () => stepHit(1));
  $('find-prev').addEventListener('click', () => stepHit(-1));
  $('find-close').addEventListener('click', closeFind);

  $('print-cancel').addEventListener('click', closeDialogs);
  $('print-go').addEventListener('click', doPrint);

  // В показе щелчок листает вперёд — привычно по любой программе показа.
  els.scroller.addEventListener('click', (e) => {
    if (!ui.present || e.button !== 0) return;
    goToPage(state.page + 1);
  });

  // Колесо в показе — тоже страница за раз, иначе один поворот пролистывал бы
  // сразу несколько слайдов.
  let wheelAt = 0;
  els.scroller.addEventListener(
    'wheel',
    (e) => {
      if (!ui.present || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const now = performance.now();
      if (now - wheelAt < 280) return;
      wheelAt = now;
      goToPage(state.page + (e.deltaY > 0 ? 1 : -1));
    },
    { passive: false },
  );

  // Зум колесом с Ctrl — как во всех просмотрщиках.
  els.scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!state) return;
      const rect = els.scroller.getBoundingClientRect();
      setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientY - rect.top);
    },
    { passive: false },
  );

  // Колесо над полосой вкладок листает вкладки — привычно и быстрее, чем целиться.
  els.tabbar.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaY === 0 || tabs.length < 2) return;
      e.preventDefault();
      stepTab(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );

  window.addEventListener('keydown', onKey);
  // Окно закрывают, не закрывая вкладок: место в каждом документе записываем,
  // пока главный процесс ещё жив и готов его принять.
  window.addEventListener('beforeunload', () => {
    if (state) state.scrollTop = els.scroller.scrollTop;
    for (const session of tabs) flushView(session);
  });
  bindDropOpen();
}

function onKey(e) {
  // Показ включают откуда угодно, даже из поля ввода. Клавишу L проверяем по
  // её месту на клавиатуре, а не по напечатанной букве: в русской раскладке
  // там «д», и сравнение с 'l' не сработало бы.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyL') {
    e.preventDefault();
    togglePresent();
    return;
  }

  if (ui.present && presentKey(e)) return;

  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
      els.scroller.scrollBy({ top: pageStep(e.key === 'ArrowDown' ? 0.12 : 0.92) });
      break;
    case 'ArrowUp':
    case 'PageUp':
      els.scroller.scrollBy({ top: -pageStep(e.key === 'ArrowUp' ? 0.12 : 0.92) });
      break;
    case 'ArrowRight':
      if (state) goToPage(state.page + 1);
      break;
    case 'ArrowLeft':
      if (state) goToPage(state.page - 1);
      break;
    case 'Home':
      goToPage(1);
      break;
    case 'End':
      if (state) goToPage(state.pageCount);
      break;
    case 'Escape':
      if (ui.present) togglePresent(false);
      else if (closeDialogs()) break;
      else if (!els.findBox.hidden) closeFind();
      else if (isFullScreen()) toggleFullScreen();
      break;
    case 'F3':
      stepHit(e.shiftKey ? -1 : 1);
      break;
    default:
      return;
  }
  e.preventDefault();
}

const pageStep = (fraction) => els.scroller.clientHeight * fraction;

// ---------------------------------------------------------------------------
// Показ
// ---------------------------------------------------------------------------
// Окно без рамок и панелей, одна страница на весь экран, листание по клавишам
// и щелчку. Отдельного отрисовщика для этого не нужно: та же лента, только с
// нулевыми полями и запрещённой прокруткой — соседние страницы оказываются
// точно за краями экрана, а переход к странице и есть смена слайда.

/** Как было до показа, чтобы вернуть в точности это. */
let beforePresent = null;

function togglePresent(on = !ui.present) {
  if (on === ui.present) return;
  if (on && !state?.doc) return;

  ui.present = on;
  document.body.classList.toggle('present', on);

  if (on) {
    beforePresent = {
      session: state,
      mode: state.mode,
      scale: state.scale,
      sidebar: ui.sidebar,
      // Показ и сам разворачивает окно; если оно уже было развёрнуто по F11,
      // после показа так и должно остаться.
      fullScreen: isFullScreen(),
    };
    if (ui.sidebar) toggleSidebar(false);
    closeFind();
    closeDialogs();
    // Выделение, оставшееся от работы с документом, в показе ни к чему: текст
    // там не выделяется, а старое выделение перехватывало бы щелчок «дальше».
    window.getSelection()?.removeAllRanges();
    state.mode = 'fit-page';
    applyLayout({ keepPage: true });
    goToPage(state.page, { save: false });
  } else {
    // Возвращаем прежний масштаб той вкладке, с которой уходили в показ.
    const was = beforePresent;
    beforePresent = null;
    if (was && was.session === state && !state.closed) {
      state.mode = was.mode;
      state.scale = was.scale;
      applyLayout({ keepPage: true });
      saveView();
    } else {
      applyLayout({ keepPage: true });
    }
    if (was?.sidebar) toggleSidebar(true);
    window.reader.setFullScreen(Boolean(was?.fullScreen));
    return;
  }

  window.reader.setFullScreen(true);
}

/** Клавиши показа: листаем страницами, а не экранами. */
function presentKey(e) {
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
    case 'Enter':
      goToPage(state.page + 1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
      goToPage(state.page - 1);
      break;
    case 'Home':
      goToPage(1);
      break;
    case 'End':
      goToPage(state.pageCount);
      break;
    case 'Escape':
      togglePresent(false);
      break;
    default:
      return false;
  }
  e.preventDefault();
  return true;
}

const isFullScreen = () => document.body.classList.contains('fullscreen');

function toggleFullScreen() {
  window.reader.setFullScreen(!isFullScreen());
}

function bindDropOpen() {
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    // Бросили несколько файлов — открываем все: под каждый заведётся вкладка.
    for (const file of e.dataTransfer?.files || []) {
      const p = window.reader.pathForFile(file);
      if (p && p.toLowerCase().endsWith('.pdf')) window.reader.openPath(p);
    }
  });
}

// ---------------------------------------------------------------------------
// Пустой экран и запуск
// ---------------------------------------------------------------------------
async function showRecent() {
  const list = await window.reader.recent();
  els.emptyRecent.replaceChildren();
  if (!list.length) return;

  const title = document.createElement('div');
  title.className = 'recent-title';
  title.textContent = t['recent.title'];
  els.emptyRecent.appendChild(title);

  for (const item of list.slice(0, 8)) {
    const btn = document.createElement('button');
    btn.className = 'recent-item';
    btn.type = 'button';
    // Путь и полная дата — в подсказке: в строке для них нет места, а знать,
    // какой именно из одноимённых файлов открывается, иногда нужно.
    const full = formatFull(item.openedAt, prefs.lang);
    btn.title = full ? `${item.path}\n${full}` : item.path;

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = item.name;

    const when = document.createElement('span');
    when.className = 'recent-when';
    when.textContent = formatWhen(item.openedAt, prefs.lang);

    btn.append(name, when);
    btn.addEventListener('click', () => window.reader.openPath(item.path));
    els.emptyRecent.appendChild(btn);
  }
}

const menuCommands = {
  print: openPrintDialog,
  find: openFind,
  'find:next': () => stepHit(1),
  'zoom:in': () => state && setScale(state.scale * 1.25),
  'zoom:out': () => state && setScale(state.scale / 1.25),
  'zoom:reset': () => setScale(1),
  'fit:width': () => setMode('fit-width'),
  'fit:page': () => setMode('fit-page'),
  'rotate:right': () => rotate(90),
  'rotate:left': () => rotate(-90),
  'sidebar:toggle': () => toggleSidebar(),
  'fullscreen:toggle': toggleFullScreen,
  'present:toggle': () => togglePresent(),
  // Окно сообщает о смене режима само — в том числе когда его переключили
  // кнопкой заголовка или средствами системы, мимо программы. Вышли из
  // полного экрана мимо нас — показ тоже заканчивается, иначе остались бы
  // в окне без панелей.
  'fullscreen:state': ({ on }) => {
    document.body.classList.toggle('fullscreen', Boolean(on));
    if (!on && ui.present) togglePresent(false);
  },
  'go:first': () => goToPage(1),
  'go:last': () => state && goToPage(state.pageCount),
  'go:prompt': () => els.pageInput.focus(),
  'prefs:open': () => openDialog(els.prefsDialog),
  'tab:close': () => state && closeTab(state),
  'tab:next': () => stepTab(1),
  'tab:prev': () => stepTab(-1),
  'tab:focus': ({ id }) => {
    const session = tabs.find((s) => s.id === id);
    if (session) activate(session);
  },
};

window.reader.onDocument((info) => {
  openDocument(info).catch((err) => console.error('не удалось открыть документ:', err));
});

window.reader.onCommand((type, payload) => menuCommands[type]?.(payload || {}));

bindUi();
// Именно showEmpty, а не showRecent: документа ещё нет, и кнопки, которым
// он нужен, должны быть выключены с самого начала, а не только после
// закрытия последней вкладки.
showEmpty();

window.reader
  .prefsGet()
  .then((saved) => {
    Object.assign(prefs, saved || {});
    applyPrefs();
  })
  .catch(() => applyPrefs());
