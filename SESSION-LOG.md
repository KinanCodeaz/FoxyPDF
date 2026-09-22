# FoxyPDF — Session Log (2026-09-15, by KinanDev)

> Purpose: exact resume point for tomorrow. Everything below was implemented
> and syntax-verified (`node --check` clean on all files). User tests with
> `npm start` (no reinstall needed); rebuild installer only when satisfied.

## 1. Task status — ALL requested items done unless marked PENDING

| # | Request | Status | Where |
|---|---------|--------|-------|
| 1 | Bookmarks / last-page / drag&drop / recent panel / converter window (v1.3.0 base) | DONE (earlier) | `src/js/index.js`, `converter.html`, `*-preload.js` |
| 2 | Word→PDF Arabic RTL + English formatting | DONE, verified with synthetic docs | `src/js/docx-convert.js`, `docx-html.js` (fallbacks) |
| 3 | Standalone converter window | DONE | `src/converter.html` + `converter-*.js` |
| 4 | `rPr is not defined` crash | DONE (dead `extraCss` call removed) | `src/js/docx-html.js:592` (def only, unused) |
| 5 | App won't reopen / icon dead / PDF click dead (zombie lock) | DONE | `closeHiddenWindow()` in `docx-convert.js:39`, called from `main.js:105` + `before-quit` |
| 6 | docx-preview as PRIMARY engine (Apache-2.0, offline) | DONE, verified | `docx-convert.js:182-203`, `src/docx-render.html` |
| 7 | docx-preview JSZip fix (UMD needs global JSZip) | DONE | vendored `src/assets/js/jszip.min.js` + `docx-preview.min.js`, load order jszip FIRST |
| 8 | Screen-only gray + box-shadows never print | DONE | `docx-render.html` CSS `!important` overrides |
| 9 | RTL table mirror (bidiVisual) | DONE, verified (flipped:1, col order = Word) | `detectRtlTables()` + `flipRtlTables()` (count-match guard) |
| 10 | Trailing blank page | DONE, verified (PAGES:1) | `preferCSSPageSize:true` + zero margins |
| 11 | Arabic font stack | DONE | `docx-render.html` + `docx-convert.js` PRINT_CSS |
| 12 | foxy.png becomes THE icon | DONE, verified ICO header (type=1, 7 sizes) | `logo.png/.ico`, `win/icon.ico`, `win/file.ico`, `png/256x256.png` |
| 13 | Publisher rebrand (Éditeur=KinanDev, keep MIT attribution) | DONE | `package.json` author+copyright, `LICENSE` both lines |
| 14 | About: my name top-bold, old author small below | DONE | `about.html` `#devName`/`#origName` + `about.css` |
| 15 | Rail hide button unreachable | DONE (pinned FIRST) | `lector-annot.js:895` + dock CSS |
| 16 | Remove duplicate top image button | DONE (hidden, entry points intact) | `viewer.html:243` (marked v1.3.0) |
| 17 | Rail → fixed vertical dock (left, full height) | DONE → REDONE as horizontal toolbar | `lector-annot.css` `#lectorAnnotBar` + grip removed |
| 18 | Night reading mode (rail+View+N+native menu, persisted) | DONE | `setNight/applyNight`, `lector-night` CSS, `night-toggle` channel (menutemplate→preload→index→viewer) |
| 19 | Custom color picker next to presets | DONE | `lectorCustomColor` input + `hexToRgb/rgbToHex` |
| 22 | Annotation bar → horizontal toolbar (top-docked, wraps) | DONE | `lector-annot.css` (flex-direction:row, top:34px), `lector-annot.js` buildBar (separators between groups) |
| 23 | SVG icons for toolbar (clean, crisp at any size) | DONE | `ICONS` object in `lector-annot.js` (24x24 viewBox SVGs for all tools) |
| 24 | Image stamp size + rotation controls | DONE | `stampSize`/`stampRotation` vars, `#lectorStampControls` panel with sliders, `placeStamp` uses size/rotation |
| 25 | Beautiful colorful SVG icons for toolbar | DONE | `ICONS` object with colored SVGs: blue select, green move, yellow highlight, red pen, purple text, etc. |
| 26 | Image upload button (prominent blue button) | DONE | `#lectorStampRow .la-stamp-upload` with upload icon + "Add Image" label |
| 27 | Centered floating toolbar | DONE | `#lectorAnnotBar` uses `left:50%; transform:translateX(-50%)`, `max-width:90vw`, rounded corners |
| 28 | Remove hide button from toolbar | DONE | Removed `hide` button from `buildBar()` |
| 29 | Remove FAB button (always visible toolbar) | DONE | Removed `showFab()`, `placeBarAtFab()`, `applyStoredPos()`, `loadFabPos()`, `saveFabPos()` |
| 30 | Separate image upload vs stamp tool | DONE | `image` tool = upload from device (opens picker), `stamp` tool = built-in icons (check, star, arrows) |
| 31 | Differentiate delete/clear icons | DONE | `delete` = trash with vertical lines (one annotation), `clear` = trash with fire (all annotations) |
| 20 | Real-file issues (ورقة ارسال position, watermark, اكادير side, font-size feel) | PENDING — needs user's `diag-docx.js` output | diag script: `C:\Users\PC-HP\AppData\Local\Temp\opencode\diag-docx.js` |
| 21 | PDF→Word (reverse) feature | PENDING — user-gated on conversion quality | — |

