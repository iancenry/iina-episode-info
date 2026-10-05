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
