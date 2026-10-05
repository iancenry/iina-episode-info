// The allow-list scan in scripts/check-apis.mjs. It exists to make the README's
// promise true: the build fails if the code calls a host that is not in
// Info.json. A scan that misses hosts passes just as happily as one that is
// correct, so the scan itself is tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hostsInSource } from "../scripts/lib/url-hosts.mjs";
import { textFiles } from "../scripts/lib/plugin-files.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a URL inside a script is found", () => {
  const src = '<script>\nfetch("https://api.example.com/3/search");\n</script>';
  assert.deepEqual([...hostsInSource(src, true)], ["api.example.com"]);
});

test("a URL reached through a variable is found", () => {
  // The reason the scan stopped matching call sites: this passed every version
  // of a check that looked for URLs written inside a fetch call.
  const src = '<script>\nvar u = "https://tracker.example.com/collect";\niina.http.get(u, {});\n</script>';
  assert.deepEqual([...hostsInSource(src, true)], ["tracker.example.com"]);
});

test("comparisons in the script are not mistaken for an open tag", () => {
  // How the scan came to see 2 hosts where the code calls 7, while reporting
  // success: deciding "is this URL inside a tag?" by looking for a "<" with no
  // ">" after it cannot tell markup from JavaScript, and "i < n" is on every
  // loop in this code. Note the URL comes first, before any comparison, and is
  // still expected here to survive: only the reverse order is guaranteed.
  const src = [
    '<a href="https://themoviedb.org">TMDB</a>',
    "<script>",
    'iina.http.get("https://api.introdb.app/segments", {',
    "  onSuccess: function (r) { for (var i = 0; i < r.length; i++) { } }",
    "});",
    "</script>"
  ].join("\n");
  assert.deepEqual([...hostsInSource(src, true)], ["api.introdb.app"]);
});

test("an href is not an outbound request", () => {
  const src = '<a href="https://www.themoviedb.org/">This product uses TMDB</a><script>var x=1;</script>';
  assert.deepEqual([...hostsInSource(src, true)], []);
});

test("a src or action attribute is an outbound request", () => {
  const src = '<script src="https://cdn.example.com/a.js"></script><form action="https://api.example.com/go"></form>';
  assert.deepEqual([...hostsInSource(src, true)].sort(), ["api.example.com", "cdn.example.com"]);
});

test("a .js file is scanned whole", () => {
  const src = 'for (var i = 0; i < 3; i++) { iina.http.get("https://api.example.com/x"); }';
  assert.deepEqual([...hostsInSource(src, false)], ["api.example.com"]);
});

test("a port is not a different host", () => {
  assert.deepEqual([...hostsInSource('"https://api.example.com:8443/x"', false)], ["api.example.com"]);
});

test("every allow-listed host is really called by the code", () => {
  const info = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));
  const hosts = new Set();
  for (const file of textFiles()) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const h of hostsInSource(src, /\.html$/.test(file))) hosts.add(h);
  }
  const missing = info.allowedDomains.filter((h) => !hosts.has(h));
  assert.deepEqual(missing, [], `allowed but never called: ${missing.join(", ")}`);
  const notAllowed = [...hosts].filter((h) => !info.allowedDomains.includes(h));
  assert.deepEqual(notAllowed, [], `called but not allowed: ${notAllowed.join(", ")}`);
});
test("the shipped version agrees across Info.json, package.json and main.js", () => {
  // A release that ships 1.4.0 in the manifest and 1.3.1 in the header produces
  // a bug report naming a version nobody is running. This lives in a script
  // rather than inline in the workflow because a JS string containing ": "
  // terminates a YAML plain scalar, and GitHub rejected the entire workflow
  // file over one — which reported as a failed run with no steps and looked
  // exactly like a broken suite.
  const version = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8")).version;
  assert.equal(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, version,
    "package.json and Info.json disagree");
  const header = /@version\s+([0-9]+\.[0-9]+\.[0-9]+)/
    .exec(readFileSync(join(ROOT, "main.js"), "utf8"));
  assert.ok(header, "main.js has no machine-readable @version line for CI to read");
  assert.equal(header[1], version, "main.js and Info.json disagree");
});
