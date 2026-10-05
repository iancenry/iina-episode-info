# Screenshot shot list

Five images, all PNG, all into `docs/images/`. Everything below is already
written into the README as a commented block: filename, alt text and caption
are done. Drop the file in, then tell me and I will uncomment the block.

Retina: screenshot at native resolution and do not downscale. Crop tight, keep
2x.

## 1. `card-episode.png` — the hero

**Setup**
- Theme: Classic. Shade: default 72%. Position: Center.
- Open a file that has a TMDB wordmark *and* a poster and an overview, so every
  element is populated. Severance S02E03 is the one the README already names.
- Play a few seconds in, then pause. Wait for the card (your Delay is 1s).

**Frame**
The full-width card centred over the video. Must show, top to bottom:
the wordmark, the episode title, the meta row (code · air date · rating), the
context line ("Season 2 of 2 · Episode 3 of 3 · Next S02E04 2025-03-07"), the
overview paragraph, and the poster on the right.

**Crop** card plus about 40px of video above and below. Do not include the
IINA window chrome or the macOS menu bar.

## 2. `sidebar.png` — the sidebar tab

**Setup**
- Same episode, still paused so the sidebar shows a live identification.
- Scroll to top. Widen the sidebar if the labels wrap.

**Frame**
Top to bottom: the Episode Info tab header with the ON/OFF toggle, the
"Dismiss overlay" row, the identified card for the current file (show title,
episode title, meta, context), the "Remember this folder" checkbox, "Clear
selection", the TMDB key section, the search box with GO, and the panel with
the season and episode pills.

**Crop** the sidebar only, top to bottom. This one is fine as a tall narrow
image; the README sets it to 480px wide.

**Note** if your sidebar is very tall, it is better to crop to the
identification + pills and let the README caption say so. A 3000px-tall image
reads as a scroll.

## 3. `card-film.png` — a film

**Setup**
- A film with a wordmark. The wordmark replaces the title entirely here, which
  is the whole point of this shot.
- Footloose 1984 is already in the README's table.

**Frame**
The card with: wordmark standing alone where the title would be (no show-name
line, no separate episode title), rating, release date, overview, poster.

**Crop** same as the hero.

## 4. `themes.png` — the three themes

**Setup**
- One episode with a wordmark and a poster. Same file for all three.
- Cycle Theme: Classic → Compact → Poster in the sidebar.

**Frame**
Three cards side by side, labelled underneath with the theme name. Compose
this one rather than screenshotting three times: Classic shows everything,
Compact drops the poster and overview, Poster is dominated by the artwork.

**Crop** each card to the same height so the differences line up.

**Note** if composing, do not scale the cards down far enough that the text
stops being legible. Legibility beats a tidy comparison.

## 5. `skip-pill.png` — the skip button

**Setup**
- Turn on Skip Intro & Credits.
- Play into an intro. The pill appears bottom-right, 4vw from the right edge
  and 12vh from the bottom.
- Label is "Skip Intro"; it reads "Skip Recap" or "Skip Credits" elsewhere.

**Frame**
The pill over the video. Small element in a corner of a large frame, so crop to
roughly a third of the width and keep enough video around it to show where it
sits.

**Crop** generous. This shot is about position and proportion, so a tight crop
of just the button loses the information.

## Two things to avoid

- No IINA window chrome, no macOS menu bar, no desktop. Every pixel of frame
  that is not the plugin is noise in a README.
- No file paths or your home directory in view. `/Users/iancenry/...` in a
  screenshot is both ugly and a small privacy leak on a public repo.

## When they are all in

Tell me and I will:
1. uncomment each block in README.md
2. confirm every `src` resolves to a file that exists and is not empty
3. run the suite and push
