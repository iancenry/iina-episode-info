// ============================================================
// IINA Plugin: Sidekick  @version 1.4.0
// The version is kept in step with Info.json and package.json by a CI check.
// Machine-readable on purpose: the check reads this line, and a header written
// for humans had drifted once already (1.3.1 in a 1.4.0 build, so a bug report
// naming 1.3.1 was really 1.4.0).
// ============================================================

const { core, event, overlay, sidebar, menu } = iina;   // utils and file were never used

// ── Helpers ──────────────────────────────────
// Convert any thrown value / API error payload into a readable string.
// Without this, sidebars could show "Error: [object Object]".
function errStr(e) {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === "object") {
    if (typeof e.message === "string") return e.message;
    if (typeof e.reason  === "string") return e.reason;
    if (e.error)              return errStr(e.error);
    if (e.data && e.data.message) return String(e.data.message);
    try { return JSON.stringify(e); } catch(_) { return "Error"; }
  }
  return String(e);
}


// Race an HTTP promise against a timeout so search never hangs forever.
function withTimeout(p, ms, label) {
  var timer = null;
  return Promise.race([
    p,
    new Promise(function(_, reject) {
      timer = setTimeout(function() {
        reject(new Error((label || "Request") + " timed out after " + Math.round(ms/1000) + "s"));
      }, ms);
    })
  ]).then(function (v) {
    // Disarm on the fast path. Every call used to leave its timeout armed, so
    // one identification kept up to seven timers alive to fire at nothing ten
    // seconds later.
    if (timer !== null) { clearTimeout(timer); timer = null; }
    return v;
  }, function (e) {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    throw e;
  });
}
var HTTP_TIMEOUT_MS = 10000; // Per-call budget; the sidebar enforces the total


// ── Lazy IMDB ID resolver ───────────────────────────
// Resolves BOTH the show-level (parent) and episode-level IMDB ids from TMDB.
// The skip databases are keyed on the show-level id, so that one matters most;
// the episode-level id is resolved alongside it because it is free to fetch in
// parallel and some providers key on it instead.
async function resolveImdbIds(d, tmdbKey) {
  if (!tmdbKey) return d;
  if (!d.tmdbId) return d;

  try {
    if (d.isMovie) {
      if (!d.imdbId) {
        var r = await withTimeout(
          iina.http.get("https://api.themoviedb.org/3/movie/" + d.tmdbId + "/external_ids", {
            params: { api_key: tmdbKey }
          }),
          HTTP_TIMEOUT_MS,
          "TMDB external_ids"
        );
        var body = r.data || JSON.parse(r.text || "{}");
        if (r.statusCode === 200 && body.imdb_id) d.imdbId = body.imdb_id;
      }
    } else {
      // TV: fetch show-level + episode-level in parallel for speed
      var calls = [];
      var needShow = !d.parentImdbId;
      var needEp   = !d.imdbId && d.season && d.episode;

      if (needShow) {
        calls.push(
          withTimeout(
            iina.http.get("https://api.themoviedb.org/3/tv/" + d.tmdbId + "/external_ids", {
              params: { api_key: tmdbKey }
            }),
            HTTP_TIMEOUT_MS,
            "TMDB show external_ids"
          ).then(function(r) {
            var b = r.data || JSON.parse(r.text || "{}");
            if (r.statusCode === 200 && b.imdb_id) d.parentImdbId = b.imdb_id;
          }).catch(function(){})
        );
      }
      if (needEp) {
        calls.push(
          withTimeout(
            iina.http.get("https://api.themoviedb.org/3/tv/" + d.tmdbId
              + "/season/" + d.season + "/episode/" + d.episode + "/external_ids", {
              params: { api_key: tmdbKey }
            }),
            HTTP_TIMEOUT_MS,
            "TMDB episode external_ids"
          ).then(function(r) {
            var b = r.data || JSON.parse(r.text || "{}");
            if (r.statusCode === 200 && b.imdb_id) d.imdbId = b.imdb_id;
          }).catch(function(){})
        );
      }
      if (calls.length) await Promise.all(calls);
    }
  } catch(_e) {}
  return d;
}


// The canonical IMDB id, leading zeros intact. That is the form the skip
// databases key on: tt0773262 returns Dexter's intro, tt773262 returns
// nothing at all.
function canonicalImdb(s) {
  if (!s) return null;
  var t = String(s).trim();
  if (!t) return null;
  return /^tt/i.test(t) ? t : ("tt" + t);
}


var sidebarLoaded      = false;
var currentEpisode     = null;
var pauseTimer         = null;
// When playback last paused. The delay is counted from the pause, so a lookup
// that lands late does not restart the countdown.
var pausedAt           = 0;
var overlayVisible     = false;
var overlayBgOpacity   = 0.72;
var overlayEnabled     = true;   // toggled from sidebar, persisted in sidebar's localStorage
var overlayVerticalPos = 50;     // 0=top, 50=center, 100=bottom
var pauseDelay         = 3;      // seconds before overlay shows on pause
var overlayTheme       = "classic"; // classic | compact | poster
var skipEnabled        = false;  // opt-in: skip intro/recap/credits
var cardVisible        = false;  // info card showing?
var skipVisible        = false;  // skip pill showing?
var segments           = [];     // resolved skip segments for this file
var activeSegment      = null;   // the one the pill is currently offering
var timeWatcher        = null;   // id of the mpv.time-pos observer
var tmdbKey            = "";     // pushed from the sidebar; needed to resolve IMDB ids
var segmentCache       = {};     // "imdb:season:episode" -> segments
var dddEnabled         = false;  // opt-in: scene content warnings from DoesTheDogDie
var dddKey             = "";     // pushed from the sidebar like the TMDB one
var dddLead            = 30;     // seconds before a scene its cue card appears
var dddAutoCard        = true;   // auto-skips show their cancel/undo card even when cues are hidden
var dddCatActions      = {};     // supercategory id -> off | warn | skip | auto
var localMarks         = [];     // the user's own trigger/skip-to pairs, pushed per selection
var scenes             = [];     // resolved scene warnings for this file (DDD + local marks)
var dddFlags           = [];     // flagged topics with no timestamp, for this title
var activeScene        = null;   // the one the cue card is currently offering
var sceneVisible       = false;  // scene cue card showing?
var sceneMode          = null;   // warn | skip | auto | undo, what the card is doing
var lastTimePos        = null;   // previous playhead, for detecting a real crossing
var undoTimer          = null;   // hides the undo card after its pause
var sceneSeq           = 0;      // scene-lookup generation, abandoned like loadSeq
var dddShowCache       = {};     // "tmdbId" -> { ratings: [...], stats: {...} }
var currentVideoUrl    = "";     // url of currently loaded file, sent to sidebar so it can
                                 // restore per-URL TMDB info on re-play

function log(msg) {
  iina.console.log("[EpInfo] " + msg);
  if (sidebarLoaded) sidebar.postMessage("overlayStatus", { text: msg });
}

function showOverlay(d) {
  if (!overlayEnabled) return;
  overlay.postMessage("showData", {
    showTitle:   d.showTitle  || "",
    epTitle:     d.epTitle    || "",
    code:        d.code       || "",
    airDate:     d.airDate    || "",
    rating:      d.rating     || "",
    overview:    d.overview   || "",
    // Where the episode sits in its season and when the next lands. Empty for
    // a film, which has no season.
    context:     d.context    || "",
    posterUrl:   d.posterUrl  || "",
    // TMDB title treatment, when the title has one and it is wide enough to
    // be worth using. Empty string otherwise, and the overlay keeps text.
    logoUrl:     d.logoUrl    || "",
    isMovie:     !!d.isMovie,
    bgOpacity:   overlayBgOpacity,
    verticalPos: overlayVerticalPos,
    theme:       overlayTheme
  });
  overlay.show();
  cardVisible = true;
  overlayVisible = true;
  sidebar.postMessage("overlayShowing", { visible: true });
  log("Showing: " + d.epTitle);
}

function hideOverlay() {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  // Hiding resets the stamp: a pause the user has already spent time on must
  // not count towards the next card. This is what keeps a new file, and a
  // dismissed card, from inheriting the previous pause's elapsed time.
  pausedAt = 0;
  cardVisible = false;
  overlayVisible = false;
  overlay.postMessage("hideCard", {});
  syncOverlay();
  sidebar.postMessage("overlayShowing", { visible: false });
}

// The overlay WebView is shared by the info card, the skip pill and the scene
// cue card. Hide it only when none of them wants to be on screen.
function syncOverlay() {
  if (cardVisible || skipVisible || sceneVisible) overlay.show();
  else overlay.hide();
}


// ── Skip intro / recap / credits ──────────────────────────────
// Chapters in the file first, then the keyless databases in parallel.
// Nothing ever seeks on its own; we only offer a button.

var SEGMENT_LABELS = {
  intro:   "Skip Intro",
  recap:   "Skip Recap",
  outro:   "Skip Credits",
  credits: "Skip Credits",
  preview: "Skip Preview"
};

// Crowdsourced data contains reversed and zero-length ranges.
function validSegment(seg) {
  // Strictly boolean. This is a predicate and is used as one in filters, and
  // it used to hand back whatever falsy value it was given, so `validSegment(x)
  // === false` did not hold.
  return !!(seg && isFinite(seg.start) && isFinite(seg.end) &&
            seg.end > seg.start && seg.end - seg.start >= 3);
}

function pushSegment(list, kind, start, end, source, opts) {
  var seg = {
    kind: kind, start: Number(start), end: Number(end), source: source,
    // A value derived from a null ("from the beginning" / "to the end") is a
    // placeholder, not a measurement, and must not win the estimate.
    preciseStart: !(opts && opts.vagueStart),
    preciseEnd:   !(opts && opts.vagueEnd)
  };
  if (validSegment(seg)) list.push(seg);
}

// 1. Chapters. No network, no coverage problem.
// Chapter has `start` but no `end`: a chapter ends where the next one begins.
function fileDuration() {
  // core.status.duration is null until the file is loaded, and getNumber
  // answers 0 in the meantime. Both are asked, and 0 is a real answer for an
  // unknown duration, so callers must treat it as "not known yet".
  try {
    var d = core.status.duration;
    if (d) return d;
  } catch (e) {}
  try { return iina.mpv.getNumber("duration") || 0; } catch (e) { return 0; }
}

