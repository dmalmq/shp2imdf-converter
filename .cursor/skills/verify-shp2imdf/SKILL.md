---
name: verify-shp2imdf
description: Drive the SHP → IMDF Converter web UI (Vite :5310 + FastAPI :8310) the way a user does — import shapefiles, wizard, review/export, Illustrator placement — and capture proof. Use when proving a UI change, checking a user path, or after touching upload, wizard, review, or illustrator screens.
---

# Verify SHP → IMDF Converter

Primary surface: the browser app at `http://localhost:5310` (title `SHP to IMDF Converter`, header wordmark `shp2imdf`). Backend API is `http://localhost:8310`. Vite proxies `/api` to the backend, so drive the UI on 5310, not 8310. Vite's default host is `localhost`; on this Windows PC that is often `[::1]` only — Node's IPv4-first lookup of `localhost` would miss it, so the helper sets `dns.setDefaultResultOrder('verbatim')`. Do not assume `http://127.0.0.1:5310` is the same instance.

Also exists, not the primary surface: REST under `/api/*` (health, import, session wizard, features, export, illustrator convert/placements). Unit tests (`pytest`, Vitest) and `audit-ui.mjs` / `audit-review.mjs` are not a substitute for this skill — they do not keep proof artifacts and `audit-*.mjs` assume a already-running UI.

This machine is a shared Windows workstation. Ports **5310** and **8310** are exclusive (`strictPort`, no `uvicorn.run()`). Two instances cannot run side by side without changing Vite, uvicorn `--port`, and `CORS_ALLOWED_ORIGINS` together. **Refuse to start a second copy.** Attach to a healthy existing instance, or launch only the missing process. Never kill a PID this run did not start.

## Launch

From the repo root:

```powershell
node .cursor/skills/verify-shp2imdf/scripts/control.mjs fixtures
node .cursor/skills/verify-shp2imdf/scripts/control.mjs launch
```

`fixtures` writes `backend/tests/fixtures/tokyo_station/*.shp` via `python backend/tests/generate_fixtures.py` when `JRTokyoSta_B1_Space.shp` is missing (pytest phase0 does the same).

`launch` polls until both answer:

- Backend ready: `GET http://localhost:8310/api/health` body `{"status":"ok"}`.
- Frontend ready: `GET http://localhost:5310/` HTML contains `<title>SHP to IMDF Converter</title>`.

If a port already serves this app, launch attaches and records `startedBackend` / `startedFrontend` as false. If a port is taken by something else, launch exits non-zero and does not bind another port.

A backend this skill starts is `python -m uvicorn backend.main:app --port 8310` **without** `--reload`. A frontend this skill starts is `node frontend/node_modules/vite/bin/vite.js` (same Vite config as `npm run dev`). Logs: `.run/frontend.log` plus `.err.log`. PIDs: `.run/state.json`.

Other ports (a worktree beside the shared instance): every command takes `--frontend-port N --backend-port N`. The pair gets its own state file (`.run/state-<fe>-<be>.json`) and logs, uvicorn gets `CORS_ALLOWED_ORIGINS` for that frontend, and Vite runs from a derived config written to `frontend/node_modules/.capture/` (untracked) that proxies `/api` to the chosen backend. Pass the same flags to `doctor`, `drive` and `cleanup`.

Teardown is `cleanup`, not Ctrl+C in a random terminal.

## Doctor

```powershell
node .cursor/skills/verify-shp2imdf/scripts/control.mjs doctor
```

Read-only. Fail unless every check passes:

- `/api/health` is `{"status":"ok"}`.
- `/` is this app (title `SHP to IMDF Converter`).
- Vite proxy works: `GET http://localhost:5310/api/health` is `{"status":"ok"}`.
- Tokyo Station fixture shapefile exists.
- State file, if present, matches the listening PIDs we started (stale PIDs are a warning, not a pass).

Do not drive when doctor fails.

## Drive

Read `features/README.md`, then the matching feature file. Recipes assume **English UI**. The helper sets `localStorage.ui_language = "en"` before load. If a page is already Japanese, the header button labeled `EN` switches to English (the button shows the *next* language: `日本語` means you are already in English).

Scripted harness (preferred for proof):

```powershell
node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive import-shapefiles
```

Other implemented ids: `wizard-configure`, `illustrator-open`. `review-export` and `open-imdf-archive` follow their feature files in Playwright or the Cursor browser; they are not yet one-shot `drive` commands.

Stable handles (do not use click coordinates):

