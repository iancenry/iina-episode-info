# Episode Info — IINA Plugin (fork)

**Episode and movie info from TMDB, shown as an overlay the moment you pause — automatically.**
Optionally, one-click skipping of intros and credits.

Fork of [Zain-Imam/iina-episode-info](https://github.com/Zain-Imam/iina-episode-info) v1.3.1 (MIT).
Two changes: it identifies what you're watching on its own, and it no longer carries subtitle code.

## What changed in this fork

### 1. Automatic identification (the main reason this fork exists)

Upstream required a manual TMDB search for every new file — pick the show, then the season, then the
episode. This fork reads the filename and does it for you.

It understands the common release conventions:

| Filename | Identified as |
|:--|:--|
| `Severance.S02E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv` | Severance — S02E03 |
| `Breaking Bad - S03E11 - 1080p.mkv` | Breaking Bad — S03E11 |
| `The.Office.US.S09E16.720p.HDTV.x264.mkv` | The Office US — S09E16 |
| `Show.Name.1x05.avi` | Show Name — S01E05 |
| `Doctor Who Season 2 Episode 7.mkv` | Doctor Who — S02E07 |
| `[SubsPlease] Frieren - 05 (1080p).mkv` | Frieren — S01E05 |
| `Attack on Titan - 12 [1080p].mkv` | Attack on Titan — S01E12 |
| `The.Matrix.1999.1080p.BluRay.x264-GRP.mkv` | The Matrix (1999) |
| `Footloose.1984.1080p.mkv` | Footloose — **1984**, not the 2011 remake |
| `1917.2019.1080p.BluRay.x264.mkv` | 1917 (2019) |

Quality/source/codec/release-group noise (`1080p`, `WEB-DL`, `DDP5.1`, `H.264`, `-NTb`,
`[SubsPlease]`, …) is stripped before searching. Among several TMDB matches it takes the
highest-voted one.

Films work too: a name with no episode code but a release year is searched as a film, and the year
is matched against TMDB so a remake never gets picked over the original.

**When it can't tell,** it says so and leaves the normal search box there — you click once instead
of four times. A name with neither an episode code nor a year is left alone rather than guessed at.

Identifications are remembered per file URL, so a replay costs nothing at all.

### 2. Subtitles removed

All OpenSubtitles / SubDL / Wyzie code is gone — about 1,300 lines. With it went the
`file-system` permission, the temporary-directory/unzip pipeline, and the shell-outs that came
with it. The plugin now holds three permissions (`show-osd`, `video-overlay`, `network-request`)
and contacts only TMDB, unless you turn on skip intro.

### 3. Upstream fixes carried over

- `overlay.html`'s `esc()` didn't escape `'`, but the poster `<img>` interpolates into a
  single-quoted attribute — a crafted `posterUrl` could inject markup into the overlay.
- Unescaped `info.code` / `info.airDate` / `info.rating` going into `innerHTML` in the sidebar.
- A dead `shellQuote()` helper that was no longer called by anything.

## Requirements

- IINA 1.4.0 or later
- macOS 12 or later
- A free TMDB API key — [get one here](https://www.themoviedb.org/settings/api)

## Installation

### Local development (symlink)

IINA can load a local folder directly as long as it's symlinked into the plugin
directory with an `.iinaplugin-dev` suffix. IINA 1.4+ ships a CLI for this at
`IINA.app/Contents/MacOS/iina-plugin`:

```sh
ln -s /Applications/IINA.app/Contents/MacOS/iina-plugin /usr/local/bin/iina-plugin
iina-plugin link /path/to/this/repo      # create the symlink
iina-plugin unlink /path/to/this/repo    # remove it
```

Edit the files, restart IINA, done — no repacking. **This is the way to run it
while developing**, and it will not auto-update.

### Distributed (GitHub, gets auto-updates)

Push this repository to GitHub, cut a release, then in IINA:
**Preferences → Plugins → Install from GitHub...** and enter `owner/repo`.
IINA's plugin manager then handles updates. This is the only install route that
auto-updates.

### One-off install from a local folder

```sh
iina-plugin pack /path/to/this/repo     # produces a .iinaplgz
```

Then double-click the `.iinaplgz`. Useful for moving the plugin to another Mac
without publishing, but it won't self-update.

## Setup

1. Open IINA → Preferences → Plugins, install the plugin.
2. Open the sidebar (⇧⌘V, or **Video → Show Video Panel**).
3. Select the **Episode Info** tab.
4. Paste your TMDB key into the orange **"TMDB API Key Required"** box and press Save.

The key is stored in the sidebar WebView's `localStorage` and is only ever sent to
`api.themoviedb.org`.

## Usage

Open a video. That's it — if the filename is recognisable the info card is already waiting.
Pause and the overlay appears after the configured delay.

Search still works the same way if you want to override what was detected, and **Recent Picks**
re-applies an identification to whatever is playing now.

## Skip intro (optional, experimental)

Turn on **Skip Intro & Credits** in the sidebar. A button appears when playback reaches an intro,
recap or credits; click it or press ⌥S. It never seeks on its own.

This feature is **not** served by TMDB. Timings come from your file's own chapter markers where
present, otherwise from four community databases — IntroDB, TheIntroDB, SkipDB and
ARM→AniSkip (anime) — queried together, preferring sources that agree. Coverage is good for
popular shows and thin for new or niche ones. Press **Search again** to retry.

## Privacy

This plugin contacts:

- `api.themoviedb.org` / `image.tmdb.org` — episode info and posters, always
- `api.introdb.app` / `api.theintrodb.org` / `api.skipdb.tv` — intro timings, only if skip intro is on
- `arm.haglund.dev` / `api.aniskip.com` — anime intro timings, only if skip intro is on

No analytics, no tracking, no telemetry. `Info.json` declares exactly these hosts and nothing
else; `npm run check` in CI fails the build if the code ever calls a host outside that list.

## Development

```sh
node scripts/check-apis.mjs        # verify every upstream API still behaves
```

Runs a daily CI job that probes each endpoint and opens (and auto-closes) an issue if one breaks.
Add `TMDB_API_KEY` to `.env` to also verify response shapes; without it the endpoints are still
proven alive and enforcing auth.

## License

MIT — see [LICENSE](LICENSE). Original work © Zain Imam.