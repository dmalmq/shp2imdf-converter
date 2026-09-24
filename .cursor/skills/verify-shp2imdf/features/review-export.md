# Review and export

Review shows generated features on a map and in a list, runs validation, and downloads an IMDF archive (or shapefile / QGIS packages).

## Sub-features

- `review-open` shows review chrome after generate, with `Validate` and `Export`.
- `review-validate` runs validation and shows error/warning counts.
- `review-export-imdf` opens the export dialog and offers `Download .imdf`.
- `review-search` filters the feature list from the `Search...` box.

## How to get to it (user POV)

- Finish the wizard with `Generate & open Review`.
- Choose `Review & Export` in the step indicator when a session exists.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- Client is on `/review` with a generated session (`drive wizard-configure`).
- There is no one-shot `drive review-export` yet — drive with Playwright or the Cursor browser using these handles, then write `artifacts/verify-shp2imdf/review-export/`.

- **Chrome.** `Export` and `Validate` are visible. Run `getByRole('button', { name: 'Export' })` and `getByRole('button', { name: 'Validate' })`.
- **Validate.** Choose `Validate`. Run `getByRole('button', { name: 'Validate' }).click()`. Wait until the label is `Validate` again (not `Validating...`). Counts for errors and warnings appear in the bottom bar.
- **Open export.** Choose `Export`. Run `getByRole('button', { name: 'Export' }).click()`. A dialog heading `Export` appears with combobox `Format` defaulting to `IMDF (.imdf)` on a standard session.
- **Download control.** `Download .imdf` is enabled after validation has a payload (Export opens validation first if needed). Do not have to complete the file save to prove the dialog; proving the button exists is the UI contract. If you do download, the browser receives an `.imdf` archive.
- **Search.** Type `B1 Room A` in the `Search...` textbox. The list keeps the matching unit and hides unrelated names.
- **Proof.** Screenshot the export dialog with Format `IMDF (.imdf)` and `Download .imdf`, plus an ARIA snapshot. Identity: review still shows `Import` / `Configure` / `Review & Export` steps.

## Gotchas

- Review renders without the main `AppShell` header; identity is the step indicator, not `IMDF Converter` in the top-left.
- `Export` is disabled while `loading` or `validating`. Wait for features to finish loading.
- Standard sessions can also pick shapefiles / ODC2026 / QGIS; those need an export file prefix. IMDF download does not.
- QGIS export needs `QGIS_PYTHON` on this PC; skip `qgis_project` if that path is missing rather than calling it a product failure of IMDF export.
- Auto-fix mutates the session. Do not click `Auto-fix` on a colleague's session.
