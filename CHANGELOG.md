# Changelog

## v1.3.0 Final (by KinanDev)

- **Word→PDF converter removed**: after extensive work the conversion output
  never matched Word's fidelity, so the feature was dropped entirely.
  FoxyPDF 1.3.0 Final is a pure offline PDF reader + annotator. All
  converter code, windows, menus, IPC channels and dependencies
  (`@xmldom/xmldom`, `jszip`) were deleted.
- **Full code audit**: one shared `src/js/theme-list.js` (was 5 copy-pasted
  theme lists), single `writeSidecar()` writer with file fingerprint,
  unified dataURL decoder in `annot-burn.js`, fixed a bookmark crash
  (`toggleBookmark` after `clearBookmarks`), removed dead menus, debug logs
  and stale docs. Verified by execution tests (sidecar logic, burn pipeline).
- Smaller installer: English-only locale pack, pruned file exclusions.

## v1.3.0 — Word→PDF engine switched to docx-preview (by KinanDev)

- PRIMARY converter is now `docx-preview` (Apache-2.0, offline, ~75KB +
  already-present jszip): renders the .docx exactly like Word — direct
  colors/sizes, bold/underline, styles, tables, images, RTL/Arabic shaping —
  then Chromium printToPDF. Verified: German CV keeps blue/red/bold/underline,
  Arabic sentence keeps logical word order with pdf.js `dir: rtl` markers.
- `src/docx-render.html` render shell (loads `assets/js/jszip.min.js` BEFORE
  `docx-preview.min.js` — the UMD build needs a global JSZip), screen-only
  wrapper gray + box-shadows stripped so they never print.
- Fallback chain: docx-preview → `docx-html.js` → `mammoth`.
- `closeHiddenWindow()` on main-window close + `before-quit` so no zombie
  process holds the single-instance lock (app reopens normally).
- RTL tables: Word `w:bidiVisual` tables are mirrored (`direction:rtl` via
  `flipRtlTables`, indexes detected from `document.xml` in document order,
  applied only on count match) — Arabic column order now matches Word.
- No more trailing blank page: `preferCSSPageSize:true` + zero page margins.
- Wider Arabic font fallback stack (Traditional/Simplified Arabic, Tahoma…);
  original Word font names always preserved first.
- Publisher rebrand: installer Éditeur + copyright now KinanDev (original
  MIT copyright by Sagar Gurtu preserved in LICENSE + About, as required).
- About window: developer name on top (bold), original author small below.
- Annotation rail: FIXED docked vertical bar (left edge, full height) instead
  of floating/draggable; hide (–) button pinned FIRST so it can never scroll
  out of reach; duplicate top-bar image button removed (stamps live only in
  the rail); native color picker added next to the 8 presets (free, no deps).
- Night reading mode 🌙 (rail button, View menu, `N` key): inverts page
  rendering to white-text-on-black, persisted per viewer.

## v1.3.0 — FoxyPDF: rebrand + themes + 4 new reader features (by KinanDev)

> Same rights: original project **Sagar Gurtu** (MIT), PDF.js **Mozilla**
> (Apache 2.0) — attribution preserved in LICENSE, About and README.

### Rebrand & icon
- Product renamed **Lector → FoxyPDF**: window titles, About, README,
  `productName`, `appId` (`com.kinandev.foxypdf`), setup artifact becomes
  `FoxyPDF_Setup.exe`. Brand-new fox icon (`logo.ico` / `logo.png`).

### 13 themes + accent (🎨 / `T`, or View → Theme)
- 13 themes (original KillerPDF colour palettes), Dark default, accent
  colour (6) on Dark/Light/Black/98SE families.
- Themed custom menubar (File/Edit/View/Settings/Help) matching the theme;
  native menu is hidden but keeps its accelerators.
- Theme + accent saved locally (userData, no cloud).

### Drag & drop (v1.3.0)
- Drop any PDF onto the window → opens in a new tab (drop overlay hint).

### Last-page memory (v1.3.0)
- The viewer remembers the last page read **per file** (debounced, local
  JSON) and resumes there next time you open the same PDF.

### Bookmarks (v1.3.0, 🔖 / `Ctrl+B`)
- Bookmark the current page (or remove it) with one click; jump straight
  to any bookmarked page from the **🔖 panel** (bottom right).
- Stored per file, local-only.

### Word → PDF (v1.3.0, File → Convert Word (.docx) to PDF…)
- `mammoth` loader is required **lazily on demand**; rendering uses
  Chromium's own `printToPDF` in a hidden window — fully offline, free,
  no cloud. Saves the resulting PDF wherever you choose and opens it.
