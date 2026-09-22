"use strict";
/*------------------------------------------------------------------------------
 *  FoxyPDF v1.3.0 — theme manager (lazy, <2KB).
 *  Applies [data-theme] + [data-accent] on <html>, persists in localStorage
 *  + userData (via main), syncs to viewer iframe. No polling, no deps.
 *----------------------------------------------------------------------------*/
const LIST = window.FOXY_THEME_LIST || {
    THEMES: ["dark"], NAMES: { dark: "Dark" }, DOTS: {},
    DARK_FAMILY: ["dark"], ACCENTS: ["green"],
    ACCENT_NAMES: {}, ACCENT_COLORS: {}
};
const THEMES = LIST.THEMES;
const ACCENTS = LIST.ACCENTS;
const DEFAULT_THEME = "dark";
const DEFAULT_ACCENT = "green";
const STORAGE_KEY = "foxypdf-theme";
const STORAGE_ACCENT = "foxypdf-accent";

function validTheme(t) { return THEMES.includes(t) ? t : DEFAULT_THEME; }
function validAccent(a) { return ACCENTS.includes(a) ? a : DEFAULT_ACCENT; }

function getStored() {
    try {
        const t = localStorage.getItem(STORAGE_KEY);
        const a = localStorage.getItem(STORAGE_ACCENT);
        return { theme: validTheme(t || DEFAULT_THEME), accent: validAccent(a || DEFAULT_ACCENT) };
    } catch (e) { return { theme: DEFAULT_THEME, accent: DEFAULT_ACCENT }; }
}

function persist(theme, accent) {
    try {
        localStorage.setItem(STORAGE_KEY, theme);
        localStorage.setItem(STORAGE_ACCENT, accent);
    } catch (e) { /* ignore */ }
    // also tell main for userData backup (best-effort)
    try {
        if (window.lectorAPI && window.lectorAPI.invoke) {
            window.lectorAPI.invoke("save-theme", { theme, accent }).catch(function(){});
        }
    } catch (e) { /* ignore */ }
}

function apply(theme, accent) {
    const t = validTheme(theme);
    const a = validAccent(accent);
    document.documentElement.setAttribute("data-theme", t);
    // only Dark family uses accent variants; others ignore but we keep attr for CSS
    if (LIST.DARK_FAMILY.includes(t)) {
        if (a === "green") { document.documentElement.removeAttribute("data-accent"); }
        else { document.documentElement.setAttribute("data-accent", a); }
    } else {
        document.documentElement.removeAttribute("data-accent");
    }
    // sync to viewer iframe(s)
    try {
        const iframes = document.querySelectorAll('iframe');
        iframes.forEach(function(f){
            try { f.contentWindow.postMessage({ ns: "foxypdf-theme", theme: t, accent: a }, "*"); } catch(e){}
        });
    } catch(e){}
}

function init() {
    const s = getStored();
    apply(s.theme, s.accent);
    // load from main if available (overrides localStorage on first run)
    try {
        if (window.lectorAPI && window.lectorAPI.invoke) {
            window.lectorAPI.invoke("get-theme", {}).then(function(res){
                if (res && res.theme && THEMES.includes(res.theme)) {
                    apply(res.theme, res.accent || DEFAULT_ACCENT);
                    persist(res.theme, res.accent || DEFAULT_ACCENT);
                }
            }).catch(function(){});
        }
    } catch(e){}
}

function setTheme(theme, accent) {
    const t = validTheme(theme);
    const cur = getStored();
    const a = accent ? validAccent(accent) : cur.accent;
    apply(t, a);
    persist(t, a);
}

function setAccent(accent) {
    const cur = getStored();
    setTheme(cur.theme, validAccent(accent));
}

// expose for menu + palette
window.foxyTheme = { init, apply, setTheme, setAccent, getStored, THEMES, ACCENTS, META: LIST };

// auto-init on load
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
