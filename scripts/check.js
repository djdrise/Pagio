#!/usr/bin/env node
'use strict';

// Синтаксическая проверка всех исходников — дешёвый барьер, который ловит
// опечатки до запуска программы. Код окна — ES-модули, главный процесс и
// preload — CommonJS, поэтому каждый файл проверяется в своём режиме.
// Файлы .mjs — модули всегда и везде: их читают и окно, и node --test.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'scripts', 'test'];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d))).sort();
let failed = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const isModule = rel.endsWith('.mjs') || rel.startsWith(path.join('src', 'renderer'));
  try {
    if (isModule) {
      execFileSync(process.execPath, ['--input-type=module', '--check'], {
        input: fs.readFileSync(file),
      });
    } else {
      execFileSync(process.execPath, ['--check', file]);
    }
    console.log(`  ok  ${rel}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${rel}\n${err.stderr?.toString() || err.message}`);
  }
}

console.log(`\n${files.length - failed} из ${files.length} файлов без ошибок`);
process.exit(failed ? 1 : 0);
