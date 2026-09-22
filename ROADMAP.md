# FoxyPDF Roadmap

> Original project by Sagar Gurtu (MIT); v1.2.x / v1.3.x development by
> KinanDev. Rights and attributions stay untouched (see CHANGELOG.md).

## v1.3.0 — shipped (see CHANGELOG.md)
- Rebrand Lector → **FoxyPDF** + brand-new fox icon + new `appId`.
- 13 color themes with accent colours (Dark default), themed custom menubar.
- **Drag & drop** to open PDFs, **bookmarks** (per file), **last-page
  memory** (resume where you left off), **Word (.docx) → PDF** conversion
  (offline, on-demand mammoth loader + Chromium printToPDF).

## v1.4.0 — Multi-language support (framework first)
- Introduce a locale dictionary + language switcher (Settings + menu).
- Ship English as the default/fallback locale.
- All UI strings (viewer toolbar, annotation bar, organizer, dialogs,
  toasts, menus) must go through the dictionary — no hardcoded literals.
- First locale after English: **full Arabic** with RTL layout mirroring
  (toolbar, sidebars, panels, dialogs). Arabic shaping already works in
  text annotations and survives PDF export as PNG stamps — keep that.

## v1.5.0 — Direct installers (per platform)
- Windows: `FoxyPDF_Setup.exe` (NSIS).
- macOS: `FoxyPDF.dmg`.
- Linux: `FoxyPDF.AppImage` (+ deb if practical).
- Publish via GitHub Releases with the same version number.

## Non-goals
- No AI / cloud / telemetry features (deferred by explicit decision).
- No version bump discipline change: numbers move only on request.