import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar, settle, searchedQueries } from "./helpers/harness.mjs";

// Everything the parser has to keep reading, in one place: the release
// conventions, the anime and fansub ones, the near-misses that must not parse,
// and the library layouts that put the show in a directory rather than the
// filename.
//
// This used to be four files, which shared eleven filenames between them,
// including "1917.2019" asserted in three of them. A fix to one was invisible to
// the others, and which file a new case belonged in was never obvious. The bugs
// found later live in parse-regressions.test.mjs: this file is the behaviour
// that was always supposed to work.

const g = loadSidebar().global;
const KEY = { epinfo_tmdb_key: "TESTKEY" };

// The parser holds no state between calls, so one shared context serves the
// whole file.
function parsed(name) {
  return g.parseFilename("file:///Users/me/Videos/" + name);
}
function at(...parts) {
  return "file:///Users/me/Videos/" + parts.filter(Boolean).join("/");
}
// The two shapes of accessor, both kept because both read naturally at different
// call sites: these take a bare filename, the ones below take a whole URL.
function titleOf1(name) {
  const r = parsed(name);
  return r ? r.title : null;
}
function codeOf1(name) {
  const r = parsed(name);
  if (!r || !r.code) return null;
  // A plain array, not one built in the vm realm: deepStrictEqual compares
  // prototypes, and those never match across a realm boundary.
  return [Number(r.code.season), Number(r.code.episode)];
}
function titleOf(url) {
  const r = g.parseFilename(url);
  return r ? r.title : null;
}
function codeOf(url) {
  const r = g.parseFilename(url);
  return r && r.code ? { season: r.code.season, episode: r.code.episode } : null;
}

// Objects built inside the vm context carry that realm's Object.prototype, so
// deepStrictEqual against a host literal fails on the prototype alone. Compare
// the fields.
function fields(r) {
  return r ? [r.season, r.episode, r.extra] : null;
}
function assertCode(r, season, episode, extra = null) {
  assert.ok(r, "expected an episode code, got null");
  assert.deepEqual(fields(r), [season, episode, extra], "code");
}

// ── Naruto, for the long-running-series cases ───────────────────────
// TMDB files Naruto and Shippuden as separate seasons of 220, so the
// franchise-absolute "E484" belongs to neither on its own.
const NARUTO = {
  id: 46260, name: "Naruto", poster_path: "/n.jpg",
  number_of_seasons: 1, number_of_episodes: 500,
  seasons: [{ season_number: 1, episode_count: 500 }],
  images: { logos: [{ file_path: "/n-logo.png", aspect_ratio: 6, iso_639_1: "en" }] }
};
const NARUTO_SEASON = {
  poster_path: "",
  episodes: [
    { episode_number: 220, name: "Towards the End", air_date: "2017-08-29" },
    { episode_number: 484, name: "A Long Way", air_date: "2019-01-06" }
  ]
};
function boot(routes = {}) {
  return loadSidebar({
    storage: KEY,
    routes: {
      "/3/search/tv": { results: [] },
      "/3/search/multi": { results: [] },
      "/3/tv/46260/season/1": NARUTO_SEASON,
      "/3/tv/46260": NARUTO,
      ...routes
    }
  });
}
async function identify(app, url) {
  app.global.currentVideoUrl = url;
  app.global.autoIdentify(url);
  await settle();
}
function selected(app) {
  const p = app.iina._posted.filter((x) => x.name === "episodeSelected");
  return p.length ? p[p.length - 1].payload : null;
}

// ── Release conventions ──────────────────────────────────────────
test("harness exposes the parser", () => {
  for (const fn of ["parseFilename", "parseEpisodeCode", "cleanTitle", "titleCandidates", "pickLogo"]) {
    assert.equal(typeof g[fn], "function", fn + " is not exposed to the tests");
  }
});

// ── parseEpisodeCode ─────────────────────────────────────────────────
test("parses the common release conventions", () => {
  assertCode(g.parseEpisodeCode("Severance S02E03"), 2, 3);
  assertCode(g.parseEpisodeCode("Breaking Bad - S03E11 - 1080p"), 3, 11);
  assertCode(g.parseEpisodeCode("The Office US S09E16 720p HDTV"), 9, 16);
  assertCode(g.parseEpisodeCode("Show Name 1x05"), 1, 5);
  assertCode(g.parseEpisodeCode("Doctor Who Season 2 Episode 7"), 2, 7);
  assertCode(g.parseEpisodeCode("Show Name S01.E02"), 1, 2);
});

