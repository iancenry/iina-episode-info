// Every file the shipped plugin executes, in load order.
//
// The sidebar's logic lives in sidebar/*.js and is pulled into sidebar.html by
// <script src>, so a check that scans source text has to read those files too.
// Discovering them from the directory rather than a hand-written list is what
// keeps the allow-list check honest: adding a file with a new outbound host
// cannot slip past it by being absent from a list someone forgot to update.
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function sidebarScripts() {
  return readdirSync(join(ROOT, "sidebar"))
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => join("sidebar", f));
}

// Paths relative to the repo root, so callers can join them onto ROOT.
export function sourceFiles() {
  return ["main.js", ...sidebarScripts(), "overlay.html"];
}

// sidebar.html itself is kept in the list: its <script src> tags name the
// split files, and the overlay's logic is still inline.
export function textFiles() {
  return [...sourceFiles(), "sidebar.html"];
}