function segmentsFromChapters() {
  var out = [];
  try {
    var chapters = core.getChapters() || [];
    if (chapters.length < 2) return out;
    var duration = fileDuration();

    for (var i = 0; i < chapters.length; i++) {
      var title = String(chapters[i].title || "").trim();
      // Last chapter has no successor, so it ends with the file. getNumber returns
  // 0 until metadata has arrived and there is no other number to ask for, and
  // `if (!end) continue` then dropped the final "Credits" chapter outright.
  // Duration + 1 is only used as a last resort, and every consumer clamps it.
  var end = (i + 1 < chapters.length) ? chapters[i + 1].start : (duration || (fileDuration() + 1));
      if (!end) continue;
      if (/^(op|opening|intro|avant|titles?|opening credits)$/i.test(title)) {
        pushSegment(out, "intro", chapters[i].start, end, "chapters");
      } else if (/^(recap|previously)/i.test(title)) {
        pushSegment(out, "recap", chapters[i].start, end, "chapters");
      } else if (/^(ed|ending|outro|credits|end credits)$/i.test(title)) {
        pushSegment(out, "outro", chapters[i].start, end, "chapters");
      }
    }
  } catch(e) {}
  return out;
}

// 2. The three databases. All key on IMDB id + season + episode, which
//    resolveImdbIds() has already produced for us.
async function segmentsFromApis(imdbId, season, episode) {
  var out = [];
  if (!imdbId) return out;

  var qs = "imdb_id=" + encodeURIComponent(imdbId);
  if (season)  qs += "&season=" + encodeURIComponent(season);
  if (episode) qs += "&episode=" + encodeURIComponent(episode);

  async function grab(label, url, parse) {
    try {
      var r = await withTimeout(
        iina.http.get(url, { headers: { "Accept": "application/json" } }),
        HTTP_TIMEOUT_MS, label
      );
      if (r.statusCode !== 200) return;
      var body = r.data || JSON.parse(r.text || "{}");
      parse(body);
    } catch(e) { /* one dead provider must not break the others */ }
  }

  await Promise.all([
    // IntroDB: /segments returns every type, /intro is intros-only.
    grab("IntroDB", "https://api.introdb.app/segments?" + qs, function(b) {
      ["intro", "recap", "outro"].forEach(function(k) {
        if (b[k]) pushSegment(out, k, b[k].start_sec, b[k].end_sec, "introdb");
      });
    }),
    // TheIntroDB: arrays, and start_ms/end_ms may be null meaning
    // "from the beginning" / "to the end of the file".
    grab("TheIntroDB", "https://api.theintrodb.org/v2/media?" + qs, function(b) {
      var dur = 0;
      try { dur = iina.mpv.getNumber("duration") || 0; } catch(e) {}
      [["intro", "intro"], ["credits", "outro"]].forEach(function(pair) {
        var arr = b[pair[0]];
        if (!Array.isArray(arr)) return;
        arr.forEach(function(x) {
          var vagueStart = (x.start_ms === null || x.start_ms === undefined);
          var vagueEnd   = (x.end_ms   === null || x.end_ms   === undefined);
          var st = vagueStart ? 0   : x.start_ms / 1000;
          var en = vagueEnd   ? dur : x.end_ms   / 1000;
          pushSegment(out, pair[1], st, en, "theintrodb",
                      { vagueStart: vagueStart, vagueEnd: vagueEnd });
        });
      });
    }),
    // SkipDB: 200 with null members when it has nothing.
    grab("SkipDB", "https://api.skipdb.tv/api/segments?" + qs, function(b) {
      var segs = b.segments || {};
      ["intro", "recap", "outro", "preview"].forEach(function(k) {
        var x = segs[k];
        if (!x) return;
        if (typeof x.confidence === "number" && x.confidence < 0.5) return;
        pushSegment(out, k, x.start_ms / 1000, x.end_ms / 1000, "skipdb");
      });
    })
  ]);

  return out;
}


// AniSkip is keyed on MyAnimeList ids, so the IMDB id goes through ARM first.
// ARM returns one entry per season, and an empty array for non-anime.
async function malIdFor(imdbTt, season) {
  try {
    var r = await withTimeout(
      iina.http.get("https://arm.haglund.dev/api/v2/imdb", {
        params: { id: imdbTt, include: "myanimelist" },
        headers: { "Accept": "application/json" }
      }), HTTP_TIMEOUT_MS, "ARM lookup");
    if (r.statusCode !== 200) return null;
    var arr = r.data || JSON.parse(r.text || "[]");
    if (!Array.isArray(arr) || !arr.length) return null;      // not anime
    var e = arr[(Number(season) || 1) - 1] || arr[0];
    return e && e.myanimelist ? String(e.myanimelist) : null;
  } catch(e) { return null; }
}

async function segmentsFromAniSkip(malId, episode) {
  var out = [];
  try {
    var url = "https://api.aniskip.com/v2/skip-times/" + encodeURIComponent(malId) +
              "/" + encodeURIComponent(episode || 1) +
              "?types[]=op&types[]=ed&types[]=recap&episodeLength=0";
    var r = await withTimeout(
      iina.http.get(url, { headers: { "Accept": "application/json" } }),
      HTTP_TIMEOUT_MS, "AniSkip");
    if (r.statusCode !== 200) return out;
    var body = r.data || JSON.parse(r.text || "{}");
    if (!body.found || !Array.isArray(body.results)) return out;
    body.results.forEach(function(x) {
      var kind = { op: "intro", "mixed-op": "intro",
                   ed: "outro", "mixed-ed": "outro",
                   recap: "recap" }[String(x.skipType).toLowerCase()];
      if (!kind || !x.interval) return;
      pushSegment(out, kind, x.interval.startTime, x.interval.endTime, "aniskip");
    });
  } catch(e) {}
  return out;
}

// Merge the providers' answers into one segment per kind. Confidence scores
// are not comparable across services, so segments covering the same stretch
// are grouped and the group backed by the most databases wins.
var SOURCE_ORDER = { chapters: 0, introdb: 1, theintrodb: 2, skipdb: 3 };

// Overlap as a fraction of the shorter segment: 1 = identical, 0 = disjoint.
function overlapRatio(a, b) {
  var lo = Math.max(a.start, b.start);
  var hi = Math.min(a.end, b.end);
  var ov = hi - lo;
  if (ov <= 0) return 0;
  var shortest = Math.min(a.end - a.start, b.end - b.start);
  return shortest > 0 ? ov / shortest : 0;
}

