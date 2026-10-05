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

// The overlay WebView is shared by the info card and the skip pill.
// Hide it only when neither of them wants to be on screen.
function syncOverlay() {
  if (cardVisible || skipVisible) overlay.show();
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

  // Never seek to or past the end of the file. A crowd-sourced "to the end"
  // marker is stored as the duration itself, so the unadjusted value lands
  // exactly on EOF, which is where mpv advances to the next playlist item.
  var duration = 0;
  try { duration = core.status.duration || iina.mpv.getNumber("duration") || 0; }
  catch (e) { duration = 0; }
  if (duration > 0 && target > duration - 0.25) target = Math.max(0, duration - 0.25);
  // A segment that claims to end before it starts would seek backwards.
  if (!(target > 0)) {
    iina.console.log("[EpInfo] refusing to seek to " + target + "s");
    return;
  }

  var how = "";
  try {
    core.seekTo(target);
    how = "core.seekTo";
  } catch(e1) {
    try {
      iina.mpv.command("seek", [String(target), "absolute", "exact"]);
      how = "mpv seek absolute";
    } catch(e2) {
      try {
        iina.mpv.set("time-pos", target);
        how = "mpv time-pos";
      } catch(e3) {
        iina.console.log("[EpInfo] seek failed: " + errStr(e1) + " / " + errStr(e2) + " / " + errStr(e3));
        return;
      }
    }
  }

  iina.console.log("[EpInfo] skipped " + kind + " to " + target + "s via " + how + " (" + via + ")");
}

function hideSkip() {
  if (!skipVisible) return;
  activeSegment = null;
  skipVisible = false;
  overlay.postMessage("hideSkip", {});
  try { overlay.setClickable(false); } catch(e) { log("setClickable(false) failed: " + errStr(e)); }
  syncOverlay();
}

// Driven by the mpv property rather than a timer: a wall-clock timer keeps
// running while paused and is wrong after any seek. The handler stays trivial
// because it fires often.
function startTimeWatcher() {
  if (timeWatcher) return;
  timeWatcher = event.on("mpv.time-pos.changed", function() {
    if (!skipEnabled || !segments.length) return;
    var t;
    try { t = iina.mpv.getNumber("time-pos"); } catch(e) { return; }
    if (!isFinite(t)) return;

    var hit = null;
    for (var i = 0; i < segments.length; i++) {
      if (t >= segments[i].start && t < segments[i].end) { hit = segments[i]; break; }
    }
    if (hit) {
      if (activeSegment !== hit) showSkip(hit);
    } else if (skipVisible) {
      hideSkip();
    }
  });
}

function stopTimeWatcher() {
  if (!timeWatcher) return;
  try { event.off("mpv.time-pos.changed", timeWatcher); } catch(e) {}
  timeWatcher = null;
}

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
  });

  sidebar.onMessage("clearEpisode", function() {
    loadSeq++;
    currentEpisode = null;
    segments = [];
    // Hand the title back to mpv so the window stops claiming to know what is
    // playing once the identification is discarded.
    try { iina.mpv.set("media-title", ""); } catch(e) {}
    // The observer outlived the selection otherwise, and would keep watching
    // time-pos for a file whose segments no longer exist.
    stopTimeWatcher();
    hideSkip();
    hideOverlay();
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

  // "Search again" in the sidebar: ignore the cache and look once more.
  sidebar.onMessage("refreshSkip", function() {
    if (!skipEnabled || !currentEpisode) {
      sidebar.postMessage("skipResult", { count: 0, label: "" });
      return;
    }
    resolveSegments(currentEpisode, true);
  });

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
      stopTimeWatcher();
    } else if (currentEpisode) {
      resolveSegments(currentEpisode);
    }
    log("Skip segments " + (skipEnabled ? "enabled" : "disabled"));
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
  // The state reset comes first on purpose. sidebar.loadFile throws if the
  // player window is not loaded yet, and setupSidebar() was called first, so a
  // throw there skipped every line below and left the previous file's
  // segments, its time observer and a visible card in place. The postMessage
  // calls after it do not throw when the window is down; IINA swallows them,
  // which is why the window-loaded handshake re-sends fileChanged.
  currentEpisode = null;
  segments = [];
  activeSegment = null;
  hideSkip();
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
