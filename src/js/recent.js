"use strict";
/*------------------------------------------------------------------------------
 *  v1.2.2 file by KinanDev (new file, MIT License, same as project).
 *  Recent-files + last-folder memory (single JSON in userData).
 *  Required by BOTH main.js (menu rebuild, tracking) and menutemplate.js
 *  (dialog defaultPath) — hence a shared module (no cycles, no deps).
 *----------------------------------------------------------------------------*/

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const RECENT_MAX = 10;
let onChange = null;

function storePath() {
    try {
        return path.join(app.getPath('userData'), 'lector-recent.json');
    } catch (e) {
        return null;
    }
}

function loadRecent() {
    const empty = { files: [], lastDir: null };
    try {
        const file = storePath();
        if (!file || !fs.existsSync(file)) { return empty; }
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').slice(0, 8192));
        const files = ((raw && raw.files) || [])
            .filter((p) => typeof p === 'string' && fs.existsSync(p))
            .slice(0, RECENT_MAX);
        const lastDir = (raw && typeof raw.lastDir === 'string' && fs.existsSync(raw.lastDir))
            ? raw.lastDir : null;
        return { files, lastDir };
    } catch (e) {
        return empty;
    }
}

function saveRecent(state) {
    try {
        const file = storePath();
        if (!file) { return; }
        fs.writeFileSync(file, JSON.stringify({
            files: (state.files || []).slice(0, RECENT_MAX),
            lastDir: state.lastDir || null
        }).slice(0, 8192), 'utf8');
    } catch (e) { /* best-effort */ }
}

function touchRecent(pdfPath) {
    if (typeof pdfPath !== 'string' || !pdfPath.toLowerCase().endsWith('.pdf')) { return; }
    if (!fs.existsSync(pdfPath)) { return; }
    const state = loadRecent();
    state.files = [pdfPath].concat(state.files.filter((p) => p !== pdfPath)).slice(0, RECENT_MAX);
    try {
        state.lastDir = path.dirname(pdfPath);
    } catch (e) { /* ignore */ }
    saveRecent(state);
    if (onChange) {
        try { onChange(); } catch (e) { /* ignore */ }
    }
}

function clearRecent() {
    saveRecent({ files: [], lastDir: loadRecent().lastDir });
    if (onChange) {
        try { onChange(); } catch (e) { /* ignore */ }
    }
}

function removeRecent(pdfPath) {
    const state = loadRecent();
    state.files = state.files.filter((p) => p !== pdfPath);
    saveRecent(state);
    if (onChange) {
        try { onChange(); } catch (e) { /* ignore */ }
    }
}

/** v1.3.10: remember a folder as the default start location for file dialogs. */
function setLastDir(dir) {
    if (typeof dir !== 'string' || !dir) return;
    try {
        const state = loadRecent();
        state.lastDir = dir;
        saveRecent(state);
    } catch (e) { /* ignore */ }
    if (onChange) {
        try { onChange(); } catch (e) { /* ignore */ }
    }
}

module.exports = {
    loadRecent, touchRecent, clearRecent, removeRecent, setLastDir,
    setOnChange(fn) { onChange = fn; }
};
