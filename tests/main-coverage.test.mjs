// The areas an audit found had no coverage at all. Each test here corresponds to
// a deliberate break of main.js that the suite used to accept: the overlay
// lifecycle, the time observer, the provider parsers, which IMDb id is used,
// the staleness counter across two episodes, and the cache.
//
// Every one was checked by reverting the behaviour it describes and watching
// the test fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMain, settle } from "./helpers/main-harness.mjs";

const IMDB = "tt0944947";

const EPISODE = {
  isMovie: false, showTitle: "Severance", epTitle: "Good News", code: "S01E01",
  airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "",
  context: "", tmdbId: "1399", season: 1, episode: 1, parentImdbId: IMDB
};

function ep(n) {
  return Object.assign({}, EPISODE, { episode: n, code: "S01E0" + n });
}

function introKey(episode) {
  return `https://api.introdb.app/segments?imdb_id=${IMDB}&season=1&episode=${episode}`;
}

function hit(start, end) {
  return { statusCode: 200, data: { intro: { start_sec: start, end_sec: end } } };
}

// A session with skip intro on and a key, which is what resolveSegments needs
// before it will do anything at all.
function session(opts = {}) {
  const m = loadMain(Object.assign({
    status: { paused: false, duration: 1400, url: "file:///v/a.mkv" },
    mpvProps: { duration: 1400 },
    http: {}
  }, opts));
  m.emit("iina.window-loaded");
  m.runTimers();
  return m;
}

function skipSession(http, opts = {}) {
  const m = session(Object.assign({ http: http || {} }, opts));
  m.fromWebView("sidebar", "setTmdbKey", { key: "K" });
  m.fromWebView("sidebar", "setSkipEnabled", { enabled: true });
  return m;
}

function overlayCalls(m, verb) {
  return m.sink.calls.filter((c) => c[0] === "overlay" && c[1] === verb);
}

// ── Overlay lifecycle ───────────────────────────────────────────────

test("a card is shown once an episode is chosen, and hidden on the next file", () => {
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();          // the pause delay
  assert.equal(m.global.cardVisible, true, "the card was never shown");
  assert.equal(m.posted("overlay", "showData").length, 1);
  assert.equal(m.posted("sidebar", "overlayShowing").pop().visible, true,
    "the sidebar was not told the card is up");
  assert.equal(overlayCalls(m, "show").length, 1);

  m.emit("iina.file-loaded");
  assert.equal(m.global.cardVisible, false, "the card survived a new file");
  assert.equal(overlayCalls(m, "hide").length >= 1, true, "the overlay was never hidden");
  // The sidebar shrinks its own padding when the overlay is up, so it has to be
  // told when it goes away as well as when it arrives.
  assert.equal(m.posted("sidebar", "overlayShowing").pop().visible, false,
    "the sidebar was not told the card went away");
});

test("the overlay stays up while either the card or the pill wants it", () => {
  // One WebView serves two independent things. syncOverlay decides whether to
  // show or hide it, so getting it wrong tears the card down when the pill is
  // up, or the pill down after a skip.
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();
  const before = overlayCalls(m, "hide").length;

  m.global.skipVisible = true;
  m.global.syncOverlay();
  assert.equal(overlayCalls(m, "hide").length, before,
    "the overlay was hidden while the card was still up");

  m.global.cardVisible = false;
  m.global.syncOverlay();
  assert.equal(overlayCalls(m, "hide").length, before,
    "the overlay was hidden while the pill was still up");

  m.global.skipVisible = false;
  m.global.syncOverlay();
  assert.equal(overlayCalls(m, "hide").length, before + 1,
    "the overlay stayed up with nothing left to show");
});

test("pausing before the lookup finishes still shows the card", () => {
  // Identification is asynchronous. presentIfPaused exists so a pause during
  // the lookup is not lost; without it the user is left paused with nothing.
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  assert.equal(m.global.currentEpisode, null);
  m.global.presentIfPaused();
  assert.equal(m.global.cardVisible, false, "a card appeared with no episode");

  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();          // the pause delay
  assert.equal(m.global.cardVisible, true, "the late answer never reached the card");
});

test("an unpaused player is not given a card", () => {
  const m = session();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.hideOverlay();
  m.global.presentIfPaused();
  m.runTimers();
  assert.equal(m.global.cardVisible, false, "a card appeared while playing");
});

