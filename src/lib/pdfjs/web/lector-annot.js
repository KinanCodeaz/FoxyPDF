/*------------------------------------------------------------------------------
 *  Lector annotations overlay (v1.2.1 by KinanDev, MIT License).
 *  Lightweight, dependency-free, open-source annotation layer injected into
 *  the vendored Mozilla PDF.js viewer (Apache 2.0, untouched files).
 *
 *  Tools: highlight, rectangle, cover (visual hide), freehand pen, text,
 *  eraser, undo, clear-page. Size / shape / color are all adjustable.
 *  v1.2.1 refinements: tools on the right side; draggable FAB + draggable
 *  bar (position remembered); black default color with last-color memory;
 *  every annot stays editable — move tool selects/drags, Delete/✖ removes,
 *  color/width/size retarget the selection, texts re-edit on double-click.
 *  Coordinates are stored in PDF points (zoom-independent) and burned into
 *  a new PDF on export by the main process (pdf-lib).
 *----------------------------------------------------------------------------*/
(function () {
'use strict';

var NS = 'lector-annot';
var filePath = null;
var logicalPath = null; // v1.2.2: user's original file (viewer may show a temp)
try {
    filePath = new URL(window.location.href).searchParams.get('file') || null;
} catch (e) { filePath = null; }

// ---- state ---------------------------------------------------------------
var annots = {};        // pageIndex -> [annot]
var tool = 'select';
var selectedId = null;  // v1.2.1: currently selected annot (move/edit/delete)
var color = loadColor();    // v1.2.1: black on first launch, else last used
var lineWidth = 2;          // viewport px at scale 1 (stored scaled below)
var fontSize = 18;          // pt
var fontFamily = 'Tahoma, "Segoe UI", Arial, sans-serif';
var barHidden = false;
var saveTimer = null;

// ---- state ---------------------------------------------------------------
var annots = {};        // pageIndex -> [annot]
var tool = 'select';
var selectedId = null;  // v1.2.1: currently selected annot (move/edit/delete)
var color = loadColor();    // v1.2.1: black on first launch, else last used
var lineWidth = 2;          // viewport px at scale 1 (stored scaled below)
var fontSize = 18;          // pt
var fontFamily = 'Tahoma, "Segoe UI", Arial, sans-serif';
var barHidden = false;
var saveTimer = null;

// v1.3.5: System fonts enumeration (user-installed fonts)
var systemFonts = [];
var fontLoadPromise = null;
async function loadSystemFonts() {
    if (systemFonts.length) { return systemFonts; }
    // Fallback fonts (always available)
    var fallback = ['Tahoma', 'Segoe UI', 'Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'Noto Sans Arabic', 'Amiri', 'Scheherazade New', 'Traditional Arabic'];
    try {
        // Modern API: queryLocalFonts() - requires secure context (https or localhost)
        if (window.queryLocalFonts) {
            var localFonts = await window.queryLocalFonts({ postscriptNames: true, fullNames: true, families: true });
            var seen = new Set();
            localFonts.forEach(function (f) {
                var name = f.family || f.fullName || f.postscriptName;
                if (name && !seen.has(name)) {
                    seen.add(name);
                    systemFonts.push(name);
                }
            });
            // Add fallbacks that might not be in system list
            fallback.forEach(function (f) { if (!seen.has(f)) { systemFonts.push(f); } });
        } else {
            // Fallback: use CSS font-family stack + known system fonts
            systemFonts = fallback.slice();
        }
    } catch (e) {
        console.warn('[lector] Font enumeration failed:', e);
        systemFonts = fallback.slice();
    }
    return systemFonts;
}
function getFontList() {
    // Ensure fonts are loaded, return current list (may be incomplete if still loading)
    if (!fontLoadPromise) { fontLoadPromise = loadSystemFonts(); }
    return systemFonts.length ? systemFonts : ['Tahoma', 'Segoe UI', 'Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia'];
}

// v1.3.4: Properties/Layers Panel state
var propsPanelOpen = false;
var currentPropTab = 'properties'; // 'properties' | 'layers'
var rotateHandleDrag = null; // {page, id, startAngle, startX, startY, cx, cy}
var resizeHandleDrag = null; // {page, id, handle, startX, startY, orig}
var measureTool = null; // 'distance' | 'area' | 'perimeter' | 'angle'
var measurePoints = []; // for measurement tools

// ---- tiny guarded storage (color memory + toolbar position) ---------------
function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
function loadColor() {
    try {
        var c = JSON.parse(lsGet('lectorAnnotColor'));
        if (Array.isArray(c) && c.length === 3 &&
            c.every(function (v) { return typeof v === 'number' && v >= 0 && v <= 1; })) {
            return c;
        }
    } catch (e) { /* fall through to default */ }
    return [0, 0, 0]; // v1.2.1: black by default
}
function saveColor() { lsSet('lectorAnnotColor', JSON.stringify(color)); }
// v1.3.0: night reading mode (persisted). Inverts page rendering to
// white-text-on-black via CSS filter (free, no deps).
function loadNight() {
    try { return lsGet('lectorNight') === '1'; } catch (e) { return false; }
}
var nightOn = loadNight();
function saveNight() { lsSet('lectorNight', nightOn ? '1' : '0'); }
var COLORS = [
    { name: 'yellow', v: [1, 0.85, 0] },
    { name: 'green', v: [0.4, 1, 0.4] },
    { name: 'cyan', v: [0.3, 0.9, 1] },
    { name: 'pink', v: [1, 0.5, 0.8] },
    { name: 'red', v: [1, 0.25, 0.25] },
    { name: 'blue', v: [0.3, 0.5, 1] },
    { name: 'black', v: [0, 0, 0] },
    { name: 'white', v: [1, 1, 1] }
];

function uid() {
    return 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
function css(c) {
    return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
}
// v1.3.0: custom color picker support (native input[type=color], no deps).
function rgbToHex(c) {
    function h(v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}
function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) { return null; }
    var v = m[1];
    return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}
function pageList(i) {
    if (!annots[i]) { annots[i] = []; }
    return annots[i];
}

// ---- parent bridge (sidecar persistence + export) -------------------------
function post(kind, extra) {
    try {
        var msg = { ns: NS, kind: kind, file: filePath, logical: logicalPath || filePath };
        if (extra) {
            for (var k in extra) { msg[k] = extra[k]; }
        }
        window.parent.postMessage(msg, '*');
    } catch (e) { /* parent unreachable (standalone viewer) */ }
}
function scheduleSave() {
    // v1.2.2 refinement: persist immediately (no debounce) so tab/app close
    // prompts always see fresh sidecars. Now carries visual page ops too —
    // the parent/main bake everything once at Save (no reloads, ever).
    post('changed', { annots: annots, visOps: structOps || undefined });
}
function snapState() {
    try {
        return JSON.parse(JSON.stringify({ annots: annots, visOps: structOps || null }));
    } catch (e) { return null; }
}
function pushVisUndo() {
    var s = snapState();
    if (!s) { return; }
    visUndo.push(s);
    if (visUndo.length > 30) { visUndo.shift(); }
    updatePill();
}
function popVisUndo() {
    if (!tryPopVisUndo()) {
        toast('Nothing to undo');
        return false;
    }
    return true;
}
function tryPopVisUndo() {
    var s = visUndo.pop();
    if (!s) { return false; }
    annots = s.annots || {};
    selectedId = null;
    resetVisualOps();
    structOps = s.visOps && s.visOps.order ? s.visOps : null;
    applyVisualOps();
    redrawAll();
    markThumbState();
    updatePill();
    scheduleSave();
    return true;
}
// v1.2.2 refinement: three-tier undo — session stack, then baked-reorder
// history (parent), then cross-reload annot slots (parent).
function menuUndo() {
    if (tryPopVisUndo()) { return; }
    if (canUndoStruct) {
        post('structure-undo', { originalPath: logicalPath || filePath });
    } else {
        post('undo-prev-request', { originalPath: logicalPath || filePath });
    }
}
window.addEventListener('message', function (ev) {
    var m = ev.data || {};
    if (m.ns !== NS) { return; }
    if (m.kind === 'load' && (!m.file || m.file === filePath) && m.annots) {
        bakeInflight = false; // v1.2.2 refinement: baked reload landed
        resetVisualOps();
        annots = m.annots || {};
        visUndo = [];
        selectedId = null; // v1.2.1
        logicalPath = m.logical || filePath; // v1.2.2
        canUndoStruct = m.canUndo === true; // v1.2.2 refinement
        structOps = normalizeVisOps(m.visOps); // v1.2.2 refinement
        applyVisualOps();
        redrawAll();
        markThumbState();
        updatePill();
        toast('Annotations loaded');
    } else if (m.kind === 'notify' && (!m.file || m.file === filePath)) {
        if (m.text) { toast(m.text); }
    } else if (m.kind === 'menu-undo') {
        menuUndo();
    } else if (m.kind === 'night-toggle') {
        // v1.3.0: parent menu / shortcut toggles night reading mode
        setNight(!nightOn);
    } else if (m.kind === 'night-set') {
        setNight(!!m.on);
    } else if (m.kind === 'scroll-to' && (!m.file || m.file === filePath)) {
        // v1.2.2 refinement: land on the moved page after a baked reload
        // (parent computed the baked position — identities shifted).
        try {
            var pvS = viewerPages();
            var pg = parseInt(m.page, 10);
            if (pvS && isFinite(pg) && pg >= 1 && pg <= (pvS.pagesCount || 0)) {
                pvS.currentPageNumber = pg;
            }
        } catch (e) { /* ignore */ }
    } else if (m.kind === 'stamp-image' && (!m.file || m.file === filePath)) {
        // v1.2.2: custom image from the file picker (already a dataURL).
        setPendingStamp(m.png, true);
    } else if (m.kind === 'export-request' && (!m.file || m.file === filePath)) {
        post('export-data', { pages: buildExport() });
    } else if (m.kind === 'export-result' && (!m.file || m.file === filePath)) {
        bakeInflight = false; // v1.2.2 refinement: unlock on bake failure
        if (m.ok) { toast('Saved: ' + (m.path || '')); }
        else if (!m.error) { toast('Save cancelled'); }
        else { toast('Save failed: ' + m.error); }
    }
});

// ---- PDF.js helpers (2.x API, guarded) ------------------------------------
function app() { return window.PDFViewerApplication || null; }
function pageView(i) {
    try {
        var a = app();
        if (a && a.pdfViewer) { return a.pdfViewer.getPageView(i); }
    } catch (e) { /* not ready */ }
    return null;
}
function toPdf(i, mx, my) {
    var pv = pageView(i);
    if (pv && pv.viewport && pv.viewport.convertToPdfPoint) {
        try { return pv.viewport.convertToPdfPoint(mx, my); } catch (e) { /* fall through */ }
    }
    return null;
}
function toView(i, px, py) {
    var pv = pageView(i);
    if (pv && pv.viewport && pv.viewport.convertToViewportPoint) {
        try { return pv.viewport.convertToViewportPoint(px, py); } catch (e) { /* fall through */ }
    }
    return null;
}

// ---- canvas overlays -------------------------------------------------------
function canvasFor(pageDiv, i) {
    var c = pageDiv.querySelector('canvas.lector-annot');
    if (!c) {
        c = document.createElement('canvas');
        c.className = 'lector-annot';
        c.dataset.page = String(i);
        pageDiv.appendChild(c);
        bindCanvas(c, i);
    }
    return c;
}
function fitCanvas(c) {
    var dpr = window.devicePixelRatio || 1;
    var w = c.parentElement.clientWidth, h = c.parentElement.clientHeight;
    if (!w || !h) { return false; }
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    return true;
}
function drawAnnot(ctx, scale, i, a) {
    if (a.kind === 'ink') {
        var pts = (a.points || []).map(function (p) { return toView(i, p[0], p[1]); });
        if (pts.length < 2) { return; }
        ctx.strokeStyle = css(a.color);
        ctx.lineWidth = a.width * scale;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var k = 1; k < pts.length; k++) { ctx.lineTo(pts[k][0], pts[k][1]); }
        ctx.stroke();
        ctx.globalAlpha = 1;
        return;
    }
    if (a.kind === 'text') {
        var p = toView(i, a.x, a.yTop !== undefined ? a.yTop : a.y);
        if (!p) { return; }
        ctx.fillStyle = css(a.color);
        var fw = a.bold ? 'bold ' : '';
        var fi = a.italic ? 'italic ' : '';
        ctx.font = fi + fw + (a.size * scale) + 'px ' + (a.font || fontFamily);
        ctx.textBaseline = 'top';
        var rtl = /[\u0590-\u08FF]/.test(a.text || '');
        var lines = String(a.text || '').split('\n');
        var lh = a.size * scale * 1.25;
        ctx.direction = rtl ? 'rtl' : 'ltr';
        for (var l = 0; l < lines.length; l++) {
            ctx.fillText(lines[l], p[0], p[1] + l * lh);
        }
        ctx.direction = 'ltr';
        return;
    }
    // box kinds: highlight / rect / redact / image
    var p1 = toView(i, a.x, a.y);
    var p2 = toView(i, a.x + a.w, a.y + a.h);
    if (a.kind === 'image') {
        var im = imageFor(a);
        if (p1 && p2 && im && im.complete && im.naturalWidth) {
            try {
                var ix = Math.min(p1[0], p2[0]);
                var iy = Math.min(p1[1], p2[1]);
                var iw = Math.abs(p2[0] - p1[0]);
                var ih = Math.abs(p2[1] - p1[1]);
                var rot = a.rotation || 0;
                if (rot) {
                    // v1.3.0: rotate around center
                    ctx.save();
                    ctx.translate(ix + iw / 2, iy + ih / 2);
                    ctx.rotate(rot * Math.PI / 180);
                    ctx.drawImage(im, -iw / 2, -ih / 2, iw, ih);
                    ctx.restore();
                } else {
                    ctx.drawImage(im, ix, iy, iw, ih);
                }
            } catch (e) { /* bad image data */ }
        }
        return;
    }
    if (!p1 || !p2) { return; }
    var x = Math.min(p1[0], p2[0]), y = Math.min(p1[1], p2[1]);
    var w = Math.abs(p2[0] - p1[0]), h = Math.abs(p2[1] - p1[1]);
    if (a.kind === 'highlight') {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = css(a.color);
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
    } else if (a.kind === 'redact') {
        ctx.fillStyle = css(a.color);
        ctx.fillRect(x, y, w, h);
    } else { // rect
        if (a.fill) {
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = css(a.color);
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = css(a.color);
        ctx.lineWidth = Math.max(1, a.width * scale);
        ctx.strokeRect(x, y, w, h);
    }
}
function redrawPage(i) {
    var pv = pageView(i);
    if (!pv || !pv.div) { return; }
    var c = canvasFor(pv.div, i);
    if (!fitCanvas(c)) { return; }
    var dpr = window.devicePixelRatio || 1;
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.parentElement.clientWidth, c.parentElement.clientHeight);
    var scale = (pv.viewport && pv.viewport.scale) || 1;
    var list = annots[i] || [];
    for (var k = 0; k < list.length; k++) {
        try { drawAnnot(ctx, scale, i, list[k]); } catch (e) { /* skip bad */ }
    }
    if (draft && draft.page === i) { drawDraft(ctx, scale, i); }
    drawSelection(ctx, i); // v1.2.1
    updateDOMHandles(i); // v1.3.5: update DOM handles for direct manipulation
}

// ---- selection (v1.2.1: every annot stays editable) --------------------------
function findAnnot(id) {
    var keys = Object.keys(annots);
    for (var k = 0; k < keys.length; k++) {
        var list = annots[keys[k]] || [];
        for (var j = 0; j < list.length; j++) {
            if (list[j].id === id) { return { page: parseInt(keys[k], 10), annot: list[j] }; }
        }
    }
    return null;
}
function bboxView(i, a) {
    // returns [x, y, w, h] in page-div CSS px, or null
    var pv = pageView(i), s = (pv && pv.viewport.scale) || 1, k, pts, p;
    if (a.kind === 'ink') {
        pts = (a.points || []).map(function (pt) { return toView(i, pt[0], pt[1]); });
        if (!pts.length) { return null; }
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (k = 0; k < pts.length; k++) {
            if (!pts[k]) { return null; }
            x0 = Math.min(x0, pts[k][0]); y0 = Math.min(y0, pts[k][1]);
            x1 = Math.max(x1, pts[k][0]); y1 = Math.max(y1, pts[k][1]);
        }
        return [x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8];
    }
    if (a.kind === 'text') {
        p = toView(i, a.x, a.yTop !== undefined ? a.yTop : a.y);
        if (!p) { return null; }
        return [p[0] - 3, p[1] - 3, a.w * s + 6, a.h * s + 6];
    }
    var p1 = toView(i, a.x, a.y), p2 = toView(i, a.x + a.w, a.y + a.h);
    if (!p1 || !p2) { return null; }
    return [Math.min(p1[0], p2[0]) - 3, Math.min(p1[1], p2[1]) - 3,
            Math.abs(p2[0] - p1[0]) + 6, Math.abs(p2[1] - p1[1]) + 6];
}
function drawSelection(ctx, i) {
    if (!selectedId) { return; }
    var found = findAnnot(selectedId);
    if (!found || found.page !== i) { return; }
    var b = bboxView(i, found.annot);
    if (!b) { return; }
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = '#0a84ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b[0], b[1], b[2], b[3]);
    
    // v1.3.4: Draw rotation handle (above center-top) for all annotations
    var cx = b[0] + b[2] / 2, cy = b[1];
    ctx.save();
    ctx.translate(cx, cy - 24);
    ctx.rotate((found.annot.rotation || 0) * Math.PI / 180);
    ctx.fillStyle = '#0a84ff';
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(-8, 7);
    ctx.lineTo(8, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    
    // v1.3.4: Draw resize handles for box-type annotations
    if (found.annot.kind !== 'ink' && found.annot.kind !== 'text') {
        ctx.setLineDash([]);
        ctx.fillStyle = '#0a84ff';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        var handles = [
            [b[0], b[1]],                    // nw
            [b[0] + b[2]/2, b[1]],          // n
            [b[0] + b[2], b[1]],            // ne
            [b[0] + b[2], b[1] + b[3]/2],   // e
            [b[0] + b[2], b[1] + b[3]],     // se
            [b[0] + b[2]/2, b[1] + b[3]],   // s
            [b[0], b[1] + b[3]],            // sw
            [b[0], b[1] + b[3]/2]           // w
        ];
        handles.forEach(function (h) {
            ctx.fillRect(h[0] - 6, h[1] - 6, 12, 12);
            ctx.strokeRect(h[0] - 6, h[1] - 6, 12, 12);
        });
    }
    
    // v1.2.2: resize handle at the bottom-right corner for images (legacy)
    if (found.annot.kind === 'image') {
        ctx.setLineDash([]);
        ctx.fillStyle = '#0a84ff';
        ctx.fillRect(b[0] + b[2] - 5, b[1] + b[3] - 5, 10, 10);
    }
    ctx.restore();
}

// v1.3.5: DOM Handles for direct manipulation (resize/rotate/move)
function updateDOMHandles(i) {
    var pv = pageView(i);
    if (!pv || !pv.div) { return; }
    
    // Clean up old handles for this page
    var oldHandles = pv.div.querySelectorAll('.lo-handle');
    oldHandles.forEach(function (el) { el.remove(); });
    
    if (!selectedId) { return; }
    var found = findAnnot(selectedId);
    if (!found || found.page !== i) { return; }
    var a = found.annot;
    var b = bboxView(i, a);
    if (!b) { return; }
    
    var pageDiv = pv.div;
    var s = (pv.viewport && pv.viewport.scale) || 1;
    var rot = (a.rotation || 0) * Math.PI / 180;
    var cos = Math.cos(rot), sin = Math.sin(rot);
    var cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
    
    // Helper to create a handle element
    function createHandle(name, x, y, cursor, cls) {
        var el = document.createElement('div');
        el.className = 'lo-handle ' + (cls || '');
        el.dataset.handle = name;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.cursor = cursor;
        pageDiv.appendChild(el);
        return el;
    }
    
    // Rotation handle (above center-top)
    if (a.kind !== 'ink') {
        var rotX = cx - 8, rotY = b[1] - 24;
        var rotEl = createHandle('rotate', rotX, rotY, 'grab', 'lo-rotate-handle');
        rotEl.style.transform = 'rotate(' + (a.rotation || 0) + 'deg)';
        rotEl.dataset.cx = cx;
        rotEl.dataset.cy = cy;
    }
    
    // Move handle (center)
    if (a.kind !== 'ink') {
        var moveEl = createHandle('move', cx - 10, cy - 10, 'move', 'lo-move-handle');
        moveEl.style.width = '20px';
        moveEl.style.height = '20px';
        moveEl.style.borderRadius = '50%';
        moveEl.style.background = 'rgba(10,132,255,0.8)';
        moveEl.style.border = '2px solid #fff';
        moveEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
        moveEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3-3M2 12h20M12 2v20"/></svg>';
    }
    
    // Resize handles for box-type annotations (not ink, not text)
    if (a.kind !== 'ink' && a.kind !== 'text') {
        var handles = [
            { name: 'nw', x: b[0], y: b[1], cursor: 'nwse-resize' },
            { name: 'n', x: b[0] + b[2]/2, y: b[1], cursor: 'ns-resize' },
            { name: 'ne', x: b[0] + b[2], y: b[1], cursor: 'nesw-resize' },
            { name: 'e', x: b[0] + b[2], y: b[1] + b[3]/2, cursor: 'ew-resize' },
            { name: 'se', x: b[0] + b[2], y: b[1] + b[3], cursor: 'nwse-resize' },
            { name: 's', x: b[0] + b[2]/2, y: b[1] + b[3], cursor: 'ns-resize' },
            { name: 'sw', x: b[0], y: b[1] + b[3], cursor: 'nesw-resize' },
            { name: 'w', x: b[0], y: b[1] + b[3]/2, cursor: 'ew-resize' }
        ];
        handles.forEach(function (h) {
            var x = h.x, y = h.y;
            // Apply rotation to handle position
            var rx = (x - cx) * cos - (y - cy) * sin + cx;
            var ry = (x - cx) * sin + (y - cy) * cos + cy;
            var el = createHandle(h.name, rx - 7, ry - 7, h.cursor, 'lo-resize-handle ' + h.name);
            el.style.width = '14px';
            el.style.height = '14px';
            el.style.background = '#0a84ff';
            el.style.border = '2px solid #fff';
            el.style.borderRadius = '3px';
            el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';
        });
    }
    
    // Move handle for text and ink (center)
    if (a.kind === 'text' || a.kind === 'ink') {
        var moveEl = createHandle('move', cx - 10, cy - 10, 'move', 'lo-move-handle');
        moveEl.style.width = '20px';
        moveEl.style.height = '20px';
        moveEl.style.borderRadius = '50%';
        moveEl.style.background = 'rgba(10,132,255,0.8)';
        moveEl.style.border = '2px solid #fff';
        moveEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
    }
    
    // Bind drag events for handles
    pageDiv.querySelectorAll('.lo-handle').forEach(function (el) {
        el.addEventListener('pointerdown', function (ev) {
            ev.stopPropagation();
            ev.preventDefault();
            var name = el.dataset.handle;
            var found = findAnnot(selectedId);
            if (!found) { return; }
            var a = found.annot;
            var pv = pageView(i), s = (pv && pv.viewport.scale) || 1;
            var b = bboxView(i, a);
            if (!b) { return; }
            
            if (name === 'rotate') {
                var cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
                rotateHandleDrag = { page: i, id: selectedId, cx: cx, cy: cy };
            } else if (name === 'move') {
                var p = toPdf(i, ev.clientX, ev.clientY);
                moving = { page: i, id: selectedId, mode: 'move', sx: p ? p[0] : 0, sy: p ? p[1] : 0, orig: snapshotPos(a) };
            } else {
                // Resize handle
                var o = snapshotPos(a);
                var handleName = el.dataset.handle;
                resizeHandleDrag = { page: i, id: selectedId, handle: name, orig: { x: a.x, y: a.y, w: a.w, h: a.h } };
            }
            if (c.setPointerCapture) {
                try { c.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            }
        });
    });
}
function deleteSelected() {
    if (!selectedId) { return false; }
    var found = findAnnot(selectedId);
    if (!found) { selectedId = null; return false; }
    var list = annots[found.page] || [];
    var ix = list.findIndex(function (x) { return x.id === selectedId; });
    if (ix < 0) { return false; }
    if (bakeLock()) { return false; }
    pushVisUndo(); // v1.2.2 refinement
    list.splice(ix, 1);
    selectedId = null;
    redrawPage(found.page);
    scheduleSave();
    return true;
}
// v1.3.4: Properties/Layers Panel (right side) ============================================
function buildPropsPanel() {
    if (document.getElementById('lectorPropsPanel')) { return; }
    var panel = el('div', '');
    panel.id = 'lectorPropsPanel';
    panel.innerHTML = '\
        <div class="lo-header">\
            <span>Properties</span>\
            <div class="spacer"></div>\
            <button title="Close" aria-label="Close panel">✕</button>\
        </div>\
        <div class="lo-tabs">\
            <button class="lo-tab active" data-tab="properties">Properties</button>\
            <button class="lo-tab" data-tab="layers">Layers</button>\
        </div>\
        <div class="lo-content active" id="loPropsContent"></div>\
        <div class="lo-content" id="loLayersContent"></div>\
    ';
    document.body.appendChild(panel);
    
    // Header close button
    panel.querySelector('.lo-header button').addEventListener('click', function () {
        togglePropsPanel(false);
    });
    
    // Tab switching
    panel.querySelectorAll('.lo-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            currentPropTab = tab.dataset.tab;
            panel.querySelectorAll('.lo-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
            panel.querySelectorAll('.lo-content').forEach(function (c) { c.classList.toggle('active', c.id === 'loPropsContent' || (c.id === 'loLayersContent' && currentPropTab === 'layers')); });
            if (currentPropTab === 'layers') { refreshLayersList(); }
        });
    });
}
function togglePropsPanel(open) {
    var panel = document.getElementById('lectorPropsPanel');
    if (!panel) { buildPropsPanel(); panel = document.getElementById('lectorPropsPanel'); }
    propsPanelOpen = !!open;
    panel.classList.toggle('open', propsPanelOpen);
    if (propsPanelOpen) {
        if (currentPropTab === 'properties') { refreshPropsPanel(); }
        else { refreshLayersList(); }
    }
}
function refreshPropsPanel() {
    var content = document.getElementById('loPropsContent');
    if (!content) { return; }
    if (!selectedId) {
        content.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">Select an annotation to edit its properties</div>';
        return;
    }
    var found = findAnnot(selectedId);
    if (!found) { return; }
    var a = found.annot;
    var pv = pageView(found.page), s = (pv && pv.viewport.scale) || 1;
    
    var html = '<div class="lo-prop-group"><label>Type</label><input type="text" value="' + a.kind + '" readonly style="background:#2a2a2a;color:#888;"></div>';
    
    // Common properties for all annotations
    if (a.kind !== 'ink') {
        var b = bboxView(found.page, a);
        if (b) {
            var xPt = Math.round((b[0] / s + a.x) * 100) / 100; // approximate
            var yPt = Math.round((b[1] / s + a.y) * 100) / 100;
            html += '<div class="lo-prop-row">\
                <div class="lo-prop-group"><label>X (pt)</label><input type="number" id="propX" value="' + Math.round(a.x) + '" step="1"></div>\
                <div class="lo-prop-group"><label>Y (pt)</label><input type="number" id="propY" value="' + Math.round(a.y) + '" step="1"></div>\
            </div>';
        }
        if (a.kind !== 'text') {
            html += '<div class="lo-prop-row">\
                <div class="lo-prop-group"><label>Width (pt)</label><input type="number" id="propW" value="' + Math.round(a.w) + '" step="1" min="1"></div>\
                <div class="lo-prop-group"><label>Height (pt)</label><input type="number" id="propH" value="' + Math.round(a.h) + '" step="1" min="1"></div>\
            </div>';
        }
        html += '<div class="lo-prop-group"><label>Rotation (°)</label><input type="number" id="propRot" value="' + (a.rotation || 0) + '" step="1" min="0" max="360"></div>';
    }
    
    // Text-specific properties
    if (a.kind === 'text') {
        html += '<div class="lo-prop-group"><label>Font Size (pt)</label><input type="number" id="propFontSize" value="' + a.size + '" min="8" max="500" step="1"></div>';
        var fonts = getFontList();
        html += '<div class="lo-prop-group"><label>Font Family</label><select id="propFont">' + 
            fonts.map(function (f) { 
                return '<option value="' + f + '"' + (f === (a.font || fontFamily) ? ' selected' : '') + '>' + f + '</option>'; 
            }).join('') + '</select></div>';
        html += '<div class="lo-prop-row">\
            <div class="lo-prop-check"><input type="checkbox" id="propBold"' + (a.bold ? ' checked' : '') + '><span>Bold</span></div>\
            <div class="lo-prop-check"><input type="checkbox" id="propItalic"' + (a.italic ? ' checked' : '') + '><span>Italic</span></div>\
        </div>';
        html += '<div class="lo-prop-group"><label>Text Content</label><textarea id="propText" rows="3" style="min-height:60px;">' + (a.text || '').replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>') + '</textarea></div>';
    }
    
    // Color
    html += '<div class="lo-prop-group"><label>Color</label><div class="lo-color-row">\
        <div class="lo-color-swatch" id="propColorSwatch" style="background:' + css(a.color) + '"></div>\
        <input type="color" id="propColor" value="' + rgbToHex(a.color) + '">\
    </div></div>';
    
    // Fill for rect
    if (a.kind === 'rect') {
        html += '<div class="lo-prop-check"><input type="checkbox" id="propFill"' + (a.fill ? ' checked' : '') + '><span>Fill</span></div>';
    }
    
    // Line width for ink/rect
    if (a.kind === 'ink' || a.kind === 'rect') {
        html += '<div class="lo-prop-group"><label>Line Width (px)</label><input type="number" id="propWidth" value="' + (a.width || lineWidth) + '" min="1" max="20" step="1"></div>';
    }
    
    // Opacity for highlight
    if (a.kind === 'highlight') {
        html += '<div class="lo-prop-group"><label>Opacity</label><input type="range" id="propOpacity" min="0" max="1" step="0.05" value="0.4" style="width:100%;"></div>';
    }
    
    content.innerHTML = html;
    
    // Bind inputs
    bindPropInput('propX', function (v) { a.x = parseFloat(v) || 0; });
    bindPropInput('propY', function (v) { a.y = parseFloat(v) || 0; });
    bindPropInput('propW', function (v) { a.w = Math.max(1, parseFloat(v) || 1); });
    bindPropInput('propH', function (v) { a.h = Math.max(1, parseFloat(v) || 1); });
    bindPropInput('propRot', function (v) { a.rotation = Math.max(0, Math.min(360, parseInt(v) || 0)) % 360; });
    bindPropInput('propFontSize', function (v) { a.size = Math.max(8, Math.min(72, parseInt(v) || 18)); });
    bindPropInput('propFont', function (v) { a.font = v; });
    bindPropInput('propBold', function (v) { a.bold = v; }, true);
    bindPropInput('propItalic', function (v) { a.italic = v; }, true);
    bindPropInput('propText', function (v) { a.text = v; });
    bindPropInput('propColor', function (v) { var c = hexToRgb(v); if (c) a.color = c; });
    bindPropInput('propFill', function (v) { a.fill = v; }, true);
    bindPropInput('propWidth', function (v) { a.width = Math.max(1, Math.min(20, parseInt(v) || 2)); });
    bindPropInput('propOpacity', function (v) { a.opacity = parseFloat(v) || 0.4; });
    
    // Sync color swatch
    var colorInput = document.getElementById('propColor');
    var swatch = document.getElementById('propColorSwatch');
    if (colorInput && swatch) {
        colorInput.addEventListener('input', function () { swatch.style.background = this.value; });
    }
}
function bindPropInput(id, setter, isCheckbox) {
    var el = document.getElementById(id);
    if (!el) { return; }
    if (isCheckbox) {
        el.addEventListener('change', function () { setter(this.checked); updateAndSave(); });
    } else {
        el.addEventListener('change', function () { setter(this.value); updateAndSave(); });
        el.addEventListener('input', function () { setter(this.value); }); // live preview
    }
}
function updateAndSave() {
    if (!selectedId) { return; }
    var found = findAnnot(selectedId);
    if (!found) { return; }
    var a = found.annot;
    
    // Recalculate text metrics if text properties changed
    if (a.kind === 'text') {
        var m = measureText(a.text, a.size, a.font, a.bold, a.italic);
        a.w = m.wPt; a.h = m.hPt;
        a.png = renderTextPng(a) || a.png;
    }
    redrawPage(found.page);
    scheduleSave();
    refreshPropsPanel(); // refresh to show updated values
}
function refreshLayersList() {
    var content = document.getElementById('loLayersContent');
    if (!content) { return; }
    var page = currentPage(); // need to get current page
    var list = annots[page] || [];
    if (!list.length) {
        content.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">No annotations on this page</div>';
        return;
    }
    var html = '<ul id="lectorLayersList">';
    for (var k = list.length - 1; k >= 0; k--) {
        var a = list[k];
        var typeLabel = a.kind === 'ink' ? 'Pen' : a.kind.charAt(0).toUpperCase() + a.kind.slice(1);
        var name = a.kind === 'text' ? (a.text ? a.text.slice(0, 30) : 'Text') : 
                   a.kind === 'image' ? 'Image' : typeLabel;
        var sel = selectedId === a.id ? ' selected' : '';
        html += '<li class="lo-layer-item' + sel + '" data-id="' + a.id + '">\
            <span class="lo-vis" data-id="' + a.id + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>\
            <div class="lo-info"><span class="lo-type">' + typeLabel + '</span><span class="lo-name">' + name + '</span></div>\
            <div class="lo-actions">\
                <button class="lo-act" data-action="up" title="Move up">↑</button>\
                <button class="lo-act" data-action="down" title="Move down">↓</button>\
                <button class="lo-act" data-action="del" title="Delete">✕</button>\
            </div>\
        </li>';
    }
    html += '</ul>';
    content.innerHTML = html;
    
    // Bind layer item clicks
    content.querySelectorAll('.lo-layer-item').forEach(function (item) {
        item.addEventListener('click', function (e) {
            if (e.target.closest('.lo-act') || e.target.closest('.lo-vis')) { return; }
            selectedId = item.dataset.id;
            refreshLayersList();
            togglePropsPanel(true);
            currentPropTab = 'properties';
            document.querySelectorAll('.lo-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'properties'); });
            document.querySelectorAll('.lo-content').forEach(function (c) { c.classList.toggle('active', c.id === 'loPropsContent'); });
            refreshPropsPanel();
            redrawAll();
        });
    });
    // Visibility toggle
    content.querySelectorAll('.lo-vis').forEach(function (vis) {
        vis.addEventListener('click', function (e) {
            e.stopPropagation();
            var a = findAnnot(vis.dataset.id);
            if (a) { a.annot.hidden = !a.annot.hidden; vis.querySelector('svg').style.opacity = a.annot.hidden ? '0.3' : '1'; redrawPage(a.page); scheduleSave(); }
        });
    });
    // Action buttons
    content.querySelectorAll('.lo-act').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var item = btn.closest('.lo-layer-item');
            var id = item.dataset.id;
            var action = btn.dataset.action;
            var a = findAnnot(id);
            if (!a) { return; }
            if (action === 'del') { deleteAnnot(id); }
            else if (action === 'up') { moveLayer(id, -1); }
            else if (action === 'down') { moveLayer(id, 1); }
        });
    });
}
function currentPage() {
    var a = app();
    return (a && a.pdfViewer) ? a.pdfViewer.currentPageNumber - 1 : 0;
}
function deleteAnnot(id) {
    var found = findAnnot(id);
    if (!found) { return; }
    var list = annots[found.page] || [];
    var ix = list.findIndex(function (x) { return x.id === id; });
    if (ix >= 0) {
        if (bakeLock()) { return; }
        pushVisUndo();
        list.splice(ix, 1);
        if (selectedId === id) { selectedId = null; }
        redrawPage(found.page);
        scheduleSave();
        refreshLayersList();
        refreshPropsPanel();
    }
}
function moveLayer(id, dir) {
    var found = findAnnot(id);
    if (!found) { return; }
    var list = annots[found.page] || [];
    var ix = list.findIndex(function (x) { return x.id === id; });
    var newIx = ix + dir;
    if (newIx < 0 || newIx >= list.length) { return; }
    if (bakeLock()) { return; }
    pushVisUndo();
    var item = list.splice(ix, 1)[0];
    list.splice(newIx, 0, item);
    redrawPage(found.page);
    scheduleSave();
    refreshLayersList();
}
function redrawAll() {
    var a = app();
    if (!a || !a.pdfViewer) { return; }
    var n = a.pdfViewer.pagesCount || 0;
    for (var i = 0; i < n; i++) { redrawPage(i); }
}

