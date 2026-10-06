import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMain, settle } from "./helpers/main-harness.mjs";
import { loadSidebar } from "./helpers/harness.mjs";
import { readRepo } from "./helpers/extract.mjs";

// The scene-content-warning machinery: the pure conversions and filters, then
// the wiring IINA drives. The rating fixtures are real shapes from the Phase 0
// spike against www.doesthedogdie.com/api/v3: positions are H:M:S split across
// three fields with -1 meaning "none", index1/index2 are season/episode (-1/-1
// for a film), cueDescription appears as both null and "", the /topics list
// omits ids ratings still reference, and — the one that produced a false cue —
// a "no" vote can carry a timestamp.

const DDD = "https://www.doesthedogdie.com/api/v3";
const DDD_ITEMS_1399 = DDD + "/items?tmdb=1399";
const DDD_RATINGS_GOT = DDD + "/items/678166/ratings";
const DDD_DETAIL_GOT = DDD + "/items/678166";
const DDD_ITEMS_550 = DDD + "/items?tmdb=550";
const DDD_RATINGS_FILM = DDD + "/items/999/ratings";
const DDD_DETAIL_FILM = DDD + "/items/999";
const DDD_TOPICS = DDD + "/topics";
const DDD_CATS = DDD + "/topiccategories";
const DDD_SUPERS = DDD + "/topicsupercategories";

const TOPICS = [
  { id: 153, name: "a dog dies", topicCategoryId: 56 },
  { id: 197, name: "there is sexual content", topicCategoryId: 51 },
  { id: 201, name: "someone is naked", topicCategoryId: 51 },
  { id: 186, name: "a cat dies", topicCategoryId: 56 }
  // 252 is deliberately absent: real ratings reference ids the list omits.
];
const CATS = [
  { id: 56, name: "Animal Injury or Death", topicSuperCategoryId: 54 },
  { id: 51, name: "Sexual Content/Assault", topicSuperCategoryId: 51 }
];
const SUPERS = [
  { id: 54, name: "Animals", shortName: "Animals" },
  { id: 51, name: "Sexual Content/Assault", shortName: "Sex" }
];

const RATINGS = [
  // S1E2 at 53:54 with a safe position 6 seconds later. Contested in the
  // stats below, so an Auto category degrades to the manual offer.
  { topicId: 153, yes: 1, no: 0, index1: 1, index2: 2, position1: 0, position2: 53, position3: 54,
    safePosition1: 0, safePosition2: 54, safePosition3: 0, cueDescription: "", triggerDescription: "A dog is hit by a car." },
  // S1E2 at 10:00 on a topic /topics omits; the label must come from the stats.
  { topicId: 252, yes: 1, no: 0, index1: 1, index2: 2, position1: 0, position2: 10, position3: 0,
    safePosition1: 0, safePosition2: 10, safePosition3: 20, cueDescription: "", triggerDescription: "" },
  // S3E1 with no safe position: warning only.
  { topicId: 201, yes: 1, no: 0, index1: 3, index2: 1, position1: 0, position2: 36, position3: 40,
    safePosition1: -1, safePosition2: -1, safePosition3: -1, cueDescription: null, triggerDescription: "Mystique is nude." },
  // The X2 lesson: a no vote with a timestamp is not a scene.
  { topicId: 186, yes: 0, no: 1, index1: -1, index2: -1, position1: 0, position2: 52, position3: 39,
    safePosition1: -1, safePosition2: -1, safePosition3: -1, cueDescription: "",
    triggerDescription: "No. A cat startles Logan but the cat isn't hurt." },
  // An untimed show-level yes with a description: the sidebar's flag, and the
  // description source for the topic.
  { topicId: 201, yes: 1, no: 0, index1: -1, index2: -1, position1: -1, position2: -1, position3: -1,
    safePosition1: -1, safePosition2: -1, safePosition3: -1, cueDescription: "",
    triggerDescription: "Mystique drugs a guard's drink." }
];
const TV_STATS = {
  153: { yes: 3, no: 8, name: "a dog dies" },
  197: { yes: 8, no: 0, name: "there is sexual content" },
  201: { yes: 8, no: 0, name: "someone is naked" },
  252: { yes: 1, no: 0, name: "a dead animal" },
  186: { yes: 0, no: 2, name: "a cat dies" }
};

const FILM_RATINGS = [
  // A timestamped yes with a safe position, strong in the stats: the scene an
  // Auto category may skip.
  { topicId: 197, yes: 1, no: 0, index1: -1, index2: -1, position1: 0, position2: 10, position3: 5,
    safePosition1: 0, safePosition2: 10, safePosition3: 20, cueDescription: "", triggerDescription: "" },
  // The real X2 pattern: the sexual-content vote carries the description but
  // no timestamp, and it is contested.
  { topicId: 201, yes: 1, no: 0, index1: -1, index2: -1, position1: -1, position2: -1, position3: -1,
    safePosition1: -1, safePosition2: -1, safePosition3: -1, cueDescription: "",
    triggerDescription: "Mystique drugs a guard's drink. He passes out while making out with her in a bathroom stall." },
  // And the false cue: a no vote with a timestamp.
  { topicId: 186, yes: 0, no: 1, index1: -1, index2: -1, position1: 0, position2: 52, position3: 39,
    safePosition1: -1, safePosition2: -1, safePosition3: -1, cueDescription: "",
    triggerDescription: "No. A cat startles Logan but the cat isn't hurt." }
];
const FILM_STATS = {
  197: { yes: 8, no: 0, name: "there is sexual content" },
  201: { yes: 8, no: 4, name: "someone is naked" },
  252: { yes: 3, no: 7, name: "there's a dead animal" },
  186: { yes: 0, no: 2, name: "a cat dies" }
};

function statsRows(m) {
  return Object.keys(m).map(function(k) {
    return { topicId: Number(k), yesSum: m[k].yes, noSum: m[k].no, topicName: m[k].name };
  });
}

function boot() {
  const m = loadMain();
  return { m, g: m.global };
}

// ── hmsToSec ────────────────────────────────────────────────────────

test("H:M:S converts to seconds", () => {
  const { g } = boot();
  assert.equal(g.hmsToSec(0, 36, 40), 2200, "0:36:40");
  assert.equal(g.hmsToSec(1, 2, 5), 3725, "1:02:05");
  assert.equal(g.hmsToSec(0, 0, 0), 0);
  assert.equal(g.hmsToSec(0, 15, null), 900, "a null seconds field is not NaN seconds");
});

test("negative and missing H:M:S parts are clamped, not subtracted", () => {
  const { g } = boot();
  assert.equal(g.hmsToSec(-1, -1, -1), 0);
  assert.equal(g.hmsToSec(null, null, null), 0);
  assert.equal(g.hmsToSec(0, -1, 0), 0);
});

// ── dddTimestamped ─────────────────────────────────────────────────

test("a rating only counts as timestamped when position1 is a real hour", () => {
  const { g } = boot();
  assert.equal(g.dddTimestamped({ position1: 0 }), true, "0:00:00 is a timestamp");
  assert.equal(g.dddTimestamped({ position1: 1 }), true);
  assert.equal(g.dddTimestamped({ position1: -1 }), false);
  assert.equal(g.dddTimestamped({ position1: null }), false);
  assert.equal(g.dddTimestamped({}), false);
  assert.equal(g.dddTimestamped(null), false);
});

// ── safeSceneSec ───────────────────────────────────────────────────

test("a safe position is only kept when it lands after the scene", () => {
  const { g } = boot();
  assert.equal(g.safeSceneSec({ safePosition1: 0, safePosition2: 54, safePosition3: 0 }, 3234), 3240);
  assert.equal(g.safeSceneSec({ safePosition1: -1, safePosition2: -1, safePosition3: -1 }, 2200), null,
    "the -1 sentinel was read as a target");
  assert.equal(g.safeSceneSec({ safePosition1: 0, safePosition2: 0, safePosition3: 0 }, 0), null,
    "a safe position equal to the scene seeks nowhere");
  assert.equal(g.safeSceneSec({ safePosition1: 0, safePosition2: 5, safePosition3: 0 }, 300), null,
    "a safe position before the scene was accepted");
});

// ── scenesForEpisode ───────────────────────────────────────────────

test("only this episode's yes-voted timestamps survive, in time order", () => {
  const { g } = boot();
  const out = g.scenesForEpisode(RATINGS, 1, 2, false);
  assert.equal(out.length, 2, `expected S1E2's two timestamps, got ${JSON.stringify(out)}`);
  // Joined rather than deep-compared: the array is built inside the vm realm.
  assert.equal(out.map((s) => s.topicId).join(","), "252,153", "not in time order");
  assert.equal(out[0].start, 600);
  assert.equal(out[1].start, 3234);
  assert.equal(out[1].safe, 3240);
});