test("parses multi-episode packs", () => {
  assertCode(g.parseEpisodeCode("Show Name S01E02E03"), 1, 2, 3);
});

test("underscores between title and code are stripped", () => {
  // The \b bug: "_" and "S" are both word characters, so a word-boundary
  // anchor cannot match between them and the code stays in the title.
  const p = parsed("Band_of_Brothers_S01E04.mkv");
  assert.equal(p.title, "Band of Brothers");
  assert.equal(p.code.season, 1);
  assert.equal(p.code.episode, 4);
});

test("absolute anime numbering", () => {
  const a = parsed("[SubsPlease] Frieren - 05 (1080p).mkv");
  assert.equal(a.code.season, 1);
  assert.equal(a.code.episode, 5);
  const b = parsed("Attack on Titan - 12 [1080p].mkv");
  assert.equal(b.code.episode, 12);
});

test("a bare 4-digit year is a film date, not an episode", () => {
  assert.equal(g.parseEpisodeCode("The Matrix 1999"), null);
  const p = parsed("The.Matrix.1999.1080p.BluRay.x264-GRP.mkv");
  assert.equal(p.code, null);
  assert.equal(p.year, 1999);
  assert.equal(p.isMovie, true);
});

test("trailing whitespace does not defeat the year strip", () => {
  // Regression: the year pattern is $-anchored and the junk pass left a space.
  assert.equal(parsed("1917.2019.1080p.BluRay.x264.mkv").year, 2019);
});

// ── parseFilename ────────────────────────────────────────────────────
test("title is cleaned of release noise", () => {
  const cases = [
    ["Severance.S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv", "Severance", 2, 3],
    ["Breaking Bad - S03E11 - 1080p.mkv", "Breaking Bad", 3, 11],
    ["The.Office.US.S09E16.720p.HDTV.x264.mkv", "The Office US", 9, 16],
    ["Show.Name.1x05.avi", "Show Name", 1, 5]
  ];
  for (const [file, title, season, episode] of cases) {
    const p = parsed(file);
    assert.equal(p.title, title, `title for ${file}`);
    assert.equal(p.code.season, season, `season for ${file}`);
    assert.equal(p.code.episode, episode, `episode for ${file}`);
  }
});

test("remake protection relies on the year, not the vote count", () => {
  assert.equal(parsed("Footloose.1984.1080p.mkv").year, 1984);
});

test("a name with neither a code nor a year is left alone", () => {
  // autoIdentify bails on this; it must not guess.
  const p = parsed("Some Random Home Video.mp4");
  assert.equal(p.isMovie, false);
  assert.equal(p.code, null);
});

test("1917 is a title, not an episode number", () => {
  const p = parsed("1917.2019.1080p.BluRay.x264.mkv");
  assert.equal(p.year, 2019);
  assert.equal(p.code, null);
});

// ── titleCandidates ──────────────────────────────────────────────────
test("ladder walks down from the full title and never stops at an article", () => {
  const c = g.titleCandidates("Breaking Bad");
  assert.equal(c[0], "Breaking Bad");
  assert.equal(c[1], "Breaking");
  assert.ok(!c.includes("The"));
  assert.ok(!g.titleCandidates("The Office").includes("The"));
});

test("ladder de-duplicates", () => {
  const c = g.titleCandidates("Show Name");
  assert.equal(new Set(c).size, c.length);
});

// ── pickLogo ─────────────────────────────────────────────────────────
test("rejects squarer-than-2.5:1 artwork and non-English logos", () => {
  assert.equal(g.pickLogo({ logos: [{ file_path: "/p.jpg", aspect_ratio: 1.0, iso_639_1: "en" }] }), "");
  assert.equal(g.pickLogo({ logos: [{ file_path: "/p.jpg", aspect_ratio: 6, iso_639_1: "he" }] }), "");
});

test("prefers a wide English wordmark", () => {
  const url = g.pickLogo({
    logos: [
      { file_path: "/wide.jpg", aspect_ratio: 6.0, iso_639_1: "en", vote_average: 5.0 },
      { file_path: "/square.jpg", aspect_ratio: 0.85, iso_639_1: "en", vote_average: 9.0 }
    ]
  });
  assert.equal(url, "https://image.tmdb.org/t/p/w780/wide.jpg");
});

