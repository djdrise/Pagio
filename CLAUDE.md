# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pagio — a PDF reader built on Electron + pdf.js. [README.md](README.md) documents
features, keyboard shortcuts, the file tree and the icon pipeline; this file covers
what is not obvious from reading any single file.

## Commands

```bash
npm start                 # empty window
npm start -- file.pdf     # straight to a document
npm run dev               # same, plus developer tools in the menu
npm run sample            # generate sample.pdf, 60 pages of varying height

npm run check             # syntax of every file under src/, scripts/, test/
npm test                  # all tests
node --test test/search.test.js                      # one file
node --test --test-name-pattern="ё" test/*.test.js   # one test by name
```

There is no linter and no formatter. `npm run check` only parses each file — in the
right module mode, which is the point: it catches a CommonJS/ESM mix-up before the
app is launched.

`npm start` goes through [scripts/start.js](scripts/start.js) rather than calling
Electron directly. A terminal spawned from an Electron app inherits
`ELECTRON_RUN_AS_NODE=1`, and with it the Electron binary starts as plain Node,
`require('electron')` returns a path string and the app dies. The launcher clears it.

Releases are cut by pushing a tag — `git tag v0.1.3 && git push origin v0.1.3` —
which fires [release.yml](.github/workflows/release.yml). electron-builder only
builds for the host OS, so all three platforms are built on GitHub runners. Local
`npm run dist:mac|win|linux` builds the host platform only.

## Two module systems, one codebase

This shapes nearly every change:

- **Main process and preload** — CommonJS (`require`).
- **Renderer** — ES modules (`import`), loaded straight from `index.html`.
- **`.mjs` files under `src/renderer/lib/`** — pure logic with no DOM, imported by
  both the renderer and `node --test`. This is the only reason the arithmetic is
  testable without a build step. There is no bundler; keep DOM access out of `.mjs`
  or the tests stop running.
- Tests are `.test.js` (CommonJS) and reach the logic through dynamic `import()`.

The same split forces **two separate string tables** —
[menu-strings.js](src/main/lib/menu-strings.js) for the menu and system dialogs,
[strings.mjs](src/renderer/lib/strings.mjs) for the window. Unifying them needs a
build step. The window is translated through one lookup table (`UI` in
[viewer.js](src/renderer/viewer.js)), not through attributes scattered over the
markup, so a forgotten element shows up at once. Search status is stored in parts
("N of M"), never as a finished string — otherwise it keeps the old language after
a switch.

## How a document flows

The file is never read into memory whole. The chain spans three files and is easy
to break by "simplifying" any one of them:

1. Main process keeps only `{id, path, name, length}` per open document and serves
   byte ranges over `doc:range` ([main.js](src/main/main.js)).
2. [preload.js](src/preload/preload.js) is the entire IPC surface — the renderer has
   no Node access. Anything new the window needs must be added here explicitly.
3. [pdfdoc.js](src/renderer/lib/pdfdoc.js) feeds those ranges to pdf.js through a
   custom `PDFDataRangeTransport`. pdf.js only does range requests for `http:` URLs,
   so a local file needs this transport. `disableAutoFetch: true` stops pdf.js from
   quietly pulling the rest of the file in the background.

pdf.js is imported from the **legacy** build on purpose: the regular 5.7 build uses
`Map.prototype.getOrInsertComputed`, which Electron 38's V8 lacks.

## Tabs and memory

A tab is one `session` object in [viewer.js](src/renderer/viewer.js) plus an entry in
the main process's `docs` map, tied by a shared `id`. Closing a tab must release both
sides — `destroySession` and the `doc:close` message.

Memory is held by canvases, not by markup: a fit-width page is tens of megabytes, a
thumbnail about one. The budgets are deliberate and worth preserving:

- `KEEP_RENDERED = 2` — only the two most recently used tabs keep rendered pages;
  the rest drop their canvases and redraw on return without losing their place.
- `OVERSCAN = 0.6` — how far beyond the viewport pages stay alive.
- `ThumbStore` budget 64 MB in memory; the on-disk thumbnail cache 200 MB
  ([thumbcache.js](src/main/lib/thumbcache.js)).

## pdf.js CSS contract

[app.css](src/renderer/styles/app.css) replaces pdf.js's own `pdf_viewer.css`, so any
rule that library depends on has to be reproduced here. Two already are, both marked
in the file, and both were bugs before they were rules:

- `.text-layer` — pdf.js positions spans in percentages and passes font height in
  document units; the stylesheet must convert them.
- `.hiddenCanvasElement` — pdf.js appends a measuring canvas straight to `body` with
  no dimensions, expecting its own stylesheet to hide it. Unhidden it is a 300×150
  opaque-black element that steals 150px from the page ribbon.

Before blaming layout code for a visual glitch, check whether pdf.js added an element
that needs a rule here.

## macOS signing

[scripts/adhoc-sign.js](scripts/adhoc-sign.js) runs as electron-builder's `afterPack`
hook and ad-hoc signs the bundle. This is not optional: Electron arrives with a
linker-signed binary whose signature stops matching once the bundle is renamed and
`app.asar` is inserted, and Apple Silicon refuses to launch code with an invalid
signature. electron-builder 25 has no ad-hoc path of its own — finding no
certificate, it simply skips signing.

It must be `afterPack`, not `afterSign`: the latter is never called when signing was
skipped, which here is always. The hook verifies its own work so a bad signature
fails the build instead of the user's launch.

## Conventions

- **No Claude attribution in commits or PRs** — no `Co-Authored-By: Claude`, no
  "Generated with Claude Code". The trailer creates a phantom co-author on GitHub.
- Commit messages are in Russian: a short subject line, a blank line, then prose
  explaining *why* the change was needed and what the alternative failed at. Match
  the existing history.
- Code comments are in Russian and explain reasoning, not mechanics. The codebase
  leans on them heavily; a change that invalidates a comment should update it.
- Settings arriving from `settings.json` are validated against an allow-list before
  they reach the window — the file gets hand-edited, and a bad value would otherwise
  break applying settings wholesale.
