"use strict";
/*------------------------------------------------------------------------------
 *  v1.2.1 file by KinanDev (new file, MIT License, same as project).
 *  Burns Lector annotations into a PDF using pdf-lib (MIT).
 *  Runs in the MAIN process only. All numbers are clamped/validated so a
 *  malformed renderer message can never crash the app or bloat the file.
 *  Coordinate system: PDF points, origin at bottom-left of the page
 *  (same as PDF.js viewport.convertToPdfPoint output).
 *----------------------------------------------------------------------------*/

const { PDFDocument, rgb } = require('pdf-lib');

const MAX_ANNOTS_PER_PAGE = 500;
const MAX_PAGES = 5000;
const MAX_PNG_BYTES = 2 * 1024 * 1024; // 2 MB per text stamp
const MAX_IMG_BYTES = 5 * 1024 * 1024; // v1.2.2: 5 MB per photo stamp

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function clampColor(c) {
    if (!Array.isArray(c) || c.length !== 3) {
        return [1, 0.8, 0];
    }
    return c.map((v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) {
            return 0;
        }
        return Math.min(1, Math.max(0, n));
    });
}

function toRgb(c) {
    const v = clampColor(c);
    return rgb(v[0], v[1], v[2]);
}

function clampWidth(w, fallback) {
    const n = num(w, fallback);
    return Math.min(24, Math.max(0.5, n));
}

function buildInkPath(points) {
    // points: [[x,y], ...] in PDF space. Returns an SVG path string.
    const pts = (Array.isArray(points) ? points : [])
        .slice(0, 2000)
        .map((p) => [num(p && p[0], NaN), num(p && p[1], NaN)])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 2) {
        return null;
    }
    let d = 'M ' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
    for (let i = 1; i < pts.length; i++) {
        d += ' L ' + pts[i][0].toFixed(2) + ' ' + pts[i][1].toFixed(2);
    }
    return d;
}

function pngBytesFromDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') {
        return null;
    }
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m || m[1].length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 64) {
        return null;
    }
    try {
        const buf = Buffer.from(m[1], 'base64');
        if (buf.length === 0 || buf.length > MAX_PNG_BYTES) {
            return null;
        }
        return buf;
    } catch (e) {
        return null;
    }
}

// v1.2.2: photo/icon stamps accept PNG or JPEG dataURLs.
function imageBytesFromDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') {
        return null;
    }
    const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m || m[2].length > Math.ceil((MAX_IMG_BYTES * 4) / 3) + 64) {
        return null;
    }
    try {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length === 0 || buf.length > MAX_IMG_BYTES) {
            return null;
        }
        return { bytes: buf, format: m[1] === 'png' ? 'png' : 'jpg' };
    } catch (e) {
        return null;
    }
}

/**
 * @param {Uint8Array|Buffer} originalBytes bytes of the source PDF.
 * @param {object} exportData { pages: { [index]: annot[] } }
 * @returns {Promise<Uint8Array>} the new PDF bytes.
 */
async function burnAnnotations(originalBytes, exportData) {
    const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
    const pages = (exportData && exportData.pages) || {};
    const indices = Object.keys(pages).slice(0, MAX_PAGES);

    for (const key of indices) {
        const pageIndex = parseInt(key, 10);
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.getPageCount()) {
            continue;
        }
        const list = Array.isArray(pages[key]) ? pages[key].slice(0, MAX_ANNOTS_PER_PAGE) : [];
        if (list.length === 0) {
            continue;
        }
        const page = doc.getPage(pageIndex);

        for (const a of list) {
            if (!a || typeof a.kind !== 'string') {
                continue;
            }
            try {
                if (a.kind === 'highlight') {
                    page.drawRectangle({
                        x: num(a.x, 0),
                        y: num(a.y, 0),
                        width: Math.max(0, num(a.w, 0)),
                        height: Math.max(0, num(a.h, 0)),
                        color: toRgb(a.color),
                        opacity: 0.4,
                        borderWidth: 0
                    });
                } else if (a.kind === 'rect') {
                    const color = toRgb(a.color);
                    const opts = {
                        x: num(a.x, 0),
                        y: num(a.y, 0),
                        width: Math.max(0, num(a.w, 0)),
                        height: Math.max(0, num(a.h, 0)),
                        borderColor: color,
                        borderWidth: clampWidth(a.width, 2)
                    };
                    if (a.fill === true) {
                        opts.color = color;
                        opts.opacity = 0.15;
                    }
                    page.drawRectangle(opts);
                } else if (a.kind === 'redact') {
                    // Visual cover only (opaque box). NOT cryptographic
                    // redaction: underlying text stays in the file.
                    page.drawRectangle({
                        x: num(a.x, 0),
                        y: num(a.y, 0),
                        width: Math.max(0, num(a.w, 0)),
                        height: Math.max(0, num(a.h, 0)),
                        color: toRgb(a.color || [0, 0, 0]),
                        opacity: 1,
                        borderWidth: 0
                    });
                } else if (a.kind === 'ink') {
                    const d = buildInkPath(a.points);
                    if (d) {
                        page.drawSvgPath(d, {
                            borderColor: toRgb(a.color),
                            borderWidth: clampWidth(a.width, 2),
                            opacity: 0.95
                        });
                    }
                } else if (a.kind === 'text') {
                    // Text is burned as a PNG stamp rendered by the browser
                    // canvas (perfect shaping for Arabic and all scripts,
                    // zero font files shipped with the app).
                    const bytes = pngBytesFromDataUrl(a.png);
                    const w = num(a.w, 0);
                    const h = num(a.h, 0);
                    if (bytes && w > 0 && h > 0 && w < 5000 && h < 5000) {
                        const img = await doc.embedPng(bytes);
                        page.drawImage(img, {
                            x: num(a.x, 0),
                            y: num(a.y, 0),
                            width: w,
                            height: h
                        });
                    }
                } else if (a.kind === 'image') {
                    // v1.2.2: photo / icon stamps (PNG or JPEG dataURL).
                    const found = imageBytesFromDataUrl(a.png);
                    const w = num(a.w, 0);
                    const h = num(a.h, 0);
                    if (found && w > 0 && h > 0 && w < 5000 && h < 5000) {
                        const img = found.format === 'jpg'
                            ? await doc.embedJpg(found.bytes)
                            : await doc.embedPng(found.bytes);
                        page.drawImage(img, {
                            x: num(a.x, 0),
                            y: num(a.y, 0),
                            width: w,
                            height: h,
                            opacity: 1
                        });
                    }
                }
            } catch (e) {
                // Skip one bad annotation, never fail the whole export.
                continue;
            }
        }
    }

    return doc.save();
}

module.exports = { burnAnnotations };
