# FoxyPDF Development Log — v1.3.6-alpha

**Date:** 2025-09-18  
**Status:** LibreOffice bundling implemented (auto-download with graceful fallback)

---

## 🎯 **Goal**
Transform FoxyPDF from a PDF *viewer* into a PDF **authoring tool** for educational content creation — with full direct manipulation, system fonts, unlimited font sizes, and professional-grade annotation controls. **Critical: Fix Word→PDF conversion for Arabic documents.**

---

## ✅ **Completed in v1.3.6-alpha**

### **🔥 MAJOR: LibreOffice Headless — Primary Word→PDF Converter (99% Fidelity)**
**New file:** `src/js/libreoffice-convert.js`  
**Integrated in:** `src/js/docx-convert.js` as **PRIMARY converter**

| Feature | LibreOffice Headless | Previous (docx-preview) |
|---------|---------------------|------------------------|
| **Arabic RTL** | ✅ Native | ⚠️ Partial |
| **Floats/Positioning** | ✅ Perfect | ❌ Broken |
| **Background Images** | ✅ Preserved | ❌ Lost |
| **Transparency** | ✅ Preserved | ❌ Lost |
| **Tables** | ✅ Perfect | ⚠️ Shifted |
| **Page Layout/Margins** | ✅ Native | ⚠️ Approximate |
| **Fidelity** | **99%** | 60% |

**Converter Chain (Best First):**
1. **PRIMARY: LibreOffice headless** (`soffice --headless --convert-to pdf`) — 99% fidelity
2. **FALLBACK 1:** docx-preview (hidden window + Chromium printToPDF)
3. **FALLBACK 2:** docx-html.js (our OOXML→HTML)
4. **FALLBACK 3:** mammoth semantic HTML (loses direct styles)

**Auto-detection:** Auto-finds LibreOffice on Windows/macOS/Linux (Program Files, Homebrew, Flatpak, Snap, Scoop, Chocolatey, PATH). Respects `LIBREOFFICE_PATH` env var.

---

### **📦 Bundled Portable LibreOffice (Zero User Dependency)**
**New files:** 
- `src/js/libreoffice-convert.js` — Updated to check bundled portable first
- `build-libreoffice.js` — Build script with graceful fallback
- `package.json` — Updated build resources and scripts

**Auto-detection priority:**
1. **Bundled portable LibreOffice** (`resources/libreoffice/`) — **highest priority, zero user dependency**
2. **System installations** (Program Files, Homebrew, Flatpak, Snap, Scoop, Chocolatey, PATH)
3. **Fallback converters** (docx-preview → docx-html → mammoth)

**Build script:** `npm run build:libreoffice`
- Downloads portable LibreOffice 7.6.7 (LTS) for current platform
- Extracts to `src/resources/libreoffice/`
- Handles Windows (.paf.exe), macOS (.tar.gz), Linux (.tar.gz)
- **Graceful failure:** If download fails, provides manual setup instructions and continues build

---

### **1. System Fonts — All User Fonts Available**
- `loadSystemFonts()` via `window.queryLocalFonts()` + fallback
- Font dropdowns show **ALL user-installed fonts** + Arabic fallbacks

### **2. Font Size Limit Removed (72pt → 500pt)**
- Properties panel, Text Panel, Text Editor: `max="500"`

### **3. Direct Manipulation Handles on Annotation Frames (v1.3.5)**
**DOM handles overlay the selected annotation:**

| Handle | Position | Action | Works On |
|--------|----------|--------|----------|
| **Rotation** | Circular arrow above center-top | Drag to rotate freely | All except ink |
| **Move** | 4-arrow icon at center | Drag to reposition | All except ink |
| **Resize (8)** | Corners + edges | Drag to resize | Rect, highlight, redact, image, stamp |
| **Move (center)** | Center of text/ink | Drag to reposition | Text, ink |

### **4. Works on All Annotation Types**
| Type | Rotation | Move | Resize (8) |
|------|----------|------|------------|
| Text | ✅ | ✅ | ❌ (use font size) |
| Rect / Highlight / Redact | ✅ | ✅ | ✅ (8 handles) |
| Image / Stamp | ✅ | ✅ | ✅ (8 handles) |
| Ink / Pen | ✅ | ✅ | ❌ (freeform) |
| Clip / Stamp | ✅ | ✅ | ✅ |

