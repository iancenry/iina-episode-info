// ── Overlay ON/OFF toggle ─────────────────────────────────────
(function() {
  var enabled = localStorage.getItem("epinfo_overlay_enabled") !== "false"; // default ON
  document.getElementById("overlay-toggle").checked = enabled;
  updateToggleVisual(enabled);
  // Send initial state to main.js after a short delay (handlers must be registered)
  setTimeout(function() {
    iina.postMessage("setOverlayEnabled", { enabled: enabled });
  }, 600);
})();

function updateToggleVisual(enabled) {
  var track = document.getElementById("toggle-track");
  var thumb = document.getElementById("toggle-thumb");
  if (track) track.style.background = enabled ? "rgba(48,209,88,.85)" : "rgba(255,255,255,.2)";
  if (thumb) thumb.style.left = enabled ? "21px" : "3px";
}

function doToggleOverlay(enabled) {
  localStorage.setItem("epinfo_overlay_enabled", enabled ? "true" : "false");
  updateToggleVisual(enabled);
  iina.postMessage("setOverlayEnabled", { enabled: enabled });
}

iina.onMessage("overlayStatus", function(d){
  var el=document.getElementById("ov-st");
  if(el) el.textContent = d.text||"";
});

// ── API Key ───────────────────────────────────────────────────
(function initPinRemember() {
  var el = document.getElementById("pin-remember");
  if (el) el.checked = localStorage.getItem("epinfo_pin_remember") !== "false";
})();

(function initApiKey() {
  var key = localStorage.getItem("epinfo_tmdb_key") || "";
  if (key) {
    TK = key;
    showApiOk();
  } else {
    showApiForm();
  }
})();

function showApiOk() {
  document.getElementById("api-section").style.display = "none";
  var ok = document.getElementById("api-ok");
  ok.style.display = "flex";
  document.getElementById("q").disabled = false;
  document.getElementById("q").placeholder = "Show or movie name…";
}

function showApiForm() {
  document.getElementById("api-section").style.display = "block";
  document.getElementById("api-ok").style.display = "none";
  document.getElementById("go").disabled = true;
  document.getElementById("q").disabled = true;
  document.getElementById("q").placeholder = "Enter API key above first…";
}

function doSaveKey() {
  var key = (document.getElementById("api-input").value || "").trim();
  var msg = document.getElementById("api-msg");
  if (!key) { msg.style.color="#ff453a"; msg.textContent="Please paste your key."; return; }
  msg.style.color="rgba(255,255,255,0.4)"; msg.textContent="Verifying…";
  fetch("https://api.themoviedb.org/3/configuration?api_key=" + encodeURIComponent(key))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.images) {
        localStorage.setItem("epinfo_tmdb_key", key);
        iina.postMessage("setTmdbKey", { key: key });
        TK = key;
        msg.style.color="#30d158"; msg.textContent="✓ Valid key saved!";
        setTimeout(showApiOk, 700);
      } else {
        msg.style.color="#ff453a"; msg.textContent="✗ Invalid key, please check and retry.";
      }
    })
    .catch(function(){
      localStorage.setItem("epinfo_tmdb_key", key);
      iina.postMessage("setTmdbKey", { key: key });
      TK = key;
      msg.style.color="#ff9f0a"; msg.textContent="⚠ Saved (couldn’t verify: no network)";
      setTimeout(showApiOk, 1200);
    });
}

function doChangeKey() {
  document.getElementById("api-input").value = TK;
  document.getElementById("api-msg").textContent = "";
  showApiForm();
}

// ── NEW: Opacity slider ───────────────────────────────────────
(function(){
  var s = localStorage.getItem("epinfo_overlay_opacity");
  if (s !== null) {
    var p = Math.round(parseFloat(s) * 100);
    document.getElementById("opacity-slider").value = p;
    document.getElementById("opacity-val").textContent = p + "%";
  }
  // Push the saved value to main.js once handlers are ready.
  // Without this, opacity always reset to default on IINA restart.
  setTimeout(function() {
    var v = localStorage.getItem("epinfo_overlay_opacity");
    if (v !== null) iina.postMessage("setOverlayOpacity", { value: parseFloat(v) });
  }, 800);
})();
function doSetOpacity(val) {
  var p = parseInt(val, 10);
  document.getElementById("opacity-val").textContent = p + "%";
  var n = p / 100;
  try { localStorage.setItem("epinfo_overlay_opacity", n); } catch(e) {}
  iina.postMessage("setOverlayOpacity", { value: n });
}

