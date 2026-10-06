// ── Remembered-URL map housekeeping ──────────────────────────────
// Entries were never removed, so this map only ever grew: one per file
// ever opened, kept even after the file is deleted or renamed. Each entry
// now carries a lastSeen stamp, refreshed every time its file is opened, and
// anything untouched for six months is dropped at launch.
//
// Ageing rather than stat()ing is deliberate. iina.file.exists() would give an
// exact answer but needs the file-system permission, and a disk-wide
// permission is not worth re-adding to tidy a few kilobytes. A count cap was rejected too: it
// evicts files that are still being watched, and because the entry is simply
// gone the only symptom is a slightly slower card, which is the worst kind of
// regression to have.
var URL_MAP_MAX_AGE_DAYS = 180;
var URL_MAP_MAX_AGE_MS = URL_MAP_MAX_AGE_DAYS * 86400000;

// Drop entries that have not been touched in `maxAgeMs`. Returns the number
// removed. Shared by the URL map and the folder map so both age identically.
function dropStale(map, maxAgeMs, now) {
  var keys = Object.keys(map), dropped = 0;
  for (var i = 0; i < keys.length; i++) {
    var e = map[keys[i]];
    // Entries written before stamping existed have no lastSeen. Keep them:
    // treating a missing stamp as stale would wipe the user's history the
    // first time this ran.
    if (e && typeof e.lastSeen === "number" && (now - e.lastSeen) > maxAgeMs) {
      delete map[keys[i]];
      dropped++;
    }
  }
  return dropped;
}

function pruneUrlMap() {
  var m = loadUrlMap(), dropped = dropStale(m, URL_MAP_MAX_AGE_MS, Date.now());
  if (dropped) saveUrlMap(m);
  return dropped;
}

// ── URL → episode map ─────────────────────────
// Each video URL gets its own remembered TMDB identification so the
// user doesn't have to re-search when re-playing the same file/stream.
// `currentVideoUrl` is set by the fileChanged handler.
var currentVideoUrl = "";
function loadUrlMap() {
  try { return JSON.parse(localStorage.getItem("epinfo_url_map") || "{}"); }
  catch(e) { return {}; }
}
function saveUrlMap(m) {
  try { localStorage.setItem("epinfo_url_map", JSON.stringify(m)); } catch(e) {}
}
function saveCurrentUrlInfo(info) {
  if (!currentVideoUrl) return;
  var m = loadUrlMap();
  // Shallow copy so the stamp doesn't leak back into the caller's object,
  // which also gets posted to main.js and stored as the current episode.
  var entry = {};
  for (var k in info) {
    if (Object.prototype.hasOwnProperty.call(info, k)) entry[k] = info[k];
  }
  entry.lastSeen = Date.now();
  m[currentVideoUrl] = entry;
  saveUrlMap(m);
}
function clearCurrentUrlFromMap() {
  if (!currentVideoUrl) return;
  var m = loadUrlMap();
  if (m[currentVideoUrl]) {
    delete m[currentVideoUrl];
    saveUrlMap(m);
  }
}

// ── File changed ──────────────────────────────────────────────
// fileChanged handled below

function resetPanel() {
  document.getElementById("panel").innerHTML =
    '<div class="msg">Search above to find a show or movie.</div>';
}

// ── Saved card ────────────────────────────────────────────────
function showSaved(info) {
  document.getElementById("s-show").textContent  = info.showTitle || "";
  document.getElementById("s-title").textContent = info.epTitle   || "";

  var m = [];
  if (info.code)    m.push(htmlEsc(info.code));
  if (info.airDate) m.push(htmlEsc(info.airDate));
  if (info.rating)  m.push('<span class="rat">&#9733; ' + htmlEsc(info.rating) + '</span>');
  document.getElementById("s-meta").innerHTML = m.join(" &nbsp;·&nbsp; ");

  // Series context line, empty for a film.
  document.getElementById("s-ctx").textContent = info.context || "";

  var desc    = info.overview || "";
  var descEl  = document.getElementById("s-desc");
  var moreBtn = document.getElementById("show-more");

  descEl.textContent = desc;
  descExpanded = false;
  descEl.classList.add("collapsed");

  moreBtn.style.display = "none";
  moreBtn.textContent = "Show more ▾";
  setTimeout(function() {
    if (descEl.scrollHeight > descEl.clientHeight + 2) {
      moreBtn.style.display = "block";
    }
  }, 50);

  document.getElementById("saved").classList.add("on");
}

function toggleDesc() {
  var descEl  = document.getElementById("s-desc");
  var moreBtn = document.getElementById("show-more");
  descExpanded = !descExpanded;
  if (descExpanded) {
    descEl.classList.remove("collapsed");
    moreBtn.textContent = "Show less ▴";
  } else {
    descEl.classList.add("collapsed");
    moreBtn.textContent = "Show more ▾";
  }
}

function doClear() {
  // Abort any lookup still in flight first. Without this a pending response
  // sailed through the guards and called saveSelection again, so the card, the
  // URL map and the overlay all came back after the user had deleted them.
  invalidateLookups();
  // user explicitly cleared: also forget this URL's saved identification
  // so re-playing it later doesn't auto-restore the old pick
  clearCurrentUrlFromMap();
  try{localStorage.removeItem("epinfo_ep");}catch(e){}
  document.getElementById("saved").classList.remove("on");
  selShow      = null;
  selSeason    = null;
  descExpanded = false;
  episodeCache = [];
  showTotals   = null;
  iina.postMessage("setSceneMarks", { marks: [] });
  iina.postMessage("clearEpisode", {});
  if (typeof paintMarks === "function") paintMarks();
  resetPanel();
}

// ── Local scene marks ─────────────────────────────────────────
// The user's own trigger/skip-to pairs, for titles the databases have not
// timed (X2's Mystique scenes, for instance). Keyed like a DDD rating —
// tmdbId:season:episode, with a film's indexes at -1 — so they attach to the
// same identification the rest of the plugin uses. Kept indefinitely: a mark
// is manual work, not a cache.
function markKey(info) {
  if (!info || !info.tmdbId) return "";
  var s = info.isMovie ? -1 : Number(info.season);
  var e = info.isMovie ? -1 : Number(info.episode);
  return String(info.tmdbId) + ":" + s + ":" + e;
}

function loadMarks() {
  try {
    var m = JSON.parse(localStorage.getItem("epinfo_marks") || "{}");
    return (m && typeof m === "object" && !Array.isArray(m)) ? m : {};
  } catch (e) { return {}; }
}

function saveMarks(m) {
  try { localStorage.setItem("epinfo_marks", JSON.stringify(m)); } catch (e) {}
}

function marksFor(info) {
  var list = loadMarks()[markKey(info)];
  return Array.isArray(list) ? list : [];
}

function setMarksFor(info, list) {
  var k = markKey(info);
  if (!k) return;
  var m = loadMarks();
  if (list && list.length) m[k] = list;
  else delete m[k];
  saveMarks(m);
}

// The identification the marks UI attaches to: whatever the saved-card
// selection is, or null when nothing is identified.
function currentMarkInfo() {
  try { return JSON.parse(localStorage.getItem("epinfo_ep") || "null"); }
  catch (e) { return null; }
}
