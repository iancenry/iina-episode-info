// ── Pick ──────────────────────────────────────────────────────
function pickItemByIndex(i) {
  var cache = document.getElementById("panel")._searchCache;
  if (!cache || !cache[i]) return;
  pickItem(cache[i]);
}

function pickItem(item) {
  selShow   = item;
  selSeason = null;
  episodeCache = [];
  showLogoUrl = "";
  showTotals = null;

  if (item.media_type === "movie") {
    document.getElementById("panel").innerHTML =
      '<div class="msg"><span class="sp"></span>Loading…</div>';
    fetch("https://api.themoviedb.org/3/movie/"+item.id+"?api_key="+TK+"&append_to_response=images")
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d || !d.title) {
          document.getElementById("panel").innerHTML = '<div class="msg">Failed to load.</div>';
          return;
        }
        var info = movieInfo(d);
        saveSelection(info);
        rememberFolderPin(info);   // a no-op for films, by design
      }).catch(function(){
        document.getElementById("panel").innerHTML='<div class="msg">Failed to load.</div>';
      });
    return;
  }

  document.getElementById("panel").innerHTML =
    '<div class="msg"><span class="sp"></span>Loading seasons…</div>';
  fetch("https://api.themoviedb.org/3/tv/"+item.id+"?api_key="+TK+"&append_to_response=images")
    .then(function(r){return r.json();})
    .then(function(show){
      // The same dead end applyShowDetail guards against: an error body has no
      // seasons, which rendered a "Season" heading over zero pills.
      if (!show || !show.seasons) {
        resetPanel();
        return;
      }
      selShow._name    = show.name;
      selShow._seasons = (show.seasons||[]).filter(function(s){return s.season_number>0;});
      showLogoUrl      = pickLogo(show.images);
      showTotals       = {
        seasons: show.number_of_seasons || selShow._seasons.length || null,
        episodes: show.number_of_episodes || null
      };
      renderSeasons();
    }).catch(function(){
      document.getElementById("panel").innerHTML='<div class="msg">Failed to load seasons.</div>';
    });
}

function renderSeasons() {
  if (!selShow||!selShow._seasons) return;
  var pills = "";
  selShow._seasons.forEach(function(s){
    pills += '<button class="pill'+(selSeason===s.season_number?" on":"")+
      '" onclick="pickSeason('+s.season_number+')">S'+
      String(s.season_number).padStart(2,"0")+'</button>';
  });
  document.getElementById("panel").innerHTML =
    '<div class="sec"><div class="sl">Season</div><div class="pills">'+pills+'</div></div>' +
    '<div id="ep"></div>';
  if (selSeason!==null) renderEps(selSeason);
}

function pickSeason(n){ selSeason=n; renderSeasons(); }