// ── Overlay vertical position slider ──────────
function vposLabel(v) {
  if (v <= 5)  return "Top";
  if (v >= 95) return "Bottom";
  if (v >= 48 && v <= 52) return "Center";
  return v + "%";
}
(function(){
  var s = localStorage.getItem("epinfo_overlay_vpos");
  if (s !== null) {
    var v = parseFloat(s);
    document.getElementById("vpos-slider").value = v;
    document.getElementById("vpos-val").textContent = vposLabel(v);
  }
  setTimeout(function() {
    var v = localStorage.getItem("epinfo_overlay_vpos");
    if (v !== null) iina.postMessage("setOverlayVerticalPos", { value: parseFloat(v) });
  }, 800);
})();
function doSetVPos(val) {
  var v = parseInt(val, 10);
  document.getElementById("vpos-val").textContent = vposLabel(v);
  try { localStorage.setItem("epinfo_overlay_vpos", v); } catch(e) {}
  iina.postMessage("setOverlayVerticalPos", { value: v });
}


// ── Overlay theme ─────────────────────────────
function paintThemePills(t) {
  var pills = document.querySelectorAll("#theme-pills .thm");
  for (var i = 0; i < pills.length; i++) {
    pills[i].className = "thm" + (pills[i].getAttribute("data-t") === t ? " on" : "");
  }
}
// The three themes, named once. The overlay whitelists them too and falls back
// to classic, but an unknown value used to be persisted and left persisted, so
// a stale name could sit in storage across restarts.
var THEMES = { classic: 1, compact: 1, poster: 1 };

function doSetTheme(t) {
  if (!THEMES[t]) t = "classic";
  try { localStorage.setItem("epinfo_overlay_theme", t); } catch(e) {}
  paintThemePills(t);
  iina.postMessage("setOverlayTheme", { value: t });
}

// ── Skip intro toggle ─────────────────────────
function paintSkipToggle(on) {
  var box = document.getElementById("skip-toggle");
  var tr  = document.getElementById("skip-track");
  var th  = document.getElementById("skip-thumb");
  if (box) box.checked = on;
  if (tr) tr.style.background = on ? "rgba(48,209,88,.85)" : "rgba(255,255,255,.2)";
  if (th) th.style.left = on ? "21px" : "3px";
}
var skipMsgTimer = null;
function showSkipMsg(text) {
  var el = document.getElementById("skip-status");
  if (!el) return;
  if (skipMsgTimer) { clearTimeout(skipMsgTimer); skipMsgTimer = null; }
  if (!text) { el.style.display = "none"; el.textContent = ""; return; }
  el.textContent = text;
  el.style.display = "block";
  // Transient on purpose: a permanent read-out of internals looks unfinished.
  skipMsgTimer = setTimeout(function() {
    el.style.display = "none";
    el.textContent = "";
  }, 6000);
}

function doRefreshSkip() {
  var btn = document.getElementById("skip-refresh");
  if (btn) { btn.disabled = true; btn.textContent = "Searching\u2026"; }
  showSkipMsg("");
  skipUserAsked = true;
  iina.postMessage("refreshSkip", {});
}

iina.onMessage("skipResult", function(d) {
  // Every answer re-enables the button, including the ones that arrive from a
  // lookup the user has already moved past.
  var btn = document.getElementById("skip-refresh");
  if (btn) { btn.disabled = false; btn.textContent = "Search again"; }
  if (!d) return;
  // A superseded run reports nothing at all. Treating it as "no segments" said
  // the episode had none and consumed the single "you asked for this" flag, so
  // the real answer that arrived a moment later was thrown away.
  if (d.stale) return;
  // Only speak up when the user asked; a silent success needs no commentary.
  if (skipUserAsked) {
    showSkipMsg(d.count ? d.label : "Nothing found for this episode.");
    skipUserAsked = false;
  }
});
var skipUserAsked = false;

function doToggleSkip(on) {
  try { localStorage.setItem("epinfo_skip_enabled", on ? "true" : "false"); } catch(e) {}
  paintSkipToggle(on);
  iina.postMessage("setSkipEnabled", { enabled: on });
}

// ── Scene content warnings (DoesTheDogDie) ───────────────────
function paintDddToggle(on) {
  var box = document.getElementById("ddd-toggle");
  var tr  = document.getElementById("ddd-track");
  var th  = document.getElementById("ddd-thumb");
  if (box) box.checked = on;
  if (tr) tr.style.background = on ? "rgba(48,209,88,.85)" : "rgba(255,255,255,.2)";
  if (th) th.style.left = on ? "21px" : "3px";
}