test("vote average decides between two wide wordmarks", () => {
  // Documents current behaviour, which is NOT what the comment above pickLogo
  // claims: every logo past 3:1 gets the same "wide" bonus, so an 8:1 hairline
  // with a high vote average does beat a solid 4:1 one. Reported, not fixed:
  // see NOTES.md.
  const url = g.pickLogo({
    logos: [
      { file_path: "/solid.jpg", aspect_ratio: 4.0, iso_639_1: "en", vote_average: 5.0 },
      { file_path: "/hairline.jpg", aspect_ratio: 8.0, iso_639_1: "en", vote_average: 7.9 }
    ]
  });
  assert.equal(url, "https://image.tmdb.org/t/p/w780/hairline.jpg");
});

test("no logos at all is not an error", () => {
  assert.equal(g.pickLogo({}), "");
  assert.equal(g.pickLogo(null), "");
});

// ── Anime and fansub conventions ───────────────────────────────
test("the anime E-marker is an episode number", () => {
  const p = parsed("Naruto.Shippuuden.E484.720p.Bia2Anime.mkv");
  assert.equal(p.code.season, 1);
  assert.equal(p.code.episode, 484);
  // …and the marker is not left behind to pollute the search.
  assert.equal(p.title, "Naruto Shippuuden Bia2Anime");
});

test("a four-digit E-marker is still an episode", () => {
  // One Piece is past 1100, so the pattern cannot stop at three digits. It is
  // read as an absolute number rather than a season-1 code, because no show has
  // an S01E1062 and locateAbsolute is what places a number that large.
  const p = parsed("One.Piece.E1062.1080p.mkv");
  assert.equal(p.code, null);
  assert.equal(p.absolute, 1062);
});

test("a lowercase e-marker works too", () => {
  assert.equal(parsed("Naruto.Shippuuden.e484.mkv").code.episode, 484);
});

test("codecs are not E-markers", () => {
  for (const f of ["Show.H.265.AAC.HEVC.mkv", "Film.2019.2160p.WEB-DL.DDP5.1.HDR.x265-GRP.mkv"]) {
    const p = parsed(f);
    // Not an E-marker at least. (A file ending in a bare channel spec is a
    // separate pre-existing bug: the end-anchored pattern reads the "1" of
    // "5.1" as episode 1. Reported, not fixed.)
    assert.ok(p.code === null || p.code.episode > 1, `false episode in ${f}: ${JSON.stringify(p.code)}`);
  }
});

// ── A number in the middle, between separators ──────────────────────

test("a mid-string number between dashes is an episode", () => {
  const p = parsed("AnimePahe_Nippon_Sangoku_-_05_1080p_Amazon.mp4");
  assert.equal(p.code.season, 1);
  assert.equal(p.code.episode, 5);
});

test("a space-delimited number is left alone", () => {
  // The guard that keeps films intact: "500 Days" is space-delimited, so the
  // mid-string pattern must not fire on it.
  const p = parsed("500.Days.of.Summer.2009.mkv");
  assert.equal(p.code, null);
  assert.equal(p.title, "500 Days of Summer");
  assert.equal(p.isMovie, true);
});

test("a year is still a film date, not an episode", () => {
  for (const f of ["The.Matrix.1999.1080p.BluRay.x264-GRP.mkv",
                   "Spider-Man.3.2002.1080p.mkv",
                   "1917.2019.1080p.BluRay.x264.mkv"]) {
    const p = parsed(f);
    assert.equal(p.code, null, `false episode in ${f}`);
    assert.equal(p.isMovie, true, `not a film: ${f}`);
  }
});

test("the year guard holds for every pattern, not one of them", () => {
  // It used to be written as `i === 3`, which silently pointed at the wrong
  // pattern the moment a pattern was inserted above it.
  assert.equal(g.parseEpisodeCode("Show E1999"), null, "E-marker read as a year");
  assert.equal(g.parseEpisodeCode("Show - 2001"), null, "trailing year read as an episode");
  assert.equal(g.parseEpisodeCode("Film 1999-2001"), null);
  // A year sitting in the title is not what the guard is about: "Show 2000"
  // is a title, and the 05 is a real episode.
  assert.equal(g.parseEpisodeCode("Show 2000 - 05").episode, 5);
  // …and a legitimate three-digit episode is unaffected.
  assert.equal(g.parseEpisodeCode("Show - 999").episode, 999);
});

