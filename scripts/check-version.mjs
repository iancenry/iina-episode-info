// The version in Info.json, package.json and the main.js header must agree.
//
// A release that ships 1.4.0 in the manifest and 1.3.1 in the header produces a
// bug report naming a version nobody is running. Cheap to check, so CI checks it.
//
// This lives in a file rather than inline in the workflow because a JavaScript
// string containing ": " terminates a YAML plain scalar. The first version of
// this check was inline, and GitHub rejected the whole workflow file over it —
// which reported as a failed run with no steps, indistinguishable from a broken
// suite.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const main = readFileSync(join(ROOT, "main.js"), "utf8");

// Machine-readable in the header so this does not have to guess at prose.
const header = /@version\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(main);

const found = {
  "Info.json": manifest.version,
  "package.json": pkg.version,
  "main.js": header ? header[1] : null
};

const distinct = [...new Set(Object.values(found))];
if (distinct.length === 1 && distinct[0]) {
  console.log(`version ${distinct[0]} everywhere`);
} else {
  for (const [where, what] of Object.entries(found)) {
    console.error(`  ${where}: ${what ?? "no @version found"}`);
  }
  console.error(`version mismatch: ${Object.entries(found)
    .map(([where, what]) => `${where} is ${what ?? "missing"}`)
    .join(", ")}`);
  process.exit(1);
}