// ---- drawing interaction ---------------------------------------------------
var draft = null;   // {page, kind, x0,y0(pdf), x1,y1(pdf), points[]}
var drawing = false;
var moving = null;  // v1.2.1 {page, id, sx, sy(pdf start), orig}

function canvasPos(c, ev) {
    var r = c.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
}
function bindCanvas(c, i) {
    c.addEventListener('pointerdown', function (ev) {
        if (tool === 'select') {
            // Select tool: check if clicking on an annotation to edit it
            var m = canvasPos(c, ev);
            var list = annots[i] || [];
            for (var k = list.length - 1; k >= 0; k--) {
                if (hitTest(i, list[k], m[0], m[1])) {
                    ev.preventDefault();
                    selectedId = list[k].id;
                    togglePropsPanel(true);
                    currentPropTab = 'properties';
                    redrawPage(i);
                    return;
                }
            }
            // Clicked on empty space — deselect
            if (selectedId) { selectedId = null; hideTextPanel(); hideStampControls(); togglePropsPanel(false); redrawPage(i); }
            return;
        }
        if (ev.button !== 0) { return; }
        ev.preventDefault();
        ev.stopPropagation();
        var m = canvasPos(c, ev);
        if (bakeLock()) { return; }
        if (tool === 'move') { moveDown(i, c, ev, m); return; }
        if (tool === 'eraser') { eraseAt(i, m[0], m[1]); return; }
        if (tool === 'text') { openTextEditor(i, m[0], m[1]); return; }
        if (tool === 'stamp' || tool === 'image') { placeStamp(i, m[0], m[1]); return; }
        if (tool === 'clip') { startClip(i, m[0], m[1]); return; }
        var p = toPdf(i, m[0], m[1]);
        if (!p) { return; }
        drawing = true;
        c.setPointerCapture && c.setPointerCapture(ev.pointerId);
        draft = { page: i, kind: tool, x0: p[0], y0: p[1], x1: p[0], y1: p[1], points: [[p[0], p[1]]] };
    });
    c.addEventListener('pointermove', function (ev) {
        var m = canvasPos(c, ev);
        // v1.3.4: Rotation handle drag
        if (rotateHandleDrag && rotateHandleDrag.page === i) {
            ev.preventDefault();
            var found = findAnnot(rotateHandleDrag.id);
            if (!found) { rotateHandleDrag = null; return; }
            var a = found.annot;
            var pv = pageView(i), s = (pv && pv.viewport.scale) || 1;
            var cx = a.x + a.w / 2, cy = a.y + a.h / 2;
            var cv = toView(i, cx, cy);
            if (cv) {
                var angle = Math.atan2(m[1] - cv[1], m[0] - cv[0]) * 180 / Math.PI;
                a.rotation = Math.round(angle) % 360;
                if (a.rotation < 0) a.rotation += 360;
                redrawPage(i);
            }
            return;
        }
        // v1.3.4: Resize handle drag
        if (resizeHandleDrag && resizeHandleDrag.page === i) {
            ev.preventDefault();
            var found = findAnnot(resizeHandleDrag.id);
            if (!found) { resizeHandleDrag = null; return; }
            var a = found.annot;
            var p = toPdf(i, m[0], m[1]);
            if (!p) { return; }
            var o = resizeHandleDrag.orig;
            var handle = resizeHandleDrag.handle;
            var dx = p[0] - o.x, dy = p[1] - o.y;
            var rot = (a.rotation || 0) * Math.PI / 180;
            var cos = Math.cos(-rot), sin = Math.sin(-rot);
            var ldx = dx * cos - dy * sin;
            var ldy = dx * sin + dy * cos;
            var minW = 5, minH = 5;
            if (handle === 'nw' || handle === 'n' || handle === 'ne') {
                a.h = Math.max(5, o.h - ldy);
                a.y = o.y + ldy;
            }
            if (handle === 'sw' || handle === 's' || handle === 'se') {
                a.h = Math.max(minH, o.h + ldy);
            }
            if (handle === 'nw' || handle === 'w' || handle === 'sw') {
                a.w = Math.max(5, o.w - ldx);
                a.x = o.x + ldx;
            }
            if (handle === 'ne' || handle === 'e' || handle === 'se') {
                a.w = Math.max(5, o.w + ldx);
            }
            // Re-center rotation center
            if (a.rotation) {
                var cx = a.x + a.w / 2, cy = a.y + a.h / 2;
                // rotation center stays the same
            }
            redrawPage(i);
            return;
        }
        if (moving && moving.page === i) {
            ev.preventDefault();
            moveTo(i, m);
            return;
        }
        // Clip tool: draw selection rectangle
        if (tool === 'clip' && clipStart && clipStart.page === i) {
            moveClip(i, m[0], m[1]);
            return;
        }
        if (!drawing || !draft || draft.page !== i) { return; }
        ev.preventDefault();
        var p = toPdf(i, m[0], m[1]);
        if (!p) { return; }
        draft.x1 = p[0]; draft.y1 = p[1];
        if (draft.kind === 'pen') { draft.points.push([p[0], p[1]]); }
        redrawPage(i);
    });
    function finish(ev) {
        if (moving && moving.page === i) {
            moving = null;
            rotateHandleDrag = null;
            resizeHandleDrag = null;
            scheduleSave();
            redrawPage(i);
            return;
        }
        // Clip tool: finish the selection and capture
        if (tool === 'clip' && clipStart && clipStart.page === i) {
            var m = canvasPos(c, ev);
            finishClip(i, m[0], m[1]);
            return;
        }
        if (!drawing || !draft || draft.page !== i) { return; }
        drawing = false;
        var d = draft; draft = null;
        var minSize = 2 / ((pageView(i) || {}).viewport?.scale || 1);
        if (d.kind === 'pen') {
            if (d.points.length < 2) { redrawPage(i); return; }
            commit(i, { id: uid(), kind: 'ink', page: i, points: d.points, color: color.slice(), width: lineWidth });
        } else {
            var w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
            if (w < minSize || h < minSize) { redrawPage(i); return; }
            var x = Math.min(d.x0, d.x1), yBottom = Math.min(d.y0, d.y1);
            // NOTE: convertToPdfPoint y grows upward from page bottom in
            // PDF user space, so min() is the bottom edge. Verified against
            // pdf-lib (also bottom-left origin) in the burn test.
            var base = { id: uid(), kind: d.kind, page: i, x: x, y: yBottom, w: w, h: h, color: color.slice() };
            if (d.kind === 'rect') { base.width = lineWidth; base.fill = fillOn; }
            commit(i, base);
        }
        redrawPage(i);
    }
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', function () { drawing = false; draft = null; moving = null; redrawPage(i); });
    c.addEventListener('dblclick', function (ev) {
        if (tool !== 'move') { return; }
        var m = canvasPos(c, ev);
        var list = annots[i] || [];
        for (var k = list.length - 1; k >= 0; k--) {
            if (list[k].kind === 'text' && hitTest(i, list[k], m[0], m[1])) {
                ev.preventDefault();
                selectedId = list[k].id;
                showTextPanel(list[k]);
                redrawPage(i);
                return;
            }
        }
    });
}