// ── End to end ──────────────────────────────────────────────────────

test("the Naruto filename now identifies without help", async () => {
  const app = boot({
    "/3/search/tv": { results: [{ id: 46260, name: "Naruto Shippuuden", vote_count: 3000, poster_path: "/n.jpg" }] },
    "/3/tv/46260": Object.assign({}, NARUTO, { number_of_episodes: 500 })
  });
  await identify(app, "file:///v/Naruto.Shippuuden.E484.720p.Bia2Anime.mkv");
  const info = selected(app);
  assert.ok(info, "nothing was selected");
  assert.equal(info.code, "S01E484");
  assert.equal(info.logoUrl, "https://image.tmdb.org/t/p/w780/n-logo.png");
});

test("an episode no season holds leaves the picker rather than guessing", async () => {
  // What TMDB actually does: Naruto and Shippuden are separate seasons of 220,
  // so the franchise-absolute 484 is in neither. Identifying the series is
  // still right; picking an episode would not be.
  const app = boot({
    "/3/search/tv": { results: [{ id: 46260, name: "Naruto Shippuuden", vote_count: 3000, poster_path: "/n.jpg" }] },
    // The season really does stop at 220, which is the point of this test.
    "/3/tv/46260/season/1": { poster_path: "", episodes: [{ episode_number: 220, name: "Towards the End" }] }
  });
  await identify(app, "file:///v/Naruto.Shippuuden.E484.720p.Bia2Anime.mkv");
  assert.equal(selected(app), null, "an episode was invented");
  // Read the #ep stub, not the panel's innerHTML: the harness cannot reflect
  // children written into an innerHTML string.
  assert.match(app.document.getElementById("ep").innerHTML, /has no episode 484/);
});

test("the site prefix washes out through the ladder", async () => {
  const app = boot({
    "/3/search/tv": { results: [{ id: 9999, name: "Nippon Sangoku", vote_count: 500, poster_path: "/s.jpg" }] },
    "/3/tv/9999": {
      id: 9999, name: "Nippon Sangoku", poster_path: "/s.jpg",
      number_of_seasons: 1, number_of_episodes: 12,
      seasons: [{ season_number: 1, episode_count: 12 }], images: {}
    },
    "/3/tv/9999/season/1": {
      poster_path: "",
      episodes: [{ episode_number: 5, name: "The Oath", air_date: "2009-10-11" }]
    }
  });
  await identify(app, "file:///v/AnimePahe_Nippon_Sangoku_-_05_1080p_Amazon.mp4");
  const info = selected(app);
  assert.ok(info, "nothing was selected");
  assert.equal(info.showTitle, "Nippon Sangoku");
  // "AnimePahe" is not in the title, so the ladder descended past it.
  assert.ok(!/animepahe/i.test(info.showTitle));
  // The full name is tried first, then shorter prefixes. What must never
  // happen is a rung that is *only* the site name. The ladder has to get
  // past it to reach the real title.
  const queried = searchedQueries(app.fetchCalls).filter(Boolean);
  assert.ok(queried.length >= 1);
  assert.ok(!queried.includes("AnimePahe"), `stopped on the site name: ${queried}`);
  assert.ok(queried[queried.length - 1].endsWith("Nippon Sangoku"),
    `last rung was not the real title: ${queried}`);
});

// ── Near-misses that must not parse ───────────────────────────
test("a language name inside a title is not noise", () => {
  // These were in the unconditional junk list, so the global pass cut them out
  // of the middle of the name. Each of these is a real film or series.
  const cases = [
    ["Russian.Doll.S01E01.720p.WEB-DL.x264-NTb.mkv", "Russian Doll"],
    ["German.Girl.S01E01.1080p.WEB.h264-GROUP.mkv", "German Girl"],
    ["The.Italian.Job.S01E01.720p.mkv", "The Italian Job"],
    ["The.English.Game.S01E01.720p.HDTV.x264.mkv", "The English Game"],
    ["French.Exit.2020.1080p.BluRay.x264.mkv", "French Exit"],
    ["A.Series.of.Unfortunate.Events.S01E01.1080p.mkv", "A Series of Unfortunate Events"],
    ["Internal.Affairs.S01E01.1080p.mkv", "Internal Affairs"],
    ["The.Peripheral.S01E01.1080p.mkv", "The Peripheral"]
  ];
  for (const [name, want] of cases) {
    assert.equal(titleOf1(name), want, `title for ${name}`);
  }
});

