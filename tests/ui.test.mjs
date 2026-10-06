import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar, settle, searchedQueries } from "./helpers/harness.mjs";
import { readRepo, sidebarSource } from "./helpers/extract.mjs";

const KEY = { epinfo_tmdb_key: "TESTKEY" };

const SHOW = {
  id: 1399, name: "Severance", poster_path: "/p.jpg",
  number_of_seasons: 1, number_of_episodes: 2,
  seasons: [{ season_number: 1, episode_count: 2 }], images: {}
};
const SEASON_1 = {
  id: 3624, poster_path: "/s1.jpg",
  episodes: [
    { episode_number: 1, name: "Good News About Hell", air_date: "2022-02-18" },
    { episode_number: 2, name: "Half Loop", air_date: "2022-02-25" }
  ]
};

function boot(storage) {
  return loadSidebar({
    storage: Object.assign({}, KEY, storage || {}),
    routes: {
      // Auto-identification searches /search/tv; the manual search uses
      // /search/multi. Both are stubbed so either path can be driven.
      "/3/search/tv": { results: [{ id: 1399, name: "Severance", vote_count: 4000 }] },
      "/3/search/multi": { results: [{ id: 1399, media_type: "tv", name: "Severance", vote_count: 4000 }] },
      "/3/tv/1399/season/1": SEASON_1,
      "/3/tv/1399": SHOW
    }
  });
}
function ls(h, key) {
  try { return JSON.parse(h.localStorage.getItem(key) || "null"); } catch (e) { return null; }
}
function posted(h, name) {
  return h.iina._posted.filter((x) => x.name === name).map((x) => x.payload);
}

// ── Settings ───────────────────────────────────────────────────────

test("opacity is stored and sent as a fraction", () => {
  // It used to be stored as the raw slider integer, which would hand main.js
  // value: 70 instead of 0.7 and blow the card's opacity out of range.
  const h = boot();
  h.global.doSetOpacity("70");
  assert.equal(h.localStorage.getItem("epinfo_overlay_opacity"), "0.7");
  assert.equal(h.document.getElementById("opacity-val").textContent, "70%");
  const msg = posted(h, "setOverlayOpacity");
  assert.equal(msg.length, 1);
  assert.ok(Math.abs(msg[0].value - 0.7) < 1e-9, `sent ${msg[0].value}`);
});

test("vertical position is stored and sent as a number", () => {
  const h = boot();
  h.global.doSetVPos("25");
  assert.equal(h.localStorage.getItem("epinfo_overlay_vpos"), "25");
  const msg = posted(h, "setOverlayVerticalPos");
  assert.equal(msg.length, 1);
  assert.equal(msg[0].value, 25);
});

test("the theme is stored and only a known one is accepted", () => {
  const h = boot();
  h.global.doSetTheme("compact");
  assert.equal(h.localStorage.getItem("epinfo_overlay_theme"), "compact");
  assert.equal(posted(h, "setOverlayTheme")[0].value, "compact");

  h.global.doSetTheme("nonsense");
  assert.equal(h.localStorage.getItem("epinfo_overlay_theme"), "classic",
    "an unknown theme was persisted");
});

test("the pause delay is clamped to a sane range", () => {
  const h = boot();
  h.global.doSetPauseDelay("45");
  assert.equal(h.localStorage.getItem("epinfo_pause_delay"), "30", "45s was not clamped");
  h.global.doSetPauseDelay("0");
  assert.equal(h.localStorage.getItem("epinfo_pause_delay"), "0.5", "0s was not clamped");
  h.global.doSetPauseDelay("3");
  assert.equal(h.localStorage.getItem("epinfo_pause_delay"), "3");
});

// ── The API key ────────────────────────────────────────────────────

test("an invalid key is rejected and not saved", async () => {
  // TMDB answers a bad key with a 401 body that carries no images. Accepting
  // any response meant a dead key looked valid until the first real lookup
  // failed.
  const h = loadSidebar({
    storage: {},
    routes: { "/3/configuration": { status_code: 7, status_message: "Invalid API key" } }
  });
  h.document.getElementById("api-input").value = "DEADKEY";
  h.global.doSaveKey();
  await settle();
  assert.equal(h.localStorage.getItem("epinfo_tmdb_key"), null, "a dead key was saved");
  assert.match(h.document.getElementById("api-msg").textContent, /Invalid key/);
});

