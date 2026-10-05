// ── Title treatment (TMDB "logos") ─────────────────────────────────
// TMDB carries the official title artwork (the KUNG FU PANDA / AVENGERS
// style wordmarks) but not in the details response. It arrives via
// `append_to_response=images`, so it costs no extra round trip.
//
// The array is a mess to pick from: for Fight Club it holds 26 entries
// across a dozen languages and aspect ratios from 0.85 (a stacked poster
// variant) to 8.5 (a thin wordmark). Title treatments are the wide ones,
// so anything squarer than 2.5:1 is rejected outright, then the best-rated
// of what remains wins. Returns null when the title has no usable logo,
// which is common, and the caller falls back to text.
function pickLogo(images) {
  var logos = (images && images.logos) || [];
  var best = null, bestScore = -1;
  for (var i = 0; i < logos.length; i++) {
    var l = logos[i];
    if (!l || !l.file_path) continue;
    // Only English or language-neutral artwork; a Hebrew or Portuguese
    // wordmark would be wrong here.
    if (l.iso_639_1 && l.iso_639_1 !== "en") continue;
    if (!(l.aspect_ratio >= 2.5)) continue;
    // Vote average is TMDB's own quality signal for an image. Reward a
    // genuinely wide wordmark, but not so much that a 8:1 hairline with a
    // 79px height beats a solid 4:1 one.
    var wide = l.aspect_ratio >= 3 ? 1 : 0;
    var score = wide * 2 + (l.vote_average || 0);
    if (score > bestScore) { bestScore = score; best = l; }
  }
  // w780 keeps a wide wordmark crisp on Retina without pulling the
  // multi-megabyte original.
  return best ? IL + best.file_path : "";
}

// The one place a film record is built. It used to be written out twice, once
// per route, and the copies had already drifted: one took the id from the detail
// response and the other from the search result.
function movieInfo(d) {
  return {
    showTitle:  "Movie",
    epTitle:    d.title,
    // No `code` for a film: it held the year, and airDate already begins with
    // the year, so the card rendered "2011 · 2011-06-03".
    airDate:    d.release_date || "",
    rating:     d.vote_average ? d.vote_average.toFixed(1) : "",
    overview:   d.overview || "",
    posterUrl:  d.poster_path ? IW + d.poster_path : "",
    logoUrl:    pickLogo(d.images),
    // A film has no season, but the key has to exist so the staleness check
    // can tell an old entry from a film.
    context:    "",
    tmdbId:     String(d.id),
    season:     null,
    episode:    null,
    isMovie:    true
  };
}

// The detail response is in hand; save it. Shared by the ladder match, the
// IMDb lookup and the manual pick, which each fetch it themselves.
function saveMovieDetail(d, token) {
  if (!currentVideoUrl || !d || !d.title) { resetPanel(); return; }
  if (!tokenLive(token)) return;
  saveSelection(movieInfo(d));
}

// Turn a matched movie into the same shape saveSelection expects.
function applyAutoMovie(item, token) {
  fetch("https://api.themoviedb.org/3/movie/" + item.id + "?api_key=" + TK + "&append_to_response=images")
    .then(function(r) { return r.json(); })
    .then(function(d) { saveMovieDetail(d, token); })
    .catch(function() { if (tokenLive(token)) resetPanel(); });
}

// A refused TMDB request resolves with a body carrying status_code and
// status_message, and no results array. It is not a rejection, so the .catch
// below never sees it. Read as "no matches" it blamed the filename for a
// transient failure, and the ladder then spent every remaining candidate
// asking the same refused question, which made the limit worse for the next
// file as well. Anything that is not a results array is treated as a failed
// lookup instead: one request, and an honest message.
function tmdbRefused(data) {
  if (!data || !("results" in data)) return true;
  return !Array.isArray(data.results);
}

// /search/movie and /search/tv results carry no media_type, because the
// endpoint already said which one it was. The shared result renderer routes on
// media_type and labels the row from it, so a copy is tagged rather than the
// response mutated: `list` is sorted in place a few lines later, and the
// suggestions should not reorder themselves after the ranking is done.
function tagResults(list, kind) {
  return list.map(function(x) {
    var tagged = {};
    for (var k in x) {
      if (Object.prototype.hasOwnProperty.call(x, k)) tagged[k] = x[k];
    }
    tagged.media_type = kind;
    return tagged;
  });
}

