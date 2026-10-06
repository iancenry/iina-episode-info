// ── Recent searches ───────────────────────────
// Just the last few query strings, so getting from "episode 4" to "episode 5"
// costs one click instead of retyping the show name.
var SEARCHES_CAP = 5;

function loadSearches() {
  try {
    var v = JSON.parse(localStorage.getItem("epinfo_searches") || "[]");
    return Array.isArray(v) ? v : [];
  } catch(e) { return []; }
}
function pushSearch(q) {
  q = String(q || "").trim();
  if (!q) return;
  var list = loadSearches().filter(function(x) {
    return String(x).toLowerCase() !== q.toLowerCase();
  });
  list.unshift(q);
  try { localStorage.setItem("epinfo_searches", JSON.stringify(list.slice(0, SEARCHES_CAP))); } catch(e) {}
  renderSearches();
}
function runSearch(i) {
  var q = loadSearches()[i];
  if (!q) return;
  var box = document.getElementById("q");
  if (box) box.value = q;
  doSearch();
}
function renderSearches() {
  var sec  = document.getElementById("searches-sec");
  var list = document.getElementById("searches-list");
  if (!sec || !list) return;
  var items = loadSearches();
  if (!items.length) { sec.style.display = "none"; list.innerHTML = ""; return; }
  sec.style.display = "block";
  var html = "";
  for (var i = 0; i < items.length; i++) {
    html += '<button class="sq" onclick="runSearch(' + i + ')" title="Search again">' +
            htmlEsc(items[i]) + '</button>';
  }
  list.innerHTML = html;
}

// ── Recent picks ──────────────────────────────
// Stored as [{ info, lastUsed, pinned }]. Pinned entries never age out and
// are not counted against the cap, or pinning would silently evict them.
var RECENTS_CAP = 5;

function loadRecents() {
  // The shape is checked, not just the parse. A hand-edited or truncated value
  // that parses to an object used to throw in sortedRecents, and because that
  // ran inside the boot timer the throw also skipped sidebarReady, so main.js
  // never re-emitted fileChanged and per-URL restore died for the session.
  try {
    var v = JSON.parse(localStorage.getItem("epinfo_recents") || "[]");
    if (!Array.isArray(v)) return [];
    return v.filter(function (r) { return r && typeof r === "object" && r.info; });
  } catch(e) { return []; }
}
function saveRecents(list) {
  try { localStorage.setItem("epinfo_recents", JSON.stringify(list)); } catch(e) {}
}
// Identity of a recent pick, for de-duplication. Keyed on the show alone, not
// the episode: Recent Picks is a list of shows you can re-apply, so watching a
// second episode of something already there should refresh the existing entry
// rather than add a near-duplicate. It used to include season and episode, so
// every episode of a series accumulated its own row and the pin was lost on the
// next one.
function recentKey(info) {
  if (!info) return "";
  return (info.isMovie ? "m" : "t") + info.tmdbId;
}
function pushRecent(info) {
  if (!info || !info.tmdbId) return;
  var list = loadRecents();
  var key  = recentKey(info);
  var hit  = null;
  list = list.filter(function(r) {
    if (recentKey(r.info) === key) { hit = r; return false; }
    return true;
  });
  list.unshift({ info: info, lastUsed: Date.now(), pinned: hit ? hit.pinned : false });

  var kept = [], unpinned = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i].pinned) { kept.push(list[i]); continue; }
    if (unpinned < RECENTS_CAP) { kept.push(list[i]); unpinned++; }
  }
  saveRecents(kept);
  renderRecents();
}
function applyRecent(idx) {
  var list = sortedRecents();
  var r = list[idx];
  if (!r) return;
  r.lastUsed = Date.now();
  var all = loadRecents();
  for (var i = 0; i < all.length; i++) {
    if (recentKey(all[i].info) === recentKey(r.info)) all[i].lastUsed = r.lastUsed;
  }
  saveRecents(all);
  // Same path a normal pick takes, so nothing new can go out of sync. That
  // includes clearing the panel and the picker state, which is where the
  // desync came from: showSaved paints the card but leaves whatever was in the
  // panel standing, so a card reading S36E04 could sit above a grid reading
  // S01. The card lives outside the panel, so it survives this.
  try { localStorage.setItem("epinfo_ep", JSON.stringify(r.info)); } catch(e) {}
  saveCurrentUrlInfo(r.info);
  showSaved(r.info);
  // The marks for this identification travel ahead of the selection, as they
  // do on every other pick path; without this main.js kept the previous
  // title's marks live for the newly picked one.
  iina.postMessage("setSceneMarks", { marks: marksFor(r.info) });
  iina.postMessage("episodeSelected", r.info);
  if (typeof paintMarks === "function") paintMarks();
  selShow = null; selSeason = null; episodeCache = [];
  resetPanel();
  renderRecents();
}
function togglePin(idx, ev) {
  if (ev) ev.stopPropagation();
  var r = sortedRecents()[idx];
  if (!r) return;
  var all = loadRecents();
  for (var i = 0; i < all.length; i++) {
    if (recentKey(all[i].info) === recentKey(r.info)) all[i].pinned = !all[i].pinned;
  }
  saveRecents(all);
  renderRecents();
}
function removeRecent(idx, ev) {
  if (ev) ev.stopPropagation();
  var r = sortedRecents()[idx];
  if (!r) return;
  saveRecents(loadRecents().filter(function(x) {
    return recentKey(x.info) !== recentKey(r.info);
  }));
  renderRecents();
}
function clearRecents() {
  saveRecents([]);
  renderRecents();
}
// Sorted AND capped: the cap has to apply here too, or a list saved under an
// older, larger limit would keep rendering every entry.
function sortedRecents() {
  var sorted = loadRecents().sort(function(a, b) {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.lastUsed || 0) - (a.lastUsed || 0);
  });
  var out = [], unpinned = 0;
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].pinned) { out.push(sorted[i]); continue; }
    if (unpinned < RECENTS_CAP) { out.push(sorted[i]); unpinned++; }
  }
  return out;
}

