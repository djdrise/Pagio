// Окно просмотрщика: непрерывная лента страниц, масштаб, боковая панель,
// поиск и печать.
//
// Устройство ленты. Страницы не лежат в потоке одна за другой: их положение
// считает scrolllayout.mjs, а в DOM живут только те, что сейчас видно, плюс
// небольшой запас. Документ на тысячу страниц иначе не открыть — тысяча канв
// съест память до того, как пользователь доберётся до второй страницы.

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

const $ = (id) => document.getElementById(id);
const els = {
  scroller: $('scroller'),
  sheet: $('sheet'),
  sidebar: $('sidebar'),
  thumbs: $('thumbs'),
  outline: $('outline'),
  tabThumbs: $('tab-thumbs'),
  tabOutline: $('tab-outline'),
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
};

/** Ширина миниатюры в боковой панели, в CSS-пикселях. */
const THUMB_WIDTH = 180;
/** Сколько экранов страниц держим нарисованными сверх видимого. */
const OVERSCAN = 0.6;

const pageQueue = new RenderQueue(4);
const thumbQueue = new RenderQueue(2);
const thumbs = new ThumbStore();

const state = {
  id: null,
  doc: null,
  pageCount: 0,
  /** Размеры страниц при масштабе 1; сначала все по первой странице. */
  sizes: [],
  layout: { pages: [], totalHeight: 0, totalWidth: 0 },
  scale: 1,
  /** 'fit-width' | 'fit-page' | 'custom' */
  mode: 'fit-width',
  page: 1,
  sidebar: false,
  sidebarTab: 'thumbs',
  /** Страница → {el, canvas, textLayer, cancel, scale} */
  nodes: new Map(),
  find: { query: '', hits: [], index: -1, token: 0 },
  thumbNodes: new Map(),
  thumbJobs: new Map(),
};

// ---------------------------------------------------------------------------
// Открытие документа
// ---------------------------------------------------------------------------
async function openDocument(info) {
  clearDocument();

  state.id = info.id;
  els.pageCount.textContent = '…';

  const doc = await loadDoc({ id: info.id, length: info.length });
  if (state.id !== info.id) return; // успели открыть другой файл

  state.doc = doc;
  state.pageCount = doc.numPages;
  els.pageCount.textContent = String(doc.numPages);
  els.empty.hidden = true;

  // Размеры: сперва берём первую страницу и считаем остальные такими же —
  // документ открывается мгновенно. Настоящие размеры подтягиваем в фоне, и
  // лента перестраивается, если они отличаются.
  const first = await pageSize(doc, 1);
  state.sizes = Array.from({ length: doc.numPages }, () => ({ ...first }));
  document.documentElement.style.setProperty('--page-aspect', `${first.width} / ${first.height}`);

  const view = info.view || null;
  state.mode = view?.mode || 'fit-width';
  state.scale = view?.scale || 1;

  applyLayout({ keepPage: false });
  if (view?.page) goToPage(view.page, { save: false });

  refineSizes(doc);
  loadOutline(doc);
  if (state.sidebar) buildThumbs();
}

function clearDocument() {
  for (const [n] of state.nodes) dropNode(n);
  state.nodes.clear();
  pageQueue.cancelAll();
  thumbQueue.cancelAll();
  for (const cancel of state.thumbJobs.values()) cancel();
  state.thumbJobs.clear();
  state.thumbNodes.clear();
  els.thumbs.replaceChildren();
  els.outline.replaceChildren();
  els.sheet.replaceChildren();
  closeFind();
  state.doc?.destroy?.();
  state.doc = null;
  state.pageCount = 0;
  state.sizes = [];
}

/**
 * Уточняет размеры страниц в фоне. Документы с однородными страницами — а это
 * почти все — от этого не меняются вовсе; смешанные (портрет и альбом вперемешку)
 * перестраиваются по мере поступления.
 */