// Identify the file that just opened, without the user touching anything.
// Handles both a TV episode (episode code in the name) and a film (no code
// but a release year).
function autoIdentify(url) {
  var parsed = parseFilename(url);
  if (!parsed || !TK) return false;

  // Already searching this URL, under the epoch that started the current
  // lookup. A duplicate fileChanged must leave the lookup alone, so nothing is
  // cancelled and no epoch is burned here. The value is the token rather than a
  // bare true: entries outlive the lookup that made them whenever it is
  // abandoned (the user played another file, or the pinned path never cleared
  // one), and a plain flag left behind made that URL un-identifiable forever.
  // Keying on the epoch lets a later visit see the stale entry, move past it and
  // try again.
  if (autoInFlight[url] && autoInFlight[url].epoch === lookupEpoch) return true;

  // Claim this lookup before anything else can return early. The token has to
  // exist before the pin branch below, which also starts async work: created
  // after it, myToken would be undefined there and tokenLive(undefined) is
  // true, leaving the pinned path with no guard at all.
  var myToken = { epoch: ++lookupEpoch, url: url };
  function live() { return tokenLive(myToken); }
  // Only ever clears our own claim: a newer lookup for the same URL has already
  // replaced it, and dropping that one would let a duplicate event double up.
  function clearClaim() { if (autoInFlight[url] === myToken) delete autoInFlight[url]; }
  autoInFlight[url] = myToken;
  autoCancelTimer();

  // A folder the user has already told us what it holds. This outranks
  // everything: no search, no ladder, one request for the show itself.
  var pin = pinForUrl(url);
  if (pin && pin.show.tmdbId) {
    touchPin(pin.dir);
    applyPinnedShow(pin, parsed, myToken);
    return true;
  }

  // Need something to search by: an episode code, a film's year, an IMDb id, or
  // a series name recovered from a bracket group. A name with none of those is
  // left for the manual search, which is deliberate: "Some Random Home Video"
  // would otherwise cost three TMDB requests per playback to be told it is not
  // on TMDB.
  var hasSubject = parsed.code || parsed.absolute || parsed.isMovie ||
                   parsed.imdbId ||
                   (parsed.altTitles && parsed.altTitles.strong.length);
  if (!hasSubject) {
    // Nothing to search for, so this lookup is over before it began.
    clearClaim();
    return false;
  }

  var panel = document.getElementById("panel");
  panel.innerHTML = '<div class="msg"><span class="sp"></span>Matching '
    + htmlEsc(parsed.fileName) + '…</div>';

  // How many bracket-derived names to try before the filename's own title.
  var MAX_ALT_TITLES = 2;

  // A fansub's bracket group is the series, so those names go first; in a
  // scene release the same slot is a release-group tag, so the filename's own
  // title has to be tried before the single-word ones. titleScore settles
  // which case a given filename is, which is why the ordering only decides how
  // many queries get spent, not what gets picked.
var alt = parsed.altTitles || { strong: [], weak: [] };
  var candidates = [];
  // De-duplicated across the sources. The filename's title is often already one
  // of the bracket groups, and asking TMDB the same question twice costs a
  // round trip and tells us nothing new.
  [].concat(alt.strong.slice(0, MAX_ALT_TITLES),
            titleCandidates(parsed.title),
            alt.weak).forEach(function(c) {
    if (candidates.indexOf(c) === -1) candidates.push(c);
  });
  candidates = candidates.slice(0, AUTO_MAX_TRIES);
  // Best plausible match seen so far, kept so that a ladder which finds
  // nothing better can still land instead of giving up.
  var bestSeen = null;
  // The first non-empty result set the ladder saw, kept to be offered back.
  // A film the year gate or the name score refuses is usually right there in
  // what TMDB already returned, and discarding it left the user with a search
  // box and nothing else. Only the first set is kept: it came from the longest
  // candidate, which is the one that had any chance of matching.
  var suggestions = [];

  function giveUp(msg) {
    if (!live()) { clearClaim(); return; }
    clearClaim();
    autoCancelTimer();
    // Rows only when there are rows. A lookup that failed for a reason no
    // result can fix (a rate limit, a dead key) has nothing to offer, and a
    // list there would be a different kind of lie.
    if (suggestions.length) { renderSearchResults({ results: suggestions }, msg); return; }
    panel.innerHTML = '<div class="msg">' + msg + '</div>';
  }

  function commit(item) {
    autoCancelTimer();
    if (!live()) { clearClaim(); return; }
    document.getElementById("q").value = item.title || item.name || "";
    if (parsed.isMovie) applyAutoMovie(item, myToken);
    else applyAutoMatch(item, parsed.code, parsed.absolute, myToken);
  }

  // Try each candidate in turn; the first with results wins.
  function attempt(i) {
    if (i >= candidates.length) {
      // Out of candidates. A weak earlier match still beats nothing, as long
      // as it named something at all.
      if (bestSeen && bestSeen.score >= AUTO_WEAK_SCORE) { commit(bestSeen.item); return; }
      giveUp("No match for " + htmlEsc(parsed.fileName) + ": search above.");
      return;
    }
    var endpoint = parsed.isMovie ? "search/movie" : "search/tv";
    var q = encodeURIComponent(candidates[i]);
    fetch("https://api.themoviedb.org/3/" + endpoint + "?api_key=" + TK + "&query=" + q)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!live()) { clearClaim(); return; }
        clearClaim();
        if (tmdbRefused(data)) { giveUp("Lookup failed. Search above."); return; }
        var list, pick;

if (parsed.isMovie) {
            list = (data.results || []).filter(function(x) { return x.title; });
            if (!list.length) return attempt(i + 1);
            if (!suggestions.length) suggestions = tagResults(list, "movie");
            // A matching release year is a far stronger signal than votes, because
            // remakes share titles, so "Footloose 1984" must not pick 2011. The name
            // comes first of all: sorting on votes and the year alone picked "Star
            // Wars" for "Star.Wars.Episode.IV.-.A.New.Hope.1977", because both were
            // 1977 and the shorter title has more votes.
            var year = String(parsed.year);
            function filmRank(x) {
              return titleScore(candidates[i], x.title) * 100 +
                     (yearOf(x.release_date) === year ? 10 : 0) +
                     Math.min(1, (x.vote_count || 0) / 10000);
            }
            list.sort(function(a, b) { return filmRank(b) - filmRank(a); });
            pick = list[0];
            // Only auto-accept a film when the name agrees and the year does too,
            // or when there was nothing else: guessing a remake is worse than
            // asking.
            if ((titleScore(candidates[i], pick.title) < AUTO_MIN_SCORE ||
                 yearOf(pick.release_date) !== year) && list.length > 1) {
              return attempt(i + 1);
            }
          } else {
          list = (data.results || [])
            .filter(function(x) { return x.media_type !== "movie" && x.name; });
          if (!list.length) return attempt(i + 1);
          if (!suggestions.length) suggestions = tagResults(list, "tv");
          // Rank by how well each result's name matches the candidate it came
          // from, using votes only to break a tie between equally good names.
          // Taking the highest-voted result outright is what let a show that
          // merely shares a prefix win.
          var ranked = list.map(function(x) {
            return { item: x, score: titleScore(candidates[i], x.name || "") };
          }).sort(function(a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return (b.item.vote_count || 0) - (a.item.vote_count || 0);
          });
          if (!bestSeen || ranked[0].score > bestSeen.score) bestSeen = ranked[0];
          // A poor name match means this candidate is still carrying noise,
          // so try a shorter one rather than committing to the wrong show.
          if (ranked[0].score < AUTO_MIN_SCORE && i + 1 < candidates.length) return attempt(i + 1);
          pick = ranked[0].item;
        }

        commit(pick);
      })
      .catch(function() {
        // A network failure will hit every candidate; don't hammer TMDB.
        giveUp("Lookup failed. Search above.");
      });
  }

  // An IMDb id in the filename is a direct answer, so it is tried before the
  // ladder: one request instead of up to AUTO_MAX_TRIES, and no chance of
  // picking a same-prefixed show. A miss here is not fatal: the ladder still
  // runs, so an id TMDB does not know costs one extra round trip and no
  // behaviour.
  function lookupImdb() {
    // With no episode code there is nothing to select inside a season, so
    // only a film can be resolved from the id alone.
    var asMovie = !parsed.code;
    var endpoint = asMovie ? "movie" : "tv";
    return fetch("https://api.themoviedb.org/3/" + endpoint + "/find/" + parsed.imdbId
      + "?api_key=" + TK + "&append_to_response=images")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!live()) { clearClaim(); return false; }
        clearClaim();
        // An unknown id comes back as a 404 body with no id on it.
        if (!d || !d.id) return false;
        if (asMovie) { autoCancelTimer(); saveMovieDetail(d, myToken); return true; }
        applyShowDetail(d, parsed.code, parsed.absolute, myToken);
        return true;
      })
      .catch(function() { return false; });
  }

  autoTimerId = setTimeout(function() {
    autoTimerId = null;
    if (!live()) return;
    giveUp("Couldn\'t match " + htmlEsc(parsed.fileName) + ": search above.");
  }, AUTO_SEARCH_MS);

  if (parsed.imdbId) {
    lookupImdb().then(function(found) { if (!found) attempt(0); });
  } else {
    attempt(0);
  }
  return true;
}