function median(nums) {
  // Never called with an empty list today, but an empty one returned NaN, and
  // this value becomes a segment's end time, where NaN would compare false
  // everywhere and silently disable the skip pill rather than fail loudly.
  if (!nums || !nums.length) return 0;
  var a = nums.slice().sort(function(x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function distinctSources(group) {
  var seen = {};
  group.forEach(function(s) { seen[s.source] = 1; });
  return Object.keys(seen);
}

function bestRank(group) {
  return Math.min.apply(null, group.map(function(s) {
    var r = SOURCE_ORDER[s.source];
    return r === undefined ? 99 : r;
  }));
}

function mergeSegments(list) {
  var byKind = {};
  list.forEach(function(seg) {
    (byKind[seg.kind] = byKind[seg.kind] || []).push(seg);
  });

  return Object.keys(byKind).map(function(kind) {
    var segs = byKind[kind];

    // Cluster segments that describe the same stretch of video.
    var groups = [];
    segs.forEach(function(seg) {
      for (var i = 0; i < groups.length; i++) {
        for (var j = 0; j < groups[i].length; j++) {
          if (overlapRatio(groups[i][j], seg) > 0.5) { groups[i].push(seg); return; }
        }
      }
      groups.push([seg]);
    });

    // Most corroborated group wins; ties go to the more reliable source.
    groups.sort(function(a, b) {
      var d = distinctSources(b).length - distinctSources(a).length;
      if (d !== 0) return d;
      return bestRank(a) - bestRank(b);
    });
    var win = groups[0];

    // Estimate from measured values only, falling back to placeholders if
    // that is genuinely all we have.
    var starts = win.filter(function(s) { return s.preciseStart; }).map(function(s) { return s.start; });
    var ends   = win.filter(function(s) { return s.preciseEnd;   }).map(function(s) { return s.end;   });
    if (!starts.length) starts = win.map(function(s) { return s.start; });
    if (!ends.length)   ends   = win.map(function(s) { return s.end;   });

    var merged = {
      kind:    kind,
      // Earliest start, so the button is up before the intro rolls.
      start:   Math.min.apply(null, starts),
      // Median end: overshooting skips real content, so this is the number
      // that has to be right, and the median resists one bad outlier.
      end:     median(ends),
      sources: distinctSources(win),
      agreed:  distinctSources(win).length
    };
    // A disagreement between sources can merge into something too short to be
    // real ("intro 51.2-54.2" with "intro 36-53.2" lands on 51.2-53.7, under
    // three seconds). The estimate is dropped in favour of one source's own
    // answer rather than the whole kind disappearing: a mediocre pill beats no
    // pill, and only the members that are valid themselves are considered.
    if (validSegment(merged)) return merged;
    var usable = win.filter(validSegment);
    if (!usable.length) return null;
    var pick = usable.slice().sort(function(a, b) { return bestRank(a) - bestRank(b); })[0];
    return {
      kind: pick.kind, start: pick.start, end: pick.end,
      sources: [pick.source], agreed: 1
    };
  }).filter(Boolean);
}

// Bumped whenever the answer must be abandoned: a new file, a cleared
// selection, or skip intro being switched off. resolveSegments awaits network
// calls that can take the best part of 30 seconds, and a run that finishes
// after the user has moved on used to install its segments, restart the time
// observer and show a skip pill for the episode that was playing before.
var loadSeq = 0;

// A run that is abandoned still has to answer, because the sidebar disables
// "Search again" while it waits and re-enables it only on this message. Every
// !live() return used to skip it, which left the button stuck on "Searching…"
// for the rest of the session: nothing re-renders it.
async function resolveSegments(info, forceRefresh) {
  try {
    await resolveSegmentsInner(info, forceRefresh);
  } catch (e) {
    // Every call site is fire-and-forget, so a throw here would be an unhandled
    // rejection and no skipResult would ever be posted: the button would sit on
    // "Searching…" for the rest of the session.
    log("skip lookup failed: " + errStr(e));
  }
}

async function resolveSegmentsInner(info, forceRefresh) {
  var seq = ++loadSeq;
  function live() { return seq === loadSeq; }
  // Reported once, whichever way this run ends: either it installed an answer,
  // or it was superseded and the sidebar needs telling that nothing is coming.
  var reported = false;
  function report(list, stale) {
    if (reported) return;
    reported = true;
    reportSkip(info, list, stale);
  }
  // Stale, not empty. The sidebar clears its "Searching…" button on this
  // message, and also prints what it is told; a superseded run reporting "no
  // segments" made the sidebar say the episode had none and then swallow the
  // real answer behind it.
  function abandoned() { report([], true); }

  segments = [];
  activeSegment = null;
  hideSkip();
  if (!skipEnabled || !info) return;

  var local = segmentsFromChapters();
  // Chapters are the best answer available for most files, and they are free.
  // A forced refresh still asks the databases, because the user asked for
  // another answer: "Search again" checked the cache below and never got here,
  // so for any file that ships chapter markers the button did nothing at all.
  //
  // But it does not replace them. The chapter answer is kept as the fallback:
  // the databases have nothing for most episodes, and reporting "nothing found"
  // while a working pill was thrown away is a worse answer than the one the
  // user already had.
  var chapterAnswer = local.length ? mergeSegments(local) : null;
  if (chapterAnswer && !forceRefresh) {
    segments = chapterAnswer;
    startTimeWatcher();
    report(segments);
    return;
  }

  // Keyed on the SHOW's IMDB id. The episode-level id is cached too, and must
  // never be used here: it is the right key for one episode and returns nothing
  // for every other, which looks exactly like "no intros found".
  function showLevelId() {
    return canonicalImdb(info.isMovie ? info.imdbId : info.parentImdbId);
  }
  var imdb = showLevelId();
  if (!imdb && tmdbKey && info.tmdbId) {
    await resolveImdbIds(info, tmdbKey);
    if (!live()) { abandoned(); return; }
    imdb = showLevelId();
  }
  // No second liveness check here: the line above is synchronous, so nothing
  // can have invalidated this run since the check inside the await block.
  if (!imdb) { report([]); return; }

  var cacheKey = imdb + ":" + (info.season || 0) + ":" + (info.episode || 0);
  if (segmentCache[cacheKey] && !forceRefresh) {
    segments = segmentCache[cacheKey];
    if (segments.length) startTimeWatcher();
    report(segments);
    return;
  }

  // Anime first when it applies: AniSkip has native anime ids and is more
  // precise than the crowdsourced TV databases for openings and endings.
  //
  // Started alongside the TV databases rather than before them. They were
  // sequential, so every non-anime title sat through the whole ARM budget
  // before a single community database was contacted.
  var malPromise = malIdFor(imdb, info.season);
  var remotePromise = segmentsFromApis(imdb, info.season, info.episode);

  var mal = await malPromise;
  if (!live()) { abandoned(); return; }
  var anime = mal ? await segmentsFromAniSkip(mal, info.episode) : [];
  if (!live()) { abandoned(); return; }

  var remote = await remotePromise;
  if (!live()) { abandoned(); return; }
  var merged = mergeSegments(remote);

  // A kind found by AniSkip wins; anything it did not cover falls back to the
  // consensus answer from the TV databases.
  if (anime.length) {
    var byKind = {};
    mergeSegments(anime).forEach(function(x) { byKind[x.kind] = x; });
    merged.forEach(function(x) { if (!byKind[x.kind]) byKind[x.kind] = x; });
    merged = Object.keys(byKind).map(function(k) { return byKind[k]; });
  }
  // The databases had nothing to say, so the chapters still stand.
  if (!merged.length && chapterAnswer) merged = chapterAnswer;
  segments = merged;
  // An empty answer is not cached. [] is truthy, so one outage or one provider
  // hiccup would have pinned the episode to "nothing found" for the session,
  // with only "Search again" able to clear it.
  if (segments.length) {
    rememberSegments(cacheKey, segments);
  }
  if (segments.length) startTimeWatcher();
  report(segments);
}

// Lets the sidebar's "Search again" button stop spinning and report.
// The cache is bounded because nothing else is: one entry per episode watched,
// held for the whole session, and a long evening adds hundreds. Oldest entries
// go first, and the cap is deliberately far above a normal viewing session, so
// the eviction only ever runs for someone who has left it playing.
var SEGMENT_CACHE_MAX = 400;

function rememberSegments(key, list) {
  segmentCache[key] = list;
  var keys = Object.keys(segmentCache);
  if (keys.length > SEGMENT_CACHE_MAX) {
    keys.slice(0, keys.length - SEGMENT_CACHE_MAX).forEach(function(k) {
      delete segmentCache[k];
    });
  }
}

function reportSkip(info, list, stale) {
  sidebar.postMessage("skipResult", {
    count: list.length,
    label: list.length ? describeSegments(list) : "",
    // This run was abandoned, not answered. The sidebar re-enables its button
    // on it and leaves its status line alone.
    stale: !!stale
  });
}


function fmtTime(sec) {
  var m = Math.floor(sec / 60), ss = Math.floor(sec % 60);
  // Hours, once there are any. Without this a 62-minute credits range rendered
  // as "62:05", which reads as a mistake even though it is arithmetically fine.
  if (m >= 60) {
    var hh = Math.floor(m / 60);
    return hh + ":" + (m % 60 < 10 ? "0" : "") + (m % 60) + ":" + (ss < 10 ? "0" : "") + ss;
  }
  return m + ":" + (ss < 10 ? "0" : "") + ss;
}

function describeSegments(list) {
  var parts = list.map(function(seg) {
    var name = (SEGMENT_LABELS[seg.kind] || "Skip").replace("Skip ", "");
    return name + " " + fmtTime(seg.start) + "–" + fmtTime(seg.end);
  });
  return "Found: " + parts.join(" · ");
}

function showSkip(seg) {
  activeSegment = seg;
  skipVisible = true;
  overlay.postMessage("showSkip", { label: SEGMENT_LABELS[seg.kind] || "Skip" });
  syncOverlay();
  // Only while the pill is up, so click-to-pause keeps working otherwise.
  // The button also needs a `data-clickable` attribute; see overlay.html.
  try { overlay.setClickable(true); } catch(e) { log("setClickable(true) failed: " + errStr(e)); }
}

// Never seek to or past the end of the file. A crowd-sourced "to the end"
// marker is stored as the duration itself, so the unadjusted value lands
// exactly on EOF, which is where mpv advances to the next playlist item.
function clampedSeekTarget(target) {
  var duration = 0;
  try { duration = core.status.duration || iina.mpv.getNumber("duration") || 0; }
  catch (e) { duration = 0; }
  if (duration > 0 && target > duration - 0.25) target = Math.max(0, duration - 0.25);
  return target;
}

// The three ways IINA can be asked to seek, most precise first. Returns how it
// was done, or null when every one of them refused.
function seekAbsolute(target) {
  try {
    core.seekTo(target);
    return "core.seekTo";
  } catch(e1) {
    try {
      iina.mpv.command("seek", [String(target), "absolute", "exact"]);
      return "mpv seek absolute";
    } catch(e2) {
      try {
        iina.mpv.set("time-pos", target);
        return "mpv time-pos";
      } catch(e3) {
        iina.console.log("[EpInfo] seek failed: " + errStr(e1) + " / " + errStr(e2) + " / " + errStr(e3));
        return null;
      }
    }
  }
}

// Reachable from the overlay button, the Plugins menu and Alt+S.
function skipNow(via) {
  if (!activeSegment) {
    return;
  }
  // Validate before hiding anything. Clearing the pill first meant a target
  // that could not be seeked left the user with no button and no reason.
  var target = activeSegment.end;
  var kind   = activeSegment.kind;
  if (!(target > 0)) {
    iina.console.log("[EpInfo] refusing to seek to " + target + "s");
    return;
  }
  hideSkip();

  target = clampedSeekTarget(target);
  // A segment that claims to end before it starts would seek backwards.
  if (!(target > 0)) {
    iina.console.log("[EpInfo] refusing to seek to " + target + "s");
    return;
  }

  var how = seekAbsolute(target);
  if (how === null) return;

  iina.console.log("[EpInfo] skipped " + kind + " to " + target + "s via " + how + " (" + via + ")");
}

function hideSkip() {
  if (!skipVisible) return;
  activeSegment = null;
  skipVisible = false;
  overlay.postMessage("hideSkip", {});
  // A clickable scene cue may still be on screen and needing its clicks.
  try { overlay.setClickable(!!(sceneVisible && sceneMode !== "warn")); } catch(e) { log("setClickable failed: " + errStr(e)); }
  syncOverlay();
}

// Driven by the mpv property rather than a timer: a wall-clock timer keeps
// running while paused and is wrong after any seek. The handler stays trivial
// because it fires often. One observer serves both features, each guarded
// inside, so switching either off does not take the other's cueing with it.
function startTimeWatcher() {
  if (timeWatcher) return;
  timeWatcher = event.on("mpv.time-pos.changed", function() {
    var t;
    try { t = iina.mpv.getNumber("time-pos"); } catch(e) { return; }
    if (!isFinite(t)) return;

    // Skip segments: the pill is up while the playhead is inside one.
    if (skipEnabled && segments.length) {
      var hit = null;
      for (var i = 0; i < segments.length; i++) {
        if (t >= segments[i].start && t < segments[i].end) { hit = segments[i]; break; }
      }
      if (hit) {
        if (activeSegment !== hit) showSkip(hit);
      } else if (skipVisible) {
        hideSkip();
      }
    }

    // Scene cues. Two jobs: catch the playhead crossing a scene's start line
    // for an Auto mark, and put the lead card up ahead of the timestamp. Auto
    // is an action rather than a cue, so it fires even when scene cues are
    // hidden — only its card follows the auto-card setting.
    if (scenes.length) {
      // Auto-skip only fires when playback crosses the line in one small step.
      // A seek is a jump larger than SCENE_SEEK_GAP and lands where the user
      // pointed on purpose, so it must not trigger a skip.
      if (lastTimePos != null && t > lastTimePos && (t - lastTimePos) <= SCENE_SEEK_GAP) {
        for (var a = 0; a < scenes.length; a++) {
          var sc = scenes[a];
          if (sc.skipped || sc.cancelled || sc.action !== "auto") continue;
          if (lastTimePos < sc.start && t >= sc.start && sc.safe != null && sc.strong) {
            skipSceneTo(sc);
            break;
          }
        }
      }
      lastTimePos = t;

      // Cards: with the feature on, every scene's lead card; with it off,
      // only auto scenes — and only when their card setting keeps the escape
      // hatch. The undo card owns the overlay until its timer ends.
      if (dddEnabled || dddAutoCard) {
        if (sceneMode === "undo") {
          // A fresh scene's window takes precedence over the receipt.
          for (var u = 0; u < scenes.length; u++) {
            if (scenes[u].skipped) continue;
            if (!dddEnabled && scenes[u].action !== "auto") continue;
            if (scenes[u].action === "auto" && !dddAutoCard) continue;
            if (scenes[u] !== activeScene && t >= scenes[u].start - dddLead && t < scenes[u].start) {
              showSceneCue(scenes[u]);
              break;
            }
          }
        } else {
          // The card comes up ahead of the timestamp by the configured lead
          // and goes away as the scene starts. A scene already skipped stays
          // down, so undoing an auto-skip does not re-offer to skip it again.
          var cue = null;
          for (var j = 0; j < scenes.length; j++) {
            var s2 = scenes[j];
            if (s2.skipped) continue;
            if (!dddEnabled && s2.action !== "auto") continue;
            if (s2.action === "auto" && !dddAutoCard) continue;
            if (t >= s2.start - dddLead && t < s2.start) { cue = s2; break; }
          }
          if (cue) {
            if (activeScene !== cue) showSceneCue(cue);
          } else if (sceneVisible) {
            hideSceneCue();
          }
        }
      }
    }
  });
}

function stopTimeWatcher() {
  if (!timeWatcher) return;
  try { event.off("mpv.time-pos.changed", timeWatcher); } catch(e) {}
  timeWatcher = null;
}

// The observer stays armed while either feature has something to watch.
// Tearing it down unconditionally when one switches off used to be harmless
// when skip intro was the only user; with two, it would take the other's
// cueing with it. Local auto marks need it even with scene cues off.
function syncTimeWatcher() {
  if ((skipEnabled && segments.length) || scenes.length) startTimeWatcher();
  else stopTimeWatcher();
}


// ── Scene content warnings (DoesTheDogDie) ────────────────────
// A sibling of the skip machinery, not a client of it: one provider, keyed on
// the tmdbId the identification already resolved. Fetched once per show (item
// search, then ratings and topic stats in parallel) and filtered per episode
// client-side: 3 requests per show per session against the free tier's
// 5,000/month.
//
// Each scene's supercategory carries an action: off (hidden), warn (card, no
// click), skip (card with a skip button) or auto (the plugin seeks on its own
// when the scene starts). Auto is the only self-seeking path in the plugin,
// and it carries three guards: the community must agree (yes votes outnumber
// no), a safe position must exist, and the card is clickable before the skip
// happens to cancel it, with an undo card after.

var DDD_BASE = "https://www.doesthedogdie.com/api/v3";
// Two topics timestamped within a few seconds of each other are one moment,
// not two cards stacked on the same spot.
var SCENE_MERGE_GAP = 10;
// A playhead jump larger than this is a seek, not playback: a seek lands
// where the user pointed on purpose and must not trigger an auto-skip.
var SCENE_SEEK_GAP = 5;
// How long the undo card stays after an auto-skip.
var UNDO_MS = 10000;
// One entry per show watched, held for the session like the segment cache.
var DDD_CACHE_MAX = 60;
// The four category actions, and their ranking for merging: when two topics
// of one moment come from categories set differently, the stronger action
// wins, because auto-skipping a shared moment is safer than warning through
// it.
var DDD_ACTIONS = { off: 0, warn: 1, skip: 2, auto: 3 };
function actionRank(a) { return DDD_ACTIONS[a] != null ? DDD_ACTIONS[a] : DDD_ACTIONS.skip; }

// H:M:S as the API splits it across three fields, with -1 and null meaning
// "not provided". Every component is clamped, so a stray -1 cannot turn 36
// minutes into 35:59.
function hmsToSec(h, m, s) {
  function part(v) { v = Number(v); return (isFinite(v) && v > 0) ? v : 0; }
  return part(h) * 3600 + part(m) * 60 + part(s);
}

// A rating carries a timestamp at all. The API marks "no timestamp" with -1
// across all three position fields (or a null on the third), not with a flag.
function dddTimestamped(r) {
  return !!(r && r.position1 != null && r.position1 >= 0);
}

// The skip-to point, or null when the rating does not carry a usable one:
// -1 everywhere, missing, or a degenerate answer that lands at or before the
// scene it is supposed to clear. A cue without a safe position is a warning
// only; seeking on it would be a guess.
function safeSceneSec(r, startSec) {
  if (!r || r.safePosition1 == null || r.safePosition1 < 0) return null;
  var s = hmsToSec(r.safePosition1, r.safePosition2, r.safePosition3);
  return s > startSec ? s : null;
}

// cueDescription arrives as both null and "" in real data, so both mean "none".
function cueTextOf(r) {
  return (r && typeof r.cueDescription === "string") ? r.cueDescription.trim() : "";
}

// The timestamped ratings for one episode out of the show's whole list. TV
// ratings carry index1/index2 = season/episode; a film's carry -1/-1. A "no"
// vote is not a scene no matter what timestamp it carries: the X2 "a cat
// dies" cue at 52:39 was a no-vote whose own comment read "No. A cat startles
// Logan but the cat isn't hurt." Labels and categories are filled by the
// caller, so a show with nothing timestamped for this episode costs no
// /topics request at all.
function scenesForEpisode(ratings, season, episode, isMovie) {
  var out = [];
  if (!Array.isArray(ratings)) return out;
  var wantS = Number(season), wantE = Number(episode);
  for (var i = 0; i < ratings.length; i++) {
    var r = ratings[i];
    if (!r || !(Number(r.yes) >= 1)) continue;
    if (!dddTimestamped(r)) continue;
    if (isMovie) { if (r.index1 !== -1) continue; }
    else if (r.index1 !== wantS || r.index2 !== wantE) continue;
    var start = hmsToSec(r.position1, r.position2, r.position3);
    out.push({
      topicId: r.topicId,
      label: "content warning",
      start: start,
      safe: safeSceneSec(r, start),
      cue: cueTextOf(r),
      // The community's own words about this instance, shown in the sidebar.
      desc: (typeof r.triggerDescription === "string") ? r.triggerDescription.trim() : ""
    });
  }
  return out.sort(function(a, b) { return a.start - b.start; });
}

// Moments a few seconds apart collapse into one cue, so the card is not
// re-shown for what is really the same scene.
function mergeSceneCues(list) {
  if (!list || !list.length) return [];
  var out = [list[0]];
  for (var i = 1; i < list.length; i++) {
    var cur = out[out.length - 1], next = list[i];
    if (next.start - cur.start <= SCENE_MERGE_GAP) {
      if (cur.label.indexOf(next.label) === -1) cur.label += " · " + next.label;
      // The later safe position clears both scenes, so that is the one a
      // click lands on.
      if (cur.safe != null && next.safe != null) cur.safe = Math.max(cur.safe, next.safe);
      else if (cur.safe == null) cur.safe = next.safe;
      if (next.cue && cur.cue.indexOf(next.cue) === -1) {
        cur.cue = cur.cue ? cur.cue + " " + next.cue : next.cue;
      }
      if (next.desc && cur.desc.indexOf(next.desc) === -1) {
        cur.desc = cur.desc ? cur.desc + " " + next.desc : next.desc;
      }
      // When the two topics' categories are set differently, the stronger
      // action wins: auto-skipping a shared moment is safer than warning
      // through it, and "off" scenes were filtered out before this point.
      if (actionRank(next.action) > actionRank(cur.action)) {
        cur.action = next.action;
        cur.strong = next.strong;
        cur.superId = next.superId;
      }
    } else {
      out.push(next);
    }
  }
  return out;
}

function dddGet(path) {
  return withTimeout(
    iina.http.get(DDD_BASE + path, {
      headers: { "X-API-KEY": dddKey, "Accept": "application/json" }
    }),
    HTTP_TIMEOUT_MS, "DDD " + path
  );
}

// The DDD item id for a tmdbId, or null when DDD has no entry for the show.
// undefined means "could not ask" — an outage must never be cached as "no
// warnings", which would pin the show to nothing for the whole session.
async function dddItemIdFor(tmdbId) {
  try {
    var r = await dddGet("/items?tmdb=" + encodeURIComponent(String(tmdbId)));
    if (r.statusCode !== 200) return undefined;
    var arr = r.data || JSON.parse(r.text || "[]");
    if (!Array.isArray(arr) || !arr.length) return null;
    return (arr[0] && arr[0].id != null) ? arr[0].id : null;
  } catch (e) { return undefined; }
}

async function dddRatingsFor(itemId) {
  try {
    var r = await dddGet("/items/" + encodeURIComponent(String(itemId)) + "/ratings");
    if (r.statusCode !== 200) return undefined;
    var arr = r.data || JSON.parse(r.text || "[]");
    return Array.isArray(arr) ? arr : undefined;
  } catch (e) { return undefined; }
}

async function dddStatsFor(itemId) {
  try {
    var r = await dddGet("/items/" + encodeURIComponent(String(itemId)));
    if (r.statusCode !== 200) return undefined;
    var body = r.data || JSON.parse(r.text || "{}");
    var stats = {};
    var rows = (body && Array.isArray(body.topicItemStats)) ? body.topicItemStats : [];
    rows.forEach(function(s) {
      if (s && s.topicId != null) {
        stats[s.topicId] = {
          yes: Number(s.yesSum) || 0,
          no: Number(s.noSum) || 0,
          name: String(s.topicName || "")
        };
      }
    });
    return stats;
  } catch (e) { return undefined; }
}

// topicId -> { name, superId, superName }, built from the three lists. The
// topics list omits ids that ratings still reference (252 and 267 in the
// machine's own data), so a caller falls back to the stats' own topicName and
// then to a generic label in Other.
function buildTopicIndex(topics, cats, supers) {
  var superName = {}, catSuper = {};
  (Array.isArray(supers) ? supers : []).forEach(function(s) {
    if (s && s.id != null) superName[s.id] = String(s.name || s.shortName || "Other");
  });
  (Array.isArray(cats) ? cats : []).forEach(function(c) {
    if (c && c.id != null) catSuper[c.id] = c.topicSuperCategoryId;
  });
  var out = {};
  (Array.isArray(topics) ? topics : []).forEach(function(t) {
    if (!t || t.id == null) return;
    var sid = catSuper[t.topicCategoryId];
    out[t.id] = {
      name: String(t.name || ""),
      superId: (sid != null) ? sid : 60,
      superName: (sid != null && superName[sid]) ? superName[sid] : "Other"
    };
  });
  return { topics: out };
}

function topicInfo(topicId, index, stats) {
  var info = (index && index.topics && index.topics[topicId]) || null;
  var st = (stats && stats[topicId]) || null;
  return {
    name: (info && info.name) || (st && st.name) || "content warning",
    superId: info ? info.superId : 60,
    superName: info ? info.superName : "Other"
  };
}

// id -> name, supercategory and category, fetched once per session. A failed
// fetch is not remembered: the next scene-bearing episode tries again, so one
// hiccup does not reduce every label to "content warning" for the session.
var dddIndexPromise = null;
function dddIndex() {
  if (!dddIndexPromise) {
    dddIndexPromise = Promise.all([
      dddGet("/topics"), dddGet("/topiccategories"), dddGet("/topicsupercategories")
    ]).then(function(rs) {
      try {
        if (rs[0].statusCode === 200 && rs[1].statusCode === 200 && rs[2].statusCode === 200) {
          var t = rs[0].data || JSON.parse(rs[0].text || "[]");
          var c = rs[1].data || JSON.parse(rs[1].text || "[]");
          var s = rs[2].data || JSON.parse(rs[2].text || "[]");
          if (Array.isArray(t) && Array.isArray(c) && Array.isArray(s)) {
            return buildTopicIndex(t, c, s);
          }
        }
      } catch (e) {}
      dddIndexPromise = null;   // not remembered; the next cue retries
      return { topics: {} };
    }, function() {
      dddIndexPromise = null;
      return { topics: {} };
    });
  }
  return dddIndexPromise;
}

// The action a category is set to. Unknown ids and unknown values default to
// "skip", which is the feature's original behaviour.
function dddCatAction(superId) {
  var a = dddCatActions[superId];
  return (a === "off" || a === "warn" || a === "skip" || a === "auto") ? a : "skip";
}

// The community's agreement on a topic, from the item stats: required before
// an auto-skip may fire. No stats (an outage, or a rating-only topic) reads
// as no agreement, which degrades to the manual offer rather than guessing.
function strongTopic(topicId, stats) {
  var st = stats && stats[topicId];
  return !!(st && st.yes > st.no);
}

// Topics the community has flagged yes on that carry no timestamp: the
// sidebar's "also flagged" list. Sources are merged:
//   - the stats, which include bare votes the ratings endpoint excludes, and
//   - the ratings, which carry the community's descriptions and, on TV, the
//     season/episode scope.
// Topics that already produced a timestamped cue for this episode are not
// repeated here.
function flagsForTitle(ratings, stats, season, episode, isMovie) {
  var out = [], byTopic = {}, timed = {};
  scenesForEpisode(ratings, season, episode, isMovie).forEach(function(s) { timed[s.topicId] = 1; });

  function add(topicId, yes, no, desc) {
    if (!(yes >= 1)) return;
    var f = byTopic[topicId];
    if (!f) { f = byTopic[topicId] = { topicId: topicId, yes: 0, no: 0, desc: "" }; out.push(f); }
    if (yes > f.yes) f.yes = yes;
    if (no > f.no) f.no = no;
    if (desc && !f.desc) f.desc = desc;
  }

  if (stats) {
    Object.keys(stats).forEach(function(k) {
      var tid = Number(k);
      if (timed[tid]) return;
      add(tid, stats[k].yes || 0, stats[k].no || 0, "");
    });
  }
  (Array.isArray(ratings) ? ratings : []).forEach(function(r) {
    if (!r || !(Number(r.yes) >= 1)) return;
    if (dddTimestamped(r)) return;
    if (timed[r.topicId]) return;
    if (isMovie) {
      if (r.index1 !== -1) return;
    } else {
      var wantS = Number(season), wantE = Number(episode);
      var showLevel  = (r.index1 === -1 && r.index2 === -1);
      var thisSeason = (r.index1 === wantS && r.index2 === -1);
      var thisEp     = (r.index1 === wantS && r.index2 === wantE);
      if (!showLevel && !thisSeason && !thisEp) return;
    }
    add(r.topicId, Number(r.yes) || 0, Number(r.no) || 0,
        (typeof r.triggerDescription === "string") ? r.triggerDescription.trim() : "");
  });
  return out;
}

function rememberDddShow(key, entry) {
  dddShowCache[key] = entry;
  var keys = Object.keys(dddShowCache);
  if (keys.length > DDD_CACHE_MAX) {
    keys.slice(0, keys.length - DDD_CACHE_MAX).forEach(function(k) {
      delete dddShowCache[k];
    });
  }
}

// Lets the sidebar's "Search again" stop spinning. The same reported-once
// discipline as resolveSegments: an abandoned run reports stale rather than
// answering for an episode the user has already left.
async function resolveScenes(info, forceRefresh) {
  try {
    await resolveScenesInner(info, forceRefresh);
  } catch (e) {
    // Fire-and-forget like every resolveSegments caller: a throw here would be
    // an unhandled rejection, and the sidebar's button would spin forever.
    log("scene lookup failed: " + errStr(e));
  }
}

async function resolveScenesInner(info, forceRefresh) {
  var seq = ++sceneSeq;
  function live() { return seq === sceneSeq; }
  var reported = false;
  function report(list, flags, stale) {
    if (reported) return;
    reported = true;
    reportScenes(list, flags, stale);
  }
  function abandoned() { report([], [], true); }

  scenes = [];
  dddFlags = [];
  activeScene = null;
  lastTimePos = null;
  hideSceneCue();
  syncTimeWatcher();
  if (!info) return;

  var list = [], flags = [];
  // The databases need the feature's key and toggle; the user's own marks do
  // not, so an auto mark keeps skipping even with scene cues switched off.
  if (dddEnabled && dddKey && info.tmdbId) {
    // One fetch per show per session: the episode-level filtering is
    // client-side, so the second episode of a show costs nothing.
    var showId = String(info.tmdbId);
    var entry = forceRefresh ? null : dddShowCache[showId];
    if (!entry) {
      var itemId = await dddItemIdFor(showId);
      if (!live()) { abandoned(); return; }
      if (itemId === null) {
        rememberDddShow(showId, { ratings: [], stats: {} });         // a real miss is cached
        entry = dddShowCache[showId];
      } else if (itemId !== undefined) {
        // The stats answer the untimed flags and the auto-skip guard, the
        // ratings answer the cues; one call each, in parallel.
        var both = await Promise.all([dddRatingsFor(itemId), dddStatsFor(itemId)]);
        if (!live()) { abandoned(); return; }
        if (both[0] !== undefined) {
          // A stats-only outage degrades the flags and the auto guard, not
          // the cues, so the ratings answer is kept. Search again retries.
          rememberDddShow(showId, { ratings: both[0], stats: both[1] || null });
          entry = dddShowCache[showId];
        }
        // both[0] undefined is an outage: not cached, entry stays null.
      }
      // itemId undefined is an outage too: not cached.
    }
    if (entry) {
      // Categories decide which scenes exist at all, so the filtering happens
      // before merging: an Off topic must not ride into a visible cue's label.
      list = scenesForEpisode(entry.ratings, info.season, info.episode, info.isMovie);
      flags = flagsForTitle(entry.ratings, entry.stats, info.season, info.episode, info.isMovie);
      if (list.length || flags.length) {
        var index = await dddIndex();
        if (!live()) { abandoned(); return; }
        list.forEach(function(s) {
          var ti = topicInfo(s.topicId, index, entry.stats);
          s.label = ti.name;
          s.superId = ti.superId;
          s.superName = ti.superName;
          s.action = dddCatAction(ti.superId);
          s.strong = strongTopic(s.topicId, entry.stats);
        });
        list = list.filter(function(s) { return s.action !== "off"; });
        flags = flags.map(function(f) {
          var ti = topicInfo(f.topicId, index, entry.stats);
          return {
            label: ti.name, superId: ti.superId, superName: ti.superName,
            yes: f.yes, no: f.no, desc: f.desc
          };
        }).filter(function(f) {
          return dddCatAction(f.superId) !== "off";
        }).sort(function(a, b) {
          if (a.superName !== b.superName) return a.superName < b.superName ? -1 : 1;
          if (b.yes !== a.yes) return b.yes - a.yes;
          return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
        });
      }
    }
  }

  // The user's own marks ride the same pipeline: appended after the
  // databases' cues, never subject to the category filters (they have no DDD
  // category), and labelled so they are distinguishable. Their type is the
  // user's own (warn/skip/auto), and `strong` is true because a mark is an
  // explicit assertion — auto does not need the community's majority.
  localMarks.forEach(function(m) {
    // A silent mark is data the user keeps in the list without wanting
    // playback interrupted; it never becomes a cue.
    if (m.action === "silent") return;
    list.push({
      topicId: null, label: m.label || "your mark", start: m.start, safe: m.safe,
      cue: "", desc: "", superId: null, superName: "Your marks",
      action: m.action || "skip", strong: true, local: true
    });
  });
  list.sort(function(a, b) { return a.start - b.start; });
  list = mergeSceneCues(list);
  scenes = list;
  dddFlags = flags;
  syncTimeWatcher();
  report(scenes, dddFlags, false);
}

function reportScenes(list, flags, stale) {
  // Local marks are the sidebar's own data, rendered from its storage; only
  // the databases' answers are reported back, so a mark is never listed twice.
  var dddList = list.filter(function(s) { return !s.local; });
  sidebar.postMessage("scenesResult", {
    count: dddList.length,
    // Stale, not empty, when superseded: the sidebar re-enables its button on
    // this and must not print "nothing found" for an episode it never asked
    // about.
    stale: !!stale,
    scenes: dddList.map(function(s) {
      return {
        label: s.label,
        at: fmtTime(s.start),
        to: (s.safe != null) ? fmtTime(s.safe) : "",
        cue: s.cue || "",
        desc: s.desc || ""
      };
    }),
    flags: flags.map(function(f) {
      return {
        label: f.label,
        super: f.superName,
        yes: f.yes,
        no: f.no,
        desc: f.desc || ""
      };
    })
  });
}

// The sidebar cannot verify the key itself: DDD serves no CORS headers, so a
// WebView fetch dies before it can judge anything. main.js owns every other
// DDD call anyway, so the check runs here and the verdict travels back as a
// message. 401 is DDD itself saying "bad key"; a Cloudflare challenge or a
// timeout means the question was never asked, which is not the same verdict.
function verifyDddKey() {
  dddGet("/topics").then(function(r) {
    if (r.statusCode === 200) sidebar.postMessage("dddKeyCheck", { ok: true });
    else if (r.statusCode === 401) sidebar.postMessage("dddKeyCheck", { ok: false, reason: "invalid" });
    else sidebar.postMessage("dddKeyCheck", { ok: false, reason: "unverified" });
  }, function() {
    sidebar.postMessage("dddKeyCheck", { ok: false, reason: "unverified" });
  });
}

// What the cue card should offer for a scene at this moment. A category set
// to Auto only auto-skips when the community agrees (yes > no) and a safe
// position exists; anything weaker degrades to the manual offer, then to a
// warning with no target at all. A scene the user cancelled degrades the same
// way.
function cueModeFor(scene) {
  if (!scene) return "warn";
  if (scene.cancelled) return (scene.safe != null) ? "skip" : "warn";
  if (scene.action === "warn") return "warn";
  if (scene.action === "auto" && scene.safe != null && scene.strong) return "auto";
  return (scene.safe != null) ? "skip" : "warn";
}

function showSceneCue(scene) {
  // A normal card replaces any pending undo state, including its timer: a
  // receipt for an old skip must not hide a fresh heads-up ten seconds later.
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  var mode = cueModeFor(scene);
  activeScene = scene;
  sceneVisible = true;
  sceneMode = mode;
  overlay.postMessage("showCue", {
    label: scene.label,
    // The mode is decided here, where the safe position and the community's
    // agreement are known, so the overlay stays dumb about what a cue can do.
    mode: mode,
    // A local mark is the user's own, and the card says so with a pen icon.
    local: !!scene.local,
    at: fmtTime(scene.start),
    to: (scene.safe != null) ? fmtTime(scene.safe) : ""
  });
  syncOverlay();
  // Clickable only when something on screen wants clicks: a warn-only card
  // never takes the mouse events, but a visible skip pill still does.
  try { overlay.setClickable((mode !== "warn") || skipVisible); } catch(e) { log("setClickable failed: " + errStr(e)); }
}

// After an auto-skip: a card that says so, and stays long enough to be
// undoed. It leaves on its own, or when another cue replaces it.
function showUndoCue(scene) {
  activeScene = scene;
  sceneVisible = true;
  sceneMode = "undo";
  overlay.postMessage("showCue", {
    label: scene.label,
    mode: "undo",
    local: !!scene.local,
    at: fmtTime(scene.start),
    to: (scene.safe != null) ? fmtTime(scene.safe) : ""
  });
  syncOverlay();
  try { overlay.setClickable(true); } catch(e) { log("setClickable(true) failed: " + errStr(e)); }
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  undoTimer = setTimeout(function() {
    undoTimer = null;
    hideSceneCue();
  }, UNDO_MS);
}

function hideSceneCue() {
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  if (!sceneVisible) return;
  activeScene = null;
  sceneVisible = false;
  sceneMode = null;
  overlay.postMessage("hideCue", {});
  // The skip pill may still be up and needing its clicks.
  try { overlay.setClickable(!!skipVisible); } catch(e) { log("setClickable failed: " + errStr(e)); }
  syncOverlay();
}

// The automatic path, reached only from the observer: the scene's category is
// Auto, the community agrees, and a safe position exists (checked by the
// caller). Marks the scene skipped so a later rewind cannot re-trigger it.
function skipSceneTo(scene) {
  var target = clampedSeekTarget(scene.safe);
  if (!(target > 0)) return false;
  var how = seekAbsolute(target);
  if (how === null) return false;
  scene.skipped = true;
  iina.console.log("[EpInfo] auto-skipped \"" + scene.label + "\" to " + target + "s via " + how);
  // The card is the escape hatch; with it switched off the skip is silent.
  if (dddAutoCard) showUndoCue(scene);
  return true;
}

// The overlay's cancel during an auto cue's lead window: keep watching this
// one, without turning the whole category off.
function cancelScene() {
  if (!activeScene || sceneMode !== "auto") return;
  activeScene.cancelled = true;
  showSceneCue(activeScene);   // re-renders as the manual offer
}

// The overlay's undo on the card after an auto-skip: back to just before the
// scene. The scene stays marked skipped, so the auto path will not fire at
// the user a second time.
function undoScene() {
  if (!activeScene || sceneMode !== "undo") return;
  var scene = activeScene;
  hideSceneCue();
  var target = Math.max(0, scene.start - 1);
  var how = seekAbsolute(target);
  if (how !== null) {
    iina.console.log("[EpInfo] undid the auto-skip of \"" + scene.label + "\", back to " + target + "s");
  }
}

// Reachable from the overlay cue card only, which only a scene with a safe
// position can put up. There is no path here that could seek on a guess.
function skipScene(via) {
  if (!activeScene) return;
  // Validate before hiding anything, like skipNow: a target that cannot be
  // seeked must leave the card up, not take it away with no reason.
  var target = activeScene.safe;
  var label  = activeScene.label;
  if (!(target > 0)) {
    iina.console.log("[EpInfo] refusing to seek to " + target + "s for a scene cue");
    return;
  }
  hideSceneCue();

  target = clampedSeekTarget(target);
  if (!(target > 0)) {
    iina.console.log("[EpInfo] refusing to seek to " + target + "s for a scene cue");
    return;
  }
  var how = seekAbsolute(target);
  if (how === null) return;

  iina.console.log("[EpInfo] skipped \"" + label + "\" to " + target + "s via " + how + " (" + via + ")");
}

// ── Subtitle tag scan ─────────────────────────────────────────
// External text subtitles only: IINA's file API cannot reach tracks inside
// the container (verified: "Cannot find the file path of track @sub/N.
// Perhaps it's an internal stream?"), and image-based tracks (PGS/VobSub)
// carry no text at all. The tags SDH subtitles use ("[moaning]", "(gunshot)")
// become proposed local marks that the user previews, edits or deletes in
// the sidebar — never cues that appear on their own.

// Tag fragment -> label for the proposed mark. Deliberately sexual-content
// only: gunfire, screaming, crying and the like are noise for this use, and
// the SDH vocabulary is mostly sound effects anyway. Labels match the tag
// so a proposal reads as what the subtitle actually said.
var SUB_LEXICON = [
  ["moan", "moaning"],
  ["kiss", "kissing"],
  ["sex", "sex"], ["orgasm", "sex"],
  ["making out", "making out"],
  ["undress", "undressing"],
  ["nude", "nudity"], ["naked", "nudity"],
  ["grope", "groping"]
];

// H:M:S.frac to seconds. SRT gives milliseconds (3 digits), ASS centiseconds
// (2), and the odd file gives deciseconds (1); each has to scale.
function subtitleSec(h, m, s, frac) {
  var digits = String(frac == null ? "" : frac).length;
  var f = Number(frac || 0);
  if (digits === 2) f *= 10;
  else if (digits === 1) f *= 100;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + (f / 1000);
}

function parseAssTime(s) {
  var m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(String(s || "").trim());
  return m ? subtitleSec(m[1], m[2], m[3], m[4]) : null;
}

// SRT / WebVTT / ASS to [{start, end, text}]. Returns [] for anything it
// cannot read; the caller says so rather than guessing.
function parseSubtitleText(text) {
  var cues = [];
  if (typeof text !== "string" || !text) return cues;
  var lines = text.replace(/\r/g, "").split("\n");
  var i;

  // ASS/SSA dialogue lines: "Dialogue: Layer,Start,End,Style,Name,L,R,V,Effect,Text".
  for (i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("Dialogue:") !== 0) continue;
    var parts = lines[i].slice(9).split(",");
    if (parts.length < 10) continue;
    var st = parseAssTime(parts[1]), en = parseAssTime(parts[2]);
    if (st == null || en == null) continue;
    var body = parts.slice(9).join(",")
      .replace(/\{[^}]*\}/g, " ")
      .replace(/\\[Nn]/g, " ")
      .trim();
    if (body) cues.push({ start: st, end: en, text: body });
  }
  if (cues.length) return cues;

  // SRT and WebVTT: a timestamp line, then text until a blank line. VTT
  // settings after the end time ("align:middle") are ignored by the pattern.
  var TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  for (i = 0; i < lines.length; i++) {
    var m = TIME.exec(lines[i]);
    if (!m) continue;
    var bodyLines = [];
    var j = i + 1;
    while (j < lines.length && lines[j] !== "") { bodyLines.push(lines[j]); j++; }
    var bodyText = bodyLines.join(" ").replace(/<[^>]*>/g, "").trim();
    cues.push({
      start: subtitleSec(m[1], m[2], m[3], m[4]),
      end:   subtitleSec(m[5], m[6], m[7], m[8]),
      text:  bodyText
    });
    i = j;
  }
  return cues;
}

function cueTags(text) {
  var out = [];
  var re = /[\[(]([^\])\n]{2,60})[\])]/g, m;
  while ((m = re.exec(String(text || ""))) !== null) out.push(m[1].trim().toLowerCase());
  return out;
}