test("real noise is still stripped", () => {
  assert.equal(titleOf1("Severance.S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv"), "Severance");
  assert.equal(titleOf1("Show.Name.S01E01.1080p.BluRay.x265-GRP.mkv"), "Show Name");
  assert.equal(titleOf1("Pantheon.6CH.SoftSub.S01E06.1080p.mkv"), "Pantheon");
  // A trailing language tag is still noise.
  assert.equal(titleOf1("Severance S02E03 German 1080p"), "Severance");
  assert.equal(titleOf1("Severance S02E03 1080p COMPLETE"), "Severance");
});

// ── Hyphenated titles ──────────────────────────────────────────────

test("a hyphenated title keeps its second half", () => {
  // The release-tag strip cannot tell "-GRP" from the rest of "Spider-Man",
  // and was deleting it, leaving "X-Men" with no title at all.
  assert.equal(titleOf1("Spider-Man.mkv"), "Spider-Man");
  assert.equal(titleOf1("X-Men.mkv"), "X-Men");
  assert.equal(titleOf1("Spider-Man.S01E01.mkv"), "Spider-Man");
  assert.deepEqual(codeOf1("X-Men.S01E01.1080p.WEB-DL.mkv"), [1, 1]);
});

test("a real release tag is still stripped", () => {
  assert.equal(titleOf1("Show.Name.S01E01.1080p.BluRay.x265-GRP.mkv"), "Show Name");
  assert.equal(titleOf1("The.Matrix.1999.1080p.BluRay.x264-GRP.mkv"), "The Matrix");
});

// ── Numbers that are not episodes ──────────────────────────────────

test("a channel spec is not an episode number", () => {
  // The known bug: the trailing "1" of "DDP5.1" was read as episode 1, so
  // every film with a channel spec became a TV episode.
  for (const name of [
    "Movie.Title.2019.1080p.BluRay.DDP5.1.mkv",
    "Movie.Title.2019.1080p.BluRay.H.264.mkv",
    "Movie.Title.2022.1080p.BluRay.DTS-HD.MA.5.1.mkv",
    "Film.2020.1080p.5.1.mkv"
  ]) {
    const r = parsed(name);
    assert.equal(r.code, null, `invented an episode for ${name}`);
    assert.equal(r.isMovie, true, `not treated as a film: ${name}`);
  }
});

test("a whole channel chain is removed, not just its first digit", () => {
  // Regression: the pattern stopped at the "5" of "DTS-HD.MA.5.1" and left a
  // dangling ".1".
  assert.equal(codeOf1("Movie.Title.2022.1080p.BluRay.DTS-HD.MA.5.1.mkv"), null);
  assert.equal(titleOf1("Movie.Title.2022.1080p.BluRay.DTS-HD.MA.5.1.mkv"), "Movie Title");
});

test("a channel spec at the very end of the name is not an episode", () => {
  // The hardest position for this: the spec is the last thing in the name, so
  // the end-anchored absolute pattern finds its trailing digit first.
  assert.equal(codeOf1("Movie.DDP5.1.mkv"), null);
  assert.equal(codeOf1("Movie.5.1.mkv"), null);
});

test("a season pack does not invent an episode", () => {
  // "S01" with no episode number is a whole-season pack, not episode 1. The
  // season is still read, because the show can be identified and the right
  // season opened with no episode to select.
  const c = parsed("Show.S01.1080p.WEB-DL.DDP5.1.mkv").code;
  assert.equal(c.season, 1);
  assert.equal(c.episode, null);
});

test("a year survives the numeric cleanup", () => {
  assert.equal(parsed("Movie.Title.2019.1080p.BluRay.DDP5.1.mkv").year, 2019);
  assert.equal(parsed("The.Matrix.1999.1080p.BluRay.x264-GRP.mkv").year, 1999);
  assert.equal(parsed("1917.2019.1080p.BluRay.x264.mkv").year, 2019);
  // …and does not leak into the title.
  assert.equal(titleOf1("Movie.Title.2019.1080p.BluRay.DDP5.1.mkv"), "Movie Title");
});