async function refineSizes(doc) {
  const known = new Map();
  for (let n = 1; n <= doc.numPages; n++) {
    if (state.doc !== doc) return;
    try {
      const size = await pageSize(doc, n);
      const before = state.sizes[n - 1];
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
        for (const [num, size] of known) state.sizes[num - 1] = size;
        known.clear();
        applyLayout({ keepPage: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Раскладка и прокрутка
// ---------------------------------------------------------------------------
function viewportSize() {
  return { width: els.scroller.clientWidth, height: els.scroller.clientHeight };
}

/** Пересчитывает масштаб под режим и раскладывает страницы заново. */
function applyLayout({ keepPage = true } = {}) {
  if (!state.pageCount) {
    els.sheet.style.height = '0px';
    return;
  }

  const view = viewportSize();
  const anchorPage = keepPage ? state.page : 1;
  const anchorOffset = keepPage ? offsetInPage(anchorPage) : 0;

  if (state.mode !== 'custom') {
    state.scale = fitScale(state.sizes[anchorPage - 1], view, state.mode === 'fit-page' ? 'page' : 'width');
  }

  state.layout = layoutPages(state.sizes, { scale: state.scale, viewportWidth: view.width });
  els.sheet.style.height = `${state.layout.totalHeight}px`;
  els.sheet.style.width = `${state.layout.totalWidth}px`;

  for (const [n, node] of state.nodes) placeNode(n, node);

  if (keepPage) {
    const page = state.layout.pages[anchorPage - 1];
    if (page) els.scroller.scrollTop = page.top - PADDING + anchorOffset * state.scale;
  }

  updateVisible();
  updateZoomControl();
  if (document.activeElement !== els.pageInput) els.pageInput.value = String(state.page);
}

/** Насколько глубоко мы внутри текущей страницы, в единицах документа. */
function offsetInPage(n) {
  const page = state.layout.pages[n - 1];
  if (!page) return 0;
  return (els.scroller.scrollTop - page.top + PADDING) / (state.scale || 1);
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
  if (!state.pageCount) return;
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
    if (existing.scale !== state.scale) renderNode(n, existing);
    return;
  }

  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.page = String(n);
  const node = { el, canvas: null, textLayer: null, cancel: null, scale: null };
  state.nodes.set(n, node);
  placeNode(n, node);
  els.sheet.appendChild(el);
  renderNode(n, node);
}

function dropNode(n) {
  const node = state.nodes.get(n);
  if (!node) return;
  node.cancel?.();
  node.textLayer?.cancel?.();
  node.el.remove();
  state.nodes.delete(n);
}

function renderNode(n, node) {
  node.cancel?.();
  const wanted = state.scale;
  const width = state.layout.pages[n - 1]?.width;
  if (!width) return;

  node.scale = wanted;
  node.cancel = pageQueue.add(
    async (signal) => {
      const doc = state.doc;
      const out = await renderPage(doc, n, width, signal);
      if (!out || doc !== state.doc || node.scale !== wanted) return;

      node.canvas?.remove();
      node.canvas = out.canvas;
      node.el.prepend(out.canvas);
      await addTextLayer(n, node, out.viewport, signal);
    },
    // Ближе к текущей странице — раньше в очередь: пользователь смотрит туда.
    { priority: 1000 - Math.abs(n - state.page) },
  );
}

/**
 * Прозрачный слой текста поверх картинки. Он и даёт выделение мышью,
 * копирование и подсветку поиска — рисовать это руками по канве не пришлось бы
 * только ценой собственного движка разметки.
 */
async function addTextLayer(n, node, viewport, signal) {
  const doc = state.doc;
  let content;
  try {
    content = await textContent(doc, n);
  } catch {
    return;
  }
  if (signal.aborted || doc !== state.doc) return;

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
  node.textContent = content;
  highlightPage(n, node);
}

// ---------------------------------------------------------------------------
// Переходы и масштаб
// ---------------------------------------------------------------------------
function goToPage(n, { save = true } = {}) {
  const page = state.layout.pages[Math.min(state.pageCount, Math.max(1, n)) - 1];
  if (!page) return;
  els.scroller.scrollTop = page.top - PADDING;
  updateVisible();
  if (save) saveView();
}

function setScale(scale, anchor = null) {
  const next = clampScale(scale);
  if (Math.abs(next - state.scale) < 0.001) return;

  const before = state.scale;
  state.mode = 'custom';
  state.scale = next;
  state.layout = layoutPages(state.sizes, {
    scale: next,
    viewportWidth: els.scroller.clientWidth,
  });
  els.sheet.style.height = `${state.layout.totalHeight}px`;
  els.sheet.style.width = `${state.layout.totalWidth}px`;
  for (const [n, node] of state.nodes) placeNode(n, node);

  // При зуме колесом точка под курсором должна остаться на месте.
  const point = anchor ?? els.scroller.clientHeight / 2;
  els.scroller.scrollTop = keepAnchor(els.scroller.scrollTop, point, before, next);

  updateVisible();
  updateZoomControl();
  saveView();
}

function setMode(mode) {
  state.mode = mode;
  applyLayout({ keepPage: true });
  saveView();
}

function updateZoomControl() {
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

let saveTimer = null;

function saveView() {
  if (!state.id) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.reader.viewSet(state.id, { page: state.page, scale: state.scale, mode: state.mode });
  }, 600);
}

// ---------------------------------------------------------------------------
// Боковая панель: миниатюры и оглавление
// ---------------------------------------------------------------------------
function toggleSidebar(on = !state.sidebar) {
  state.sidebar = on;
  els.sidebar.hidden = !on;
  $('btn-sidebar').classList.toggle('active', on);
  if (on && state.doc && !state.thumbNodes.size) buildThumbs();
  applyLayout({ keepPage: true });
}

function buildThumbs() {
  els.thumbs.replaceChildren();
  state.thumbNodes.clear();

  const frag = document.createDocumentFragment();
  for (let n = 1; n <= state.pageCount; n++) {
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
    state.thumbNodes.set(n, btn);
  }
  els.thumbs.appendChild(frag);
  markCurrentThumb();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        renderThumb(Number(e.target.dataset.page), e.target);
      }
    },
    { root: els.thumbs, rootMargin: '300px' },
  );
  for (const btn of state.thumbNodes.values()) observer.observe(btn);
}

