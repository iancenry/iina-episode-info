#!/usr/bin/env node
// Episode Info API health check.
//
// Verifies that every service the plugin depends on still behaves the way
// main.js and sidebar.html expect. Exits 0 when everything is intact, 1 when
// something has broken.
//
//   node scripts/check-apis.mjs
//
// TMDB_API_KEY is read from the environment or a local .env and is optional:
// without it the endpoints are still checked for being alive and enforcing
// auth, which is what catches a moved or retired API.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hostsInSource } from "./lib/url-hosts.mjs";
import { textFiles } from "./lib/plugin-files.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env reader so local runs need no dependencies. Real environment
// variables always win, so CI secrets are never shadowed by a stray file.
function loadDotEnv() {
  let raw;
  try { raw = readFileSync(join(ROOT, ".env"), "utf8"); } catch { return false; }
  let loaded = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded++;
  }
  return loaded;
}

const INFO = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));

// Identifies this script to the APIs it probes.
const UA = `EpisodeInfo v${INFO.version}`;
const TIMEOUT_MS = 20000;
const RETRIES = 3;
// Upstream hiccups that say nothing about the plugin being broken.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Stable, heavily-subtitled fixtures.
const TV = { tmdb: 1399, imdb: "tt0944947", name: "Game of Thrones" };
const MOVIE = { tmdb: 550, imdb: "tt0137523", name: "Fight Club" };

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  const icon = { pass: "PASS", fail: "FAIL", skip: "SKIP", warn: "WARN" }[status];
  console.log(`${icon.padEnd(4)}  ${name.padEnd(46)}  ${detail}`);
};

// --- fetch with timeout + retries, so a blip does not raise a false alarm ----
async function get(url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctl.signal,
        headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
      });
      clearTimeout(timer);
      if (RETRYABLE.has(res.status) && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json, fine */ }
      return { status: res.status, json, text, headers: res.headers };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

// A check must fail twice to count. Third-party APIs occasionally return a
// malformed 200, and a badge that cries wolf stops being read.
async function check(name, fn) {
  try {
    let out;
    try {
      out = await fn();
    } catch (first) {
      await new Promise((r) => setTimeout(r, 3000));
      out = await fn();
    }
    if (out && out.skip) record(name, "skip", out.skip);
    else if (out && out.warn) record(name, "warn", out.warn);
    else record(name, "pass", (out && out.detail) || "ok");
  } catch (err) {
    record(name, "fail", err.message);
  }
}

const need = (cond, msg) => { if (!cond) throw new Error(msg); };

// 1. Static check: every URL in the code is allow-listed in Info.json.
async function checkAllowlist() {
  const info = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));
  const allowed = new Set(info.allowedDomains || []);
  const sources = textFiles();
  const hosts = new Set();

  for (const file of sources) {
    let src;
    try { src = readFileSync(join(ROOT, file), "utf8"); } catch { continue; }
    for (const h of hostsInSource(src, /\.html$/.test(file))) hosts.add(h);
  }

  const missing = [...hosts].filter((h) => !allowed.has(h));
  need(missing.length === 0, `host(s) referenced in code but NOT in Info.json allowedDomains: ${missing.join(", ")}`);
  // And the other direction: a host on the allow-list that nothing calls is a
  // promise nothing keeps, and IINA shows these to the user as the destinations
  // the plugin can reach. Checked with the same scan as above, not a substring
  // search: a host named only in a comment satisfied "unused" for as long as
  // that weaker check was here.
  const unused = [...allowed].filter((h) => !hosts.has(h));
  need(unused.length === 0, `allowedDomains entries nothing in the code references: ${unused.join(", ")}`);
  return { detail: `${hosts.size} hosts referenced, all ${allowed.size} allow-listed and all used` };
}

