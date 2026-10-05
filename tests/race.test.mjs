import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar, settle, searchedQueries } from "./helpers/harness.mjs";

const KEY = { epinfo_tmdb_key: "TESTKEY" };

const SHOW = {
  id: 1399, name: "Severance", poster_path: "/p.jpg",
  number_of_seasons: 1, number_of_episodes: 2,
  seasons: [{ season_number: 1, episode_count: 2 }],
  images: {}
};
const SEASON_1 = {
  id: 3624, poster_path: "/s1.jpg",
  episodes: [
    { episode_number: 1, name: "Good News About Hell", air_date: "2022-02-18" },
    { episode_number: 2, name: "Half Loop", air_date: "2022-02-25" }
  ]
};

function boot(over = {}) {
  return loadSidebar({
    storage: { ...KEY, ...(over.storage || {}) },
    routes: {
      "/3/search/tv": { results: [{ id: 1399, name: "Severance", vote_count: 4000 }] },
      "/3/tv/1399/season/1": SEASON_1,
      "/3/tv/1399": SHOW,
      ...(over.routes || {})
    }
  });
}

function picks(h) {
  return h.iina._posted.filter((x) => x.name === "episodeSelected").map((x) => x.payload);
}
function lastPick(h) {
  const p = picks(h);
  return p.length ? p[p.length - 1] : null;
}
function urlMap(h) {
  try { return JSON.parse(h.localStorage.getItem("epinfo_url_map") || "{}"); } catch (e) { return {}; }
}

// ── A repeated fileChanged must not sabotage the lookup ─────────────

test("a duplicate fileChanged leaves the in-flight lookup alone", async () => {
  // main.js re-sends fileChanged on the sidebar-ready handshake. This used to
  // cancel the give-up timer and then return early, so the lookup found a null
  // timer and dropped its result: nothing identified, no timer, no error.
  const h = boot();
  const url = "file:///v/Severance S01E02.mkv";
  h.iina._emit("fileChanged", { url });
  h.iina._emit("fileChanged", { url });
  h.iina._emit("fileChanged", { url });
  await settle();

  const info = lastPick(h);
  assert.ok(info, "the duplicate fileChanged killed the lookup");
  assert.equal(info.code, "S01E02");
  assert.ok(h.timers._pending().length > 0, "the give-up timer was cancelled");
});

test("a fileChanged for a different file does supersede the first", async () => {
  const h = boot();
  const a = "file:///v/Severance S01E02.mkv";
  const b = "file:///v/Unrelated Clip.mkv";
  // Let A finish first, then move on. Firing both with no settle in between is
  // a race the product is meant to lose deliberately.
  h.iina._emit("fileChanged", { url: a });
  await settle();
  assert.equal(picks(h).length, 1, "A did not identify");
  h.iina._emit("fileChanged", { url: b });
  await settle();
  // B has nothing to identify, so A's pick stands and is filed against A.
  assert.equal(picks(h).length, 1);
  assert.ok(urlMap(h)[a], "A was not filed against its own URL");
  assert.deepEqual(urlMap(h)[b], undefined, "B inherited A's identification");
});

// ── A late response must not land on the new file ───────────────────

test("a slow response cannot stamp file A onto file B's cache", async () => {
  // One gate on the show-detail response, released by hand. Without a token
  // the reply is applied to whatever file is playing when it lands.
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = boot({
    routes: {
      "/3/tv/1399": () => gate.then(() => SHOW),
      "/3/search/movie": { results: [] }
    }
  });

  const a = "file:///v/Severance S01E02.mkv";
  const b = "file:///v/Unrelated Clip.mkv";

  h.iina._emit("fileChanged", { url: a });
  await settle();               // search resolves, detail request is parked
  h.iina._emit("fileChanged", { url: b });
  await settle();               // b has nothing to identify
  release();
  await settle();

  assert.equal(picks(h).length, 0, "the late reply still selected an episode");
  assert.deepEqual(urlMap(h)[b], undefined, "file A was written into file B's cache entry");
  assert.deepEqual(urlMap(h)[a], undefined, "file A was never filed against its own URL");
});

test("a slow film response cannot overwrite the current file", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = boot({
    routes: {
      "/3/search/movie": { results: [{ id: 550, title: "Fight Club", release_date: "1999-10-15", vote_count: 26000 }] },
      "/3/movie/550": () => gate.then(() => ({ id: 550, title: "Fight Club", release_date: "1999-10-15", vote_average: 8.4, images: {} }))
    }
  });

  const a = "file:///v/Fight Club 1999.mkv";
  const b = "file:///v/Unrelated Clip.mkv";
  h.iina._emit("fileChanged", { url: a });
  await settle();
  h.iina._emit("fileChanged", { url: b });
  await settle();
  release();
  await settle();

  assert.equal(picks(h).length, 0, "the late film reply still selected something");
  assert.deepEqual(urlMap(h)[b], undefined, "the film was filed against the wrong URL");
});

