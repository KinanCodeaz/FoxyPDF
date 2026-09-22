"use strict";
/*------------------------------------------------------------------------------
 *  Copyright (c) 2019 Sagar Gurtu
 *  Licensed under the MIT License.
 *  See License in the project root for license information.
 *
 *  v1.2.0 changes by KinanDev:
 *  - Removed nodeIntegration / remote (RCE hardening).
 *  - Enabled contextIsolation + sandbox + preload bridge.
 *  - Removed custom-electron-titlebar (unmaintained, remote-based).
 *    Native OS frame is used instead (lighter + safer).
 *  - Fixed relative paths for packaged builds (path.join / __dirname).
 *  - Blocked popups, external navigation and dangerous permissions.
 *    The app opens no network ports and loads no remote code.
 *----------------------------------------------------------------------------*/

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
// v1.2.2 refinement: English-only UI — pin Chromium locale so the vendored
// viewer, native dialogs and navigator.language ignore the OS locale.
app.commandLine.appendSwitch('lang', 'en-US');
const { buildMenuTemplate } = require('./menutemplate');
const { burnAnnotations } = require('./annot-burn');
const { applyStructure } = require('./page-ops');
const readerState = require('./reader-state');
const recent = require('./recent');
const THEME_LIST = require('./theme-list');

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win, aboutWin;

function secureWebContents(contents) {
    // Never open a new window inside the app: open http(s) externally.
    contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // Allow only local file navigation (the bundled viewer + assets).
    // Anything else (http, custom protocols) is blocked to stop
    // malicious PDFs / injected links from exfiltrating data.
    contents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) {
            event.preventDefault();
        }
    });

    // Deny all powerful permissions by default (media, fullscreen
    // requests from the PDF viewer iframe are handled via the menu).
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
        callback(false);
    });
}

function createWindow() {
    // Create the browser window.
    win = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 300,
        minHeight: 300,
        icon: path.join(__dirname, '..', 'assets', 'images', 'logo.ico'),
        // NOTE v1.2.0: native frame. The old custom-electron-titlebar
        // dependency was removed (unmaintained + remote-based).
        // v1.3.0: keep native frame but hide the OS menu bar — we render a
        // custom themed menubar in index.html (File/Edit/View...).
        frame: true,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    secureWebContents(win.webContents);
    armCloseGuard(win); // v1.2.2: prompt for dirty files before quitting

    // Send initial launch arguments (e.g. PDF opened via file association)
    // to the renderer once it is ready. Replaces the old `remote` usage.
    win.webContents.once('did-finish-load', () => {
        win.webContents.send('external-file-open', process.argv);
    });

    // and load the index.html of the app.
    win.loadFile(path.join(__dirname, '..', 'index.html'));

    // Emitted when the window is closed.
    win.on('closed', () => {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        win = null;
        aboutWin = null;
    });

    // Create the application menu (File/Edit/View/Help + recent files).
    buildAppMenu();
    try { win.setMenuBarVisibility(false); } catch(e){}
}

// Theme persistence (lightweight, userData JSON). Valid names come from
// the shared theme-list.js so main and renderer can never disagree.
const THEME_FILE = path.join(app.getPath('userData'), 'foxypdf-theme.json');
const VALID_THEMES = new Set(THEME_LIST.THEMES);
function loadThemePref(){ try{ if(!fs.existsSync(THEME_FILE)) return null; const j=JSON.parse(fs.readFileSync(THEME_FILE,'utf8').slice(0,4096)); if(j&&VALID_THEMES.has(j.theme)) return {theme:j.theme, accent:j.accent||"green"}; }catch(e){} return null; }
function saveThemePref(theme,accent){ try{ fs.writeFileSync(THEME_FILE, JSON.stringify({theme, accent: accent||"green"}).slice(0,4096),'utf8'); }catch(e){} }
ipcMain.handle('get-theme', async()=> loadThemePref() || {theme:"dark", accent:"green"});
ipcMain.handle('save-theme', async(e,d)=>{ if(d&&VALID_THEMES.has(d.theme)) saveThemePref(d.theme,d.accent); return {ok:true}; });
ipcMain.handle('get-recent', async()=> recent.loadRecent());

