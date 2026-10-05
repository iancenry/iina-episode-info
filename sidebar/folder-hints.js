// ── Folder hints ─────────────────────────────────────────────────
// Some libraries carry the show in the directory and nothing but a number in
// the file: "Severance/Season 2/05.mkv". No amount of filename parsing can
// identify that, so the directory names are the only other place a title can
// come from.

// Directories that describe the library rather than the show. "Downloads" and
// "Videos" sit at the top of almost every tree, so the walk has to step over
// them rather than search for them.
var FOLDER_NOISE = {
  videos: 1, video: 1, movies: 1, movie: 1, films: 1, film: 1, shows: 1,
  show: 1, tv: 1, television: 1, series: 1, anime: 1, episodes: 1,
  episode: 1, seasons: 1, season: 1, complete: 1, collection: 1, media: 1,
  downloads: 1, download: 1, desktop: 1, documents: 1, tmp: 1, temp: 1,
  data: 1, unsorted: 1, new: 1, misc: 1, other: 1, public: 1, share: 1,
  users: 1, user: 1, volume: 1, mediafolder: 1,
  // What a Plex or Jellyfin library puts *below* the show folder. The walk
  // stops at the closest real-looking name, so without these a file in
  // "Severance/Specials/01.mkv" was identified as a show called "Specials".
  specials: 1, extra: 1, extras: 1, bonus: 1, featurettes: 1, trailers: 1,
  scenes: 1, behindthescenes: 1, interviews: 1, bloopers: 1, samples: 1,
  omake: 1, deleted: 1, deletedscenes: 1, subs: 1, subtitles: 1,
  staffel: 1, saison: 1, staffeln: 1, temporada: 1
};

// Descriptor folders that sit inside a season folder, which the walk steps over
// rather than stopping at. FOLDER_NOISE stops the walk because a container name
// says nothing about what is above it; "4K" and "Official" say nothing either,
// but stopping there throws the show away, and "Severance/Season 2/4K/05.mkv"
// has a perfectly good show two segments up.
var FOLDER_SKIP = {
  "4k": 1, "8k": 1, "official": 1, "unrated": 1, "finalcut": 1, "directorscut": 1,
  "extendedcut": 1, "uncut": 1, "theatrical": 1, "remastered": 1, "proper": 1,
  "dualaudio": 1, "dual": 1, "dubbed": 1, "original": 1, "complete": 1,
  "english": 1, "german": 1, "spanish": 1, "french": 1, "italian": 1, "japanese": 1,
  "multi": 1, "hdr": 1, "dolby": 1, "vision": 1, "hdr10": 1, "sdr": 1,
  "audio": 1, "cut": 1, "final": 1, "directors": 1, "extended": 1,
  "remux": 1, "web": 1, "webdl": 1, "bluray": 1, "uhd": 1, "hd": 1, "dl": 1
};

// Every word of a segment has to be descriptor noise for the walk to step over
// it. Matching the whole segment missed "4K HDR" and "Official 4K", which Plex
// writes inside season folders, and each one became the name of the show.
function isDescriptorFolder(seg) {
  var words = seg.toLowerCase().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return false;
  return words.every(function(w) { return FOLDER_SKIP[w.replace(/['’]/g, "")] === 1; });
}

// Words that a bracket group can be made entirely of without being a series
// name. Fansubs label the audio and subtitle tracks this way, and a multi-word
// group is otherwise trusted first, so "[SubsPlease] Frieren - 21 [Dual Audio]"
// searched for "Dual Audio" before it searched for the show.
var BRACKET_NOISE = {
  multiple: 1, multi: 1, subtitle: 1, subtitles: 1, subs: 1, sub: 1,
  audio: 1, dual: 1, batch: 1, uncensored: 1, dubbed: 1, english: 1,
  softsub: 1, hardsub: 1, softsubs: 1, hardsubs: 1, burn: 1, burnt: 1
};

// How far up the tree to look. "Show/Season 2/05.mkv" needs two levels, and
// past three the names belong to the disk, not the show.
var FOLDER_LOOKUP_DEPTH = 5;

function pathSegments(url) {
  var s = String(url || "");
  try { s = decodeURIComponent(s); } catch(e) {}
  s = s.split("#")[0].split("?")[0];
  var parts = s.split("/").filter(Boolean);
  // Drop the filename so only directories are left. A part with no extension
  // is assumed to be a directory, which is why a bare "05" cannot be mistaken
  // for a show title.
  if (parts.length && /\.[a-z0-9]{2,4}$/i.test(parts[parts.length - 1])) parts.pop();
  return parts;
}

// A name that cannot be a show title, however it is spelled.
function isRealTitle(t) {
  if (!t || t.length < 2) return false;
  // Digits alone are an episode number or a year rather than a name, except where
  // film really is called "1917", which is why the caller only discards these
  // when a directory name is available to take their place.
  if (/^\d+$/.test(t)) return false;
  return !isPlaceholderTitle(t);
}

// A word that stands in for a title rather than being one. Kept separate from
// isRealTitle because these can be discarded outright, whereas a numeric title
// like "1917" is a real one and may only be replaced, never dropped. Anchored
// to the end so that a title merely starting with the letters, such as
// "E.V.A.", is not mistaken for one.
function isPlaceholderTitle(t) {
  if (!t) return false;
  var s = t.trim();
  if (/^(?:episode|ep|e|part|pt|disc|cd|dvd|vol|volume|file|track)\.?$/i.test(s)) return true;
  // Release noise on its own is a placeholder as well. "WEB" is all that is
  // left of "S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv": it names nothing, and
  // a directory beside it was the better answer all along. Only the case where
  // every single word is noise counts, so "Severance Extended" keeps its
  // cleanup while "WEB" gives way.
  var words = s.split(/\s+/);
  return words.every(function(w) {
    w = w.toLowerCase();
    return TRAILING_JUNK[w] === 1 || JUNK_WORDS.indexOf(w) !== -1;
  });
}

// Directory names only, so ["Severance", "Season 2"] for
// "file:///…/Severance/Season 2/05.mkv".