- **Faithful formatting (v1.3.0 refinement)**: the conversion now uses a
  custom OOXML→HTML converter (`src/js/docx-html.js`, jszip + @xmldom,
  both already shipped via mammoth) that preserves Word's **direct
  formatting** — colours, font sizes, bold/italic/underline/strike,
  alignment (centre/right/justify), indentation, table borders + cell
  shading, hyperlinks, images and Arabic RTL. `mammoth` stays as the
  automatic fallback only if a document is too exotic for the converter.
- Standalone **Convert window** (520×480): pick Word file → choose save
  location (same folder or custom) → Convert → Open in FoxyPDF.

## v1.2.2 — Page organizer, image stamps & smart save (by KinanDev)

> Same rights: original project **Sagar Gurtu** (MIT), PDF.js **Mozilla**
> (Apache 2.0). New files: `src/js/page-ops.js` (MIT, KinanDev).
> Extended: `src/js/main.js`, `menutemplate.js`, `preload.js`, `index.js`,
> `annot-burn.js`, `lector-annot.js/css`, `viewer.html` (4 marked lines).

### 1. Page organizer — VISUAL-FIRST, zero reloads (🗂 + sidebar + top bar)
- Rotation is **instant and silent** (native per-page re-render, no popup,
  no reload, 360° works forever — absolute angles, never stuck deltas).
- Delete/reorder render instantly in place (hidden divs / DOM order).
- Top-center bar on thumbnail click: delete / rotate / move up / down /
  add image; Ctrl+click multi-select; Esc hides.
- Organizer panel: drag-reorder, ✓ check-select + batch delete/rotate.
- Delete always confirms (single + batch with count); Cancel stages
  nothing (no stuck red frame).
- Annotations stay glued to their pages (identity-keyed, no remap bugs).

### 2. Image & icon stamps (🖼)
- Top-toolbar 🖼 opens the bar **and the file picker at once** (icons stay
  in the chooser row if cancelled); failures report exactly where.
- 6 built-in icons (✓ ✖ ★ → ← ⚠, rasterized locally, zero files) +
  **upload PNG/JPG** from disk (auto-downscaled to 1024px, 5 MB cap).
- Stamps move with ✥, delete with eraser/✖/Delete, and **resize by the
  corner handle**; burned as embedded images on export.

### 3. Smart save (replaces single "Save Annotated")
- **Dirty tracking**: any edit puts • on the tab + title.
- `File → Save` (`Ctrl+S`): overwrites the original **after keeping
  `<base>.bak.pdf` backup beside it**; burned annots are then part of the
  file, so sidecar/overlay reset (no double rendering).
- `File → Save As...` (`Ctrl+Shift+S`): defaults to **same folder +
  `<base>-MODIFIED.pdf`** (e.g. `EDIT-ME-NOW-MODIFIED.pdf`); original kept.
- Closing a dirty tab **or quitting the app** asks per file:
  [Save] [Save As...] [Discard] [Cancel] — all executed in main from the
  sidecar, so background tabs are safe too (no viewer round-trip).
- Close flows are **fail-open**: a broken dialog can never trap a tab or
  the window (edits always survive in the sidecar).
- Sidecar v2 `{annots, visOps}` (old sidecars still load); text annots
  carry their baked PNG, making every save viewer-independent.

### Refinements 12 — pre-release polish (same v1.2.2)
- **Ctrl+Z undo** (in-viewer, typing-aware) with three tiers: session
  stack → baked-reorder history → cross-reload slots (swap = redo). No
  menu accelerator on purpose — it would hijack text fields.
- **Edit → Undo last change** menu entry (clickable, safe).
- **File → Open Recent** (10 files, Ctrl+1..9, missing auto-pruned, Clear)
  — survives crashes via userData; plus **Ctrl+O reopens in the last
  folder used**.
- **English lock-in**: Chromium locale pinned to en-US (was: French OS
  leaked into the viewer); re-scan: zero non-English UI strings.
- **Evaluation fixes**: cannot delete the last living page; step
  up/down skips deleted slots; failed bakes clear the landing marker;
  menu enable-state survives Recent rebuilds; cross-reload undo armed
  for structural edits (`struct-changed` was never posted); duplicate
  `undo-struct` registration removed (it double-swapped = no-op undo).

### Refinements 11 — navigation, pace, one-shot quit (same v1.2.2)
- **Sidebar clicks always navigate**: explicit `currentPageNumber` set in
  the capture handler (thumbnail hash-anchors are fragile when the hash
  already matches — the backup makes every click land).
- **Hold-to-move no longer piles up**: repeat ticks skip while a bake is
  in flight and resume after landing — fast AND index-correct.