// v1.3.0: per-file reader state (last page + bookmarks).
ipcMain.handle('state-get-file', async (e, d) => {
    if (!d || typeof d.pdfPath !== 'string') { return { page: 1, bookmarks: [] }; }
    return readerState.getFileState(d.pdfPath);
});
ipcMain.handle('state-set-lastpage', async (e, d) => {
    if (!d || typeof d.pdfPath !== 'string') { return { page: 1, bookmarks: [] }; }
    return readerState.setLastPage(d.pdfPath, d.page);
});
ipcMain.handle('state-toggle-bookmark', async (e, d) => {
    if (!d || typeof d.pdfPath !== 'string') { return null; }
    return readerState.toggleBookmark(d.pdfPath, d.page);
});
ipcMain.handle('state-clear-bookmarks', async (e, d) => {
    if (!d || typeof d.pdfPath !== 'string') { return { page: 1, bookmarks: [] }; }
    return readerState.clearBookmarks(d.pdfPath);
});

// Menu lives in one rebuildable place so the Open Recent list refreshes
// the moment it changes.
let appMenu = null;
// v1.2.2 refinement: menu rebuilds wipe item state — remember it.
let menuItemsEnabled = false;

function applyMenuToggle() {
    if (!appMenu) { return; }
    for (const id of ['file-print', 'file-properties', 'file-close', 'file-save', 'file-save-as', 'view-fullscreen']) {
        const item = appMenu.getMenuItemById(id);
        if (item) {
            item.enabled = menuItemsEnabled;
        }
    }
}

function buildAppMenu() {
    if (!win || win.isDestroyed()) { return; }
    // Create a menu using template
    const menu = Menu.buildFromTemplate(buildMenuTemplate(win));
    // Create about window
    const aboutItem = menu.getMenuItemById('about');
    if (aboutItem) {
        aboutItem.click = () => {
            if (!aboutWin) {
                aboutWin = new BrowserWindow({
                    width: 340,
                    height: 200,
                    resizable: false,
                    parent: win,
                    modal: true,
                    autoHideMenuBar: true,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                        preload: path.join(__dirname, 'preload.js')
                    }
                });

                secureWebContents(aboutWin.webContents);
                aboutWin.loadFile(path.join(__dirname, '..', 'about.html'));

                aboutWin.on('closed', () => {
                    aboutWin = null;
                });
            }
        };
    }

    // Set application menu
    Menu.setApplicationMenu(menu);
    appMenu = menu;
    applyMenuToggle();
}

// v1.2.2: track every opened file for Open Recent (renderer reports all
// opens uniformly: dialog, association, second instance).
ipcMain.on('recent-add', (event, pdfPath) => {
    recent.touchRecent(pdfPath);
});
recent.setOnChange(() => { buildAppMenu(); });

