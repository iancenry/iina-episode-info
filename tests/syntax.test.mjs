import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidebarScripts, overlayScripts, mainSource } from "./helpers/extract.mjs";

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

test("sidebar.html inline scripts parse", () => {
  const bodies = sidebarScripts();
  assert.ok(bodies.length >= 1, "expected at least one inline script in sidebar.html");
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