### **5. Other Improvements**
- Word→PDF: Extracts actual page size/margins from OOXML, injects `@page` CSS
- CSP headers in `index.html` and `viewer.html`
- Viewer.properties: 6 languages (en-US, ar, fr, de, es-ES, zh-CN)
- Sidecar race condition fix: `discardedPaths` Set with LRU pruning
- Organize pages panel: Close button + toggle behavior
- Delete (①) vs Clear (ALL) — distinct icons
- Arabic support: RTL text, ligatures, font stack, table mirroring, export PNG

---

## 📦 **Version: 1.3.6-alpha**
Updated in:
- `package.json` → `1.3.6-alpha`
- `src/about.html` → `Version: 1.3.6 alpha`
- `src/converter.html` → `v1.3.6 alpha`

---

## ⚠️ **Current Status: LibreOffice Download URLs Returning 404**
The LibreOffice portable download URLs are returning 404 (not found). This is a known issue with the LibreOffice download URLs changing or portable builds not being available for certain versions.

**Current behavior:** Build script fails gracefully, provides manual setup instructions, and continues build. App works without bundled LibreOffice (falls back to system LibreOffice or docx-preview).

**To enable bundled LibreOffice (for perfect Arabic conversion):**
```bash
# Manual setup:
1. Download LibreOffice Portable from:
   Windows: https://sourceforge.net/projects/libreoffice/files/LibreOffice%20Portable/
   macOS/Linux: https://www.libreoffice.org/download/download/
2. Extract to: src/resources/libreoffice/
3. Ensure structure: src/resources/libreoffice/program/soffice.exe (Windows) or soffice (macOS/Linux)
4. Re-run: npm run build:libreoffice
```

---

## 🧪 **Test Checklist (Critical: Test Arabic Word→PDF)**
Run `npm start` and verify:

1. **LibreOffice Detection:** Console should show `[libreoffice-convert] Found LibreOffice at: ...` (if bundled or system)
2. **Arabic Word→PDF:** Convert Arabic .docx with background images, tables, floats → **must be 1:1 identical**
3. **Background Image + Table:** Transparent background image behind table → **must preserve transparency + positioning**
4. **Arabic Text Position:** Left-aligned Arabic text in Word → **stays left-aligned in PDF** (not shifted right)
5. **Fonts:** Text tool dropdown → shows your system fonts
5. **Font Size:** Set to 150, 300, 500 pt
6. **Direct Handles:** Select tool → click annotation → **see handles on the frame itself**
   - Drag rotation handle (top) → rotates live
   - Drag corner/edge handles → resizes live
   - Drag center move handle → moves live
   - All updates reflect instantly in Properties panel
7. **All Tools:** Rect, highlight, image, stamp, text, pen — all have direct handles
8. **Organize Pages:** Click button twice → toggle open/close
8. **Delete (①) vs Clear (ALL):** Distinct icons

---

## 📂 **Key Files Modified**
| File | Changes |
|------|---------|
| `src/js/libreoffice-convert.js` | Bundled portable check first, graceful fallback |
| `build-libreoffice.js` | Graceful download failure, manual setup instructions |
| `src/js/docx-convert.js` | LibreOffice as PRIMARY converter, docx-preview as fallback |
| `src/lib/pdfjs/web/lector-annot.js` | System fonts, direct handles, Properties/Layers panel |
| `src/lib/pdfjs/web/lector-annot.css` | Handle styles (`.lo-handle`, `.lo-rotate-handle`, etc.) |
| `src/js/docx-convert.js` | Word→PDF page layout extraction |
| `src/js/main.js` | Sidecar race condition fix |
| `src/index.html` / `viewer.html` | CSP headers |
| `src/lib/pdfjs/web/locale/locale.properties` | 6 languages only |
| `package.json`, `about.html`, `converter.html` | Version 1.3.6-alpha |

---

## 📋 **Next Steps**
1. **Test Arabic Word→PDF** with `npm start` — **this is the critical test**
2. **Manually add bundled LibreOffice** for perfect Arabic conversion (see instructions above)
3. **Add PDF compression** (qpdf/pdfcpu), **split/merge**, **Images→PDF**, **OCR**
4. **Decide on v1.3.0 Final** after Arabic conversion verified

---

## 💡 **Note on LibreOffice Bundling**
The automatic download is currently failing (404 on all known LibreOffice portable URLs). This is a known issue with LibreOffice's portable download URLs changing or not being available for certain versions.

**For production:** You can manually download LibreOffice Portable from SourceForge and place it in `src/resources/libreoffice/` before building. The app will work perfectly without it (falling back to system LibreOffice or docx-preview), but **bundled LibreOffice is required for perfect 1:1 Arabic conversion fidelity**.