// Lexicon hits to proposed marks. Same-label hits within ten seconds are one
// moment. The scene's end is not the last tag: a "[Moaning]" is a moment, and
// the scene around it keeps going. Captions are continuous inside a scene and
// stop at a cut, so each run is extended forward through consecutive cues
// until a silence longer than SUB_EXTEND_GAP — and the cut itself lands a
// moment after the final line, so a short pad follows it. Both tuned against
// a real SDH track (X2's bar scene: tag 46:27, last line 47:13, cut 47:18).
var SUB_EXTEND_GAP = 10;   // seconds of silence that ends the run
var SUB_EXTEND_PAD = 5;    // silence after the last line before the cut
var SUB_EXTEND_MAX = 120;  // longest a proposal may be

function subtitleProposals(cues) {
  var list = Array.isArray(cues) ? cues : [];
  var hits = [];
  list.forEach(function(c, idx) {
    var tags = cueTags(c.text);
    for (var t = 0; t < tags.length; t++) {
      for (var i = 0; i < SUB_LEXICON.length; i++) {
        if (tags[t].indexOf(SUB_LEXICON[i][0]) !== -1) {
          hits.push({ label: SUB_LEXICON[i][1], start: c.start, end: c.end, idx: idx });
          break;
        }
      }
    }
  });
  hits.sort(function(a, b) { return a.start - b.start; });
  var merged = [];
  hits.forEach(function(h) {
    var last = merged[merged.length - 1];
    if (last && last.label === h.label && h.start - last.end <= 10) {
      if (h.end > last.end) { last.end = h.end; last.idx = h.idx; }
    } else {
      merged.push({ label: h.label, start: h.start, end: h.end, idx: h.idx });
    }
  });
  merged.forEach(function(p) {
    var cap = p.start + SUB_EXTEND_MAX;
    for (var i = p.idx + 1; i < list.length; i++) {
      if (list[i].start - p.end > SUB_EXTEND_GAP) break;
      if (list[i].end > p.end) p.end = list[i].end;
      if (p.end >= cap) break;
    }
    p.end += SUB_EXTEND_PAD;
  });
  return merged.map(function(p) {
    return { label: p.label, start: p.start, safe: p.end };
  });
}

