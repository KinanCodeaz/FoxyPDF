"use strict";
/*------------------------------------------------------------------------------
 *  Copyright (c) 2019 Sagar Gurtu
 *  Licensed under the MIT License.
 *  See License in the project root for license information.
 *
 *  v1.2.0 changes by KinanDev:
 *  - Migrated dialog.showOpenDialog from removed callback API to Promise API.
 *  - Fixed array-to-string bug: now sends a single file path (filePaths[0]).
 *  v1.2.2 changes by KinanDev:
 *  - Replaced single "Save Annotated" with Save (Ctrl+S, overwrite + .bak)
 *    and Save As (Ctrl+Shift+S, default `<base>-MODIFIED.pdf`).
 *----------------------------------------------------------------------------*/

const { app, dialog } = require('electron');
const fs = require('fs');
const recent = require('./recent');
const THEME_LIST = require('./theme-list');

exports.buildMenuTemplate = function (win) {
    const recentState = recent.loadRecent();
    const recentItems = recentState.files.map((p, i) => {
        // Accelerator 1-9 for the first nine (Windows convention).
        const item = {
            label: (i < 9 ? '&' + (i + 1) + ' ' : '') + p,
            click() {
                if (!fs.existsSync(p)) {
                    recent.removeRecent(p); // drops it + rebuilds the menu
                    dialog.showMessageBox(win, {
                        type: 'info',
                        title: 'File not found',
                        message: 'This file no longer exists and was removed from the recent list.'
                    }).catch(() => { /* ignore */ });
                    return;
                }
                win.webContents.send('file-open', p);
            }
        };
        if (i < 9) { item.accelerator = 'CmdOrCtrl+' + (i + 1); }
        return item;
    });
    if (recentItems.length > 0) {
        recentItems.push({ type: 'separator' });
        recentItems.push({
            label: 'Clear Recent',
            click() { recent.clearRecent(); }
        });
    } else {
        recentItems.push({ label: '(empty)', enabled: false });
    }
    return [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open...',
                    id: 'file-open',
                    accelerator: 'CmdOrCtrl+O',
                    async click() {
                        // Reopen where the user left off.
                        const opts = {
                            properties: ['openFile'],
                            filters: [
                                { name: 'PDF Files', extensions: ['pdf'] }
                            ]
                        };
                        const lastDir = recent.loadRecent().lastDir;
                        if (lastDir) { opts.defaultPath = lastDir; }
                        const { canceled, filePaths } = await dialog.showOpenDialog(win, opts);
                        // Send one clean path (never array.toString() —
                        // that breaks on commas in file names).
                        if (!canceled && filePaths && filePaths.length > 0) {
                            win.webContents.send('file-open', filePaths[0]);
                        }
                    }
                },
                {
                    label: 'Open Recent',
                    submenu: recentItems
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Print...',
                    id: 'file-print',
                    accelerator: 'CmdOrCtrl+P',
                    enabled: false,
                    click() {
                        win.webContents.send('file-print')
                    }
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Save',
                    id: 'file-save',
                    accelerator: 'CmdOrCtrl+S',
                    enabled: false,
                    click() {
                        win.webContents.send('file-save')
                    }
                },
                {
                    label: 'Save As...',
                    id: 'file-save-as',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    enabled: false,
                    click() {
                        win.webContents.send('file-save-as')
                    }
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Properties...',
                    id: 'file-properties',
                    enabled: false,
                    click() {
                        win.webContents.send('file-properties')
                    }
                },
                {
                    type: 'separator'
                },
                {
                    label: 'Close',
                    id: 'file-close',
                    enabled: false,
                    click() {
                        win.webContents.send('file-close')
                    }
                },
                {
                    label: 'Exit',
                    click() {
                        app.quit()
                    }
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                {
                    // Visible cross-reload undo (no accelerator — never
                    // hijacks typing in the viewer).
                    label: 'Undo last change',
                    id: 'edit-undo',
                    click() {
                        win.webContents.send('undo-struct')
                    }
                }
            ]
        },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Theme',
                    submenu: THEME_LIST.THEMES.map((t) => ({
                        label: THEME_LIST.NAMES[t] || t,
                        type: 'radio',
                        click() { win.webContents.send('set-theme', t); }
                    }))
                },
                { type: 'separator' },
                {
                    // v1.3.0: night reading mode (forwarded to the viewer overlay)
                    label: 'Night reading mode',
                    click() {
                        win.webContents.send('night-toggle')
                    }
                },
                {
                    label: 'Toggle Full Screen',
                    id: 'view-fullscreen',
                    enabled: false,
                    accelerator: 'F11',
                    click() {
                        win.webContents.send('view-fullscreen')
                    }
                },
                {
                    // v1.2.2 refinement: our custom menu removed the default
                    // devtools bindings — restore both explicitly.
                    label: 'Toggle Developer Tools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click(item, focusedWindow) {
                        if (focusedWindow) {
                            focusedWindow.webContents.toggleDevTools();
                        }
                    }
                },
                {
                    label: 'Toggle Developer Tools (F12)',
                    accelerator: 'F12',
                    click(item, focusedWindow) {
                        if (focusedWindow) {
                            focusedWindow.webContents.toggleDevTools();
                        }
                    }
                }
            ]
        },
        {
            label: 'Settings',
            submenu: [
                {
                    label: 'Themes…',
                    click(){ win.webContents.send('set-theme','__palette'); }
                }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About',
                    id: 'about'
                }
            ]
        }

    ];
};