// v1.3.0: custom themed menubar (renderer) forwards clicks here so the
// native hidden menu still provides accelerators but the visual bar is themed.
ipcMain.on('custom-menu-action', async (event, data) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender) || win;
    if (!senderWin) return;
    let action = '', arg = undefined;
    if (typeof data === 'string') {
        // Split on the FIRST colon only: Windows paths (C:\...) carry
        // their own colons, and the action names never contain one.
        const idx = data.indexOf(':');
        if (idx >= 0) { action = data.slice(0, idx); arg = data.slice(idx + 1); }
        else { action = data; }
    } else if (data && typeof data.action === 'string') {
        action = data.action; arg = data.arg;
    } else return;
    const act = String(action||'');
    if (act === 'file-open') {
        const opts = { properties: ['openFile'], filters: [{ name: 'PDF Files', extensions: ['pdf'] }] };
        const lastDir = recent.loadRecent().lastDir;
        if (lastDir) opts.defaultPath = lastDir;
        const { canceled, filePaths } = await dialog.showOpenDialog(senderWin, opts);
        if (!canceled && filePaths && filePaths[0]) senderWin.webContents.send('file-open', filePaths[0]);
    } else if (act === 'file-open-path') {
        if (typeof arg === 'string' && arg) senderWin.webContents.send('file-open', arg);
    } else if (act === 'file-print') senderWin.webContents.send('file-print');
    else if (act === 'file-save') senderWin.webContents.send('file-save');
    else if (act === 'file-save-as') senderWin.webContents.send('file-save-as');
    else if (act === 'file-properties') senderWin.webContents.send('file-properties');
    else if (act === 'file-close') senderWin.webContents.send('file-close');
    else if (act === 'app-quit') app.quit();
    else if (act === 'undo-struct') senderWin.webContents.send('undo-struct');
    else if (act === 'view-fullscreen') senderWin.webContents.send('view-fullscreen');
    else if (act === 'toggle-devtools' && senderWin) senderWin.webContents.toggleDevTools();
    else if (act === 'set-theme' && typeof arg === 'string') senderWin.webContents.send('set-theme', arg);
    else if (act === 'about') {
        const aboutItem = appMenu && appMenu.getMenuItemById('about');
        if (aboutItem && aboutItem.click) aboutItem.click();
    } else if (act === 'clear-recent') recent.clearRecent();
    else if (act === 'remove-recent' && typeof arg === 'string') recent.removeRecent(arg);
});

// Add event listener for enabling/disabling menu items (module level:
// registered once, survives menu rebuilds via appMenu).
ipcMain.on('toggle-menu-items', (event, flag) => {
    menuItemsEnabled = flag === true;
    applyMenuToggle();
});

// v1.2.0: close handler for the About dialog (replaces `remote`).
ipcMain.on('about-close', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (senderWin) {
        senderWin.close();
    }
});

/*------------------------------------------------------------------------------
 * v1.2.1 annotation persistence + export (KinanDev).
 * Sidecars live in the app userData dir (never next to user files unless
 * the user explicitly exports). Export burns annotations into a NEW pdf-lib
 * document so the original file is never modified in place.
 *----------------------------------------------------------------------------*/
function annotSidecarPath(pdfPath) {
    const dir = path.join(app.getPath('userData'), 'lector-annots');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const hash = crypto.createHash('sha1').update(String(pdfPath)).digest('hex');
    return path.join(dir, hash + '.json');
}

