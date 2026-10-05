import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar, loadOverlay, settle } from "./helpers/harness.mjs";
import { readRepo, sidebarSource } from "./helpers/extract.mjs";

const KEY = { epinfo_tmdb_key: "TESTKEY" };

const SHOW = {
  id: 1399,
  name: "Severance",
  poster_path: "/p.jpg",
  number_of_seasons: 2,
  number_of_episodes: 19,
  seasons: [{ season_number: 1 }, { season_number: 2 }],
  images: {}
};
const SEASON_2 = {
  poster_path: "/s2.jpg",
  episodes: [
    { episode_number: 1, name: "Hello, Ms. Cobel", air_date: "2025-02-21", vote_average: 8.4, overview: "o1" },
    { episode_number: 2, name: "Half Loop", air_date: "2025-02-28", vote_average: 8.8, overview: "o2" },
    { episode_number: 3, name: "In Perpetuity", air_date: "2025-03-07", vote_average: 9.1, overview: "o3" }
  ]
};

function boot(routes = {}) {
  return loadSidebar({
    storage: KEY,
    routes: {
      "/3/search/tv": { results: [{ id: 1399, name: "Severance", vote_count: 4000 }] },
      "/3/tv/1399/season/2": SEASON_2,
      "/3/tv/1399/season/1": { poster_path: "/s1.jpg", episodes: [] },
      "/3/tv/1399": SHOW,
      ...routes
    }
  });
}

async function identify(h, url) {
  h.global.currentVideoUrl = url;
  h.global.autoIdentify(url);
  await settle();
}

function selected(h) {
  const p = h.iina._posted.filter((x) => x.name === "episodeSelected");
  return p.length ? p[p.length - 1].payload : null;
}

test("the card says where the episode sits in its season", async () => {
  const h = boot();
  await identify(h, "file:///v/Severance S02E03.mkv");
  const info = selected(h);
  assert.ok(info, "nothing was selected");
  // The last episode of the season, so there is nothing after it to promise.
  assert.equal(info.context, "Season 2 of 2  ·  Episode 3 of 3");
});

test("the next episode's air date is shown when TMDB knows it", async () => {
  const h = boot();
  await identify(h, "file:///v/Severance S02E01.mkv");
  assert.equal(selected(h).context, "Season 2 of 2  ·  Episode 1 of 3  ·  Next S02E02 2025-02-28");
});

test("no total is claimed for an episode outside the season TMDB lists", async () => {
  // renderEps deliberately refuses to auto-select an episode the season does
  // not contain, so this state is only reachable after a manual pick. TMDB
  // does return partial seasons, and "Episode 3 of 2" would be nonsense.
  const h = boot();
  h.global.episodeCache = [
    { episode_number: 1, name: "One", air_date: "2025-02-21" },
    { episode_number: 2, name: "Two", air_date: "2025-02-28" }
  ];
  h.global.showTotals = { seasons: 2, episodes: 19 };
  const stray = { episode_number: 3, name: "Three", air_date: "2025-03-07" };
  const text = h.global.seriesContext(2, stray);
  assert.equal(text, "Season 2 of 2");

  // An episode that is inside the list still gets its total.
  const inside = h.global.seriesContext(2, h.global.episodeCache[0]);
  assert.equal(inside, "Season 2 of 2  ·  Episode 1 of 2  ·  Next S02E02 2025-02-28");
});

test("a film carries no series context", async () => {
  const h = boot({
    "/3/search/movie": { results: [{ id: 550, title: "Fight Club", release_date: "1999-10-15", vote_count: 26000 }] },
    "/3/movie/550": { id: 550, title: "Fight Club", release_date: "1999-10-15", vote_average: 8.4, images: {} }
  });
  await identify(h, "file:///v/Fight Club 1999.mkv");
  const info = selected(h);
  assert.equal(info.isMovie, true);
  assert.ok(!info.context, `film should have no context line: ${info.context}`);
});

test("the overlay renders the context line and clears it again", () => {
  const o = loadOverlay();
  o.iina._emit("showData", {
    showTitle: "Severance", epTitle: "In Perpetuity", code: "S02E03",
    airDate: "2025-03-07", rating: "9.1", overview: "o",
    context: "Season 2 of 2  ·  Episode 3 of 10"
  });
  assert.equal(o.document.getElementById("ctx-row").textContent, "Season 2 of 2  ·  Episode 3 of 10");

  // A film after an episode must not inherit the previous show's line.
  o.iina._emit("showData", { showTitle: "Movie", epTitle: "Fight Club", code: "1999", context: "" });
  assert.equal(o.document.getElementById("ctx-row").textContent, "");
});