// 2. TMDB, the only hard requirement. Every route the plugin uses.
async function checkTmdbRoutes() {
  const key = process.env.TMDB_API_KEY;
  const routes = [
    ["/3/search/multi", { query: TV.name }],
    ["/3/search/tv", { query: TV.name }],
    ["/3/search/movie", { query: MOVIE.name }],
    ["/3/configuration", {}],
    [`/3/tv/${TV.tmdb}`, {}],
    [`/3/tv/${TV.tmdb}/external_ids`, {}],
    // The episode-level id. main.js asks for it and falls back to the show-level
    // one, so a break here would quietly cost every episode its IMDB id.
    [`/3/tv/${TV.tmdb}/season/1/episode/1/external_ids`, {}],
    [`/3/tv/${TV.tmdb}/season/1`, {}],
    // The IMDb fast path: a filename carrying tt\d+ skips the title ladder.
    [`/3/tv/find/${TV.imdb}`, {}],
    [`/3/movie/find/${MOVIE.imdb}`, {}],
    [`/3/movie/${MOVIE.tmdb}`, {}],
    [`/3/movie/${MOVIE.tmdb}/external_ids`, {}],
  ];

  const bad = [];
  for (const [path, params] of routes) {
    const qs = new URLSearchParams({ ...params, api_key: key || "INVALID_KEY_HEALTHCHECK" });
    const r = await get(`https://api.themoviedb.org${path}?${qs}`);
    // With a key: 200. Without: 401 + TMDB's status_code 7 proves the route lives.
    const ok = key ? r.status === 200 : r.status === 401 && r.json?.status_code === 7;
    if (!ok) bad.push(`${path} -> HTTP ${r.status}${r.json?.status_message ? ` (${r.json.status_message})` : ""}`);
  }
  need(bad.length === 0, bad.join("; "));
  return { detail: key ? `${routes.length} routes returned 200` : `${routes.length} routes alive (no key: verified 401/status_code 7)` };
}

async function checkTmdbShape() {
  const key = process.env.TMDB_API_KEY;
  if (!key) return { skip: "no TMDB_API_KEY secret, so response shape not verified" };

  const search = await get(`https://api.themoviedb.org/3/search/multi?api_key=${key}&query=${encodeURIComponent(TV.name)}`);
  need(search.status === 200, `search/multi HTTP ${search.status}`);
  need(Array.isArray(search.json?.results) && search.json.results.length > 0, "search/multi returned no results array");
  const hit = search.json.results.find((r) => r.media_type === "tv" || r.media_type === "movie");
  need(hit, "no result carried media_type (sidebar.html branches on it)");
  need("id" in hit && ("name" in hit || "title" in hit), "result missing id/name/title used by the sidebar");

  // main.js resolves IMDB ids from here, and the skip-intro lookups are keyed
  // on the result.
  const ext = await get(`https://api.themoviedb.org/3/tv/${TV.tmdb}/external_ids?api_key=${key}`);
  need(ext.status === 200, `external_ids HTTP ${ext.status}`);
  need(ext.json?.imdb_id === TV.imdb, `external_ids.imdb_id was "${ext.json?.imdb_id}", expected ${TV.imdb}`);

  // Season episodes feed the episode picker, and the season's episode count and
  // air dates now also feed the "Episode 3 of 10 · Next S02E04" context line.
  const season = await get(`https://api.themoviedb.org/3/tv/${TV.tmdb}/season/1?api_key=${key}`);
  need(season.status === 200, `season HTTP ${season.status}`);
  need(Array.isArray(season.json?.episodes) && season.json.episodes.length > 0, "season.episodes missing");
  const ep = season.json.episodes[0];
  need("episode_number" in ep && "name" in ep, "episode missing episode_number/name");
  need("air_date" in ep, "episode missing air_date (the next-episode line reads it)");

  // The IMDb fast path. sidebar.html calls /find and treats a body with no id
  // as a miss, so a shape change here would silently drop every file with an
  // IMDb id back onto the title ladder.
  const found = await get(`https://api.themoviedb.org/3/tv/find/${TV.imdb}?api_key=${key}`);
  need(found.status === 200, `tv/find HTTP ${found.status}`);
  need(found.json?.id === TV.tmdb, `tv/find.id was "${found.json?.id}", expected ${TV.tmdb}`);
  need(Array.isArray(found.json?.seasons) && found.json.seasons.length > 0, "tv/find returned no seasons");
  need("name" in found.json, "tv/find missing name");
  // The season count drives the "Season 2 of 3" line.
  need(typeof found.json?.number_of_seasons === "number", "tv/find missing number_of_seasons");

  const foundMovie = await get(`https://api.themoviedb.org/3/movie/find/${MOVIE.imdb}?api_key=${key}`);
  need(foundMovie.status === 200, `movie/find HTTP ${foundMovie.status}`);
  need(foundMovie.json?.id === MOVIE.tmdb, `movie/find.id was "${foundMovie.json?.id}", expected ${MOVIE.tmdb}`);

  return { detail: `search + find (${TV.imdb}) + external_ids (${TV.imdb}) + ${season.json.episodes.length} episodes all match` };
}

