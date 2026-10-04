# AGENTS.md

Standing rules for AI agents working in this repository.

## Do not act without explicit approval

The owner reviews every change before it lands. Diagnose, explain, propose —
then **stop and wait**.

This applies to:

- **Editing any file** — including obvious one-liners and typo fixes
- **`git commit` and `git push`** — never proactively. If work is done but
  uncommitted at the end of a turn, say so rather than committing
- **The owner's machine** — IINA's plugin folder, preferences, WebView
  localStorage, symlinks, anything under `~/Library`
- **IINA tooling** — `iina-plugin link` / `pack` / `unlink`, `defaults write`

Read-only inspection is fine when needed to diagnose something, but say that
you are doing it.

If a bug is spotted mid-task, **report it and stop** — do not fix it
opportunistically.

## Why this rule exists

It was set after an agent committed and pushed five times on its own
initiative while the owner was only *reporting* symptoms ("it's not working,
here's the message"). Each individual fix was reasonable; the problem was
that the owner never got to accept or reject a direction. Speed is not a
substitute for consent.

The owner has also had unrequested deletions made in their IINA preferences
directory. Treat their system as off-limits by default.

## Testing

The behaviour that matters here is pure parsing logic, so it is tested with
Node rather than by hand:

- Extract the `<script>` bodies and run `node --check` for syntax
- Filename parsing and end-to-end identification are covered by mock harnesses
  (mocked `fetch`, `document`, `localStorage`, `iina`) rather than by clicking

When changing `cleanTitle`, `parseEpisodeCode`, `parseFilename`,
`titleCandidates`, `pickLogo` or `autoIdentify`, extend the parser suite
rather than reasoning about the change. Several real bugs here were only
caught by the suite — a `\b` that cannot match between `_` and `S`, a
`$`-anchored pattern defeated by trailing whitespace.

Run the full suite before proposing any parser change.

## Style

- ES5-flavoured `var` and `function`, matching the surrounding code. The
  sidebar and overlay are WebViews; do not introduce syntax the bundled
  WebKit might not have
- No build step, no dependencies, no framework
- Comments explain *why*, not *what* — see the existing `// ──` section
  headers
