"use strict";
/*------------------------------------------------------------------------------
 *  Copyright (c) 2019 Sagar Gurtu
 *  Licensed under the MIT License.
 *  See License in the project root for license information.
 *
 *  v1.2.0 changes by KinanDev:
 *  - Removed require('electron') / require('custom-electron-titlebar') /
 *    require('electron').remote from the renderer (no Node in renderer).
 *    All IPC now goes through window.lectorAPI (preload contextBridge).
 *  - Removed custom titlebar (native OS frame is used).
 *  - FIX: classList assignment bug (classList is read-only).
 *  - FIX: filename XSS (innerHTML -> textContent).
 *  - FIX: Windows-only path separator (now handles / and \ on all OSes).
 *  - FIX: uppercase .PDF files were rejected; extension check is now
 *    case-insensitive. Non-PDF files are ignored.
 *  - FIX: guarded iframe contentDocument access (was throwing on empty
 *    viewer / cross-origin states).
 *  v1.2.2 changes by KinanDev:
 *  - Unsaved-changes dots, Save / Save As flows, fail-open dirty-guard on
 *    tab close and window unload (main owns the data, no viewer round-trip).
 *  - Relay for image-stamp upload, cross-reload undo slots and dirty dots.
 *  - v1.2.2 refinement: visual-first ops — display === logical, no temps.
 *----------------------------------------------------------------------------*/

