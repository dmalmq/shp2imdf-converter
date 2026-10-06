# Recolour a station

The colour tool takes one station's shapefile folder or zip, shows how each old `color2` value maps to a new area name, and returns every file as one zip with only `color2` rewritten.

## Sub-features

- `color-theme-open` reaches `/color-theme` from the hub and shows the whole old → new table before any upload.
- `color-theme-check` reads an uploaded station and shows the rows each rule changes, the layers, and what stays as it is.
- `color-theme-attention` lists the values the table does not know and the new values that do not fit the field.
- `color-theme-download` downloads `<station>_new-colors.zip` and moves the stage track to `Deliver`.

## How to get to it (user POV)

- On the hub (`/`), under `Tools` below the drop zone, choose `Recolour a station`.
- Open `/color-theme` directly.
- On the page, drop the station folder or its zip anywhere, or use `Choose folder` or `Choose zip`.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- English UI.
- A station zip. `capture.mjs` builds one from `demo_station()` in `backend/tests/color_theme_fixtures.py` and saves it as `DemoSta_6677.zip`. The numbers below are that station's.
- No one-shot `drive` command yet. `capture.mjs` drives this whole path and writes the `color-theme-*` screens.

- **Enter.** From `/`, choose `Recolour a station`. Run `getByRole('button', { name: /Recolour a station/ }).click()`. URL is `/color-theme`. The `Stages` nav reads `1 · Bring in`, `2 · Check`, `3 · Deliver`.
- **Table before upload.** Heading `Recolour a station` and the table `How color2 changes` are visible, with 15 rules under `Old`, `Covered` and `New area, written to color2`. Each rule's new cell leads with the value written to `color2` (the Japanese area name), then the English area name in English and the spec name. The table is the answer to `GET /api/color-theme`.
- **Upload.** Set `[data-testid="color-theme-zip-input"]` to the zip. Wait for the heading `Recolour DemoSta_6677`. The current stage is `2 · Check`.
- **Counts.** The region `What this station gets` reads `Changes 129`, `Layers 2`, `Left as is 6`, `Files back untouched 11 / 13`. The table gains a `Rows` column: `白` reads `40` with `3 left as is`, and `進入制限あり` reads `0`.
- **Needs attention.** The region `Needs attention` lists `赤` (3 rows, not in the table) and `DemoSta_B1_Space.dbf` (3 rows, the new value does not fit `color2 (24 bytes)`). A station with nothing to report shows `Nothing needs attention` instead.
- **Layers.** Choose `Layers (2)`. Run `getByText(/^Layers \(\d+\)$/).click()`. Each row gives the path, encoding, width, changes and the rows left as is. `DemoSta_B1_Space.dbf` is `24 bytes` wide, and `階段・エスカレーター` is 30 bytes in UTF-8, so `白` stays as it is there.
- **Download.** Run `getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Download', exact: true }).click()` and wait for the browser's `download` event. The bar reads `Downloaded DemoSta_6677_new-colors.zip` (the file name appears once), the button becomes `Download again`, and the current stage is `3 · Deliver`.
- **Proof.** Screenshot the checked page and the delivered page, and record the download's suggested file name. Write `artifacts/verify-shp2imdf/color-theme/`.

## Gotchas

- The page scrolls inside the shell and the table is taller than 1440×960, so `fullPage: true` still cuts it off. `capture.mjs` uses a 1440×1700 viewport for these screens.
- The hub's drop zone never opens this tool. It reads a station folder or zip as a shapefile import, so choose `Recolour a station` under `Tools` first.
- Nothing is stored on the server and no project appears on the hub. The files stay in the browser tab, `Download` sends them again, and a reload returns to the empty page.
- A single `.zip` is read as a zipped station and its stem names the station. A zip inside a folder upload is one more file that comes back untouched.
- The page has three file inputs. `color-theme-drop-input` is the page-wide drop zone, `color-theme-folder-input` is `Choose folder` and takes a folder path, and `color-theme-zip-input` is `Choose zip`, the only one with an `accept` filter.
- Upload the download again and `Download` is disabled. The bar reads `Nothing to change` with the reason `Rows match an old colour, but the new value does not fit color2.`, because the B1 rows are still too narrow. `Changes` is `0` and `Files back untouched` is `13 / 13`. A second run changes nothing by design.
- Japanese labels are `駅の色を新しくする`, `要確認`, `ダウンロード` and `もう一度ダウンロード`. The values written to `color2` are Japanese in both languages.
