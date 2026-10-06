// ── Pause delay ───────────────────────────────
(function(){
  var s = localStorage.getItem("epinfo_pause_delay");
  if (s !== null) {
    document.getElementById("pause-delay-input").value = parseFloat(s);
  }
  setTimeout(function() {
    var v = localStorage.getItem("epinfo_pause_delay");
    var n = v !== null ? parseFloat(v) : 3;
    if (!isNaN(n)) iina.postMessage("setPauseDelay", { value: n });

    // TMDB key. main.js needs it to resolve the IMDB id that the skip
    // databases are keyed on.
    iina.postMessage("setTmdbKey", { key: localStorage.getItem("epinfo_tmdb_key") || "" });

    // Overlay theme
    var th = localStorage.getItem("epinfo_overlay_theme") || "classic";
    paintThemePills(th);
    iina.postMessage("setOverlayTheme", { value: th });

    // Skip intro, opt-in so off by default
    var sk = localStorage.getItem("epinfo_skip_enabled") === "true";
    paintSkipToggle(sk);
    iina.postMessage("setSkipEnabled", { enabled: sk });

    // Scene warnings: the second key and the second opt-in, also off by
    // default. Pushed after the skip pair so the two features are set up in
    // the same order the sidebar shows them.
    iina.postMessage("setDddKey", { key: localStorage.getItem("epinfo_ddd_key") || "" });
    var dw = localStorage.getItem("epinfo_ddd_enabled") === "true";
    paintDddToggle(dw);
    iina.postMessage("setDddEnabled", { enabled: dw });

    // How early the scene card appears, and the per-category actions.
    var dl = localStorage.getItem("epinfo_ddd_lead");
    iina.postMessage("setDddLead", { value: dl !== null ? parseFloat(dl) : 30 });
    iina.postMessage("setDddCatActions", { actions: loadDddCats() });

    // Whether an auto-skip shows its cancel/undo card. It skips either way.
    iina.postMessage("setDddAutoCard", { enabled: dddAutoCardOn() });

    renderSearches();
    pruneRecents();
    renderRecents();
    pruneUrlMap();
    // The folder map ages identically. Without this it was the one map that
    // only ever grew, holding pins for folders that no longer exist.
    pruneFolderMap();
    // Marks age like the maps, with a cap over that; scanner runs made this
    // store partly a cache, not only a record of manual work.
    pruneMarks();

    // All settings have been pushed, so tell main.js it is safe to re-emit
    // fileChanged so we can do the per-URL TMDB restore.
    // The original fileChanged from iina.file-loaded may have arrived
    // before our handlers were registered.
    iina.postMessage("sidebarReady", {});
  }, 800);
})();
function doSetPauseDelay(val) {
  var n = parseFloat(val);
  if (isNaN(n) || n < 0.5) n = 0.5;
  if (n > 30) n = 30;
  document.getElementById("pause-delay-input").value = n;
  try { localStorage.setItem("epinfo_pause_delay", n); } catch(e) {}
  iina.postMessage("setPauseDelay", { value: n });
}

// ── NEW: Overlay dismiss/showing ──────────────────────────────
iina.onMessage("overlayShowing", function(d) {
  document.getElementById("ov-dismiss").style.display = d.visible ? "block" : "none";
});

// Collapsible sidebar sections, remembering open/closed state across launches.
(function () {
  var live = {};
  document.querySelectorAll("details.sub-sec").forEach(function (d) {
    var key = "epinfo_open_" + d.getAttribute("data-k");
    live[key] = 1;
    var saved = localStorage.getItem(key);
    if (saved !== null) d.open = saved === "1";
    d.addEventListener("toggle", function () {
      try { localStorage.setItem(key, d.open ? "1" : "0"); } catch (e) {}
    });
  });

  // Drop stored state for sections that no longer exist. Keys written by a
  // section that has since been removed still sit in localStorage, and are
  // pruned here. The live set is derived from the DOM, so this stays correct
  // if sections are added or removed again.
  try {
    var dead = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf("epinfo_open_") === 0 && !live[k]) dead.push(k);
    }
    dead.forEach(function (k) { localStorage.removeItem(k); });
  } catch (e) {}
})();