(function () {

    const api = window.lectorAPI;
    if (!api) {
        // Fail closed: without the preload bridge the app cannot safely
        // talk to the main process, so do not run with Node fallback.
        document.addEventListener('DOMContentLoaded', () => {
            const el = document.getElementById('backgroundText');
            if (el) {
                el.textContent = 'Preload bridge missing. Please reinstall the app.';
            }
        });
        return;
    }

    /**
     * @desc Main view class containing all rendering and
     *       event listening operations
     */
    class Reader {

        constructor() {
            // Array of all path names
            this._paths = [];
            // Array of all tab elements
            this._tabs = [];
            // Total number of buckets
            this._buckets = 1;
            // Current tab element
            this._currentTab = null;
            // Current bucket index
            this._currentBucket = 0;
            // Number of tabs in one bucket
            this._computeStepTabs();

            this._tabContainer = document.getElementById('tabContainer');
            this._viewerElement = document.getElementById('viewer');
            this._leftSeekElement = document.getElementById('leftSeek');
            this._rightSeekElement =
                document.getElementById('rightSeek');
            // v1.2.2: path of the file currently shown in the viewer iframe.
            this._currentPath = null;
            // v1.2.2 refinement (visual-first ops): the viewer edits in
            // place and the original bytes never change until Save, so
            // display path === logical path. No temp files, no mapping.
            // v1.2.2: logical path -> true while it has unsaved changes.
            this._dirty = {};
            // v1.2.2 refinement: cross-reload undo slots. The viewer owns a
            // 30-step stack within a session; these two slots (kept in the
            // parent, fed from the sidecar) cover tab switches: undo swaps
            // them, so it also works as redo.
            this._undoPrev = {}; // logical -> {annots, visOps} | null
            this._undoLast = {}; // logical -> {annots, visOps} | null
            // v1.2.2 refinement: reorder bakes go through temps. Tabs keep
            // showing the latest temp while representing the logical file.
            this._pathMap = {}; // temp display path -> logical original
            this._bakeHist = {}; // logical -> [{tempPath|null, annots}] (cap 5)
            this._pendingScroll = {}; // logical -> 1-based page to land on
        }

        /**
         * @desc Extracts the file name from a full path on any OS.
         *       FIX v1.2.0: old code used lastIndexOf('\\') only (Windows),
         *       which broke on Linux/macOS paths with '/'.
         */
        _baseName(pathName) {
            if (typeof pathName !== 'string') {
                return '';
            }
            return pathName.split(/[\\/]/).pop();
        }

        /**
         * @desc Computes stepTabs based on window size
         */
        _computeStepTabs() {
            this.stepTabs = Math.max(1, Math.floor(window.innerWidth / 100));
        }

        /**
         * @desc Appends tabs at bucketPosition to tabContainer
         * @param {*} bucketPosition
         */
        _appendTabsToContainer(bucketPosition) {
            this._tabContainer.innerHTML = "";
            for (let i = bucketPosition * this.stepTabs;
                i < this._tabs.length &&
                i < (bucketPosition + 1) * this.stepTabs;
                i++) {
                this._tabContainer.append(this._tabs[i]);
            }
        }

        /**
         * @desc Sets seek-button state without touching innerHTML.
         */
        _setSeekState(element, active) {
            // FIX v1.2.0: old code did `element.classList = []` which is a
            // no-op / TypeError because classList is read-only.
            element.classList.remove('active-seek', 'inactive-seek');
            element.classList.add(active ? 'active-seek' : 'inactive-seek');
        }

        /**
         * @desc Toggles seek elements based on number of buckets
         *       and current bucket
         */
        _toggleSeek() {
            if (this._buckets > 1) {
                if (this._currentBucket === 0) {
                    this._setSeekState(this._leftSeekElement, false);
                    this._setSeekState(this._rightSeekElement, true);
                } else if (this._currentBucket === this._buckets - 1) {
                    this._setSeekState(this._leftSeekElement, true);
                    this._setSeekState(this._rightSeekElement, false);
                } else {
                    this._setSeekState(this._leftSeekElement, true);
                    this._setSeekState(this._rightSeekElement, true);
                }
            } else {
                this._setSeekState(this._leftSeekElement, false);
                this._setSeekState(this._rightSeekElement, false);
            }
        }

        /**
         * @desc Recalculates number of buckets
         */
        _updateBuckets() {
            this._buckets = Math.max(1, Math.ceil(this._tabs.length / this.stepTabs));
        }

        /**
         * @desc Re-renders tabs in tabContainer
         */
        _adjustTabs() {
            this._updateBuckets();

            let currentPosition = this._tabs.indexOf(this._currentTab);
            let newBucketPosition =
                Math.floor(currentPosition / this.stepTabs);

            if (newBucketPosition !== this._currentBucket ||
                this._tabContainer.childElementCount !== this.stepTabs) {
                this._appendTabsToContainer(newBucketPosition);
                this._currentBucket = newBucketPosition;
            }

            this._toggleSeek();
        }

        /**
         * @desc Toggles background info visibility based on flag
         * @param {*} flag
         */
        _toggleBackgroundInfo(flag) {
            let visibility = flag ? 'visible' : 'hidden';
            document.getElementById('backgroundInfo').style.visibility =
                visibility;
        }

        /**
         * @desc Creates a new tab element
         * @param {*} pathName
         */
        _createTabElement(pathName) {
            const filename = this._baseName(pathName);
            const tabElement = document.createElement('div');
            const labelElement = document.createElement('div');
            const closeElement = document.createElement('div');
            let that = this;

            // FIX v1.2.0: innerHTML allowed a crafted file name such as
            // '<img src=x onerror=...>' to execute. textContent is safe.
            labelElement.textContent = filename;
            labelElement.setAttribute('class',
                'file-tab-label');
            labelElement.setAttribute('title', filename);

            closeElement.textContent = '\u00d7';
            closeElement.style.visibility = 'hidden';
            closeElement.setAttribute('class',
                'file-tab-close');

            tabElement.classList.add('file-tab');
            tabElement.classList.add('inactive');
            // setAttribute does not parse HTML, so paths with quotes/<>
            // cannot break out here.
            tabElement.setAttribute('data-path', pathName);
            tabElement.setAttribute('title', pathName);

            tabElement.append(labelElement);
            tabElement.append(closeElement);

            closeElement.addEventListener('click', async (event) => {
                event.stopPropagation();
                let positionToRemove = that._tabs.indexOf(tabElement);
                // v1.2.2: dirty guard — Save / Save As / Discard / Cancel.
                // Saving runs fully in main (sidecar + temp on disk), so it
                // works for background tabs too, with no viewer round-trip.
                const tabLogical = that._logicalOf(tabElement.getAttribute('data-path'));
                if (that._dirty[tabLogical]) {
                    let choice = 'cancel';
                    try {
                        choice = await api.invoke('confirm-dirty',
                            { name: that._baseName(tabLogical) });
                    } catch (e) {
                        // v1.2.2 refinement: FAIL OPEN — the sidecar already
                        // holds every edit, so a broken dialog must never
                        // trap the tab. Close without baking.
                        choice = 'discard';
                    }
                    if (choice === 'cancel') {
                        return;
                    }
                    if (choice === 'save' || choice === 'saveas') {
                        const r = await that._doSaveQuiet(tabLogical,
                            choice === 'save' ? 'overwrite' : 'saveas');
                        if (!r.ok && r.canceled) {
                            return; // user cancelled the save dialog: stay
                        }
                        // v1.2.2 refinement: on hard save errors still close
                        // (fail open — work survives in the sidecar).
                        if (choice === 'saveas' && r.ok) {
                            // MODIFIED file written; drop the session but keep
                            // the sidecar so reopening shows the annotations.
                            try {
                                await api.invoke('discard-changes', { pdfPath: tabLogical });
                            } catch (e) { /* ignore */ }
                        }
                        that._forgetStruct(tabLogical); // v1.2.2
                    } else { // discard
                        try {
                            await api.invoke('discard-changes', { pdfPath: tabLogical });
                        } catch (e) { /* ignore */ }
                        that._forgetStruct(tabLogical); // v1.2.2
                    }
                    delete that._dirty[tabLogical];
                }
                if (that._tabs.length === 1) {
                    // If only one tab remaining, empty everything
                    that._currentTab = null;
                    that._currentPath = null; // v1.2.1
                    that._tabContainer.innerHTML = "";
                    that._viewerElement.removeAttribute('src');
                    that._toggleMenuItems(false);
                    that._toggleBackgroundInfo(true);
                } else if (tabElement === that._currentTab) {
                    // If current tab is to be removed
                    let newCurrentPosition = positionToRemove;
                    // If tab to be removed is first in array,
                    // make next tab as current
                    if (positionToRemove === 0) {
                        newCurrentPosition = 1;
                    } else { // Else, make previous tab as current
                        newCurrentPosition -= 1;
                    }
                    // Switch to new current tab
                    that._switchTab(that._tabs[newCurrentPosition]);
                }
                // Remove tab from paths and tabs and update buckets
                that._paths.splice(positionToRemove, 1);
                that._tabs.splice(positionToRemove, 1);
                that._updateBuckets();

                // If atleast one tab remaining
                if (that._tabs.length > 0) {
                    // If this bucket has no tabs, render current bucket
                    if (that._tabContainer.childElementCount === 1) {
                        that._adjustTabs();
                    } else {
                        // Else, re-render this bucket without switching to
                        // current bucket
                        that._appendTabsToContainer(that._currentBucket);
                    }
                } else { // If no tabs remaining
                    that._toggleTabContainer(false);
                    that._updateTitle();
                }
                that._toggleSeek();
                event.stopPropagation();

            });

            tabElement.addEventListener('mouseover', event => {
                if (tabElement !== that._currentTab) {
                    closeElement.style.visibility = 'visible';
                }
            });

            tabElement.addEventListener('mouseleave', event => {
                if (tabElement !== that._currentTab) {
                    closeElement.style.visibility = 'hidden';
                }
            });

            tabElement.addEventListener('click', event => {
                if (tabElement !== that._currentTab) {
                    that._switchTab(tabElement);
                }
            });

            return tabElement;
        }

        /**
         * @desc Dispatches click event to window
         */
        _propagateClick() {
            window.dispatchEvent(new Event('mousedown'));
        }

        /**
         * @desc Returns the viewer document or null (never throws).
         *       FIX v1.2.0: old code accessed contentDocument directly and
         *       crashed when the iframe was empty or not same-origin yet.
         */
        _viewerDoc() {
            try {
                const doc = this._viewerElement.contentDocument;
                return doc || null;
            } catch (e) {
                return null;
            }
        }

        /**
         * @desc Propagates iframe events to window
         */
        _setViewerEvents() {
            const doc = this._viewerDoc();
            if (!doc) {
                return;
            }
            try {
                doc.addEventListener('click', this._propagateClick);
                doc.addEventListener('mousedown', this._propagateClick);
            } catch (e) {
                // Viewer not ready yet; onload will retry.
            }
        }

        /**
         * @desc Opens pathName in iframe
         * @param {*} pathName
         */
        _openInViewer(pathName) {
            this._viewerElement.src = 'lib/pdfjs/web/viewer.html?file=' +
                encodeURIComponent(pathName);
            this._viewerElement.onload = this._setViewerEvents.bind(this);
        }

        /**
         * @desc Focuses the current tab and opens current file in iframe
         */
        _focusCurrentTab() {
            this._tabs.forEach(tabElement => {
                tabElement.classList.remove('active');
                tabElement.classList.add('inactive');
                tabElement.getElementsByClassName('file-tab-close')[0]
                    .style.visibility = 'hidden';
            });
            this._currentTab.classList.remove('inactive');
            this._currentTab.classList.add('active');
            this._currentTab.getElementsByClassName('file-tab-close')[0]
                .style.visibility = 'visible';
            this._openInViewer(
                this._paths[this._tabs.indexOf(this._currentTab)]);
        }

        /**
         * @desc Switches to tabElement
         * @param {*} tabElement
         */
        _switchTab(tabElement) {
            if (this._currentTab !== tabElement) {
                this._currentTab = tabElement;
                this._currentPath = this._paths[this._tabs.indexOf(tabElement)]; // v1.2.1
                this._updateTitle(this._paths[this._tabs.indexOf(tabElement)]);
                this._adjustTabs();
                this._focusCurrentTab();
            }
        }

        /**
         * @desc Toggles tab container visibililty
         * @param {*} visible
         */
        _toggleTabContainer(visible) {
            const visibility = visible ? 'visible' : 'hidden';
            this._tabContainer.style.visibility = visibility;
            this._leftSeekElement.style.visibility = visibility;
            this._rightSeekElement.style.visibility = visibility;
        }

        /**
         * @desc Sends enable/disable flag for toggle-menu-items
         * @param {*} flag
         */
        _toggleMenuItems(flag) {
            api.send('toggle-menu-items', flag === true);
        }

        /**
         * @desc Validates a candidate file path (PDF only, any case).
         */
        _isPdfPath(pathName) {
            return typeof pathName === 'string' &&
                pathName.toLowerCase().endsWith('.pdf');
        }

        /**
         * @desc Adds a new tab
         * @param {*} pathName
         */
        _addTab(pathName) {
            // Enable visibility of tabContainer, etc. when the
            // first tab is added
            if (this._tabs.length === 0) {
                this._toggleTabContainer(true);
                this._toggleMenuItems(true);
                this._toggleBackgroundInfo(false);
            }

            // Switch to tab if already open. v1.2.2 refinement: compare by
            // LOGICAL file, so a baked temp never opens a divergent second
            // tab over the same document (two live views would fork edits).
            const wantLogical = this._logicalOf(pathName);
            const existingIx = this._tabs.findIndex(
                (t) => this._logicalOf(t.getAttribute('data-path')) === wantLogical);
            if (existingIx >= 0) {
                this._switchTab(this._tabs[existingIx]);
                return;
            }

            const tabElement = this._createTabElement(pathName);

            this._currentTab = tabElement;
            this._tabs.push(tabElement);
            this._paths.push(pathName);
            this._tabContainer.append(tabElement);
            this._adjustTabs();
            this._focusCurrentTab();
        }

        /**
         * @desc Updates title (native frame). v1.2.0: custom titlebar removed.
         * @param {*} pathName
         */
        _updateTitle(pathName) {
            if (pathName) {
                const logical = this._logicalOf(pathName);
                const dot = logical && this._dirty[logical] ? '• ' : '';
                document.title = dot + this._baseName(logical) + " - Lector";
            } else {
                document.title = "Lector";
            }
        }

        /**
         * @desc Opens a file
         * @param {*} pathName
         */
        _openFile(pathName) {
            // FIX v1.2.0: ignore non-PDF / empty values instead of
            // pushing them into tabs and the viewer URL.
            if (!this._isPdfPath(pathName)) {
                return;
            }
            this._currentPath = pathName; // v1.2.1
            api.send('recent-add', pathName); // v1.2.2: recent list + last dir
            this._updateTitle(pathName);
            this._addTab(pathName);
        }

        /**
         * @desc Sets menu item events
         *       'click' needs to be propagated (custom-electron-titlebar issue)
         */
        _setMenuItemEvents() {
            api.on('file-open', (args) => {
                this._propagateClick();
                // Main process now sends a single string; accept a
                // one-element array too for backward compatibility.
                const pathName = Array.isArray(args) ? args[0] : args;
                this._openFile(pathName);
            });

            api.on('file-print', () => {
                this._propagateClick();
                const doc = this._viewerDoc();
                if (this._viewerElement.src && doc) {
                    doc.getElementById('print').dispatchEvent(
                        new Event('click'));
                }
            });

            api.on('file-properties', () => {
                this._propagateClick();
                const doc = this._viewerDoc();
                if (this._viewerElement.src && doc) {
                    doc.getElementById('documentProperties')
                        .dispatchEvent(new Event('click'));
                }
            });

            api.on('file-close', () => {
                this._propagateClick();
                if (this._currentTab) {
                    this._currentTab.getElementsByClassName('file-tab-close')[0]
                        .dispatchEvent(new Event('click'));
                }
            });

            // v1.2.2: smart save. Overwrite keeps a .bak.pdf backup;
            // Save As defaults to `<base>-MODIFIED.pdf` next to the original.
            api.on('file-save', () => {
                this._propagateClick();
                if (this._currentPath) {
                    this._doSave(this._logicalOf(this._currentPath), 'overwrite');
                }
            });

            // v1.2.2 refinement: Edit-menu undo forwards into the viewer,
            // which runs the three tiers (session stack -> baked history ->
            // cross-reload slots). The menu itself never touches state.
            api.on('undo-struct', () => {
                this._propagateClick();
                this._askViewer({ ns: 'lector-annot', kind: 'menu-undo' });
            });

            api.on('file-save-as', () => {
                this._propagateClick();
                if (this._currentPath) {
                    this._doSave(this._logicalOf(this._currentPath), 'saveas');
                }
            });

            // v1.2.1 legacy channel (kept): behaves like Save As.
            api.on('file-save-annotated', () => {
                this._propagateClick();
                if (this._currentPath) {
                    this._doSave(this._logicalOf(this._currentPath), 'saveas');
                }
            });

            api.on('view-fullscreen', () => {
                this._propagateClick();
                const doc = this._viewerDoc();
                if (this._viewerElement.src && doc) {
                    doc.getElementById('presentationMode')
                        .dispatchEvent(new Event('click'));
                }
            });
        }

        /**
         * @desc v1.2.2 refinement: identity now (visual-first ops keep the
         *       original bytes until Save, so display === logical).
         */
        _logicalOf(displayPath) {
            if (typeof displayPath !== 'string') {
                return displayPath;
            }
            return this._pathMap[displayPath] || displayPath;
        }

        /**
         * @desc v1.2.2: paint/clear the unsaved-changes dot on every tab and
         *       the window title for the current file.
         */
        _setTabDot(logical, dirty) {
            if (!logical) {
                return;
            }
            if (dirty) {
                this._dirty[logical] = true;
            } else {
                delete this._dirty[logical];
            }
            const base = this._baseName(logical);
            this._tabs.forEach((t) => {
                if (this._logicalOf(t.getAttribute('data-path')) === logical) {
                    const label = t.getElementsByClassName('file-tab-label')[0];
                    if (label) {
                        label.textContent = (dirty ? '• ' : '') + base;
                    }
                }
            });
            if (this._currentPath && this._logicalOf(this._currentPath) === logical) {
                document.title = (dirty ? '• ' : '') + base + ' - Lector';
            }
        }

        /**
         * @desc Relays messages between the sandboxed viewer iframe (which
         *       owns the annotation layer) and the main process (which owns
         *       the filesystem). v1.2.1 by KinanDev.
         */
        _askViewer(msg) {
            try {
                const target = this._viewerElement.contentWindow;
                if (target && this._viewerElement.src) {
                    target.postMessage(msg, '*');
                }
            } catch (e) { /* viewer not ready */ }
        }

        _setAnnotBridge() {
            window.addEventListener('message', (event) => {
                // Accept only messages coming from our own viewer iframe.
                if (event.source !== this._viewerElement.contentWindow) {
                    return;
                }
                const m = event.data || {};
                if (!m || m.ns !== 'lector-annot') {
                    return;
                }
                const displayFile = (typeof m.file === 'string' && m.file)
                    ? m.file : this._currentPath;
                const logical = (typeof m.logical === 'string' && m.logical)
                    ? m.logical : this._logicalOf(displayFile);
                if (!logical) {
                    return;
                }
                // v1.2.2 refinement: drop persistence writes from STALE
                // viewer contexts (replaced temps). A dying iframe posting
                // old indices AFTER a bake would otherwise clobber the
                // freshly baked sidecar (the "save reverts" bug). Live =
                // current viewer or any open tab; 'ready' always passes.
                const liveDisplay = !!displayFile && (displayFile === this._currentPath ||
                    this._paths.indexOf(displayFile) >= 0);
                if ((m.kind === 'changed' || m.kind === 'struct-changed') && !liveDisplay) {
                    return;
                }
                if (m.kind === 'ready') {
                    api.invoke('annot-load', { pdfPath: logical }).then((res) => {
                        this._askViewer({
                            ns: 'lector-annot', kind: 'load',
                            file: displayFile, logical,
                            annots: (res && res.annots) || {},
                            visOps: (res && res.visOps) || null,
                            // v1.2.2 refinement: undo if baked-reorder
                            // history OR annot slots exist.
                            canUndo: !!(((this._bakeHist[logical] || []).length) ||
                                this._undoPrev[logical])
                        });
                        // v1.2.2 refinement: land on the moved page after a
                        // baked reload (goto-position jumps).
                        if (this._pendingScroll[logical]) {
                            this._askViewer({
                                ns: 'lector-annot', kind: 'scroll-to',
                                file: displayFile, page: this._pendingScroll[logical]
                            });
                            delete this._pendingScroll[logical];
                        }
                    }).catch(() => { /* stay annotation-free */ });
                } else if (m.kind === 'changed') {
                    api.invoke('annot-save', {
                        pdfPath: logical,
                        annots: m.annots || {},
                        visOps: m.visOps || null
                    }).catch(() => { /* non-fatal */ });
                    // Dot itself arrives via 'dirty-changed' from main.
                } else if (m.kind === 'struct-changed') {
                    // v1.2.2 refinement: rotate the cross-reload undo slots
                    // (fed from the sidecar — single source of truth).
                    api.invoke('get-sidecar', { pdfPath: logical }).then((res) => {
                        if (res && res.ok) {
                            this._undoPrev[logical] = this._undoLast[logical] || null;
                            this._undoLast[logical] = {
                                annots: res.annots || {}, visOps: res.visOps || null
                            };
                        }
                    }).catch(() => { /* non-fatal */ });
                } else if (m.kind === 'export-data') {
                    // v1.2.2: viewer 💾 button → Save As (original untouched).
                    this._doSave(logical, 'saveas');
                } else if (m.kind === 'stamp-request') {
                    // v1.2.2: image stamp upload via main file picker.
                    // Every outcome notifies the viewer (silent failure was
                    // reported as "nothing happens").
                    api.invoke('pick-image').then((res) => {
                        if (res && res.ok) {
                            this._askViewer({
                                ns: 'lector-annot', kind: 'stamp-image',
                                file: displayFile, png: res.dataUrl
                            });
                        } else if (res && res.error) {
                            this._askViewer({
                                ns: 'lector-annot', kind: 'notify',
                                file: displayFile, text: 'Could not open the image: ' + res.error
                            });
                        } else {
                            this._askViewer({
                                ns: 'lector-annot', kind: 'notify',
                                file: displayFile, text: 'Image selection cancelled'
                            });
                        }
                    }).catch((err) => {
                        this._askViewer({
                            ns: 'lector-annot', kind: 'notify',
                            file: displayFile,
                            text: 'Could not open the image dialog: ' + String((err && err.message) || err)
                        });
                    });
                } else if (m.kind === 'reorder-bake') {
                    // v1.2.2 refinement: REORDER bakes explicitly (DOM
                    // reordering fights this PDF.js version's index-based
                    // rendering/tracking). Rotation/deletion stay visual.
                    // Remember where to land after the reload (goto jumps).
                    if (m.scrollTo !== null && m.scrollTo !== undefined) {
                        const at = (m.order || []).map((x) => parseInt(x, 10))
                            .indexOf(parseInt(m.scrollTo, 10));
                        if (at >= 0) {
                            this._pendingScroll[logical] = at + 1;
                        }
                    }
                    this._bakeReorder(logical, displayFile, {
                        order: m.order || [], deleted: m.deleted || [],
                        rotations: m.rotations || {}, annots: m.annots || {}
                    });
                } else if (m.kind === 'structure-undo') {
                    this._undoBake(logical, displayFile);
                } else if (m.kind === 'undo-prev-request') {
                    // v1.2.2 refinement: third undo tier — cross-reload
                    // slots (swap = a second call redoes).
                    if (!this._undoPrev[logical]) {
                        this._askViewer({
                            ns: 'lector-annot', kind: 'notify',
                            file: displayFile, text: 'Nothing to undo'
                        });
                    } else {
                        const snap = this._undoPrev[logical];
                        this._undoPrev[logical] = this._undoLast[logical] || null;
                        this._undoLast[logical] = snap;
                        api.invoke('annot-save', {
                            pdfPath: logical, annots: snap.annots || {}, visOps: snap.visOps || null
                        }).catch(() => { /* non-fatal */ });
                        this._askViewer({
                            ns: 'lector-annot', kind: 'load',
                            file: displayFile, logical,
                            annots: snap.annots || {}, visOps: snap.visOps || null,
                            canUndo: !!this._undoPrev[logical]
                        });
                    }
                }
            });
            // v1.2.2: single source of truth for dirty dots (main process).
            api.on('dirty-changed', ({ path, dirty }) => {
                this._setTabDot(path, dirty === true);
            });
            // NOTE: 'undo-struct' (Edit menu) is registered once in
            // _setMenuItemEvents above — do NOT duplicate it here (a double
            // registration would swap the slots twice and cancel the undo).
        }

        /**
         * @desc v1.2.2 refinement: forget cross-reload undo slots
         *       (after overwrite-save or tab close — bytes are final).
         */
        _forgetStruct(logical) {
            delete this._undoPrev[logical];
            delete this._undoLast[logical];
            delete this._bakeHist[logical];
            delete this._pendingScroll[logical];
            delete this._pendingScroll[logical];
            Object.keys(this._pathMap).forEach((k) => {
                if (this._pathMap[k] === logical) { delete this._pathMap[k]; }
            });
        }

        /**
         * @desc v1.2.2 refinement: bake a reorder into a temp + reload.
         * Snapshots the sidecar first so undo restores everything.
         */
        _bakeReorder(logical, displayFile, delta) {
            api.invoke('get-sidecar', { pdfPath: logical }).then((res) => {
                if (!this._bakeHist[logical]) {
                    this._bakeHist[logical] = [];
                }
                this._bakeHist[logical].push({
                    tempPath: (displayFile !== logical &&
                        this._pathMap[displayFile] === logical) ? displayFile : null,
                    annots: (res && res.ok) ? (res.annots || {}) : {}
                });
                if (this._bakeHist[logical].length > 5) {
                    this._bakeHist[logical].shift();
                }
                return api.invoke('structure-bake', {
                    originalPath: logical,
                    order: delta.order || [], deleted: delta.deleted || [],
                    rotations: delta.rotations || {}, annots: delta.annots || {}
                });
            }).then((res) => {
                if (res && res.ok && res.tempPath) {
                    this._adoptTemp(displayFile, logical, res.tempPath);
                } else {
                    delete this._pendingScroll[logical]; // v1.2.2: no landing without a bake
                    this._askViewer({
                        ns: 'lector-annot', kind: 'export-result',
                        file: displayFile, ok: false,
                        error: (res && res.error) || 'Reorder failed'
                    });
                }
            }).catch((err) => {
                delete this._pendingScroll[logical]; // v1.2.2
                this._askViewer({
                    ns: 'lector-annot', kind: 'export-result',
                    file: displayFile, ok: false,
                    error: String((err && err.message) || err)
                });
            });
        }

        /**
         * @desc v1.2.2 refinement: undo a baked reorder — back to the
         * previous temp (or the original bytes) + sidecar snapshot.
         */
        _undoBake(logical, displayFile) {
            const hist = this._bakeHist[logical] || [];
            const entry = hist.pop();
            if (!entry) {
                this._askViewer({
                    ns: 'lector-annot', kind: 'notify',
                    file: displayFile, text: 'Nothing to undo'
                });
                return;
            }
            api.invoke('annot-save', {
                pdfPath: logical, annots: entry.annots || {}, visOps: null
            }).catch(() => { /* non-fatal */ }).then(() => {
                if (!entry.tempPath) {
                    this._adoptOriginal(logical);
                    return { ok: true };
                }
                return api.invoke('use-temp', {
                    originalPath: logical, tempPath: entry.tempPath,
                    annots: entry.annots || {}
                });
            }).then((res) => {
                if (res && res.ok) {
                    if (entry.tempPath) {
                        this._adoptTemp(displayFile, logical, entry.tempPath);
                    }
                } else {
                    this._askViewer({
                        ns: 'lector-annot', kind: 'notify',
                        file: displayFile,
                        text: 'Undo failed: ' + ((res && res.error) || 'unknown')
                    });
                }
            }).catch(() => { /* keep current view on failure */ });
        }

        /**
         * @desc v1.2.2 refinement: point every tab showing this logical
         * file at a temp. Matched by LOGICAL (race-proof: stale contexts
         * never corrupt the mapping).
         */
        _adoptTemp(oldDisplay, logical, tempPath) {
            this._pathMap[tempPath] = logical;
            for (let j = 0; j < this._paths.length; j++) {
                const p = this._paths[j];
                if (p === oldDisplay || this._pathMap[p] === logical) {
                    this._paths[j] = tempPath;
                }
            }
            this._tabs.forEach((t) => {
                const dp = t.getAttribute('data-path');
                if (dp === oldDisplay || this._pathMap[dp] === logical) {
                    // stale map entries for older temps are harmless.
                    t.setAttribute('data-path', tempPath);
                    t.setAttribute('title', tempPath);
                }
            });
            if (this._currentPath === oldDisplay ||
                this._pathMap[this._currentPath] === logical) {
                this._currentPath = tempPath;
            }
            this._openInViewer(tempPath);
        }

        /**
         * @desc v1.2.2 refinement: point tabs back at the original bytes
         * (undo of the very first bake).
         */
        _adoptOriginal(logical) {
            for (let j = 0; j < this._paths.length; j++) {
                const p = this._paths[j];
                if (p === logical || this._pathMap[p] === logical) {
                    this._paths[j] = logical;
                }
            }
            this._tabs.forEach((t) => {
                const dp = t.getAttribute('data-path');
                if (dp === logical || this._pathMap[dp] === logical) {
                    t.setAttribute('data-path', logical);
                    t.setAttribute('title', logical);
                }
            });
            Object.keys(this._pathMap).forEach((k) => {
                if (this._pathMap[k] === logical) { delete this._pathMap[k]; }
            });
            if (this._logicalOf(this._currentPath) === logical) {
                this._currentPath = logical;
            }
            this._openInViewer(logical);
        }

        /**
         * @desc v1.2.2: Save (overwrite + .bak backup) or Save As
         *       (default `<base>-MODIFIED.pdf` next to the original).
         *       Visual ops are baked ONCE here — no reloads anywhere else.
         */
        _doSave(logical, mode) {
            return api.invoke('save-pdf', { pdfPath: logical, mode }).then((res) => {
                if (res && res.ok) {
                    if (mode === 'overwrite' && res.cleared) {
                        this._forgetStruct(logical); // v1.2.2: bytes are final
                        // Ask the viewer for a pristine state (identity ops,
                        // empty overlay) without reloading the document.
                        this._askViewer({
                            ns: 'lector-annot', kind: 'load',
                            file: this._currentPath, logical,
                            annots: {}, visOps: null, canUndo: false
                        });
                    }
                    this._askViewer({
                        ns: 'lector-annot', kind: 'export-result',
                        file: this._currentPath, ok: true, path: res.path || ''
                    });
                } else if (res && !res.canceled) {
                    this._askViewer({
                        ns: 'lector-annot', kind: 'export-result',
                        file: this._currentPath, ok: false, error: res.error || ''
                    });
                }
                return res || { ok: false };
            }).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
        }

        /**
         * @desc v1.2.2: quiet save for tab-close flows (no viewer refresh —
         *       the tab is going away or shows another file).
         */
        _doSaveQuiet(logical, mode) {
            return api.invoke('save-pdf', { pdfPath: logical, mode }).then((res) => {
                if (res && res.ok && mode === 'overwrite' && res.cleared) {
                    this._forgetStruct(logical); // v1.2.2
                }
                return res || { ok: false };
            }).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
        }

        /**
         * @desc Sets seek element events
         */
        _setSeekEvents() {
            let that = this;
            this._leftSeekElement.addEventListener('click', event => {
                if (that._currentBucket > 0) {
                    that._currentBucket--;
                    that._appendTabsToContainer(that._currentBucket);
                    that._toggleSeek();
                }
            });

            this._rightSeekElement.addEventListener('click',
                event => {
                    if (that._currentBucket < that._buckets - 1) {
                        that._currentBucket++;
                        that._appendTabsToContainer(that._currentBucket);
                        that._toggleSeek();
                    }
                });

        }

        /**
         * @desc Sets window events
         */
        _setWindowEvents() {
            let that = this;
            // Adjust tabs on resize
            window.addEventListener('resize', event => {
                that._computeStepTabs();
                if (that._tabs.length > 0) {
                    that._adjustTabs();
                }
            });
        }

        /**
         * @desc Extracts path name from the arguments and opens the file.
         *       FIX v1.2.0: case-insensitive .pdf, trims quotes, accepts
         *       argv arrays of any shape (Electron / packaged / dev).
         * @param {*} args
         */
        _processArguments(args) {
            if (!args) {
                return;
            }
            const list = Array.isArray(args) ? args : [args];
            if (list.length > 1) {
                let candidate = list[list.length - 1];
                if (typeof candidate === 'string') {
                    candidate = candidate.trim().replace(/^["']|["']$/g, '');
                    if (candidate.toLowerCase().endsWith('.pdf')) {
                        this._openFile(candidate);
                    }
                }
            }
        }

        /**
         * @desc Sets external application events
         */
        _setExternalEvents() {
            let that = this;
            api.on('external-file-open', (args) => {
                that._processArguments(args);
            });
        }

        /**
         * @desc Runs the application
         */
        run() {
            this._setMenuItemEvents();
            this._setSeekEvents();
            this._setWindowEvents();
            this._setExternalEvents();
            this._setAnnotBridge(); // v1.2.1
            // v1.2.2 refinement: NO beforeunload handler here on purpose.
            // The main process owns the dirty prompts; a renderer-side
            // handler would stack Chrome's own dialog on top and trap quit.
        }

    }

    const application = new Reader();
    application.run();

})();