// Codecs that are actual text. hdmv_pgs_subtitle and dvd_subtitle are
// bitmaps; subrip/ass/ssa/mov_text/webvtt parse.
var SUBTITLE_TEXT_CODECS = { subrip: 1, srt: 1, ass: 1, ssa: 1, mov_text: 1, webvtt: 1, text: 1 };

// Every successful scan leaves a copy of the subtitle in the plugin's data
// directory, keyed to the identification. On the next open the plugin can
// load that copy itself, so an SDH subtitle obtained once keeps working
// without searching again — and switching live tracks never changes it.
function subtitleEpisodeKey(info) {
  if (!info || !info.tmdbId) return "";
  var s = info.isMovie ? -1 : Number(info.season);
  var e = info.isMovie ? -1 : Number(info.episode);
  return String(info.tmdbId) + ":" + s + ":" + e;
}

function subtitleCachePath(info) {
  var k = subtitleEpisodeKey(info);
  return k ? ("@data/sidekick-sub-" + k.replace(/:/g, "-") + ".srt") : "";
}

function rememberSubtitle(info, text) {
  if (!text || typeof text !== "string") return;
  var p = subtitleCachePath(info);
  if (!p) return;
  try {
    if (typeof iina.file.write === "function") iina.file.write(p, text);
  } catch (e) { /* caching is best-effort */ }
}