function renderThumb(n, el) {
  if (state.thumbJobs.has(n)) return;

  const ready = thumbs.get(state.id, THUMB_WIDTH, n);
  if (ready) {
    place(el, ready);
    return;
  }

  const cancel = thumbQueue.add(async (signal) => {
    try {
      const doc = state.doc;
      const cached = await window.reader.thumbGet(state.id, n, THUMB_WIDTH);
      if (doc !== state.doc || signal.aborted) return;

      if (cached) {
        const img = new Image();
        img.src = cached;
        await img.decode();
        place(el, img);
        return;
      }

      const out = await renderPage(doc, n, THUMB_WIDTH, signal);
      if (!out || doc !== state.doc) return;
      place(el, out.canvas);
      thumbs.put(state.id, THUMB_WIDTH, n, out.canvas);
      window.reader.thumbPut(state.id, n, THUMB_WIDTH, out.canvas.toDataURL('image/jpeg', 0.75));
    } finally {
      state.thumbJobs.delete(n);
    }
  });
  state.thumbJobs.set(n, cancel);

  function place(target, media) {
    target.querySelector(':scope > .ph, :scope > canvas, :scope > img')?.replaceWith(media);
  }
}

function markCurrentThumb() {
  for (const [n, el] of state.thumbNodes) el.classList.toggle('current', n === state.page);
  if (state.sidebar && state.sidebarTab === 'thumbs') {
    state.thumbNodes.get(state.page)?.scrollIntoView({ block: 'nearest' });
  }
}

async function loadOutline(doc) {
  let outline = null;
  try {
    outline = await doc.getOutline();
  } catch {
    outline = null;
  }
  if (state.doc !== doc) return;

  els.outline.replaceChildren();
  if (!outline || !outline.length) {
    const empty = document.createElement('p');
    empty.className = 'outline-empty';
    empty.textContent = 'В документе нет оглавления.';
    els.outline.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  const walk = (items, depth) => {
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'outline-item';
      btn.type = 'button';
      btn.style.paddingLeft = `${6 + depth * 12}px`;
      btn.textContent = item.title || '(без названия)';
      btn.addEventListener('click', () => jumpToDest(item.dest));
      frag.appendChild(btn);
      if (item.items?.length) walk(item.items, depth + 1);
    }
  };
  walk(outline, 0);
  els.outline.appendChild(frag);
}

/** Пункт оглавления указывает на место в документе, а не на номер страницы. */
async function jumpToDest(dest) {
  const doc = state.doc;
  if (!doc || !dest) return;
  try {
    const target = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(target) || !target[0]) return;
    const index = await doc.getPageIndex(target[0]);
    goToPage(index + 1);
  } catch {
    // Битая ссылка в оглавлении — не повод падать.
  }
}