test("a no vote with a timestamp is not a scene", () => {
  // The exact X2 row that produced the false "a cat dies at 52:39" cue: the
  // voter's own comment says the cat is not hurt.
  const { g } = boot();
  const out = g.scenesForEpisode(RATINGS, undefined, undefined, true);
  assert.equal(out.length, 0, `a no vote became a scene: ${JSON.stringify(out)}`);
});

test("a film keeps its -1-indexed timestamps, and its description comes through", () => {
  const { g } = boot();
  const out = g.scenesForEpisode(FILM_RATINGS, undefined, undefined, true);
  assert.equal(out.length, 1, `expected the -1 row only, got ${JSON.stringify(out)}`);
  assert.equal(out[0].topicId, 197);
  assert.equal(out[0].start, 605);
  assert.equal(out[0].safe, 620);
});

// ── mergeSceneCues ─────────────────────────────────────────────────

test("moments a few seconds apart collapse into one cue", () => {
  const { g } = boot();
  const merged = g.mergeSceneCues([
    { topicId: 1, label: "a car crash", start: 100, safe: 130, cue: "", desc: "", action: "skip", strong: false },
    { topicId: 2, label: "someone is naked", start: 105, safe: 140, cue: "a car swerves", desc: "", action: "skip", strong: false }
  ]);
  assert.equal(merged.length, 1, "two topics on the same moment became two cards");
  assert.equal(merged[0].label, "a car crash · someone is naked");
  assert.equal(merged[0].safe, 140, "the later safe position clears both scenes");
  assert.equal(merged[0].cue, "a car swerves");
});

test("the stronger category action wins a merged moment", () => {
  // A moment shared by a Warn topic and an Auto topic must not auto-skip
  // silently losing its warning, and an Auto topic must not be weakened by
  // its neighbour.
  const { g } = boot();
  const merged = g.mergeSceneCues([
    { topicId: 1, label: "an animal dies", start: 100, safe: 130, cue: "", desc: "", action: "warn", strong: false },
    { topicId: 2, label: "someone is naked", start: 103, safe: 140, cue: "", desc: "", action: "auto", strong: true }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].action, "auto");
  assert.equal(merged[0].strong, true);
});

test("distant moments stay separate and merging nothing yields nothing", () => {
  const { g } = boot();
  const merged = g.mergeSceneCues([
    { topicId: 1, label: "a", start: 100, safe: null, cue: "", desc: "" },
    { topicId: 2, label: "b", start: 300, safe: null, cue: "", desc: "" }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(g.mergeSceneCues([]).length, 0);
  assert.equal(g.mergeSceneCues(null).length, 0);
});

// ── The topic/category index ───────────────────────────────────────

test("the topic index maps topics through their category to a supercategory", () => {
  const { g } = boot();
  const index = g.buildTopicIndex(TOPICS, CATS, SUPERS);
  assert.equal(index.topics[153].name, "a dog dies");
  assert.equal(index.topics[153].superId, 54);
  assert.equal(index.topics[153].superName, "Animals");
  assert.equal(index.topics[197].superName, "Sexual Content/Assault");
});

test("a topic the list omits falls back to the stats name, then to Other", () => {
  const { g } = boot();
  const index = g.buildTopicIndex(TOPICS, CATS, SUPERS);
  const missing = g.topicInfo(252, index, { 252: { yes: 1, no: 0, name: "a dead animal" } });
  assert.equal(missing.name, "a dead animal", "the stats' own topicName was not used");
  assert.equal(missing.superName, "Other");
  const gone = g.topicInfo(999, index, {});
  assert.equal(gone.name, "content warning");
});

// ── flagsForTitle ──────────────────────────────────────────────────

test("untimed yes topics become flags, with their descriptions", () => {
  const { g } = boot();
  const flags = g.flagsForTitle(RATINGS, TV_STATS, 1, 2, false);
  const byTopic = {};
  flags.forEach((f) => { byTopic[f.topicId] = f; });
  const sexual = byTopic[201];
  assert.ok(sexual, `the sexual flag is missing: ${JSON.stringify(flags)}`);
  assert.equal(sexual.yes, 8, "the stats' vote totals were not used");
  assert.equal(sexual.desc, "Mystique drugs a guard's drink.");
  assert.equal(byTopic[153], undefined, "a topic already timed for this title was repeated as a flag");
  assert.equal(byTopic[252], undefined, "a topic already timed for this title was repeated as a flag");
  assert.equal(byTopic[186], undefined, "a topic the community voted no on was flagged");
});

// ── Subtitle tag scanning ──────────────────────────────────────────

test("SRT, WebVTT and ASS all parse to cues", () => {
  const { g } = boot();
  const srt = "1\n00:00:46,270 --> 00:00:46,900\n[Moaning]\n\n2\n00:00:46,340 --> 00:00:47,100\n[Both moaning]\n";
  const a = g.parseSubtitleText(srt);
  assert.equal(a.length, 2);
  assert.ok(Math.abs(a[0].start - 46.27) < 0.001, `srt start was ${a[0].start}`);

  const vtt = "WEBVTT\n\n00:01:02.500 --> 00:01:03.000 align:middle\n(whimpering)\n";
  const b = g.parseSubtitleText(vtt);
  assert.equal(b.length, 1, `vtt did not parse: ${JSON.stringify(b)}`);
  assert.ok(Math.abs(b[0].start - 62.5) < 0.001);

  const ass = "[Events]\nDialogue: 0,0:00:41.12,0:00:43.50,Default,,0,0,0,,{\\an8}[screaming]\\Nhelp me\n";
  const c = g.parseSubtitleText(ass);
  assert.equal(c.length, 1, `ass did not parse: ${JSON.stringify(c)}`);
  assert.ok(Math.abs(c[0].start - 41.12) < 0.001, `ass start was ${c[0].start}`);
  assert.match(c[0].text, /screaming/);
  assert.doesNotMatch(c[0].text, /\{/, "ASS override tags survived");
  assert.equal(g.parseSubtitleText(null).length, 0);
  assert.equal(g.parseSubtitleText("").length, 0);
});

test("the lexicon maps sexual SDH tags and ignores the rest", () => {
  const { g } = boot();
  const cues = [
    { start: 100, end: 101, text: "[Moaning]" },
    { start: 104, end: 108, text: "[Both moaning]" },
    { start: 130, end: 131, text: "[Storm]" },          // a name, not content
    { start: 200, end: 201, text: "(gunshot)" },        // non-sexual: ignored
    { start: 260, end: 261, text: "[kissing]" },
    { start: 300, end: 301, text: "[screaming]" },      // non-sexual: ignored
    { start: 500, end: 501, text: "moaning" }           // no annotation
  ];
  const p = g.subtitleProposals(cues);
  assert.equal(p.length, 2, `wrong proposals: ${JSON.stringify(p)}`);
  assert.equal(p[0].label, "moaning");
  assert.equal(p[0].start, 100);
  assert.equal(p[0].safe, 113, "the run did not extend and pad from 108");
  assert.equal(p[1].label, "kissing");
});

test("a proposal extends through the scene until a silence gap", () => {
  const { g } = boot();
  const cues = [
    { start: 10, end: 12, text: "[Moaning]" },
    { start: 13, end: 15, text: "dialogue" },
    { start: 16, end: 18, text: "more dialogue" },
    { start: 30, end: 31, text: "next scene" }        // a 12s gap: the cut
  ];
  const p = g.subtitleProposals(cues);
  assert.equal(p.length, 1);
  assert.equal(p[0].start, 10);
  assert.equal(p[0].safe, 23, `the run did not extend to the gap plus pad: ${p[0].safe}`);
});

test("the extension is capped so one long sequence cannot swallow the film", () => {
  const { g } = boot();
  const cues = [];
  for (let t = 0; t < 400; t += 5) {
    cues.push({ start: t, end: t + 4, text: t === 0 ? "[Moaning]" : "dialogue" });
  }
  const p = g.subtitleProposals(cues);
  assert.equal(p.length, 1);
  assert.ok(p[0].safe - p[0].start <= 130, `proposal ran ${p[0].safe - p[0].start}s`);
});

// ── Action defaults and cue modes ──────────────────────────────────

test("an unset or unknown category action defaults to skip", () => {
  const m = loadMain();
  assert.equal(m.global.dddCatAction(54), "skip");
  m.global.dddCatActions = { 54: "off", 55: "nonsense" };
  assert.equal(m.global.dddCatAction(54), "off");
  assert.equal(m.global.dddCatAction(55), "skip", "an unknown action was trusted");
});

test("cueModeFor degrades auto when the community disagrees or no safe exists", () => {
  const m = loadMain();
  const g = m.global;
  assert.equal(g.cueModeFor({ action: "warn", safe: 100, strong: true }), "warn");
  assert.equal(g.cueModeFor({ action: "skip", safe: 100, strong: true }), "skip");
  assert.equal(g.cueModeFor({ action: "skip", safe: null, strong: true }), "warn", "no target, no offer");
  assert.equal(g.cueModeFor({ action: "auto", safe: 100, strong: false }), "skip",
    "an auto category with a contested topic was allowed to auto-skip");
  assert.equal(g.cueModeFor({ action: "auto", safe: 100, strong: true }), "auto");
  assert.equal(g.cueModeFor({ action: "auto", safe: null, strong: true }), "warn");
  assert.equal(g.cueModeFor({ action: "auto", safe: 100, strong: true, cancelled: true }), "skip",
    "a cancelled auto scene still offered to auto-skip");
});

// ── The lookup, driven the way IINA drives it ──────────────────────

const EPISODE = {
  isMovie: false, showTitle: "Game of Thrones", epTitle: "The Kingsroad", code: "S01E02",
  airDate: "", rating: "", overview: "", posterUrl: "", logoUrl: "",
  context: "", tmdbId: "1399", season: 1, episode: 2
};
const FILM = Object.assign({}, EPISODE, {
  isMovie: true, showTitle: "X2", epTitle: "X2", code: "",
  tmdbId: "550", season: undefined, episode: undefined
});

function tvRoutes() {
  return {
    [DDD_ITEMS_1399]: { statusCode: 200, data: [{ id: 678166, tmdbId: 1399 }] },
    [DDD_RATINGS_GOT]: { statusCode: 200, data: RATINGS },
    [DDD_DETAIL_GOT]: { statusCode: 200, data: { topicItemStats: statsRows(TV_STATS) } },
    [DDD_TOPICS]: { statusCode: 200, data: TOPICS },
    [DDD_CATS]: { statusCode: 200, data: CATS },
    [DDD_SUPERS]: { statusCode: 200, data: SUPERS }
  };
}
function filmRoutes() {
  return {
    [DDD_ITEMS_550]: { statusCode: 200, data: [{ id: 999, tmdbId: 550 }] },
    [DDD_RATINGS_FILM]: { statusCode: 200, data: FILM_RATINGS },
    [DDD_DETAIL_FILM]: { statusCode: 200, data: { topicItemStats: statsRows(FILM_STATS) } },
    [DDD_TOPICS]: { statusCode: 200, data: TOPICS },
    [DDD_CATS]: { statusCode: 200, data: CATS },
    [DDD_SUPERS]: { statusCode: 200, data: SUPERS }
  };
}

function dddSession(http, opts = {}) {
  const m = loadMain(Object.assign({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    mpvProps: { duration: 4000 },
    http: http || {}
  }, opts));
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddKey", { key: "K" });
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  return m;
}

function dddCalls(m) {
  return m.sink.httpCalls.filter((u) => u.indexOf("doesthedogdie.com") !== -1);
}

test("without a key nothing is fetched and nothing is claimed", () => {
  const m = loadMain({ status: { paused: false, duration: 4000, url: "file:///v/a.mkv" } });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });   // no key pushed
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  assert.equal(dddCalls(m).length, 0, "the feature queried DDD without a key");
  assert.equal(m.global.scenes.length, 0);
  // An empty answer, not silence: the sidebar's list is cleared rather than
  // left showing the previous episode's scenes.
  assert.equal(m.posted("sidebar", "scenesResult").length, 1);
  assert.equal(m.posted("sidebar", "scenesResult").pop().count, 0);
});

test("a TV episode installs its scenes and flags, labelled from the index", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  assert.equal(m.global.scenes.length, 2, `fixture produced the wrong scenes: ${JSON.stringify(m.global.scenes)}`);
  assert.equal(m.global.scenes[0].label, "a dead animal", "the missing topic did not fall back to the stats name");
  assert.equal(m.global.scenes[0].start, 600);
  assert.equal(m.global.scenes[0].superName, "Other");
  assert.equal(m.global.scenes[1].label, "a dog dies");
  assert.equal(m.global.scenes[1].safe, 3240);
  assert.equal(m.global.scenes[1].superName, "Animals", "the scene was not annotated with its category");

  // Both never-timed yes topics are flagged: the sexual one carries the
  // description from the untimed rating, 197 only has its stats row.
  assert.equal(m.global.dddFlags.length, 2, `fixture produced the wrong flags: ${JSON.stringify(m.global.dddFlags)}`);
  assert.equal(m.global.dddFlags[0].label, "someone is naked");
  assert.equal(m.global.dddFlags[0].yes, 8);
  assert.equal(m.global.dddFlags[0].superName, "Sexual Content/Assault");
  assert.equal(m.global.dddFlags[1].label, "there is sexual content");

  const report = m.posted("sidebar", "scenesResult").pop();
  assert.equal(report.count, 2);
  assert.equal(report.stale, false);
  assert.equal(report.scenes[1].at, "53:54");
  assert.equal(report.scenes[1].to, "54:00");
  assert.equal(report.flags[0].super, "Sexual Content/Assault");
  assert.equal(m.listening("mpv.time-pos.changed"), true, "no observer was armed for the scenes");
});