| User control | Handle |
|---|---|
| App identity | top-bar wordmark `shp2imdf`; document title `SHP to IMDF Converter` |
| Language | group `Display language` (`[data-language-switch]`) holding buttons `EN` and `日本語`; the current one has `aria-pressed="true"` |
| Theme | button `Switch theme` (toggles `.dark` on `<html>`) |
| Breadcrumb | nav `Breadcrumb`: link `Projects` / station / current stage |
| Stages | nav `Stages` under the top bar: `1 · Bring in`, `2 · Set up`, `3 · Check`, `4 · Deliver` (Illustrator: `Bring in artwork`, `Name floors`, `Place on map`, `Deliver`); the current one has `aria-current="step"`, reachable ones are buttons |
| Top-bar action | the stage's primary action (e.g. `Import & Continue`) appears in the banner only while the page's own button for it is off screen; use `.first()` when clicking by name |
| Import profile | buttons `Standard`, `IMDF schema` |
| Shapefile file input | `input[type=file]:not(#imdf-file-input)` |
| Import | button `Import & Continue` (standard) or `Import to Review` (IMDF schema) |
| Open archive | card `Open IMDF archive` / `#imdf-file-input` |
| Illustrator entry | card `Illustrator artwork`; then `Choose file` / `#illustrator-georef-input` |
| Wizard sections | `Sections` nav buttons, e.g. `Venue Info`, `Summary & Generate`; the h1 names the section |
| Venue | textbox named `Venue Name*`; `Locality*` (autosaves; the top bar shows `Saved · HH:MM`, or `Not saved yet` while a required field is missing) |
| Generate | button `Generate & open Review` |
| Review | buttons `Validate`, `Export`, `Download .imdf` |

Playwright in this repo: `@playwright/test` from `frontend/node_modules`. `audit-ui.mjs` is the older full-flow screenshot script; prefer `control.mjs` so doctor/cleanup/evidence stay consistent.

Cursor browser MCP is allowed when it is attached to `http://localhost:5310` and doctor already passed. Use the same names as above. Still write evidence into `artifacts/verify-shp2imdf/<feature-id>/`.

## Evidence

Directory: `artifacts/verify-shp2imdf/<feature-id>/` (gitignored). Cleanup must not delete it.

Proof standards:

- Exercise the real UI path (file picker, Import, wizard, review). Do not PATCH zustand or call `/api/import` as a stand-in for `import-shapefiles`.
- Capture the action and the result: screenshot + ARIA snapshot after the state change, plus `report.md` with URL, feature id, and entry point.
- Identity must be visible (the `shp2imdf` top bar).
- Side effects: a successful import navigates to `/p/<sessionId>/set-up` (standard) or `/p/<sessionId>/check` (IMDF-schema / `.imdf` reopen). Confirm the URL, not only a toast.
- Import **does** create a real in-memory session and can evict the oldest of `MAX_SESSIONS` (default 5). That is a production behavior — record it; do not pretend it is a dry-run.
- Do not save, overwrite, or delete named Illustrator placements (`data/placements.db`). Opening `/illustrator` is safe; clicking Save on a named placement is not.

## Capture

```powershell
node .cursor/skills/verify-shp2imdf/scripts/capture.mjs --label baseline [--frontend-port 5420 --backend-port 8420] [--cleanup]
```

Screenshots every screen in light/dark × EN/日本語 for before/after review: the hub (as found, and again listing the project the run created), Bring in (empty, queued), each wizard section with Project & Venue filled, Summary, Review (map, after Validate, export dialog), and the Illustrator route (bring in, name floors from a generated three-page `.ai`, place, export tab). Launches or attaches like `launch`; `--cleanup` then stops only what the pair's state file owns, also when launch fails. Output replaces `artifacts/captures/<label>/` (gitignored, `--out` overrides), but only a folder that is new, empty or carries the script's `.capture-output` marker; anything else is refused: `<screen>.<theme>.<lang>.png` plus `manifest.json`, an array of `{ screen, theme, lang, path }` with `path` relative to the manifest. Theme and language are switched with the app's own toggles (theme falls back to the `.dark` class); toasts are dismissed before each shot. It creates a real import session and an Illustrator conversion, and never saves a placement.

## Cleanup

```powershell
node .cursor/skills/verify-shp2imdf/scripts/control.mjs cleanup
```

Kills only processes listed in `.run/state.json` with `startedBackend` / `startedFrontend` true (Windows `taskkill /T /F` on that PID), and only after checking that the PID's command line still carries what launch ran (uvicorn with its `--port`, or the Vite script and config); a reused PID is skipped and reported. Leaves an attached colleague instance running. Closes browsers the `drive` command started (those are already closed in a `finally` after each drive). Does **not** delete `artifacts/verify-shp2imdf/`.

After a failed iteration, run cleanup before the next launch so a half-started Vite does not hold 5310.

## Helpers

All commands from the repo root:

```powershell
node .cursor/skills/verify-shp2imdf/scripts/control.mjs help
node .cursor/skills/verify-shp2imdf/scripts/control.mjs fixtures
node .cursor/skills/verify-shp2imdf/scripts/control.mjs launch
node .cursor/skills/verify-shp2imdf/scripts/control.mjs doctor
node .cursor/skills/verify-shp2imdf/scripts/control.mjs status
node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive import-shapefiles
node .cursor/skills/verify-shp2imdf/scripts/control.mjs cleanup
```
