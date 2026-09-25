# SHP → IMDF Converter verification map

This directory is the maintained source for verifying the user-facing behavior of the SHP → IMDF Converter web app. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Doctor must pass: `node .cursor/skills/verify-shp2imdf/scripts/control.mjs doctor`.
- UI at `http://localhost:5310`, API at `http://localhost:8310`, Vite proxy `/api` → 8310. `127.0.0.1:5310` is often a miss because Vite listens on `[::1]` only.
- English UI (`localStorage.ui_language=en`). The header button shows the *next* language (`日本語` = already English).
- Tokyo Station fixtures exist at `backend/tests/fixtures/tokyo_station/` (`JRTokyoSta_B1_Space.shp` and sidecars). Run `control.mjs fixtures` if the `.shp` is missing.
- Never start a second copy on 5310/8310. Attach or launch only the missing process.
- Never drive an instance doctor did not accept as this app.
- Do not save/delete named Illustrator placements. Import *does* create a real session and can evict the oldest of five.

## Driving conventions

- Start from `/` unless the feature lists another entry.
- Prefer role and accessible name. File inputs are the exception: `input[type=file]:not(#imdf-file-input)` and `#imdf-file-input`.
- Treat every command as literal.
- One-shot: `node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive <feature-id>` for ids the helper implements.
- Restore nothing on the shared backend except by not writing placements. Sessions expire or evict on their own.

## Proof and skip reporting

- Capture action and result: screenshot + ARIA snapshot + `report.md` under `artifacts/verify-shp2imdf/<feature-id>/`.
- UI proof includes app identity (`IMDF Converter` or `SHP to IMDF Converter`).
- Mutation proof includes the URL after navigation (`/p/<sessionId>/set-up` or `/p/<sessionId>/check`).
- Record feature id and entry point on every artifact.
- An unreachable path is a fail with the unmet precondition, not a pass via another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph, then exactly four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with control.mjs`, `Gotchas`.

## Features

- [Import shapefiles](./import-shapefiles.md) covers standard shapefile import into the wizard.
- [Configure wizard](./wizard-configure.md) covers venue info, classification, and generating a draft.
- [Review and export](./review-export.md) covers validation and IMDF download.
- [Place Illustrator artwork](./illustrator-place.md) covers opening the georeference screen.
- [Open IMDF archive](./open-imdf-archive.md) covers re-opening a previous `.imdf` export.