test("a card that is already up is refreshed rather than torn down and rebuilt", () => {
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();          // the pause delay, so the card is actually up
  assert.equal(m.global.cardVisible, true, "the card never appeared to refresh");
  const shows = m.posted("overlay", "showData").length;
  const hides = overlayCalls(m, "hide").length;
  m.global.presentIfPaused();
  assert.equal(m.posted("overlay", "showData").length, shows + 1, "the card was not refreshed");
  assert.equal(overlayCalls(m, "hide").length, hides, "the card flashed off");
});

// ── The time observer ───────────────────────────────────────────────

test("the pill appears inside its range and goes away after it", () => {
  // The observer is the only thing that shows and hides the pill as playback
  // moves, and nothing drove it: a mutation of either bound passed the suite.
  const mpvProps = { duration: 1400, "time-pos": 20 };
  const m = skipSession({}, { mpvProps });
  m.global.segments = [{ kind: "intro", start: 30, end: 90 }];
  m.global.startTimeWatcher();

  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showSkip").length, 0, "the pill appeared early");

  mpvProps["time-pos"] = 40;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showSkip").length, 1, "the pill never appeared");
  // Field by field: the payload is built inside the vm realm, so deepStrictEqual
  // reports two identical objects as unequal.
  assert.equal(m.posted("overlay", "showSkip")[0].label, "Skip Intro");
  assert.deepEqual(m.global.activeSegment, { kind: "intro", start: 30, end: 90 });
  // The overlay swallows clicks unless something with data-clickable is under
  // the pointer, so a visible pill has to make it clickable.
  const clicks = m.sink.calls.filter((c) => c[1] === "setClickable");
  assert.equal(clicks.length > 0, true, "the pill never made the overlay clickable");
  assert.equal(clicks[clicks.length - 1][2], true, "a visible pill was not clickable");

  mpvProps["time-pos"] = 60;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showSkip").length, 1, "the pill was shown twice");
  assert.equal(m.posted("overlay", "hideSkip").length, 0, "the pill was hidden mid-intro");

  mpvProps["time-pos"] = 95;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "hideSkip").length, 1, "the pill never went away");
  assert.equal(m.global.activeSegment, null, "the segment outlived the pill");
  // Clickability has to go with the pill, or the overlay keeps swallowing clicks
  // over a button that is no longer there.
  const clicksAfter = m.sink.calls.filter((c) => c[1] === "setClickable");
  assert.equal(clicksAfter[clicksAfter.length - 1][2], false,
    "the pill went away and the overlay stayed clickable");
});

test("a segment already in the past is not offered", () => {
  const mpvProps = { duration: 1400, "time-pos": 200 };
  const m = skipSession({}, { mpvProps });
  m.global.segments = [{ kind: "intro", start: 30, end: 90 }];
  m.global.startTimeWatcher();
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showSkip").length, 0, "a finished segment was offered");
});

test("no observer is armed twice", () => {
  // Every call re-registered the handler, so each identification left another
  // live observer behind on the same event, and all of them ran.
  const m = skipSession();
  m.global.segments = [{ kind: "intro", start: 0, end: 90 }];
  m.global.startTimeWatcher();
  const first = m.global.timeWatcher;
  const registered = m.sink.eventRegistrations.filter((n) => n === "mpv.time-pos.changed").length;
  m.global.startTimeWatcher();
  assert.equal(m.global.timeWatcher, first, "a second observer replaced the first");
  assert.equal(m.sink.eventRegistrations.filter((n) => n === "mpv.time-pos.changed").length,
    registered, "a second observer was armed on the same event");
});

// ── Provider parsers ────────────────────────────────────────────────

test("IntroDB's recap and outro are read as themselves", () => {
  const m = skipSession({});
  const out = [];
  m.global.pushSegment(out, "recap", 5, 40, "introdb");
  m.global.pushSegment(out, "outro", 1200, 1320, "introdb");
  m.global.pushSegment(out, "intro", 60, 150, "introdb");
  assert.deepEqual(out.map((s) => s.kind), ["recap", "outro", "intro"]);
});

test("SkipDB's low-confidence answers are left out", async () => {
  // SkipDB grades its own answers and below the bar the timing is a guess.
  const low = "https://api.skipdb.tv/api/segments?imdb_id=" + IMDB + "&season=1&episode=1";
  const m = skipSession({
    [low]: { statusCode: 200, data: { segments: { intro: { start_ms: 0, end_ms: 90000, confidence: 0.4 } } } }
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.sink.httpCalls.some((u) => u.includes("skipdb")), true, "SkipDB was never asked");
  assert.equal(m.global.segments.length, 0, "a 0.4-confidence answer was used");

  const m2 = skipSession({
    [low]: { statusCode: 200, data: { segments: { intro: { start_ms: 0, end_ms: 90000, confidence: 0.9 } } } }
  });
  m2.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m2.global.segments.length, 1, "a confident answer was thrown away");
});

