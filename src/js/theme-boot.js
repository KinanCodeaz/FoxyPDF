"use strict";
/* FoxyPDF — early theme boot (must run before first paint, no deps).
 * theme-list.js is loaded just before this file, so the valid-theme list
 * comes from the single shared source (falls back to "dark" only). */
try {
    var _list = (window.FOXY_THEME_LIST && window.FOXY_THEME_LIST.THEMES) || ["dark"];
    var _t = localStorage.getItem("foxypdf-theme") || "dark";
    if (_list.indexOf(_t) < 0) { _t = "dark"; }
    var _a = localStorage.getItem("foxypdf-accent");
    document.documentElement.setAttribute("data-theme", _t);
    if (_a && _a !== "green") document.documentElement.setAttribute("data-accent", _a);
    else document.documentElement.removeAttribute("data-accent");
} catch (e) {
    try { document.documentElement.setAttribute("data-theme", "dark"); } catch (ex) {}
}