// File fingerprint: size + mtime guard against stale sidecars (the PDF on
// disk may have been replaced since the sidecar was written).
function fileFingerprint(logicalPath) {
    try {
        const st = fs.statSync(logicalPath);
        return { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
    } catch (e) { return null; }
}

// Single writer for every sidecar update (annot-save, structure-bake,
// use-temp, post-save clear). Always stamps the fingerprint so readers can
// detect a replaced file instead of resurrecting dead annotations.
function writeSidecar(logicalPath, annots, visOps) {
    const payload = JSON.stringify({
        v: 2, annots: annots || {}, visOps: visOps || null,
        fp: fileFingerprint(logicalPath)
    }).slice(0, 10 * 1024 * 1024);
    fs.writeFileSync(annotSidecarPath(logicalPath), payload, 'utf8');
}

ipcMain.handle('annot-load', async (event, data) => {
    try {
        const pdfPath = data && data.pdfPath;
        if (typeof pdfPath !== 'string' || !pdfPath) { return { ok: false }; }
        discardedPaths.delete(pdfPath); // re-allow saves for this path
        pruneDiscardedPaths(); // keep set bounded
        const sidecar = readSidecar(pdfPath);
        return { ok: true, annots: sidecar.annots, visOps: sidecar.visOps };
    } catch (e) {
        return { ok: false };
    }
});

ipcMain.handle('annot-save', async (event, data) => {
    try {
        const pdfPath = data && data.pdfPath;
        if (typeof pdfPath !== 'string' || !pdfPath || !data.annots) { return { ok: false }; }
        // If this file was just discarded (tab closed with "Don't Save"),
        // skip writing — the sidecar was intentionally deleted.
        if (discardedPaths.has(pdfPath)) { return { ok: false, discarded: true }; }
        const s = sessions[pdfPath];
        if (s && s.discarded) { return { ok: false, discarded: true }; }
        writeSidecar(pdfPath, data.annots, data.visOps);
        markDirty(pdfPath);
        return { ok: true };
    } catch (e) {
        return { ok: false };
    }
});

/*------------------------------------------------------------------------------
 * v1.2.2 refinement document sessions + smart save (KinanDev).
 * HYBRID model (correctness-first, verified against the vendored viewer):
 * - Rotation/deletion render INSTANTLY in the viewer (native update /
 *   hidden divs) and persist to the sidecar; bytes bake ONCE at Save.
 * - REORDER is baked explicitly into a temp file + viewer reload. Reason:
 *   this PDF.js version keys rendering, current-page tracking and
 *   thumbnail navigation by page index — DOM reordering fights all of
 *   them (blank pages, stuck navigation). A baked temp is always native.
 * - Undo of a bake restores the previous temp + sidecar snapshot.
 *----------------------------------------------------------------------------*/
const sessions = {}; // logicalPath -> { tempPath, tempHistory[], dirty }
const discardedPaths = new Set(); // v1.3.1: paths where sidecar was discarded
const DISCARDED_MAX = 500; // v1.3.3: prevent unbounded growth
const TEMP_HIST_CAP = 5;

// v1.3.3: Keep discardedPaths bounded (LRU-style: remove oldest when over limit)
function pruneDiscardedPaths() {
    if (discardedPaths.size > DISCARDED_MAX) {
        const toRemove = discardedPaths.size - DISCARDED_MAX;
        const iter = discardedPaths.values();
        for (let i = 0; i < toRemove; i++) {
            const v = iter.next().value;
            if (v !== undefined) { discardedPaths.delete(v); }
        }
    }
}

function getSession(logicalPath) {
    if (!sessions[logicalPath]) {
        sessions[logicalPath] = { tempPath: null, tempHistory: [], dirty: false };
    }
    return sessions[logicalPath];
}

function currentBytes(logicalPath) {
    const s = getSession(logicalPath);
    const usePath = (s.tempPath && fs.existsSync(s.tempPath)) ? s.tempPath : logicalPath;
    if (!fs.existsSync(usePath)) { return null; }
    return { bytes: fs.readFileSync(usePath), basePath: usePath };
}

function dropTemps(logicalPath) {
    const s = sessions[logicalPath];
    if (!s) { return; }
    [s.tempPath].concat(s.tempHistory || []).forEach((t) => {
        if (t) { try { fs.unlinkSync(t); } catch (e) { /* ignore */ } }
    });
    s.tempPath = null;
    s.tempHistory = [];
}

// Delete stale lector temps from previous crashed sessions (startup).
function cleanStaleTemps() {
    try {
        const dir = os.tmpdir();
        fs.readdirSync(dir).forEach((f) => {
            if (/^lector-[0-9a-f]{10}-\d+\.pdf$/.test(f)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ }
            }
        });
    } catch (e) { /* ignore */ }
}

function notifyDirty(logicalPath) {
    const s = sessions[logicalPath];
    if (win && !win.isDestroyed()) {
        win.webContents.send('dirty-changed',
            { path: logicalPath, dirty: !!(s && s.dirty) });
    }
}

function markDirty(logicalPath) {
    if (typeof logicalPath !== 'string' || !logicalPath) { return; }
    getSession(logicalPath).dirty = true;
    notifyDirty(logicalPath);
}