// Registered with the other sidebar handlers, after the page loads.
function scanSubtitlesNow() {
  try {
    if (!iina.file || typeof iina.file.read !== "function") {
      sidebar.postMessage("subScanResult", { ok: false, reason: "no-file-api" });
      return;
    }
    var tracks = [];
    try { tracks = core.subtitle.tracks || []; } catch (e) {}
    // The selected external text track wins; otherwise the first external
    // text one. Embedded tracks are useless here whatever their codec.
    var track = null;
    tracks.forEach(function(t) {
      if (!track && t.isExternal && SUBTITLE_TEXT_CODECS[t.codec] && t.isSelected) track = t;
    });
    tracks.forEach(function(t) {
      if (!track && t.isExternal && SUBTITLE_TEXT_CODECS[t.codec]) track = t;
    });
    if (!track) {
      sidebar.postMessage("subScanResult", { ok: false, reason: "no-external-text" });
      return;
    }
    var text = iina.file.read("@sub/" + track.id);
    var cues = parseSubtitleText(text);
    // A user-adjusted subtitle delay applies to playback, so the tags need
    // it too; otherwise every proposal is off by the sync amount.
    var delay = 0;
    try { delay = Number(core.subtitle.delay) || 0; } catch (e) { delay = 0; }
    if (delay) {
      cues.forEach(function(c) {
        c.start = Math.max(0, c.start + delay);
        c.end = Math.max(0, c.end + delay);
      });
    }
    if (currentEpisode) {
      subtitleScanDone[subtitleEpisodeKey(currentEpisode)] = true;
      rememberSubtitle(currentEpisode, text);
    }
    sidebar.postMessage("subScanResult", {
      ok: true,
      track: String(track.title || track.formattedTitle || ("track " + track.id)),
      cues: cues.length,
      proposals: subtitleProposals(cues)
    });
  } catch (e) {
    sidebar.postMessage("subScanResult", { ok: false, reason: "read-failed", detail: errStr(e) });
  }
}