// An absolute episode number ("[1062-1063]") is not S01E1062. It is whichever
// season's running total first reaches it. TMDB returns an episode_count per
// season in the show response we already have, so the mapping is arithmetic
// rather than another request.
//
// A season with no episode_count is skipped, which is what used to break this.
// The newest seasons of a long-running show have no count until TMDB publishes
// one, so the running total stopped short of the number in the filename and
// this returned null. The caller then opened season 1 because that was the
// first entry in the list, and a One Piece file from season 36 was reported as
// season 1. When the total runs out, the first uncounted season is the only
// place the episode can be, so it is returned with a null episode: the season
// is knowable, the episode inside it is not.
//
// This assumes the source numbering lines up with TMDB's season splits, which
// holds for most long-running series but is not guaranteed. When the total
// falls outside every season and every season is counted, nothing is claimed.
function locateAbsolute(show, absolute) {
  if (!absolute) return null;
  var seasons = (show.seasons || []).filter(function(s) { return s.season_number > 0; });
  var seen = 0, uncounted = null;
  for (var i = 0; i < seasons.length; i++) {
    var count = seasons[i].episode_count || 0;
    if (!count) {
      // Newer than everything counted so far, so the first one is the only
      // candidate for a number past the total.
      if (uncounted === null) uncounted = seasons[i].season_number;
      continue;
    }
    if (absolute <= seen + count) {
      return { season: seasons[i].season_number, episode: absolute - seen };
    }
    seen += count;
  }
  return uncounted === null ? null : { season: uncounted, episode: null };
}

