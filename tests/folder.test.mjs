import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar } from "./helpers/harness.mjs";

const h = loadSidebar();
const { parseFilename, parseFolderHints } = h.global;

// The library cases that motivated this: the show is in the directory and the
// filename is nothing but a number.
function at(...parts) {
  return "file:///Users/me/Videos/" + parts.join("/");
}

function titleOf(url) {
  const p = parseFilename(url);
  return p ? p.title : null;
}

function codeOf(url) {
  const p = parseFilename(url);
  return p && p.code ? { season: p.code.season, episode: p.code.episode } : null;
}

test("a bare number takes its episode number from the filename", () => {
  const p = parseFilename(at("Severance", "Season 2", "05.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 5);
});

test("a number with no season directory defaults to season 1", () => {
  const p = parseFilename(at("Frieren", "05.mkv"));
  assert.equal(p.title, "Frieren");
  assert.equal(p.code.season, 1);
  assert.equal(p.code.episode, 5);
});

test("'Episode 3' takes the title from the directory", () => {
  const p = parseFilename(at("Breaking Bad", "Episode 3.mkv"));
  assert.equal(p.title, "Breaking Bad");
  assert.equal(p.code.episode, 3);
});

test("'S01E05' still wins over a contradictory directory name", () => {
  // The filename is ground truth for the season. A stale or mislabelled
  // directory must not override what the file actually says.
  const p = parseFilename(at("Severance", "Season 2", "S01E05.mkv"));
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
  const p = parseFilename(at("Severance Season 2", "05.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 5);
});

test("a full scene filename still beats the directory", () => {
  // The normal case must be untouched by any of this.
  const p = parseFilename(at("Severance", "S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv"));
  assert.equal(p.title, "Severance");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 3);
});

test("a title that is only digits survives when there is no directory to replace it", () => {
  // "1917.2019.1080p.mkv" is a film whose title happens to be a number. The
  // digit check must not throw that away and leave nothing to search for.
  const p = parseFilename(at("1917.2019.1080p.BluRay.x264.mkv"));
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
  assert.equal(parseFilename(at("Episode 3.mkv")), null);
  assert.equal(parseFilename(at("Videos", "Episode 3.mkv")), null);
});

test("folder hints are bounded and skip noise", () => {
  assert.equal(parseFolderHints(at("Severance", "Season 2", "05.mkv")).title, "Severance");
  assert.equal(parseFolderHints(at("Videos", "Episode 3.mkv")), null);
  assert.equal(parseFolderHints("file:///Users/me/Videos/Severance.S02E03.mkv"), null);
});

test("a stream URL can also supply the show name", () => {
  const p = parseFilename("https://example.com/media/Severance/Season 1/04.mkv");
  assert.equal(p.title, "Severance");
  assert.equal(p.code.episode, 4);
});

test("percent-encoded names decode before parsing", () => {
  const p = parseFilename(at("Severance%20Season%202", "05.mkv"));
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
    const p = parseFilename(base + file);
    assert.ok(p, `no parse for ${file}`);
    assert.equal(p.title.toLowerCase(), "samurai champloo", `title for ${file}`);
    assert.equal(p.code.season, 1, `season for ${file}`);
    assert.equal(p.code.episode, episode, `episode for ${file}`);
  }
});

test("a season directory below the show folder is still found", () => {
  const base = "file:///Users/iancenry/Downloads/watch/me/samurai%20champloo/Season%202/";
  const p = parseFilename(base + "03.mkv");
  assert.equal(p.title.toLowerCase(), "samurai champloo");
  assert.equal(p.code.season, 2);
  assert.equal(p.code.episode, 3);
});