// ---- move-drag engine (v1.2.1) -----------------------------------------------
function snapshotPos(a) {
    var s = { x: a.x, y: a.y };
    if (a.yTop !== undefined) { s.yTop = a.yTop; }
    if (a.kind === 'ink') {
        s.points = (a.points || []).map(function (p) { return [p[0], p[1]]; });
    }
    return s;
}
function moveDown(i, c, ev, m) {
    // v1.3.4: Check rotation handle (above center-top)
    if (selectedId) {
        var sel = findAnnot(selectedId);
        if (sel && sel.page === i) {
            var a = sel.annot;
            var b = bboxView(i, a);
            if (b) {
                var cx = b[0] + b[2] / 2, cy = b[1];
                var rotHandle = { x: cx, y: cy - 24 };
                var hp = toView(i, rotHandle.x, rotHandle.y);
                if (hp && Math.hypot(m[0] - hp[0], m[1] - hp[1]) < 14) {
                    pushVisUndo();
                    rotateHandleDrag = { page: i, id: selectedId, startAngle: a.rotation || 0 };
                    if (c.setPointerCapture) {
                        try { c.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
                    }
                    return;
                }
                // v1.3.4: Check resize handles (8 corners/edges)
                if (a.kind !== 'ink' && a.kind !== 'text') {
                    var handles = [
                        { name: 'nw', x: b[0], y: b[1] },
                        { name: 'n', x: b[0] + b[2]/2, y: b[1] },
                        { name: 'ne', x: b[0] + b[2], y: b[1] },
                        { name: 'e', x: b[0] + b[2], y: b[1] + b[3]/2 },
                        { name: 'se', x: b[0] + b[2], y: b[1] + b[3] },
                        { name: 's', x: b[0] + b[2]/2, y: b[1] + b[3] },
                        { name: 'sw', x: b[0], y: b[1] + b[3] },
                        { name: 'w', x: b[0], y: b[1] + b[3]/2 }
                    ];
                    for (var h = 0; h < handles.length; h++) {
                        var hp = toView(i, handles[h].x, handles[h].y);
                        if (hp && Math.hypot(m[0] - hp[0], m[1] - hp[1]) < 10) {
                            pushVisUndo();
                            var o = snapshotPos(a);
                            resizeHandleDrag = { page: i, id: selectedId, handle: handles[h].name, orig: { x: o.x, y: o.y, w: o.w, h: o.h } };
                            if (c.setPointerCapture) {
                                try { c.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
                            }
                            return;
                        }
                    }
                }
                // Legacy image resize handle (bottom-right)
                if (a.kind === 'image') {
                    var hp = toView(i, a.x + a.w, a.y);
                    if (hp && Math.hypot(m[0] - hp[0], m[1] - hp[1]) < 14) {
                        pushVisUndo();
                        moving = { page: i, id: selectedId, mode: 'resize' };
                        if (c.setPointerCapture) {
                            try { c.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
                        }
                        return;
                    }
                }
            }
        }
        }
        var list = annots[i] || [];
        for (var k = list.length - 1; k >= 0; k--) {
        if (hitTest(i, list[k], m[0], m[1])) {
            pushVisUndo(); // v1.2.2 refinement
            selectedId = list[k].id;
            togglePropsPanel(true);
            var p = toPdf(i, m[0], m[1]);
            moving = { page: i, id: selectedId,
                       sx: p ? p[0] : 0, sy: p ? p[1] : 0,
                       orig: snapshotPos(list[k]) };
            if (c.setPointerCapture) {
                try { c.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
            }
            redrawPage(i);
            return;
        }
    }
    selectedId = null; // click on empty space = deselect
    redrawPage(i);
}
function moveTo(i, m) {
    var found = findAnnot(moving.id);
    if (!found) { moving = null; return; }
    var p = toPdf(i, m[0], m[1]);
    if (!p) { return; }
    var a = found.annot;
    if (moving.mode === 'resize' && a.kind === 'image') {
        // v1.2.2: drag the corner — top edge stays, size follows the cursor.
        a.w = Math.max(5, p[0] - a.x);
        a.h = Math.max(5, (a.y + a.h) - p[1]);
        redrawPage(i);
        return;
    }
    var dx = p[0] - moving.sx, dy = p[1] - moving.sy;
    var o = moving.orig;
    if (a.kind === 'ink') {
        a.points = o.points.map(function (pt) { return [pt[0] + dx, pt[1] + dy]; });
    } else {
        a.x = o.x + dx;
        a.y = o.y + dy;
        if (a.yTop !== undefined) { a.yTop = o.yTop + dy; }
    }
    redrawPage(i);
}
function drawDraft(ctx, scale, i) {
    if (!draft) { return; }
    if (draft.kind === 'pen') {
        drawAnnot(ctx, scale, i, { kind: 'ink', points: draft.points, color: color, width: lineWidth });
        return;
    }
    var p1 = toView(i, draft.x0, draft.y0), p2 = toView(i, draft.x1, draft.y1);
    if (!p1 || !p2) { return; }
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.abs(p2[0] - p1[0]), Math.abs(p2[1] - p1[1]));
    ctx.restore();
}
function commit(i, a) {
    pushVisUndo(); // v1.2.2 refinement: unified undo snapshot
    pageList(i).push(a);
    scheduleSave();
}
// v1.2.2: place the pending image/icon stamp centered on the click.
// v1.3.0: uses stampSize and stampRotation from control panel.
function placeStamp(i, mx, my) {
    if (!pendingStamp) {
        toast('Pick a stamp from the icon row first');
        return;
    }
    var p = toPdf(i, mx, my);
    if (!p) { return; }
    var pv = pageView(i), s = (pv && pv.viewport.scale) || 1;
    var wPt = stampSize; // v1.3.0: adjustable size
    var hPt = stampSize * (pendingStamp.h / Math.max(1, pendingStamp.w));
    commit(i, { id: uid(), kind: 'image', page: i,
        x: p[0] - wPt / 2, y: p[1] - hPt / 2, w: wPt, h: hPt,
        rotation: stampRotation, // v1.3.0: rotation in degrees
        png: pendingStamp.png });
    selectedId = annots[i][annots[i].length - 1].id;
    redrawPage(i);
}
function eraseAt(i, mx, my) {
    var list = annots[i] || [];
    for (var k = list.length - 1; k >= 0; k--) {
        if (hitTest(i, list[k], mx, my)) {
            pushVisUndo(); // v1.2.2 refinement
            var removed = list.splice(k, 1)[0];
            if (selectedId === removed.id) { selectedId = null; } // v1.2.1
            redrawPage(i);
            scheduleSave();
            return;
        }
    }
}
function hitTest(i, a, mx, my) {
    var tol = 8;
    if (a.kind === 'ink') {
        var pts = (a.points || []).map(function (p) { return toView(i, p[0], p[1]); });
        for (var k = 0; k < pts.length - 1; k++) {
            if (distSeg(mx, my, pts[k], pts[k + 1]) < tol) { return true; }
        }
        return false;
    }
    if (a.kind === 'text') {
        var p = toView(i, a.x, a.yTop !== undefined ? a.yTop : a.y);
        if (!p) { return false; }
        var pv = pageView(i), s = (pv && pv.viewport.scale) || 1;
        return mx >= p[0] - 4 && mx <= p[0] + a.w * s + 4 && my >= p[1] - 4 && my <= p[1] + a.h * s + 4;
    }
    var p1 = toView(i, a.x, a.y), p2 = toView(i, a.x + a.w, a.y + a.h);
    if (!p1 || !p2) { return false; }
    var x = Math.min(p1[0], p2[0]) - 3, y = Math.min(p1[1], p2[1]) - 3;
    var w = Math.abs(p2[0] - p1[0]) + 6, h = Math.abs(p2[1] - p1[1]) + 6;
    return mx >= x && mx <= x + w && my >= y && my <= y + h;
}
function distSeg(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = a[0] + t * dx - px, cy = a[1] + t * dy - py;
    return Math.sqrt(cx * cx + cy * cy);
}

// ---- text editor ------------------------------------------------------------
// v1.3.0: replaced by select tool + text panel. openTextEditor still used for
// initial placement (click with text tool).
function openTextEditor(i, mx, my, existing) {
    closeTextEditor();
    var pv = pageView(i);
    if (!pv || !pv.div) { return; }
    var p = toPdf(i, mx, my);
    if (!p && !existing) { return; }
    var useSize = existing ? existing.size : fontSize;
    var useColor = existing ? existing.color : color;
    var useFont = existing ? existing.font : fontFamily;
    var ta = document.createElement('textarea');
    ta.className = 'lector-textedit';
    ta.style.position = 'absolute';
    ta.style.zIndex = '30';
    ta.style.left = mx + 'px';
    ta.style.top = my + 'px';
    ta.style.font = useSize + 'px ' + useFont;
    ta.style.color = css(useColor);
    ta.style.background = 'rgba(255,255,255,0.92)';
    ta.style.border = '1px solid #0a84ff';
    ta.style.borderRadius = '3px';
    ta.style.padding = '4px 6px';
    ta.style.minWidth = '80px';
    ta.style.minHeight = '28px';
    ta.style.outline = 'none';
    ta.style.resize = 'both';
    ta.placeholder = 'Write here…';
    ta.dir = 'auto';
    if (existing) { ta.value = existing.text || ''; }
    pv.div.appendChild(ta);
    ta.focus();
    if (existing) { ta.select(); }
    function done(save) {
        if (save && bakeInflight) { toast('Applying reorder, please wait…'); return; }
        var val = ta.value;
        var left = parseFloat(ta.style.left), top = parseFloat(ta.style.top);
        ta.remove();
        if (save && val.trim()) {
            var q = toPdf(i, left, top);
            var eb = existing ? !!existing.bold : false;
            var ei = existing ? !!existing.italic : false;
            var meas = measureText(val, useSize, useFont, eb, ei);
            var yTopPdf = q ? q[1] : (existing ? existing.yTop : p[1]);
            var record = {
                id: existing ? existing.id : uid(), kind: 'text', page: i,
                x: q ? q[0] : (existing ? existing.x : p[0]),
                y: yTopPdf - meas.hPt, yTop: yTopPdf,
                w: meas.wPt, h: meas.hPt,
                size: useSize, font: useFont,
                bold: eb, italic: ei,
                color: useColor.slice ? useColor.slice() : useColor,
                text: val
            };
            // v1.2.2: bake the PNG now so the sidecar is export-ready and
            // saving never needs the viewer (tab/app close prompts).
            record.png = renderTextPng(record) || undefined;
            pushVisUndo(); // v1.2.2 refinement
            if (existing) {
                for (var k in record) { existing[k] = record[k]; }
                selectedId = existing.id;
            } else {
                commit(i, record);
            }
            redrawPage(i);
            scheduleSave();
        } else {
            redrawPage(i);
        }
    }
    ta.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { done(true); }
        else if (ev.key === 'Escape') { done(false); }
    });
    ta._lectorDone = done;
    // click elsewhere commits
    setTimeout(function () {
        document.addEventListener('pointerdown', outsideCommit);
    }, 0);
    function outsideCommit(ev) {
        if (ta.isConnected && !ta.contains(ev.target)) {
            document.removeEventListener('pointerdown', outsideCommit);
            done(true);
        }
    }
}
function closeTextEditor() {
    var old = document.querySelector('textarea.lector-textedit');
    if (old && old._lectorDone) { old._lectorDone(false); }
}
function measureText(text, sizePt, font, bold, italic) {
    var c = measureText._c || (measureText._c = document.createElement('canvas'));
    var ctx = c.getContext('2d');
    var fw = bold ? 'bold ' : '';
    var fi = italic ? 'italic ' : '';
    ctx.font = fi + fw + sizePt + 'px ' + (font || fontFamily);
    var lines = String(text).split('\n');
    var w = 0;
    for (var k = 0; k < lines.length; k++) { w = Math.max(w, ctx.measureText(lines[k]).width); }
    var k72 = 72 / 96;
    return { wPt: Math.max(8, w * k72 + 4), hPt: Math.max(8, lines.length * sizePt * 1.25 * k72) };
}

// ---- export payload ----------------------------------------------------------
function buildExport() {
    var out = {};
    Object.keys(annots).forEach(function (key) {
        var i = parseInt(key, 10);
        var arr = [];
        (annots[key] || []).forEach(function (a) {
            if (a.kind === 'text') {
                var png = renderTextPng(a);
                if (!png) { return; }
                arr.push({ kind: 'text', x: a.x, y: a.y, w: a.w, h: a.h, png: png });
            } else {
                arr.push(a);
            }
        });
        if (arr.length) { out[key] = arr; }
    });
    return out;
}
function renderTextPng(a) {
    try {
        var scale = 2;
        var c = document.createElement('canvas');
        var ctx = c.getContext('2d');
        var pxPerPt = 96 / 72;
        var fw = a.bold ? 'bold ' : '';
        var fi = a.italic ? 'italic ' : '';
        ctx.font = fi + fw + (a.size * pxPerPt * scale) + 'px ' + (a.font || fontFamily);
        var lines = String(a.text || '').split('\n');
        var w = 0, i;
        for (i = 0; i < lines.length; i++) { w = Math.max(w, ctx.measureText(lines[i]).width); }
        var lh = a.size * pxPerPt * 1.25 * scale;
        c.width = Math.max(2, Math.ceil(w + 8 * scale));
        c.height = Math.max(2, Math.ceil(lh * lines.length + 4 * scale));
        ctx.font = fi + fw + (a.size * pxPerPt * scale) + 'px ' + (a.font || fontFamily);
        ctx.fillStyle = css(a.color);
        ctx.textBaseline = 'top';
        var rtl = /[\u0590-\u08FF]/.test(a.text || '');
        ctx.direction = rtl ? 'rtl' : 'ltr';
        for (i = 0; i < lines.length; i++) { ctx.fillText(lines[i], 4 * scale, 2 * scale + i * lh); }
        return c.toDataURL('image/png');
    } catch (e) { return null; }
}

// ---- image stamps (v1.2.2) ------------------------------------------------------
var imgCache = {};      // annotId -> HTMLImageElement
var pendingStamp = null; // {png, w, h} aspect in px
var stampSize = 80;     // v1.3.0: stamp width in PDF points (adjustable)
var stampRotation = 0;  // v1.3.0: rotation in degrees (0-360)
var BUILTINS = [
    { name: 'check', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M10 34l14 14 30-36' stroke='#1e7e34' stroke-width='9' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" },
    { name: 'cross', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M14 14l36 36M50 14L14 50' stroke='#c00' stroke-width='9' fill='none' stroke-linecap='round'/></svg>" },
    { name: 'star', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M32 6l7.5 16.5L57 24l-13 12.5 3.5 17.5L32 45l-15.5 9L20 36.5 7 24l17.5-1.5z' fill='#f5b301'/></svg>" },
    { name: 'arrow-r', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M8 32h40M36 18l14 14-14 14' stroke='#0a84ff' stroke-width='8' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" },
    { name: 'arrow-l', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M56 32H16M28 18L14 32l14 14' stroke='#0a84ff' stroke-width='8' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" },
    { name: 'warn', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M32 6L60 56H4z' fill='#f5b301'/><rect x='29' y='22' width='6' height='16' fill='#222'/><rect x='29' y='42' width='6' height='6' fill='#222'/></svg>" }
];
// v1.3.0: stamp control panel (size + rotation) — applies to selected stamp
function buildStampControls() {
    if (document.getElementById('lectorStampControls')) { return; }
    var panel = el('div', '');
    panel.id = 'lectorStampControls';

    // Size control
    var sizeGroup = el('label', '', 'Size: ');
    var sizeSlider = document.createElement('input');
    sizeSlider.type = 'range';
    sizeSlider.min = '20';
    sizeSlider.max = '300';
    sizeSlider.value = String(stampSize);
    sizeSlider.id = 'lectorStampSize';
    var sizeVal = el('span', 'la-val', stampSize + 'pt');
    sizeSlider.addEventListener('input', function () {
        stampSize = parseInt(sizeSlider.value, 10) || 80;
        sizeVal.textContent = stampSize + 'pt';
        applyStampPropsToSelected();
    });
    sizeGroup.appendChild(sizeSlider);
    sizeGroup.appendChild(sizeVal);
    panel.appendChild(sizeGroup);

    // Rotation control
    var rotGroup = el('label', '', 'Rotate: ');
    var rotSlider = document.createElement('input');
    rotSlider.type = 'range';
    rotSlider.min = '0';
    rotSlider.max = '360';
    rotSlider.value = String(stampRotation);
    rotSlider.id = 'lectorStampRot';
    var rotVal = el('span', 'la-val', stampRotation + '\u00B0');
    rotSlider.addEventListener('input', function () {
        stampRotation = parseInt(rotSlider.value, 10) || 0;
        rotVal.textContent = stampRotation + '\u00B0';
        applyStampPropsToSelected();
    });
    rotGroup.appendChild(rotSlider);
    rotGroup.appendChild(rotVal);
    panel.appendChild(rotGroup);

    document.body.appendChild(panel);
}
function applyStampPropsToSelected() {
    if (!selectedId) { return; }
    var found = findAnnot(selectedId);
    if (!found || found.annot.kind !== 'image') { return; }
    var a = found.annot;
    var sizeSlider = document.getElementById('lectorStampSize');
    var rotSlider = document.getElementById('lectorStampRot');
    if (sizeSlider) {
        var newSize = parseInt(sizeSlider.value, 10) || 80;
        var ratio = a.h / Math.max(1, a.w);
        a.w = newSize;
        a.h = newSize * ratio;
        // Re-center
        var pv = pageView(found.page);
        if (pv && pv.viewport) {
            var center = toView(found.page, a.x + a.w / 2, a.y + a.h / 2);
            if (center) {
                var p = toPdf(found.page, center[0], center[1]);
                if (p) {
                    a.x = p[0] - a.w / 2;
                    a.y = p[1] - a.h / 2;
                }
            }
        }
    }
    if (rotSlider) {
        a.rotation = parseInt(rotSlider.value, 10) || 0;
    }
    redrawPage(found.page);
    scheduleSave();
}
function showStampControls() {
    var p = document.getElementById('lectorStampControls');
    if (p) { p.style.display = 'flex'; }
}
function hideStampControls() {
    var p = document.getElementById('lectorStampControls');
    if (p) { p.style.display = 'none'; }
}

// ---- text properties panel (v1.3.0) ----------------------------------------
var TEXT_FONTS = getFontList(); // v1.3.5: dynamic, includes system fonts
function buildTextPanel() {
    if (document.getElementById('lectorTextPanel')) { return; }
    var panel = el('div', '');
    panel.id = 'lectorTextPanel';

    // Font family - use system fonts
    var fontSel = el('select', '', '');
    fontSel.id = 'lectorTextFont';
    getFontList().forEach(function (f) {
        var o = document.createElement('option');
        o.value = f; o.textContent = f;
        fontSel.appendChild(o);
    });
    fontSel.addEventListener('change', function () {
        if (selectedId) { applyTextPropsToSelected(); }
    });
    var fontLabel = el('label', '', 'Font');
    fontLabel.appendChild(fontSel);
    panel.appendChild(fontLabel);

    // Font size
    var sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.id = 'lectorTextSize';
    sizeInput.min = '8';
    sizeInput.max = '500';
    sizeInput.value = String(fontSize);
    sizeInput.addEventListener('change', function () {
        if (selectedId) { applyTextPropsToSelected(); }
    });
    var sizeLabel = el('label', '', 'Size');
    sizeLabel.appendChild(sizeInput);
    panel.appendChild(sizeLabel);

    // Color
    var colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.id = 'lectorTextColor';
    colorInput.value = rgbToHex(color);
    colorInput.style.width = '28px';
    colorInput.style.height = '24px';
    colorInput.addEventListener('input', function () {
        if (selectedId) { applyTextPropsToSelected(); }
    });
    panel.appendChild(colorInput);

    // Bold
    var boldBtn = el('button', 'la-text-btn', 'B');
    boldBtn.id = 'lectorTextBold';
    boldBtn.title = 'Bold';
    boldBtn.style.fontWeight = 'bold';
    boldBtn.addEventListener('click', function () {
        boldBtn.classList.toggle('active');
        if (selectedId) { applyTextPropsToSelected(); }
    });
    panel.appendChild(boldBtn);

    // Italic
    var italicBtn = el('button', 'la-text-btn', 'I');
    italicBtn.id = 'lectorTextItalic';
    italicBtn.title = 'Italic';
    italicBtn.style.fontStyle = 'italic';
    italicBtn.addEventListener('click', function () {
        italicBtn.classList.toggle('active');
        if (selectedId) { applyTextPropsToSelected(); }
    });
    panel.appendChild(italicBtn);

    // Done button
    var doneBtn = el('button', 'la-text-btn', '\u2713');
    doneBtn.title = 'Apply and deselect';
    doneBtn.style.background = '#1e7e34';
    doneBtn.style.color = '#fff';
    doneBtn.addEventListener('click', function () {
        selectedId = null;
        redrawAll();
        hideTextPanel();
    });
    panel.appendChild(doneBtn);

    document.body.appendChild(panel);
}
function showTextPanel(a) {
    buildTextPanel();
    var panel = document.getElementById('lectorTextPanel');
    if (!panel) { return; }
    var fontSel = document.getElementById('lectorTextFont');
    var sizeInput = document.getElementById('lectorTextSize');
    var colorInput = document.getElementById('lectorTextColor');
    var boldBtn = document.getElementById('lectorTextBold');
    var italicBtn = document.getElementById('lectorTextItalic');
    if (fontSel) { fontSel.value = a.font || fontFamily; }
    if (sizeInput) { sizeInput.value = String(a.size || fontSize); }
    if (colorInput) { colorInput.value = rgbToHex(a.color || color); }
    if (boldBtn) { boldBtn.classList.toggle('active', !!a.bold); }
    if (italicBtn) { italicBtn.classList.toggle('active', !!a.italic); }
    panel.style.display = 'flex';
}
function hideTextPanel() {
    var p = document.getElementById('lectorTextPanel');
    if (p) { p.style.display = 'none'; }
}
function applyTextPropsToSelected() {
    if (!selectedId) { return; }
    var found = findAnnot(selectedId);
    if (!found || found.annot.kind !== 'text') { return; }
    var a = found.annot;
    var fontSel = document.getElementById('lectorTextFont');
    var sizeInput = document.getElementById('lectorTextSize');
    var colorInput = document.getElementById('lectorTextColor');
    var boldBtn = document.getElementById('lectorTextBold');
    var italicBtn = document.getElementById('lectorTextItalic');
    var fname = fontSel ? fontSel.value : fontFamily;
    var isBold = boldBtn && boldBtn.classList.contains('active');
    var isItalic = italicBtn && italicBtn.classList.contains('active');
    // Store family name + bold/italic flags separately
    a.font = fname;
    a.bold = isBold;
    a.italic = isItalic;
    if (sizeInput) { a.size = parseInt(sizeInput.value, 10) || 18; }
    if (colorInput) {
        var cc = hexToRgb(colorInput.value);
        if (cc) { a.color = cc; }
    }
    var meas = measureText(a.text, a.size, a.font, a.bold, a.italic);
    a.w = meas.wPt;
    a.h = meas.hPt;
    a.png = renderTextPng(a) || a.png;
    redrawPage(found.page);
    scheduleSave();
}

// ---- clip/copy tool (v1.3.0) -----------------------------------------------
// Allows selecting a region and creating a copy of it as an image annotation.
var clipStart = null;  // {page, x, y} in PDF coords
var clipOverlay = null;
var clipSelections = []; // [{page, x, y, w, h, png, id}] — placed copies

function startClip(i, mx, my) {
    var p = toPdf(i, mx, my);
    if (!p) { return; }
    clipStart = { page: i, x: p[0], y: p[1], mx: mx, my: my };
    // Create visual overlay
    clipOverlay = document.createElement('div');
    clipOverlay.id = 'lectorClipOverlay';
    clipOverlay.style.left = mx + 'px';
    clipOverlay.style.top = my + 'px';
    clipOverlay.style.width = '0px';
    clipOverlay.style.height = '0px';
    var pv = pageView(i);
    if (pv && pv.div) { pv.div.appendChild(clipOverlay); }
}

function moveClip(i, mx, my) {
    if (!clipStart || clipStart.page !== i || !clipOverlay) { return; }
    var x0 = clipStart.mx, y0 = clipStart.my;
    var x = Math.min(x0, mx), y = Math.min(y0, my);
    var w = Math.abs(mx - x0), h = Math.abs(my - y0);
    clipOverlay.style.left = x + 'px';
    clipOverlay.style.top = y + 'px';
    clipOverlay.style.width = w + 'px';
    clipOverlay.style.height = h + 'px';
}

function finishClip(i, mx, my) {
    if (!clipStart || clipStart.page !== i) { return; }
    var p1 = toPdf(i, clipStart.mx, clipStart.my);
    var p2 = toPdf(i, mx, my);
    if (clipOverlay) { clipOverlay.remove(); clipOverlay = null; }
    clipStart = null;
    if (!p1 || !p2) { return; }
    var x = Math.min(p1[0], p2[0]), y = Math.min(p1[1], p2[1]);
    var w = Math.abs(p2[0] - p1[0]), h = Math.abs(p2[1] - p1[1]);
    if (w < 5 || h < 5) { return; }
    // Capture the region as an image using html2canvas-like approach
    // We'll render the PDF page region to a canvas
    captureRegion(i, x, y, w, h, function (png) {
        if (!png) { toast('Failed to capture region'); return; }
        commit(i, { id: uid(), kind: 'image', page: i,
            x: x, y: y, w: w, h: h,
            rotation: 0, png: png });
        redrawPage(i);
        toast('Region copied');
    });
}

function captureRegion(pageIdx, xPdf, yPdf, wPdf, hPdf, cb) {
    var pv = pageView(pageIdx);
    if (!pv || !pv.viewport) { cb(null); return; }
    var vp = pv.viewport;
    // Convert PDF coords to viewport coords
    var p1 = vp.convertToViewportPoint(xPdf, yPdf + hPdf); // bottom-left
    var p2 = vp.convertToViewportPoint(xPdf + wPdf, yPdf); // top-right
    var vx = Math.min(p1[0], p2[0]), vy = Math.min(p1[1], p2[1]);
    var vw = Math.abs(p2[0] - p1[0]), vh = Math.abs(p2[1] - p1[1]);
    // Get the page canvas
    var canvas = pv.canvas;
    if (!canvas) { cb(null); return; }
    try {
        var c = document.createElement('canvas');
        c.width = Math.round(vw * 2);
        c.height = Math.round(vh * 2);
        var ctx = c.getContext('2d');
        ctx.scale(2, 2);
        ctx.drawImage(canvas, vx, vy, vw, vh, 0, 0, vw, vh);
        cb(c.toDataURL('image/png'));
    } catch (e) { cb(null); }
}
function rasterizeSvg(svg, cb) {
    try {
        var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        var im = new Image();
        im.onload = function () {
            try {
                var c = document.createElement('canvas');
                c.width = 128; c.height = 128;
                c.getContext('2d').drawImage(im, 0, 0, 128, 128);
                URL.revokeObjectURL(url);
                cb(c.toDataURL('image/png'));
            } catch (e) { cb(null); }
        };
        im.onerror = function () { cb(null); };
        im.src = url;
    } catch (e) { cb(null); }
}
function setPendingStamp(png, fromUpload) {
    if (!png || png.length > 7 * 1024 * 1024) { toast('Invalid image'); return; }
    downscaleDataUrl(png, 1024, function (small) {
        if (!small) { toast('Cannot read the image'); return; }
        var im = new Image();
        im.onload = function () {
            pendingStamp = { png: small, w: im.naturalWidth, h: im.naturalHeight };
            tool = 'image';
            refreshToolButtons();
            refreshCanvasEvents();
            toast(fromUpload ? 'Click on the page to place the image' : 'Stamp selected');
        };
        im.onerror = function () { toast('Cannot read the image'); };
        im.src = small;
    });
}
function downscaleDataUrl(dataUrl, maxDim, cb) {
    try {
        var im = new Image();
        im.onload = function () {
            try {
                var w = im.naturalWidth, h = im.naturalHeight;
                var k = Math.min(1, maxDim / Math.max(w, h));
                var c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(w * k));
                c.height = Math.max(1, Math.round(h * k));
                c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
                cb(c.toDataURL(w * k < w || h * k < h ? 'image/png' : 'image/png'));
            } catch (e) { cb(null); }
        };
        im.onerror = function () { cb(null); };
        im.src = dataUrl;
    } catch (e) { cb(null); }
}
function imageFor(a) {
    var im = imgCache[a.id];
    if (!im && a.png) {
        im = new Image();
        im.onload = function () { redrawPage(a.page); };
        im.src = a.png;
        imgCache[a.id] = im;
    }
    return im || null;
}

// ---- toolbar UI ---------------------------------------------------------------
var fillOn = false;
function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (html !== undefined) { e.innerHTML = html; }
    return e;
}

// v1.3.0: Beautiful colorful SVG icons for toolbar.
var ICONS = {
    night: "<svg viewBox='0 0 24 24' fill='#7c83ff' stroke='#7c83ff' stroke-width='1'><path d='M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z'/></svg>",
    sun: "<svg viewBox='0 0 24 24' fill='#ffc107' stroke='#ffc107' stroke-width='1' stroke-linecap='round'><circle cx='12' cy='12' r='5'/><path d='M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42'/></svg>",
    select: "<svg viewBox='0 0 24 24' fill='#4fc3f7' stroke='#4fc3f7' stroke-width='1'><path d='M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z'/></svg>",
    move: "<svg viewBox='0 0 24 24' fill='none' stroke='#66bb6a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20'/></svg>",
    highlight: "<svg viewBox='0 0 24 24' fill='none' stroke='#ffeb3b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z'/></svg>",
    rect: "<svg viewBox='0 0 24 24' fill='none' stroke='#42a5f5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/></svg>",
    redact: "<svg viewBox='0 0 24 24' fill='#616161'><rect x='3' y='3' width='18' height='18' rx='2'/></svg>",
    pen: "<svg viewBox='0 0 24 24' fill='none' stroke='#ef5350' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 3l4 4L7.5 20.5 2 22l1.5-5.5L17 3z'/></svg>",
    text: "<svg viewBox='0 0 24 24' fill='none' stroke='#ce93d8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='4 7 4 4 20 4 20 7'/><line x1='9' y1='20' x2='15' y2='20'/><line x1='12' y1='4' x2='12' y2='20'/></svg>",
    image: "<svg viewBox='0 0 24 24' fill='#29b6f6' stroke='#29b6f6' stroke-width='1' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2' fill='none' stroke-width='2'/><circle cx='8.5' cy='8.5' r='1.5'/><polyline points='21 15 16 10 5 21' fill='none' stroke-width='2'/></svg>",
    stamp: "<svg viewBox='0 0 24 24' fill='none' stroke='#ff8a65' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 2L2 7l10 5 10-5-10-5z'/><path d='M2 17l10 5 10-5'/><path d='M2 12l10 5 10-5'/></svg>",
    organizer: "<svg viewBox='0 0 24 24' fill='none' stroke='#ff8a65' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/></svg>",
    eraser: "<svg viewBox='0 0 24 24' fill='none' stroke='#ffab91' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M20 20H7L3 16l9-9 8 8-4 4z'/><path d='M6.5 13.5l8-8'/></svg>",
    undo: "<svg viewBox='0 0 24 24' fill='none' stroke='#81c784' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='1 4 1 10 7 10'/><path d='M3.51 15a9 9 0 102.13-9.36L1 10'/></svg>",
    // Delete = trash with X (delete ONE selected annotation)
    delete: "<svg viewBox='0 0 24 24' fill='none' stroke='#ef5350' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='3 6 5 6 21 6'/><path d='M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2'/><line x1='10' y1='11' x2='10' y2='17'/><line x1='14' y1='11' x2='14' y2='17'/></svg>",
    // Clear = trash with fire (clear ALL annotations on page)
    clear: "<svg viewBox='0 0 24 24' fill='none' stroke='#ff7043' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='3 6 5 6 21 6'/><path d='M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2'/><path d='M10 11v6'/><path d='M14 11v6'/><path d='M8 11V9a1 1 0 011-1h6a1 1 0 011 1v2'/></svg>",
    save: "<svg viewBox='0 0 24 24' fill='#66bb6a' stroke='#66bb6a' stroke-width='1' stroke-linecap='round' stroke-linejoin='round'><path d='M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z'/><polyline points='17 21 17 13 7 13 7 21' fill='none' stroke='#fff' stroke-width='2'/><polyline points='7 3 7 8 15 8' fill='none' stroke='#fff' stroke-width='2'/></svg>",
    fill: "<svg viewBox='0 0 24 24' fill='#42a5f5' stroke='#42a5f5' stroke-width='1'><path d='M12 2.69l5.66 5.66a8 8 0 11-11.31 0z'/></svg>",
    upload: "<svg viewBox='0 0 24 24' fill='none' stroke='#fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4'/><polyline points='17 8 12 3 7 8'/><line x1='12' y1='3' x2='12' y2='15'/></svg>",
    clip: "<svg viewBox='0 0 24 24' fill='none' stroke='#26c6da' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 2v4M18 2v4M6 18v4M18 18v4'/><rect x='6' y='6' width='12' height='12' rx='1'/></svg>"
};
function buildBar() {
    if (document.getElementById('lectorAnnotBar')) { return; }
    var bar = el('div', '');
    bar.id = 'lectorAnnotBar';

    // Night reading mode toggle
    var night = el('button', 'la-btn', nightOn ? ICONS.sun : ICONS.night);
    night.id = 'lectorNightBtn';
    night.title = 'Night reading mode';
    night.addEventListener('click', function () {
        setNight(!nightOn);
    });
    bar.appendChild(night);

    bar.appendChild(el('span', 'la-sep'));

    // Tools: image (upload from device) is SEPARATE from stamp (built-in icons)
    var tools = [
        ['select', ICONS.select, 'Select'],
        ['move', ICONS.move, 'Move / edit selection'],
        ['highlight', ICONS.highlight, 'Highlight'],
        ['rect', ICONS.rect, 'Rectangle'],
        ['redact', ICONS.redact, 'Cover / hide'],
        ['pen', ICONS.pen, 'Freehand pen'],
        ['text', ICONS.text, 'Write'],
        ['image', ICONS.image, 'Add image from device'],
        ['stamp', ICONS.stamp, 'Built-in stamps (shapes, icons)'],
        ['clip', ICONS.clip, 'Clip / copy region'],
        ['organizer', ICONS.organizer, 'Organize pages'],
        ['eraser', ICONS.eraser, 'Eraser']
    ];
    tools.forEach(function (t) {
        var b = el('button', 'la-btn' + (tool === t[0] ? ' active' : ''), t[1]);
        b.title = t[2];
        b.dataset.tool = t[0];
        b.addEventListener('click', function () {
            if (t[0] === 'organizer') { organizerOpen(); return; }
            // Image tool: directly open file picker
            if (t[0] === 'image') {
                toast('Opening image picker\u2026');
                post('stamp-request');
                return;
            }
            tool = t[0];
            closeTextEditor();
            refreshToolButtons();
            refreshCanvasEvents();
            // Show/hide stamp row (built-in icons only)
            var row = document.getElementById('lectorStampRow');
            if (row) { row.style.display = (tool === 'stamp') ? '' : 'none'; }
            // Show/hide stamp controls
            if (tool === 'stamp') { buildStampControls(); showStampControls(); }
            else { hideStampControls(); }
            toast('Tool: ' + t[2]);
        });
        bar.appendChild(b);
    });

    // Stamp row: built-in icons only (check, cross, star, arrows, warn)
    var row = el('div', '');
    row.id = 'lectorStampRow';
    row.style.display = 'none';
    BUILTINS.forEach(function (bi) {
        var ib = el('button', 'la-btn la-icon', bi.svg);
        ib.title = 'Stamp: ' + bi.name;
        ib.addEventListener('click', function () {
            rasterizeSvg(bi.svg, function (png) { setPendingStamp(png, false); });
        });
        row.appendChild(ib);
    });
    bar.appendChild(row);

    bar.appendChild(el('span', 'la-sep'));

    COLORS.forEach(function (cc) {
        var s = el('button', 'la-color' + (css(color) === css(cc.v) ? ' active' : ''));
        s.style.background = css(cc.v);
        s.title = cc.name;
        s.addEventListener('click', function () {
            color = cc.v.slice();
            saveColor();
            clearActiveColors();
            s.classList.add('active');
            var cp = document.getElementById('lectorCustomColor');
            if (cp) { cp.value = rgbToHex(color); }
            applyToSelected();
        });
        bar.appendChild(s);
    });

    // Custom color picker
    var custom = document.createElement('input');
    custom.type = 'color';
    custom.id = 'lectorCustomColor';
    custom.className = 'la-customcolor';
    custom.title = 'Custom color\u2026';
    custom.value = rgbToHex(color);
    custom.addEventListener('input', function () {
        var v = hexToRgb(custom.value);
        if (!v) { return; }
        color = v;
        saveColor();
        clearActiveColors();
        applyToSelected();
    });
    bar.appendChild(custom);

    bar.appendChild(el('span', 'la-sep'));

    var widths = [1, 2, 4, 8];
    var wsel = el('select', 'la-sel');
    wsel.title = 'Line width';
    widths.forEach(function (w) {
        var o = document.createElement('option');
        o.value = String(w); o.textContent = w + 'px';
        if (w === lineWidth) { o.selected = true; }
        wsel.appendChild(o);
    });
    wsel.addEventListener('change', function () { lineWidth = parseInt(wsel.value, 10) || 2; applyToSelected(); });
    bar.appendChild(wsel);

    var fsel = el('select', 'la-sel');
    fsel.title = 'Font size';
    [12, 16, 18, 24, 36].forEach(function (s) {
        var o = document.createElement('option');
        o.value = String(s); o.textContent = s + 'pt';
        if (s === fontSize) { o.selected = true; }
        fsel.appendChild(o);
    });
    fsel.addEventListener('change', function () { fontSize = parseInt(fsel.value, 10) || 18; applyToSelected(); });
    bar.appendChild(fsel);

    var fill = el('button', 'la-btn', ICONS.fill);
    fill.title = 'Fill rectangle';
    fill.addEventListener('click', function () {
        fillOn = !fillOn;
        fill.classList.toggle('active', fillOn);
    });
    bar.appendChild(fill);

    bar.appendChild(el('span', 'la-sep'));

    var undo = el('button', 'la-btn', ICONS.undo);
    undo.title = 'Undo';
    undo.addEventListener('click', function () {
        menuUndo();
    });
    bar.appendChild(undo);

    // Delete = remove ONE selected annotation (trash with lines)
    var del = el('button', 'la-btn', ICONS.delete);
    del.title = 'Delete selected annotation';
    del.addEventListener('click', function () {
        if (!deleteSelected()) { toast('Select an annotation first'); }
    });
    bar.appendChild(del);

    // Clear = remove ALL annotations on current page (trash with fire)
    var clear = el('button', 'la-btn', ICONS.clear);
    clear.title = 'Clear all annotations on this page';
    clear.addEventListener('click', function () {
        var a = app();
        var cur = a && a.pdfViewer ? a.pdfViewer.currentPageNumber - 1 : 0;
        if (!((annots[cur] || []).length)) { return; }
        if (bakeLock()) { return; }
        lectorConfirm('Erase all annotations on this page?', 'Erase all').then(function (ok) {
            if (!ok) { return; }
            pushVisUndo();
            annots[cur] = [];
            redrawPage(cur);
            scheduleSave();
        });
    });
    bar.appendChild(clear);

    bar.appendChild(el('span', 'la-sep'));

    var save2 = el('button', 'la-btn la-save', ICONS.save);
    save2.title = 'Save annotated PDF copy';
    save2.addEventListener('click', function () {
        post('export-data', { pages: buildExport() });
        toast('Preparing the PDF\u2026');
    });
    bar.appendChild(save2);

    document.body.appendChild(bar);
}
function clearActiveColors() {
    var all = document.querySelectorAll('#lectorAnnotBar .la-color');
    for (var k = 0; k < all.length; k++) { all[k].classList.remove('active'); }
}
// v1.3.0: night reading mode — white text on black page background.
function applyNight() {
    try { document.documentElement.classList.toggle('lector-night', !!nightOn); } catch (e) { /* ignore */ }
    var b = document.getElementById('lectorNightBtn');
    if (b) { b.textContent = nightOn ? '☀' : '🌙'; }
}
function setNight(on) {
    nightOn = !!on;
    saveNight();
    applyNight();
}
function refreshToolButtons() {
    // v1.2.2: single place that marks the active tool button.
    var btns = document.querySelectorAll('#lectorAnnotBar .la-btn[data-tool]');
    for (var k = 0; k < btns.length; k++) {
        btns[k].classList.toggle('active', btns[k].dataset.tool === tool);
    }
}
function refreshCanvasEvents() {
    // canvases stay interactive for tools; transparent to mouse in select mode
    var all = document.querySelectorAll('canvas.lector-annot');
    for (var k = 0; k < all.length; k++) {
        all[k].style.pointerEvents = (tool === 'select') ? 'none' : 'auto';
        all[k].style.cursor = tool === 'move' ? 'move'
            : tool === 'eraser' ? 'pointer'
            : tool === 'select' ? 'default' : 'crosshair';
    }
}
var toastTimer = null;
function toast(msg) {
    var t = document.getElementById('lectorToast');
    if (!t) {
        t = el('div', '');
        t.id = 'lectorToast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 1800);
}

// ---- visual page ops engine (v1.2.2 refinement) ----------------------------------
// Everything renders INSTANTLY in place (native pv.update for rotation,
// DOM order for reorder, display:none for delete). Bytes are baked ONCE at
// Save. No reloads, no temp files, no races — by construction.
var renderedRots = {}; // identity -> rotation currently painted
function viewerPages() {
    var a = app();
    return (a && a.pdfViewer) ? a.pdfViewer : null;
}
function assignThumbIds() {
    var view = document.getElementById('thumbnailView');
    if (!view) { return; }
    var kids = view.querySelectorAll('.thumbnail');
    for (var i = 0; i < kids.length; i++) {
        if (kids[i].dataset.lectorPage === undefined) {
            kids[i].dataset.lectorPage = String(i);
        }
    }
}
function normalizeVisOps(v) {
    // Accept parent-sent ops or null (lazy identity on first edit).
    if (v && Array.isArray(v.order)) {
        return {
            order: v.order.slice(),
            deleted: v.deleted || {},
            rotations: v.rotations || {}
        };
    }
    return null;
}
function thumbEl(id) {
    return document.querySelector('#thumbnailView .thumbnail[data-lector-page="' + id + '"]');
}
function renderRotation(id) {
    var pv = viewerPages();
    var p = null;
    try { p = pv.getPageView(id); } catch (e) { return false; }
    if (!p || !p.update) { return false; }
    var rot = (structOps && structOps.rotations) ? (structOps.rotations[id] || 0) : 0;
    if ((renderedRots[id] || 0) === rot) { return true; }
    try {
        p.update(p.scale, rot);
        renderedRots[id] = rot;
        return true;
    } catch (e) { return false; }
}
function applyVisualOps() {
    var pv = viewerPages();
    if (!pv || !structOps) { return; }
    var viewer = document.getElementById('viewer');
    var view = document.getElementById('thumbnailView');
    (structOps.order || []).forEach(function (id) {
        var p = null;
        try { p = pv.getPageView(id); } catch (e) { /* ignore */ }
        if (p && p.div) {
            p.div.style.display = (structOps.deleted && structOps.deleted[id]) ? 'none' : '';
            if (viewer) { viewer.appendChild(p.div); }
        }
        var th = thumbEl(id);
        if (th) {
            th.style.display = (structOps.deleted && structOps.deleted[id]) ? 'none' : '';
            if (view) { view.appendChild(th); }
        }
    });
    Object.keys((structOps.rotations) || {}).forEach(function (k) {
        renderRotation(parseInt(k, 10));
    });
}
function resetVisualOps() {
    // restore pristine DOM (used before same-context fresh loads).
    var pv = viewerPages();
    if (!pv) { return; }
    var n = pv.pagesCount || 0;
    var viewer = document.getElementById('viewer');
    var view = document.getElementById('thumbnailView');
    for (var i = 0; i < n; i++) {
        var p = null;
        try { p = pv.getPageView(i); } catch (e) { /* ignore */ }
        if (p && p.div) {
            p.div.style.display = '';
            if (viewer) { viewer.appendChild(p.div); }
        }
        var th = thumbEl(i);
        if (th) {
            th.style.display = '';
            if (view) { view.appendChild(th); }
        }
    }
    Object.keys(renderedRots).forEach(function (k) {
        var id = parseInt(k, 10);
        if (renderedRots[id]) {
            var q = null;
            try { q = pv.getPageView(id); } catch (e) { /* ignore */ }
            if (q && q.update) {
                try { q.update(q.scale, 0); } catch (e) { /* ignore */ }
            }
            renderedRots[id] = 0;
        }
    });
}
// Convention: every structural change runs inside doStruct() — snapshot for
// undo first, visuals second, persist (sidecar+dirty+pill+badges) last.
function persistOps() {
    scheduleSave(); // carries {annots, visOps}; session marked dirty
    updatePill();
}
function doStruct(fn) {
    pushVisUndo();
    try { fn(); } catch (e) { /* never break the viewer */ }
    persistOps();
    // v1.2.2 refinement: arm the parent's cross-reload undo slots (the
    // parent snapshots the sidecar itself — payload-free ping).
    post('struct-changed', {});
    organizerRender();
    markThumbState();
}
function setPageRotation(idx, deg) {
    // SILENT instant rotation (no confirm, no toast, no reload).
    if (bakeLock()) { return; }
    structOpsEnsure();
    var pv = viewerPages();
    var p = null;
    try { p = pv.getPageView(idx); } catch (e) { /* ignore */ }
    if (!p || !p.update) {
        toast('Rotation is not supported for this document');
        return;
    }
    if (deg) { structOps.rotations[idx] = deg; }
    else { delete structOps.rotations[idx]; }
    try {
        p.update(p.scale, deg);
        renderedRots[idx] = deg;
    } catch (e) { toast('Rotation failed'); }
}
function visualDelete(idxs) {
    // assumes delete-confirm already done by the caller.
    if (bakeLock()) { return; }
    structOpsEnsure();
    idxs.forEach(function (id) {
        structOps.deleted[id] = true;
        // NOTE: annots[id] are KEPT (hidden page keeps its annots), so
        // un-delete and undo restore everything. Save skips deleted pages.
        delete structOps.rotations[id];
        delete renderedRots[id];
        var pv = viewerPages();
        var p = null;
        try { p = pv.getPageView(id); } catch (e) { /* ignore */ }
        if (p && p.div) { p.div.style.display = 'none'; }
        var th = thumbEl(id);
        if (th) { th.style.display = 'none'; }
    });
}
function visualUndelete(idxs) {
    // restore hidden pages (undo of a staged delete restores annots too,
    // because snapshots carry both — see popVisUndo).
    if (bakeLock()) { return; }
    structOpsEnsure();
    idxs.forEach(function (id) {
        delete structOps.deleted[id];
        var pv = viewerPages();
        var p = null;
        try { p = pv.getPageView(id); } catch (e) { /* ignore */ }
        if (p && p.div) { p.div.style.display = ''; }
        var th = thumbEl(id);
        if (th) { th.style.display = ''; }
    });
}
// v1.2.2 refinement: REORDER bakes explicitly + reloads. Reason (verified
// against the vendored viewer): this PDF.js version keys rendering,
// current-page tracking and thumbnail navigation by page INDEX — moving
// page DIVs in the DOM fights all of them (blank pages, stuck navigation).
// A baked temp is always native DOM. Rotation/deletion stay visual-instant.
var bakeInflight = false;
function remappedAnnots(newOrder) {
    var del = (structOps && structOps.deleted) || {};
    var out = {};
    (newOrder || []).forEach(function (oi, ni) {
        if (del[oi]) { return; }
        var list = (annots && annots[oi]) || [];
        if (list.length) {
            out[ni] = list.map(function (an) {
                var c = {};
                for (var k in an) { c[k] = an[k]; }
                c.page = ni;
                return c;
            });
        }
    });
    return out;
}
function postReorder(newOrder, scrollToIdentity) {
    // newOrder: full array of identities in the desired visual sequence.
    if (bakeLock()) { return; }
    structOpsEnsure();
    var alive = newOrder.filter(function (id) { return !structOps.deleted[id]; });
    if (!alive.length) {
        toast('Cannot delete all pages');
        return;
    }
    if (bakeInflight) {
        toast('Applying reorder, please wait…');
        return;
    }
    bakeInflight = true;
    updatePill();
    post('reorder-bake', {
        originalPath: logicalPath || filePath,
        order: newOrder.slice(),
        deleted: Object.keys(structOps.deleted).map(function (x) { return parseInt(x, 10); }),
        rotations: structOps.rotations || {},
        annots: remappedAnnots(newOrder),
        scrollTo: (scrollToIdentity === undefined ? null : scrollToIdentity)
    });
    toast('Applying reorder…');
}
// ---- page organizer (v1.2.2) ------------------------------------------------------
// Delete / reorder (drag) / rotate pages. Ops are staged with live badges,
// then baked into a real new PDF by the main process on Apply.
// v1.2.2 refinement: ops live in persistent structOps (not only while the
// panel is open), so the left-sidebar thumbnails and the floating Apply
// pill share the same staging area.
var structOps = null; // v1.2.2 refinement: VISUAL ops, identity-keyed:
 // {order:[identity...] visual sequence, deleted:{identity:true},
 //  rotations:{identity:deg}}. Bytes never change until Save, so identity
 // (original index) is stable across tab switches — no remap bugs, no
 // reloads. Baked once at Save by the main process.
var canUndoStruct = false; // v1.2.2 refinement: set from load message
var pageSel = [];         // v1.2.2 refinement: selected page indices (sidebar)
var orgSelected = {};     // v1.2.2 refinement: selected pages in organizer panel
var visUndo = [];         // v1.2.2 refinement: UNIFIED undo snapshots
                          // {annots, visOps} before every mutation (cap 30).
function structOpsEnsure() {
    if (structOps) { return structOps; }
    var a = app();
    var n = (a && a.pdfViewer) ? (a.pdfViewer.pagesCount || 0) : 0;
    structOps = { order: [], deleted: {}, rotations: {} };
    for (var i = 0; i < n; i++) { structOps.order.push(i); }
    return structOps;
}
function organizerOpen() {
    if (document.getElementById('lectorOrganizer')) { return; }
    structOpsEnsure();
    if (!structOps.order.length) { toast('No document open'); return; }

    var panel = el('div', '');
    panel.id = 'lectorOrganizer';
    var head = el('div', 'lo-head', '<b>Organize pages</b><span class="spacer"></span>');
    var apply = el('button', 'lo-apply', 'Done ✓');
    apply.title = 'All changes apply instantly — close the panel';
    apply.addEventListener('click', organizerApply);
    var cancel = el('button', '', 'Cancel');
    cancel.addEventListener('click', organizerClose);
    head.appendChild(apply);
    head.appendChild(cancel);
    // v1.2.2 refinement: batch actions on the checked pages.
    var selInfo = el('span', 'lo-selinfo', '');
    selInfo.id = 'lectorOrgSel';
    head.appendChild(selInfo);
    var delSel = el('button', '', 'Delete selected');
    delSel.addEventListener('click', function () {
        var ids = Object.keys(orgSelected).map(function (x) { return parseInt(x, 10); });
        if (!ids.length) { toast('Select one or more pages with ✓ first'); return; }
        confirmDeletePages(ids).then(function (ok) {
            if (!ok) { return; }
            orgSelected = {};
            doStruct(function () { visualDelete(ids); });
        });
    });
    head.appendChild(delSel);
    var rotSel = el('button', '', 'Rotate selected');
    rotSel.addEventListener('click', function () {
        var ids = Object.keys(orgSelected).map(function (x) { return parseInt(x, 10); });
        if (!ids.length) { toast('Select one or more pages with ✓ first'); return; }
        doStruct(function () {
            ids.forEach(function (p) {
                setPageRotation(p, ((structOps.rotations[p] || 0) + 90) % 360);
            });
        });
    });
    head.appendChild(rotSel);
    var reset = el('button', '', '↩ Undo');
    reset.title = 'Restore last change';
    reset.addEventListener('click', function () {
        menuUndo();
        organizerRender();
    });
    head.appendChild(reset);
    panel.appendChild(head);
    var body = el('div', '');
    body.id = 'lectorThumbs';
    panel.appendChild(body);
    document.body.appendChild(panel);
    organizerRender();
}
function organizerClose() {
    // v1.2.2 refinement: closing the panel keeps staged ops (pill stays).
    var p = document.getElementById('lectorOrganizer');
    if (p) { p.remove(); }
}
function organizerRender() {
    var body = document.getElementById('lectorThumbs');
    if (!body || !structOps) { return; }
    var selInfo = document.getElementById('lectorOrgSel');
    if (selInfo) {
        var n = Object.keys(orgSelected).length;
        selInfo.textContent = n ? 'Selected: ' + n : '';
    }
    body.innerHTML = '';
    structOps.order.forEach(function (pageIdx, pos) {
        var t = el('div', 'lo-thumb' + (structOps.deleted[pageIdx] ? ' deleted' : '') +
            (orgSelected[pageIdx] ? ' selected' : ''));
        t.draggable = true;
        t.dataset.pos = String(pos);
        var sel = el('button', 'lo-check' + (orgSelected[pageIdx] ? ' on' : ''), '✓');
        sel.title = 'Select page';
        sel.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (orgSelected[pageIdx]) { delete orgSelected[pageIdx]; }
            else { orgSelected[pageIdx] = true; }
            organizerRender();
        });
        t.appendChild(sel);
        var cv = document.createElement('canvas');
        t.appendChild(cv);
        var num = el('div', 'lo-num', String(pos + 1));
        t.appendChild(num);
        var rot = structOps.rotations[pageIdx] || 0;
        if (rot) { t.appendChild(el('div', 'lo-rot', rot + '°')); }
        t.appendChild(el('div', 'lo-del', '✖'));
        var btns = el('div', 'lo-btns');
        var rb = el('button', '', '⟳');
        rb.title = 'Rotate 90°';
        rb.addEventListener('click', function (ev) {
            ev.stopPropagation();
            doStruct(function () {
                setPageRotation(pageIdx, ((structOps.rotations[pageIdx] || 0) + 90) % 360);
            });
        });
        var db = el('button', '', '🗑');
        db.title = 'Delete page';
        db.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (structOps.deleted[pageIdx]) {
                doStruct(function () { visualUndelete([pageIdx]); });
                return;
            }
            confirmDeletePages([pageIdx]).then(function (ok) {
                if (!ok) { return; }
                doStruct(function () { visualDelete([pageIdx]); });
            });
        });
        btns.appendChild(rb);
        btns.appendChild(db);
        t.appendChild(btns);

        t.addEventListener('dragstart', function (ev) {
            ev.dataTransfer.setData('text/plain', String(pos));
        });
        t.addEventListener('dragover', function (ev) {
            ev.preventDefault();
            t.classList.add('dragover');
        });
        t.addEventListener('dragleave', function () { t.classList.remove('dragover'); });
        t.addEventListener('drop', function (ev) {
            ev.preventDefault();
            t.classList.remove('dragover');
            var from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
            if (!isFinite(from) || from === pos) { return; }
            var base = structOps.order.slice();
            var item = base.splice(from, 1)[0];
            base.splice(pos, 0, item);
            postReorder(base);
        });
        body.appendChild(t);
        organizerPaintThumb(cv, pageIdx, rot);
    });
}
function organizerPaintThumb(cv, pageIdx, rotDeg) {
    try {
        var a = app();
        if (!a || !a.pdfDocument) { return; }
        a.pdfDocument.getPage(pageIdx + 1).then(function (page) {
            try {
                var v = page.getViewport(1.0);
                var k = 130 / Math.max(v.width, v.height);
                var deg = rotDeg || 0;
                cv.width = (deg === 90 || deg === 270)
                    ? Math.round(v.height * k) : Math.round(v.width * k);
                cv.height = (deg === 90 || deg === 270)
                    ? Math.round(v.width * k) : Math.round(v.height * k);
                cv.style.transform = deg ? ('rotate(' + deg + 'deg)') : '';
                cv.style.transformOrigin = 'center';
                var ctx = cv.getContext('2d');
                var renderV = page.getViewport(k);
                page.render({ canvasContext: ctx, viewport: renderV });
            } catch (e) { /* thumb failed, label still shows */ }
        });
    } catch (e) { /* ignore */ }
}
// v1.2.2 refinement: ops are already live on screen (visual-first) — the
// panel button only closes. Bytes are baked ONCE at Save.
function organizerApply() {
    organizerClose();
}

// v1.2.2 refinement: NATIVE confirm()/alert() are BLOCKED inside the
// sandboxed viewer iframe (no allow-modals) and always act as "Cancel".
// This custom modal replaces them everywhere (delete, clear-page).
function lectorConfirm(message, okLabel) {
    return new Promise(function (resolve) {
        closeThumbMenu();
        var done = false;
        function fin(v) {
            if (done) { return; }
            done = true;
            var o = document.getElementById('lectorConfirmOv');
            if (o) { o.remove(); }
            document.removeEventListener('keydown', esc, true);
            resolve(v);
        }
        function esc(ev) {
            if (ev.key === 'Escape') {
                ev.stopPropagation();
                ev.preventDefault();
                fin(false);
            }
        }
        var ov = el('div', '');
        ov.id = 'lectorConfirmOv';
        var box = el('div', 'lo-confirm');
        var msg = el('div', 'lo-msg');
        msg.textContent = message;
        box.appendChild(msg);
        var row = el('div', 'lo-row');
        var ok = el('button', 'lo-danger', okLabel || 'Confirm');
        ok.addEventListener('click', function (ev) {
            ev.stopPropagation();
            fin(true);
        });
        var no = el('button', '', 'Cancel');
        no.addEventListener('click', function (ev) {
            ev.stopPropagation();
            fin(false);
        });
        row.appendChild(ok);
        row.appendChild(no);
        box.appendChild(row);
        ov.appendChild(box);
        ov.addEventListener('pointerdown', function (ev) {
            if (ev.target === ov) { fin(false); }
        });
        document.body.appendChild(ov);
        document.addEventListener('keydown', esc, true);
        try { ok.focus(); } catch (e) { /* ignore */ }
    });
}
function confirmDeletePages(idxs) {
    // v1.2.2 refinement: refuse to delete the last living page(s) — an
    // all-deleted document cannot be baked (and cannot be read).
    structOpsEnsure();
    var doomed = (idxs || []).filter(function (id) { return !structOps.deleted[id]; });
    var alive = structOps.order.filter(function (id) { return !structOps.deleted[id]; });
    if (doomed.length > 0 && alive.length - doomed.length < 1) {
        toast('Cannot delete all pages');
        markThumbState();
        organizerRender();
        return Promise.resolve(false);
    }
    var msg = idxs.length === 1
        ? 'Delete page ' + (idxs[0] + 1) + ' from the file?\nYou can undo it right away.'
        : 'Delete ' + idxs.length + ' pages from the file?\nYou can undo it right away.';
    return lectorConfirm(msg, idxs.length === 1 ? 'Delete page 🗑' : 'Delete pages 🗑')
        .then(function (ok) {
            if (!ok) {
                // Cancel stages nothing — refresh so no red frame can stick.
                markThumbState();
                organizerRender();
            }
            return ok;
        });
}
function updatePill() {
    // v1.2.2 refinement: the pill is now UNDO only (ops apply instantly,
    // nothing stages). It appears when this session has undo steps, or when
    // the parent reports cross-reload undo availability (canUndoStruct).
    var canUndo = visUndo.length > 0 || canUndoStruct;
    var pill = document.getElementById('lectorApplyPill');
    if (!canUndo) {
        if (pill) { pill.remove(); }
        return;
    }
    if (!pill) {
        pill = el('div', '');
        pill.id = 'lectorApplyPill';
        var label = el('span', '', 'Undo last change');
        var back = el('button', 'lo-go', '↩ Undo');
        back.title = 'Restore last change (annotation/page — even deleted)';
        back.addEventListener('click', function () {
            menuUndo();
        });
        pill.appendChild(label);
        pill.appendChild(back);
        document.body.appendChild(pill);
    }
}

// ---- left-sidebar page options (v1.2.2 refinement) -------------------------------
// Hover any thumbnail for quick ✖/⟳, or right-click it for the full menu.
// Single click still navigates (viewer default, untouched).
function thumbIndex(th) {
    // v1.2.2 refinement: stable identity survives visual reordering.
    if (th && th.dataset && th.dataset.lectorPage !== undefined && th.dataset.lectorPage !== '') {
        var id = parseInt(th.dataset.lectorPage, 10);
        if (isFinite(id)) { return id; }
    }
    var view = document.getElementById('thumbnailView');
    if (!view) { return -1; }
    var kids = view.querySelectorAll('.thumbnail');
    for (var i = 0; i < kids.length; i++) {
        if (kids[i] === th) { return i; }
    }
    return -1;
}
function thumbDelete(idx) {
    if (idx < 0) { return; }
    structOpsEnsure();
    if (structOps.deleted[idx]) {
        // un-stage delete (annots were kept) — no confirm needed.
        doStruct(function () { visualUndelete([idx]); });
        toast('Page ' + (idx + 1) + ' deletion cancelled');
        return;
    }
    confirmDeletePages([idx]).then(function (ok) {
        if (!ok) { return; }
        doStruct(function () { visualDelete([idx]); });
    });
}
function thumbRotate(idx) {
    if (idx < 0) { return; }
    structOpsEnsure();
    // SILENT: badge + instant paint are the feedback (no popups, no reload).
    doStruct(function () {
        setPageRotation(idx, ((structOps.rotations[idx] || 0) + 90) % 360);
    });
}
function thumbMove(idx, edge) {
    if (idx < 0) { return; }
    structOpsEnsure();
    var at = structOps.order.indexOf(idx);
    if (at < 0) { return; }
    var arr = structOps.order.slice();
    arr.splice(at, 1);
    arr.splice(edge === 'first' ? 0 : arr.length, 0, idx);
    postReorder(arr);
}
function thumbAddImage(idx) {
    if (idx < 0) { return; }
    try {
        var a = app();
        if (a && a.pdfViewer) { a.pdfViewer.currentPageNumber = idx + 1; }
    } catch (e) { /* ignore */ }
    openAnnotBarWith('stamp');
    toast('Click page ' + (idx + 1) + ' to place the image');
}
function ensureThumbOverlay(th) {
    if (th.querySelector(':scope > .lo-hover')) { return; }
    var idx = thumbIndex(th);
    if (idx < 0) { return; }
    var ov = el('div', 'lo-hover');
    // v1.2.2 refinement: visible ✓ multi-select (no hidden Ctrl needed).
    var chk = el('button', 'lo-check' + (pageSel.indexOf(idx) >= 0 ? ' on' : ''), '✓');
    chk.title = 'Select page (multi-select)';
    chk.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        var id = thumbIndex(th);
        var at = pageSel.indexOf(id);
        if (at >= 0) { pageSel.splice(at, 1); }
        else { pageSel.push(id); }
        setPageSel(pageSel.slice());
    });
    var del = el('button', '', '✖');
    del.title = 'Delete page';
    del.addEventListener('click', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        thumbDelete(thumbIndex(th));
    });
    var rot = el('button', '', '⟳');
    rot.title = 'Rotate 90°';
    rot.addEventListener('click', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        thumbRotate(thumbIndex(th));
    });
    ov.appendChild(chk);
    ov.appendChild(del);
    ov.appendChild(rot);
    th.appendChild(ov);
}
function markThumbState() {
    // reflect staged ops on the sidebar thumbnails (badges survive scroll).
    var view = document.getElementById('thumbnailView');
    if (!view) { return; }
    var kids = view.querySelectorAll('.thumbnail');
    for (var i = 0; i < kids.length; i++) {
        var th = kids[i];
        // v1.2.2 refinement: selection ring works even with zero page ops.
        th.classList.toggle('lo-selected', pageSel.indexOf(i) >= 0);
        var chkBtn = th.querySelector(':scope > .lo-hover > .lo-check');
        if (chkBtn) {
            chkBtn.classList.toggle('on', pageSel.indexOf(i) >= 0);
        }
        if (!structOps) { continue; }
        th.classList.toggle('lo-marked-del', !!structOps.deleted[i]);
        var badge = th.querySelector(':scope > .lo-badge');
        var rot = structOps.rotations[i] || 0;
        if (rot && !badge) {
            badge = el('div', 'lo-badge', '');
            th.appendChild(badge);
        }
        if (badge) {
            if (rot) { badge.textContent = rot + '°'; badge.style.display = ''; }
            else { badge.style.display = 'none'; }
        }
    }
}
function closeThumbMenu() {
    var m = document.getElementById('lectorThumbMenu');
    if (m) { m.remove(); }
}
function showThumbMenu(x, y, idx) {
    closeThumbMenu();
    var menu = el('div', '');
    menu.id = 'lectorThumbMenu';
    var items = [
        ['🗑 Delete page', function () { thumbDelete(idx); }],
        ['⟳ Rotate 90°', function () { thumbRotate(idx); }],
        ['🖼 Add image here', function () { thumbAddImage(idx); }],
        ['⤒ Move to first', function () { thumbMove(idx, 'first'); }],
        ['⤓ Move to last', function () { thumbMove(idx, 'last'); }],
        ['🗂 Full organizer…', function () { organizerOpen(); }]
    ];
    items.forEach(function (it) {
        var b = el('button', '', it[0]);
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            closeThumbMenu();
            it[1]();
        });
        menu.appendChild(b);
    });
    menu.style.left = Math.min(window.innerWidth - 190, Math.max(4, x)) + 'px';
    menu.style.top = Math.min(window.innerHeight - 220, Math.max(40, y)) + 'px';
    document.body.appendChild(menu);
    setTimeout(function () {
        document.addEventListener('pointerdown', function h(ev) {
            if (!menu.isConnected) { return; }
            if (!menu.contains(ev.target)) {
                closeThumbMenu();
                document.removeEventListener('pointerdown', h);
            }
        });
    }, 0);
}
function hookSidebar() {
    var view = document.getElementById('thumbnailView');
    if (!view || view._lectorHooked) { return; }
    view._lectorHooked = true;
    view.addEventListener('mouseover', function (ev) {
        var th = ev.target && ev.target.closest ? ev.target.closest('.thumbnail') : null;
        if (th && view.contains(th)) { ensureThumbOverlay(th); }
    });
    view.addEventListener('contextmenu', function (ev) {
        var th = ev.target && ev.target.closest ? ev.target.closest('.thumbnail') : null;
        if (!th || !view.contains(th)) { return; }
        ev.preventDefault();
        ev.stopPropagation();
        showThumbMenu(ev.clientX, ev.clientY, thumbIndex(th));
    });
    // v1.2.2 refinement: click = select (+navigate, viewer default kept).
    // Ctrl+click adds to a multi-selection for batch delete/rotate.
    // CAPTURE phase: runs before any viewer bubble listener, so selection
    // works no matter what PDF.js does with the event. We never stop
    // propagation here, so navigation always proceeds.
    view.addEventListener('click', function (ev) {
        var th = ev.target && ev.target.closest ? ev.target.closest('.thumbnail') : null;
        if (!th || !view.contains(th)) { return; }
        // ignore clicks on our own overlay buttons (they stopPropagation anyway)
        if (ev.target.closest && ev.target.closest('.lo-hover')) { return; }
        var idx = thumbIndex(th);
        if (idx < 0) { return; }
        if (ev.ctrlKey || ev.metaKey) {
            var at = pageSel.indexOf(idx);
            if (at >= 0) { pageSel.splice(at, 1); }
            else { pageSel.push(idx); }
            setPageSel(pageSel.slice());
        } else if (pageSel.length === 1 && pageSel[0] === idx) {
            setPageSel([]); // second click = deselect
        } else {
            setPageSel([idx]);
        }
        // v1.2.2 refinement: explicit programmatic navigation as a BACKUP.
        // Thumbnail anchors navigate via URL hash, which is fragile (same
        // hash = no navigation). Setting currentPageNumber always scrolls
        // to the page div wherever it lives. Harmless if both fire.
        try {
            var pvN = viewerPages();
            if (pvN) { pvN.currentPageNumber = idx + 1; }
        } catch (e) { /* anchor nav still applies */ }
    }, true);
}

