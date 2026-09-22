# FoxyPDF — Lightweight PDF Reader & Organizer
## 📸 Screenshots (v1.3.0 Final)

<table>
  <tr>
    <td align="center">
      <img src="screenshots/screen%201%20interface.png" alt="Main interface" width="400"/><br/>
      <b>Main interface</b>
    </td>
    <td align="center">
      <img src="screenshots/screen%202%20support%20arabic.png" alt="Arabic support" width="400"/><br/>
      <b>Arabic support</b>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="screenshots/screen%203%20black.png" alt="Night reading mode" width="400"/><br/>
      <b>Night reading mode (black pages)</b>
    </td>
    <td align="center">
      <img src="screenshots/screen%204%20edit%20pages.png" alt="Edit pages" width="400"/><br/>
      <b>Edit pages: delete, reorder, rotate</b>
    </td>
  </tr>
</table>
> **Fork note (rights preserved):** original project **Lector** by
> **Sagar Gurtu** (v1.1.0, MIT License). **FoxyPDF** is the continued
> development of Lector by **KinanDev** since v1.2.0 (renamed in v1.3.0).
> The original `LICENSE` file and all copyright headers are kept intact.
> PDF.js viewer by Mozilla (Apache 2.0) — vendored files untouched.

A fast, lightweight, fully offline PDF reader built with Electron and
PDF.js: annotations, page organizer, image stamps, smart save, 13 color
themes, night reading mode, bookmarks, last-page memory, drag & drop,
recent files and full Arabic support. No accounts, no cloud, no AI,
no data collection.

## Features (v1.3.0 Final)

- **New identity**: renamed **Lector → FoxyPDF** with a brand-new fox logo,
  new icons and installer branding.
- Tabbed reading, thumbnails, outline, find, zoom, print (from v1.x).
- **Annotations toolbar** (redesigned docked rail): highlight, rectangle,
  cover/hide, freehand pen, write-over text, eraser, undo — adjustable
  size/shape/color, black default with last-color memory.
- **Page organizer** (improved): delete pages (with confirm), drag-reorder,
  rotate 90°, multi-select, instant apply, real undo across reloads.
- **Image stamps**: built-in icons + PNG/JPG upload, movable + resizable.
- **Smart save**: dirty dots, `Ctrl+S` overwrite (with `.bak.pdf` backup),
  `Ctrl+Shift+S` Save As (`*-MODIFIED.pdf`), per-file prompt on close/quit.
- **13 color themes** (🎨 or `T`): Dark default + accent colours, themed
  custom menubar, saved locally.
- **Night reading mode** (`N` key): white pages become black to protect
  the reader's eyes; persisted per viewer.
- **Arabic support**: Arabic UI font (Noto Sans Arabic), RTL text shaping
  in annotations, English-only app UI.
- **Drag & drop**: drop a PDF anywhere on the window → opens a new tab.
- **Bookmarks** (🔖 or `Ctrl+B`): mark pages per file, jump straight to
  them; stored locally.
- **Last-page memory**: reopening a file resumes where you left off.
- **Recent files**: recent panel + Open Recent menu with last-folder memory.
- **Improved installer** (NSIS): install-folder choice, optional desktop
  shortcut (checked by default), Start Menu entry.
- **Extras**: `Ctrl+Z` undo, English UI.

See [CHANGELOG.md](CHANGELOG.md) for the full per-version history and
[ROADMAP.md](ROADMAP.md) for the upcoming plan.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/en/) (LTS or newer)
- [Git](https://git-scm.com/)

### Clone

```
git clone https://github.com/KinanCodeaz/FoxyPDF.git
cd FoxyPDF
```

### Run (no install — runs from source, touches nothing on the system)

```
npm install
npm start
```

Open a file directly:

```
npx electron . "C:\path\to\file.pdf"
```

### Build distributions

```
npm run dist
```

Current build target: **Windows (NSIS)**. Linux/macOS targets can be
added to the `build` section of `package.json` (the code itself is
cross-platform: no OS-specific calls, `path.join` everywhere).

## Project layout

```
src/
  index.html / about.html   app shell (sandboxed, CSP, no Node)
  js/main.js                main process (windows, menus, save, sessions)
  js/preload.js             minimal contextBridge (whitelisted IPC only)
  js/index.js               tabs + viewer relay
  js/annot-burn.js          burn annotations into PDF (pdf-lib)
  js/page-ops.js            delete / reorder / rotate on PDF bytes
  js/recent.js              recent files + last folder
  lib/pdfjs/                vendored Mozilla PDF.js (Apache 2.0, untouched
                            except 4 marked include-lines in viewer.html)
  lib/pdfjs/web/lector-annot.js/.css   annotation + organizer layer (MIT)
```

## Security model

- No Node.js in any renderer (`contextIsolation` + `sandbox` + preload).
- Viewer iframe sandboxed; strict `Content-Security-Policy` (`self` only).
- No network code, no open ports; Google Fonts removed (fully offline).
- `npm audit`: 0 vulnerabilities (only `pdf-lib` at runtime).

## License

- This project: [MIT](LICENSE) — Copyright (c) 2019 Sagar Gurtu
  (v1.2.x additions by KinanDev, same license).
- [PDF.js](https://mozilla.github.io/pdf.js/): Apache License 2.0.