// Sidecar v2: { v: 2, annots: {identity:[...]}, visOps: {order, deleted,
// rotations} }. Old v1 sidecars (bare page-keyed annots) still load.
function readSidecar(logicalPath) {
    const empty = { annots: {}, visOps: null };
    try {
        const file = annotSidecarPath(logicalPath);
        if (!fs.existsSync(file)) { return empty; }
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').slice(0, 10 * 1024 * 1024));
        if (!raw || typeof raw !== 'object') { return empty; }
        // v1.3.1: Validate file fingerprint — if the PDF on disk has a
        // different size or mtime than when the sidecar was saved, the
        // sidecar is stale (user replaced the file). Return empty.
        if (raw.fp && typeof raw.fp.size === 'number') {
            try {
                const st = fs.statSync(logicalPath);
                if (st.size !== raw.fp.size ||
                    Math.floor(st.mtimeMs / 1000) !== raw.fp.mtime) {
                    return empty; // stale: the PDF was replaced on disk
                }
            } catch (e) { /* stat failed: use the sidecar as-is */ }
        }
        if (Array.isArray(raw.order) || raw.annots) {
            return {
                annots: raw.annots || {},
                visOps: Array.isArray(raw.order) ? null : (raw.visOps || null)
            };
        }
        return { annots: raw, visOps: null }; // v1 bare format
    } catch (e) { return empty; }
}

function visOpsActive(visOps) {
    if (!visOps || !Array.isArray(visOps.order)) { return false; }
    if (Object.keys(visOps.deleted || {}).length > 0) { return true; }
    if (Object.keys(visOps.rotations || {}).some((k) => visOps.rotations[k])) { return true; }
    return visOps.order.some((id, pos) => parseInt(id, 10) !== pos);
}

// Remap identity-keyed annots onto final baked positions (skip deleted).
function remapForBake(annots, ops) {
    const deleted = new Set((ops.deleted || []).map((n) => parseInt(n, 10)));
    const out = {};
    (ops.order || []).forEach((origIdx, newIdx) => {
        const oi = parseInt(origIdx, 10);
        if (deleted.has(oi)) { return; }
        const list = (annots && annots[oi]) || [];
        if (list.length) {
            out[newIdx] = list.map((an) => Object.assign({}, an, { page: newIdx }));
        }
    });
    return out;
}

/**
 * Bake visual ops + annotations ONCE and write the result.
 * mode 'overwrite': backup original to `<base>.bak.pdf`, write result over
 *   the original, clear sidecar (annots now baked in).
 * mode 'saveas': ask for a target (default `<base>-MODIFIED.pdf` in the
 *   same folder), keep the session untouched.
 */
