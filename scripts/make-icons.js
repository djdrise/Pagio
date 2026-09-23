#!/usr/bin/env node
'use strict';

// Значки программы и связанных с ней файлов — из двух исходных SVG.
//
//   npm run icons
//
// Рисовать SVG умеет браузер, и он у проекта уже есть: скрипт перезапускает сам
// себя под Electron и растеризует знак через canvas. Отдельная библиотека ради
// десятка картинок была бы лишней зависимостью в сборке.
//
// Что получается:
//   build/icon.png        1024×1024 — из него electron-builder делает остальное
//   build/icon.ico        значок программы для Windows, все размеры в одном файле
//   build/icons/NxN.png   значки для Linux
//   build/icon-file.ico   значок документа PDF в проводнике Windows
//   build/icon-file.png   он же картинкой, для тем оформления Linux
//   build/icon.icns       значок для macOS, если под рукой есть iconutil
//   build/icon-file.icns  значок документа для macOS, там же
//   assets/icon-256.png   значок окна во время работы

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Запуск под Electron
// ---------------------------------------------------------------------------
// Как и scripts/start.js: из терминала VS Code наследуется ELECTRON_RUN_AS_NODE,
// с которой Electron стартует обычным Node и рисовать ничем не может.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const electron = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const res = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(res.status ?? 1);
}

const { app, BrowserWindow } = require('electron');

/** Размеры для Linux и для значка окна. */
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
/** Что кладём внутрь .ico. Больше 256 Windows в значках не показывает. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Рисует SVG в PNG заданного размера.
 * @returns {Promise<Buffer>}
 */
async function render(win, svg, size) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(src)};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${size};
    canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
    return canvas.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/**
 * Собирает .ico из готовых PNG.
 *
 * Формат простой: заголовок, таблица описаний и сами картинки следом. Windows
 * начиная с Vista понимает PNG внутри .ico, поэтому перекодировать в BMP не
 * нужно — а вот размер 256 в таблице записывается нулём, места под него в байте
 * не хватает.
 *
 * @param {{size: number, data: Buffer}[]} images
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // зарезервировано
  header.writeUInt16LE(1, 2); // тип: значок
  header.writeUInt16LE(images.length, 4);

  const table = Buffer.alloc(16 * images.length);
  let offset = header.length + table.length;
  images.forEach((image, i) => {
    const at = i * 16;
    const side = image.size >= 256 ? 0 : image.size;
    table.writeUInt8(side, at);
    table.writeUInt8(side, at + 1);
    table.writeUInt8(0, at + 2); // цветов в палитре: полноцветный
    table.writeUInt8(0, at + 3); // зарезервировано
    table.writeUInt16LE(1, at + 4); // плоскостей
    table.writeUInt16LE(32, at + 6); // бит на пиксель
    table.writeUInt32LE(image.data.length, at + 8);
    table.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, table, ...images.map((image) => image.data)]);
}

/** Значок macOS: своего кодировщика не пишем, зовём системный iconutil. */
function buildIcns(images, out) {
  if (process.platform !== 'darwin') return false;
  const { spawnSync } = require('node:child_process');
  const dir = path.join(path.dirname(out), `${path.basename(out, '.icns')}.iconset`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Имена файлов внутри .iconset заданы Apple и менять их нельзя.
  const names = {
    16: ['icon_16x16.png'],
    32: ['icon_16x16@2x.png', 'icon_32x32.png'],
    64: ['icon_32x32@2x.png'],
    128: ['icon_128x128.png'],
    256: ['icon_128x128@2x.png', 'icon_256x256.png'],
    512: ['icon_256x256@2x.png', 'icon_512x512.png'],
    1024: ['icon_512x512@2x.png'],
  };
  for (const image of images) {
    for (const name of names[image.size] || []) {
      fs.writeFileSync(path.join(dir, name), image.data);
    }
  }
  const res = spawnSync('iconutil', ['-c', 'icns', dir, '-o', out], { stdio: 'inherit' });
  fs.rmSync(dir, { recursive: true, force: true });
  return res.status === 0;
}

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`  ${path.relative(ROOT, file)} — ${(data.length / 1024).toFixed(1)} КБ`);
};

// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('about:blank');

  const appSvg = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
  const fileSvg = fs.readFileSync(path.join(ROOT, 'assets', 'icon-file.svg'), 'utf8');

  const sizes = [...new Set([...PNG_SIZES, ...ICO_SIZES, 1024])].sort((a, b) => a - b);
  const appIcons = [];
  const fileIcons = [];
  for (const size of sizes) {
    appIcons.push({ size, data: await render(win, appSvg, size) });
    fileIcons.push({ size, data: await render(win, fileSvg, size) });
  }
  const pick = (icons, list) => list.map((size) => icons.find((i) => i.size === size));

  console.log('Значки программы:');
  write(path.join(ROOT, 'build', 'icon.png'), appIcons.find((i) => i.size === 1024).data);
  write(path.join(ROOT, 'build', 'icon.ico'), buildIco(pick(appIcons, ICO_SIZES)));
  for (const size of PNG_SIZES) {
    write(
      path.join(ROOT, 'build', 'icons', `${size}x${size}.png`),
      appIcons.find((i) => i.size === size).data,
    );
  }
  write(path.join(ROOT, 'assets', 'icon-256.png'), appIcons.find((i) => i.size === 256).data);

  const icns = path.join(ROOT, 'build', 'icon.icns');
  if (buildIcns(appIcons, icns)) {
    console.log(`  ${path.relative(ROOT, icns)} — ${(fs.statSync(icns).size / 1024).toFixed(1)} КБ`);
  }

  console.log('Значки документа:');
  write(path.join(ROOT, 'build', 'icon-file.ico'), buildIco(pick(fileIcons, ICO_SIZES)));
  write(path.join(ROOT, 'build', 'icon-file.png'), fileIcons.find((i) => i.size === 512).data);

  const fileIcns = path.join(ROOT, 'build', 'icon-file.icns');
  if (buildIcns(fileIcons, fileIcns)) {
    console.log(`  ${path.relative(ROOT, fileIcns)} — ${(fs.statSync(fileIcns).size / 1024).toFixed(1)} КБ`);
  }

  app.quit();
});

app.on('window-all-closed', () => app.quit());