## 2. Verification evidence (all reproduced today)

- `t-cv.docx` (German CV): engine=docx-preview, paragraphs=7, colored=2, bold=2; PDF lines in order.
- `t-ar-table.docx` (Arabic + bidiVisual table + image): tables flipped 1/1; PDF PAGES=1; header x-order الوثائق>عدد>ملاحظات (=Word); sentence `السلام عليكم ورحمة الله تعالى و بركاته` in logical order; image op present.
- PDF text checked with `pdfjs-dist` (temp-only dep, NOT in project).
- `node --check` clean: all `src/js/*.js` + `lector-annot.js`; `package.json` valid JSON; viewer.html button tags balanced (42/42).

## 3. Architecture notes (don't break)

- Converter chain: `docx-preview` → `docx-html.js` → `mammoth`. Result has `engine` field.
- Hidden converter window is a SINGLETON (`getHiddenWindow`, `hiddenMode` render|data); never create a second one (breaks sequential loads); always `closeHiddenWindow()` on quit/close.
- `flipRtlTables` flips ONLY on table-count match — safe default.
- Viewer messages use `ns:'lector-annot'`; parent→iframe via `_askViewer()` (index.js:781); iframe→parent via `post()`.
- Vendored files NEVER edit except marked lines: `viewer.html` (5 marked), `viewer.js/css` untouched.
- Night CSS inverts ONLY `.page canvas:not(.lector-annot)` — overlay stays true-color.
- `N` shortcut lives in PARENT doc only (iframe typing unaffected).
- Annotation bar is HORIZONTAL (v1.3.0 redesign): `#lectorAnnotBar` uses `flex-direction:row`, fixed at `top:34px`, full width. Separators (`la-sep`) between tool groups. FAB (✎) still works to reopen after hide.
- SVG icons: `ICONS` object in `lector-annot.js` defines all toolbar icons as 24x24 viewBox SVGs. Use `innerHTML` to render. Buttons use `flex: 0 0 auto` to prevent shrinking.
- Image stamp controls: `stampSize` (20-300pt, default 80) and `stampRotation` (0-360°) in `#lectorStampControls` panel. `placeStamp` reads these values; `drawAnnot` applies rotation via `ctx.rotate()`.

## 4. Tomorrow: start here

1. User runs (no install): `taskkill /IM FoxyPDF.exe /F` → `cd lector` → `npm start`.
2. If real-file problems remain → user pastes `diag-docx.js` output (structure dump shows jc/bidi/style per paragraph) → fix precisely.
3. Then: `npm run dist` → install `dist\FoxyPDF_Setup.exe` (replaces 1.3.0, new icon + Éditeur=KinanDev).
4. Open items: #20 (needs user data), #21 (PDF→Word), README feature lines for night/rail (micro-task).
5. Temp scripts live in `C:\Users\PC-HP\AppData\Local\Temp\opencode\` (diag-docx.js, make-*.js, verify*.mjs) — project dir is clean.