test("a pinned-folder response cannot land on another file", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = loadSidebar({
    storage: {
      ...KEY,
      epinfo_folder_map: JSON.stringify({
        "samurai champloo": { tmdbId: "1399", name: "Severance", season: 1, lastSeen: Date.now() }
      })
    },
    routes: {
      "/3/tv/1399": () => gate.then(() => SHOW),
      "/3/tv/1399/season/1": SEASON_1
    }
  });

  const a = "file:///Users/me/samurai%20champloo/01.mkv";
  const b = "file:///v/Unrelated Clip.mkv";
  h.iina._emit("fileChanged", { url: a });
  await settle();
  h.iina._emit("fileChanged", { url: b });
  await settle();
  release();
  await settle();

  assert.equal(picks(h).length, 0, "the pinned response still selected an episode");
  assert.deepEqual(urlMap(h)[b], undefined, "the pinned show was filed against the wrong URL");
});

test("a slow season response cannot select an episode for the wrong file", async () => {
  // A different gate from the one above: the show arrives promptly and only the
  // season list is late, which is a separate code path with its own writer.
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = boot({ routes: { "/3/tv/1399/season/1": () => gate.then(() => SEASON_1) } });

  const a = "file:///v/Severance S01E02.mkv";
  const b = "file:///v/Unrelated Clip.mkv";
  h.iina._emit("fileChanged", { url: a });
  await settle();
  h.iina._emit("fileChanged", { url: b });
  await settle();
  release();
  await settle();

  // What the guard actually protects. A late season list cannot select an
  // episode anyway, because pickEp now refuses to run without a selShow. But
  // it must not repopulate the caches either: a stale seasonPosterUrl would
  // silently supply the next file's poster, and stale pills would be drawn
  // over whatever is on screen.
  assert.deepEqual(urlMap(h)[b], undefined, "the episode was filed against the wrong URL");
  // Length, not deepStrictEqual: the cache is an array built in the vm realm.
  assert.equal(h.global.episodeCache.length, 0, "a stale season repopulated the episode cache");
  assert.doesNotMatch(h.document.getElementById("ep").innerHTML, /pickEp|E01|E02/,
    "a stale season drew its pills over the current panel");
});

// ── Clear must survive an in-flight response ────────────────────────

test("Clear selection is not undone by a response already in flight", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = boot({ routes: { "/3/tv/1399": () => gate.then(() => SHOW) } });

  const url = "file:///v/Severance S01E02.mkv";
  h.iina._emit("fileChanged", { url });
  await settle();

  h.global.doClear();
  assert.equal(lastPick(h), null);
  assert.deepEqual(urlMap(h), {}, "clear left the cache entry behind");

  release();
  await settle();

  assert.equal(lastPick(h), null, "the card came back after the user cleared it");
  assert.deepEqual(urlMap(h), {}, "the URL map repopulated after the user cleared it");
  assert.equal(h.localStorage.getItem("epinfo_ep"), null);
  assert.equal(h.document.getElementById("saved").classList.contains("on"), false);
});

test("unpinning is not undone by a response already in flight", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = loadSidebar({
    storage: {
      ...KEY,
      epinfo_folder_map: JSON.stringify({
        "samurai champloo": { tmdbId: "1399", name: "Severance", season: 1, lastSeen: Date.now() }
      })
    },
    routes: { "/3/tv/1399": () => gate.then(() => SHOW), "/3/tv/1399/season/1": SEASON_1 }
  });

  const url = "file:///Users/me/samurai%20champloo/01.mkv";
  h.iina._emit("fileChanged", { url });
  await settle();

  h.global.doUnpinFolder();
  release();
  await settle();

  assert.deepEqual(JSON.parse(h.localStorage.getItem("epinfo_folder_map") || "{}"), {},
    "the pin came back");
  assert.equal(picks(h).length, 0, "the show was selected after the pin was removed");
});

// ── Error paths must not strand the panel ───────────────────────────

