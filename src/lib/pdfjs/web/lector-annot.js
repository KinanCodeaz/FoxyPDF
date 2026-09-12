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
function loadFabPos() {
    try {
        var p = JSON.parse(lsGet('lectorFabPos'));
        if (p && isFinite(p.top) && isFinite(p.right)) { return p; }
    } catch (e) { /* ignore */ }
    return null;
}
function saveFabPos(p) { lsSet('lectorFabPos', JSON.stringify(p)); }

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
        ctx.font = (a.size * scale) + 'px ' + a.font;
        ctx.textBaseline = 'top';
        var rtl = /[\u0590-\u08FF]/.test(a.text || '');
        // draw possibly multi-line text
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
                ctx.drawImage(im,
                    Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]),
                    Math.abs(p2[0] - p1[0]), Math.abs(p2[1] - p1[1]));
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
    if (found.annot.kind === 'image') {
        // v1.2.2: resize handle at the bottom-right corner.
        ctx.setLineDash([]);
        ctx.fillStyle = '#0a84ff';
        ctx.fillRect(b[0] + b[2] - 5, b[1] + b[3] - 5, 10, 10);
    }
    ctx.restore();
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
function applyToSelected() {
    // v1.2.1: color / width / font-size controls retarget the selection
    if (!selectedId) { return; }
    var found = findAnnot(selectedId);
    if (!found) { selectedId = null; return; }
    var a = found.annot;
    if (bakeLock()) { return; }
    pushVisUndo(); // v1.2.2 refinement
    a.color = color.slice();
    if (a.kind === 'rect' || a.kind === 'ink') { a.width = lineWidth; }
    if (a.kind === 'text') {
        a.size = fontSize;
        var m = measureText(a.text, a.size, a.font);
        a.w = m.wPt; a.h = m.hPt;
        if (a.yTop !== undefined) { a.y = a.yTop - m.hPt; }
        a.png = renderTextPng(a) || a.png; // v1.2.2: keep baked stamp fresh
    }
    redrawPage(found.page);
    scheduleSave();
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
        if (tool === 'select' || ev.button !== 0) { return; }
        ev.preventDefault();
        ev.stopPropagation();
        var m = canvasPos(c, ev);
        if (bakeLock()) { return; }
        if (tool === 'move') { moveDown(i, c, ev, m); return; } // v1.2.1
        if (tool === 'eraser') { eraseAt(i, m[0], m[1]); return; }
        if (tool === 'text') { openTextEditor(i, m[0], m[1]); return; }
        if (tool === 'stamp') { placeStamp(i, m[0], m[1]); return; } // v1.2.2
        var p = toPdf(i, m[0], m[1]);
        if (!p) { return; }
        drawing = true;
        c.setPointerCapture && c.setPointerCapture(ev.pointerId);
        draft = { page: i, kind: tool, x0: p[0], y0: p[1], x1: p[0], y1: p[1], points: [[p[0], p[1]]] };
    });
    c.addEventListener('pointermove', function (ev) {
        var m = canvasPos(c, ev); // v1.2.1: needed for move-drag
        if (moving && moving.page === i) {
            ev.preventDefault();
            moveTo(i, m);
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
        if (moving && moving.page === i) { // v1.2.1: end of move-drag
            moving = null;
            scheduleSave();
            redrawPage(i);
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
    c.addEventListener('dblclick', function (ev) { // v1.2.1: re-edit text
        if (tool !== 'move') { return; }
        var m = canvasPos(c, ev);
        var list = annots[i] || [];
        for (var k = list.length - 1; k >= 0; k--) {
            if (list[k].kind === 'text' && hitTest(i, list[k], m[0], m[1])) {
                ev.preventDefault();
                editTextAnnot(i, list[k]);
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
    // v1.2.2: resize handle (bottom-right) of the selected image first.
    if (selectedId) {
        var sel = findAnnot(selectedId);
        if (sel && sel.page === i && sel.annot.kind === 'image') {
            var hp = toView(i, sel.annot.x + sel.annot.w, sel.annot.y);
            if (hp && Math.hypot(m[0] - hp[0], m[1] - hp[1]) < 14) {
                pushVisUndo(); // v1.2.2 refinement
                moving = { page: i, id: selectedId, mode: 'resize' };
                if (c.setPointerCapture) {
                    try { c.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
                }
                return;
            }
        }
    }
    var list = annots[i] || [];
    for (var k = list.length - 1; k >= 0; k--) {
        if (hitTest(i, list[k], m[0], m[1])) {
            pushVisUndo(); // v1.2.2 refinement
            selectedId = list[k].id;
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
function placeStamp(i, mx, my) {
    if (!pendingStamp) {
        toast('Pick a stamp from the icon row first');
        return;
    }
    var p = toPdf(i, mx, my);
    if (!p) { return; }
    var pv = pageView(i), s = (pv && pv.viewport.scale) || 1;
    var wPt = 80; // default stamp width in PDF points
    var hPt = 80 * (pendingStamp.h / Math.max(1, pendingStamp.w));
    commit(i, { id: uid(), kind: 'image', page: i,
        x: p[0] - wPt / 2, y: p[1] - hPt / 2, w: wPt, h: hPt,
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
// v1.2.1: existing texts can be re-edited (double-click with the move tool).
function editTextAnnot(i, a) {
    var v = toView(i, a.x, a.yTop !== undefined ? a.yTop : a.y);
    if (!v) { return; }
    selectedId = a.id;
    openTextEditor(i, v[0], v[1], a);
}
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
    ta.style.left = mx + 'px';
    ta.style.top = my + 'px';
    ta.style.font = useSize + 'px ' + useFont;
    ta.style.color = css(useColor);
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
            // measure for overlay box + export stamp
            var meas = measureText(val, useSize, useFont);
            // yTop (viewport-down coords) -> store both top and bottom:
            var yTopPdf = q ? q[1] : (existing ? existing.yTop : p[1]);
            var record = {
                id: existing ? existing.id : uid(), kind: 'text', page: i,
                x: q ? q[0] : (existing ? existing.x : p[0]),
                y: yTopPdf - meas.hPt, yTop: yTopPdf,
                w: meas.wPt, h: meas.hPt,
                size: useSize, font: useFont,
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
function measureText(text, sizePt, font) {
    var c = measureText._c || (measureText._c = document.createElement('canvas'));
    var ctx = c.getContext('2d');
    ctx.font = sizePt + 'px ' + font;
    var lines = String(text).split('\n');
    var w = 0;
    for (var k = 0; k < lines.length; k++) { w = Math.max(w, ctx.measureText(lines[k]).width); }
    // canvas px == CSS px at this font size; PDF pt == CSS px * (72/96)
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
        var scale = 2; // 2x for crisp print
        var c = document.createElement('canvas');
        var ctx = c.getContext('2d');
        var pxPerPt = 96 / 72;
        ctx.font = (a.size * pxPerPt * scale) + 'px ' + a.font;
        var lines = String(a.text || '').split('\n');
        var w = 0, i;
        for (i = 0; i < lines.length; i++) { w = Math.max(w, ctx.measureText(lines[i]).width); }
        var lh = a.size * pxPerPt * 1.25 * scale;
        c.width = Math.max(2, Math.ceil(w + 8 * scale));
        c.height = Math.max(2, Math.ceil(lh * lines.length + 4 * scale));
        ctx.font = (a.size * pxPerPt * scale) + 'px ' + a.font;
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
var BUILTINS = [
    { name: 'check', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M10 34l14 14 30-36' stroke='#1e7e34' stroke-width='9' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" },
    { name: 'cross', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M14 14l36 36M50 14L14 50' stroke='#c00' stroke-width='9' fill='none' stroke-linecap='round'/></svg>" },
    { name: 'star', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M32 6l7.5 16.5L57 24l-13 12.5 3.5 17.5L32 45l-15.5 9L20 36.5 7 24l17.5-1.5z' fill='#f5b301'/></svg>" },
    { name: 'arrow-r', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M8 32h40M36 18l14 14-14 14' stroke='#0a84ff' stroke-width='8' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" },
    { name: 'arrow-l', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M56 32H16M28 18L14 32l14 14' stroke='#0a84ff' stroke-width='8' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" },
    { name: 'warn', svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='M32 6L60 56H4z' fill='#f5b301'/><rect x='29' y='22' width='6' height='16' fill='#222'/><rect x='29' y='42' width='6' height='6' fill='#222'/></svg>" }
];
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
            tool = 'stamp';
            refreshToolButtons();
            refreshCanvasEvents();
            toast(fromUpload ? 'Click a page to place the image' : 'Stamp selected');
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
function buildBar() {
    if (document.getElementById('lectorAnnotBar')) { return; }
    var bar = el('div', '');
    bar.id = 'lectorAnnotBar';

    // v1.2.1: grip handle — drag the whole bar anywhere, position is saved.
    var grip = el('div', 'la-grip', '⋮⋮');
    grip.title = 'Drag to move the bar';
    grip.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        var sy = ev.clientY, sx = ev.clientX;
        var r = bar.getBoundingClientRect();
        var startTop = r.top, startRight = window.innerWidth - r.right;
        function mv(e2) {
            var nt = Math.min(window.innerHeight - 60,
                       Math.max(36, startTop + (e2.clientY - sy)));
            var nr = Math.min(window.innerWidth - 60,
                       Math.max(4, startRight - (e2.clientX - sx)));
            bar.style.top = nt + 'px';
            bar.style.right = nr + 'px';
        }
        function up() {
            document.removeEventListener('pointermove', mv);
            document.removeEventListener('pointerup', up);
            saveFabPos({ top: parseFloat(bar.style.top), right: parseFloat(bar.style.right) });
        }
        document.addEventListener('pointermove', mv);
        document.addEventListener('pointerup', up);
    });
    bar.appendChild(grip);

    var tools = [
        ['select', '➤', 'Select'],
        ['move', '✥', 'Move / edit selection'],
        ['highlight', '🖍', 'Highlight'],
        ['rect', '▭', 'Rectangle'],
        ['redact', '⬛', 'Cover / hide'],
        ['pen', '✒', 'Freehand pen'],
        ['text', 'T', 'Write'],
        ['stamp', '🖼', 'Image / icon'],
        ['organizer', '🗂', 'Organize pages'],
        ['eraser', '⌫', 'Eraser']
    ];
    tools.forEach(function (t) {
        var b = el('button', 'la-btn' + (tool === t[0] ? ' active' : ''), t[1]);
        b.title = t[2];
        b.dataset.tool = t[0];
        b.addEventListener('click', function () {
            if (t[0] === 'organizer') { organizerOpen(); return; } // v1.2.2
            tool = t[0];
            closeTextEditor();
            refreshToolButtons();
            refreshCanvasEvents();
            var row = document.getElementById('lectorStampRow');
            if (row) { row.style.display = (tool === 'stamp') ? '' : 'none'; }
            toast('Tool: ' + t[2]);
        });
        bar.appendChild(b);
    });

    // v1.2.2: stamp chooser row — 6 built-in icons + upload from disk.
    var row = el('div', '');
    row.id = 'lectorStampRow';
    row.style.display = 'none';
    BUILTINS.forEach(function (bi) {
        var ib = el('button', 'la-btn la-icon', bi.name === 'check' ? '✓' : bi.name);
        ib.title = bi.name;
        ib.addEventListener('click', function () {
            rasterizeSvg(bi.svg, function (png) { setPendingStamp(png, false); });
        });
        row.appendChild(ib);
    });
    var up = el('button', 'la-btn', '📁');
    up.title = 'Image from disk (PNG/JPG)';
    up.addEventListener('click', function () {
        toast('Choose an image from your device…');
        post('stamp-request');
    });
    row.appendChild(up);
    bar.appendChild(row);

    COLORS.forEach(function (cc) {
        var s = el('button', 'la-color' + (css(color) === css(cc.v) ? ' active' : ''));
        s.style.background = css(cc.v);
        s.title = cc.name;
        s.addEventListener('click', function () {
            color = cc.v.slice();
            saveColor(); // v1.2.1: last color becomes the default
            var all = bar.querySelectorAll('.la-color');
            for (var k = 0; k < all.length; k++) { all[k].classList.remove('active'); }
            s.classList.add('active');
            applyToSelected(); // recolor the selected annot, if any
        });
        bar.appendChild(s);
    });

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

    var fill = el('button', 'la-btn', '▨');
    fill.title = 'Fill rectangle';
    fill.addEventListener('click', function () {
        fillOn = !fillOn;
        fill.classList.toggle('active', fillOn);
    });
    bar.appendChild(fill);

    var undo = el('button', 'la-btn', '↩');
    undo.title = 'Undo';
    undo.addEventListener('click', function () {
        menuUndo(); // v1.2.2 refinement: unified three-tier undo
    });
    bar.appendChild(undo);

    // v1.2.1: delete the selected annot (works for every kind).
    var del = el('button', 'la-btn', '✖');
    del.title = 'Delete selected';
    del.addEventListener('click', function () {
        if (!deleteSelected()) { toast('Select an annotation with the ✥ move tool first'); }
    });
    bar.appendChild(del);

    var clear = el('button', 'la-btn', '🗑');
    clear.title = 'Clear page';
    clear.addEventListener('click', function () {
        var a = app();
        var cur = a && a.pdfViewer ? a.pdfViewer.currentPageNumber - 1 : 0;
        if (!((annots[cur] || []).length)) { return; }
        if (bakeLock()) { return; }
        lectorConfirm('Erase all annotations on this page?', 'Erase all 🗑').then(function (ok) {
            if (!ok) { return; }
            pushVisUndo(); // v1.2.2 refinement
            annots[cur] = [];
            redrawPage(cur);
            scheduleSave();
        });
    });
    bar.appendChild(clear);

    var save = el('button', 'la-btn la-save', '💾');
    save.title = 'Save annotated PDF copy';
    save.addEventListener('click', function () {
        post('export-data', { pages: buildExport() });
        toast('Preparing the PDF…');
    });
    bar.appendChild(save);

    var hide = el('button', 'la-btn', '–');
    hide.title = 'Hide the bar';
    hide.addEventListener('click', function () {
        bar.style.display = 'none';
        showFab();
    });
    bar.appendChild(hide);

    document.body.appendChild(bar);
}
function placeBarAtFab(bar) {
    // v1.2.1: the bar opens where the user put the FAB.
    var f = document.getElementById('lectorFab');
    if (f) {
        var r = f.getBoundingClientRect();
        bar.style.top = Math.min(window.innerHeight - 120,
                         Math.max(36, r.top)) + 'px';
        bar.style.right = Math.min(window.innerWidth - 60,
                         Math.max(4, window.innerWidth - r.right)) + 'px';
        saveFabPos({ top: parseFloat(bar.style.top), right: parseFloat(bar.style.right) });
    }
}
function applyStoredPos(node) {
    var p = loadFabPos();
    if (p) {
        node.style.top = Math.min(window.innerHeight - 60, Math.max(36, p.top)) + 'px';
        node.style.right = Math.min(window.innerWidth - 50, Math.max(4, p.right)) + 'px';
    }
}
function showFab() {
    if (document.getElementById('lectorFab')) { return; }
    var f = el('button', '', '✎');
    f.id = 'lectorFab';
    f.title = 'Annotation tools (drag me anywhere)';
    applyStoredPos(f);
    // v1.2.1: drag to move, click to open — distinguished by distance.
    var sx = 0, sy = 0, dragging = false;
    f.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) { return; }
        sx = ev.clientX; sy = ev.clientY; dragging = false;
        f.setPointerCapture && f.setPointerCapture(ev.pointerId);
        function mv(e2) {
            if (!dragging && Math.hypot(e2.clientX - sx, e2.clientY - sy) > 5) {
                dragging = true;
                f.classList.add('dragging');
            }
            if (dragging) {
                var r = f.getBoundingClientRect();
                var curTop = parseFloat(f.style.top);
                var curRight = parseFloat(f.style.right);
                if (!isFinite(curTop)) { curTop = r.top; }
                if (!isFinite(curRight)) { curRight = window.innerWidth - r.right; }
                f.style.top = Math.min(window.innerHeight - 50,
                                Math.max(36, curTop + e2.movementY)) + 'px';
                f.style.right = Math.min(window.innerWidth - 50,
                                Math.max(4, curRight - e2.movementX)) + 'px';
            }
        }
        function up() {
            f.removeEventListener('pointermove', mv);
            f.removeEventListener('pointerup', up);
            f.classList.remove('dragging');
            if (dragging) {
                var r2 = f.getBoundingClientRect();
                saveFabPos({ top: r2.top, right: window.innerWidth - r2.right });
            } else {
                var bar = document.getElementById('lectorAnnotBar');
                if (bar) {
                    placeBarAtFab(bar);
                    bar.style.display = '';
                }
                f.remove();
            }
        }
        f.addEventListener('pointermove', mv);
        f.addEventListener('pointerup', up);
    });
    document.body.appendChild(f);
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
        applyStoredPos(bar);
        bar.style.display = '';
    }
    var f = document.getElementById('lectorFab');
    if (f) { f.remove(); }
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
    buildBar();
    showFab();
    hookTopToolbar();
    hookSidebar();
    // v1.2.2 refinement: one-time hint where the page options live.
    setTimeout(function () {
        toast('💡 Left sidebar ☰ → right-click any page: delete / rotate / image');
    }, 2500);
    // v1.2.2: default stamp = built-in check mark (silent, no toast).
    rasterizeSvg(BUILTINS[0].svg, function (png) {
        if (!png) { return; }
        var im = new Image();
        im.onload = function () {
            if (!pendingStamp) {
                pendingStamp = { png: png, w: im.naturalWidth, h: im.naturalHeight };
            }
        };
        im.src = png;
    });
    var bar = document.getElementById('lectorAnnotBar');
    if (bar) {
        bar.style.display = 'none'; // start hidden, FAB shows it
        applyStoredPos(bar);
    }
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
