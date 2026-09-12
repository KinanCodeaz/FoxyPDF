# Lector Roadmap — v1.2.3 (planned, NOT started)

> Recorded on request. v1.2.2 is English-only by decision; work below
> begins only when explicitly requested. Original project by Sagar Gurtu
> (MIT); v1.2.x development by KinanDev. Rights and attributions stay
> untouched (see CHANGELOG.md).

## 1. Multi-language support (i18n framework first)
- Introduce a locale dictionary + language switcher (Settings + menu).
- Ship English as the default/fallback locale.
- All UI strings (viewer toolbar, annotation bar, organizer, dialogs,
  toasts, menus) must go through the dictionary — no hardcoded literals.

## 2. Full Arabic support (first locale after English)
- Complete Arabic translation of the dictionary.
- RTL layout mirroring (toolbar, sidebars, panels, dialogs).
- Arabic shaping already works in text annotations (browser canvas) and
  survives PDF export as PNG stamps — keep that property in 1.2.3.

## 3. Themes
- Light / dark / system theme setting, persisted locally.
- The vendored PDF.js viewer CSS must be themeable without forking it
  (override layer, same technique as `lector-annot.css`).
- Annotation colors must stay readable on every theme.

## 4. Convert files TO PDF — headline feature of 1.2.3
- Priority: **Word (.docx) → PDF**.
- Constraints carried over: lightweight (lazy-load converters only when
  used), offline-first, free/open-source libraries only.
- Candidates to evaluate: `docx` + HTML intermediate rendered headless,
  vs. LibreOffice headless bridge (heavy — likely rejected for the
  lightness rule), vs. OS print-to-PDF pipeline.
- Later formats only after Word proves the architecture (Excel, PowerPoint,
  images, text).

## Non-goals for 1.2.3
- No AI / cloud features (deferred by explicit decision).
- No version bump discipline change: numbers move only on request.