async function checkTmdbImages() {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    // Still confirm the image CDN is serving at all.
    const r = await get("https://image.tmdb.org/t/p/w92/");
    need(r.status < 500, `image.tmdb.org returned HTTP ${r.status}`);
    return { skip: "no TMDB_API_KEY, so CDN reachable but poster not fetched" };
  }
  const cfg = await get(`https://api.themoviedb.org/3/configuration?api_key=${key}`);
  need(cfg.status === 200, `configuration HTTP ${cfg.status}`);
  const base = cfg.json?.images?.secure_base_url;
  // Nothing in the plugin reads secure_base_url: poster and logo URLs are built
  // from a hardcoded image.tmdb.org prefix. This asserts TMDB still serves one,
  // not that we consume it.
  need(base, "configuration.images.secure_base_url missing (TMDB no longer advertises a CDN base)");

  const tv = await get(`https://api.themoviedb.org/3/tv/${TV.tmdb}?api_key=${key}`);
  const path = tv.json?.poster_path;
  need(path, "poster_path missing");
  const img = await get(`${base}w92${path}`);
  need(img.status === 200, `poster fetch HTTP ${img.status}`);
  const ct = img.headers.get("content-type") || "";
  need(ct.startsWith("image/"), `poster content-type was "${ct}"`);
  return { detail: `${base}w92 serving images` };
}

// Every host in Info.json resolves and answers. Catches a domain move
async function checkAllowlistedHostsLive() {
  const info = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));
  const dead = [];
  for (const host of info.allowedDomains || []) {
    try {
      const r = await get(`https://${host}/`);
      if (r.status >= 500) dead.push(`${host} -> HTTP ${r.status}`);
    } catch (err) {
      dead.push(`${host} -> ${err.message}`);
    }
  }
  need(dead.length === 0, `unreachable: ${dead.join(", ")}`);
  return { detail: `${(info.allowedDomains || []).length} allow-listed hosts reachable` };
}


// Skip-intro sources. Each is optional, so this fails only when one is
//    genuinely broken or none are usable. 401/403/429 means this runner is
//    blocked: these sit behind Cloudflare, which challenges datacenter IPs
//    while serving real users normally.
async function checkSkipSources() {
  const qs = `imdb_id=${TV.imdb}&season=1&episode=1`;

  const sources = [
    { name: "IntroDB", url: `https://api.introdb.app/segments?${qs}`,
      valid: (j) => j && "intro" in j, shape: "`intro` key" },
    { name: "TheIntroDB", url: `https://api.theintrodb.org/v2/media?${qs}`,
      valid: (j) => j && (!("intro" in j) || Array.isArray(j.intro)), shape: "`intro` array" },
    { name: "SkipDB", url: `https://api.skipdb.tv/api/segments?${qs}`,
      valid: (j) => j && typeof j.segments === "object", shape: "`segments` object" },
  ];

  const ok = [], blocked = [], broken = [];
  for (const src of sources) {
    let r;
    try {
      r = await get(src.url);
    } catch (err) {
      broken.push(`${src.name} unreachable (${err.message})`);
      continue;
    }
    if ([401, 403, 429].includes(r.status)) {
      blocked.push(`${src.name} HTTP ${r.status}`);
    } else if (r.status !== 200) {
      broken.push(`${src.name} HTTP ${r.status}`);
    } else if (!src.valid(r.json)) {
      broken.push(`${src.name} response lost its ${src.shape}`);
    } else {
      ok.push(src.name);
    }
  }

  need(broken.length === 0, broken.join("; "));
  need(ok.length > 0, `no source usable from here (${blocked.join(", ")})`);

  if (blocked.length) {
    return { warn: `${ok.join(", ")} healthy; ${blocked.join(", ")} blocked from this runner, not a service fault` };
  }
  return { detail: `all ${ok.length} sources answering with the expected shape` };
}