// Auto-scan: when an external text subtitle becomes the selected track for an
// identified episode, scan it without the button. Once per episode, so
// switching to another subtitle later does not add a second batch; the manual
// button bypasses that. Failures stay silent — the manual button is where
// errors are reported, since an auto failure has no user action behind it.
var subtitleScanDone = {};
function autoScanStep() {
  try {
    if (!dddEnabled || !currentEpisode) return;
    if (!iina.file || typeof iina.file.read !== "function") return;
    var epKey = subtitleEpisodeKey(currentEpisode);
    if (!epKey || subtitleScanDone[epKey]) return;
    var tracks = [];
    try { tracks = core.subtitle.tracks || []; } catch (e) { return; }
    var track = null;
    tracks.forEach(function(t) {
      if (!track && t.isExternal && SUBTITLE_TEXT_CODECS[t.codec] && t.isSelected) track = t;
    });
    if (!track) return;
    var text = iina.file.read("@sub/" + track.id);
    var cues = parseSubtitleText(text);
    var delay = 0;
    try { delay = Number(core.subtitle.delay) || 0; } catch (e) { delay = 0; }
    if (delay) {
      cues.forEach(function(c) {
        c.start = Math.max(0, c.start + delay);
        c.end = Math.max(0, c.end + delay);
      });
    }
    // Marked done only after a successful read, so a track whose file is not
    // ready yet is retried on the next poll.
    subtitleScanDone[epKey] = true;
    rememberSubtitle(currentEpisode, text);
    sidebar.postMessage("subScanResult", {
      ok: true,
      auto: true,
      track: String(track.title || track.formattedTitle || ("track " + track.id)),
      cues: cues.length,
      proposals: subtitleProposals(cues)
    });
  } catch (e) { /* silent by design; see above */ }
}

// Load the remembered copy when the user has no external subtitle of their
// own selected. loadTrack does not report failure, so the result is verified
// a moment later: if no external track appeared, the sidebar is told, because
// a manual load is the workaround and the storage location can then change.
function tryLoadCachedSubtitle() {
  try {
    if (!dddEnabled || !currentEpisode) return;
    if (!iina.file || typeof iina.file.exists !== "function") return;
    var p = subtitleCachePath(currentEpisode);
    if (!p || !iina.file.exists(p)) return;
    var tracks = [];
    try { tracks = core.subtitle.tracks || []; } catch (e) {}
    var hasExternal = false;
    tracks.forEach(function(t) { if (t.isExternal) hasExternal = true; });
    if (hasExternal) return;   // the user's own choice stays untouched
    if (typeof core.subtitle.loadTrack !== "function") return;
    var before = tracks.length;
    core.subtitle.loadTrack(p);
    log("loading cached subtitle " + p);
    setTimeout(function() {
      try {
        var now = [];
        try { now = core.subtitle.tracks || []; } catch (e) {}
        var ext = false;
        now.forEach(function(t) { if (t.isExternal && SUBTITLE_TEXT_CODECS[t.codec]) ext = true; });
        if (!ext && now.length <= before) {
          log("cached subtitle did not appear after loadTrack: " + p);
          sidebar.postMessage("subScanResult", { ok: false, reason: "autoload-failed", auto: true });
        }
      } catch (e) {}
    }, 2500);
  } catch (e) {
    log("cached subtitle load failed: " + errStr(e));
    sidebar.postMessage("subScanResult", { ok: false, reason: "autoload-failed", auto: true });
  }
}
// The poll is what notices a subtitle downloaded while the file is playing.
setInterval(autoScanStep, 3000);


// The window title, the macOS media panel and IINA's playlist all read
// mpv's media-title. Left alone, they show "Severance.S02E03.1080p.WEB-DL
// .mkv"; set, they show what is actually playing.
function clearMediaTitle() {
  try {
    iina.mpv.set("media-title", "");
  } catch (e) {
    log("media-title not cleared: " + errStr(e));
  }
}

function setMediaTitle(info) {
  if (!info) return;
  var bits = [];
  if (!info.isMovie && info.showTitle) bits.push(info.showTitle);
  if (info.epTitle) bits.push(info.epTitle);
  var title = bits.join(" · ");
  if (!title) return;
  try {
    iina.mpv.set("media-title", title);
  } catch (e) {
    // Not worth surfacing: the only casualty is the window title.
    log("media-title not set: " + errStr(e));
  }
}

