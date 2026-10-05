import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar, settle, searchedQueries, requestedPaths } from "./helpers/harness.mjs";

const KEY = { epinfo_tmdb_key: "TESTKEY" };

const SHOW = {
  id: 1399,
  name: "Severance",
  poster_path: "/p.jpg",
  seasons: [{ season_number: 1 }, { season_number: 2 }],
  images: { logos: [{ file_path: "/logo.jpg", aspect_ratio: 6, iso_639_1: "en" }] }
};

const SEASON_2 = {
  poster_path: "/s2.jpg",
  episodes: [
    { episode_number: 1, name: "Hello, Ms. Cobel", air_date: "2025-02-21", vote_average: 8.4, overview: "o1" },
    { episode_number: 2, name: "Half Loop", air_date: "2025-02-28", vote_average: 8.8, overview: "o2" },
    { episode_number: 3, name: "In Perpetuity", air_date: "2025-03-07", vote_average: 9.1, overview: "o3" }
  ]
};

function routes(overrides = {}) {
  return {
    "/3/search/tv": { results: [{ id: 1399, name: "Severance", vote_count: 4000, poster_path: "/p.jpg" }] },
    "/3/search/movie": { results: [] },
    "/3/tv/1399/season/2": SEASON_2,
    "/3/tv/1399/season/1": { poster_path: "/s1.jpg", episodes: [] },
    "/3/tv/1399": SHOW,
    "/3/movie/550": { title: "Fight Club", release_date: "1999-10-15", vote_average: 8.4, overview: "o", poster_path: "/fc.jpg", images: {} },
    ...overrides
  };
}

function boot(opts = {}) {
  const h = loadSidebar({ storage: KEY, routes: routes(opts.routes) });
  return h;
}

// Drive one file through the whole identification path the way main.js does.
async function identify(h, url) {
  h.global.currentVideoUrl = url;
  const started = h.global.autoIdentify(url);
  await settle();
  return started;
}

function episodeSelected(h) {
  const posted = h.iina._posted.filter((p) => p.name === "episodeSelected");
  return posted.length ? posted[posted.length - 1].payload : null;
}

test("identifies a release filename with no user interaction", async () => {
  const h = boot();
  const started = await identify(h, "file:///Users/me/Videos/Severance.S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv");
  assert.equal(started, true);

  const info = episodeSelected(h);
  assert.ok(info, "nothing was selected");
  assert.equal(info.showTitle, "Severance");
  assert.equal(info.code, "S02E03");
  assert.equal(info.epTitle, "In Perpetuity");
  assert.equal(info.airDate, "2025-03-07");
  assert.equal(info.logoUrl, "https://image.tmdb.org/t/p/w780/logo.jpg");
});

test("searches the parsed title, not the whole filename", async () => {
  const h = boot();
  await identify(h, "file:///Users/me/Videos/Severance.S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv");
  assert.deepEqual(searchedQueries(h.fetchCalls).filter(Boolean), ["Severance"]);
});

test("a film is identified by year, and a remake loses", async () => {
  const h = boot({
    routes: {
      "/3/search/movie": {
        results: [
          { id: 134, title: "Footloose", release_date: "2011-10-14", vote_count: 5000 },
          { id: 900, title: "Footloose", release_date: "1984-02-17", vote_count: 900 }
        ]
      },
      "/3/movie/900": { title: "Footloose", release_date: "1984-02-17", vote_average: 6.2, images: {} }
    }
  });
  await identify(h, "file:///Users/me/Videos/Footloose.1984.1080p.mkv");
  const info = episodeSelected(h);
  assert.ok(info, "no film was selected");
  assert.equal(info.isMovie, true);
  assert.equal(info.epTitle, "Footloose");
  assert.equal(info.airDate, "1984-02-17");
});

test("a name with neither an episode code nor a year is left alone", async () => {
  const h = boot();
  const started = await identify(h, "file:///Users/me/Videos/Some Random Home Video.mp4");
  assert.equal(started, false);
  assert.equal(h.fetchCalls.length, 0, "a manual-only file must cost no requests");
});

test("a remembered identification is restored without any request", async () => {
  const h = boot();
  const url = "file:///Users/me/Videos/Severance.S02E03.mkv";
  await identify(h, url);
  const callsAfterFirst = h.fetchCalls.length;
  assert.ok(callsAfterFirst > 0);

  h.iina._emit("fileChanged", { url });
  await settle();
  assert.equal(h.fetchCalls.length, callsAfterFirst, "re-opening a known file re-fetched");
  assert.equal(episodeSelected(h).code, "S02E03");
});

test("a cached entry that disagrees with the filename is re-identified", async () => {
  const h = boot();
  const url = "file:///Users/me/Videos/Severance.S02E03.mkv";
  await identify(h, url);

  // Same URL, but the cache now claims a different episode. The filename is
  // ground truth, so the stale entry must be replaced rather than replayed.
  const map = JSON.parse(h.localStorage.getItem("epinfo_url_map"));
  map[url].episode = 1;
  map[url].code = "S02E01";
  h.localStorage.setItem("epinfo_url_map", JSON.stringify(map));

  // Come back to the file the way a playlist does: play something else in
  // between. A repeat of fileChanged for the file already playing is now a
  // deliberate no-op, so it cannot stand in for "the user returned".
  h.iina._emit("fileChanged", { url: "file:///v/Some Other Film 2019.mkv" });
  await settle();
  const before = h.fetchCalls.length;
  h.iina._emit("fileChanged", { url });
  await settle();
  assert.ok(h.fetchCalls.length > before, "stale entry was replayed instead of re-identified");
  assert.equal(episodeSelected(h).code, "S02E03");
});

test("every request goes to a host declared in Info.json", async () => {
  const h = boot();
  await identify(h, "file:///Users/me/Videos/Severance.S02E03.mkv");
  for (const path of requestedPaths(h.fetchCalls)) {
    assert.match(path, /^\/3\//, `unexpected request path: ${path}`);
  }
});
test("a film is chosen by how well its name matches, not by votes alone", async () => {
  // Sorting a film on votes and the year picked "Star Wars" for
  // "Star.Wars.Episode.IV.-.A.New.Hope.1977": both are 1977, and the shorter
  // title has more votes. The name has to be the first thing ranked on.
  const h = boot({
    routes: {
      "/3/search/movie": {
        results: [
          { id: 1, title: "Star Wars", release_date: "1977-05-25", vote_count: 20000 },
          { id: 2, title: "Star Wars: Episode IV - A New Hope", release_date: "1977-05-25", vote_count: 12000 }
        ]
      },
      "/3/movie/2": {
        title: "Star Wars: Episode IV - A New Hope", release_date: "1977-05-25", images: {}
      }
    }
  });
  await identify(h, "file:///Users/me/Videos/Star.Wars.Episode.IV.-.A.New.Hope.1977.1080p.BluRay.x264-SPARKS.mkv");
  const info = episodeSelected(h);
  assert.ok(info, "no film was selected");
  assert.equal(info.epTitle, "Star Wars: Episode IV - A New Hope",
    "the higher-voted title won despite matching the name less well");
});
