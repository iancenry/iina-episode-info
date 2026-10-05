import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar, settle, searchedQueries } from "./helpers/harness.mjs";

const KEY = { epinfo_tmdb_key: "TESTKEY" };

const SHOW = {
  id: 1399,
  name: "Severance",
  poster_path: "/p.jpg",
  number_of_seasons: 2,
  number_of_episodes: 19,
  seasons: [{ season_number: 1, episode_count: 9 }, { season_number: 2, episode_count: 10 }],
  images: { logos: [{ file_path: "/logo.jpg", aspect_ratio: 6, iso_639_1: "en" }] }
};
const SEASON_1 = {
  poster_path: "/s1.jpg",
  episodes: [
    { episode_number: 1, name: "Good News About Hell", air_date: "2022-02-18" },
    { episode_number: 2, name: "Half Loop", air_date: "2022-02-25" }
  ]
};
const SEASON_2 = {
  poster_path: "/s2.jpg",
  episodes: [
    { episode_number: 1, name: "Hello, Ms. Cobel", air_date: "2025-02-21" },
    { episode_number: 2, name: "In Perpetuity", air_date: "2025-02-28" },
    { episode_number: 3, name: "Chikhai Bardo", air_date: "2025-03-07" }
  ]
};

const LIB = "file:///Users/me/Downloads/watch/me/samurai%20champloo";

function boot(over = {}) {
  return loadSidebar({
    storage: { ...KEY, ...(over.storage || {}) },
    routes: {
      "/3/search/tv": { results: [] },
      "/3/search/multi": { results: [] },
      "/3/tv/1399/season/1": SEASON_1,
      "/3/tv/1399/season/2": SEASON_2,
      "/3/tv/1399": SHOW,
      ...(over.routes || {})
    }
  });
}

function urlMap(h) {
  try { return JSON.parse(h.localStorage.getItem("epinfo_url_map") || "{}"); } catch (e) { return {}; }
}

function folderMap(h) {
  try { return JSON.parse(h.localStorage.getItem("epinfo_folder_map") || "{}"); }
  catch (e) { return {}; }
}

function selected(h) {
  const p = h.iina._posted.filter((x) => x.name === "episodeSelected");
  return p.length ? p[p.length - 1].payload : null;
}

// Search finds it, so a manual pick has something to pick.
const SEVERANCE_RESULTS = {
  results: [
    { id: 1399, media_type: "tv", name: "Severance", vote_count: 4000, poster_path: "/p.jpg" }
  ]
};

async function manualPick(h, url) {
  // What a user does: open the file, search, click the show, click a season,
  // click an episode.
  h.iina._emit("fileChanged", { url });
  await settle();
  h.global.pickItem({ id: 1399, media_type: "tv", name: "Severance", poster_path: "/p.jpg" });
  await settle();
  h.global.pickSeason(1);
  await settle();
  h.global.pickEp(0);
  await settle();
}

// ── Writing ─────────────────────────────────────────────────────────

test("a manual pick pins the folder to the show", async () => {
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  // A filename the parser cannot make sense of, which is the case pinning is
  // for. "Egghead" is what the parser would otherwise have searched.
  await manualPick(h, LIB + "/11.mkv");
  assert.ok(selected(h), "the manual pick did not take");

  const pins = folderMap(h);
  const keys = Object.keys(pins);
  assert.equal(keys.length, 1, `expected one pin, got ${JSON.stringify(pins)}`);
  assert.equal(keys[0], "samurai champloo", "pinned the wrong directory");
  assert.equal(pins["samurai champloo"].tmdbId, "1399");
  assert.equal(pins["samurai champloo"].name, "Severance");
});

test("an automatic match never writes a pin", async () => {
  // Otherwise one bad guess would silently apply to every other file.
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  const url = "file:///Users/me/Videos/Severance S01E01.mkv";
  h.global.currentVideoUrl = url;
  h.global.autoIdentify(url);
  await settle();
  assert.ok(selected(h), "auto-identification did not happen");
  assert.deepEqual(folderMap(h), {}, "an automatic match wrote a pin");
});

test("turning the opt-out off stops pins being written", async () => {
  const h = boot({ storage: { epinfo_pin_remember: "false" }, routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, LIB + "/11.mkv");
  assert.ok(selected(h), "the manual pick did not take");
  assert.deepEqual(folderMap(h), {}, "a pin was written despite the opt-out");
});

test("a film is not pinned", async () => {
  // A film folder would need the year to stay unambiguous against remakes.
  const h = boot();
  h.iina._emit("fileChanged", { url: LIB + "/11.mkv" });
  await settle();
  h.global.pickItem({ id: 550, media_type: "movie", title: "Fight Club" });
  await settle();
  assert.deepEqual(folderMap(h), {}, "a film was pinned");
});

test("a filename that supplied its own title is not pinned", async () => {
  // In a flat library the parent directory is usually the whole media folder,
  // and pinning that to one show would be wrong.
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, "file:///Users/me/Videos/Severance S01E01.mkv");
  assert.ok(selected(h), "the manual pick did not take");
  assert.deepEqual(folderMap(h), {}, "a flat library directory was pinned");
});

// ── Reading ─────────────────────────────────────────────────────────

