import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMain, settle } from "./helpers/main-harness.mjs";

// The skip-intro machinery is the most intricate logic in the plugin and the
// only part with no tests at all: eight deliberate breaks to it passed the suite
// before this file existed, because main.js was merely syntax-checked.

const T = "IntroDB";
const S2 = "SkipDB";
const S3 = "TheIntroDB";

function seg(start, end, kind, source, opts) {
  const o = Object.assign({
    kind, start, end, source,
    preciseStart: true, preciseEnd: true
  }, opts || {});
  return o;
}

function boot() {
  const m = loadMain();
  return { m, g: m.global };
}

// ── validSegment ────────────────────────────────────────────────────

test("a reversed or zero-length range is rejected", () => {
  const { g } = boot();
  assert.equal(g.validSegment(seg(10, 5)), false, "end before start");
  assert.equal(g.validSegment(seg(10, 10)), false, "zero length");
  assert.equal(g.validSegment(seg(10, 11)), false, "under the 3s minimum");
  assert.equal(g.validSegment(null), false);
  assert.equal(g.validSegment({ kind: "intro", start: NaN, end: 20 }), false);
  assert.equal(g.validSegment({ kind: "intro", start: 0, end: "x" }), false);
});

test("a sane range is accepted", () => {
  const { g } = boot();
  assert.equal(g.validSegment(seg(0, 45)), true);
  assert.equal(g.validSegment(seg(30, 33)), true, "exactly the 3s minimum");
});

// ── pushSegment ─────────────────────────────────────────────────────

test("pushSegment drops anything invalid", () => {
  const { g } = boot();
  const out = [];
  g.pushSegment(out, "intro", 50, 10, T);
  g.pushSegment(out, "intro", NaN, 20, T);
  assert.equal(out.length, 0);
  g.pushSegment(out, "intro", 0, 45, T);
  assert.equal(out.length, 1);
});

test("a placeholder boundary is marked imprecise", () => {
  // "From the beginning" and "to the end" are not measurements, so a range with
  // one must never outrank a corroborated one.
  const { g } = boot();
  const out = [];
  g.pushSegment(out, "credits", 0, 1200, S3, { vagueEnd: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].preciseEnd, false, "a vague end was treated as precise");
  assert.equal(out[0].preciseStart, true);
});

// ── overlapRatio and median ─────────────────────────────────────────

test("overlapRatio measures how much two ranges coincide", () => {
  // It takes {start, end} objects, not arrays.
  const { g } = boot();
  const r = (a, b) => g.overlapRatio({ start: a, end: b }, { start: b, end: b });
  assert.equal(g.overlapRatio({ start: 0, end: 100 }, { start: 0, end: 100 }), 1,
    "identical ranges");
  assert.equal(g.overlapRatio({ start: 0, end: 100 }, { start: 200, end: 300 }), 0,
    "disjoint ranges");
  const half = g.overlapRatio({ start: 0, end: 100 }, { start: 50, end: 150 });
  assert.ok(half > 0.3 && half < 0.7, `partial overlap scored ${half}`);
  assert.ok(r(0, 100) >= 0);
});

test("median ignores outliers", () => {
  const { g } = boot();
  // A mean would be dragged to 100 by the outlier; the median must not be.
  assert.equal(g.median([10, 20, 30, 100000]), 25);
  assert.equal(g.median([5]), 5);
  assert.equal(g.median([]), 0, "an empty list must not yield NaN into a segment end");
});

// ── Source ranking ──────────────────────────────────────────────────

test("distinctSources lists the different databases behind a group", () => {
  // It returns the names, and callers take the length.
  const { g } = boot();
  assert.equal(g.distinctSources([seg(0, 90, "intro", T), seg(0, 90, "intro", S2)]).length, 2);
  assert.equal(g.distinctSources([seg(0, 90, "intro", T), seg(0, 90, "intro", T)]).length, 1);
});

test("an agreed range outranks a single loud one", () => {
  const { g } = boot();
  const corroborated = [seg(0, 90, "intro", T), seg(0, 90, "intro", S2), seg(0, 90, "intro", S3)];
  const alone = [seg(0, 90, "intro", T)];
  const best = g.mergeSegments([].concat(corroborated, alone));
  assert.equal(best.length, 1, "the ranges were not merged into one");
  assert.equal(best[0].agreed, 3, `wrong winner: ${best[0].sources.join("+")}`);
});

// ── mergeSegments ───────────────────────────────────────────────────

test("agreeing sources are merged into one range", () => {
  const { g } = boot();
  const merged = g.mergeSegments([
    seg(0, 90, "intro", T),
    seg(2, 92, "intro", S2),
    seg(1, 89, "intro", S3)
  ]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].end >= 88 && merged[0].end <= 93,
    `end was a mean of outliers: ${merged[0].end}`);
  assert.ok(merged[0].start <= 2, `start drifted: ${merged[0].start}`);
});

