"use strict";
/* viewer boot — same as theme-boot.js but for the iframe */
try {
    var _t = localStorage.getItem("foxypdf-theme") || "dark";
    var _a = localStorage.getItem("foxypdf-accent");
    document.documentElement.setAttribute("data-theme", _t);
    if (_a && _a !== "green") document.documentElement.setAttribute("data-accent", _a);
    else document.documentElement.removeAttribute("data-accent");
} catch (e) {
    try { document.documentElement.setAttribute("data-theme", "dark"); } catch (ex) {}
}
window.addEventListener("message", function (e) {
    try {
        if (e.data && e.data.ns === "foxypdf-theme") {
            document.documentElement.setAttribute("data-theme", e.data.theme);
            if (e.data.accent && e.data.accent !== "green") document.documentElement.setAttribute("data-accent", e.data.accent);
            else document.documentElement.removeAttribute("data-accent");
        }
    } catch (ex) {}
});
