import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar, settle, searchedQueries } from "./helpers/harness.mjs";

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
    { episode_number: 2, name: "Half Loop", air_date: "2025-02-28", vote_average: 8.8, overview: "o2" },
    { episode_number: 3, name: "In Perpetuity", air_date: "2025-03-07", vote_average: 9.1, overview: "o3" }
  ]
};

function boot(routes) {
  return loadSidebar({
    storage: KEY,
    routes: {
      "/3/tv/find/tt0944947": SHOW,
      "/3/movie/find/tt0111161": {
        id: 278, title: "The Shawshank Redemption", release_date: "1994-09-23",
        vote_average: 8.7, overview: "o", poster_path: "/s.jpg", images: {}
      },
      "/3/tv/1399/season/2": SEASON_2,
      "/3/tv/1399/season/1": { poster_path: "/s1.jpg", episodes: [] },
      "/3/tv/1399": SHOW,
      "/3/search/tv": { results: [] },
      "/3/search/movie": { results: [] },
      ...routes
    }
  });
}

async function identify(h, url) {
  h.global.currentVideoUrl = url;
  const started = h.global.autoIdentify(url);
  await settle();
  return started;
}

function selected(h) {
  const p = h.iina._posted.filter((x) => x.name === "episodeSelected");
  return p.length ? p[p.length - 1].payload : null;
}

// ── IMDb ────────────────────────────────────────────────────────────

test("an IMDb id is read out of the filename", () => {
  const { parseFilename } = loadSidebar().global;
  assert.equal(parseFilename("file:///v/Severance.tt0944947.S01E02.mkv").imdbId, "tt0944947");
  assert.equal(parseFilename("file:///v/Severance.TT0944947.mkv").imdbId, "tt0944947");
  assert.equal(parseFilename("file:///v/Severance.S01E02.mkv").imdbId, null);
  // A five-digit number is not an IMDb id.
  assert.equal(parseFilename("file:///v/Severance.tt1234.mkv").imdbId, null);
});

test("an IMDb id identifies a show in one request and skips the ladder", async () => {
  const h = boot();
  await identify(h, "file:///v/Severance.tt0944947.S02E03.1080p.mkv");

  const info = selected(h);
  assert.ok(info, "nothing was selected");
  assert.equal(info.showTitle, "Severance");
  assert.equal(info.code, "S02E03");
  assert.equal(info.logoUrl, "https://image.tmdb.org/t/p/w780/logo.jpg");

  assert.equal(h.fetchCalls.length, 2, `expected find + season only, got ${h.fetchCalls.length}`);
  assert.ok(h.fetchCalls[0].includes("/3/tv/find/tt0944947"));
  assert.deepEqual(searchedQueries(h.fetchCalls).filter(Boolean), [], "the title ladder should not run");
});

test("an IMDb id identifies a film", async () => {
  const h = boot();
  await identify(h, "file:///v/The Shawshank Redemption tt0111161.mkv");
  const info = selected(h);
  assert.ok(info, "nothing was selected");
  assert.equal(info.isMovie, true);
  assert.equal(info.epTitle, "The Shawshank Redemption");
  assert.equal(info.airDate, "1994-09-23");
});

test("an unknown IMDb id falls back to the ladder", async () => {
  // /find answers 404 for an id TMDB has never seen; the filename may still be
  // perfectly good, so the ladder has to run anyway.
  const h = boot({
    "/3/tv/find/tt0944947": undefined,
    "/3/search/tv": { results: [{ id: 1399, name: "Severance", vote_count: 4000 }] }
  });
  await identify(h, "file:///v/Severance.tt0944947.S02E03.mkv");
  const info = selected(h);
  assert.ok(info, "the ladder did not take over");
  assert.equal(info.code, "S02E03");
  assert.ok(h.fetchCalls.some((u) => u.includes("/3/search/tv")), "no search was issued");
});