test("a second episode of the same show costs no requests", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const afterFirst = dddCalls(m).length;
  assert.ok(afterFirst >= 5, `expected item + ratings + stats + index calls, saw ${afterFirst}`);

  m.fromWebView("sidebar", "episodeSelected", Object.assign({}, EPISODE, { episode: 1 }));
  await settle();
  assert.equal(dddCalls(m).length, afterFirst,
    "the second episode re-fetched the show instead of filtering client-side");
});

test("a film's no-vote cat row is gone and its untimed sexual flag is present", async () => {
  const m = dddSession(filmRoutes());
  m.fromWebView("sidebar", "episodeSelected", FILM);
  await settle();
  assert.equal(m.global.scenes.length, 1, `the no-vote row survived: ${JSON.stringify(m.global.scenes)}`);
  assert.equal(m.global.scenes[0].topicId, 197);
  assert.equal(m.global.scenes[0].label, "there is sexual content");
  const labels = m.global.dddFlags.map((f) => f.label);
  assert.ok(labels.indexOf("someone is naked") !== -1, `sexual flag missing: ${JSON.stringify(labels)}`);
  assert.ok(labels.indexOf("a cat dies") === -1, "a no-voted topic was flagged");
  const naked = m.global.dddFlags.filter((f) => f.label === "someone is naked")[0];
  assert.match(naked.desc, /Mystique drugs a guard/);
});

test("switching a category Off removes its scenes and flags without a refetch", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const calls = dddCalls(m).length;

  m.fromWebView("sidebar", "setDddCatActions", { actions: { "54": "off", "51": "skip" } });
  await settle();
  assert.equal(dddCalls(m).length, calls, "a settings change re-ran the network lookup");
  assert.equal(m.global.scenes.length, 1, `the Off category's scene survived: ${JSON.stringify(m.global.scenes)}`);
  assert.equal(m.global.scenes[0].label, "a dead animal");
});

test("a show DDD does not have is cached as a miss", async () => {
  const m = dddSession({
    [DDD_ITEMS_1399]: { statusCode: 200, data: [] },
    [DDD_TOPICS]: { statusCode: 200, data: TOPICS }
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const afterMiss = dddCalls(m).length;

  m.fromWebView("sidebar", "episodeSelected", Object.assign({}, EPISODE, { episode: 1 }));
  await settle();
  assert.equal(dddCalls(m).length, afterMiss, "a real miss was re-fetched for every episode");
});

test("an outage is not cached as nothing found", async () => {
  const m = dddSession({
    [DDD_ITEMS_1399]: () => new Error("network down"),
    [DDD_TOPICS]: { statusCode: 200, data: TOPICS }
  });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const afterOutage = dddCalls(m).length;
  assert.equal(m.global.scenes.length, 0);

  m.fromWebView("sidebar", "episodeSelected", Object.assign({}, EPISODE, { episode: 1 }));
  await settle();
  assert.ok(dddCalls(m).length > afterOutage, "the outage was cached and the retry never happened");
});

test("a scene lookup that finishes after the file changed is discarded", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = dddSession(Object.assign(tvRoutes(), {
    [DDD_RATINGS_GOT]: () => gate.then(() => ({ statusCode: 200, data: RATINGS }))
  }));
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const callsBefore = dddCalls(m).length;

  m.emit("iina.file-loaded");
  release();
  await settle();

  assert.equal(m.global.scenes.length, 0, "the abandoned lookup installed scenes for the new file");
  assert.equal(dddCalls(m).length, callsBefore, "the abandoned lookup kept querying after the file changed");
  const last = m.posted("sidebar", "scenesResult").pop();
  assert.equal(last.stale, true, "the abandoned run did not report stale");
});

// ── The cue card ───────────────────────────────────────────────────

test("the cue card comes up in its window and goes away when the scene starts", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  mpvProps["time-pos"] = 3203;                  // one second before the window
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").length, 0, "the card appeared before its window");

  mpvProps["time-pos"] = 3204;                  // exactly 30s before 53:54
  m.emit("mpv.time-pos.changed");
  const cues = m.posted("overlay", "showCue");
  assert.equal(cues.length, 1, "the card never appeared");
  assert.equal(cues[0].mode, "skip");
  assert.equal(cues[0].label, "a dog dies");
  assert.equal(cues[0].local, false, "database data was marked as the user's own");
  assert.equal(cues[0].at, "53:54");
  assert.equal(cues[0].to, "54:00");
  const clicks = m.sink.calls.filter((c) => c[1] === "setClickable");
  assert.equal(clicks[clicks.length - 1][2], true, "a skippable cue was not made clickable");

  mpvProps["time-pos"] = 3210;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").length, 1, "the card was re-shown for the same scene");

  mpvProps["time-pos"] = 3234;                  // the scene starts
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "hideCue").length, 1, "the card outlived its window");
  assert.equal(m.global.activeScene, null);
  const after = m.sink.calls.filter((c) => c[1] === "setClickable");
  assert.equal(after[after.length - 1][2], false, "the overlay stayed clickable after the card went away");
});

