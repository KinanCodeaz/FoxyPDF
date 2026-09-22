"use strict";
/*------------------------------------------------------------------------------
 *  FoxyPDF — single source of truth for theme/accent metadata (no deps).
 *  Loaded as a plain <script> in the renderer (sets window.FOXY_THEME_LIST)
 *  AND required from the main process (module.exports). This kills the five
 *  copy-pasted theme lists that used to live in theme.js, index.js (x2),
 *  main.js and menutemplate.js — add a theme here once, it appears everywhere.
 *----------------------------------------------------------------------------*/

var FOXY_THEME_LIST = {
    THEMES: ["dark", "light", "black", "98se", "blood", "greed", "cyanotic",
        "ectoplasm", "decay", "malaise", "sepulchre", "delirium", "mourning"],
    NAMES: {
        dark: "Dark", light: "Light", black: "Black", "98se": "98SE",
        blood: "Blood", greed: "Greed", cyanotic: "Cyanotic",
        ectoplasm: "Ectoplasm", decay: "Decay", malaise: "Malaise",
        sepulchre: "Sepulchre", delirium: "Delirium", mourning: "Mourning"
    },
    DOTS: {
        dark: "#1ea54c", light: "#1b5e20", black: "#00ff66", "98se": "#004f00",
        blood: "#e8485a", greed: "#3fbf6f", cyanotic: "#3aa0d8",
        ectoplasm: "#bd00c6", decay: "#b8aa7c", malaise: "#ff6f91",
        sepulchre: "#4faaa8", delirium: "#dd8500", mourning: "#ff6f91"
    },
    // Only the Dark family honors accent variants; others ignore them.
    DARK_FAMILY: ["dark", "light", "black", "98se"],
    ACCENTS: ["green", "blue", "teal", "red", "orange", "purple"],
    ACCENT_NAMES: {
        green: "Green", blue: "Blue", teal: "Teal",
        red: "Red", orange: "Orange", purple: "Purple"
    },
    ACCENT_COLORS: {
        green: "#1ea54c", blue: "#50AEE8", teal: "#1FB8A8",
        red: "#DD504B", orange: "#E8962C", purple: "#B982E3"
    }
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = FOXY_THEME_LIST;
}
if (typeof window !== "undefined") {
    window.FOXY_THEME_LIST = FOXY_THEME_LIST;
}