test("distant ranges stay separate", () => {
  const { g } = boot();
  const merged = g.mergeSegments([
    seg(0, 90, "intro", T),
    seg(600, 700, "credits", T)
  ]);
  assert.equal(merged.length, 2, "an intro and a 10 minutes later were merged");
  assert.equal(merged[0].kind, "intro");
  assert.equal(merged[1].kind, "credits");
});

test("the earliest start wins, not the latest", () => {
  const { g } = boot();
  const merged = g.mergeSegments([
    seg(30, 90, "intro", T),
    seg(0, 90, "intro", S2)
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start, 0, `start was pushed to ${merged[0].start}`);
});

// mergeSegments groups by kind, so the order of the result is the order the
// kinds were first seen, not time order. Nothing depends on it: the time
// watcher tests every segment, and the label is the only place it shows.
test("every kind survives the merge exactly once", () => {
  const { g } = boot();
  const merged = g.mergeSegments([
    seg(600, 700, "credits", T),
    seg(0, 90, "intro", T),
    seg(300, 400, "recap", T)
  ]);
  // Order is unspecified, so compare the set. Joined rather than deep-compared
  // because the array is built inside the vm realm.
  assert.equal(merged.map((x) => x.kind).sort().join(","), "credits,intro,recap");
});

test("merging nothing yields nothing", () => {
  const { g } = boot();
  assert.equal(g.mergeSegments([]).length, 0);
});

// ── Chapter detection ───────────────────────────────────────────────

test("a chapter named like an intro is detected", () => {
  const { m, g } = loadMainWithChapters([
    { title: "Intro", start: 0 },
    { title: "Episode", start: 90 },
    { title: "Credits", start: 1200 }
  ]);
  const segs = g.segmentsFromChapters();
  assert.ok(segs.length >= 1, "no intro found in the chapter list");
  assert.ok(segs.some((x) => x.kind === "intro"), `kinds: ${segs.map((x) => x.kind)}`);
});

test("chapters with no markers yield nothing", () => {
  const { g } = loadMainWithChapters([
    { title: "Part One", start: 0 },
    { title: "Part Two", start: 600 }
  ]);
  assert.equal(g.segmentsFromChapters().length, 0);
});

test("a single chapter cannot define a range", () => {
  const { g } = loadMainWithChapters([{ title: "Intro", start: 0 }]);
  assert.equal(g.segmentsFromChapters().length, 0);
});

function loadMainWithChapters(chapters) {
  const m = loadMain({ chapters, mpvProps: { duration: 1400 } });
  return { m, g: m.global };
}

// ── Formatting ──────────────────────────────────────────────────────

test("times format as minutes and seconds", () => {
  const { g } = boot();
  assert.equal(g.fmtTime(0), "0:00");
  assert.equal(g.fmtTime(65), "1:05");
  assert.equal(g.fmtTime(3725), "1:02:05", "an hour-long credits range needs an hour field");
});

// ── withTimeout ─────────────────────────────────────────────────────

test("a slow promise is abandoned at the deadline", async () => {
  const { m, g } = boot();
  // Armed, not awaited: the deadline only fires when the timers are run, so
  // awaiting first would wait forever.
  const outcome = g.withTimeout(new Promise(() => {}), 10, "slow")
    .then(() => "resolved", () => "rejected");
  m.runTimers();
  assert.equal(await outcome, "rejected", "the deadline never fired");
});

test("a fast promise wins and the deadline does not fire afterwards", async () => {
  const { m, g } = boot();
  assert.equal(await g.withTimeout(Promise.resolve("ok"), 10, "fast"), "ok");
  // Nothing should reject after the race was already decided.
  let late = false;
  g.withTimeout(new Promise(() => {}), 10, "late").catch(() => { late = true; });
  m.runTimers();
  await settle();
  assert.equal(late, true, "a disarmed deadline never rejected at all");
});

test("errStr makes something readable out of anything", () => {
  const { g } = boot();
  assert.equal(g.errStr(null), "Unknown error");
  assert.equal(g.errStr("boom"), "boom");
  assert.equal(g.errStr(new Error("bang")), "bang");
  assert.equal(g.errStr({ message: "m" }), "m");
  assert.equal(typeof g.errStr({ weird: 1 }), "string");
});
// ── Seeking ─────────────────────────────────────────────────────────
// These need the event wiring, so they drive main.js the way IINA does:
// window-loaded, let the registration timers run, then deliver messages.

function session(opts = {}) {
  const m = loadMain(Object.assign({
    status: { paused: false, duration: 1400, url: "file:///v/x.mkv" }
  }, opts));
  m.emit("iina.window-loaded");
  m.runTimers();          // the 500ms handler registration
  return m;
}

const EPISODE = {
  isMovie: false, showTitle: "Severance", epTitle: "Good News", code: "S01E01",
  airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "",
  context: "", tmdbId: "1399", season: 1, episode: 1
};

test("a segment ending at the duration does not seek to EOF", () => {
  // A crowd-sourced "to the end" marker stores the duration itself, so the
  // unadjusted target lands exactly on EOF, where mpv moves to the next file.
  const m = session();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.activeSegment = { kind: "credits", start: 0, end: 1400 };
  m.global.skipNow("test");
  assert.equal(m.sink.seeks.length, 1, "nothing was seeked");
  assert.ok(m.sink.seeks[0] < 1400,
    `seeked to ${m.sink.seeks[0]}, which is EOF for a 1400s file`);
});

test("a segment ending inside the file seeks to its own end", () => {
  const m = session();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.activeSegment = { kind: "intro", start: 0, end: 90 };
  m.global.skipNow("test");
  assert.deepEqual(m.sink.seeks, [90], "a normal end must be used unchanged");
});

test("a non-positive target is refused rather than seeked to", () => {
  const m = session();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.activeSegment = { kind: "intro", start: 0, end: 0 };
  m.global.skipNow("test");
  assert.deepEqual(m.sink.seeks, [], "sought to zero");
});

test("with no segment active nothing is seeked", () => {
  const m = session();
  m.global.activeSegment = null;
  m.global.skipNow("test");
  assert.deepEqual(m.sink.seeks, []);
});

// ── A lookup that outlives its file ────────────────────────────────

// Skip intro has to be on and a key supplied, or resolveSegments returns
// before reaching any of the network work the staleness guard protects.
function remoteSession(http) {
  const m = loadMain(Object.assign({
    status: { paused: false, duration: 1400, url: "file:///v/a.mkv" },
    mpvProps: { duration: 1400 },
    http: http || {}
  }, {}));
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setTmdbKey", { key: "K" });
  m.fromWebView("sidebar", "setSkipEnabled", { enabled: true });
  return m;
}

// Real segment data, so a stale run that installs its answer is visible. With
// every provider stubbed empty both the good and the broken run end up with
// zero segments, and the assertion cannot tell them apart.
const INTRO_KEY = "https://api.introdb.app/segments?imdb_id=tt0944947&season=1&episode=1";
const INTRODB_HIT = {
  [INTRO_KEY]: { statusCode: 200, data: { intro: { start_sec: 0, end_sec: 90 } } }
};
// The api_key travels in the query for the segment databases and in `params`
// for TMDB, so these keys have no query string on the TMDB side.
const SHOW_IDS = "https://api.themoviedb.org/3/tv/1399/external_ids";
const EP_IDS = "https://api.themoviedb.org/3/tv/1399/season/1/episode/1/external_ids";

test("a segment lookup that finishes after the file changed is discarded", async () => {
  // The chain can take the best part of 30 seconds. Without a generation
  // counter it installed its answer into whatever file was playing by then and
  // showed a skip pill for the previous episode.
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = remoteSession(Object.assign({
    [SHOW_IDS]: () => gate.then(() => ({ id: 1399, imdb_id: "tt0944947" })),
    [EP_IDS]: {}
  }, INTRODB_HIT));

  // Prove the fixture really produces a segment, so the assertions below have
  // something to lose.
  const control = remoteSession({
    [SHOW_IDS]: { id: 1399, imdb_id: "tt0944947" },
    [EP_IDS]: {},
    ...INTRODB_HIT
  });
  control.fromWebView("sidebar", "episodeSelected", { ...EPISODE, tmdbId: "1399", parentImdbId: null });
  await settle();
  assert.ok(control.global.segments.length > 0,
    "the fixture produced no segments, so these tests could not detect anything");

  // No imdb id on the episode, so the lookup has to resolve one first, and that
  // call is the one held open.
  m.fromWebView("sidebar", "episodeSelected", {
    ...EPISODE, imdbId: "1399", imdbIdResolved: undefined, parentImdbId: null
  });
  await settle();
  assert.ok(m.sink.httpCalls.length > 0, "no remote call was made at all");

  const callsBefore = m.sink.httpCalls.length;
  m.emit("iina.file-loaded");
  release();
  await settle();

  // Two things matter, and the second is easy to miss: a stale run must not
  // install segments, and it must not go on making requests either. Watching
  // only the segments would pass even with the guard gone, because a later
  // liveness check stops the write while four requests have already gone out.
  assert.equal(m.global.segments.length, 0,
    "the abandoned lookup installed segments for the new file");
  assert.equal(m.sink.httpCalls.length, callsBefore,
    "the abandoned lookup kept querying after the file changed");
});

test("two overlapping lookups: the older one must not win", async () => {
  // "Search again" can start a second resolveSegments while the first is still
  // awaiting. Last-to-finish used to overwrite, so a slow first run could undo
  // a fresher refresh.
  let releaseA, releaseB;
  const gateA = new Promise((r) => { releaseA = r; });
  const gateB = new Promise((r) => { releaseB = r; });
  // The two runs must return *different* segments, or a stale run writing the
  // same answer is indistinguishable from a stale run being correctly ignored.
  let introCalls = 0;
  const m = remoteSession(Object.assign({
    [SHOW_IDS]: () => (gateAUsed ? gateB : gateA).then(() => ({ id: 1399, imdb_id: "tt0944947" })),
    [EP_IDS]: {},
    [INTRO_KEY]: () => {
      introCalls++;
      const end = introCalls === 1 ? 90 : 120;
      return { statusCode: 200, data: { intro: { start_sec: 0, end_sec: end } } };
    }
  }, {}));
  let gateAUsed = false;

  m.fromWebView("sidebar", "episodeSelected", { ...EPISODE, tmdbId: "1399", parentImdbId: null });
  await settle();
  gateAUsed = true;
  m.fromWebView("sidebar", "refreshSkip", {});     // second run, parked on gateB
  await settle();

  releaseB();
  await settle();
  const afterSecond = m.global.segments.length;
  assert.ok(afterSecond > 0, "the second run produced nothing to compare against");

  releaseA();                                     // the stale first run finishes last
  await settle();

  assert.equal(m.global.segments.length, afterSecond,
    "the stale first lookup overwrote the newer one");
  // The second run is released first, so it reaches IntroDB first and gets the
  // 90s answer; the stale first run would get 120s if it were allowed to write.
  assert.equal(m.global.segments[0].end, 90,
    "the stale first run's answer survived");
});

test("file-loaded clears the state before the call that can throw", () => {
  // sidebar.loadFile throws when the player window has not loaded.
  // setupSidebar() used to run first, so the throw skipped the reset below and
  // left the previous file's card, segments and time observer in place.
  //
  // postMessage is a silent no-op in that state, not a throw, so the dropped
  // messages are visible in sink.dropped while the state is still asserted on.
  const m = loadMain({
    status: { paused: false, duration: 1400, url: "file:///v/a.mkv" },
    windowLoaded: true
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.segments = [{ kind: "intro", start: 0, end: 90 }];
  m.global.activeSegment = { kind: "intro", start: 0, end: 90 };

  m.setWindowLoaded(false);
  // Already set up by the handshake, so nothing here throws.
  m.emit("iina.file-loaded");

  assert.equal(m.global.currentEpisode, null, "the previous episode survived");
  assert.equal(m.global.segments.length, 0, "the previous segments survived");
  assert.equal(m.global.activeSegment, null, "the previous segment survived");
  assert.equal(m.global.cardVisible, false, "the previous card stayed visible");
  assert.ok(m.dropped.some((c) => c[0] === "sidebar" && c[1] === "fileChanged"),
    "expected the fileChanged to be swallowed while the window is down");
});

test("file-loaded clears the state even when loading the sidebar throws", () => {
  // The first file after launch, with the window not up yet: loadFile throws,
  // and everything below it in the handler must already have run.
  const m = loadMain({
    status: { paused: false, duration: 1400, url: "file:///v/a.mkv" },
    windowLoaded: true
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.segments = [{ kind: "intro", start: 0, end: 90 }];
  // Hand the plugin a window that has gone away again, leaving sidebarLoaded
  // false the way a launch before the handshake does.
  m.setWindowLoaded(false);
  m.global.sidebarLoaded = false;

  assert.throws(() => m.emit("iina.file-loaded"), /player window not loaded/);
  assert.equal(m.global.currentEpisode, null, "the previous episode survived");
  assert.equal(m.global.segments.length, 0, "the previous segments survived");
});

test("clearing the selection also stops the time observer", () => {
  const m = session();
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.startTimeWatcher();
  m.fromWebView("sidebar", "clearEpisode", {});
  assert.equal(m.global.timeWatcher, null,
    "the observer kept running after the selection was cleared");
});

test("the merged end is a median, not a mean of the group", () => {
  // One provider returning a wildly wrong end must not drag the estimate.
  const { g } = boot();
  const merged = g.mergeSegments([
    seg(0, 90, "intro", T),
    seg(0, 92, "intro", S2),
    seg(0, 89, "intro", S3),
    seg(0, 100000, "intro", S2)     // the outlier
  ]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].end <= 95,
    `an outlier moved the end to ${merged[0].end}; a mean would have done that`);
});