function doToggleDdd(on) {
  try { localStorage.setItem("epinfo_ddd_enabled", on ? "true" : "false"); } catch(e) {}
  paintDddToggle(on);
  iina.postMessage("setDddEnabled", { enabled: on });
}

// Auto marks skip whether or not scene cues are shown; this decides if their
// cancel/undo card still appears. Default on: an automatic seek with no way
// back is worse than a card the user did not ask for.
function dddAutoCardOn() {
  return localStorage.getItem("epinfo_ddd_autocard") !== "false";
}

function paintDddAutoCard(on) {
  var box = document.getElementById("ddd-autocard-toggle");
  var tr  = document.getElementById("ddd-autocard-track");
  var th  = document.getElementById("ddd-autocard-thumb");
  if (box) box.checked = on;
  if (tr) tr.style.background = on ? "rgba(48,209,88,.85)" : "rgba(255,255,255,.2)";
  if (th) th.style.left = on ? "21px" : "3px";
}

function doToggleDddAutoCard(on) {
  try { localStorage.setItem("epinfo_ddd_autocard", on ? "true" : "false"); } catch(e) {}
  paintDddAutoCard(on);
  iina.postMessage("setDddAutoCard", { enabled: on });
}

(function initDddKey() {
  // The placeholder says whether a key is already stored, so the field works
  // as both a first entry and a "change it" field.
  var el = document.getElementById("ddd-key-input");
  if (!el) return;
  if (localStorage.getItem("epinfo_ddd_key")) {
    el.placeholder = "Key saved \u2014 paste a new one to replace";
  }
})();

function doSaveDddKey() {
  var key = (document.getElementById("ddd-key-input").value || "").trim();
  var msg = document.getElementById("ddd-key-msg");
  if (!msg) return;
  if (!key) { msg.style.color="#ff453a"; msg.textContent="Please paste your key."; return; }
  // Saved and pushed immediately. DDD serves no CORS headers, so a fetch from
  // here dies before it can judge anything: main.js owns every DDD call
  // anyway, so it verifies and the verdict arrives below.
  try { localStorage.setItem("epinfo_ddd_key", key); } catch(e) {}
  iina.postMessage("setDddKey", { key: key });
  msg.style.color="rgba(255,255,255,0.4)";
  msg.textContent="Verifying\u2026";
}

iina.onMessage("dddKeyCheck", function(d) {
  var msg = document.getElementById("ddd-key-msg");
  if (!msg) return;
  if (d && d.ok === true) {
    msg.style.color="#30d158"; msg.textContent="\u2713 Valid key saved!";
  } else if (d && d.reason === "invalid") {
    // DDD itself said no, so the key is not kept: a dead key saved looks
    // exactly like the feature being silently broken.
    try { localStorage.removeItem("epinfo_ddd_key"); } catch(e) {}
    msg.style.color="#ff453a"; msg.textContent="\u2717 Invalid key, please check and retry.";
  } else {
    // Not DDD saying no: a Cloudflare challenge or a timeout. The key stays,
    // the way the TMDB form keeps a key it could not verify.
    msg.style.color="#ff9f0a"; msg.textContent="\u26a0 Saved (couldn\u2019t verify: no answer from DDD)";
  }
});

var dddUserAsked = false;
var dddMsgTimer = null;
function showDddMsg(text) {
  var el = document.getElementById("ddd-status");
  if (!el) return;
  if (dddMsgTimer) { clearTimeout(dddMsgTimer); dddMsgTimer = null; }
  if (!text) { el.style.display = "none"; el.textContent = ""; return; }
  el.textContent = text;
  el.style.display = "block";
  // Transient on purpose, like the skip status: a permanent read-out of
  // internals looks unfinished.
  dddMsgTimer = setTimeout(function() {
    el.style.display = "none";
    el.textContent = "";
  }, 6000);
}

function doRefreshScenes() {
  var btn = document.getElementById("ddd-refresh");
  if (btn) { btn.disabled = true; btn.textContent = "Searching\u2026"; }
  showDddMsg("");
  dddUserAsked = true;
  iina.postMessage("refreshScenes", {});
}

