import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
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

// Strip comments so a lint can look at code rather than prose.
//
// Scanned one line at a time, deliberately. Carrying string state across lines
// meant a regex literal or an apostrophe somewhere earlier could flip the
// scanner into "inside a string" and swallow the rest of the file, comments
// included, which is exactly how backticks in a comment ended up reading as
// template literals. A multi-line string cannot survive the rule this file
// enforces anyway.
export function stripComments(src) {
  const lines = String(src).split("\n");
  const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close === -1) { out.push(""); continue; }   // keep the line count
      line = line.slice(close + 2);
      inBlock = false;
    }
    let res = "";
    let quote = null;
    let j = 0;
    while (j < line.length) {
      const c = line[j];
      const d = line[j + 1];
      if (quote) {
        res += c;
        if (c === "\\") { res += line[j + 1] || ""; j += 2; continue; }
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; res += c; j++; continue; }
      if (c === "/" && d === "/") break;              // rest of line is comment
      if (c === "/" && d === "*") { inBlock = true; break; }
      res += c;
      j++;
    }
    out.push(res);
  }
  return out.join("\n");
}