// autoEp: when set, the episode is picked automatically as soon as the list
// loads. This is what the filename-detection path uses.
function renderEps(sNum, autoEp, token) {
  var el = document.getElementById("ep");
  if (!el) return;
  el.innerHTML = '<div class="msg"><span class="sp"></span>Loading episodes…</div>';
  fetch("https://api.themoviedb.org/3/tv/"+selShow.id+"/season/"+sNum+"?api_key="+TK)
    .then(function(r){return r.json();})
    .then(function(s){
      if (!tokenLive(token)) return;
      // A season that 404s, or an auth failure, resolves with a body carrying
      // no episodes. Rendering "Episode" above an empty pill row is a dead
      // end with no way out, so say so instead. Tested on the field actually
      // used below, not on an id nothing reads.
      if (!s || !s.episodes) {
        el.innerHTML = '<div class="msg">Couldn\'t load that season. Search again above.</div>';
        return;
      }
      // Store season poster for overlay
      seasonPosterUrl = s.poster_path
        ? IW + s.poster_path
        : (selShow && selShow.poster_path ? IW + selShow.poster_path : "");
      // FIX: Cache episodes in a plain JS array. Buttons use integer
      // indices only, with no JSON or encoding in onclick attributes.
      // Previously, ep.name/ep.overview with " characters would corrupt
      // the onclick HTML and silently disable specific episode buttons.
      episodeCache = s.episodes || [];

      var pills = "";
      episodeCache.forEach(function(ep, i){
        var label = "E" + String(ep.episode_number).padStart(2,"0");
        // Use htmlEsc for tooltip; no data at all in onclick
        pills += '<button class="pill" title="'+htmlEsc(ep.name||"")+
          '" onclick="pickEp('+i+')">'+label+'</button>';
      });
      el.innerHTML =
        '<div class="sec" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)">' +
        '<div class="sl">Episode</div><div class="pills">'+pills+'</div></div>';

      if (autoEp) {
        for (var i = 0; i < episodeCache.length; i++) {
          if (episodeCache[i].episode_number === autoEp) { pickEp(i, true); return; }
        }
        // Episode not in this season (bad parse, or season mismatch).
        // Leave the pills up so the user can correct it in one click.
        el.innerHTML = '<div class="msg" style="padding:6px 0">'
          + htmlEsc(selShow._name || "") + ' has no episode '
          + htmlEsc(String(autoEp)) + ' in season ' + htmlEsc(String(sNum))
          + ': pick below.</div>' +
          '<div class="sec" style="margin-top:8px"><div class="pills">'+pills+'</div></div>';
      }
    }).catch(function(){
      if (!tokenLive(token)) return;
      el.innerHTML='<div class="msg">Failed to load episodes.</div>';
    });
}

// The release year out of a TMDB date string, used wherever one is needed.
function yearOf(dateStr) {
  var m = /(19|20)\d{2}/.exec(String(dateStr || ""));
  return m ? m[0] : "";
}

function epCode(s, e) {
  return "S" + String(s).padStart(2, "0") + "E" + String(e).padStart(2, "0");
}

// Where this episode sits, and when the next one is due. Both figures come
// out of the season response the picker already fetched, so showing them costs
// no extra round trip.
function seriesContext(sNum, ep) {
  var bits = [];
  if (showTotals) {
    bits.push("Season " + sNum + (showTotals.seasons ? " of " + showTotals.seasons : ""));
  }
  // Only claim a total when the episode really is inside it: a season that
  // TMDB lists partially would otherwise render "Episode 3 of 2".
  if (episodeCache.length && ep.episode_number <= episodeCache.length) {
    bits.push("Episode " + ep.episode_number + " of " + episodeCache.length);
  }
  var i = episodeCache.indexOf(ep);
  var next = i >= 0 ? episodeCache[i + 1] : null;
  if (next) {
    bits.push("Next " + epCode(sNum, next.episode_number) + (next.air_date ? " " + next.air_date : ""));
  }
  return bits.join("  ·  ");
}

// FIX: pickEp now takes an integer index, not an encoded JSON string.
// `auto` marks a pick the plugin made for itself rather than one the user
// clicked. Only a click counts as evidence the user endorses the pairing, so
// only a click is allowed to pin a folder.
function pickEp(idx, auto) {
  var ep = episodeCache[idx];
  if (!ep) return;
  // selShow is cleared on every file change, so a season response that lands
  // late can reach here with nothing to describe. Previously that threw, and
  // the rejection was absorbed by renderEps' catch, which turned a real bug
  // into silence.
  if (!selShow) return;
  // Captured now rather than read from the module later: a response that
  // arrives after the user has moved on must not act on the new file. (The
  // staleness itself is checked by renderEps, before this is ever reached.)
  var pickDir = currentParsed && currentParsed.titleDir;
  var info = {
    showTitle: selShow._name||selShow.name||"",
    epTitle:   ep.name||("Episode "+ep.episode_number),
    code:      epCode(selSeason, ep.episode_number),
    context:   seriesContext(selSeason, ep),
    airDate:   ep.air_date||"",
    rating:    ep.vote_average?ep.vote_average.toFixed(1):"",
    overview:  ep.overview||"",
    posterUrl: seasonPosterUrl || (selShow && selShow.poster_path ? IW + selShow.poster_path : ""),
    logoUrl: showLogoUrl,
    tmdbId: String(selShow.id), season: selSeason, episode: ep.episode_number, isMovie: false,
    // The absolute number this entry was derived from, or null when the
    // filename carried none. S21E62 cannot be compared with "[1062-1063]"
    // without the show's season totals, which are not loaded here, so the
    // number that produced the entry is recorded instead. See the staleness
    // check in the fileChanged handler.
    absoluteFrom: currentParsed ? (currentParsed.absolute || null) : null
  };
  saveSelection(info);
  if (!auto) rememberFolderPin(info, pickDir);
}

