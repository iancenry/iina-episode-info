import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar } from "./helpers/harness.mjs";

// One shared load is enough: the parser is pure and holds no state between
// calls, and rebuilding the context per test would be pure overhead.
const h = loadSidebar();
const { parseFilename, parseEpisodeCode, cleanTitle, titleCandidates, pickLogo } = h.global;

function parsed(name) {
  return parseFilename("file:///Users/me/Videos/" + name);
}

// Objects built inside the vm context carry that realm's Object.prototype, so
// deepStrictEqual against a host literal always fails on the prototype. Compare
// the fields instead.
function assertCode(r, season, episode, extra = null) {
  assert.ok(r, "expected an episode code, got null");
  assert.equal(r.season, season, "season");
  assert.equal(r.episode, episode, "episode");
  assert.equal(r.extra, extra, "extra");
}

// ── The harness itself ────────────────────────────────────────────────
test("harness exposes the parser", () => {
  for (const fn of [parseFilename, parseEpisodeCode, cleanTitle, titleCandidates, pickLogo]) {
    assert.equal(typeof fn, "function");
  }
});

// ── parseEpisodeCode ─────────────────────────────────────────────────
test("parses the common release conventions", () => {
  assertCode(parseEpisodeCode("Severance S02E03"), 2, 3);
  assertCode(parseEpisodeCode("Breaking Bad - S03E11 - 1080p"), 3, 11);
  assertCode(parseEpisodeCode("The Office US S09E16 720p HDTV"), 9, 16);
  assertCode(parseEpisodeCode("Show Name 1x05"), 1, 5);
  assertCode(parseEpisodeCode("Doctor Who Season 2 Episode 7"), 2, 7);
  assertCode(parseEpisodeCode("Show Name S01.E02"), 1, 2);
});

test("parses multi-episode packs", () => {
  assertCode(parseEpisodeCode("Show Name S01E02E03"), 1, 2, 3);
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
  assert.equal(parseEpisodeCode("The Matrix 1999"), null);
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
  const c = titleCandidates("Breaking Bad");
  assert.equal(c[0], "Breaking Bad");
  assert.equal(c[1], "Breaking");
  assert.ok(!c.includes("The"));
  assert.ok(!titleCandidates("The Office").includes("The"));
});

test("ladder de-duplicates", () => {
  const c = titleCandidates("Show Name");
  assert.equal(new Set(c).size, c.length);
});

// ── pickLogo ─────────────────────────────────────────────────────────
test("rejects squarer-than-2.5:1 artwork and non-English logos", () => {
  assert.equal(pickLogo({ logos: [{ file_path: "/p.jpg", aspect_ratio: 1.0, iso_639_1: "en" }] }), "");
  assert.equal(pickLogo({ logos: [{ file_path: "/p.jpg", aspect_ratio: 6, iso_639_1: "he" }] }), "");
});

test("prefers a wide English wordmark", () => {
  const url = pickLogo({
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
  // with a high vote average does beat a solid 4:1 one. Reported, not fixed —
  // see NOTES.md.
  const url = pickLogo({
    logos: [
      { file_path: "/solid.jpg", aspect_ratio: 4.0, iso_639_1: "en", vote_average: 5.0 },
      { file_path: "/hairline.jpg", aspect_ratio: 8.0, iso_639_1: "en", vote_average: 7.9 }
    ]
  });
  assert.equal(url, "https://image.tmdb.org/t/p/w780/hairline.jpg");
});

test("no logos at all is not an error", () => {
  assert.equal(pickLogo({}), "");
  assert.equal(pickLogo(null), "");
});