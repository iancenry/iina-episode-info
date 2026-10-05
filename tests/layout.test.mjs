import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readRepo, sidebarScripts } from "./helpers/extract.mjs";

// The sidebar's logic was one 2,484-line inline <script>. It is now split
// across sidebar/*.js and pulled in by <script src>, which the WebView loads in
// document order. Three things can quietly break that, none of which a syntax
// check would catch:

//   1. A file exists on disk but nothing loads it. It looks maintained, tests
//      never run it, and a fix lands in code the plugin does not execute.
//   2. A src names a file that is not there. In IINA this is a blank sidebar
//      with no error, because a classic script that 404s is skipped silently.
//   3. Everything is fine and then one file grows back to 2,000 lines, which is
//      the thing the split was for.

const SRC_RE = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

test("every sidebar script file is loaded by sidebar.html", () => {
  const html = readRepo("sidebar.html");
  const referenced = new Set();
  let m;
  SRC_RE.lastIndex = 0;
  while ((m = SRC_RE.exec(html)) !== null) referenced.add(m[1]);

  const onDisk = readdirSync(join(ROOT, "sidebar"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `sidebar/${f}`);

  const orphans = onDisk.filter((f) => !referenced.has(f));
  assert.deepEqual(orphans, [],
    `not loaded by sidebar.html, so never runs: ${orphans.join(", ")}`);

  const missing = [...referenced].filter((f) => !onDisk.includes(f));
  assert.deepEqual(missing, [],
    `sidebar.html loads a file that does not exist: ${missing.join(", ")}`);
});

test("the sidebar is loaded from files, not one inline block", () => {
  // An inline script still parses and still runs, so nothing else would notice
  // the split quietly being undone.
  assert.ok(sidebarScripts().length >= 5,
    `expected the sidebar to be split across files, found ${sidebarScripts().length}`);
});

test("no sidebar script has grown back into a wall", () => {
  // Loose enough for a section to grow, tight enough that 2,484 lines cannot
  // come back. The largest section when the split was made was 480.
  const LIMIT = 600;
  const fat = [];
  for (const f of readdirSync(join(ROOT, "sidebar")).filter((x) => x.endsWith(".js"))) {
    const count = readRepo(`sidebar/${f}`).split("\n").length;
    if (count > LIMIT) fat.push(`${f} (${count} lines)`);
  }
  assert.deepEqual(fat, [], `over the ${LIMIT}-line limit: ${fat.join(", ")}`);
});

// The order the split was made in, pinned. It is not alphabetical and not
// arbitrary: classic scripts share one global scope, and a declaration is only
// hoisted inside its own file, so a file that calls a function defined in a
// later file breaks. Two sections have that shape and keep their helper
// alongside the caller inside settings.js, which is why the split points sit
// where they do. Everything after them is safe to reorder; nothing before is.
const LOAD_ORDER = [
  "sidebar/state.js",        // globals, the AUTO_* budget, the lookup epoch
  "sidebar/parse.js",        // parseFilename and the noise tables
  "sidebar/folder-hints.js", // directory names standing in for a title
  "sidebar/pins.js",         // "this folder is that show"
  "sidebar/brackets.js",     // the bracket groups a fansub supplies
  "sidebar/identify.js",     // the candidate ladder and applyShowDetail
  "sidebar/storage.js",      // URL -> episode map, and the saved card
  "sidebar/file-changed.js", // the fileChanged handler
  "sidebar/search.js",       // manual search, htmlEsc
  "sidebar/picker.js",       // season and episode pills, saveSelection
  "sidebar/settings.js",     // toggles, API key, sliders, theme  (two IIFEs)
  "sidebar/recents.js",      // recent searches and recent picks
  "sidebar/boot.js"          // last: pushes saved settings, says sidebarReady
];

test("the sidebar's load order is the one the split was made in", () => {
  const html = readRepo("sidebar.html");
  const order = [];
  let m;
  SRC_RE.lastIndex = 0;
  while ((m = SRC_RE.exec(html)) !== null) order.push(m[1]);

  assert.deepEqual(order, LOAD_ORDER,
    "sidebar.html loads the split files in a different order. The tests and the " +
    "WebView resolve it the same way, so changing it needs the hoisting " +
    "argument above re-checked, not just the list.");
});

test("boot.js stays last, because it calls into every other file", () => {
  // It reads back opacity, pause delay, theme, the skip toggle and the recents,
  // then posts sidebarReady so main.js re-emits fileChanged. Loaded earlier it
  // would post a ready signal before the handlers it depends on exist.
  const src = readRepo("sidebar/boot.js");
  for (const fn of ["paintThemePills", "renderSearches", "pruneUrlMap",
                    "pruneFolderMap", "renderRecents"]) {
    assert.ok(src.includes(fn), `boot.js no longer calls ${fn}`);
  }
});
