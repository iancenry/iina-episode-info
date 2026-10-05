import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readRepo(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

// The web views keep their logic in <script> tags with no src. The sidebar's
// logic is split across sidebar/*.js and pulled in by src, the overlay's is
// still inline. Both are collected here in document order, which is the order
// the WebView itself would run them in: classic scripts share one global
// scope, so a body that calls a function declared in a later file only works
// because the later file has already been evaluated by the time the call runs.
// Resolving the src against the HTML file's own directory keeps that ordering
// honest rather than alphabetical.
const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
const SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;

export function extractScripts(file) {
  const html = readRepo(file);
  const dir = dirname(join(ROOT, file));
  const out = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const src = SRC_RE.exec(m[1] || "");
    if (src) {
      const ref = src[1];
      // A remote src would make the suite depend on the network, and would
      // also mean the shipped plugin did, which the allow-list check covers.
      if (/^(https?:)?\/\//i.test(ref)) {
        throw new Error(`${file} loads a remote script: ${ref}`);
      }
      out.push(readFileSync(join(dir, ref), "utf8"));
    } else {
      out.push(m[2]);
    }
  }
  if (!out.length) throw new Error(`no <script> tags found in ${file}`);
  return out;
}

export function sidebarScripts() {
  return extractScripts("sidebar.html");
}

export function overlayScripts() {
  return extractScripts("overlay.html");
}

// Every line of the sidebar's JavaScript, joined. For tests that assert on the
// source rather than on a rendered element, because the harness's document is a
// stub and never parses HTML.
export function sidebarSource() {
  return sidebarScripts().join("\n;\n");
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
