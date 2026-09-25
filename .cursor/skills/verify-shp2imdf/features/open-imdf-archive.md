# Open IMDF archive

Re-open lets a user pick a previously exported `.imdf` or `.zip` archive and jump straight to review, skipping the wizard.

## Sub-features

- `imdf-open-control` shows `Open IMDF archive` on Import.
- `imdf-open-file` loads an archive and navigates to `/p/<sessionId>/check`.
- `imdf-open-error` shows an error when the file is not IMDF.

## How to get to it (user POV)

- On `/`, below the `or` divider, choose `Open IMDF archive`.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- English UI.
- For `imdf-open-file`, you already have an `.imdf` produced by Review export (or a fixture archive). If you do not, report `imdf-open-file` unreachable and only prove `imdf-open-control`.
- No one-shot `drive` command yet.

- **Control.** On `/`, the button `Open IMDF archive` is enabled. Run `getByRole('button', { name: 'Open IMDF archive' })`. Helper text mentions re-opening `.imdf.zip`.
- **Picker.** Choosing the button activates `#imdf-file-input` (`accept=".imdf,.zip"`). Set that input to the archive path. Do not use the shapefile dropzone input.
- **Land on review.** Wait for `/p/<sessionId>/check`. A toast `IMDF archive opened` reports a feature count. `Export` becomes available after load.
- **Bad file.** Set `#imdf-file-input` to a non-IMDF zip. An error region appears; URL stays `/`.
- **Proof.** For the control-only path, screenshot Import showing `Open IMDF archive`. For a full open, screenshot `/p/<sessionId>/check` with a non-zero feature list and write `artifacts/verify-shp2imdf/open-imdf-archive/`.

## Gotchas

- This is a different input from the shapefile dropzone. Mixing them looks like “import did nothing” or “not an archive”.
- Client session lives in memory. Opening an archive in a second tab does not share the first tab's `sessionId`.
- Same session-cap as shapefile import: this creates a real session and can evict another.