- **One-shot quit**: several dirty files get a single dialog (Save all /
  Discard all / Review one by one / Cancel) instead of an interrogation
  per file; Discard paths wipe structural ops so reopen is pristine.
- Note on the log: zero red errors is the healthy state — the sandbox
  lines are informational and the `getImageData`/`TT` lines are PDF.js
  internals for this file, not app faults.

### Refinements 10 — console-driven fixes (same v1.2.2)
- **Top-bar crash fixed** (`null.order` on first thumbnail click — the
  exact `TypeError` from the user's DevTools log): the bar now ensures
  identity state before building. This unblocked move/up/down/goto/image.
- **Save-revert fixed**: stale viewer contexts could overwrite the freshly
  baked sidecar with pre-bake indices. The parent now drops persistence
  writes from non-live displays, and the viewer locks ALL mutations while
  a bake is in flight ("please wait").
- **Duplicate tabs impossible**: open-by-logical dedup (a baked temp never
  forks a divergent second view of the same document).

### Refinements 9 — reorder you can trust (same v1.2.2)
- **Why reorder is baked, not visual**: this PDF.js version keys
  rendering, current-page tracking and thumbnail navigation by page
  index (`_getVisiblePages` renders the current page only) — moving page
  DIVs in the DOM fights all of it (blank pages, stuck navigation).
  Reorder now bakes a native temp + reloads; rotation/deletion stay
  visual-instant. Undo of a bake restores the previous temp + snapshot.
- **Top-toolbar buttons are TEXT** ("Organize pages" / "Add image") —
  emoji-only icons were invisible slots on systems without color-emoji
  fonts (viewer CSS hides the span).
- **DevTools restored**: View → Toggle Developer Tools (Ctrl+Shift+I and
  F12) — the custom menu had removed the default binding, which is also
  why nothing opened it before.

### Refinements 8 — paint + visible buttons (same v1.2.2)
- **Top-toolbar buttons are TEXT now**: the emoji-only icons were invisible
  empty slots on systems without color-emoji fonts (viewer CSS hides the
  span) — "Image" and "Organize pages" always render.
- **Blank moved pages fixed properly**: reorder calls the viewer's own
  `update()` (live DOM) and force-paints never-rendered MOVED pages only
  (never the whole document). Synthetic scroll/resize pokes removed.
- **Goto-position lands on the page** (identity-based scroll into view).
- Defensive `pagerendered` wrapper: the overlay can never break the
  viewer's render loop again.

### Refinements 7 — quit that always works + English-only UI (same v1.2.2)
- **Quit fix**: removed the renderer `beforeunload` (it stacked Chrome's
  own dialog over ours and trapped quit). Single dialog owner (main),
  double-X collapse guard, per-step guards + 90s timeout — the window can
  never be trapped; explicit Cancel still stays open as it should.
- **Duplicate undo-struct handler removed** (it swapped the slots twice and
  cancelled the undo).
- **English-only 1.2.2**: ~90 UI strings (toasts, toolbar, organizer, page
  bar, thumb menu, modal, dialogs) translated; layouts set to LTR. Arabic
  returns as a full locale in 1.2.3 (see ROADMAP.md).
- **ROADMAP.md** records the 1.2.3 plan (i18n, Arabic, themes, Word→PDF).

### Refinements 6 — move that works (same v1.2.2, no bump)
- **Blank page after long moves fixed**: PDF.js paints pages lazily on
  scroll — a page dragged from far away was never painted. Reorder now
  pokes the render queue (scroll + resize) and repaints the overlay.
- **Fast move**: press-and-hold ⬆⬇ repeats, plus "jump to position N"
  input in the top bar (15→1 in one step instead of 15 clicks).
- **Visible multi-select**: every sidebar thumbnail has a ✓ picker (no
  hidden Ctrl needed); the bar acts on the whole set (batch delete/rotate
  with count + confirm).
- **Image flow is observable**: every step toasts (picking / cancelled /
  exact error), so "nothing happens" is diagnosable.

### Refinements 5 — delete/move/discard actually work (same v1.2.2, no bump)
- **Root cause found**: native `confirm()` is BLOCKED in the sandboxed
  viewer iframe (no `allow-modals`) and always acted as Cancel — every
  delete died there. Replaced by a custom in-viewer modal (`lectorConfirm`),
  used for page delete (single+batch) and annotation clear-page.
- **Selection hardened**: thumbnail clicks now listen in the capture phase,
  so the top-center bar (delete / rotate / up / down / image) always opens.
- **True Discard**: dropping a tab also wipes structural ops from the
  sidecar — reopening shows the pristine pages (draft annots stay).
- **Arabic close dialogs**: [حفظ] [حفظ باسم...] [تجاهل] [إلغاء] with an
  explicit detail line (the English labels caused Cancel-confusion).

### Refinements 4 — visual-first rewrite (same v1.2.2, no bump)
- Killed the materialize+reload pipeline (root of stuck rotations, heavy
  reloads and temp races): rotation via native `pageView.update`, reorder
  via DOM order, delete via hide — all instant, bytes baked ONCE at Save.
- **Unified undo**: 30-step in-viewer snapshots (annots + pages) via pill,
  toolbar ↩ and panel; cross-reload single-step via Edit menu (slots swap
  = redo). Deleted pages truly come back.
- **Edit → Undo last change** menu item (no accelerator, never hijacks typing).
- Honest limitation (documented): Print/Download use the original bytes —
  save first to print the edited structure.

### Refinements 3 — usability fixes (same v1.2.2, no bump)
- **About**: fair wording — "Original by Sagar Gurtu (v1.1.0, MIT)" +
  "Developed by KinanDev since v1.2.0" (original name kept: MIT requires it).
- **Top-center page bar**: clicking any sidebar thumbnail selects it and
  shows: delete / rotate / move up / move down / add image. Ctrl+click
  multi-selects for batch delete/rotate. Esc or ✖ hides it.
- **Delete confirms** everywhere (single + batch with count); Cancel stages
  nothing, so no stuck red frame.
- **Organizer panel**: ✓ check-select per page + header batch delete/rotate.

### Refinements 2 — discoverability (same v1.2.2, no bump)
- Two visible buttons in the viewer top toolbar: 🗂 organize pages,
  🖼 add image (no more hunting for the floating ✎).
- Left sidebar thumbnails: hover any page for quick ✖/⟳, right-click it
  for the full menu (delete, rotate, add image here, move to first/last,
  full organizer). Single click still navigates.
- Staged page ops are shared state: sidebar, organizer panel and a new
  floating "تغييرات الصفحات: N — تطبيق ✓ / تراجع" pill all work on it.
- One-time hint toast points to the sidebar options.

### Weight & security
- Still zero frameworks; only `pdf-lib`. New IPC channels are whitelisted
  in preload; image dataURLs are type/size-validated. No temp files, no
  network, no ports.

## v1.2.1 — Annotations (by KinanDev)

> Same rights as below: original project **Sagar Gurtu** (MIT),
> PDF.js **Mozilla** (Apache 2.0). New files in this release:
> `src/lib/pdfjs/web/lector-annot.js`, `lector-annot.css` (MIT, KinanDev),
> `src/js/annot-burn.js` (MIT, KinanDev). Vendored Mozilla viewer files are
> untouched except 4 marked include-lines in `viewer.html`.

### Refinements (same v1.2.1, no version bump)
- Toolbar + floating ✎ button moved to the **right** side (left sidebar
  stays visible); both are **draggable** and the position is remembered.
- **About window**: removed the duplicate custom × button — single native
  close button.
- **Everything stays editable**: new ✥ move tool (click to select, drag to
  move any annot), ✖ / Delete key deletes the selection, color / width /
  font-size controls retarget the selection, texts re-edit on double-click.
- **Black is the default color**; the last chosen color is remembered.

### Tools (all free, open-source, dependency-free in the viewer)
- **Highlight** (شفاف، لون قابل للاختيار), **Rectangle** (حدود + تعبئة
  اختيارية + سماكة), **Cover/Redact** (صندوق معتم لإخفاء جزء من الصفحة —
  تغطية بصرية فقط، النص الأصلي يبقى في الملف، ليست تنقيحاً تشفيرياً),
  **Freehand pen** (سماكة ولون), **Text** (كتابة فوق الملف، عربي كامل
  الاتجاه + أحجام + ألوان), **Eraser** (مسح تعليق واحد بالنقر),
  **Undo** عام, **Clear page**, إظهار/إخفاء الشريط (زر ✎ عائم).
- الإحداثيات بنقاط PDF (لا تتأثر بالزوم)، والطبقة شفافة فوق كل صفحة ولا
  تعطل تحديد النص عندما تكون أداة التحديد نشطة.

### Persistence & export
- حفظ تلقائي لكل ملف في `userData/lector-annots/<sha1>.json` (لا يلمس
  ملفك الأصلي أبداً).
- `File → Save Annotated PDF...` (`Ctrl+S`): يحرق التعليقات في نسخة جديدة
  `*-annotated.pdf` عبر `pdf-lib` (MIT) في العملية الرئيسية — الأشكال
  كمتجهات حادة، والنصوص كطوابع PNG من canvas المتصفح (تشكيل عربي مثالي
  بدون شحن أي ملف خط).
- Bridge: `viewer (lector-annot.js)` ↔ `parent (index.js _setAnnotBridge)`
  ↔ `main (annot-load/save, save-annotated)` عبر قنوات مقيدة في `preload`.

### Weight
- New runtime dep: `pdf-lib ^1.17.1` only (~150KB). Viewer layer is ~25KB
  of hand-written JS/CSS, zero frameworks. No AI, no cloud, no accounts.

## v1.2.0 — Security & Modernization update (by KinanDev)

> Original project by **Sagar Gurtu** (MIT License, Copyright (c) 2019).
> PDF.js viewer by **Mozilla Foundation** (Apache License 2.0).
> All original copyrights, licenses and attributions are preserved.
> v1.2.0 additions and fixes are documented below and marked `KinanDev`
> in the source headers.

### Dependencies (modernized after ~7 years without updates)
- `electron`: `^5.0.4` → `^44.3.0` (Chromium with 7 years of security fixes).
- `electron-builder`: `^21.1.1` → `^26.15.3` (works on current Node).
- **Removed** `custom-electron-titlebar ^3.0.9` (unmaintained, `remote`-based,
  incompatible with modern Electron, extra weight). The app now uses the
  native OS frame — lighter and safer.

### Security fixes (goal: malicious code cannot run, no ports, no exfiltration)
- Renderer: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`
  (`src/js/main.js`). No Node.js in any window.
- Removed `electron.remote` everywhere (`src/js/index.js`, `src/about.html`).
  New minimal `src/js/preload.js` exposes only 1 send + 6 receive channels
  through `contextBridge` (`window.lectorAPI`).
- `Content-Security-Policy` in `src/index.html` + `src/about.html`:
  `default-src 'self'` — no remote scripts, no CDN, no inline Node.
- Viewer `<iframe sandbox="allow-same-origin allow-scripts">` — the vendored
  PDF.js runs but cannot open popups, navigate the app, or reach Node.
- Main process: `setWindowOpenHandler` denies popups (http(s) opens in the
  external browser), `will-navigate` blocks anything but `file://`,
  `setPermissionRequestHandler` denies media/powerful permissions.
- Removed Google Fonts `@import` from both CSS files (external request,
  privacy + offline + CSP). System fonts are used.
- The app opens **no network ports** and loads **no remote code**: PDFs are
  loaded from local paths only via `viewer.html?file=<encoded local path>`.

### Bug fixes
1. `dialog.showOpenDialog` callback API → Promise API (`src/js/menutemplate.js`).
   Required for Electron ≥ 6; old code would crash on modern Electron.
2. `filename.toString()` on the file array → `filePaths[0]`
   (`src/js/menutemplate.js`). Old code broke on paths containing commas.
3. `element.classList = []` (read-only, silently failed) → proper
   `classList.remove/add` (`src/js/index.js` `_setSeekState`).
4. `labelElement.innerHTML = filename` (XSS via crafted file name) →
   `textContent` (`src/js/index.js`).
5. `lastIndexOf('\\')` (Windows only) → `split(/[\\/]/)` on all OSes
   (`src/js/index.js` `_baseName`, title + tabs).
6. `endsWith(".pdf")` case-sensitive → case-insensitive + quote trimming;
   non-PDF files are ignored instead of opening broken tabs.
7. Relative paths (`./src/...`) → `path.join(__dirname, ...)` (`src/js/main.js`).
   Old paths broke in packaged builds.
8. `ipcMain.on('toggle-menu-items')` now guards all 4 menu ids; About-window
   handler uses `about-close` IPC instead of `remote`.
9. Iframe `contentDocument` access wrapped in try/catch (`_viewerDoc`);
   print/properties/fullscreen no longer throw on empty viewer.
10. Single-instance + file-association args: initial `process.argv` is pushed
    after `did-finish-load` (replaces deleted `remote.process.argv`).

### Preserved lightness
- Zero runtime dependencies (only Electron devDeps for build/run).
- No annotation / UI frameworks added in this release.
- Vendored PDF.js `2.0.943` kept sandboxed for now; upgrade to PDF.js 4.x
  (which has a built-in annotation editor) is planned for v1.3.0 together
  with the annotation feature and `pdf-lib` for saving.

### Credits
- Original author: Sagar Gurtu — https://github.com/sagargurtu/lector
- v1.2.0 security & modernization: KinanDev
- PDF rendering: Mozilla PDF.js (Apache 2.0)

## v1.1.0 and earlier — see original README (Sagar Gurtu).
