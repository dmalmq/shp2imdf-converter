# Review and export

Review shows generated features on a map and in a list, runs validation, and downloads an IMDF archive (or shapefile / QGIS packages).

## Sub-features

- `review-open` shows Check after generate: the `Before you can deliver` rail with `Check again`, and `Deliver` in the top bar.
- `review-validate` runs validation and shows error/warning counts.
- `review-export-imdf` opens the export dialog and offers `Download .imdf`.
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
- **Open export.** Choose `Deliver`. Run `getByRole('banner').getByRole('button', { name: /^Deliver/ }).click()`. A dialog heading `Export` appears with combobox `Format` defaulting to `IMDF (.imdf)` on a standard session.
- **Download control.** `Download .imdf` is enabled after validation has a payload (Export opens validation first if needed). Do not have to complete the file save to prove the dialog; proving the button exists is the UI contract. If you do download, the browser receives an `.imdf` archive.
- **Search.** Choose `Table` in the map toolbar, then type `B1 Room A` in the `Name or attribute` search box. The list keeps the matching unit and hides unrelated names.
- **Proof.** Screenshot the export dialog with Format `IMDF (.imdf)` and `Download .imdf`, plus an ARIA snapshot. Identity: review still shows `Import` / `Configure` / `Review & Export` steps.

## Gotchas

- Review renders without the main `AppShell` header; identity is the step indicator, not `IMDF Converter` in the top-left.
- `Deliver` is disabled while `loading`, `validating` or a fix is running. Wait for features to finish loading.
- Standard sessions can also pick shapefiles / ODC2026 / QGIS; those need an export file prefix. IMDF download does not.
- QGIS export needs `QGIS_PYTHON` on this PC; skip `qgis_project` if that path is missing rather than calling it a product failure of IMDF export.
- Auto-fix and the rail's fixes mutate the session. Do not run them on a colleague's session; `Undo` restores a fix.