test("a valid key is saved and pushed to main.js", async () => {
  const h = loadSidebar({
    storage: {},
    routes: { "/3/configuration": { images: { secure_base_url: "https://image.tmdb.org/t/p/" } } }
  });
  h.document.getElementById("api-input").value = "GOODKEY";
  h.global.doSaveKey();
  await settle();
  assert.equal(h.localStorage.getItem("epinfo_tmdb_key"), "GOODKEY");
  assert.equal(posted(h, "setTmdbKey")[0].key, "GOODKEY");
});

// ── Search history ─────────────────────────────────────────────────

test("recent searches de-duplicate case-insensitively, newest first", () => {
  const h = boot();
  h.global.pushSearch("Severance");
  h.global.pushSearch("Frieren");
  h.global.pushSearch("severance");
  const list = ls(h, "epinfo_searches");
  assert.equal(list.length, 2, `expected 2 entries, got ${JSON.stringify(list)}`);
  assert.equal(list[0], "severance", "the newest search is not first");
});

test("recent searches are capped", () => {
  const h = boot();
  for (let i = 0; i < 12; i++) h.global.pushSearch("query " + i);
  assert.ok(ls(h, "epinfo_searches").length <= 5,
    `cap not applied: ${ls(h, "epinfo_searches").length}`);
});

test("running a stored search puts it in the box", () => {
  const h = boot();
  h.global.pushSearch("Severance");
  h.global.runSearch(0);
  assert.equal(h.document.getElementById("q").value, "Severance");
});

// ── Recent picks ───────────────────────────────────────────────────

async function identify(h, code) {
  h.iina._emit("fileChanged", { url: "file:///v/Severance " + code + ".mkv" });
  await settle();
  return posted(h, "episodeSelected").pop();
}

test("an identified episode lands in Recent Picks", async () => {
  const h = boot();
  const info = await identify(h, "S01E01");
  const list = ls(h, "epinfo_recents");
  assert.equal(list.length, 1, "nothing was recorded");
  assert.equal(list[0].info.code, info.code);
  assert.equal(list[0].info.showTitle, "Severance");
});

test("Recent Picks is capped, oldest unpinned entries dropped", async () => {
  const h = boot();
  for (let i = 1; i <= 8; i++) {
    h.global.saveSelection({
      showTitle: "Show " + i, epTitle: "Ep", code: "S01E0" + i, context: "",
      airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "",
      tmdbId: String(1000 + i), season: 1, episode: i, isMovie: false
    });
  }
  const list = ls(h, "epinfo_recents");
  assert.ok(list.length <= 5, `cap not applied: ${list.length}`);
  assert.ok(list.length > 0);
});

test("a pinned entry is never evicted by the cap", () => {
  const h = boot();
  h.global.saveSelection({
    showTitle: "Keeper", epTitle: "Ep", code: "S01E01", context: "",
    airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "",
    tmdbId: "1", season: 1, episode: 1, isMovie: false
  });
  // Pin it, then push enough others to overflow the cap.
  h.global.togglePin(0);
  for (let i = 1; i <= 8; i++) {
    h.global.saveSelection({
      showTitle: "Show " + i, epTitle: "Ep", code: "S01E0" + i, context: "",
      airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "",
      tmdbId: String(2000 + i), season: 1, episode: i, isMovie: false
    });
  }
  const list = ls(h, "epinfo_recents");
  assert.ok(list.some((r) => r.info.showTitle === "Keeper"),
    "a pinned entry was evicted");
});

test("re-adding a show keeps its pin", () => {
  const h = boot();
  const info = {
    showTitle: "Keeper", epTitle: "Ep", code: "S01E01", context: "",
    airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "",
    tmdbId: "1", season: 1, episode: 1, isMovie: false
  };
  h.global.saveSelection(info);
  h.global.togglePin(0);
  assert.equal(ls(h, "epinfo_recents")[0].pinned, true, "pin did not take");

  // Same show again: the pin must survive the re-push.
  h.global.saveSelection(Object.assign({}, info, { code: "S01E02", episode: 2 }));
  assert.equal(ls(h, "epinfo_recents")[0].pinned, true,
    "re-adding the show cleared its pin");
});

test("corrupt storage is tolerated rather than fatal", async () => {
  // A non-array recents value used to throw inside pruneRecents, and because
  // that ran inside the boot timer the throw also skipped sidebarReady, so
  // main.js never re-emitted fileChanged and per-URL restore died for the
  // whole session.
  const h = boot({
    epinfo_recents: '{"not":"an array"}',
    epinfo_searches: "nonsense",
    epinfo_url_map: '"not an object either"',
    epinfo_folder_map: "[]"
  });
  h.timers._fireAll();
  await settle();
  assert.ok(posted(h, "sidebarReady").length > 0,
    "the boot pass threw before telling main.js it was ready");

  // And saving still works afterwards.
  await identify(h, "S01E01");
  assert.ok(Array.isArray(ls(h, "epinfo_recents")), "recents did not recover");
});