// Anime chain: IMDB -> MyAnimeList via ARM, then AniSkip. An outage here
//    degrades anime lookups only, so blocked or unreachable warns rather
//    than fails; a changed contract still fails.
async function checkAnimeChain() {
  const ANIME = { imdb: "tt2560140", name: "Attack on Titan", mal: 16498 };
  const soft = [], hard = [];

  let mal = null;
  try {
    const arm = await get(`https://arm.haglund.dev/api/v2/imdb?id=${ANIME.imdb}&include=myanimelist`);
    if ([401, 403, 429].includes(arm.status)) soft.push(`ARM HTTP ${arm.status}`);
    else if (arm.status !== 200) hard.push(`ARM HTTP ${arm.status}`);
    else if (!Array.isArray(arm.json)) hard.push("ARM no longer returns an array");
    else {
      mal = (arm.json[0] || {}).myanimelist;
      if (!mal) hard.push(`ARM stopped mapping ${ANIME.name} to a MyAnimeList id`);
    }
  } catch (err) {
    soft.push(`ARM unreachable (${err.message})`);
  }

  try {
    const r = await get(`https://api.aniskip.com/v2/skip-times/${mal || ANIME.mal}/1?types[]=op&types[]=ed&episodeLength=0`);
    if ([401, 403, 429].includes(r.status)) soft.push(`AniSkip HTTP ${r.status}`);
    else if (r.status !== 200) hard.push(`AniSkip HTTP ${r.status}`);
    else if (!r.json || typeof r.json.found !== "boolean") hard.push("AniSkip response lost its `found` flag");
    else if (r.json.found && !Array.isArray(r.json.results)) hard.push("AniSkip `results` is no longer an array");
  } catch (err) {
    soft.push(`AniSkip unreachable (${err.message})`);
  }

  need(hard.length === 0, hard.join("; "));
  // Both providers merely unreachable is still an outage, and reporting it as a
  // warning let the daily job exit 0, which closed the tracking issue with
  // "All APIs are healthy again" while anime intro timings were dead for
  // everyone. A blocked-or-rate-limited runner stays a warning; total silence
  // does not.
  need(soft.length < 2, `both anime providers unreachable: ${soft.join("; ")}`);
  if (soft.length) return { warn: `${soft.join(", ")} with anime lookups unavailable from this runner` };
  return { detail: `ARM maps ${ANIME.name} to MAL ${mal}, AniSkip answering` };
}

// Run everything, then write the summary.
const fromDotEnv = loadDotEnv();

const KEY_NAMES = ["TMDB_API_KEY"];
const configured = KEY_NAMES.filter((k) => process.env[k]);

console.log("Episode Info API health check");
if (fromDotEnv !== false) {
  console.log(`Loaded .env (${fromDotEnv} key${fromDotEnv === 1 ? "" : "s"} set)`);
}
console.log(
  configured.length
    ? `Keys in use: ${configured.join(", ")}`
    : "No keys set, so liveness checks only. Add them to .env for full verification."
);
console.log("");

await check("Info.json allow-list covers every called host", checkAllowlist);
await check("TMDB: all routes used by the plugin", checkTmdbRoutes);
await check("TMDB: response shape (search, ids, episodes)", checkTmdbShape);
await check("TMDB: image CDN and poster paths", checkTmdbImages);
await check("Skip-intro sources (IntroDB/TheIntroDB/SkipDB)", checkSkipSources);
await check("Anime chain (ARM \u2192 AniSkip)", checkAnimeChain);
await check("All allow-listed hosts reachable", checkAllowlistedHostsLive);

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");
const skipped = results.filter((r) => r.status === "skip");

const icons = { pass: "✅", fail: "❌", skip: "⏭️", warn: "⚠️" };
const summary = [
  `## ${failed.length ? "❌ API health: FAILING" : warned.length ? "⚠️ API health: passing with warnings" : "✅ API health: all good"}`,
  "",
  `${results.length - failed.length - skipped.length - warned.length} passed · ${failed.length} failed · ${warned.length} warnings · ${skipped.length} skipped`,
  "",
  "| | Check | Detail |",
  "|:--|:--|:--|",
  ...results.map((r) => `| ${icons[r.status]} | ${r.name} | ${r.detail.replace(/\|/g, "\\|")} |`),
  "",
];

    if (skipped.length) {
  summary.push(
    "> **Skipped checks** need the `TMDB_API_KEY` repository secret to run in full. " +
    "Without it the endpoints are still proven alive and enforcing auth, " +
    "only the response shapes go unverified.",
    ""
  );
}

console.log("\n" + summary.join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n"));
}

process.exit(failed.length ? 1 : 0);
