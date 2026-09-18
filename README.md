# Pagio

**English** · [Русский](README.ru.md)

[![Latest release](https://img.shields.io/github/v/release/djdrise/Pagio?label=release)](https://github.com/djdrise/Pagio/releases/latest)
[![Check](https://github.com/djdrise/Pagio/actions/workflows/check.yml/badge.svg)](https://github.com/djdrise/Pagio/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A PDF reader for working with documents: continuous scrolling, text search,
printing, an outline, thumbnails and a full-screen show. Modelled on
SumatraPDF — the window belongs to the document, not to the panels.

Windows · macOS · Linux (Electron + pdf.js). MIT licence.

## Install

Prebuilt installers are on the
[Releases](https://github.com/djdrise/Pagio/releases) page: `.dmg` for macOS
(Apple Silicon and Intel separately), `.exe` for Windows (installer and
portable), `.AppImage` and `.deb` for Linux.

The builds are ad-hoc signed but neither notarized by Apple nor covered by a
Windows certificate, so the first launch needs a nudge:

* **macOS** — System Settings → Privacy & Security, find the message about
  Pagio and click “Open Anyway”. On macOS 14 and earlier, right-clicking the
  app → “Open” works too. If macOS claims the app is damaged, clear the
  quarantine flag: `xattr -dr com.apple.quarantine /Applications/Pagio.app`
* **Windows** — SmartScreen warns: “More info” → “Run anyway”.
* **Linux** — make the AppImage executable: `chmod +x Pagio-*.AppImage`.

## What it does

* **Tabs.** Several documents in one window, each tab with its own pages, zoom,
  thumbnails, outline, search and scroll position. The two most recent tabs
  keep their pages rendered and come back instantly; the rest redraw on return,
  in a fraction of a second and without losing the place. A file that is
  already open is not opened twice — the window simply switches to it.
* **A continuous ribbon of pages.** The document scrolls as a whole, with page
  boundaries visible. Only the pages on screen live in memory, plus a small
  margin, so a thousand-page document opens as fast as a ten-page one.
* **Zoom** to width, to whole page, or to a value you pick; with
  <kbd>Ctrl</kbd> and the wheel the point under the cursor stays put.
* **Page rotation** — the button next to the zoom control, or
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>; counter-clockwise is
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>. Scans often arrive lying on
  their side and cannot be read otherwise. The rotation is remembered along
  with the page and the zoom, and the document prints the way it looks.
* **Text search** highlighting every match and stepping between them. Case is
  ignored, and Russian “ё” and “е” count as one letter.
* **Selecting and copying text** with the mouse — a real text layer sits on top
  of the page.
* **Sidebar** with page thumbnails and the document outline.
* **Printing** the whole document or a range of pages through the system
  dialog. What goes on paper is the document itself, not the application
  window.
* **Full screen** on <kbd>F11</kbd>.
* **Show** on <kbd>F5</kbd> or <kbd>Ctrl</kbd>+<kbd>L</kbd>: no frame, no
  panels, one page per screen, paged with the keyboard, a click or the wheel.
  Leaving with <kbd>Esc</kbd> restores the previous zoom and keeps you on the
  page where the show ended. A slide rarely matches the shape of the screen,
  so bands are left along the edges — the settings choose whether to fill them
  black (the default) or white, and on white slides the frame disappears
  entirely.
* **Settings** — the gear button in the toolbar or View → Settings…: show
  background, whether to reopen last session's tabs, and the interface
  language. They are kept next to the recent files, in `settings.json`.
* **Recent documents** — on the empty screen and in the File menu. Next to the
  name is when the file was opened: the time for today, the year for last year,
  and the day with the month in between. The full date is in the tooltip,
  together with the path. Files that no longer exist on disk are dropped from
  the list.
* **English and Russian** interface. Switched in the settings and applied at
  once — menu, tooltips and an already displayed search result included.
* **Help** — the question-mark button: a short description and the main
  keyboard shortcuts, without leaving the program.
* Remembers the page and the zoom you stopped reading at.

## Keys

| Keys | Action |
| --- | --- |
| <kbd>↓</kbd> <kbd>↑</kbd>, wheel | scroll |
| <kbd>PageDown</kbd> <kbd>PageUp</kbd>, <kbd>Space</kbd> | one screen forward / back |
| <kbd>→</kbd> <kbd>←</kbd> | next / previous page |
| <kbd>Home</kbd> <kbd>End</kbd> | to the beginning / to the end |
| <kbd>Ctrl</kbd>+<kbd>F</kbd>, <kbd>F3</kbd> | find, next match |
| <kbd>Ctrl</kbd>+<kbd>=</kbd> <kbd>Ctrl</kbd>+<kbd>-</kbd> <kbd>Ctrl</kbd>+<kbd>0</kbd> | zoom |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | rotate right / left |
| <kbd>Ctrl</kbd>+<kbd>O</kbd>, <kbd>Ctrl</kbd>+<kbd>P</kbd> | open, print |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | close the tab (the middle mouse button does the same) |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> | next tab, with <kbd>Shift</kbd> the previous one |
| <kbd>F4</kbd> | sidebar |
| <kbd>F11</kbd> | full screen |
| <kbd>F5</kbd>, <kbd>Ctrl</kbd>+<kbd>L</kbd> | show: one page per screen |
| <kbd>Esc</kbd> | close find, leave the show and full screen |

In the show the keys move by pages rather than by screens: <kbd>→</kbd>
<kbd>↓</kbd> <kbd>PageDown</kbd> <kbd>Space</kbd> <kbd>Enter</kbd> go forward,
<kbd>←</kbd> <kbd>↑</kbd> <kbd>PageUp</kbd> <kbd>Backspace</kbd> go back. A
click on the page and the mouse wheel do the same.

## Running from source

Node.js 20 or newer.

```bash
npm install
npm start                 # open an empty window
npm start -- file.pdf     # straight to a document
npm run dev               # the same, plus developer tools in the menu
```

> `npm start` goes through `scripts/start.js`. The VS Code terminal exports
> `ELECTRON_RUN_AS_NODE=1`, and with it the Electron binary starts as plain
> Node and the app fails. The launcher clears that variable.

A test document is built on the spot:

```bash
npm run sample            # sample.pdf, 60 pages of varying height
```

## Checks

```bash
npm run check   # syntax of every source file
npm test        # tests for the pure logic: ribbon layout and search
```

GitHub Actions runs both on every push to `main` and on every pull request.

The tests cover what is awkward to check by hand: the scrolling arithmetic
(page offsets, the visible range, holding the anchor point while zooming), the
text parsing behind search (case, “ё”, matches straddling the boundary between
text chunks) and how recently a file was opened (the day and year boundaries —
verifying those by hand would mean moving the clock).

## Building installers

```bash
npm run dist:mac     # dmg and zip
npm run dist:win     # installer and portable
npm run dist:linux   # AppImage and deb
```

electron-builder only builds for the host OS, so releases are built on GitHub
Actions — one job per system. The
[`release.yml`](.github/workflows/release.yml) workflow fires on a `v*` tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## Icons

The icons are generated from two source SVGs and committed ready-made — they
only need rebuilding after the SVGs themselves change:

```bash
npm run icons
```

Electron rasterizes them itself (it is already a dependency), so nothing extra
has to be installed. From `assets/icon.svg` comes the Pagio mark: a solid
46×46 tile centred on (32, 32) with two lines cut out of it. The cuts use the
`evenodd` rule, so they go right through rather than being filled with the
background colour: the tile itself shows through them and one file suits any
backdrop. The line thickness (6) and the bridge between them (10) are tuned for
16 pixels — at that size both lines are still distinct. It yields the
application icons: `build/icon.ico` for Windows, `build/icons/` for Linux,
`build/icon.icns` for macOS (when `iconutil` is at hand) and
`assets/icon-256.png` for the window at runtime. From `assets/icon-file.svg`
come `build/icon-file.ico` and `build/icon-file.icns`, the icon for PDF files
associated with the program: in a file manager the document and the application
have to be told apart at a glance. On Linux the file icon comes from the
desktop theme by `application/pdf` type, so it is not taken from this file
there.

The variants the current mark was chosen from are in `assets/logo.html` — open
it in a browser. That page is not shipped.

## Layout

```
src/main/main.js              window, tabs, menu, file reading, printing, thumbnail cache
src/main/lib/recent.js        the list of recent files
src/main/lib/menu-strings.js  menu and system dialog strings, two languages
src/main/lib/thumbcache.js    naming and eviction of thumbnails on disk
src/preload/preload.js        the bridge between the window and the main process
src/renderer/viewer.js        tabs, page ribbon, zoom, sidebar, search, show
src/renderer/print.js         rendering pages for printing
src/renderer/lib/pdfdoc.js    a wrapper over pdf.js, cache of parsed pages
src/renderer/lib/scrolllayout.mjs  the arithmetic of the continuous ribbon
src/renderer/lib/search.mjs   text parsing and matching
src/renderer/lib/strings.mjs  window strings, two languages
src/renderer/lib/when.mjs     how long ago a file was opened: time, date or year
src/renderer/lib/renderqueue.js    the render queue
src/renderer/lib/thumbstore.js     thumbnails in memory
scripts/make-icons.js         application and document icons from SVG
assets/icon.svg               the application mark
assets/icon-file.svg          the mark for associated documents
assets/logo.html              the variants the current mark was chosen from
```

The settings live in the main process and reach the window at startup. Values
are validated against an allow-list on the way in: the settings file gets
edited by hand, and rubbish from it never reaches the window.

There are two sets of strings, one per process: the menu is assembled in the
main process and the interface in the window, and the two share only a handful
of strings. Tying them to a single file is impossible without a build step —
the main process is CommonJS, the window is ES modules. The Russian strings
also sit in the markup itself: if a key goes missing, the window stays
readable. The window is translated not through attributes scattered across the
markup but through a single lookup table in `viewer.js` — a forgotten element
shows up immediately. Search state is kept in parts (“so many of so many”)
rather than as a finished string; otherwise it would stay in the old language
after a switch.

An open document lives in two places at once: the main process remembers only
its path and size, while the window holds the parsed PDF and the rendered
pages. A tab is a pair of such states tied by a shared `id`; closing the tab
releases both.

The `.mjs` files are pure logic without the DOM: the window and `node --test`
read them alike, so that logic is covered by tests with no build step and no
duplication.

The document is never read into memory whole: the window learns only its size
and fetches the bytes in chunks through the main process as needed. On large
files this shows in both memory and opening time.

Memory is held by canvases, not by the markup: a page at fit-width weighs tens
of megabytes, a thumbnail about one. Canvases are therefore released as soon as
they stop being needed — pages outside the visible range and in long-abandoned
tabs, thumbnails once they leave the panel (the picture itself stays in
`ThumbStore` and comes back without redrawing). Eight open documents of
400–1000 pages hold about 80 MB of canvases, and that figure grows neither with
the number of tabs nor with how many thumbnails have been scrolled past.

## Dependencies

* [pdf.js](https://github.com/mozilla/pdf.js) — PDF parsing and rendering, Apache-2.0
* [Electron](https://www.electronjs.org/) — the application shell, MIT