test("a season that comes back empty says so instead of showing no pills", async () => {
  // A 404 or a dead API key resolves with a body carrying no episodes.
  const h = boot({ routes: { "/3/tv/1399/season/1": { status_code: 34, status_message: "not found" } } });
  h.iina._emit("fileChanged", { url: "file:///v/Severance S01E02.mkv" });
  await settle();
  const ep = h.document.getElementById("ep").innerHTML;
  assert.match(ep, /Couldn't load that season/, `panel was a dead end: ${ep}`);
});

test("a show that comes back empty leaves the search prompt", async () => {
  const h = boot({ routes: { "/3/tv/1399": { status_code: 7, status_message: "invalid API key" } } });
  h.iina._emit("fileChanged", { url: "file:///v/Severance S01E02.mkv" });
  await settle();
  assert.match(h.document.getElementById("panel").innerHTML, /Search above/);
  assert.equal(picks(h).length, 0);
});

test("a manual pick of a show that comes back empty leaves the search prompt", async () => {
  const h = boot({ routes: { "/3/tv/1399": { status_code: 34 } } });
  h.iina._emit("fileChanged", { url: "file:///v/Severance S01E02.mkv" });
  await settle();
  h.global.pickItem({ id: 1399, media_type: "tv", name: "Severance" });
  await settle();
  // No "Season" heading stranded above zero pills.
  assert.doesNotMatch(h.document.getElementById("panel").innerHTML, /Season<\/div>/);
});

test("the give-up timer fires and releases the in-flight guard", async () => {
  // A search that never comes back, so the 25s deadline is the only exit.
  const h = loadSidebar({ storage: KEY, routes: { "/3/search/tv": () => new Promise(() => {}) } });
  const url = "file:///v/Severance S01E02.mkv";
  h.iina._emit("fileChanged", { url });
  assert.ok(h.global.autoInFlight[url], "the lookup was never marked in flight");

  h.timers._fireAll();
  await settle();
  assert.match(h.document.getElementById("panel").innerHTML, /Couldn't match/);
  assert.equal(h.global.autoInFlight[url], undefined, "the URL stayed locked after the deadline");
});

test("a rejected search reports failure rather than stranding the panel", async () => {
  const h = loadSidebar({
    storage: KEY,
    routes: { "/3/search/tv": new Error("network down") }
  });
  h.iina._emit("fileChanged", { url: "file:///v/Severance S01E02.mkv" });
  await settle();
  assert.match(h.document.getElementById("panel").innerHTML, /Lookup failed/);
  assert.doesNotMatch(h.document.getElementById("panel").innerHTML, /Matching/);
  assert.deepEqual(searchedQueries(h.fetchCalls).filter(Boolean), ["Severance"]);
});

// ── An abandoned lookup must not lock its URL out ──────────────────

test("a URL is re-identified after an abandoned lookup left its mark", async () => {
  // autoInFlight[url] was a bare flag, so an entry left behind by a lookup the
  // user navigated away from made that file un-identifiable for the rest of
  // the session: the next fileChanged returned early and the panel stayed on
  // whatever the previous file had shown.
  let first = true;
  const h = boot({
    routes: {
      "/3/search/tv": () => {
        if (first) { first = false; return new Promise(() => {}); }  // never settles
        return { results: [{ id: 1399, name: "Severance", vote_count: 4000 }] };
      }
    }
  });
  const url = "file:///v/Severance S01E02.mkv";

  h.iina._emit("fileChanged", { url });
  await settle();
  assert.ok(h.global.autoInFlight[url], "the first lookup should still be in flight");

  // Play something else, so the first lookup is dead without ever finishing.
  h.iina._emit("fileChanged", { url: "file:///v/Other Clip.mkv" });
  await settle();

  // Come back to the first file. It has to be identified, not locked out.
  h.iina._emit("fileChanged", { url });
  await settle();
  const info = lastPick(h);
  assert.ok(info, "revisiting an abandoned URL identified nothing");
  assert.equal(info.code, "S01E02");
});

test("a pinned folder does not lock a file out of being identified", async () => {
  // The pinned path claims autoInFlight and nothing in it ever clears the
  // claim, so replaying a pinned file hit the early return and kept the
  // previous state instead of re-deriving anything.
  const h = boot({
    storage: {
      epinfo_folder_map: JSON.stringify({
        "Severance Season 1": { tmdbId: "1399", name: "Severance", lastSeen: Date.now() }
      })
    }
  });
  const url = "file:///Users/me/Videos/Severance Season 1/02.mkv";

  h.iina._emit("fileChanged", { url });
  await settle();
  assert.ok(h.global.autoInFlight[url], "the pinned lookup should claim the URL");
  assert.equal(lastPick(h).code, "S01E02");

  // Replaying the same file is a no-op by design (main.js re-sends it on the
  // sidebar-ready handshake), so go via a different file and back.
  h.iina._emit("fileChanged", { url: "file:///v/Other Clip.mkv" });
  await settle();
  h.iina._emit("fileChanged", { url });
  await settle();
  assert.equal(lastPick(h).code, "S01E02", "the pinned URL stayed locked out");
});

test("a manual search wins over a lookup still in flight", async () => {
  // The user is driving, so the automatic ladder is stale. It used to land a
  // moment later and replace their results with a show they never chose.
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = loadSidebar({
    storage: KEY,
    routes: {
      "/3/search/multi": { results: [{ id: 42, media_type: "tv", name: "The Bear" }] },
      "/3/search/tv": () => gate
    }
  });
  h.iina._emit("fileChanged", { url: "file:///v/Severance S01E02.mkv" });
  await settle();

  h.document.getElementById("q").value = "The Bear";
  h.global.doSearch();
  await settle();
  assert.match(h.document.getElementById("panel").innerHTML, /The Bear/);

  // The stranded search answers now, as a real one eventually would.
  release({ results: [{ id: 1399, name: "Severance", vote_count: 4000 }] });
  await settle();
  assert.match(h.document.getElementById("panel").innerHTML, /The Bear/,
    "the in-flight lookup replaced the user's search results");
  assert.doesNotMatch(h.document.getElementById("panel").innerHTML, /Severance/);
});
