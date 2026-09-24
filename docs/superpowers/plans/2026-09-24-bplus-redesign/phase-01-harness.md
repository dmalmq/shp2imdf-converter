# Harness and baseline

Back to [overview](overview.md).

**Goal.** A rerunnable screenshot capture of every screen the redesign touches, so every later
phase is judged as "before vs after", and fix the stale verification commands in CLAUDE.md.

**Changes.**
- A capture script next to `.cursor/skills/verify-shp2imdf/scripts/control.mjs` that reuses its
  `launch` and fixture handling, drives Upload, Wizard, Review, Export and the Illustrator
  route, and saves screenshots per screen in light/dark and EN/日本語 to an untracked folder.
- CLAUDE.md: replace `npx playwright test` (there are no specs) with the capture script, and
  document the real type gate (`-p tsconfig.app.json`, `-p tsconfig.node.json`).

**Data structures.** `CaptureManifest = { screen, theme, lang, path }[]`, written as JSON.

**Verification.** Run it twice on main; same screens and names both times; the manifest lists
every route. Baseline captured from main before phase 2 merges.