test("a file identified by IMDb id can be cleared and identified again", async () => {
  // The in-flight guard has to be released on the IMDb path too. If it is not,
  // clearing the selection and re-opening the same file silently does nothing.
  const h = boot();
  const url = "file:///v/Severance.tt0944947.S02E03.mkv";
  await identify(h, url);
  assert.ok(selected(h), "nothing was selected the first time");

  h.global.doClear();
  h.iina._emit("fileChanged", { url });
  await settle();
  const again = selected(h);
  assert.ok(again, "re-identification did not happen after a clear");
  assert.equal(again.code, "S02E03");
});

// ── Result scoring ──────────────────────────────────────────────────

test("a same-prefix impostor does not beat the right show", async () => {
  // Regression shape: "Show" matches an unrelated higher-rated show whose name
  // merely begins the same way. Votes used to decide this outright.
  const h = boot({
    "/3/search/tv": {
      results: [
        { id: 1, name: "Severance of Attraction", vote_count: 99000 },
        { id: 2, name: "Severance", vote_count: 4000 }
      ]
    },
    "/3/tv/2/season/1": { poster_path: "", episodes: [{ episode_number: 1, name: "Good News About Hell", air_date: "2022-02-18" }] },
    "/3/tv/2": { id: 2, name: "Severance", poster_path: "/p.jpg", seasons: [{ season_number: 1 }], images: {} }
  });
  await identify(h, "file:///v/Severance S01E01.mkv");
  const info = selected(h);
  assert.ok(info, "nothing was selected");
  assert.equal(info.showTitle, "Severance");
  assert.equal(info.tmdbId, "2");
});

test("votes still decide between two equally good name matches", async () => {
  const h = boot({
    "/3/search/tv": {
      results: [
        { id: 1, name: "Frieren", vote_count: 10 },
        { id: 2, name: "Frieren", vote_count: 900 }
      ]
    },
    "/3/tv/2/season/1": { poster_path: "", episodes: [{ episode_number: 1, name: "A Journey Yet to Begin", air_date: "2023-10-06" }] },
    "/3/tv/2": { id: 2, name: "Frieren", poster_path: "/p.jpg", seasons: [{ season_number: 1 }], images: {} }
  });
  await identify(h, "file:///v/Frieren S01E01.mkv");
  assert.equal(selected(h).tmdbId, "2");
});

test("a weak match is still used when the ladder runs out", async () => {
  // Nothing better ever turns up, so the best plausible result is used rather
  // than leaving the user with an empty panel.
  const h = boot({
    "/3/search/tv": { results: [{ id: 5, name: "Pantheon", vote_count: 900 }] },
    "/3/tv/5/season/1": { poster_path: "", episodes: [{ episode_number: 6, name: "Episode 6", air_date: "2022-11-03" }] },
    "/3/tv/5": { id: 5, name: "Pantheon", poster_path: "/p.jpg", seasons: [{ season_number: 1 }], images: {} }
  });
  await identify(h, "file:///v/Pantheon 6CH SoftSub S01E06.mkv");
  const info = selected(h);
  assert.ok(info, "a usable match was thrown away");
  assert.equal(info.showTitle, "Pantheon");
  assert.equal(info.code, "S01E06");
});

test("nothing matchable means no selection and no stuck panel", async () => {
  const h = boot({ "/3/search/tv": { results: [{ id: 9, name: "Totally Different Thing", vote_count: 10 }] } });
  await identify(h, "file:///v/Zzzz Qqqq Xxxx S01E01.mkv");
  assert.equal(selected(h), null, "an unrelated show was auto-selected");
  // The give-up timer is cancelled the moment anything is committed, so a
  // detail request that comes back empty must not leave "Matching…" on screen.
  const panel = h.document.getElementById("panel").innerHTML;
  assert.ok(!panel.includes("Matching"), `panel was left mid-search: ${panel}`);
  assert.ok(panel.includes("Search above"), `panel did not fall back to search: ${panel}`);
});