// Drop anything the cap has squeezed out, so storage does not keep growing
// invisibly behind the list.
function pruneRecents() {
  var kept = sortedRecents();
  if (kept.length !== loadRecents().length) saveRecents(kept);
}
function renderRecents() {
  var sec  = document.getElementById("recents-sec");
  var list = document.getElementById("recents-list");
  if (!sec || !list) return;
  var items = sortedRecents();
  if (!items.length) { sec.style.display = "none"; list.innerHTML = ""; return; }
  sec.style.display = "block";

  var html = "";
  for (var i = 0; i < items.length; i++) {
    var info = items[i].info || {};
    var sub  = info.isMovie
      ? "Movie" + (info.airDate ? " · " + htmlEsc(yearOf(info.airDate)) : "")
      : (info.code ? htmlEsc(info.code) : "") + (info.epTitle ? " · " + htmlEsc(info.epTitle) : "");
    var img  = info.posterUrl ? "background-image:url('" + htmlEsc(info.posterUrl) + "')" : "";
    html += '<div class="rc" onclick="applyRecent(' + i + ')">' +
              '<div class="rc-img" style="' + img + '"></div>' +
              '<div class="rc-txt">' +
                '<div class="rc-t">' + htmlEsc(info.showTitle || info.epTitle || "Untitled") + '</div>' +
                '<div class="rc-s">' + sub + '</div>' +
              '</div>' +
              '<button class="rc-b' + (items[i].pinned ? ' pinned' : '') + '" title="Pin" ' +
                'onclick="togglePin(' + i + ',event)">' + (items[i].pinned ? '\u2605' : '\u2606') + '</button>' +
              '<button class="rc-b" title="Remove" onclick="removeRecent(' + i + ',event)">\u00D7</button>' +
            '</div>';
  }
  list.innerHTML = html;
}
