# Review and export

Review shows generated features on a map and in a list, runs validation, and downloads an IMDF archive (or shapefile / QGIS packages).

## Sub-features

- `review-open` shows Check after generate: the `Before you can deliver` rail with `Check again`, and `Deliver` in the top bar.
- `review-validate` runs validation and shows error/warning counts.
- `review-export-imdf` opens Deliver (`/p/<sessionId>/deliver`) and creates the IMDF archive from its footer.
- `review-search` filters the Table view from its `Name or attribute` search box.

## How to get to it (user POV)

- Finish the wizard with `Generate & open Review`.
- Choose `Review & Export` in the step indicator when a session exists.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- Client is on `/p/<sessionId>/check` with a generated session (`drive wizard-configure`).
- There is no one-shot `drive review-export` yet — drive with Playwright or the Cursor browser using these handles, then write `artifacts/verify-shp2imdf/review-export/`.

- **Chrome.** The rail heading `Before you can deliver`, its `Check again` button, and the top bar's `Deliver` are visible. Run `getByRole('banner').getByRole('button', { name: /^Deliver/ })` and `getByRole('button', { name: 'Check again' })`.
- **Validate.** Choose `Check again`. Wait for the `Validation complete` toast. Must-fix items are the list `Must fix`; warnings are the region `Can wait`; fixes made this visit are the region `Done`, each with `Undo`.
- **Fix an issue.** A `Must fix` item's button, or a `Can wait` row's `Resolve` / `Snap` / `Show`, opens a dialog on the map. Overlaps offer `Keep A · …` / `Keep B · …` and then `Keep A and trim B`; a door off the wall offers the nearby spaces and `Snap to …`.
- **Open Deliver.** Choose `Deliver`. Run `getByRole('banner').getByRole('button', { name: /^Deliver/ }).click()` and wait for `**/p/*/deliver`. The page lists checkboxes under the regions `For Apple` and `For GIS and open data`; `IMDF archive` is checked on a standard session, `Open Data Contest 2026` on an IMDF-schema one. `What you'll get` is the list `Files`, read from the archives each format builds (`GET /export/contents`, which records nothing).
- **Create.** The footer (region `Next step`) holds the only action, `Create the output` or `Create N outputs`; each chosen output downloads as its own file. It reads the stored validation and does not run the checker; when that is out of date the status says so and offers `Check again`.
- **Search.** Choose `Table` in the map toolbar, then type `B1 Room A` in the `Name or attribute` search box. The list keeps the matching unit and hides unrelated names.
- **Proof.** Screenshot Deliver with `IMDF archive` checked and the footer's `Create the output`, plus an ARIA snapshot.

## Gotchas

- Review renders without the main `AppShell` header; identity is the step indicator, not `IMDF Converter` in the top-left.
- `Deliver` is disabled while `loading`, `validating` or a fix is running. Wait for features to finish loading.
- Standard sessions can also pick shapefiles / ODC2026 / QGIS; ODC and QGIS need a `File prefix`, which starts as the dataset's shared file stem. IMDF does not.
- QGIS export needs `QGIS_PYTHON` on this PC; skip `qgis_project` if that path is missing rather than calling it a product failure of IMDF export.
- Auto-fix and the rail's fixes mutate the session. Do not run them on a colleague's session; `Undo` restores a fix.