test("AniSkip's ed kinds are endings and its recap is not an intro", async () => {
  const m = skipSession({
    "https://arm.haglund.dev/api/v2/imdb": [{ myanimelist: 16498, title: "x" }],
    "https://api.aniskip.com/v2/skip-times/16498/1?types[]=op&types[]=ed&types[]=recap&episodeLength=0": {
      statusCode: 200,
      data: {
        found: true,
        results: [
          { skipType: "ed", interval: { startTime: 1300, endTime: 1380 } },
          { skipType: "recap", interval: { startTime: 5, endTime: 60 } }
        ]
      }
    }
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const kinds = m.global.segments.map((s) => s.kind);
  assert.ok(kinds.includes("outro"), "an ed was not read as an ending: " + kinds.join(","));
  assert.ok(kinds.includes("recap"), "a recap was thrown away: " + kinds.join(","));
  assert.equal(kinds.indexOf("recap") >= 0 && kinds.includes("intro"), false,
    "a recap was flattened into an intro: " + kinds.join(","));
});

test("ARM picks the entry for the season asked for, and the first when there is one", async () => {
  const arm = "https://arm.haglund.dev/api/v2/imdb";
  const two = skipSession({
    [arm]: [
      { myanimelist: 111, title: "season one" },
      { myanimelist: 222, title: "season two" }
    ]
  });
  assert.equal(await two.global.malIdFor(IMDB, 2), "222");

  const one = skipSession({
    [arm]: [{ myanimelist: 111, title: "only" }]
  });
  // Asking for a season ARM has no entry for falls back to what it does have,
  // rather than reporting the title is not anime.
  assert.equal(await one.global.malIdFor(IMDB, 3), "111");

  const none = skipSession({ [arm]: [] });
  assert.equal(await none.global.malIdFor(IMDB, 1), null, "an empty answer claimed an id");
});

test("TheIntroDB's vague boundaries become placeholders", async () => {
  const m = skipSession({
    ["https://api.theintrodb.org/v2/media?imdb_id=" + IMDB + "&season=1&episode=1"]: {
      intro: [{ start_ms: null, end_ms: 90000 }]
    }
  });
  // The raw provider answer is where the precision lives; the merged segment
  // deliberately drops it, because by then the boundary has been chosen.
  const raw = await m.global.segmentsFromApis(IMDB, 1, 1);
  assert.equal(raw.length, 1, "a from-the-beginning marker was dropped");
  assert.equal(raw[0].start, 0);
  assert.equal(raw[0].preciseStart, false, "a placeholder start was treated as measured");
  assert.equal(raw[0].preciseEnd, true);

  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.global.segments.length, 1, "the marker did not survive the merge");
  assert.equal(m.global.segments[0].start, 0);
});

// ── Which IMDb id is used ───────────────────────────────────────────

test("a show uses its show-level id, not the episode's own", async () => {
  const m = skipSession({ [introKey(1)]: hit(0, 90) });
  m.fromWebView("sidebar", "episodeSelected", Object.assign({}, EPISODE, {
    imdbId: "ttEPISODELEVEL", parentImdbId: IMDB
  }));
  await settle();
  const calls = m.sink.httpCalls.filter((u) => u.includes("introdb"));
  assert.equal(calls.length > 0, true, "no lookup was made");
  assert.ok(calls[0].includes(IMDB), "the wrong id was used: " + calls[0]);
  assert.ok(!calls[0].includes("ttEPISODELEVEL"),
    "the episode-level id was used, which returns nothing for other episodes");
});

test("a film uses its own id", async () => {
  const m = skipSession({});
  m.fromWebView("sidebar", "episodeSelected", {
    isMovie: true, showTitle: "Fight Club", epTitle: "Fight Club", code: "",
    airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "", context: "",
    tmdbId: "550", imdbId: "tt0137523", parentImdbId: "ttSHOWLEVEL"
  });
  await settle();
  const calls = m.sink.httpCalls.filter((u) => u.includes("introdb"));
  assert.equal(calls.length > 0, true, "no lookup was made");
  assert.ok(calls[0].includes("tt0137523"), "the wrong id was used: " + calls[0]);
});

test("canonicalImdb normalises what TMDB hands back", () => {
  const { g } = { g: session().global };
  // TMDB hands these back lowercase, so the prefix is all that is corrected.
  assert.equal(g.canonicalImdb("TT0944947"), "TT0944947");
  assert.equal(g.canonicalImdb("tt0944947"), "tt0944947");
  assert.equal(g.canonicalImdb(""), null);
  assert.equal(g.canonicalImdb(null), null);
  // A bare TMDB id is what main.js hands it most of the time, so a number
  // without the prefix is completed rather than rejected.
  assert.equal(g.canonicalImdb("0944947"), "tt0944947");
});

// ── The staleness counter, across two different episodes ────────────

test("two episodes in quick succession: the older answer must not win", async () => {
  // The generation counter is the only thing separating these two runs. The
  // existing overlap test cannot see it, because its stale run hits the cache
  // and returns early. Two different episodes are two different cache keys, so
  // the stale run really does fetch, really does finish last, and must be
  // refused.
  let release1, release2;
  const gate1 = new Promise((r) => { release1 = r; });
  const gate2 = new Promise((r) => { release2 = r; });
  const m = skipSession({
    [introKey(1)]: () => gate1.then(() => hit(10, 70)),
    [introKey(2)]: () => gate2.then(() => hit(600, 660))
  });

  m.fromWebView("sidebar", "episodeSelected", ep(1));
  await settle();
  m.fromWebView("sidebar", "episodeSelected", ep(2));
  await settle();
  assert.ok(m.sink.httpCalls.includes(introKey(1)), "the first episode never looked up");
  assert.ok(m.sink.httpCalls.includes(introKey(2)), "the second episode never looked up");

  release2();                       // the current episode answers
  await settle();
  assert.equal(m.global.segments[0].start, 600, "the second episode did not answer");

  release1();                       // the stale one answers last
  await settle();
  assert.equal(m.global.segments.length, 1, "the stale run installed an answer");
  assert.equal(m.global.segments[0].start, 600,
    "the stale answer won: " + JSON.stringify(m.global.segments));
  assert.equal(m.global.currentEpisode.episode, 2, "the wrong episode is current");
});

// ── Chapters ────────────────────────────────────────────────────────

test("usable chapters mean no lookup at all", async () => {
  const m = skipSession({}, {
    chapters: [{ title: "Intro", start: 0 }, { title: "Episode", start: 90 }]
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.sink.httpCalls.filter((u) => u.includes("introdb")).length, 0,
    "the databases were asked despite usable chapters");
  assert.equal(m.posted("sidebar", "skipResult").length > 0, true, "nothing was reported");
});

test("Search again ignores chapters and asks the databases", async () => {
  // The chapters short-circuit ran before forceRefresh was ever consulted, so
  // for any file that ships chapter markers the button did nothing at all while
  // the sidebar kept reporting the same result.
  const m = skipSession({ [introKey(1)]: hit(5, 95) }, {
    chapters: [{ title: "Intro", start: 0 }, { title: "Episode", start: 120 }]
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.global.segments[0].end, 120, "the chapter answer was not used first");

  m.fromWebView("sidebar", "refreshSkip", {});
  await settle();
  assert.equal(m.sink.httpCalls.filter((u) => u.includes("introdb")).length > 0, true,
    "Search again never contacted a database");
  assert.equal(m.global.segments[0].end, 95,
    "Search again kept the chapter answer: " + JSON.stringify(m.global.segments));
});

test("the last chapter ends with the file when the duration is not known yet", () => {
  // getNumber answers 0 until metadata arrives, and the old code dropped the
  // final chapter outright rather than guess.
  const m = skipSession({}, {
    chapters: [{ title: "Episode", start: 0 }, { title: "Credits", start: 1200 }],
    mpvProps: { duration: 0 }
  });
  const segs = m.global.segmentsFromChapters();
  const credits = segs.find((s) => s.kind === "outro");
  assert.ok(credits, "the credits chapter was dropped: " + JSON.stringify(segs));
  assert.ok(credits.end > 1200, "the credits end at " + credits.end);
});

test("a known duration is used for the last chapter", () => {
  const m = skipSession({}, {
    chapters: [{ title: "Episode", start: 0 }, { title: "Credits", start: 1200 }],
    status: { paused: false, duration: 1500, url: "file:///v/a.mkv" },
    mpvProps: { duration: 1500 }
  });
  // Both sources are asked, in that order, and they are the same number in
  // reality: reading one for the chapter end and the other for the fallback
  // meant a one-second overshoot whenever they were not.
  assert.equal(m.global.segmentsFromChapters().find((s) => s.kind === "outro").end, 1500);
});

// ── The cache ───────────────────────────────────────────────────────

test("an empty answer is not cached", async () => {
  // [] is truthy, so one outage pinned the episode to "nothing found" for the
  // rest of the session, with only Search again able to clear it.
  const m = skipSession({ [introKey(1)]: { statusCode: 200, data: { intro: null } } });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const empty = Object.keys(m.global.segmentCache)
    .filter((k) => !m.global.segmentCache[k].length);
  assert.deepEqual(empty, [], "an empty result was cached");
});

test("a real answer is cached, and Search again re-asks anyway", async () => {
  const m = skipSession({ [introKey(1)]: hit(0, 90) });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const keys = Object.keys(m.global.segmentCache);
  assert.equal(keys.length, 1, "the answer was not cached: " + JSON.stringify(keys));
  const before = m.sink.httpCalls.filter((u) => u === introKey(1)).length;

  m.fromWebView("sidebar", "refreshSkip", {});
  await settle();
  assert.equal(m.sink.httpCalls.filter((u) => u === introKey(1)).length, before + 1,
    "Search again served the cache instead of re-asking");
});

test("the cache is bounded", () => {
  const m = skipSession();
  const n = m.global.SEGMENT_CACHE_MAX + 25;
  for (let i = 0; i < n; i++) m.global.rememberSegments("k" + i, [{ kind: "intro", start: 0, end: 90 }]);
  const keys = Object.keys(m.global.segmentCache);
  assert.equal(keys.length, m.global.SEGMENT_CACHE_MAX, "the cache grew past its cap");
  // The most recent answers are the ones kept.
  assert.ok(m.global.segmentCache["k" + (n - 1)], "the newest entry was evicted");
  assert.equal(m.global.segmentCache.k0, undefined, "the oldest entry was kept");
});

// ── A lookup that is superseded still answers ───────────────────────

test("an abandoned lookup reports, so Search again comes back", async () => {
  // The sidebar disables the button and re-enables it only on skipResult. Every
  // !live() return used to skip that, which left it stuck on "Searching…" for
  // the rest of the session: nothing else re-renders it.
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = skipSession({ [introKey(1)]: () => gate });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.posted("sidebar", "skipResult").length, 0, "the parked lookup reported early");

  // Move on, then let the request answer. The run is stale by then, so it will
  // not install anything, and it still has to say so.
  m.emit("iina.file-loaded");
  release(hit(0, 90));
  await settle();
  assert.equal(m.posted("sidebar", "skipResult").length >= 1, true,
    "the abandoned lookup never reported: " +
    JSON.stringify(m.posted("sidebar", "skipResult")));
});
// ── Merging ────────────────────────────────────────────────────────

test("two sources that merge into something too short fall back to one of them", () => {
  // Two sources that overlap enough to be believed, whose consensus lands
  // between them at 51.2-53.85, under the three-second minimum. Dropping the
  // whole kind made the intro disappear with no explanation; a mediocre pill is
  // better than none.
  const { g } = { g: session().global };
  const out = g.mergeSegments([
    { kind: "intro", start: 51.2, end: 54.2, source: "introdb", preciseStart: true, preciseEnd: true },
    { kind: "intro", start: 52, end: 53.5, source: "skipdb", preciseStart: true, preciseEnd: true }
  ]);
  assert.equal(out.length, 1, "the intro vanished: " + JSON.stringify(out));
  assert.ok(g.validSegment(out[0]), "the fallback is not a usable segment");
  assert.equal(out[0].start, 51.2, "the fallback should be one source intact");
  assert.equal(out[0].end, 54.2);
  assert.equal(out[0].sources.length, 1, "a single source claimed corroboration");
  assert.equal(out[0].sources[0], "introdb");
});

test("a merge that is valid is used as measured", () => {
  const { g } = { g: session().global };
  const out = g.mergeSegments([
    { kind: "intro", start: 0, end: 110, source: "introdb", preciseStart: true, preciseEnd: true },
    { kind: "intro", start: 0, end: 100, source: "skipdb", preciseStart: true, preciseEnd: true }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources.sort(), ["introdb", "skipdb"], "corroboration was lost");
  assert.equal(out[0].agreed, 2);
});

test("a small overlap is not treated as agreement", () => {
  // The clustering threshold decides when two answers count as one, so it has
  // to be pinned in the direction that matters: too eager and two unrelated
  // answers corroborate each other, and the more reliable one loses.
  const { g } = { g: session().global };
  const out = g.mergeSegments([
    { kind: "intro", start: 0, end: 100, source: "skipdb", preciseStart: true, preciseEnd: true },
    { kind: "intro", start: 80, end: 180, source: "introdb", preciseStart: true, preciseEnd: true }
  ]);
  assert.equal(out.length, 1, "one kind, one answer");
  assert.equal(out[0].agreed, 1, "a 20% overlap was treated as agreement");
  assert.equal(out[0].start, 80, "the more reliable source lost a non-merge");
});

// ── The timeout wrapper ─────────────────────────────────────────────

test("a promise that wins disarms its deadline", async () => {
  // Seven sources, each with a deadline. A deadline left armed after the race
  // is decided fires into a run that has already finished, and holds the event
  // loop for the length of HTTP_TIMEOUT_MS doing nothing.
  const m = session();
  const before = m.pendingTimers();
  assert.equal(await m.global.withTimeout(Promise.resolve("ok"), 10, "fast"), "ok");
  assert.equal(m.pendingTimers(), before, "the deadline was left armed after the race was won");

  // The rejection path disarms it too.
  const r = session();
  const beforeReject = r.pendingTimers();
  await r.global.withTimeout(Promise.reject(new Error("nope")), 10, "bad").catch(() => {});
  assert.equal(r.pendingTimers(), beforeReject, "a failed request left its deadline armed");

  // …and it really does fire when nothing beats it.
  const n = session();
  const armed = n.pendingTimers();
  const outcome = n.global.withTimeout(new Promise(() => {}), 10, "slow")
    .then(() => "resolved", () => "rejected");
  assert.equal(n.pendingTimers(), armed + 1, "no deadline was armed");
  n.runTimers();
  assert.equal(await outcome, "rejected");
});

test("an identification leaves no deadline behind", async () => {
  const m = skipSession({ [introKey(1)]: hit(0, 90) });
  const before = m.pendingTimers();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  // The give-up timer is not disarmed by design; every per-source deadline is.
  assert.ok(m.pendingTimers() <= before + 1,
    "deadlines were left armed: " + (m.pendingTimers() - before));
});

// ── The wiring layer ────────────────────────────────────────────────
// Everything above drove the internals directly. These drive the paths IINA
// actually enters through: the event bus, the WebView messages and the menu.

test("the observer is switched off, not just forgotten", () => {
  // The harness's event.off used to record the call and leave the handler in
  // place, so "stops the time observer" could not fail. It now unregisters.
  const m = skipSession();
  m.global.segments = [{ kind: "intro", start: 0, end: 90 }];
  m.global.startTimeWatcher();
  assert.equal(m.listening("mpv.time-pos.changed"), true, "no observer was armed");
  m.global.stopTimeWatcher();
  assert.equal(m.listening("mpv.time-pos.changed"), false,
    "the observer is still listening after being stopped");
  assert.equal(m.global.timeWatcher, null);
});

test("a cleared selection stops the observer for real", async () => {
  const m = skipSession({ [introKey(1)]: hit(0, 90) });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.listening("mpv.time-pos.changed"), true, "nothing was watching");
  m.fromWebView("sidebar", "clearEpisode", {});
  assert.equal(m.listening("mpv.time-pos.changed"), false,
    "the observer outlived the selection");
  assert.equal(m.global.segments.length, 0);
});

test("a file change stops the observer and the card, and clears the window title", () => {
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();
  assert.ok(m.sink.mpvSet["media-title"], "the window title was never set");

  m.emit("iina.file-loaded");
  assert.equal(m.listening("mpv.time-pos.changed"), false);
  assert.equal(m.global.cardVisible, false);
  assert.equal(m.global.currentEpisode, null);
  // The window title, the Now Playing panel and IINA's playlist all read this,
  // and identification is a multi-request ladder: left set, they named the
  // previous episode until the next answer arrived.
  assert.equal(m.sink.mpvSet["media-title"], "",
    "the previous episode is still named as what is playing");
});

test("the menu item and ⌥S reach the same skip path", () => {
  // README: "click it or press ⌥S". Both arrive as the same handler.
  const m = session();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.activeSegment = { kind: "intro", start: 0, end: 90 };
  m.global.skipVisible = true;
  const item = m.sink.menuItem;
  assert.ok(item && typeof item.fn === "function", "no Plugins menu item was added");
  const before = m.sink.seeks.length;
  item.fn();
  assert.equal(m.sink.seeks.length, before + 1, "the menu item did not skip");
  assert.equal(m.sink.seeks[m.sink.seeks.length - 1], 90);
});

test("the card carries what the overlay needs", () => {
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  m.fromWebView("sidebar", "setOverlayTheme", { value: "compact" });
  m.fromWebView("sidebar", "episodeSelected", Object.assign({}, EPISODE, {
    isMovie: true, showTitle: "Fight Club", epTitle: "Fight Club", code: ""
  }));
  m.runTimers();
  const card = m.posted("overlay", "showData").pop();
  assert.equal(card.showTitle, "Fight Club");
  assert.equal(card.epTitle, "Fight Club");
  assert.equal(card.isMovie, true);
  assert.equal(card.theme, "compact");
  assert.equal(card.code, "", "a film was sent with a season code");
  assert.equal(card.posterUrl, "");
  assert.equal(typeof card.bgOpacity, "number");
});

test("switching the overlay off stops the card from appearing", () => {
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  m.fromWebView("sidebar", "setOverlayEnabled", { enabled: false });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();
  assert.equal(m.global.cardVisible, false, "a card appeared with the overlay off");
  assert.equal(m.posted("overlay", "showData").length, 0);
  // Called directly as well: presentIfPaused has its own guard, so going
  // through it proves nothing about showOverlay's.
  m.global.showOverlay(EPISODE);
  assert.equal(m.posted("overlay", "showData").length, 0,
    "showOverlay drew a card with the overlay switched off");

  m.fromWebView("sidebar", "setOverlayEnabled", { enabled: true });
  m.global.presentIfPaused();
  m.runTimers();
  assert.equal(m.global.cardVisible, true, "the card did not come back");
});

test("a second pause does not queue a second card", () => {
  const m = session({ status: { paused: true, duration: 1400, url: "file:///v/a.mkv" } });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();
  m.global.hideOverlay();
  const before = m.pendingTimers();
  m.global.presentIfPaused();
  m.global.presentIfPaused();
  m.global.presentIfPaused();
  assert.equal(m.pendingTimers(), before + 1,
    "three pauses queued three cards: " + (m.pendingTimers() - before));
  m.runTimers();
  assert.equal(m.posted("overlay", "showData").length, 2, "the card was drawn more than once");
});

test("the window title names the episode, not the file", () => {
  const m = session();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  assert.equal(m.sink.mpvSet["media-title"], "Severance · Good News");
  // A film has no show name to prefix.
  m.fromWebView("sidebar", "episodeSelected", Object.assign({}, EPISODE, {
    isMovie: true, showTitle: "Fight Club", epTitle: "Fight Club"
  }));
  assert.equal(m.sink.mpvSet["media-title"], "Fight Club",
    "a film was titled with its own name twice");
});

test("switching skip intro off abandons the lookup in flight", async () => {
  // The counter's own comment promises this. Without it a lookup that finished
  // after the switch re-installed segments, re-armed the observer and wrote to
  // the cache while the feature was off.
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = skipSession({ [introKey(1)]: () => gate.then(() => hit(10, 70)) });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  m.fromWebView("sidebar", "setSkipEnabled", { enabled: false });
  assert.equal(m.global.segments.length, 0, "segments survived the switch");

  release();
  await settle();
  assert.equal(m.global.segments.length, 0, "the abandoned lookup installed segments");
  assert.equal(m.listening("mpv.time-pos.changed"), false, "the observer was re-armed");
  assert.deepEqual(Object.keys(m.global.segmentCache), [], "the cache was written while off");
});

test("a superseded lookup says nothing about the episode", async () => {
  // It reports so the sidebar's button comes back, but with stale set: the
  // sidebar prints what it is told, and "nothing found" would also swallow the
  // real answer that is on its way.
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = skipSession({ [introKey(1)]: () => gate });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  m.emit("iina.file-loaded");
  release(hit(0, 90));
  await settle();

  const results = m.posted("sidebar", "skipResult");
  assert.ok(results.length > 0, "the button was never re-enabled");
  assert.equal(results[results.length - 1].stale, true,
    "a superseded run reported as a real answer: " + JSON.stringify(results[results.length - 1]));
  assert.equal(results[results.length - 1].count, 0);
});

test("a database answer replaces the chapter answer, and chapters survive an empty one", async () => {
  // "Search again" must ask the databases, but a file whose chapters are the
  // answer must not lose them because the databases have nothing.
  const withHit = skipSession({ [introKey(1)]: hit(5, 95) }, {
    chapters: [{ title: "Intro", start: 0 }, { title: "Episode", start: 120 }]
  });
  withHit.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  withHit.fromWebView("sidebar", "refreshSkip", {});
  await settle();
  assert.equal(withHit.global.segments[0].end, 95, "the chapter answer was not replaced");

  const empty = skipSession({ [introKey(1)]: { statusCode: 200, data: { intro: null } } }, {
    chapters: [{ title: "Intro", start: 0 }, { title: "Episode", start: 120 }]
  });
  empty.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  empty.fromWebView("sidebar", "refreshSkip", {});
  await settle();
  assert.equal(empty.global.segments.length, 1,
    "the working chapter answer was thrown away: " + JSON.stringify(empty.global.segments));
  assert.equal(empty.global.segments[0].end, 120);
  assert.equal(empty.listening("mpv.time-pos.changed"), true,
    "the observer was left disarmed with an answer to show");
});

test("IntroDB's own kinds are read by its parser, not just by pushSegment", async () => {
  const m = skipSession({
    ["https://api.introdb.app/segments?imdb_id=" + IMDB + "&season=1&episode=1"]: {
      statusCode: 200,
      data: {
        intro: { start_sec: 0, end_sec: 90 },
        recap: { start_sec: 95, end_sec: 130 },
        outro: { start_sec: 1300, end_sec: 1380 }
      }
    }
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const kinds = m.global.segments.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ["intro", "outro", "recap"],
    "IntroDB's kinds were flattened: " + JSON.stringify(m.global.segments));
});

test("a lookup that throws still answers", () => {
  // Every call site is fire-and-forget, so a throw would be an unhandled
  // rejection and the button would stay on "Searching…" for the session.
  const m = skipSession({
    ["https://api.introdb.app/segments?imdb_id=" + IMDB + "&season=1&episode=1"]: () => {
      throw new Error("hostile");
    }
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  return settle().then(() => {
    assert.ok(m.posted("sidebar", "skipResult").length > 0,
      "a failed lookup never reported, so the button stayed disabled");
  });
});

// ── The pause delay is counted from the pause ───────────────────────
// The delay exists so "paused briefly to rewind" does not flash a card. It is
// therefore time spent paused, and a lookup that lands late has already had the
// user's pause spent on it. The countdown used to start when the answer
// arrived, so a slow ladder added its whole duration on top of the delay.

function clocked(pauseDelay) {
  const m = session();
  let now = 1000;
  m.global.Date.now = () => now;
  m.fromWebView("sidebar", "setPauseDelay", { value: pauseDelay });
  return { m, at: (t) => { now = t; }, now: () => now };
}

test("a lookup that lands late does not restart the pause delay", async () => {
  const { m, at } = clocked(1);
  // Paused with nothing identified yet, then the ladder takes four seconds.
  m.setPaused(true);
  m.emit("mpv.pause.changed");
  at(5000);
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  // Four seconds paused is far more than the one-second delay, so the card is
  // due the moment there is anything to put in it.
  assert.equal(m.global.cardVisible, true,
    "the card waited out the delay again after the lookup");
});

test("part of the delay is already spent when the answer lands", async () => {
  const { m, at } = clocked(1);
  m.setPaused(true);
  m.emit("mpv.pause.changed");
  at(1400);                              // 400ms of the second gone
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  // 600ms left, not 1000.
  assert.deepEqual(m.sink.timerMs.slice(-1), [600],
    "the countdown restarted instead of resuming");
  assert.equal(m.global.cardVisible, false, "the card appeared before the delay was up");
  m.runTimers();
  assert.equal(m.global.cardVisible, true);
});

test("a lookup that lands mid-delay does not double up the timer", async () => {
  const { m, at } = clocked(3);
  // Already identified, so the pause actually starts a countdown.
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  m.setPaused(true);
  m.emit("mpv.pause.changed");
  const armed = m.pendingTimers();
  assert.equal(armed, 1, "the pause armed no countdown");
  // A second answer for the same pause, while the countdown is running.
  at(1100);
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.pendingTimers(), armed, "a second countdown was armed for one pause");
});

test("a new file does not inherit the previous file's spent pause", async () => {
  const { m, at } = clocked(1);
  m.setPaused(true);
  m.emit("mpv.pause.changed");
  at(9000);                              // a long pause on the old file
  m.global.setPaused ? null : null;
  m.emit("iina.file-loaded");
  // The new file is identified while still paused: its own delay applies.
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.global.cardVisible, false,
    "the new file's card appeared instantly, inheriting the old pause");
});

test("resuming clears the pause stamp", async () => {
  const { m, at } = clocked(1);
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  m.setPaused(true);
  m.emit("mpv.pause.changed");
  m.runTimers();
  m.setPaused(false);
  m.emit("mpv.pause.changed");
  assert.equal(m.global.pausedAt, 0, "the pause stamp outlived the resume");

  // A long gap, then a fresh pause: the countdown is the full delay again, not
  // whatever was left of the previous pause.
  at(9000);
  m.setPaused(true);
  m.emit("mpv.pause.changed");
  assert.deepEqual(m.sink.timerMs.slice(-1), [1000], "the stale stamp was counted");
});