// ---- click-select + top-center action bar (v1.2.2 refinement) ------------------
// v1.2.2 refinement: while a reorder bake is in flight, the viewer shows
// PRE-bake indices — any mutation would persist stale indices over the
// baked sidecar. Block everything with feedback (brief, ~1s locally).
function bakeLock() {
    if (bakeInflight) {
        toast('Applying reorder, please wait…');
        return true;
    }
    return false;
}
// "Click any page -> top-center bar: delete / up / down / rotate / image"
function setPageSel(list) {
    pageSel = (list || []).filter(function (x) { return x >= 0; });
    markThumbState();
    renderPageBar();
}
function movePageStep(idx, dir) {
    structOpsEnsure();
    // v1.2.2 refinement: step over ALIVE positions only (deleted slots are
    // parking spots at the end, not stops).
    var alive = structOps.order.filter(function (id) { return !structOps.deleted[id]; });
    var ai = alive.indexOf(idx);
    var ni = ai + dir;
    if (ai < 0 || ni < 0 || ni >= alive.length) { return false; }
    var arr = structOps.order.slice();
    var fromPos = arr.indexOf(alive[ai]);
    var item = arr.splice(fromPos, 1)[0];
    var toPos = arr.indexOf(alive[ni]);
    arr.splice(toPos + (dir > 0 ? 1 : 0), 0, item);
    postReorder(arr);
    return true;
}
function renderPageBar() {
    var bar = document.getElementById('lectorPageBar');
    if (!pageSel.length) {
        if (bar) { bar.remove(); }
        return;
    }
    // v1.2.2 refinement: NEVER assume structOps exists (first click on a
    // fresh document crashed here: null.order). Ensure identity first.
    structOpsEnsure();
    if (!bar) {
        bar = el('div', '');
        bar.id = 'lectorPageBar';
        document.body.appendChild(bar);
    }
    bar.innerHTML = '';
    var multi = pageSel.length > 1;
    bar.appendChild(el('b', '', multi ? pageSel.length + ' pages' : 'Page ' + (pageSel[0] + 1)));
    function btn(txt, title, fn) {
        var b = el('button', '', txt);
        b.title = title;
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            fn();
        });
        bar.appendChild(b);
        return b;
    }
    btn('🗑 Delete', multi ? 'Delete selected pages' : 'Delete page', function () {
        var ids = pageSel.slice();
        confirmDeletePages(ids).then(function (ok) {
            if (!ok) { return; }
            doStruct(function () { visualDelete(ids); });
        });
    });
    btn('⟳ Rotate', 'Rotate 90°', function () {
        // SILENT instant rotation for one or many pages.
        doStruct(function () {
            pageSel.forEach(function (p) {
                setPageRotation(p, ((structOps.rotations[p] || 0) + 90) % 360);
            });
        });
    });
    if (!multi) {
        (function (idx) {
            // v1.2.2 refinement: press-and-hold repeats (no 15 clicks).
            function holdBtn(txt, title, fn) {
                var b = el('button', '', txt);
                b.title = title + ' (hold to repeat)';
                var t1 = null, t2 = null;
                function stop() {
                    if (t1) { clearTimeout(t1); t1 = null; }
                    if (t2) { clearInterval(t2); t2 = null; }
                }
                b.addEventListener('pointerdown', function (ev) {
                    if (ev.button !== 0) { return; }
                    ev.preventDefault();
                    // v1.2.2 refinement: skip ticks while a bake is in
                    // flight (firing into the lock would pile up stale
                    // orders and spam toasts). The held button keeps
                    // firing after the reload lands — smooth + correct.
                    if (!bakeInflight) { fn(); }
                    t1 = setTimeout(function () {
                        t2 = setInterval(function () {
                            if (!bakeInflight) { fn(); }
                        }, 160);
                    }, 380);
                    function up() {
                        stop();
                        b.removeEventListener('pointerup', up);
                        b.removeEventListener('pointerleave', up);
                    }
                    b.addEventListener('pointerup', up);
                    b.addEventListener('pointerleave', up);
                });
                bar.appendChild(b);
                return b;
            }
            holdBtn('⬆ Up', 'Move page up', function () {
                var ok = false;
                doStruct(function () { ok = movePageStep(idx, -1); });
                if (!ok) { toast('Already the first page'); }
            });
            holdBtn('⬇ Down', 'Move page down', function () {
                var ok = false;
                doStruct(function () { ok = movePageStep(idx, 1); });
                if (!ok) { toast('Already the last page'); }
            });
            // v1.2.2 refinement: jump straight to position N (big files).
            var alive = structOps.order.filter(function (id) { return !structOps.deleted[id]; });
            var goWrap = el('span', 'la-goto');
            var goInput = document.createElement('input');
            goInput.type = 'number';
            goInput.min = '1';
            goInput.max = String(alive.length);
            goInput.placeholder = '1-' + alive.length;
            goInput.title = 'Move page to position…';
            function stopKeys(ev) { ev.stopPropagation(); }
            goInput.addEventListener('keydown', stopKeys);
            goInput.addEventListener('pointerdown', stopKeys);
            function goTo() {
                var n = parseInt(goInput.value, 10);
                if (!isFinite(n)) { return; }
                structOpsEnsure();
                var aliveNow = structOps.order.filter(function (id) { return !structOps.deleted[id]; });
                n = Math.max(1, Math.min(aliveNow.length, n));
                var arr = structOps.order.filter(function (id) { return id !== idx; });
                var others = arr.filter(function (id) { return !structOps.deleted[id]; });
                var at = Math.min(others.length, n - 1);
                // insert before the alive page currently at position at
                var beforeId = others[at];
                var ix = arr.indexOf(beforeId);
                if (ix < 0) { arr.push(idx); }
                else { arr.splice(ix, 0, idx); }
                // keep deleted identities at the end, stable
                Object.keys(structOps.deleted).forEach(function (k) {
                    var d = parseInt(k, 10);
                    var di = arr.indexOf(d);
                    if (di >= 0) { arr.splice(di, 1); arr.push(d); }
                });
                postReorder(arr, idx);
            }
            goInput.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') { goTo(); }
            });
            var goBtn = el('button', '', 'Go');
            goBtn.title = 'Move the page to the entered position';
            goBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                goTo();
            });
            goWrap.appendChild(goInput);
            goWrap.appendChild(goBtn);
            bar.appendChild(goWrap);
            btn('🖼 Image', 'Add an image to this page', function () {
                thumbAddImage(idx);
            });
        })(pageSel[0]);
    }
    btn('✖', 'Hide the bar', function () { setPageSel([]); });
}