test("the configured lead time moves the card's window", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "setDddLead", { value: 5 });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  mpvProps["time-pos"] = 3204;                  // inside the default's window, not 5s'
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").length, 0, "the card used the old lead");

  mpvProps["time-pos"] = 3230;                  // within 5s of 3234
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").length, 1, "the configured lead was not used");
});

test("a warning-only cue never takes the mouse events", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "episodeSelected", Object.assign({}, EPISODE, { season: 3, episode: 1 }));
  await settle();
  assert.equal(m.global.scenes.length, 1);
  assert.equal(m.global.scenes[0].safe, null, "the fixture scene grew a safe position");

  mpvProps["time-pos"] = 2180;                  // inside [2200-30, 2200)
  m.emit("mpv.time-pos.changed");
  const cues = m.posted("overlay", "showCue");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].mode, "warn");
  assert.equal(cues[0].to, "");
  const clickable = m.sink.calls.filter((c) => c[1] === "setClickable" && c[2] === true);
  assert.equal(clickable.length, 0, "a warning-only card became clickable");
});

test("skipScene seeks to the safe position and a warning cannot be skipped", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  m.global.showSceneCue(m.global.scenes[1]);
  m.fromWebView("overlay", "skipScene", {});
  assert.deepEqual(m.sink.seeks, [3240]);
  assert.equal(m.global.sceneVisible, false, "the card survived the skip");

  m.global.activeScene = { label: "x", start: 100, safe: null };
  m.global.sceneVisible = true;
  m.fromWebView("overlay", "skipScene", {});
  assert.deepEqual(m.sink.seeks, [3240], "a warning with no safe position was seeked on");
  assert.equal(m.global.sceneVisible, true, "the refused skip took the card away");
});

test("a scene skip never lands on EOF", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  m.global.activeScene = { label: "x", start: 100, safe: 4000 };  // the file's duration
  m.fromWebView("overlay", "skipScene", {});
  assert.equal(m.sink.seeks.length, 1);
  assert.ok(m.sink.seeks[0] < 4000, `seeked to ${m.sink.seeks[0]}, which is EOF`);
});

// ── Auto-skip ──────────────────────────────────────────────────────

function autoFilmSession(mpvProps) {
  const m = dddSession(filmRoutes(), { mpvProps });
  // Sexual Content/Assault -> Auto; everything else stays at its default.
  m.fromWebView("sidebar", "setDddCatActions", { actions: { "51": "auto" } });
  return m;
}

test("an auto category skips the scene and offers undo", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = autoFilmSession(mpvProps);
  m.fromWebView("sidebar", "episodeSelected", FILM);
  await settle();
  assert.equal(m.global.scenes[0].strong, true, "the fixture topic is not strong in the stats");

  mpvProps["time-pos"] = 585;                   // lead window, 20s before 605
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").pop().mode, "auto");

  mpvProps["time-pos"] = 604.5;
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [], "the skip fired before the scene started");

  mpvProps["time-pos"] = 605.2;                 // crossing the start line
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [620], `expected a seek to the safe position, got ${m.sink.seeks}`);
  const undo = m.posted("overlay", "showCue").pop();
  assert.equal(undo.mode, "undo", "no undo card after the auto-skip");
  assert.equal(m.global.scenes[0].skipped, true);

  // Undo goes back to just before the scene, and the auto path does not fire
  // again on the way through.
  m.fromWebView("overlay", "undoScene", {});
  assert.deepEqual(m.sink.seeks, [620, 604]);
});

test("cancelling an auto cue keeps the scene, with the manual offer left", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = autoFilmSession(mpvProps);
  m.fromWebView("sidebar", "episodeSelected", FILM);
  await settle();

  mpvProps["time-pos"] = 590;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").pop().mode, "auto");

  m.fromWebView("overlay", "cancelScene", {});
  assert.equal(m.posted("overlay", "showCue").pop().mode, "skip",
    "a cancelled auto cue did not fall back to the manual offer");
  assert.equal(m.global.scenes[0].cancelled, true);

  mpvProps["time-pos"] = 605.2;
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [], "a cancelled scene was auto-skipped anyway");
});

test("a contested topic never auto-skips, however its category is set", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "setDddCatActions", { actions: { "54": "auto" } });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const scene = m.global.scenes.filter((s) => s.topicId === 153)[0];
  assert.equal(scene.strong, false, "the fixture stopped being contested");

  mpvProps["time-pos"] = 3233;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").pop().mode, "skip");

  mpvProps["time-pos"] = 3234.3;
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [], "a contested topic auto-skipped");
});

test("a seek across the scene is not an auto-skip trigger", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = autoFilmSession(mpvProps);
  m.fromWebView("sidebar", "episodeSelected", FILM);
  await settle();

  mpvProps["time-pos"] = 550;
  m.emit("mpv.time-pos.changed");
  mpvProps["time-pos"] = 610;                   // a 60s jump: the user seeking in
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [], "a deliberate seek was treated as an auto-skip trigger");
});

test("a fresh scene window replaces the undo card and disarms its timer", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  // Pretend an auto-skip just happened for the later scene.
  m.global.showUndoCue({ label: "a dog dies", start: 3234, safe: 3240, skipped: true });
  assert.equal(m.posted("overlay", "showCue").pop().mode, "undo");

  mpvProps["time-pos"] = 575;                   // inside the early scene's window
  m.emit("mpv.time-pos.changed");
  const last = m.posted("overlay", "showCue").pop();
  assert.equal(last.mode, "skip", "the undo card was not replaced by the new window");
  assert.equal(last.label, "a dead animal");

  m.runTimers();                                // the undo timer must already be disarmed
  assert.equal(m.posted("overlay", "hideCue").length, 0,
    "the disarmed undo timer hid the fresh card");
});

test("switching scene warnings off clears the cue and the observer", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.listening("mpv.time-pos.changed"), true);

  m.fromWebView("sidebar", "setDddEnabled", { enabled: false });
  assert.equal(m.global.scenes.length, 0);
  assert.equal(m.global.sceneVisible, false);
  assert.equal(m.listening("mpv.time-pos.changed"), false, "the observer outlived the feature");
  assert.equal(m.posted("sidebar", "scenesResult").pop().count, 0, "the sidebar list was not cleared");
});

// ── Local scene marks ──────────────────────────────────────────────

test("captureTime hands back the playhead, or null when there is none", () => {
  const mpvProps = { duration: 4000, "time-pos": 1234.5 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "captureTime", { kind: "trigger" });
  let out = m.posted("sidebar", "timeCaptured").pop();
  assert.equal(out.kind, "trigger");
  assert.equal(out.seconds, 1234.5);

  mpvProps["time-pos"] = -3;                    // an unloaded file
  m.fromWebView("sidebar", "captureTime", { kind: "safe" });
  out = m.posted("sidebar", "timeCaptured").pop();
  assert.equal(out.kind, "safe");
  assert.equal(out.seconds, null, "a negative playhead was reported as a time");
});

test("a local mark becomes a cue and is not reported as DDD data", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "setSceneMarks", { marks: [
    { label: "your mark", start: 1000, safe: 1030 },
    { label: "your mark", start: 2000, safe: null },
    { label: "bad", start: "x", safe: 5 }             // invalid: dropped
  ] });
  assert.equal(m.global.localMarks.length, 2, "the invalid mark was kept");
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  const locals = m.global.scenes.filter((s) => s.local);
  assert.equal(locals.length, 2, "the marks did not reach the cue list");
  assert.equal(locals[0].label, "your mark");
  assert.equal(locals[0].action, "skip", "a local mark is not a manual skip");
  assert.equal(locals[1].safe, null, "a warn-only mark grew a target");

  const report = m.posted("sidebar", "scenesResult").pop();
  assert.equal(report.count, 2, "the DDD count includes local marks");
  assert.ok(report.scenes.every((s) => s.label !== "your mark"),
    "a local mark was reported back as DDD data");
});

test("local marks work without a DDD key", async () => {
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    mpvProps: { duration: 4000 }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });   // no key
  m.fromWebView("sidebar", "setSceneMarks", { marks: [{ label: "your mark", start: 30, safe: 60 }] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(dddCalls(m).length, 0, "the no-key path still queried DDD");
  assert.equal(m.global.scenes.length, 1, "the mark did not become a cue without a key");
  assert.equal(m.listening("mpv.time-pos.changed"), true, "no observer was armed for the mark");
});

