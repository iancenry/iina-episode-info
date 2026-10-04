# NOTES

Working notes for this fork. Written 2026-10-04.

## What this is

A fork of [Zain-Imam/iina-episode-info](https://github.com/Zain-Imam/iina-episode-info)
v1.3.1 (MIT), tracked as the first commit so upstream diffs stay clean.

Upstream stopped releasing around 2026-08-14 with an open issue unanswered, and
one maintainer means a bus factor of 1. Neither mattered much — the only
reason to fork was a feature gap, not a security one.

## Why it was forked

Upstream requires a manual TMDB search for **every new file**: pick the show,
then the season, then the episode. It has no filename parsing at all. That is
fatal for the intended use — watching a new episode and expecting the card to
already be there.

The subtitle feature was not wanted and was removed rather than left dormant.

## Changes from upstream

**Added — automatic identification.** Reads the filename, derives show title
and season/episode, searches TMDB, and selects the episode with no clicks.
Handles `S01E02`, `1x02`, `Season 1 Episode 2`, multi-episode packs, and the
absolute-number anime convention. Films are detected by release year rather
than episode code, with the year weighted above vote count so a remake never
beats the original.

Two ideas do the heavy lifting:

- A **candidate ladder** — progressively shorter prefixes of the parsed title,
  stopping at the first that returns results. Release-group names ("NTb",
  "BlueMovie", "Raws") are unbounded, so enumerating them cannot work.
- The filename is **ground truth** for season/episode and film year. A cached
  entry that disagrees is stale and gets re-identified. This is also how a
  pre-title-treatment entry picks up its logo exactly once.

**Removed — all subtitle code.** OpenSubtitles, SubDL and Wyzie, ~1,300
lines, which took the `file-system` permission and the temp-directory unzip
pipeline with it. Down to three permissions: `show-osd`, `video-overlay`,
`network-request`.

**Added — title treatments.** TMDB's official wordmark replaces the text
title. For a film it stands in for the title entirely; for an episode it sits
above the episode title, which stays text because the logo belongs to the
show. Arrives via `append_to_response=images` folded into the detail request
already being made, so no extra round trip.

**Upstream bugs fixed.** `esc()` in the overlay did not escape `'` while
interpolating into a single-quoted `src` attribute — a crafted `posterUrl`
could inject markup into the overlay WebView. `info.code` / `airDate` /
`rating` reached `innerHTML` unescaped. A dead `shellQuote()` helper was
removed.

## Layout

| File | Role |
|:--|:--|
| `main.js` | IINA-side: pause handler, overlay messages, skip-intro resolution |
| `sidebar.html` | All UI and all TMDB calls — search, picker, parsing, storage |
| `overlay.html` | The card drawn over the video |
| `scripts/check-apis.mjs` | CI probe of every upstream API the plugin uses |

`sidebar.html` is the only file with meaningful logic. It holds the filename
parser, the auto-identification state machine, and everything in
`localStorage`.

## Open questions / not done

- **Skip intro is kept but is the fragile part.** It is not TMDB data —
  timings come from the file's own chapters where present, otherwise from
  IntroDB, TheIntroDB, SkipDB and ARM→AniSkip. Four community services with
  no SLA, and the author called it experimental. It is opt-in and off by
  default. Stripping it would leave a genuinely TMDB-only plugin at the cost
  of ~350 lines in `main.js`.
- **No GitHub release yet**, so the plugin cannot self-update. Needs a `.iinaplgz`
  attached to a release; `git push` cannot create one and there is no `gh` CLI
  on this machine. Currently installed via symlink.
- **TMDB attribution lives in the README only.** Their terms ask for the notice
  where the data is *displayed*, so it arguably belongs in the card too.
- **Logo coverage is uneven** and the ≥2.5:1 filter rejects some titles that do
  have a wordmark. Whether to loosen it has not been tested against real data.
- **The candidate ladder is prefix-based.** A name like
  `Show 1080p BluMovie S01E01` burns several queries before landing. Bounded
  by `AUTO_MAX_TRIES`, but not clever.

## Operational notes

- Installed by symlink for development:
  `~/Library/Application Support/com.colliderli.iina/plugins/iina-episode-info.iinaplugin-dev`
  → this directory. **Moving this folder breaks the plugin** until re-linked
  with `iina-plugin link`.
- WebView storage lives in
  `~/Library/WebKit/com.colliderli.iina/WebsiteData/Default/*/LocalStorage/localstorage.sqlite3`.
  Read it read-only to inspect what the plugin has cached.
- Storage is small and mostly bounded: ~1.2 KB per remembered file, and
  `epinfo_url_map` entries now age out after 180 days.