// ---- top-toolbar entry points (v1.2.2 refinement) ----------------------------------
function openAnnotBarWith(t) {
    tool = t || tool;
    var bar = document.getElementById('lectorAnnotBar');
    if (bar) {
        bar.style.display = '';
    }
    refreshToolButtons();
    refreshCanvasEvents();
    var row = document.getElementById('lectorStampRow');
    if (row) { row.style.display = (tool === 'stamp') ? '' : 'none'; }
    if (tool === 'stamp') { toast('Pick a stamp, then click a page'); }
}
function hookTopToolbar() {
    var org = document.getElementById('lectorOrganize');
    if (org && !org._lectorHooked) {
        org._lectorHooked = true;
        org.addEventListener('click', function () { organizerOpen(); });
    }
    var st = document.getElementById('lectorStamp');
    if (st && !st._lectorHooked) {
        st._lectorHooked = true;
        // v1.2.2 refinement: one click → bar opens AND the file picker opens
        // at once (icons stay available in the chooser row if cancelled).
        st.addEventListener('click', function () {
            openAnnotBarWith('stamp');
            toast('Choose an image from your device…');
            post('stamp-request');
        });
    }
}

// ---- boot ----------------------------------------------------------------------
function hookViewerEvents() {
    var a = app();
    if (!a || !a.eventBus) { return; }
    a.eventBus.on('pagerendered', function (ev) {
        // v1.2.2 refinement: fully guarded — our overlay must never break
        // the viewer's own render loop, whatever the DOM looks like.
        try {
            var n = (ev.pageNumber || 1) - 1;
            redrawPage(n);
            refreshCanvasEvents();
        } catch (e) { /* ignore */ }
    });
    a.eventBus.on('scalechange', function () { redrawAll(); refreshCanvasEvents(); });
    a.eventBus.on('pagesloaded', function () {
        redrawAll();
        refreshCanvasEvents();
        assignThumbIds(); // v1.2.2 refinement: stable page identity
        markThumbState();
        post('ready');
    });
    window.addEventListener('resize', function () { redrawAll(); });
}
function boot() {
    // v1.3.5: Start loading system fonts early (async, non-blocking)
    loadSystemFonts();
    buildBar();
    hookTopToolbar();
    hookSidebar();
    // v1.2.2 refinement: one-time hint where the page options live.
    setTimeout(function () {
        toast('Left sidebar: right-click any page for options');
    }, 2500);
    var bar = document.getElementById('lectorAnnotBar');
    if (bar) {
        // v1.3.0: docked rail starts visible (hide via – button, reopen via ✎).
        bar.style.display = '';
    }
    applyNight(); // v1.3.0: restore persisted night mode
    hookViewerEvents();
    // v1.2.1: Delete key removes the selected annot (unless typing).
    // v1.2.2 refinement: Ctrl/Cmd+Z = three-tier undo. Skipped while
    // typing so native text undo keeps working; no menu accelerator is
    // used for the same reason (it would hijack text fields).
    document.addEventListener('keydown', function (ev) {
        var typing = false;
        try {
            var at = document.activeElement;
            typing = !!(at && (at.tagName === 'TEXTAREA' || at.tagName === 'INPUT' || at.isContentEditable));
        } catch (e) { /* ignore */ }
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey &&
            (ev.key === 'z' || ev.key === 'Z') && !typing) {
            ev.preventDefault();
            ev.stopPropagation();
            menuUndo();
            return;
        }
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedId) {
            if (typing) { return; }
            ev.preventDefault();
            deleteSelected();
        }
        // v1.2.2 refinement: Escape clears the page selection + bar.
        if (ev.key === 'Escape' && pageSel.length) {
            setPageSel([]);
        }
    });
    // in case the document is already open (cached viewer)
    try {
        var a = app();
        if (a && a.pdfDocument) { post('ready'); redrawAll(); }
    } catch (e) { /* ignore */ }
    refreshCanvasEvents();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        var a = app();
        if (a && a.initializedPromise) { a.initializedPromise.then(boot); }
        else { setTimeout(boot, 500); }
    });
} else {
    var a0 = app();
    if (a0 && a0.initializedPromise) { a0.initializedPromise.then(boot); }
    else { setTimeout(boot, 500); }
}

})();