function switchSidebarTab(tab) {
  state.sidebarTab = tab;
  els.tabThumbs.classList.toggle('active', tab === 'thumbs');
  els.tabOutline.classList.toggle('active', tab === 'outline');
  els.thumbs.hidden = tab !== 'thumbs';
  els.outline.hidden = tab !== 'outline';
}

// ---------------------------------------------------------------------------
// Поиск
// ---------------------------------------------------------------------------
function openFind() {
  els.findBox.hidden = false;
  els.findInput.focus();
  els.findInput.select();
}

function closeFind() {
  els.findBox.hidden = true;
  state.find = { query: '', hits: [], index: -1, token: state.find.token + 1 };
  els.findStatus.textContent = '';
  for (const [n, node] of state.nodes) highlightPage(n, node);
}

/**
 * Ищет по всему документу. Страницы читаются по очереди, а не разом: на
 * большом документе это единственный способ не подвесить окно, и первые
 * совпадения появляются сразу.
 */
async function runFind(query) {
  const token = ++state.find.token;
  state.find.query = query;
  state.find.hits = [];
  state.find.index = -1;

  if (!query.trim() || !state.doc) {
    els.findStatus.textContent = '';
    for (const [n, node] of state.nodes) highlightPage(n, node);
    return;
  }

  els.findStatus.textContent = 'поиск…';
  const doc = state.doc;

  for (let n = 1; n <= state.pageCount; n++) {
    if (token !== state.find.token || doc !== state.doc) return;
    let content;
    try {
      content = await textContent(doc, n);
    } catch {
      continue;
    }
    const { text, spans } = buildPageText(content);
    for (const match of findMatches(text, query)) {
      state.find.hits.push({ page: n, match, spans });
    }
    if (state.find.hits.length && state.find.index === -1) {
      // Первое совпадение показываем, не дожидаясь конца поиска.
      state.find.index = 0;
      showHit(0);
    }
    els.findStatus.textContent = state.find.hits.length
      ? `${state.find.index + 1} из ${state.find.hits.length}${n < state.pageCount ? '…' : ''}`
      : `поиск… ${n}/${state.pageCount}`;
  }

  els.findStatus.textContent = state.find.hits.length
    ? `${state.find.index + 1} из ${state.find.hits.length}`
    : 'не найдено';
}

function stepHit(delta) {
  const { hits } = state.find;
  if (!hits.length) return;
  state.find.index = (state.find.index + delta + hits.length) % hits.length;
  showHit(state.find.index);
  els.findStatus.textContent = `${state.find.index + 1} из ${hits.length}`;
}

function showHit(i) {
  const hit = state.find.hits[i];
  if (!hit) return;
  if (hit.page !== state.page) goToPage(hit.page, { save: false });
  for (const [n, node] of state.nodes) highlightPage(n, node);
}

