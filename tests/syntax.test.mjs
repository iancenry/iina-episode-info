import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sidebarScripts, overlayScripts, mainSource, stripComments
} from "./helpers/extract.mjs";

// A syntax error in an inline <script> is invisible until IINA loads the web
// view, and the failure surfaces as a blank panel with no useful message. This
// is the cheapest possible guard against shipping one.
function nodeCheck(label, source) {
  const dir = mkdtempSync(join(tmpdir(), "epinfo-syntax-"));
  const file = join(dir, "snippet.js");
  try {
    writeFileSync(file, source);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(
      r.status,
      0,
      `${label} failed node --check:\n${r.stderr || r.stdout}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sidebar.html scripts parse", () => {
  const bodies = sidebarScripts();
  assert.ok(bodies.length >= 1, "expected at least one script in sidebar.html");
  bodies.forEach((src, i) => nodeCheck(`sidebar.html script #${i + 1}`, src));
});

test("overlay.html inline scripts parse", () => {
  const bodies = overlayScripts();
  assert.ok(bodies.length >= 1, "expected at least one inline script in overlay.html");
  bodies.forEach((src, i) => nodeCheck(`overlay.html script #${i + 1}`, src));
});

test("main.js parses", () => {
  nodeCheck("main.js", mainSource());
});

// ── The ES5 rule, enforced ──────────────────────────────────────────
//
// IINA bundles the WebKit of the host OS, and the sidebar is one <script>
// block: a single unsupported construct anywhere in it stops the whole thing
// evaluating, taking the API-key form, the fileChanged handler and the overlay
// toggle with it. `node --check` runs on Node, where all of the below are
// perfectly legal, so it cannot see any of this.

const BANNED = [
  ["arrow function", /=>/],
  ["template literal", /`/],
  ["let", /\blet\s+[A-Za-z_$]/],
  ["const", /\bconst\s+[A-Za-z_$]/],
  ["class", /\bclass\s+[A-Za-z_$]/],
  ["async function", /\basync\s+function\b/],
  ["await", /\bawait\s/],
  ["spread or rest in a call", /\.\.\./],
  ["for...of", /\bfor\s*\([^;)]*\bof\b/],
  ["RegExp lookbehind", /\(\?<[=!]/],
  ["optional catch binding", /catch\s*\{/]
];

test("the web views stay within what the bundled WebKit can parse", () => {
  const views = [["sidebar.html", sidebarScripts()], ["overlay.html", overlayScripts()]];
  const problems = [];
  for (const [name, bodies] of views) {
    bodies.forEach((src, i) => {
      const code = stripComments(src);
      for (const [label, re] of BANNED) {
        const m = re.exec(code);
        if (m) {
          const line = code.slice(0, m.index).split("\n").length;
          problems.push(`${name} script #${i + 1} line ${line}: ${label} (${JSON.stringify(m[0])})`);
        }
      }
    });
  }
  assert.deepEqual(problems, [], `unsupported syntax in a web view:\n  ${problems.join("\n  ")}`);
});

test("main.js is allowed modern syntax", async () => {
  // The check above is deliberately web-view-only. main.js is evaluated by
  // IINA itself, not a WebView, and already uses async/await.
  const code = stripComments(mainSource());
  assert.match(code, /\basync\s+function\b/, "main.js should still use async");
});

test("the comment stripper understands strings", () => {
  // A naive stripper would mangle the "//" in a URL and read the backticks in
  // a comment as template literals.
  const src = 'var u = "https://example.com//x"; // a `comment` with => and let y\nvar v = 1;';
  const out = stripComments(src);
  assert.match(out, /https:\/\/example\.com\/\/x/);
  assert.doesNotMatch(out, /=>/);
  assert.doesNotMatch(out, /`comment`/);
  assert.match(out, /var v = 1;/);
});

test("the banned-syntax list actually fires", () => {
  // A guard that cannot fail is worse than no guard.
  for (const [label, re] of BANNED) {
    const samples = {
      "arrow function": "var f = function(){ }; var g = x => x;",
      "template literal": "var s = `hi`;",
      "let": "let x = 1;",
      "const": "const x = 1;",
      "class": "class Foo {}",
      "async function": "async function f() { }",
      "await": "async function f() { await g(); }",
      "spread or rest in a call": "f(...args);",
      "for...of": "for (var x of list) { }",
      "RegExp lookbehind": "var r = /(?<!\\d)x/;",
      "optional catch binding": "try { f(); } catch { g(); }"
    };
    assert.ok(re.test(samples[label]), `the "${label}" rule does not match its own sample`);
  }
});