test("an entry saved before the context line existed re-identifies once", async () => {
  const h = boot();
  const url = "file:///v/Severance S02E03.mkv";
  await identify(h, url);
  assert.match(selected(h).context, /Episode 3 of 3/);

  // Rewrite the cached entry the way the previous version stored it: no
  // context key at all.
  const map = JSON.parse(h.localStorage.getItem("epinfo_url_map"));
  delete map[url].context;
  h.localStorage.setItem("epinfo_url_map", JSON.stringify(map));

  // Leave and come back, rather than re-sending fileChanged for the same file:
  // a duplicate for the file already playing is now a deliberate no-op.
  const revisit = async () => {
    h.iina._emit("fileChanged", { url: "file:///v/Another File.mkv" });
    await settle();
    h.iina._emit("fileChanged", { url });
    await settle();
  };

  const before = h.fetchCalls.length;
  await revisit();
  assert.ok(h.fetchCalls.length > before, "the old entry was replayed instead of upgraded");
  assert.match(selected(h).context, /Episode 3 of 3/, "the upgraded entry has no context line");

  // And it settles: the upgraded entry must not be considered stale again.
  const afterUpgrade = h.fetchCalls.length;
  await revisit();
  assert.equal(h.fetchCalls.length, afterUpgrade, "the upgraded entry is stale every single time");
});

test("a film entry is not re-identified on every open", async () => {
  // Films store context:"" rather than omitting the key. If they omitted it,
  // the staleness check would treat every film as pre-context and re-fetch it
  // forever.
  const h = boot({
    "/3/search/movie": { results: [{ id: 550, title: "Fight Club", release_date: "1999-10-15", vote_count: 26000 }] },
    "/3/movie/550": { id: 550, title: "Fight Club", release_date: "1999-10-15", vote_average: 8.4, poster_path: "/fc.jpg", images: {} }
  });
  const url = "file:///v/Fight Club 1999.mkv";
  await identify(h, url);
  assert.ok(selected(h), "the film was not identified");

  const map = JSON.parse(h.localStorage.getItem("epinfo_url_map"));
  assert.equal(map[url].context, "", "a film entry must still carry the key");

  const afterFirst = h.fetchCalls.length;
  h.iina._emit("fileChanged", { url });
  await settle();
  assert.equal(h.fetchCalls.length, afterFirst, "the film was re-fetched on re-open");
});

test("TMDB's attribution lives in the sidebar, not on the card", () => {
  // Static markup, so this asserts on the source rather than on a rendered
  // element: the harness's document is a stub and never parses HTML.
  const sidebar = readRepo("sidebar.html");
  const overlay = readRepo("overlay.html");
  assert.match(sidebar, /Not endorsed or certified by TMDB/);
  // Comments in the overlay still mention TMDB (the wordmark is TMDB's), so
  // this checks for the rendered notice rather than the word.
  assert.doesNotMatch(overlay, /Not endorsed/,
    "the overlay card should carry no attribution wording");
  assert.doesNotMatch(overlay, /id="attr"/, "the attribution element is still on the card");

  // The full notice still has to exist somewhere for the terms.
  assert.match(readRepo("README.md"), /not endorsed or certified by TMDB/i);
});
// ── Overlay layout and fallbacks ────────────────────────────────────

test("a film's wordmark is sized for the compact theme", () => {
  const o = loadOverlay();
  o.iina._emit("showData", {
    theme: "compact", isMovie: true, logoUrl: "https://image.tmdb.org/t/p/w780/l.png",
    epTitle: "Heat", showTitle: "Movie"
  });
  const wrap = o.document.getElementById("wrap");
  assert.equal(wrap.attributes["data-theme"], "compact");
  assert.equal(wrap.attributes["data-logo"], "movie");
  // The wordmark is the only title a film shows, so it must not be sized by
  // the movie rule and overflow a compact card.
  assert.match(readRepo("overlay.html"),
    /\[data-theme="compact"\]\[data-logo="movie"\] #logo img \{ max-height: 22px; \}/);
});

test("an absent poster collapses instead of reserving a gap", () => {
  const o = loadOverlay();
  o.iina._emit("showData", { showTitle: "Severance", epTitle: "Ep", posterUrl: "" });
  assert.equal(o.document.getElementById("poster").innerHTML, "");
  assert.match(readRepo("overlay.html"), /#poster:empty \{ display: none; \}/);
});

test("the logo and poster carry the title as alt text", () => {
  const o = loadOverlay();
  o.iina._emit("showData", {
    isMovie: true, logoUrl: "https://image.tmdb.org/t/p/w780/l.png",
    posterUrl: "https://image.tmdb.org/t/p/w500/p.jpg",
    epTitle: "Heat", showTitle: "Movie"
  });
  // A film hides both text lines, so a failed image would otherwise leave the
  // card with nothing naming the film.
  assert.match(o.document.getElementById("logo").innerHTML, /alt="Heat"/);
  assert.match(o.document.getElementById("poster").innerHTML, /alt='Heat'/);
});

test("a film no longer prints its year twice", () => {
  const sidebar = sidebarSource();
  // `code` held the year and airDate began with the year, so the meta row read
  // "2011 · 2011-06-03".
  assert.doesNotMatch(sidebar, /code:\s*\(d\.release_date \|\| ""\)\.slice/);
  assert.doesNotMatch(sidebar, /code: d\.release_date\?d\.release_date\.slice/);
});
