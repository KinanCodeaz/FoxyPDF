"use strict";
/*------------------------------------------------------------------------------
 *  v1.3.0 file by KinanDev (new file, MIT License, same as project).
 *  Per-file reader state: last page read + bookmarks (single JSON in userData).
 *  Required by BOTH main.js (IPC handlers) and nothing else — the renderer
 *  only talks to it through the whitelisted preload channels.
 *----------------------------------------------------------------------------*/

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const STATE_MAX_BYTES = 262144; // 256 KB guard
const BOOKMARK_MAX = 512;

function storePath() {
    try {
        return path.join(app.getPath('userData'), 'foxypdf-state.json');
    } catch (e) {
        return null;
    }
}

function loadState() {
    try {
        const file = storePath();
        if (!file || !fs.existsSync(file)) { return {}; }
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').slice(0, STATE_MAX_BYTES));
        return (raw && typeof raw === 'object') ? raw : {};
    } catch (e) {
        return {};
    }
}

function saveState(state) {
    try {
        const file = storePath();
        if (!file) { return; }
        const out = {};
        Object.keys(state).forEach((k) => {
            if (typeof k !== 'string' || k.length > 4096) { return; }
            const rec = state[k];
            if (!rec) { return; }
            const clean = { page: 1, bookmarks: [] };
            if (typeof rec.page === 'number' && isFinite(rec.page) && rec.page >= 1) {
                clean.page = Math.floor(rec.page);
            }
            if (Array.isArray(rec.bookmarks)) {
                clean.bookmarks = rec.bookmarks
                    .map((n) => parseInt(n, 10))
                    .filter((n) => isFinite(n) && n >= 1)
                    .filter((n, i, a) => a.indexOf(n) === i)
                    .sort((a, b) => a - b)
                    .slice(0, BOOKMARK_MAX);
            }
            // drop records with nothing useful
            if (clean.page > 1 || clean.bookmarks.length > 0) {
                out[k] = clean;
            }
        });
        fs.writeFileSync(file, JSON.stringify(out).slice(0, STATE_MAX_BYTES), 'utf8');
    } catch (e) { /* best-effort */ }
}

function getFileState(pdfPath) {
    const state = loadState();
    return state[pdfPath] || { page: 1, bookmarks: [] };
}

function setLastPage(pdfPath, page) {
    const n = parseInt(page, 10);
    if (!isFinite(n) || n < 1) { return getFileState(pdfPath); }
    const state = loadState();
    state[pdfPath] = state[pdfPath] || { page: 1, bookmarks: [] };
    state[pdfPath].page = n;
    saveState(state);
    return state[pdfPath];
}

function toggleBookmark(pdfPath, page) {
    const n = parseInt(page, 10);
    if (!isFinite(n) || n < 1) { return null; }
    const state = loadState();
    const rec = state[pdfPath] || { page: 1, bookmarks: [] };
    // FIX: bookmarks may be missing (clearBookmarks deletes the key) —
    // default to [] instead of crashing on .indexOf of undefined.
    rec.bookmarks = Array.isArray(rec.bookmarks) ? rec.bookmarks : [];
    const i = rec.bookmarks.indexOf(n);
    if (i >= 0) { rec.bookmarks.splice(i, 1); } else { rec.bookmarks.push(n); }
    rec.bookmarks.sort((a, b) => a - b);
    state[pdfPath] = rec;
    saveState(state);
    return { page: rec.page || 1, bookmarks: rec.bookmarks.slice() };
}

function clearBookmarks(pdfPath) {
    const state = loadState();
    if (state[pdfPath]) { delete state[pdfPath].bookmarks; }
    saveState(state);
    // FIX: always return a normalized shape (the stored record may have no
    // bookmarks key at all — callers expect an array, not undefined).
    const rec = state[pdfPath] || { page: 1, bookmarks: [] };
    return { page: rec.page || 1, bookmarks: [] };
}

module.exports = {
    getFileState, setLastPage, toggleBookmark, clearBookmarks, loadState
};