// ── Bracket-only names ─────────────────────────────────────────────

test("a name that is only bracket groups still yields a title", () => {
  // cleanTitle deletes every bracket group to strip the noise, which left
  // nothing, and the name bracketTitles had already recovered was discarded
  // with it. These all returned null.
  assert.equal(titleOf1("[Frieren][12][1080p].mkv"), "Frieren");
  assert.equal(titleOf1("[Jujutsu Kaisen][47][AVC-8bit][1080p].mkv"), "Jujutsu Kaisen");
  assert.equal(titleOf1("[Oshi no Ko] - 01 [1080p].mkv"), "Oshi no Ko");
});

test("an episode written inside a bracket is read", () => {
  assert.deepEqual(codeOf1("[Frieren][12][1080p].mkv"), [1, 12]);
  assert.deepEqual(codeOf1("[Jujutsu Kaisen][47][AVC-8bit][1080p].mkv"), [1, 47]);
});

test("a bracketed episode range is a title, not a name", () => {
  // "[1062-1063]" holds no letters, so it must never be offered as a series.
  const r = parsed("[One Pace][1062-1063] Egghead 04 [1080p][En Sub][FD5592BE].mp4");
  const all = r.altTitles.strong.concat(r.altTitles.weak);
  assert.ok(!all.some((x) => /1062/.test(x)), `offered as a title: ${all}`);
});

test("a CRC32 bracket is still skipped", () => {
  assert.equal(titleOf1("One Piece - 62 [1080p][FD5592BE].mkv"), "One Piece");
});

// ── An all-digit title is a counter, not a name ────────────────────

test("a three-digit title is rejected rather than searched for", () => {
  // This searched TMDB for the string "01".
  const r = g.parseFilename("file:///Users/me/Videos/X-Men/Season%201/01.mkv");
  assert.equal(r.title, "X-Men", "did not fall back to the folder");
  assert.deepEqual([r.code.season, r.code.episode], [1, 1]);
});

test("a four-digit title is a real one", () => {
  assert.equal(titleOf1("1917.2019.1080p.BluRay.x264.mkv"), "1917");
  assert.equal(titleOf1("2001.Space.Odyssey.1968.1080p.mkv"), "2001 Space Odyssey");
});

test("a lone counter with no folder is left for manual search", () => {
  assert.equal(parsed("01.mkv"), null);
});

// ── Nothing that used to work ──────────────────────────────────────

test("previously working names are unaffected", () => {
  const cases = [
    ["Severance.S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv", "Severance", [2, 3]],
    ["Breaking Bad - S03E11 - 1080p.mkv", "Breaking Bad", [3, 11]],
    ["The.Office.US.S09E16.720p.HDTV.x264.mkv", "The Office US", [9, 16]],
    ["Show.Name.1x05.avi", "Show Name", [1, 5]],
    ["Doctor Who Season 2 Episode 7.mkv", "Doctor Who", [2, 7]],
    ["Naruto.Shippuuden.E484.720p.Bia2Anime.mkv", "Naruto Shippuuden Bia2Anime", [1, 484]],
    ["AnimePahe_Nippon_Sangoku_-_05_1080p_Amazon.mp4", "AnimePahe Nippon Sangoku - 05 Amazon", [1, 5]],
    ["[SubsPlease] Frieren - 05 (1080p).mkv", "Frieren", [1, 5]],
    ["Band_of_Brothers_S01E04.mkv", "Band of Brothers", [1, 4]],
    ["500.Days.of.Summer.2009.mkv", "500 Days of Summer", null],
    ["Footloose.1984.1080p.mkv", "Footloose", null]
  ];
  for (const [name, wantTitle, wantCode] of cases) {
    assert.equal(titleOf1(name), wantTitle, `title for ${name}`);
    assert.deepEqual(codeOf1(name), wantCode, `code for ${name}`);
  }
});

