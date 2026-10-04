import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readRepo(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

// The web views keep their logic in inline <script> bodies with no src, so the
// only way to test them is to pull the bodies out of the HTML. External
// scripts are skipped: nothing in this repo uses them, and a src'd body would
// not be self-contained anyway.
const SCRIPT_RE = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

export function extractScripts(file) {
  const html = readRepo(file);
  const out = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) out.push(m[1]);
  if (!out.length) throw new Error(`no inline <script> bodies found in ${file}`);
  return out;
}

export function sidebarScripts() {
  return extractScripts("sidebar.html");
}

export function overlayScripts() {
  return extractScripts("overlay.html");
}

// main.js is a plain script IINA evaluates, not a web view.
export function mainSource() {
  return readRepo("main.js");
}