test("a later file in a pinned folder resolves with no search at all", async () => {
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, LIB + "/11.mkv");
  assert.ok(selected(h));

  // A different file, and a name the parser could never have resolved. Only
  // the requests made *after* the pin matters: the first file legitimately
  // searched, because at that point nothing was pinned.
  const before = h.fetchCalls.length;
  const next = LIB + "/AnimePahe_Egghead_-_12_1080p.mkv";
  h.iina._emit("fileChanged", { url: next });
  await settle();

  const info = selected(h);
  assert.ok(info, "the pinned folder did not resolve");
  assert.equal(info.showTitle, "Severance");

  const after = h.fetchCalls.slice(before);
  assert.deepEqual(searchedQueries(after).filter(Boolean), [], "the pin fell through to searching");
  // The show and its season, and nothing else.
  assert.equal(after.length, 2, `unexpected requests: ${after}`);
  assert.ok(after[0].includes("/3/tv/1399?"), after[0]);
});

test("a pin reaches into subdirectories", async () => {
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, LIB + "/11.mkv");
  const picksBefore = h.iina._posted.filter((x) => x.name === "episodeSelected").length;
  h.iina._emit("fileChanged", { url: LIB + "/Season%202/03.mkv" });
  await settle();
  const picks = h.iina._posted.filter((x) => x.name === "episodeSelected");
  assert.equal(picks.length, picksBefore + 1, "a file inside Season 2 did not resolve");
  assert.equal(picks[picks.length - 1].payload.showTitle, "Severance");
  // The pin names the show; the "Season 2" directory and the bare "03" still
  // decide the episode.
  assert.equal(picks[picks.length - 1].payload.code, "S02E03");
});

test("a pinned folder with an unreadable name still yields the show", async () => {
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, LIB + "/11.mkv");
  const url = LIB + "/[SomeFansub][1-2] Whatever 04 [1080p][FD5592BE].mkv";
  h.iina._emit("fileChanged", { url });
  await settle();
  assert.equal(selected(h).showTitle, "Severance");
});

test("unpinning stops the folder resolving", async () => {
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, LIB + "/11.mkv");
  assert.ok(folderMap(h)["samurai champloo"]);

  h.global.doUnpinFolder();
  assert.deepEqual(folderMap(h), {}, "the pin survived");

  // The same unreadable file now finds nothing, because the search route in
  // this harness returns no results. Compare post counts, not the last
  // payload, or the earlier pick would mask the failure.
  const picksBefore = h.iina._posted.filter((x) => x.name === "episodeSelected").length;
  h.iina._emit("fileChanged", { url: LIB + "/AnimePahe_Egghead_-_12_1080p.mkv" });
  await settle();
  const picksAfter = h.iina._posted.filter((x) => x.name === "episodeSelected").length;
  assert.equal(picksAfter, picksBefore, "an unpinned folder still resolved");
});

test("a pin is refreshed when used, so a live library never ages out", async () => {
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, LIB + "/11.mkv");
  const stale = Date.now() - 200 * 86400000;   // 200 days ago
  const m = folderMap(h);
  m["samurai champloo"].lastSeen = stale;
  h.localStorage.setItem("epinfo_folder_map", JSON.stringify(m));

  // Using the folder refreshes the stamp, which is what keeps it alive.
  h.iina._emit("fileChanged", { url: LIB + "/12.mkv" });
  await settle();
  assert.ok(folderMap(h)["samurai champloo"].lastSeen > stale,
    "the pin was not refreshed by being used");
  assert.equal(h.global.pruneFolderMap(), 0, "a freshly used pin aged out anyway");
});

test("a folder that has not been touched does age out", async () => {
  const h = boot({ routes: { "/3/search/tv": SEVERANCE_RESULTS } });
  await manualPick(h, LIB + "/11.mkv");
  const m = folderMap(h);
  m["samurai champloo"].lastSeen = Date.now() - 200 * 86400000;
  h.localStorage.setItem("epinfo_folder_map", JSON.stringify(m));

  const dropped = h.global.pruneFolderMap();
  assert.equal(dropped, 1);
  assert.deepEqual(folderMap(h), {});
});
// ── Both maps age out at launch ────────────────────────────────────

test("the boot pass ages out a stale folder pin", async () => {
  // pruneFolderMap existed and was tested in isolation, but nothing called it:
  // the boot block only ran pruneUrlMap, so folder pins were the one map that
  // only ever grew.
  const stale = Date.now() - 200 * 86400000;
  const h = loadSidebar({
    storage: {
      epinfo_tmdb_key: "K",
      epinfo_folder_map: JSON.stringify({
        "samurai champloo": { tmdbId: "1399", name: "Severance", season: 1, lastSeen: stale }
      }),
      epinfo_url_map: JSON.stringify({
        "file:///v/old.mkv": { showTitle: "Severance", season: 1, episode: 1, lastSeen: stale }
      })
    },
    routes: {}
  });
  assert.equal(Object.keys(folderMap(h)).length, 1, "the fixture did not seed");

  // The boot block is a timer; fire it.
  h.timers._fireAll();
  await settle();

  assert.deepEqual(folderMap(h), {}, "a stale folder pin survived the boot pass");
  assert.deepEqual(urlMap(h), {}, "a stale URL entry survived the boot pass");
});

test("a fresh pin survives the boot pass", () => {
  const h = loadSidebar({
    storage: {
      epinfo_tmdb_key: "K",
      epinfo_folder_map: JSON.stringify({
        "samurai champloo": { tmdbId: "1399", name: "Severance", season: 1, lastSeen: Date.now() }
      })
    },
    routes: {}
  });
  h.timers._fireAll();
  assert.equal(Object.keys(folderMap(h)).length, 1, "the boot pass dropped a live pin");
});