// Record "this directory is that show", so every other file in it stops
// needing the guesswork. Called from manual picks only: an automatic match is
// not evidence the user would have chosen it, and a wrong pin would then apply
// to every remaining file in the folder.
function rememberFolderPin(info, dir) {
  if (!info || info.isMovie) return;
  try {
    if (localStorage.getItem("epinfo_pin_remember") === "false") return;
  } catch (e) { return; }
  // Only a directory that supplied the title is worth pinning. In a flat
  // library the parent is usually the whole media folder, and pinning that to
  // one show would be actively wrong. The directory is passed in by the caller
  // rather than read from the module, so a late response cannot pin whatever
  // folder happens to be playing now.
  if (!dir) return;
  var m = loadFolderMap();
  m[dir] = {
    tmdbId: String(info.tmdbId || ""),
    name: info.showTitle || "",
    season: info.season,
    lastSeen: Date.now()
  };
  saveFolderMap(m);
  paintPinState();
}

// Reflect the pin, if any, for the file that is playing now.
function paintPinState() {
  var el = document.getElementById("pin-state");
  if (!el) return;
  var pin = currentVideoUrl ? pinForUrl(currentVideoUrl) : null;
  if (!pin) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "block";
  el.innerHTML = '<span class="pin-lbl">Folder pinned to <b>' + htmlEsc(pin.show.name || "?")
    + '</b></span>'
    + '<button class="pin-x" onclick="doUnpinFolder()" title="Forget this folder">\u2715</button>';
}

function doUnpinFolder() {
  invalidateLookups();
  var pin = currentVideoUrl ? pinForUrl(currentVideoUrl) : null;
  if (pin) unpinFolder(pin.dir);
  paintPinState();
  // Forget the identification too, so the very next play re-derives it rather
  // than replaying the pick the pin was standing in for.
  clearCurrentUrlFromMap();
  try { localStorage.removeItem("epinfo_ep"); } catch (e) {}
  document.getElementById("saved").classList.remove("on");
  selShow = null; selSeason = null; episodeCache = []; showTotals = null;
  iina.postMessage("clearEpisode", {});
  resetPanel();
  autoIdentify(currentVideoUrl);
}

function doSetPinRemember(on) {
  try { localStorage.setItem("epinfo_pin_remember", on ? "true" : "false"); } catch (e) {}
}

function saveSelection(info) {
  try{localStorage.setItem("epinfo_ep", JSON.stringify(info));}catch(e){}
  saveCurrentUrlInfo(info); // remember per-URL
  pushRecent(info);         // and to the recent picks list
  showSaved(info);
  // The marks for this identification travel ahead of the selection, so the
  // cue pipeline has them by the time it resolves.
  iina.postMessage("setSceneMarks", { marks: marksFor(info) });
  iina.postMessage("episodeSelected", info);
  if (typeof paintMarks === "function") paintMarks();
  document.getElementById("panel").innerHTML =
    '<div class="ok" style="padding:8px 0">✓ Saved</div>';
  selShow      = null;
  selSeason    = null;
  episodeCache = [];
}
