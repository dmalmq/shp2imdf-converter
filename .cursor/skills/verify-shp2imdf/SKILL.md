---
name: verify-shp2imdf
description: Drive the SHP → IMDF Converter web UI (Vite :5310 + FastAPI :8310) the way a user does — import shapefiles, wizard, review/export, Illustrator placement — and capture proof. Use when proving a UI change, checking a user path, or after touching upload, wizard, review, or illustrator screens.
---

# Verify SHP → IMDF Converter

Primary surface: the browser app at `http://localhost:5310` (title `SHP to IMDF Converter`, header `IMDF Converter`). Backend API is `http://localhost:8310`. Vite proxies `/api` to the backend, so drive the UI on 5310, not 8310. Vite's default host is `localhost`; on this Windows PC that is often `[::1]` only — Node's IPv4-first lookup of `localhost` would miss it, so the helper sets `dns.setDefaultResultOrder('verbatim')`. Do not assume `http://127.0.0.1:5310` is the same instance.

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
| App identity | heading/text `IMDF Converter`; document title `SHP to IMDF Converter` |
| Language | button `日本語` or `EN` |
| Steps | buttons `Import`, `Configure`, `Review & Export` |
| Standard import | button `Standard import` |
| IMDF-schema shapefiles | button `IMDF-schema shapefiles` |
| Shapefile file input | `input[type=file]:not(#imdf-file-input)` |
| Import | button `Import & Continue` (standard) or `Import to Review` (IMDF-schema) |
| Open archive | button `Open IMDF archive` / `#imdf-file-input` |
| Illustrator entry | button `Illustrator (.ai) → place on map` |
| Wizard save | button `Save Project Info` |
| Venue | textbox named `Venue Name *` |
| Locality | textbox named `Locality *` |
| Generate | button `Confirm & Open Review` |
| Review | buttons `Validate`, `Export`, `Download .imdf` |

Playwright in this repo: `@playwright/test` from `frontend/node_modules`. `audit-ui.mjs` is the older full-flow screenshot script; prefer `control.mjs` so doctor/cleanup/evidence stay consistent.

Cursor browser MCP is allowed when it is attached to `http://localhost:5310` and doctor already passed. Use the same names as above. Still write evidence into `artifacts/verify-shp2imdf/<feature-id>/`.

## Evidence

Directory: `artifacts/verify-shp2imdf/<feature-id>/` (gitignored). Cleanup must not delete it.

Proof standards:

- Exercise the real UI path (file picker, Import, wizard, review). Do not PATCH zustand or call `/api/import` as a stand-in for `import-shapefiles`.
- Capture the action and the result: screenshot + ARIA snapshot after the state change, plus `report.md` with URL, feature id, and entry point.
- Identity must be visible (`IMDF Converter` or the wizard/review chrome).
- Side effects: a successful import navigates to `/wizard` (standard) or `/review` (IMDF-schema / `.imdf` reopen). Confirm the URL, not only a toast.
- Import **does** create a real in-memory session and can evict the oldest of `MAX_SESSIONS` (default 5). That is a production behavior — record it; do not pretend it is a dry-run.
- Do not save, overwrite, or delete named Illustrator placements (`data/placements.db`). Opening `/illustrator` is safe; clicking Save on a named placement is not.

## Cleanup

```powershell
node .cursor/skills/verify-shp2imdf/scripts/control.mjs cleanup
```

Kills only processes listed in `.run/state.json` with `startedBackend` / `startedFrontend` true (Windows `taskkill /T /F` on that PID). Leaves an attached colleague instance running. Closes browsers the `drive` command started (those are already closed in a `finally` after each drive). Does **not** delete `artifacts/verify-shp2imdf/`.

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