test("a local mark's card offers its skip-to", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "setSceneMarks", { marks: [{ label: "your mark", start: 1000, safe: 1030 }] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  mpvProps["time-pos"] = 985;                   // inside the 30s lead
  m.emit("mpv.time-pos.changed");
  const cue = m.posted("overlay", "showCue").pop();
  assert.equal(cue.mode, "skip");
  assert.equal(cue.label, "your mark");
  assert.equal(cue.local, true, "a local mark was not marked as the user's own");

  mpvProps["time-pos"] = 1001;                  // playing through the mark
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "hideCue").length, 1, "the card outlived the mark's start");
});

test("a mark's own type decides its card, including auto", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "setSceneMarks", { marks: [
    { label: "warny", start: 500, safe: 530, action: "warn" },
    { label: "autoy", start: 1000, safe: 1030, action: "auto" }
  ]});
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  const warny = m.global.scenes.filter((s) => s.label === "warny")[0];
  const autoy = m.global.scenes.filter((s) => s.label === "autoy")[0];
  assert.equal(m.global.localMarks[0].action, "warn");
  assert.equal(warny.action, "warn");
  assert.equal(autoy.action, "auto");
  assert.equal(autoy.strong, true, "a local auto mark must not need the community's majority");

  mpvProps["time-pos"] = 485;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").pop().mode, "warn", "a warn mark offered a button");

  mpvProps["time-pos"] = 985;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").pop().mode, "auto");

  mpvProps["time-pos"] = 999.5;                 // crossing in playback steps,
  m.emit("mpv.time-pos.changed");               // not one jump (that is a seek)
  mpvProps["time-pos"] = 1000.4;
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [1030], "the auto mark did not skip at its start");
});

test("an auto mark still skips when scene cues are off", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "setSceneMarks", { marks: [
    { label: "autoy", start: 1000, safe: 1030, action: "auto" },
    { label: "skippy", start: 500, safe: 530, action: "skip" }
  ] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  m.fromWebView("sidebar", "setDddEnabled", { enabled: false });
  await settle();
  assert.equal(m.global.scenes.length, 2, "the rebuild dropped the local marks");
  assert.equal(m.posted("sidebar", "scenesResult").pop().count, 0,
    "the databases' cue was not dropped from the list");

  // A skip mark is a cue and stays down with cues off...
  mpvProps["time-pos"] = 485;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").length, 0, "a skip mark carded with cues off");

  // ...but an auto mark is an action and fires.
  mpvProps["time-pos"] = 999.5;
  m.emit("mpv.time-pos.changed");
  mpvProps["time-pos"] = 1000.4;
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [1030], "the auto mark did not skip with cues off");
});

test("with auto cards off an auto skip is silent", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "setDddAutoCard", { enabled: false });
  m.fromWebView("sidebar", "setSceneMarks", { marks: [
    { label: "autoy", start: 1000, safe: 1030, action: "auto" }
  ] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  mpvProps["time-pos"] = 985;
  m.emit("mpv.time-pos.changed");
  assert.equal(m.posted("overlay", "showCue").length, 0, "a silent auto mark still carded");

  mpvProps["time-pos"] = 999.5;
  m.emit("mpv.time-pos.changed");
  mpvProps["time-pos"] = 1000.4;
  m.emit("mpv.time-pos.changed");
  assert.deepEqual(m.sink.seeks, [1030], "the silent auto mark did not skip");
  assert.equal(m.posted("overlay", "showCue").length, 0, "the undo card appeared for a silent auto");
});

test("turning auto cards off leaves other cues alone", async () => {
  const mpvProps = { duration: 4000, "time-pos": 0 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "setDddAutoCard", { enabled: false });
  m.fromWebView("sidebar", "setSceneMarks", { marks: [
    { label: "skippy", start: 3000, safe: 3005, action: "skip" }
  ] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();

  // The database's cue in this window still cards...
  mpvProps["time-pos"] = 575;
  m.emit("mpv.time-pos.changed");
  let cue = m.posted("overlay", "showCue").pop();
  assert.equal(cue.label, "a dead animal", "a database cue was suppressed by the auto-card setting");

  // ...and so does a plain Skip mark.
  mpvProps["time-pos"] = 2985;
  m.emit("mpv.time-pos.changed");
  cue = m.posted("overlay", "showCue").pop();
  assert.equal(cue.label, "skippy");
  assert.equal(cue.mode, "skip");
});

test("a mark with a safe position before or at its start is warn-only", () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "setSceneMarks", { marks: [
    { label: "a", start: 100, safe: 100 },        // degenerate
    { label: "b", start: 200, safe: 150 }         // before the start
  ] });
  assert.equal(m.global.localMarks[0].safe, null);
  assert.equal(m.global.localMarks[1].safe, null);
});

test("local marks survive a category set to Off", async () => {
  const m = dddSession(tvRoutes());
  // Every category the fixture touches is off, so only the mark remains:
  // 54 Animals (the 153 cue), 51 Sexual (the flag), 60 Other (the missing
  // topic's fallback bucket).
  m.fromWebView("sidebar", "setDddCatActions", { actions: { "54": "off", "51": "off", "60": "off" } });
  m.fromWebView("sidebar", "setSceneMarks", { marks: [{ label: "your mark", start: 1000, safe: 1030 }] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.global.scenes.length, 1, "an Off category suppressed a local mark");
  assert.equal(m.global.scenes[0].local, true);
});

test("a local mark merges into a database cue at the same moment", async () => {
  const m = dddSession(tvRoutes());
  // The TV fixture's 153 cue starts at 3234; mark the same moment.
  m.fromWebView("sidebar", "setSceneMarks", { marks: [{ label: "your mark", start: 3236, safe: 3300 }] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  const merged = m.global.scenes.filter((s) => s.start === 3234)[0];
  assert.ok(merged, "the merged cue disappeared");
  assert.match(merged.label, /a dog dies/);
  assert.match(merged.label, /your mark/);
  assert.equal(merged.safe, 3300, "the mark's later safe position did not win");
});

test("clearing the selection clears the marks from main.js too", async () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "setSceneMarks", { marks: [{ label: "your mark", start: 100, safe: 130 }] });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  await settle();
  assert.equal(m.global.localMarks.length, 1);
  m.fromWebView("sidebar", "clearEpisode", {});
  assert.equal(m.global.localMarks.length, 0);
  assert.equal(m.global.scenes.length, 0, "a mark outlived the selection");
});

test("preview seeks are clamped and refuse nonsense", () => {
  const m = dddSession(tvRoutes());
  m.fromWebView("sidebar", "seekToTime", { seconds: 1234 });
  assert.equal(m.sink.seeks.length, 1);
  assert.equal(m.sink.seeks[0], 1234);

  m.fromWebView("sidebar", "seekToTime", { seconds: -5 });
  m.fromWebView("sidebar", "seekToTime", { seconds: "nonsense" });
  assert.equal(m.sink.seeks.length, 1, "a bad preview seek went through");

  m.fromWebView("sidebar", "seekToTime", { seconds: 99999 });   // past the 4000s fixture
  assert.equal(m.sink.seeks.length, 2);
  assert.ok(m.sink.seeks[1] < 4000, `a preview seeked past EOF: ${m.sink.seeks[1]}`);
});

test("captureTime echoes the editor's start/end kinds", () => {
  const mpvProps = { duration: 4000, "time-pos": 500 };
  const m = dddSession(tvRoutes(), { mpvProps });
  m.fromWebView("sidebar", "captureTime", { kind: "start" });
  assert.equal(m.posted("sidebar", "timeCaptured").pop().kind, "start");
  m.fromWebView("sidebar", "captureTime", { kind: "end" });
  const out = m.posted("sidebar", "timeCaptured").pop();
  assert.equal(out.kind, "end");
  assert.equal(out.seconds, 500);
});

test("a scan reads the selected external text track and proposes marks", () => {
  const SRT = "1\n00:00:46,270 --> 00:00:46,900\n[Moaning]\n\n2\n00:00:46,340 --> 00:00:47,100\n[Both moaning]\n\n3\n00:01:10,000 --> 00:01:15,000\n[Storm]\n";
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle: {
      tracks: [
        { id: 1, isExternal: false, codec: "subrip", isSelected: false, title: "embedded" },
        { id: 23, isExternal: true, codec: "subrip", isSelected: true, title: "x.en.SDH.srt" }
      ],
      delay: 2
    },
    file: { read: (p) => { assert.equal(p, "@sub/23"); return SRT; } }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "scanSubtitles", {});
  const out = m.posted("sidebar", "subScanResult").pop();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.track, "x.en.SDH.srt");
  assert.equal(out.cues, 3);
  assert.equal(out.proposals.length, 1, `proposals: ${JSON.stringify(out.proposals)}`);
  assert.equal(out.proposals[0].label, "moaning");
  assert.ok(Math.abs(out.proposals[0].start - 48.27) < 0.001, "the subtitle delay was not applied");
});