/** Раскрашивает совпадения в уже отрисованном слое текста этой страницы. */
function highlightPage(n, node) {
  const layer = node.el.querySelector('.text-layer');
  if (!layer) return;

  // Снимаем прежнюю подсветку: mark разворачиваем обратно в текст.
  for (const mark of [...layer.querySelectorAll('mark')]) {
    mark.replaceWith(document.createTextNode(mark.textContent));
  }
  for (const div of layer.children) div.normalize();

  if (!state.find.query) return;
  const divs = node.textLayer?.textDivs || [];
  const active = state.find.hits[state.find.index];

  for (let i = 0; i < state.find.hits.length; i++) {
    const hit = state.find.hits[i];
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
  if (!state.doc) return;
  els.printFrom.max = String(state.pageCount);
  els.printTo.max = String(state.pageCount);
  els.printFrom.value = '1';
  els.printTo.value = String(state.pageCount);
  els.printError.hidden = true;
  els.printDialog.hidden = false;
}

async function doPrint() {
  const mode = document.querySelector('input[name="print-range"]:checked')?.value;
  let pages;
  if (mode === 'range') {
    const from = Number(els.printFrom.value);
    const to = Number(els.printTo.value);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > state.pageCount || from > to) {
      els.printError.textContent = `Укажите страницы от 1 до ${state.pageCount}, начало не больше конца.`;
      els.printError.hidden = false;
      return;
    }
    pages = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  } else {
    pages = Array.from({ length: state.pageCount }, (_, i) => i + 1);
  }

  els.printDialog.hidden = true;
  const res = await window.reader.print(state.id, pages);
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
    if (state.pageCount) applyLayout({ keepPage: true });
  });
  observer.observe(els.scroller);

  $('btn-open').addEventListener('click', () => window.reader.openDialog());
  $('empty-open').addEventListener('click', () => window.reader.openDialog());
  $('btn-sidebar').addEventListener('click', () => toggleSidebar());
  $('btn-prev').addEventListener('click', () => goToPage(state.page - 1));
  $('btn-next').addEventListener('click', () => goToPage(state.page + 1));
  $('btn-zoom-in').addEventListener('click', () => setScale(state.scale * 1.25));
  $('btn-zoom-out').addEventListener('click', () => setScale(state.scale / 1.25));
  $('btn-find').addEventListener('click', openFind);
  $('btn-print').addEventListener('click', openPrintDialog);
  $('btn-fullscreen').addEventListener('click', toggleFullScreen);

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
    els.pageInput.value = String(state.page);
  });
  els.pageInput.addEventListener('focus', () => els.pageInput.select());

  let findTimer = null;
  els.findInput.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runFind(els.findInput.value), 250);
  });
  els.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') stepHit(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') closeFind();
  });
  $('find-next').addEventListener('click', () => stepHit(1));
  $('find-prev').addEventListener('click', () => stepHit(-1));
  $('find-close').addEventListener('click', closeFind);

  $('print-cancel').addEventListener('click', () => {
    els.printDialog.hidden = true;
  });
  $('print-go').addEventListener('click', doPrint);

  // Зум колесом с Ctrl — как во всех просмотрщиках.
  els.scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = els.scroller.getBoundingClientRect();
      setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientY - rect.top);
    },
    { passive: false },
  );

  window.addEventListener('keydown', onKey);
  bindDropOpen();
}

function onKey(e) {
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
      goToPage(state.page + 1);
      break;
    case 'ArrowLeft':
      goToPage(state.page - 1);
      break;
    case 'Home':
      goToPage(1);
      break;
    case 'End':
      goToPage(state.pageCount);
      break;
    case 'Escape':
      if (!els.printDialog.hidden) els.printDialog.hidden = true;
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

const isFullScreen = () => document.body.classList.contains('fullscreen');

function toggleFullScreen() {
  const on = !isFullScreen();
  document.body.classList.toggle('fullscreen', on);
  window.reader.setFullScreen(on);
}

function bindDropOpen() {
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer?.files || []) {
      const p = window.reader.pathForFile(file);
      if (p && p.toLowerCase().endsWith('.pdf')) {
        window.reader.openPath(p);
        break;
      }
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
  title.textContent = 'Недавние';
  els.emptyRecent.appendChild(title);

  for (const item of list.slice(0, 8)) {
    const btn = document.createElement('button');
    btn.className = 'recent-item';
    btn.type = 'button';
    btn.textContent = item.name;
    btn.title = item.path;
    btn.addEventListener('click', () => window.reader.openPath(item.path));
    els.emptyRecent.appendChild(btn);
  }
}

const menuCommands = {
  print: openPrintDialog,
  find: openFind,
  'find:next': () => stepHit(1),
  'zoom:in': () => setScale(state.scale * 1.25),
  'zoom:out': () => setScale(state.scale / 1.25),
  'zoom:reset': () => setScale(1),
  'fit:width': () => setMode('fit-width'),
  'fit:page': () => setMode('fit-page'),
  'sidebar:toggle': () => toggleSidebar(),
  'fullscreen:toggle': toggleFullScreen,
  'go:first': () => goToPage(1),
  'go:last': () => goToPage(state.pageCount),
  'go:prompt': () => els.pageInput.focus(),
};

window.reader.onDocument((info) => {
  openDocument(info).catch((err) => {
    console.error('не удалось открыть документ:', err);
    els.empty.hidden = false;
  });
});

window.reader.onCommand((type) => menuCommands[type]?.());

bindUi();
showRecent();
