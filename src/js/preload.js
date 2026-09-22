"use strict";
/*------------------------------------------------------------------------------
 *  v1.2.0 file by KinanDev (new file, MIT License, same as project).
 *  Minimal contextBridge API: the renderer has NO Node access.
 *  Only these whitelisted channels are exposed, so injected code inside
 *  a malicious PDF cannot reach ipcRenderer, shell, fs or network.
 *----------------------------------------------------------------------------*/

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ALLOWED_SEND = new Set(['toggle-menu-items', 'recent-add', 'custom-menu-action']);
const ALLOWED_INVOKE = new Set(['save-pdf', 'annot-load', 'annot-save',
    'structure-bake', 'use-temp', 'pick-image', 'confirm-dirty', 'discard-changes',
    'get-dirty-list', 'get-sidecar', 'get-theme', 'save-theme', 'get-recent',
    'state-get-file', 'state-set-lastpage', 'state-toggle-bookmark',
    'state-clear-bookmarks']);
const ALLOWED_RECEIVE = new Set([
    'file-open',
    'file-print',
    'file-properties',
    'file-close',
    'file-save',
    'file-save-as',
    'undo-struct',
    'view-fullscreen',
    'external-file-open',
    'dirty-changed',
    'set-theme',
    'night-toggle'
]);

contextBridge.exposeInMainWorld('lectorAPI', {
    send(channel, data) {
        if (ALLOWED_SEND.has(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    on(channel, listener) {
        if (ALLOWED_RECEIVE.has(channel)) {
            ipcRenderer.on(channel, (event, ...args) => listener(...args));
        }
    },
    invoke(channel, data) {
        // v1.2.1: request/response bridge for annotation persistence
        // and "save annotated PDF" export (handled in main process).
        if (ALLOWED_INVOKE.has(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
        return Promise.reject(new Error('channel not allowed: ' + channel));
    },
    closeAbout() {
        ipcRenderer.send('about-close');
    },
    getPathForFile(file) {
        // v1.3.0: drag & drop — webUtils is the only supported way to read
        // a dropped file's path from a sandboxed renderer.
        try {
            if (!file) { return ''; }
            return webUtils.getPathForFile(file) || (file.path || '');
        } catch (e) {
            return (file && file.path) || '';
        }
    }
});