iina.onMessage("scenesResult", function(d) {
  // Every answer re-enables the button, including one from a lookup the user
  // has already moved past.
  var btn = document.getElementById("ddd-refresh");
  if (btn) { btn.disabled = false; btn.textContent = "Search again"; }
  if (!d) return;
  // A superseded run reports nothing but stale, exactly like skipResult.
  if (d.stale) return;
  var list = d.scenes || [];
  var flags = d.flags || [];
  renderDddScenes(list);
  renderDddFlags(flags);
  // DDD's attribution shows wherever their data does, and these lists are it.
  var attr = document.getElementById("ddd-attr");
  if (attr) attr.style.display = (list.length || flags.length) ? "block" : "none";
  if (dddUserAsked) {
    dddUserAsked = false;
    if (list.length) {
      showDddMsg(list.length + " timestamped scene" + (list.length === 1 ? "" : "s") + " found");
    } else if (flags.length) {
      showDddMsg("No timestamps for this episode \u00b7 " + flags.length +
                 " topic" + (flags.length === 1 ? "" : "s") + " flagged.");
    } else {
      showDddMsg("Nothing found for this episode.");
    }
  }
});

function renderDddScenes(list) {
  var el = document.getElementById("ddd-scenes");
  if (!el) return;
  if (!list || !list.length) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  var html = "";
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    html += '<div class="ddd-row"><span class="ddd-lbl">' + htmlEsc(s.label) + '</span>' +
      '<span class="ddd-time">' + htmlEsc(s.at) + (s.to ? " &rarr; " + htmlEsc(s.to) : "") + '</span></div>';
    // The community's own description of what happens, when the data
    // carries one; the cue description is the fallback.
    var detail = s.desc || s.cue;
    if (detail) html += '<div class="ddd-cue">' + htmlEsc(detail) + '</div>';
  }
  el.innerHTML = html;
  el.style.display = "block";
}

// Open state per supercategory group in the flag list, persisted so a
// re-render (another search, a new episode) does not re-expand or re-collapse
// what the user set. Collapsed until opened.
function loadDddFlagOpen() {
  try {
    var m = JSON.parse(localStorage.getItem("epinfo_dddflag_open") || "{}");
    return (m && typeof m === "object" && !Array.isArray(m)) ? m : {};
  } catch (e) { return {}; }
}

function dddFlagOpen(name) {
  return loadDddFlagOpen()[name] === true;
}