test("a scan without a readable track explains itself", () => {
  const m = loadMain({
    subtitle: { tracks: [{ id: 3, isExternal: false, codec: "hdmv_pgs_subtitle", isSelected: true, title: "PGS" }] },
    file: { read: () => { throw new Error("unreachable"); } }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "scanSubtitles", {});
  const out = m.posted("sidebar", "subScanResult").pop();
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no-external-text");
});

test("an unreadable subtitle file reports read-failed", () => {
  const m = loadMain({
    subtitle: { tracks: [{ id: 5, isExternal: true, codec: "subrip", isSelected: true, title: "x.srt" }] },
    file: { read: () => { throw new Error("boom"); } }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "scanSubtitles", {});
  const out = m.posted("sidebar", "subScanResult").pop();
  assert.equal(out.ok, false);
  assert.equal(out.reason, "read-failed");
});

test("a selected external subtitle is auto-scanned once per track", () => {
  const SRT = "1\n00:00:10,000 --> 00:00:12,000\n[Moaning]\n";
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle: { tracks: [{ id: 9, isExternal: true, codec: "subrip", isSelected: true, title: "a.en.SDH.srt" }] },
    file: { read: () => SRT }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddKey", { key: "K" });
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);

  const auto = m.posted("sidebar", "subScanResult").filter((r) => r.auto);
  assert.equal(auto.length, 1, "the subtitle was not auto-scanned");
  assert.equal(auto[0].ok, true);
  assert.equal(auto[0].proposals.length, 1);
  assert.equal(auto[0].proposals[0].label, "moaning");

  m.global.autoScanStep();          // the same track is not scanned twice
  assert.equal(m.posted("sidebar", "subScanResult").filter((r) => r.auto).length, 1);
});

test("a successful scan caches the subtitle for the next open", () => {
  const SRT = "1\n00:00:10,000 --> 00:00:12,000\n[Moaning]\n";
  const writes = [];
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle: { tracks: [{ id: 9, isExternal: true, codec: "subrip", isSelected: true, title: "a.en.SDH.srt" }] },
    file: { read: () => SRT, write: (p, t) => writes.push([p, t]) }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddKey", { key: "K" });
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  assert.equal(writes.length, 1, "the scanned subtitle was not cached");
  assert.equal(writes[0][0], "@data/sidekick-sub-1399-1-2.srt");
  assert.equal(writes[0][1], SRT);
});

test("a remembered subtitle auto-loads when none of the user's is selected", () => {
  const loads = [];
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle: {
      tracks: [{ id: 1, isExternal: false, codec: "subrip", isSelected: true, title: "embedded" }],
      loadTrack: (p) => loads.push(p)
    },
    file: { exists: () => true }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddKey", { key: "K" });
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  assert.equal(loads.length, 1, "the remembered subtitle was not loaded");
  assert.equal(loads[0], "@data/sidekick-sub-1399-1-2.srt");

  // A user-selected external subtitle is never overridden.
  const loads2 = [];
  const m2 = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle: {
      tracks: [{ id: 1, isExternal: true, codec: "subrip", isSelected: true, title: "mine.srt" }],
      loadTrack: (p) => loads2.push(p)
    },
    file: { exists: () => true }
  });
  m2.emit("iina.window-loaded");
  m2.runTimers();
  m2.fromWebView("sidebar", "setDddKey", { key: "K" });
  m2.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  m2.fromWebView("sidebar", "episodeSelected", EPISODE);
  assert.equal(loads2.length, 0, "an existing external subtitle was overridden");
});

test("a cached subtitle that never appears reports autoload-failed", () => {
  const tracks = [{ id: 1, isExternal: false, codec: "subrip", isSelected: true, title: "embedded" }];
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle: { tracks, loadTrack: () => {} },
    file: { exists: () => true }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddKey", { key: "K" });
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.runTimers();                       // the verification deadline
  const last = m.posted("sidebar", "subScanResult").pop();
  assert.equal(last.ok, false);
  assert.equal(last.reason, "autoload-failed");
});

test("a cached subtitle that loads is not reported as failed and gets scanned", () => {
  const tracks = [{ id: 1, isExternal: false, codec: "subrip", isSelected: true, title: "embedded" }];
  const SRT = "1\n00:00:10,000 --> 00:00:12,000\n[Moaning]\n";
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle: {
      tracks,
      loadTrack: () => { tracks.push({ id: 9, isExternal: true, codec: "subrip", isSelected: true, title: "cached" }); }
    },
    file: { exists: () => true, read: () => SRT }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddKey", { key: "K" });
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  m.global.autoScanStep();             // the poll would catch the new track
  m.runTimers();                       // the verification deadline
  const failures = m.posted("sidebar", "subScanResult").filter((r) => !r.ok);
  assert.equal(failures.length, 0, "a successful load was reported as failed");
  const auto = m.posted("sidebar", "subScanResult").filter((r) => r.ok && r.auto);
  assert.equal(auto.length, 1, "the loaded cached subtitle was not scanned");
});

test("switching subtitle tracks does not rescan the episode", () => {
  const SRT = "1\n00:00:10,000 --> 00:00:12,000\n[Moaning]\n";
  const subtitle = { tracks: [{ id: 9, isExternal: true, codec: "subrip", isSelected: true, title: "a.en.SDH.srt" }] };
  const m = loadMain({
    status: { paused: false, duration: 4000, url: "file:///v/a.mkv" },
    subtitle,
    file: { read: () => SRT }
  });
  m.emit("iina.window-loaded");
  m.runTimers();
  m.fromWebView("sidebar", "setDddKey", { key: "K" });
  m.fromWebView("sidebar", "setDddEnabled", { enabled: true });
  m.fromWebView("sidebar", "episodeSelected", EPISODE);
  assert.equal(m.posted("sidebar", "subScanResult").filter((r) => r.auto).length, 1);

  // The user switches to another external subtitle; no new proposals.
  subtitle.tracks = [{ id: 11, isExternal: true, codec: "subrip", isSelected: true, title: "b.srt" }];
  m.global.autoScanStep();
  assert.equal(m.posted("sidebar", "subScanResult").filter((r) => r.auto).length, 1,
    "a track switch re-scanned the episode");
});

// ── Sidebar side ───────────────────────────────────────────────────

function posted(h, name) {
  return h.iina._posted.filter((x) => x.name === name).map((x) => x.payload);
}

test("saving a DDD key stores it and pushes it to main.js", () => {
  const h = loadSidebar({ storage: {} });
  h.document.getElementById("ddd-key-input").value = "  KEY123  ";
  h.global.doSaveDddKey();
  assert.equal(h.localStorage.getItem("epinfo_ddd_key"), "KEY123");
  assert.equal(posted(h, "setDddKey")[0].key, "KEY123");
});

test("the verification verdicts: invalid drops the key, unverified keeps it", () => {
  const bad = loadSidebar({ storage: { epinfo_ddd_key: "K" } });
  bad.iina._emit("dddKeyCheck", { ok: false, reason: "invalid" });
  assert.equal(bad.localStorage.getItem("epinfo_ddd_key"), null, "a dead key was kept");
  assert.match(bad.document.getElementById("ddd-key-msg").textContent, /Invalid/);

  const soft = loadSidebar({ storage: { epinfo_ddd_key: "K" } });
  soft.iina._emit("dddKeyCheck", { ok: false, reason: "unverified" });
  assert.equal(soft.localStorage.getItem("epinfo_ddd_key"), "K",
    "a key that could not be verified was thrown away");
  assert.match(soft.document.getElementById("ddd-key-msg").textContent, /Saved/);

  const good = loadSidebar({ storage: { epinfo_ddd_key: "K" } });
  good.iina._emit("dddKeyCheck", { ok: true });
  assert.match(good.document.getElementById("ddd-key-msg").textContent, /Valid/);
});

test("the scene and flag lists render, grouped and escaped", () => {
  const h = loadSidebar({ storage: {} });
  const el = h.document.getElementById("ddd-scenes");
  const flags = h.document.getElementById("ddd-flags");
  const attr = h.document.getElementById("ddd-attr");

  h.iina._emit("scenesResult", { count: 1, stale: false, scenes: [
    { label: "a <b>dog</b> dies", at: "53:54", to: "54:00", cue: "", desc: "A dog is hit by a car." }
  ], flags: [
    { label: "someone is naked", super: "Sexual Content/Assault", yes: 8, no: 4, desc: "Mystique drugs a guard's drink." }
  ]});
  assert.match(el.innerHTML, /&lt;b&gt;dog&lt;\/b&gt;/, "the scene label was not escaped");
  assert.match(el.innerHTML, /53:54/);
  assert.match(el.innerHTML, /A dog is hit by a car/);
  assert.match(flags.innerHTML, /Sexual Content\/Assault/);
  assert.match(flags.innerHTML, /8 yes/);
  assert.match(flags.innerHTML, /Mystique drugs a guard/);
  assert.equal(h.document.getElementById("ddd-flags-wrap").style.display, "block");
  assert.equal(attr.style.display, "block", "the DDD attribution did not appear with the data");

  // A superseded run must not blank the lists the live run just filled.
  el.innerHTML = "MARKER";
  flags.innerHTML = "MARKER";
  h.iina._emit("scenesResult", { count: 0, stale: true, scenes: [], flags: [] });
  assert.equal(el.innerHTML, "MARKER", "a stale report was treated as an answer");
  assert.equal(flags.innerHTML, "MARKER");

  h.iina._emit("scenesResult", { count: 0, stale: false, scenes: [], flags: [] });
  assert.equal(el.style.display, "none");
  assert.equal(h.document.getElementById("ddd-flags-wrap").style.display, "none");
  assert.equal(h.document.getElementById("ddd-flags-empty").style.display, "block",
    "the empty-flags state was not shown");
  assert.equal(attr.style.display, "none");
});

