"use strict";
/*------------------------------------------------------------------------------
 *  v1.2.2 file by KinanDev (new file, MIT License, same as project).
 *  Real page-structure operations (delete / reorder / rotate) on PDF bytes
 *  using pdf-lib. Runs in the MAIN process. Pure function of bytes + ops,
 *  so it is unit-testable with plain node.
 *
 *  ops: { order: [origIndex...] (new left-to-right order),
 *         deleted: [origIndex...],
 *         rotations: { origIndex: 0|90|180|270 } }  (clockwise, additive)
 *  Deleted pages win over order/rotations. Rotations are absolute-set on
 *  the copied page (original /Rotate + requested, mod 360).
 *----------------------------------------------------------------------------*/

const { PDFDocument, degrees } = require('pdf-lib');

function toInt(v) {
    const n = parseInt(v, 10);
    return Number.isInteger(n) ? n : -1;
}

function normalizeRot(v) {
    const n = toInt(v);
    if (n < 0) { return 0; }
    return ((n % 360) + 360) % 360;
}

/**
 * @param {Uint8Array|Buffer} originalBytes source PDF bytes (never mutated).
 * @param {object} ops as described above.
 * @returns {Promise<Uint8Array>} new PDF bytes with ops applied.
 */
async function applyStructure(originalBytes, ops) {
    const src = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
    const count = src.getPageCount();
    // Accept deleted as array OR {index:true} map (viewer sidecar shape).
    const delRaw = (ops && ops.deleted) || [];
    const delList = Array.isArray(delRaw) ? delRaw : Object.keys(delRaw);
    const deleted = new Set(
        delList.map(toInt).filter((n) => n >= 0 && n < count)
    );
    let order = ((ops && ops.order) || []).map(toInt)
        .filter((n) => n >= 0 && n < count && !deleted.has(n));
    // Fall back to natural order for pages missing from `order`.
    const seen = new Set(order);
    for (let i = 0; i < count; i++) {
        if (!deleted.has(i) && !seen.has(i)) {
            order.push(i);
            seen.add(i);
        }
    }
    if (order.length === 0) {
        throw new Error('Cannot delete all pages.');
    }
    const rotations = (ops && ops.rotations) || {};

    const out = await PDFDocument.create();
    for (const origIdx of order) {
        const copied = (await out.copyPages(src, [origIdx]))[0];
        const srcPage = src.getPage(origIdx);
        let base = 0;
        try { base = normalizeRot(srcPage.getRotation().angle); } catch (e) { base = 0; }
        const total = (base + normalizeRot(rotations[origIdx])) % 360;
        if (total !== 0) {
            copied.setRotation(degrees(total));
        }
        out.addPage(copied);
    }
    return out.save();
}

module.exports = { applyStructure };