// The topics the community has flagged yes on for this title that carry no
// timestamp, grouped under their supercategory as collapsible sections.
// Sorted by the plugin, so the rows arrive in group order already.
var dddFlagsCache = [];
function renderDddFlags(list) {
  var wrap = document.getElementById("ddd-flags-wrap");
  var el = document.getElementById("ddd-flags");
  var empty = document.getElementById("ddd-flags-empty");
  if (!el || !wrap) return;
  if (!list || !list.length) {
    dddFlagsCache = [];
    wrap.style.display = "none";
    el.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  dddFlagsCache = list;
  if (empty) empty.style.display = "none";

  // Group counts first, so each summary can show its weight.
  var counts = {}, order = [];
  for (var c = 0; c < list.length; c++) {
    var sup = list[c].super || "Other";
    if (counts[sup] == null) { counts[sup] = 0; order.push(sup); }
    counts[sup]++;
  }

  var html = "", i = 0;
  for (var g = 0; g < order.length; g++) {
    var name = order[g];
    var rows = "";
    while (i < list.length && (list[i].super || "Other") === name) {
      var f = list[i];
      var votes = Number(f.yes) + " yes" + (Number(f.no) ? " \u00b7 " + Number(f.no) + " no" : "");
      rows += '<div class="ddd-row"><span class="ddd-lbl">' + htmlEsc(f.label) + '</span>' +
        '<span class="ddd-time">' + htmlEsc(votes) + '</span></div>';
      if (f.desc) rows += '<div class="ddd-cue">' + htmlEsc(f.desc) + '</div>';
      i++;
    }
    html += '<details class="ddd-fgrp"' + (dddFlagOpen(name) ? ' open' : '') +
      ' data-g="' + htmlEsc(name) + '">' +
      '<summary class="ddd-super">' + htmlEsc(name) +
      '<span class="ddd-gcount">' + counts[name] + '</span></summary>' + rows +
      '</details>';
  }
  el.innerHTML = html;
  wrap.style.display = "block";
}

// Persist a group's open state. The toggle event does not bubble, so this is
// a capture-phase listener registered once.
(function initDddFlagPersistence() {
  document.addEventListener("toggle", function (ev) {
    var d = ev && ev.target;
    if (!d || !d.getAttribute || String(d.className || "").indexOf("ddd-fgrp") === -1) return;
    var name = d.getAttribute("data-g");
    if (!name) return;
    var m = loadDddFlagOpen();
    m[name] = !!d.open;
    try { localStorage.setItem("epinfo_dddflag_open", JSON.stringify(m)); } catch (e) {}
  }, true);
})();

// ── Scene warning settings: lead time and per-category actions ─
// The 11 supercategories from /topicsupercategories (v3). Ids are the
// contract with main.js; the names are display only. A category not listed
// here behaves as Skip, main.js's own default.
var DDD_SUPERS = [
  { id: 54, name: "Animals", short: "Animals" },
  { id: 59, name: "Bodily Harm", short: "Bodily Harm" },
  { id: 53, name: "Children & Babies", short: "Kids" },
  { id: 52, name: "Death, Grief & Loss", short: "Death" },
  { id: 56, name: "Discrimination", short: "Discrimination" },
  { id: 57, name: "Medical & Health", short: "Medical" },
  { id: 55, name: "Mental Health", short: "Mental" },
  { id: 60, name: "Other", short: "Other" },
  { id: 58, name: "Phobias & Sensory", short: "Phobias" },
  { id: 51, name: "Sexual Content/Assault", short: "Sex" },
  { id: 50, name: "Violence", short: "Violence" }
];
var DDD_STATES = ["off", "warn", "skip", "auto"];
var DDD_STATE_LABEL = { off: "Off", warn: "Warn", skip: "Skip", auto: "Auto" };

function loadDddCats() {
  try {
    var m = JSON.parse(localStorage.getItem("epinfo_ddd_cats") || "{}");
    return (m && typeof m === "object") ? m : {};
  } catch (e) { return {}; }
}

function dddCatState(id) {
  var v = loadDddCats()[id];
  return DDD_STATES.indexOf(v) >= 0 ? v : "skip";
}

function paintDddCats() {
  var el = document.getElementById("ddd-cats");
  if (!el) return;
  var html = "";
  for (var i = 0; i < DDD_SUPERS.length; i++) {
    var c = DDD_SUPERS[i], st = dddCatState(c.id);
    html += '<button class="pill cpill ' + st + '" title="' + htmlEsc(c.name) + ': ' + DDD_STATE_LABEL[st] +
      '" onclick="cycleDddCat(' + c.id + ')">' + htmlEsc(c.short) + ' &middot; ' + DDD_STATE_LABEL[st] + '</button>';
  }
  el.innerHTML = html;
}

function cycleDddCat(id) {
  var m = loadDddCats();
  m[id] = DDD_STATES[(DDD_STATES.indexOf(dddCatState(id)) + 1) % DDD_STATES.length];
  try { localStorage.setItem("epinfo_ddd_cats", JSON.stringify(m)); } catch (e) {}
  paintDddCats();
  iina.postMessage("setDddCatActions", { actions: loadDddCats() });
}

function doSetDddLead(val) {
  var n = parseFloat(val);
  if (isNaN(n) || n < 5) n = 5;
  if (n > 120) n = 120;
  var input = document.getElementById("ddd-lead-input");
  if (input) input.value = n;
  try { localStorage.setItem("epinfo_ddd_lead", n); } catch (e) {}
  iina.postMessage("setDddLead", { value: n });
}

(function initDddSettings() {
  var s = localStorage.getItem("epinfo_ddd_lead");
  var input = document.getElementById("ddd-lead-input");
  if (s !== null && input) input.value = parseFloat(s);
  paintDddCats();
  paintDddAutoCard(dddAutoCardOn());
})();

// ── Scene-section tabs: Cues | Flags | Options ────────────────
// The section carries three activities — act on this episode, read the rest
// of the flags, and configure — so they are tabs rather than one long scroll.
var DDD_TABS = ["cues", "flags", "options"];

function paintDddTab(t) {
  var i, btns = document.querySelectorAll("#ddd-tabs .pill");
  for (i = 0; i < btns.length; i++) {
    btns[i].className = "pill" + (btns[i].getAttribute("data-t") === t ? " on" : "");
  }
  for (i = 0; i < DDD_TABS.length; i++) {
    var pane = document.getElementById("ddd-pane-" + DDD_TABS[i]);
    if (pane) pane.style.display = (DDD_TABS[i] === t) ? "block" : "none";
  }
}

function doDddTab(t) {
  if (DDD_TABS.indexOf(t) < 0) t = "cues";
  try { localStorage.setItem("epinfo_ddd_tab", t); } catch(e) {}
  paintDddTab(t);
}

(function initDddTab() {
  var t = localStorage.getItem("epinfo_ddd_tab") || "cues";
  paintDddTab(t);
})();