async function doSavePdf(event, logicalPath, mode) {
    try {
        if (typeof logicalPath !== 'string' || !logicalPath) {
            return { ok: false, error: 'No file.' };
        }
        if (!fs.existsSync(logicalPath)) {
            return { ok: false, error: 'Original PDF not found.' };
        }
        const senderWin = (event && BrowserWindow.fromWebContents(event.sender)) || win;
        const sidecar = readSidecar(logicalPath);
        // Base = current temp if a reorder was baked, else the original.
        // visOps (visual rotation/deletion since the last bake, if any)
        // bake on top; annots remap accordingly.
        const cur = currentBytes(logicalPath);
        if (!cur) { return { ok: false, error: 'Original PDF not found.' }; }
        const originalBytes = cur.bytes;
        let baseBytes = originalBytes;
        let pages = sidecar.annots || {};
        if (visOpsActive(sidecar.visOps)) {
            // visOps.deleted is an object map {identity:true}; normalize.
            const delArr = Object.keys(sidecar.visOps.deleted || {})
                .map((x) => parseInt(x, 10)).filter((n) => n >= 0);
            const structured = await applyStructure(originalBytes, {
                order: sidecar.visOps.order,
                deleted: delArr,
                rotations: sidecar.visOps.rotations || {}
            });
            baseBytes = Buffer.from(structured);
            pages = remapForBake(sidecar.annots, {
                order: sidecar.visOps.order, deleted: delArr
            });
        }
        const outBytes = await burnAnnotations(baseBytes, { pages });

        if (mode === 'overwrite') {
            const backupPath = logicalPath.replace(/\.pdf$/i, '') + '.bak.pdf';
            try { fs.copyFileSync(logicalPath, backupPath); } catch (e) { /* backup best-effort */ }
            fs.writeFileSync(logicalPath, Buffer.from(outBytes));
            dropTemps(logicalPath);
            const s = getSession(logicalPath);
            s.dirty = false;
            try { writeSidecar(logicalPath, {}, null); } catch (e) { /* ignore */ }
            notifyDirty(logicalPath);
            return { ok: true, path: logicalPath, mode: 'overwrite', backup: backupPath, cleared: true };
        }

        // saveas
        const dir = path.dirname(logicalPath);
        const base = path.basename(logicalPath).replace(/\.pdf$/i, '');
        const { canceled, filePath: outPath } = await dialog.showSaveDialog(senderWin, {
            title: 'Save as new PDF',
            defaultPath: path.join(dir, base + '-MODIFIED.pdf'),
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
        });
        if (canceled || !outPath) { return { ok: false, canceled: true }; }
        fs.writeFileSync(outPath, Buffer.from(outBytes));
        return { ok: true, path: outPath, mode: 'saveas' };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

ipcMain.handle('save-pdf', async (event, data) => {
    return doSavePdf(event, data && data.pdfPath,
        data && data.mode === 'overwrite' ? 'overwrite' : 'saveas');
});

// v1.2.2 refinement: REORDER-ONLY bake. The viewer posts its full current
// visOps + annots (identity-keyed); main bakes structure onto the session
// bytes, stores REMAPPED annots with visOps reset to null, and returns a
// fresh temp. Rotation/deletion never come here (visual-instant).
ipcMain.handle('structure-bake', async (event, data) => {
    try {
        const originalPath = data && data.originalPath;
        if (typeof originalPath !== 'string' || !originalPath) {
            return { ok: false, error: 'No file.' };
        }
        const cur = currentBytes(originalPath);
        if (!cur) { return { ok: false, error: 'Original PDF not found.' }; }
        const ops = { order: data.order, deleted: data.deleted, rotations: data.rotations };
        const outBytes = await applyStructure(cur.bytes, ops);
        const s = getSession(originalPath);
        if (s.tempPath) {
            s.tempHistory.push(s.tempPath);
            while (s.tempHistory.length > TEMP_HIST_CAP) {
                const old = s.tempHistory.shift();
                try { fs.unlinkSync(old); } catch (e) { /* ignore */ }
            }
        }
        const hash = crypto.createHash('sha1').update(originalPath).digest('hex').slice(0, 10);
        const tempPath = path.join(os.tmpdir(),
            'lector-' + hash + '-' + Date.now() + '.pdf');
        fs.writeFileSync(tempPath, Buffer.from(outBytes));
        s.tempPath = tempPath;
        // Remap annots onto baked positions; visOps reset (baked in).
        try {
            writeSidecar(originalPath, remapForBake(data.annots || {}, ops), null);
        } catch (e) { /* ignore */ }
        markDirty(originalPath);
        return { ok: true, tempPath };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
});

// v1.2.2 refinement: undo of a bake — switch back to a history temp and
// restore its sidecar snapshot (sent by the parent, which owns history).
ipcMain.handle('use-temp', async (event, data) => {
    try {
        const originalPath = data && data.originalPath;
        const tempPath = data && data.tempPath;
        const s = originalPath && sessions[originalPath];
        if (!s || typeof tempPath !== 'string' || !fs.existsSync(tempPath)) {
            return { ok: false, error: 'Session expired, reopen the file.' };
        }
        const allowed = [s.tempPath].concat(s.tempHistory || []);
        if (allowed.indexOf(tempPath) < 0) {
            return { ok: false, error: 'Unknown temp file.' };
        }
        // Drop temps newer than the target (files + history entries).
        const chain = [s.tempPath].concat(s.tempHistory || []);
        const keep = [];
        let found = false;
        for (const t of chain) {
            if (t === tempPath) { found = true; }
            if (found) { keep.push(t); }
            else { try { fs.unlinkSync(t); } catch (e) { /* ignore */ } }
        }
        if (!found) { return { ok: false, error: 'Unknown temp file.' }; }
        s.tempPath = tempPath;
        s.tempHistory = keep.slice(1);
        if (data.annots) {
            try { writeSidecar(originalPath, data.annots, null); }
            catch (e) { /* ignore */ }
        }
        markDirty(originalPath);
        return { ok: true, tempPath };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
});

ipcMain.handle('get-sidecar', async (event, data) => {
    // v1.2.2 refinement: feeds the parent's cross-reload undo slots.
    try {
        const pdfPath = data && data.pdfPath;
        if (typeof pdfPath !== 'string' || !pdfPath) { return { ok: false }; }
        const sidecar = readSidecar(pdfPath);
        return { ok: true, annots: sidecar.annots, visOps: sidecar.visOps };
    } catch (e) {
        return { ok: false };
    }
});

ipcMain.handle('pick-image', async (event) => {
    try {
        const senderWin = (event && BrowserWindow.fromWebContents(event.sender)) || win;
        const { canceled, filePaths } = await dialog.showOpenDialog(senderWin, {
            title: 'Choose an image stamp',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
        });
        if (canceled || !filePaths || !filePaths[0]) { return { ok: false, canceled: true }; }
        const buf = fs.readFileSync(filePaths[0]);
        if (buf.length > 5 * 1024 * 1024) { return { ok: false, error: 'Image is larger than 5 MB.' }; }
        const ext = path.extname(filePaths[0]).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
});

// Choice dialog for dirty files. Returns 'save' | 'saveas' | 'discard' | 'cancel'.
ipcMain.handle('confirm-dirty', async (event, data) => {
    const senderWin = (event && BrowserWindow.fromWebContents(event.sender)) || win;
    const name = (data && data.name) || 'file';
    const { response } = await dialog.showMessageBox(senderWin, {
        type: 'question',
        title: 'Unsaved changes',
        message: '"' + name + '" has unsaved changes.',
        detail: 'Save: overwrite the original (a .bak.pdf backup is kept).\nSave As: create a new file, the original stays untouched.\nDiscard: close without saving (page edits are reverted).',
        buttons: ['Save', 'Save As...', 'Discard', 'Cancel'],
        defaultId: 0,
        cancelId: 3
    });
    return ['save', 'saveas', 'discard', 'cancel'][response] || 'cancel';
});

// Single source for "which files have unsaved changes" (dirty-list IPC
// and the quit guard must never disagree).
function listDirty() {
    try {
        return Object.keys(sessions).filter((p) => sessions[p].dirty && fs.existsSync(p));
    } catch (e) { return []; }
}

ipcMain.handle('get-dirty-list', async () => {
    return listDirty();
});

ipcMain.handle('discard-changes', async (event, data) => {
    // TRUE discard — delete the sidecar entirely so annotations are
    // gone on next open. Also mark session as discarded so any pending
    // annot-save IPC calls skip writing (prevents race condition).
    try {
        const p = data && data.pdfPath;
        dropTemps(p);
        if (p && sessions[p]) {
            sessions[p].discarded = true;
            delete sessions[p];
        }
        if (typeof p === 'string' && p) {
            discardedPaths.add(p); // block pending annot-save
            pruneDiscardedPaths(); // keep set bounded
            try {
                const file = annotSidecarPath(p);
                if (fs.existsSync(file)) { fs.unlinkSync(file); }
            } catch (e) { /* best-effort */ }
        }
        notifyDirty(p);
        return { ok: true };
    } catch (e) {
        return { ok: false };
    }
});

// Window close guard: prompt for every dirty file before quitting.
// v1.2.2 refinement: SINGLE dialog owner (main only — the renderer has no
// beforeunload, so nothing stacks). A `prompting` flag collapses double-X,
// every step is guarded, and a 90s timeout guarantees the window can never
// be trapped by a hung dialog.
let forceQuit = false;
let promptingQuit = false;
function armCloseGuard(targetWin) {
    targetWin.on('close', (e) => {
        if (forceQuit || targetWin.isDestroyed()) { return; }
        e.preventDefault();
        if (promptingQuit) { return; } // second X while asking: wait for it
        promptingQuit = true;
        quitWithPrompt(targetWin).catch(() => {
            // Fail open: never trap the user over a dialog failure.
        }).then(() => {
            promptingQuit = false;
        });
    });
}
// Drop a file's sidecar (used by Discard paths so a reopened file shows
// pristine pages — annotations AND structural ops are gone together).
function clearVisOps(logicalPath) {
    try {
        const file = annotSidecarPath(logicalPath);
        if (fs.existsSync(file)) { fs.unlinkSync(file); }
    } catch (e) { /* best-effort */ }
}

async function quitWithPrompt(targetWin) {
    const dirty = listDirty();
    if (dirty.length === 0) {
        forceQuit = true;
        if (!targetWin.isDestroyed()) { targetWin.close(); }
        return;
    }
    const flow = (async () => {
        // v1.2.2 refinement: ONE dialog for many files (Save all / Discard
        // all) instead of an interrogation per file.
        if (dirty.length > 1) {
            const first = await dialog.showMessageBox(targetWin, {
                type: 'question',
                title: 'Unsaved changes',
                message: dirty.length + ' files have unsaved changes.',
                detail: 'Save all: overwrite each original (a .bak.pdf backup is kept).\nDiscard all: quit without saving (page edits are reverted).',
                buttons: ['Save all', 'Discard all', 'Review one by one', 'Cancel'],
                defaultId: 0,
                cancelId: 3
            });
            if (first.response === 3) { return 'abort'; }
            if (first.response === 0) {
                for (const p of dirty) {
                    const r = await doSavePdf(null, p, 'overwrite');
                    if (!r.ok) { return 'abort'; }
                }
                return 'quit';
            }
            if (first.response === 1) {
                dirty.forEach(clearVisOps);
                return 'quit';
            }
            // response 2 falls through to the per-file loop.
        }
        for (const p of dirty) {
            const { response } = await dialog.showMessageBox(targetWin, {
                type: 'question',
                title: 'Unsaved changes',
                message: '"' + path.basename(p) + '" has unsaved changes.',
                detail: 'Save: overwrite the original (a .bak.pdf backup is kept).\nSave As: create a new file, the original stays untouched.\nDiscard: close without saving (page edits are reverted).',
                buttons: ['Save', 'Save As...', 'Discard', 'Cancel'],
                defaultId: 0,
                cancelId: 3
            });
            if (response === 3) { return 'abort'; } // Cancel: stay open
            if (response === 0) { await doSavePdf(null, p, 'overwrite'); }
            else if (response === 1) {
                const r = await doSavePdf({ sender: targetWin.webContents }, p, 'saveas');
                if (!r.ok) { return 'abort'; } // cancelled OR failed: stay put
            } else {
                clearVisOps(p); // Discard (2): revert structure on reopen
            }
        }
        return 'quit';
    })();
    const timeout = new Promise((res) => setTimeout(() => res('timeout'), 90000));
    const outcome = await Promise.race([flow, timeout]);
    if (outcome !== 'quit') { return; } // explicit Cancel (or hung dialog): stay
    forceQuit = true;
    if (!targetWin.isDestroyed()) { targetWin.close(); }
}

// Allow only a single instance of the app
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        // Someone tried to run a second instance, we should focus our window.
        if (win) {
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();
            win.webContents.send('external-file-open', commandLine);
        }
    });

    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.
    app.whenReady().then(() => {
        cleanStaleTemps();
        createWindow();
    });

    // Quit when all windows are closed.
    app.on('window-all-closed', () => {
        // On macOS it is common for applications and their menu bar
        // to stay active until the user quits explicitly with Cmd + Q
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (win === null) {
            createWindow();
        }
    });
}
