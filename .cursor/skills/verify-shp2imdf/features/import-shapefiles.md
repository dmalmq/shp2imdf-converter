# Import shapefiles

Standard import lets a user drop per-floor shapefile components, confirm the grouped datasets, and continue into the configuration wizard with a new session.

## Sub-features

- `import-mode-standard` selects the `Standard` profile (not `IMDF schema`).
- `import-queue` accepts `.shp` / `.dbf` / `.shx` / `.prj` / `.cpg` and shows dataset chips by stem.
- `import-continue` starts import and navigates to `/wizard`.
- `import-empty` keeps Import disabled when nothing is selected.

## How to get to it (user POV)

- Open `/` (step `Import`).
- Drop files on `Drop files here or click to browse`, or click that region to use the system picker.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- English UI.
- `backend/tests/fixtures/tokyo_station/JRTokyoSta_B1_Space.shp` exists.
- One-shot: `node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive import-shapefiles`.

- **Open import.** Go to `/`. The header reads `IMDF Converter`. The `Standard` / `IMDF schema` profile switch is visible.
- **Choose standard.** Choose `Standard`. Run `getByRole('button', { name: 'Standard', exact: true }).click()`. It shows as pressed; the primary button label is `Import & Continue`.
- **Queue fixtures.** Set the dropzone input to every `tokyo_station` shapefile sidecar. Run `locator('input[type="file"]:not(#imdf-file-input)').first().setInputFiles(<paths>)`. A chip `JRTokyoSta_B1_Space` appears (also `JRTokyoSta_B1_Opening`, `JRTokyoSta_GF_Space`).
- **Import.** Choose `Import & Continue`. Run `getByRole('button', { name: 'Import & Continue' }).click()`. Wait until the URL is `/wizard`.
- **Land on wizard.** Heading `Project & Venue` and the `Venue Name*` field are visible (do not treat the section skeleton as done — Vite StrictMode remounts the wizard once).
- **Empty control.** Reload `/` with no files. The `Import & Continue` button is disabled.
- **Proof.** Capture wizard Project & Venue. Write `artifacts/verify-shp2imdf/import-shapefiles/result.png`, `result.aria.txt`, and `report.md`. Artifacts show `IMDF Converter` and `Venue Name`.

## Gotchas

- Two file inputs exist. `#imdf-file-input` is the archive reopen path; using it here opens an IMDF zip, not shapefiles.
- UI language follows the OS unless `ui_language` is `en`. Japanese labels are `インポートして次へ`. The language toggle accessible name is exactly `EN` or `日本語` — a substring match on `EN` hits `Open IMDF archive`.
- Import creates a real session and can evict the oldest of five (`MAX_SESSIONS`). Stop if a colleague is mid-wizard on this shared PC.
- The primary button is `Import & Continue`, not `Import Files` (that string is leftover in `audit-ui.mjs`).
- Wait for `/wizard`, not a fixed sleep. Large shapefiles take seconds; the tokyo_station fixture is small.