// ── Section layout ─────────────────────────────────────────────────

test("the scene section's tabs switch panes and persist", () => {
  const h = loadSidebar({ storage: {} });
  assert.equal(h.document.getElementById("ddd-pane-cues").style.display, "block", "cues is not the default");
  assert.equal(h.document.getElementById("ddd-pane-flags").style.display, "none");

  h.global.doDddTab("flags");
  assert.equal(h.localStorage.getItem("epinfo_ddd_tab"), "flags");
  assert.equal(h.document.getElementById("ddd-pane-flags").style.display, "block");
  assert.equal(h.document.getElementById("ddd-pane-cues").style.display, "none");

  // An unknown tab falls back rather than hiding everything.
  h.global.doDddTab("nonsense");
  assert.equal(h.localStorage.getItem("epinfo_ddd_tab"), "cues");
  assert.equal(h.document.getElementById("ddd-pane-cues").style.display, "block");
  assert.equal(h.document.getElementById("ddd-pane-options").style.display, "none");
});

test("the last scene tab is restored at load", () => {
  const h = loadSidebar({ storage: { epinfo_ddd_tab: "options" } });
  assert.equal(h.document.getElementById("ddd-pane-options").style.display, "block");
  assert.equal(h.document.getElementById("ddd-pane-cues").style.display, "none");
});

test("flag groups collapse by default and honour stored open state", () => {
  const flags = [
    { label: "b", super: "Bodily Harm", yes: 2, no: 0, desc: "" },
    { label: "c", super: "Bodily Harm", yes: 1, no: 0, desc: "" },
    { label: "s", super: "Sexual Content/Assault", yes: 8, no: 4, desc: "x" }
  ];
  const closed = loadSidebar({ storage: {} });
  closed.iina._emit("scenesResult", { count: 0, stale: false, scenes: [], flags });
  const html = closed.document.getElementById("ddd-flags").innerHTML;
  assert.match(html, /<details class="ddd-fgrp" data-g="Bodily Harm">/,
    "a group is open without stored state");
  assert.match(html, /ddd-gcount">2</, "the group count is missing");

  const open = loadSidebar({ storage: { epinfo_dddflag_open: '{"Bodily Harm":true}' } });
  open.iina._emit("scenesResult", { count: 0, stale: false, scenes: [], flags });
  assert.match(open.document.getElementById("ddd-flags").innerHTML,
    /<details class="ddd-fgrp" open data-g="Bodily Harm">/,
    "the stored open state was ignored");
});

test("the sidebar's sections are collapsible with persisted keys", () => {
  // The boot collapsible scanner runs against the real WebView DOM, which the
  // harness does not parse, so the keys are asserted at the source.
  const src = readRepo("sidebar.html");
  for (const k of ["find", "sk", "ddd", "app"]) {
    assert.match(src, new RegExp('data-k="' + k + '"'), `section "${k}" is not a persisted collapsible`);
  }
});

test("the lead input stores, clamps and pushes", () => {
  const h = loadSidebar({ storage: {} });
  h.global.doSetDddLead("45");
  assert.equal(h.localStorage.getItem("epinfo_ddd_lead"), "45");
  assert.equal(posted(h, "setDddLead")[0].value, 45);
  h.global.doSetDddLead("1");
  assert.equal(h.localStorage.getItem("epinfo_ddd_lead"), "5", "a too-small lead was not clamped");
  h.global.doSetDddLead("999");
  assert.equal(h.localStorage.getItem("epinfo_ddd_lead"), "120", "a too-large lead was not clamped");
});

test("the category pills cycle Off -> Warn -> Skip -> Auto and push the map", () => {
  const h = loadSidebar({ storage: {} });
  assert.equal(h.global.dddCatState(51), "skip", "the default is not skip");
  h.global.cycleDddCat(51);
  assert.equal(h.global.dddCatState(51), "auto");
  assert.equal(posted(h, "setDddCatActions").pop().actions["51"], "auto");
  h.global.cycleDddCat(51);
  assert.equal(h.global.dddCatState(51), "off", "the cycle did not wrap");
  assert.match(h.document.getElementById("ddd-cats").innerHTML, /Sex/, "the pills were not painted");
});

test("boot pushes the saved lead and category map", () => {
  const h = loadSidebar({ storage: { epinfo_ddd_lead: "45", epinfo_ddd_cats: '{"51":"auto","54":"warn"}' } });
  h.timers._fireAll();
  assert.equal(posted(h, "setDddLead").pop().value, 45);
  const cats = posted(h, "setDddCatActions").pop().actions;
  assert.equal(cats["51"], "auto");
  assert.equal(cats["54"], "warn");
});

test("the auto-card toggle stores and pushes, and boot pushes it", () => {
  const h = loadSidebar({ storage: {} });
  h.global.doToggleDddAutoCard(false);
  assert.equal(h.localStorage.getItem("epinfo_ddd_autocard"), "false");
  assert.equal(posted(h, "setDddAutoCard").pop().enabled, false);

  const booted = loadSidebar({ storage: { epinfo_ddd_autocard: "false" } });
  booted.timers._fireAll();
  assert.equal(posted(booted, "setDddAutoCard").pop().enabled, false, "boot ignored the saved setting");
});

// ── Sidebar marks ──────────────────────────────────────────────────

const EP_INFO = {
  showTitle: "X2", epTitle: "X2", code: "", context: "", airDate: "", rating: "",
  overview: "", posterUrl: "", logoUrl: "", tmdbId: "550", isMovie: true
};

test("marking a trigger then a skip-to stores and pushes the pair", () => {
  const h = loadSidebar({ storage: { epinfo_ep: JSON.stringify(EP_INFO) } });
  h.global.doMarkTrigger();
  assert.equal(posted(h, "captureTime").pop().kind, "trigger",
    "the mark button did not ask for the playhead");
  h.iina._emit("timeCaptured", { kind: "trigger", seconds: 600 });
  assert.match(h.document.getElementById("ddd-mark-pending").innerHTML, /10:00/,
    "the pending trigger was not painted");

  h.global.doMarkSafe();
  assert.equal(posted(h, "captureTime").pop().kind, "safe");
  h.iina._emit("timeCaptured", { kind: "safe", seconds: 660 });

  const marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks.length, 1, "the pair was not stored");
  assert.equal(marks[0].start, 600);
  assert.equal(marks[0].safe, 660);
  assert.equal(posted(h, "setSceneMarks").pop().marks.length, 1,
    "the new mark was not pushed to main.js");
  assert.match(h.document.getElementById("ddd-marks").innerHTML, /10:00/,
    "the list was not painted");
});

test("a mark saved warn-only carries no target", () => {
  const h = loadSidebar({ storage: { epinfo_ep: JSON.stringify(EP_INFO) } });
  h.global.doMarkTrigger();
  h.iina._emit("timeCaptured", { kind: "trigger", seconds: 100 });
  h.global.doMarkWarnOnly();
  const marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks.length, 1);
  assert.equal(marks[0].safe, null);
});

test("a skip-to before the trigger is refused", () => {
  const h = loadSidebar({ storage: { epinfo_ep: JSON.stringify(EP_INFO) } });
  h.global.doMarkTrigger();
  h.iina._emit("timeCaptured", { kind: "trigger", seconds: 500 });
  h.global.doMarkSafe();
  h.iina._emit("timeCaptured", { kind: "safe", seconds: 400 });
  assert.equal(h.localStorage.getItem("epinfo_marks"), null, "an invalid pair was stored");
  assert.match(h.document.getElementById("ddd-status").textContent, /after the trigger/);
});

test("deleting a mark removes it from storage and pushes the new list", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: null }] })
  }});
  h.global.doMarkDelete(0);
  const marks = JSON.parse(h.localStorage.getItem("epinfo_marks"));
  assert.equal(marks["550:-1:-1"], undefined, "the emptied entry was not cleaned up");
  assert.equal(posted(h, "setSceneMarks").pop().marks.length, 0);
});