// ── Sidebar handlers ──────────────────────────────────────────
function registerSidebarHandlers() {

  sidebar.onMessage("episodeSelected", function(info) {
    log("episodeSelected: " + (info ? info.epTitle : "null"));
    currentEpisode = info;
    setMediaTitle(info);
    // The user may well have paused while this lookup was in flight.
    presentIfPaused();
    resolveSegments(info);
    resolveScenes(info);
    // A subtitle may already be loaded for this episode, and a remembered
    // copy from an earlier scan can be brought back without searching.
    autoScanStep();
    tryLoadCachedSubtitle();
  });

  sidebar.onMessage("clearEpisode", function() {
    loadSeq++;
    sceneSeq++;
    currentEpisode = null;
    segments = [];
    scenes = [];
    dddFlags = [];
    localMarks = [];
    activeScene = null;
    lastTimePos = null;
    hideSceneCue();
    // Hand the title back to mpv so the window stops claiming to know what is
    // playing once the identification is discarded.
    try { iina.mpv.set("media-title", ""); } catch(e) {}
    // The observer outlived the selection otherwise, and would keep watching
    // time-pos for a file whose segments no longer exist.
    stopTimeWatcher();
    hideSkip();
    hideOverlay();
    // The sidebar's scene list belongs to the selection being cleared.
    reportScenes([], [], false);
  });

  sidebar.onMessage("overlayCloseRequest", function() {
    hideOverlay();
  });

  // ON/OFF toggle from sidebar
  sidebar.onMessage("setOverlayEnabled", function(d) {
    overlayEnabled = !!d.enabled;
    if (!overlayEnabled) hideOverlay();
    log("Overlay " + (overlayEnabled ? "enabled" : "disabled"));
  });

  // Opacity slider
  sidebar.onMessage("setOverlayOpacity", function(d) {
    var v = parseFloat(d.value);
    if (isNaN(v)) return;
    overlayBgOpacity = Math.max(0, Math.min(1, v));
    if (overlayVisible) overlay.postMessage("setBgOpacity", { value: overlayBgOpacity });
  });

  // Vertical position slider
  sidebar.onMessage("setOverlayVerticalPos", function(d) {
    var v = parseFloat(d.value);
    if (!isNaN(v)) {
      overlayVerticalPos = Math.max(0, Math.min(100, v));
      if (overlayVisible) overlay.postMessage("setVerticalPos", { value: overlayVerticalPos });
    }
  });

  // Configurable pause delay
  sidebar.onMessage("setPauseDelay", function(d) {
    var v = parseFloat(d.value);
    if (!isNaN(v) && v >= 0.5) pauseDelay = v;
  });

  // Overlay theme: classic | compact | poster
  sidebar.onMessage("setOverlayTheme", function(d) {
    overlayTheme = d && d.value ? String(d.value) : "classic";
    overlay.postMessage("setTheme", { value: overlayTheme });
  });

  // The sidebar's TMDB key, needed to resolve the IMDB id that every skip
  // database is keyed on.
  sidebar.onMessage("setTmdbKey", function(d) {
    tmdbKey = (d && d.key) ? String(d.key) : "";
  });

  // The sidebar's DoesTheDogDie key, pushed on boot and on save exactly like
  // the TMDB one. The scene feature stays silently off without it.
  sidebar.onMessage("setDddKey", function(d) {
    dddKey = (d && d.key) ? String(d.key) : "";
    if (dddKey) verifyDddKey();
    // A key that has just arrived re-answers the episode already playing,
    // which is the one that prompted the user to go get a key at all.
    if (dddEnabled && dddKey && currentEpisode) resolveScenes(currentEpisode);
  });

  // "Search again" in the sidebar: ignore the cache and look once more.
  sidebar.onMessage("refreshSkip", function() {
    if (!skipEnabled || !currentEpisode) {
      sidebar.postMessage("skipResult", { count: 0, label: "" });
      return;
    }
    resolveSegments(currentEpisode, true);
  });

  // The scene warnings' own "Search again": same shape, its own feature.
  sidebar.onMessage("refreshScenes", function() {
    if (!dddEnabled || !dddKey || !currentEpisode) {
      reportScenes([], [], false);
      return;
    }
    resolveScenes(currentEpisode, true);
  });

  // How long before a scene its card appears.
  sidebar.onMessage("setDddLead", function(d) {
    var v = parseFloat(d && d.value);
    if (isFinite(v)) dddLead = Math.max(5, Math.min(120, v));
  });

  // Whether an auto-skip shows its card (cancel before, undo after). Off
  // means a completely silent skip; the seek still happens either way.
  sidebar.onMessage("setDddAutoCard", function(d) {
    dddAutoCard = !(d && d.enabled === false);
  });

  // Per-category actions. Changing them changes which scenes exist at all,
  // so the current episode is rebuilt — straight from the show cache, so it
  // costs no requests.
  sidebar.onMessage("setDddCatActions", function(d) {
    var raw = (d && d.actions && typeof d.actions === "object") ? d.actions : {};
    var clean = {};
    Object.keys(raw).forEach(function(k) {
      var v = String(raw[k]);
      if (v === "off" || v === "warn" || v === "skip" || v === "auto") clean[k] = v;
    });
    dddCatActions = clean;
    if (dddEnabled && currentEpisode) resolveScenes(currentEpisode);
  });

  // The sidebar's mark buttons: hand back the playhead so it can attach a
  // mark to the current identification, or fill one of the editor's fields.
  sidebar.onMessage("captureTime", function(d) {
    var kind = (d && (d.kind === "safe" || d.kind === "start" || d.kind === "end")) ? d.kind : "trigger";
    var t;
    try { t = iina.mpv.getNumber("time-pos"); } catch(e) { t = NaN; }
    sidebar.postMessage("timeCaptured", {
      kind: kind,
      seconds: (isFinite(t) && t >= 0) ? t : null
    });
  });

  // A preview seek from a mark row or the editor. Every seek path in this
  // file goes through the same clamp so a preview can never land past EOF.
  sidebar.onMessage("seekToTime", function(d) {
    var t = Number(d && d.seconds);
    if (!isFinite(t) || t < 0) return;
    t = clampedSeekTarget(t);
    var how = seekAbsolute(t);
    if (how !== null) iina.console.log("[EpInfo] preview seek to " + t + "s via " + how);
  });

  // The user's own scene marks for the current identification, pushed ahead
  // of episodeSelected. Rebuilding from the show cache costs no requests, and
  // an outage above only means the database cues are missing that run.
  sidebar.onMessage("setSceneMarks", function(d) {
    var raw = (d && Array.isArray(d.marks)) ? d.marks : [];
    var clean = [];
    raw.forEach(function(m) {
      if (!m) return;
      var start = Number(m.start);
      if (!isFinite(start) || start < 0) return;
      var safe = Number(m.safe);
      // A mark's type: silent (data only, never a cue), warn (card only),
      // skip (card with a button), auto (the player jumps at the start mark
      // on its own). Anything else is the original behaviour.
      var action = (m.action === "silent" || m.action === "warn" || m.action === "auto")
        ? m.action : "skip";
      clean.push({
        label: (typeof m.label === "string" && m.label.trim()) ? m.label.trim().slice(0, 60) : "your mark",
        start: start,
        safe: (isFinite(safe) && safe > start) ? safe : null,
        action: action
      });
    });
    clean.sort(function(a, b) { return a.start - b.start; });
    localMarks = clean;
    // Rebuilt even with scene cues off, because auto marks are live actions.
    if (currentEpisode) resolveScenes(currentEpisode);
  });

  // The subtitle tag scan. Registered here with the other sidebar handlers,
  // which do not survive the sidebar page load otherwise.
  sidebar.onMessage("scanSubtitles", scanSubtitlesNow);

  // Skip intro/recap/credits toggle
  sidebar.onMessage("setSkipEnabled", function(d) {
    skipEnabled = !!(d && d.enabled);
    // Abandon anything in flight, as the counter's own comment promises. Without
    // it a lookup that finishes after the switch re-installs segments, re-arms
    // the observer and writes its answer into the cache while the feature is
    // off.
    loadSeq++;
    if (!skipEnabled) {
      segments = [];
      hideSkip();
      // Scene cues may still need the observer, so this decides rather than
      // always tearing it down.
      syncTimeWatcher();
    } else if (currentEpisode) {
      resolveSegments(currentEpisode);
    }
    log("Skip segments " + (skipEnabled ? "enabled" : "disabled"));
  });

  // Scene content warnings toggle. It gates the databases and the cue pills;
  // the user's own auto marks keep skipping with it off (see the rebuild).
  sidebar.onMessage("setDddEnabled", function(d) {
    dddEnabled = !!(d && d.enabled);
    sceneSeq++;
    if (!dddEnabled) {
      if (currentEpisode) {
        // Rebuild rather than clear: the databases' cues and flags drop out,
        // local marks stay, and the sidebar's list clears via the report.
        resolveScenes(currentEpisode);
      } else {
        scenes = [];
        dddFlags = [];
        activeScene = null;
        lastTimePos = null;
        hideSceneCue();
        syncTimeWatcher();
        reportScenes([], [], false);
      }
    } else if (currentEpisode) {
      resolveScenes(currentEpisode);
      autoScanStep();
      tryLoadCachedSubtitle();
    }
    log("Scene warnings " + (dddEnabled ? "enabled" : "disabled"));
  });

  // Sidebar finished its init and is ready to receive messages.
  // Re-emit the current file's URL so it can do its URL→episode lookup
  //. The original fileChanged from file-loaded may have
  // arrived before sidebar handlers were registered.
  sidebar.onMessage("sidebarReady", function() {
    if (currentVideoUrl) {
      sidebar.postMessage("fileChanged", { url: currentVideoUrl });
    }
  });

}

function setupSidebar() {
  if (!sidebarLoaded) {
    sidebar.loadFile("sidebar.html");
    sidebarLoaded = true;
    setTimeout(registerSidebarHandlers, 500);
  }
}

var overlayHandlersRegistered = false;
function registerOverlayHandlers() {
  if (overlayHandlersRegistered) return;   // never stack duplicates
  overlayHandlersRegistered = true;
  // No closeOverlay handler: nothing in overlay.html ever sends that name, and
  // the sidebar's own dismiss path posts overlayCloseRequest instead. It was a
  // handler with no sender, which reads like working code.
  overlay.onMessage("skipSegment", function() { skipNow("button"); });
  // The scene cue card seeks to its scene's safe position; a warn-only card
  // is never made clickable, so this can only fire for one that can act. The
  // cancel and undo paths come from the auto cue's two cards.
  overlay.onMessage("skipScene", function() { skipScene("button"); });
  overlay.onMessage("cancelScene", function() { cancelScene(); });
  overlay.onMessage("undoScene", function() { undoScene(); });
}

// A trigger that does not involve the overlay web view at all.
try {
  menu.addItem(menu.item("Skip Intro / Recap / Credits", function() {
    skipNow("menu");
  }, { keyBinding: "Alt+s" }));
} catch(e) {
  iina.console.log("[EpInfo] menu item failed: " + errStr(e));
}

// ── Events ────────────────────────────────────────────────────
event.on("iina.window-loaded", function() {
  overlay.loadFile("overlay.html");
  // Handlers registered straight after loadFile do not survive the page
  // load; the sidebar uses the same delay for the same reason.
  setTimeout(registerOverlayHandlers, 500);
  setupSidebar();
});

event.on("iina.file-loaded", function() {
  // Abandon any lookup still in flight before touching the state it writes to.
  loadSeq++;
  sceneSeq++;
  // The state reset comes first on purpose. sidebar.loadFile throws if the
  // player window is not loaded yet, and setupSidebar() was called first, so a
  // throw there skipped every line below and left the previous file's
  // segments, its time observer and a visible card in place. The postMessage
  // calls after it do not throw when the window is down; IINA swallows them,
  // which is why the window-loaded handshake re-sends fileChanged.
  currentEpisode = null;
  segments = [];
  activeSegment = null;
  scenes = [];
  dddFlags = [];
  localMarks = [];
  subtitleScanDone = {};
  activeScene = null;
  lastTimePos = null;
  hideSkip();
  hideSceneCue();
  stopTimeWatcher();
  hideOverlay();
  // The window title, the macOS Now Playing panel and IINA's own playlist all
  // read this. Identification is a multi-request ladder, so between this and
  // the next answer they named the previous episode: clearEpisode has always
  // done the same, and this path did not.
  clearMediaTitle();
  setupSidebar();
  // Capture URL so sidebar can look it up in its URL→episode map
  try { currentVideoUrl = core.status.url || ""; } catch(e) { currentVideoUrl = ""; }
  sidebar.postMessage("fileChanged", { url: currentVideoUrl });
  sidebar.postMessage("overlayStatus", { text: "Select an episode, then pause" });
});

// Show the card if the video is sitting paused. Identification finishes
// asynchronously, so a user who pauses during the lookup would otherwise have
// to pause a second time: the pause event has already come and gone by the
// time there is an episode to show.
function presentIfPaused() {
  if (!overlayEnabled) return;
  if (!currentEpisode) return;
  if (!core.status.paused) return;
  // Already on screen: refresh it in place rather than flashing it off and on.
  if (cardVisible) { showOverlay(currentEpisode); return; }

  // The delay is for "paused briefly to rewind", so it runs from the pause. The
  // lookup is asynchronous and the user does not wait for it: pausing during
  // the lookup used to start the countdown only once the answer arrived, so a
  // slow ladder added its whole duration on top of the delay. Whatever the
  // lookup spent is time the user has already been paused, and is spent.
  var waited = pausedAt ? Math.max(0, Date.now() - pausedAt) : 0;
  var remaining = pauseDelay * 1000 - waited;
  if (remaining <= 0) {
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    showOverlay(currentEpisode);
    return;
  }

  // Already counting down, and counting down to the same moment: a lookup
  // landing mid-pause must not restart or double up the timer.
  if (pauseTimer) return;
  pauseTimer = setTimeout(function() {
    pauseTimer = null;
    if (core.status.paused && currentEpisode) showOverlay(currentEpisode);
  }, remaining);
}

event.on("mpv.pause.changed", function() {
  if (core.status.paused) {
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    pausedAt = Date.now();
    if (currentEpisode) {
      presentIfPaused();
    } else {
      // Not a dead end: episodeSelected calls presentIfPaused when the lookup
      // finishes, so the card appears without waiting for a second pause.
      log("Paused, waiting for identification");
    }
  } else {
    // hideOverlay clears the stamp, so the next pause counts from then.
    hideOverlay();
  }
});