// The guards are only load-bearing if something calls the vulnerable path with
// a bad value. The boot pass alone did not: its callers happened to tolerate
// one. These drive the code that actually used to throw.
test("pruneRecents survives a non-array recents value", () => {
  const h = boot({ epinfo_recents: '{"not":"an array"}' });
  // Length, not deepStrictEqual: the array is built inside the vm realm.
  assert.equal(h.global.loadRecents().length, 0, "the bad value was not discarded");
  assert.doesNotThrow(() => h.global.pruneRecents());
  assert.doesNotThrow(() => h.global.renderRecents());
});

test("renderSearches survives a non-array searches value", () => {
  const h = boot({ epinfo_searches: '{"not":"an array"}' });
  assert.equal(h.global.loadSearches().length, 0, "the bad value was not discarded");
  assert.doesNotThrow(() => h.global.renderSearches());
});

test("a corrupt folder map yields no pins, and lookup tolerates it", () => {
  const h = boot({ epinfo_folder_map: '["an","array"]' });
  assert.equal(Object.keys(h.global.loadFolderMap()).length, 0, "the bad value was not discarded");
  assert.equal(h.global.pinForUrl("file:///Users/me/Videos/x.mkv"), null);
});

test("a corrupt url map yields no remembered entries", () => {
  // A stored null passed the old guard and then threw in Object.keys during
  // the boot prune, which skipped sidebarReady and took per-URL restore with
  // it. The empty-function assertion this replaced could never fail.
  for (const raw of ['["an","array"]', "null", "nonsense"]) {
    const h = boot({ epinfo_url_map: raw });
    assert.equal(Object.keys(h.global.loadUrlMap()).length, 0, `kept ${raw}`);
    assert.doesNotThrow(() => h.global.pruneUrlMap());
    assert.doesNotThrow(
      () => h.iina._emit("fileChanged", { url: "file:///v/Severance S01E01.mkv" }),
      `fileChanged threw on ${raw}`
    );
  }
});

test("a film record is built in one place", () => {
  // Two literals had already drifted: one took the id from the detail
  // response, the other from the search result.
  const sidebar = sidebarSource();
  assert.equal((sidebar.match(/showTitle:\s*"Movie"/g) || []).length, 1,
    "the film record literal appears more than once");
});

test("a search with no results says so and re-enables the button", async () => {
  const h = loadSidebar({ storage: KEY, routes: { "/3/search/multi": { results: [] } } });
  h.document.getElementById("q").value = "Nothing At All";
  h.global.doSearch();
  await settle();
  assert.match(h.document.getElementById("panel").innerHTML, /No results/);
  assert.equal(h.document.getElementById("go").disabled, false,
    "the GO button stayed disabled after a search that returned nothing");
});

test("a recent pick cannot be contradicted by a leftover season grid", () => {
  // Clicking a Recent Pick painted the card but left the panel alone, so a grid
  // from an earlier parse stayed on screen underneath it. A One Piece card
  // reading S36E04 was reported above a grid reading S01, which is a pick the
  // plugin was not making. The normal pick path clears this state, so the
  // recent path has to as well.
  const h = boot();
  const info = {
    showTitle: "One Piece", epTitle: "Adventure in the Land of Science",
    code: "S36E04", context: "Season 36 of 36", airDate: "2025-08-03",
    rating: "8.5", overview: "", posterUrl: "", logoUrl: "",
    tmdbId: "37854", season: 36, episode: 4, isMovie: false
  };
  h.global.saveSelection(info);
  // Whatever an earlier identification left behind: a grid on another season.
  h.global.selShow = { id: 1399, _name: "Severance", _seasons: SHOW.seasons };
  h.global.selSeason = 1;
  h.global.renderSeasons();
  assert.match(h.document.getElementById("panel").innerHTML, /pickSeason/,
    "the test needs a grid on screen to be meaningful");

  h.global.applyRecent(0);
  const panel = h.document.getElementById("panel").innerHTML;
  assert.doesNotMatch(panel, /pickSeason/,
    `a stale grid survived a different pick: ${panel}`);
  assert.equal(h.global.selSeason, null, "the old season stayed selected");
  // The card is the point of the click, so it must still be there.
  assert.equal(h.document.getElementById("s-title").textContent, info.epTitle);
});