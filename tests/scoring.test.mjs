import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSidebar } from "./helpers/harness.mjs";

const g = loadSidebar().global;
const score = g.titleScore;
const hints = g.parseFolderHints;

// ── titleScore stays inside its documented range ─────────────────────

test("the score never leaves 0 to 1", () => {
  // A repeated word used to be counted twice, so the overlap ratio could
  // exceed 1. A negative length difference turned the prefix penalty into a
  // bonus, which also exceeded 1.
  const pairs = [
    ["One Piece", "Piece One One"],
    ["Dark Matter", "Dark"],
    ["Dark", "Dark Matter"],
    ["a", "a a a a"],
    ["Doctor", "Doctor Who Doctor"],
    ["a a a", "a"],
    ["Show Name Extra Words Here", "Show Name"]
  ];
  for (const [q, n] of pairs) {
    const v = score(q, n);
    assert.ok(v >= 0 && v <= 1, `score(${q}, ${n}) = ${v}, outside 0..1`);
  }
});

test("a word prefix is a match, a string prefix is not", () => {
  // The ladder sends shorter prefixes, so a candidate being a prefix of the
  // real title is the design working.
  assert.ok(score("Severance", "Severance: The Office") >= 0.6);
  assert.ok(score("Dark", "Dark Matter") >= 0.6);
  // Sharing a few letters is not sharing a name.
  assert.ok(score("Man", "Maniac Mansion") < 0.3);
  assert.ok(score("Ran", "Rangers") < 0.3);
});

test("the whole candidate must match, not just its first word", () => {
  // Matching on one token made this a 0.83 match, even though the second word
  // disagrees outright.
  assert.ok(score("One Pace", "One Piece: Clockwork") < 0.6,
    `scored ${score("One Pace", "One Piece: Clockwork")}`);
  // …while the correctly spelled short name still lands.
  assert.ok(score("One Pace", "One Piece") >= 0.6,
    `scored ${score("One Pace", "One Piece")}`);
});

test("a misspelt name still matches on character closeness", () => {
  // Fansubs spell series slightly wrong; token overlap alone scores this 0.33
  // and would send the ladder past the right answer.
  assert.ok(score("One Pace", "One Piece") >= 0.6);
});

test("a longer result is penalised, a shorter one is not rewarded", () => {
  const short = score("Severance", "Severance: The Office");
  const long = score("Severance: The Office", "Severance");
  assert.ok(short > long, `penalty ran the wrong way: ${short} vs ${long}`);
});

test("empty and unrelated input score zero", () => {
  assert.equal(score("", "Anything"), 0);
  assert.equal(score("Anything", ""), 0);
  // Unrelated names still pick up a little character-level similarity, so this
  // asserts "low", not "zero".
  assert.ok(score("Zzzz Qqqq", "Totally Different") < 0.2);
});

// ── Folder names ───────────────────────────────────────────────────

test("library sub-folders below the show do not become the title", () => {
  // The walk stops at the closest real-looking name, so these used to win over
  // the show folder sitting one level above them.
  const sub = ["Specials", "Extras", "Featurettes", "Bonus", "Trailers",
               "Behind.The.Scenes", "Samples", "Omake", "Interviews"];
  for (const s of sub) {
    const h = hints("file:///Users/me/Videos/Severance/" + s + "/01.mkv");
    assert.equal(h, null, `"${s}" was treated as a show name`);
  }
  const ok = hints("file:///Users/me/Videos/Severance/Season 1/01.mkv");
  assert.equal(ok.title, "Severance", "the show folder itself should still win");
});

test("a German season folder is still understood", () => {
  const h = hints("file:///Users/me/Videos/Serien/Staffel%202/03.mkv");
  assert.equal(h.title, "Serien");
  assert.equal(h.season, 2);
});

// ── Checksums vs real words ─────────────────────────────────────────

test("a CRC32 bracket is skipped but a real word is not", () => {
  // Every English word made only of the letters a-f was being thrown away.
  const cases = [
    ["[FD5592BE]", false], ["[D5E4A3]", false], ["[BEEF]", true],
    ["[Decade]", true], ["[Facade]", true], ["[Beaded]", true], ["[Defaced]", true]
  ];
  for (const [group, wantKept] of cases) {
    const t = g.bracketTitles("Show Name " + group + " - 05.mkv");
    const kept = t.strong.concat(t.weak).some((x) => x.indexOf(group.slice(1, -1)) === 0);
    assert.equal(kept, wantKept, `${group}: ${JSON.stringify(t)}`);
  }
});

// ── Resolution pairs are not episode numbers ────────────────────────

test("a bracketed resolution pair is not an absolute episode number", () => {
  // Reading "[1080-1920]" as episode 1080 also suppressed the filename's own
  // real episode code.
  for (const group of ["[1080-1920]", "[1920-1080]", "[576-1080]", "[720-1440]"]) {
    assert.equal(g.absoluteFromBrackets("Show " + group + " - 05.mkv"), null,
      `${group} was read as an episode`);
  }
  // A genuine range is still one.
  assert.equal(g.absoluteFromBrackets("Show [1062-1063].mkv"), 1062);
  assert.equal(g.absoluteFromBrackets("Show [1000].mkv"), 1000);
  // A pair that is not 16:9-shaped is not a resolution.
  assert.equal(g.absoluteFromBrackets("Show [1062-1063].mkv"), 1062);
});