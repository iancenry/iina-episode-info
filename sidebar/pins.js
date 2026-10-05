// ── Folder pins ─────────────────────────────────────────────────────
// Release groups, fansub names, site prefixes and misspelled series names are
// an open set: no list of patterns covers them, and the tail never ends.
// Episode numbering is a closed set. So the show is decided once by the user
// and remembered per directory, and only the episode is parsed from the name.
//
// A pin covers the directory it names and everything below it, so pinning
// "…/samurai champloo" also covers "…/samurai champloo/Season 1/05.mkv".

// Off by default for the *feature*, on by default for *writing* pins: see
// doSetPinRemember.
function loadFolderMap() {
  // Read straight through rather than cached in a module variable, for the
  // same reason loadUrlMap does: one source of truth, and no way for the
  // cached copy to drift from what is actually stored.
  try {
    var v = JSON.parse(localStorage.getItem("epinfo_folder_map") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return v;
  } catch (e) { return {}; }
}
function saveFolderMap(m) {
  try { localStorage.setItem("epinfo_folder_map", JSON.stringify(m)); } catch (e) {}
}
function pruneFolderMap() {
  var m = loadFolderMap();
  var dropped = dropStale(m, URL_MAP_MAX_AGE_MS, Date.now());
  if (dropped) saveFolderMap(m);
  return dropped;
}

// How far up to look for a pin. Matches the folder-hint walk so a pin is
// found from inside a Season folder as readily as from the show folder.
var PIN_LOOKUP_DEPTH = FOLDER_LOOKUP_DEPTH;

// The nearest pinned directory at or above this file, or null.
function pinForUrl(url) {
  var m = loadFolderMap(), segs = pathSegments(url);
  var floor = Math.max(0, segs.length - PIN_LOOKUP_DEPTH);
  for (var i = segs.length - 1; i >= floor; i--) {
    if (m[segs[i]]) return { dir: segs[i], show: m[segs[i]] };
  }
  return null;
}

// Touch a pin so a library still in use never ages out.
function touchPin(dir) {
  var m = loadFolderMap();
  if (!m[dir]) return;
  m[dir].lastSeen = Date.now();
  saveFolderMap(m);
}

function unpinFolder(dir) {
  var m = loadFolderMap();
  if (!m[dir]) return;
  delete m[dir];
  saveFolderMap(m);
}

function parseFolderHints(url) {
  var segs = pathSegments(url);
  // `dir` is the directory the title came from, which is what gets pinned:
  // the show folder, not the Season folder or the media folder below it.
  var out = { title: "", season: null, year: null, dir: "" };
  var floor = Math.max(0, segs.length - FOLDER_LOOKUP_DEPTH);

  for (var i = segs.length - 1; i >= floor; i--) {
    var seg = segs[i];
    if (!seg) continue;

    // "Season 2" or "S02" as a whole segment: a season, never a title. German
    // and French library tools write "Staffel 2" and "Saison 2" for the same
    // thing, and without these the folder was identified as a series.
    var whole = /^(?:season|staffel|saison|s|temporada|sezon|staffa|stor)[\s._-]*(\d{1,3})$/i.exec(seg);
    if (whole) {
      if (out.season === null) out.season = parseInt(whole[1], 10);
      continue;
    }
    // "Severance Season 2", one segment holding both.
    var inner = /\b(?:season|staffel|saison|temporada|sezon|staffa|stor)[\s._-]*(\d{1,3})\b/i.exec(seg);
    if (inner) {
      if (out.season === null) out.season = parseInt(inner[1], 10);
      var rest = cleanTitle(seg.replace(inner[0], " "), null);
      if (isRealTitle(rest)) { out.title = rest; out.dir = seg; break; }
      continue;
    }
    // A bare year directory is the film's date, not its title.
    if (/^(?:19|20)\d{2}$/.test(seg)) {
      if (out.year === null) out.year = parseInt(seg, 10);
      break;
    }
    // Anything below this point describes the disk rather than the show, and
    // the walk stops rather than stepping over it: continuing upward is what
    // ended up naming a show after the user's own home directory.
    // A resolution folder is a descriptor like any other. It used to stop the walk,
// which threw the show away for "Severance/Season 2/2160p/05.mkv", a layout
    // Plex writes, while the same directory with "4K" in it was stepped over.
    if (/^\d{3,4}[pi]$/.test(seg.toLowerCase())) continue;
    if (isDescriptorFolder(seg)) continue;
    if (FOLDER_NOISE[seg.toLowerCase().replace(/[\s._-]+/g, "")]) break;

    var cleaned = cleanTitle(seg, null);
    if (!isRealTitle(cleaned)) continue;
    // "The Complete Series" cleans down to an article, which is no title.
    if (/^(?:the|a|an|of|and|to|in|on|my|all|final|complete)$/i.test(cleaned)) continue;
    out.title = cleaned;
    out.dir = seg;
    break;   // the closest name to the file wins
  }

  return out.title ? out : null;
}