// Wire the picker to a full show detail object, whichever route produced it:
// /tv/{id} after a ladder match, or /tv/find/{imdb_id} when the filename
// carries an IMDb id. Both return the same shape.
function applyShowDetail(show, code, absolute, token) {
  if (!currentVideoUrl) return;
  if (!tokenLive(token)) return;
  // A request that 404s still resolves, with a JSON body carrying no id. That
  // is not a match, and returning quietly would strand the panel on
  // "Matching…", because the give-up timer was already cancelled by the time
  // we get here, so fall back to the search prompt instead.
  if (!show || !show.id) { resetPanel(); return; }
  selShow = show;
  selShow._name = show.name;
  selShow._seasons = (show.seasons || []).filter(function(s) { return s.season_number > 0; });
  showLogoUrl = pickLogo(show.images);
  showTotals = {
    seasons: show.number_of_seasons || selShow._seasons.length || null,
    episodes: show.number_of_episodes || null
  };

  // No code from the filename? An absolute number can still be placed, by
  // adding up the seasons. Failing that, open on the first season.
  var located = code ? { season: code.season, episode: code.episode }
                     : locateAbsolute(show, absolute);
  var auto = located;

  // If the filename named a season the show doesn't have, fall back to
  // the closest real one rather than failing outright.
  var wanted = located ? located.season
                       : (selShow._seasons.length ? selShow._seasons[0].season_number : 1);
  var exists = selShow._seasons.some(function(s) { return s.season_number === wanted; });
  if (!exists && wanted > 1) wanted = 1;
  // The episode belongs to the season we actually landed on, so it has to be
  // re-derived when that season had to be substituted.
  if (auto && auto.season !== wanted) auto = { season: wanted, episode: null };
  selSeason = wanted;

  // Build the same panel shape a manual pick produces, so the season and
  // episode pills stay available for a one-click correction.
  var pills = "";
  selShow._seasons.forEach(function(s) {
    pills += '<button class="pill' + (wanted === s.season_number ? " on" : "") +
      '" onclick="pickSeason(' + s.season_number + ')">S' +
      String(s.season_number).padStart(2, "0") + '</button>';
  });
  document.getElementById("panel").innerHTML =
    '<div class="sec"><div class="sl">Season</div><div class="pills">' + pills + '</div></div>' +
    '<div id="ep"></div>';

  // Without an episode to select, renderEps leaves the pills up and the panel
  // waits for a click rather than guessing which one was meant.
  renderEps(wanted, auto ? auto.episode : null, token);
}

// A pinned folder names its show, so there is nothing to search for: fetch
// that show directly and let the filename decide only the episode. A folder
// full of files the parser cannot read still resolves to the right series.
function applyPinnedShow(pin, parsed, token) {
  fetch("https://api.themoviedb.org/3/tv/" + encodeURIComponent(pin.show.tmdbId)
    + "?api_key=" + TK + "&append_to_response=images")
    .then(function(r) { return r.json(); })
    .then(function(show) { applyShowDetail(show, parsed.code, parsed.absolute, token); })
    .catch(function() { if (tokenLive(token)) resetPanel(); });
}

// Fetch the season list and select the parsed episode in one go.
function applyAutoMatch(item, code, absolute, token) {
  fetch("https://api.themoviedb.org/3/tv/" + item.id + "?api_key=" + TK + "&append_to_response=images")
    .then(function(r) { return r.json(); })
    .then(function(show) { applyShowDetail(show, code, absolute, token); })
    .catch(function() {
      if (tokenLive(token)) resetPanel();
    });
}