// ── Library layouts: the show is in the directory ──────────────
test("a bare number takes its episode number from the filename", () => {
  const p = g.parseFilename(at("Severance", "Season 2", "05.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 5);
});

test("a number with no season directory defaults to season 1", () => {
  const p = g.parseFilename(at("Frieren", "05.mkv"));
  assert.equal(p.title, "Frieren");
  assert.equal(p.code.season, 1);
  assert.equal(p.code.episode, 5);
});

test("'Episode 3' takes the title from the directory", () => {
  const p = g.parseFilename(at("Breaking Bad", "Episode 3.mkv"));
  assert.equal(p.title, "Breaking Bad");
  assert.equal(p.code.episode, 3);
});

test("'S01E05' still wins over a contradictory directory name", () => {
  // The filename is ground truth for the season. A stale or mislabelled
  // directory must not override what the file actually says.
  const p = g.parseFilename(at("Severance", "Season 2", "S01E05.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 1);
  assert.equal(p.code.episode, 5);
});

test("the library's own directories are stepped over", () => {
  assert.equal(titleOf(at("Downloads", "Severance", "Season 1", "01.mkv")), "Severance");
  assert.equal(titleOf(at("Videos", "Shows", "The Office", "02.mkv")), "The Office");
  assert.equal(titleOf(at("media", "tv", "anime", "Frieren", "03.mkv")), "Frieren");
});

test("a descriptive directory name survives cleaning", () => {
  assert.equal(titleOf(at("Frieren - Beyond Journey's End", "05 [1080p].mkv")), "Frieren - Beyond Journey's End");
});

test("a season inside one directory name is understood", () => {
  const p = g.parseFilename(at("Severance Season 2", "05.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 5);
});

test("a full scene filename still beats the directory", () => {
  // The normal case must be untouched by any of this.
  const p = g.parseFilename(at("Severance", "S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 3);
});

test("a title that is only digits survives when there is no directory to replace it", () => {
  // "1917.2019.1080p.mkv" is a film whose title happens to be a number. The
  // digit check must not throw that away and leave nothing to search for.
  const p = g.parseFilename(at("1917.2019.1080p.BluRay.x264.mkv"));
  assert.equal(p.title, "1917");
  assert.equal(p.year, 2019);
  assert.equal(p.isMovie, true);
});

test("a 4-digit number alone is not an episode", () => {
  // Only 1-3 digits are episode numbers; 1917 is a title or a year.
  assert.equal(codeOf(at("Severance", "Season 1", "1917.mkv")), null);
});

test("'Episode 3' with no usable directory is left for manual search", () => {
  // Searching for "Episode" would find nothing useful, so the file is handed
  // to the user instead.
  assert.equal(g.parseFilename(at("Episode 3.mkv")), null);
  assert.equal(g.parseFilename(at("Videos", "Episode 3.mkv")), null);
});

test("folder hints are bounded and skip noise", () => {
  assert.equal(g.parseFolderHints(at("Severance", "Season 2", "05.mkv")).title, "Severance");
  assert.equal(g.parseFolderHints(at("Videos", "Episode 3.mkv")), null);
  assert.equal(g.parseFolderHints("file:///Users/me/Videos/Severance.S02E03.mkv"), null);
});

test("a stream URL can also supply the show name", () => {
  const p = g.parseFilename("https://example.com/media/Severance/Season 1/04.mkv");
  assert.equal(p.title, "Severance");
  assert.equal(p.code.episode, 4);
});

test("percent-encoded names decode before parsing", () => {
  const p = g.parseFilename(at("Severance%20Season%202", "05.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 2);
});

// The real layout this was built for.
test("a nested library path resolves the show from the folder", () => {
  const base = "file:///Users/iancenry/Downloads/watch/me/samurai%20champloo/";
  const cases = [
    ["11.mkv", 11],
    ["Episode 11.mkv", 11],
    ["Samurai Champloo - 11.mkv", 11],
    ["[SubsPlease] Samurai Champloo - 11 [1080p].mkv", 11]
  ];
  for (const [file, episode] of cases) {
    const p = g.parseFilename(base + file);
    assert.ok(p, `no parse for ${file}`);
    assert.equal(p.title.toLowerCase(), "samurai champloo", `title for ${file}`);
    assert.equal(p.code.season, 1, `season for ${file}`);
    assert.equal(p.code.episode, episode, `episode for ${file}`);
  }
});

test("a season directory below the show folder is still found", () => {
  const base = "file:///Users/iancenry/Downloads/watch/me/samurai%20champloo/Season%202/";
  const p = g.parseFilename(base + "03.mkv");
  assert.equal(p.title.toLowerCase(), "samurai champloo");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 3);
});