test("clearing all marks takes two taps", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "a", start: 100, safe: null }] })
  }});
  h.global.doMarkClearAll();
  assert.equal(JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"].length, 1,
    "one tap cleared the marks");
  assert.equal(h.document.getElementById("ddd-marks-clear").textContent, "Sure?");

  h.global.doMarkClearAll();
  const marks = JSON.parse(h.localStorage.getItem("epinfo_marks"));
  assert.equal(marks["550:-1:-1"], undefined, "the second tap did not clear");
  assert.equal(posted(h, "setSceneMarks").pop().marks.length, 0, "the empty list was not pushed");
});

test("identifying a selection pushes that title's marks before the episode", () => {
  const h = loadSidebar({ storage: {
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: null }] })
  }});
  h.global.saveSelection(Object.assign({}, EP_INFO));
  const pushed = posted(h, "setSceneMarks").pop();
  assert.equal(pushed.marks.length, 1, "the saved marks were not pushed with the selection");
  const names = h.iina._posted.map((x) => x.name);
  assert.ok(names.indexOf("setSceneMarks") < names.indexOf("episodeSelected"),
    "the marks must arrive before the selection so one resolve sees them");
});

test("times parse from mm:ss, h:mm:ss and plain seconds", () => {
  const h = loadSidebar({ storage: {} });
  assert.equal(h.global.parseMarkTime("4:04"), 244);
  assert.equal(h.global.parseMarkTime("1:02:05"), 3725);
  assert.equal(h.global.parseMarkTime("2472"), 2472);
  assert.equal(h.global.parseMarkTime("4:99"), null, "out-of-range seconds were accepted");
  assert.equal(h.global.parseMarkTime("nonsense"), null);
  assert.equal(h.global.parseMarkTime(""), null);
});

test("mark times format with hours once past an hour", () => {
  const h = loadSidebar({ storage: {} });
  assert.equal(h.global.fmtMarkTime(244), "4:04");
  assert.equal(h.global.fmtMarkTime(3725), "1:02:05");
});

test("the editor saves typed times, and clearing the end means warn-only", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: 130 }] })
  }});
  h.global.doMarkEdit(0);
  assert.match(h.document.getElementById("ddd-marks").innerHTML, /mark-edit-start/,
    "the editor did not open");

  h.document.getElementById("mark-edit-start").value = "4:04";
  h.document.getElementById("mark-edit-end").value = "4:30";
  h.global.doEditSave();
  let marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].start, 244);
  assert.equal(marks[0].safe, 270);
  assert.equal(posted(h, "setSceneMarks").pop().marks[0].start, 244, "the edit was not pushed");

  h.global.doMarkEdit(0);
  h.document.getElementById("mark-edit-end").value = "";
  h.global.doEditSave();
  marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].safe, null, "clearing the end did not make it warn-only");
});

test("the editor changes a mark's type, and refuses unknown ones", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: 130 }] })
  }});
  // The harness never parses innerHTML, so the editor's fields are set here
  // the way a person would type in them.
  h.global.doMarkEdit(0);
  h.global.doEditType("auto");
  h.document.getElementById("mark-edit-start").value = "1:40";
  h.document.getElementById("mark-edit-end").value = "2:10";
  h.global.doEditSave();
  let marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].action, "auto");
  assert.equal(posted(h, "setSceneMarks").pop().marks[0].action, "auto", "the type was not pushed");

  h.global.doMarkEdit(0);
  h.global.doEditType("warn");
  h.document.getElementById("mark-edit-start").value = "1:40";
  h.document.getElementById("mark-edit-end").value = "2:10";
  h.global.doEditSave();
  marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].action, "warn");

  // An unknown type is refused rather than stored.
  h.global.doMarkEdit(0);
  h.global.doEditType("nonsense");
  h.document.getElementById("mark-edit-start").value = "1:40";
  h.document.getElementById("mark-edit-end").value = "2:10";
  h.global.doEditSave();
  marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].action, "warn");
});

test("the editor saves a custom title, and an empty one falls back", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: 130 }] })
  }});
  h.global.doMarkEdit(0);
  h.document.getElementById("mark-edit-label").value = "  Mystique bathroom scene  ";
  h.document.getElementById("mark-edit-start").value = "1:40";
  h.document.getElementById("mark-edit-end").value = "2:10";
  h.global.doEditSave();
  let marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].label, "Mystique bathroom scene");
  assert.match(h.document.getElementById("ddd-marks").innerHTML, /Mystique bathroom scene/,
    "the custom title was not painted");

  h.global.doMarkEdit(0);
  h.document.getElementById("mark-edit-label").value = "";
  h.document.getElementById("mark-edit-start").value = "1:40";
  h.document.getElementById("mark-edit-end").value = "2:10";
  h.global.doEditSave();
  marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].label, "your mark", "an empty title did not fall back");
});

test("the editor refuses an end before the start", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: 130 }] })
  }});
  h.global.doMarkEdit(0);
  h.document.getElementById("mark-edit-start").value = "5:00";
  h.document.getElementById("mark-edit-end").value = "4:00";
  h.global.doEditSave();
  assert.match(h.document.getElementById("ddd-status").textContent, /after the start/);
  const marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks[0].start, 100, "an invalid edit was saved");
});

test("use playhead fills the editor field from main's answer", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: null }] })
  }});
  h.global.doMarkEdit(0);
  h.global.doEditUsePlayhead("start");
  assert.equal(posted(h, "captureTime").pop().kind, "start");
  h.iina._emit("timeCaptured", { kind: "start", seconds: 605 });
  assert.match(h.document.getElementById("ddd-marks").innerHTML, /10:05/,
    "the playhead value did not fill the field");
});

test("preview buttons seek five seconds before the point", () => {
  const h = loadSidebar({ storage: {
    epinfo_ep: JSON.stringify(EP_INFO),
    epinfo_marks: JSON.stringify({ "550:-1:-1": [{ label: "your mark", start: 100, safe: 200 }] })
  }});
  h.global.doPreviewStart(0);
  assert.equal(posted(h, "seekToTime").pop().seconds, 95, "the row preview is not start-5");
  h.global.doMarkEdit(0);
  h.global.doPreviewEditLanding();
  assert.equal(posted(h, "seekToTime").pop().seconds, 195, "the landing preview is not end-5");
  h.global.doEditCancel();

  h.global.doMarkTrigger();
  h.iina._emit("timeCaptured", { kind: "trigger", seconds: 60 });
  h.global.doPreviewPending();
  assert.equal(posted(h, "seekToTime").pop().seconds, 55, "the pending preview is not trigger-5");
});

test("a scan result adds marks and a rescan does not stack duplicates", () => {
  const h = loadSidebar({ storage: { epinfo_ep: JSON.stringify(EP_INFO) } });
  h.global.doScanSubtitles();
  assert.equal(posted(h, "scanSubtitles").length, 1, "the scan request was not posted");

  h.iina._emit("subScanResult", { ok: true, track: "x.sdh.srt", cues: 10, proposals: [
    { label: "moaning", start: 100, safe: 108 },
    { label: "kissing", start: 500, safe: 503 },
    { label: "t", start: 700, safe: 700 }              // degenerate safe -> warn only
  ]});
  let marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks.length, 3);
  assert.equal(marks[0].label, "moaning");
  assert.equal(marks[2].safe, null, "a degenerate safe was kept");
  assert.equal(posted(h, "setSceneMarks").pop().marks.length, 3, "the proposals were not pushed");

  h.iina._emit("subScanResult", { ok: true, track: "x.sdh.srt", cues: 10, proposals: [
    { label: "moaning", start: 102, safe: 108 },       // within 5s: the same moment
    { label: "kissing", start: 500, safe: 503 },
    { label: "screaming", start: 900, safe: 903 }
  ]});
  marks = JSON.parse(h.localStorage.getItem("epinfo_marks"))["550:-1:-1"];
  assert.equal(marks.length, 4, "the rescan stacked duplicates");
  assert.equal(marks[3].label, "screaming");
});

test("the scan failures explain themselves in the status line", () => {
  const h = loadSidebar({ storage: { epinfo_ep: JSON.stringify(EP_INFO) } });
  h.iina._emit("subScanResult", { ok: false, reason: "no-external-text" });
  assert.match(h.document.getElementById("ddd-status").textContent, /OpenSubtitles/);
  h.iina._emit("subScanResult", { ok: false, reason: "read-failed" });
  assert.match(h.document.getElementById("ddd-status").textContent, /Couldn't read/);

  // A failed auto-load is worth saying; other auto failures stay silent.
  h.iina._emit("subScanResult", { ok: false, reason: "autoload-failed", auto: true });
  assert.match(h.document.getElementById("ddd-status").textContent, /auto-load/);
  h.document.getElementById("ddd-status").textContent = "MARKER";
  h.iina._emit("subScanResult", { ok: false, reason: "read-failed", auto: true });
  assert.equal(h.document.getElementById("ddd-status").textContent, "MARKER",
    "an auto failure was not silent");
});
