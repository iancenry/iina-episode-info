// ── File changed ──────────────────────────────────────────────
// URL-aware. A URL we've already identified restores instantly, but only
// if the remembered episode still agrees with the filename. A stale entry
// (typically a mis-pick saved against the wrong file) is re-identified
// rather than silently replayed.
iina.onMessage("fileChanged", function(d){
  var nextUrl = (d && d.url) || "";
  // A repeat of the message for the file already playing is a no-op, and it
  // has to be: main.js re-sends this on the sidebar-ready handshake. Returning
  // here is what leaves the in-flight lookup's timer and its eventual result
  // intact. Treating it as a fresh event cancelled the timer, and the lookup
  // then abandoned its own result because the timer it was waiting on had
  // gone, so the file silently failed to identify.
  if (nextUrl === currentVideoUrl) return;
  currentVideoUrl = nextUrl;
  invalidateLookups();

  // Reset search panel state regardless
  document.getElementById("q").value = "";
  selShow = null; selSeason = null; episodeCache = []; resetPanel();
  paintPinState();

  var map   = loadUrlMap();
  var saved = currentVideoUrl ? map[currentVideoUrl] : null;

  // Parsed unconditionally, not only when there is something cached: the pin
  // writer needs to know which directory supplied the title, and a lazy parse
  // would leave it working from whichever file happened to be parsed last.
  var now = parseFilename(currentVideoUrl);

  // The filename is ground truth for season/episode, and for a film's year;
  // the cache is only authoritative about which show it is.
  var stale = false;
  if (saved) {
    if (now && now.code) {
      stale = Number(saved.season || 0)  !== now.code.season ||
              Number(saved.episode || 0) !== now.code.episode;
    } else if (now && now.absolute) {
      // An absolute number is ground truth for the episode too, but S21E62
      // cannot be compared with "[1062-1063]" without the show's season totals,
      // which are not loaded here and would cost a request on every replay.
      // The entry records the number it was built from instead. An entry
      // written before that field existed has nothing to compare, so it is
      // re-identified once, exactly as a missing logoUrl or context is.
      stale = (saved.absoluteFrom === undefined) || saved.absoluteFrom !== now.absolute;
    } else if (now && now.isMovie && saved.isMovie) {
      // A film identified under a different year is the wrong film.
      stale = yearOf(saved.airDate || saved.code) !== yearOf(now.year);
    } else if (now && now.isMovie && !saved.isMovie) {
      stale = true;   // an episode identification on a film
    }
    // An entry with no logoUrl key at all was saved before title treatments
    // existed, so it would restore as plain text forever. Re-identify once:
    // the refreshed entry always has the key, empty or not, and a title with
    // genuinely no logo refreshes only this one time.
    if (saved.logoUrl === undefined) stale = true;
    // Same for the series context line, added later. Both writers now always
    // store the key. A film stores an empty string, exactly as it does for
    // logoUrl, so an absent key means only one thing: an entry written
    // before the field existed.
    if (saved.context === undefined) stale = true;
  }

  if (saved && !stale) {
    // URL is already identified and still correct, so restore it silently.
    try { localStorage.setItem("epinfo_ep", JSON.stringify(saved)); } catch(e) {}
    saveCurrentUrlInfo(saved);   // refresh lastSeen so it never ages out
    showSaved(saved);
    iina.postMessage("setSceneMarks", { marks: marksFor(saved) });
    iina.postMessage("episodeSelected", saved);
    if (typeof paintMarks === "function") paintMarks();
  } else if (!autoIdentify(currentVideoUrl)) {
    // Nothing usable in the filename, so fall back to a manual prompt.
    try { localStorage.removeItem("epinfo_ep"); } catch(e) {}
    document.getElementById("saved").classList.remove("on");
    iina.postMessage("setSceneMarks", { marks: [] });
    iina.postMessage("clearEpisode", {});
    if (typeof paintMarks === "function") paintMarks();
  }
  // else: autoIdentify is running and will replace the stale entry.
});
