#!/bin/sh
# Regenerate the .iinaplgz for fast iteration.
#
# Never pack the repository root directly. `iina-plugin pack` zips the folder
# as it is on disk, so pointing it at the repo would include .git, todo/,
# AGENTS.md, NOTES.md and .env — the first pack built that way was deleted
# uncommitted for exactly this. Instead the shipped files are copied to a
# staging directory and that is packed.
#
# The dev install is a symlink to this directory, so IINA already loads the
# working tree; this script checks that link and reports it, then produces and
# verifies the distributable archive. Artifacts are gitignored build output.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_BIN="/Applications/IINA.app/Contents/MacOS/iina-plugin"
LINK="$HOME/Library/Application Support/com.colliderli.iina/plugins/iina-sidekick.iinaplugin-dev"

if [ ! -x "$PLUGIN_BIN" ]; then
  echo "error: iina-plugin not found at $PLUGIN_BIN" >&2
  echo "install IINA 1.4+ or adjust PLUGIN_BIN" >&2
  exit 1
fi

# The link is what IINA actually loads while developing.
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$ROOT" ]; then
  echo "dev symlink: ok"
else
  echo "dev symlink: MISSING or pointing elsewhere: $LINK" >&2
  echo "             (the plugin will fall back to a packaged copy, not this tree)" >&2
fi

# Staging: exactly what ships, nothing else.
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STAGE_ROOT"' EXIT
STAGE="$STAGE_ROOT/iina-sidekick"
mkdir -p "$STAGE"
cp "$ROOT/Info.json" "$ROOT/main.js" "$ROOT/overlay.html" "$ROOT/sidebar.html" \
   "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/"
cp -R "$ROOT/sidebar" "$STAGE/sidebar"

# Packed from inside the staging directory: that is what names the artifact
# (folder name + Info.json version) and keeps the working tree out of it.
( cd "$STAGE" && "$PLUGIN_BIN" pack . >/dev/null )
ARTIFACT="$(ls "$STAGE"/*.iinaplgz)"
NAME="$(basename "$ARTIFACT")"

LISTING="$(unzip -l "$ARTIFACT")"

# The entry file and every sidebar module must be in. A package missing one
# loads as a blank sidebar or a dead entry point, with no error anywhere.
for f in Info.json main.js overlay.html sidebar.html; do
  printf '%s\n' "$LISTING" | grep -q "[[:space:]]$f\$" || {
    echo "error: package is missing $f" >&2; exit 1; }
done
for f in "$ROOT"/sidebar/*.js; do
  rel="sidebar/$(basename "$f")"
  printf '%s\n' "$LISTING" | grep -q "[[:space:]]$rel\$" || {
    echo "error: package is missing $rel" >&2; exit 1; }
done

# Nothing local may ride along, whatever the staging list says.
if printf '%s\n' "$LISTING" | grep -Eq '\.env|\.git/|todo/|tests/|NOTES\.md|AGENTS\.md|\.DS_Store'; then
  echo "error: package contains local-only files:" >&2
  printf '%s\n' "$LISTING" | grep -E '\.env|\.git/|todo/|tests/|NOTES\.md|AGENTS\.md|\.DS_Store' >&2
  exit 1
fi

# The manifest inside must be the manifest on disk.
ZIP_VERSION="$(unzip -p "$ARTIFACT" Info.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)"
DISK_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/Info.json" | head -1)"
[ "$ZIP_VERSION" = "$DISK_VERSION" ] || {
  echo "error: packaged version $ZIP_VERSION does not match Info.json $DISK_VERSION" >&2
  exit 1; }

# Replace the previous build; artifacts live in the repo root, gitignored.
rm -f "$ROOT"/*.iinaplgz
mv "$ARTIFACT" "$ROOT/$NAME"
SIZE="$(wc -c < "$ROOT/$NAME" | tr -d ' ')"
echo "packed:      $NAME ($SIZE bytes, version $ZIP_VERSION)"
echo "for IINA:    restart it to load the current code (the symlink is live)"
