# Recolour a station

The colour tool takes one station's shapefile folder, its File Geodatabase (`.gdb` folder), its ArcGIS Pro layer files (`.lyrx`) or project (`.aprx`), or a zip of any of them, shows how each old `color2` value maps to a new area name, and returns every file as one zip with only `color2` rewritten. Shapefiles are patched byte for byte. A geodatabase is updated in place by GDAL in a Python that has `osgeo` (ArcGIS Pro's on this PC), so its edited tables are rewritten and every other table comes back byte for byte. In a layer file or project, each unique-value renderer keyed on `color2` alone becomes six classes in the new fills, outlined in `#657678`; in a project every other member comes back unchanged. A station from the Revit/IMDF pipeline (Shinjuku, Ikebukuro) has no `color2`: its unit layers are keyed on `category`, and each such polygon renderer becomes one class per area its categories map to, by the second table in `backend/config/color_theme.json`. Its data is never edited.

## Sub-features

- `color-theme-open` reaches `/color-theme` from the hub and shows the whole old → new table before any upload.
- `color-theme-check` reads an uploaded station and shows the rows each rule changes, the layers, and what stays as it is.
- `color-theme-attention` lists the values the table does not know and the new values that do not fit the field.
- `color-theme-download` downloads `<station>_new-colors.zip` and moves the stage track to `Deliver`.
- `color-theme-gdb` does the same for a zipped geodatabase: its feature classes in the tables, widths in characters, the geodatabase paragraph under `What comes back`, and the stale lock files left out.
- `color-theme-symbology` does it for a zip of a layer file and two projects: the `Symbology` section with the field each layer is coloured by, renderers left alone under `Needs attention`, and the layer-file paragraphs under `What comes back`.
- `color-theme-category` checks a station that has `category` and no `color2`: nothing to rewrite, and the summary says the colours live in its layer file or project.

## How to get to it (user POV)

- On the hub (`/`), under `Tools` below the drop zone, choose `Recolour a station`.
- Open `/color-theme` directly.
- On the page, drop the station folder, its zip, a `.lyrx` or an `.aprx` anywhere, or use `Choose folder` or `Choose file`.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- English UI.
- A station zip. `capture.mjs` builds one from `demo_station()` in `backend/tests/color_theme_fixtures.py` and saves it as `DemoSta_6677.zip`. The numbers below are that station's.
- No one-shot `drive` command yet. `capture.mjs` drives this whole path and writes the `color-theme-*` screens.

- **Enter.** From `/`, choose `Recolour a station`. Run `getByRole('button', { name: /Recolour a station/ }).click()`. URL is `/color-theme`. The `Stages` nav reads `1 · Bring in`, `2 · Check`, `3 · Deliver`.
- **Table before upload.** Heading `Recolour a station` and the table `How color2 changes` are visible, with 15 rules under `Old`, `Covered` and `New area, written to color2`. Each rule's new cell leads with the value written to `color2` (the Japanese area name), then the English area name in English and the spec name. The table is the answer to `GET /api/color-theme`.
- **Category table.** Below it, under `No color2: category → new area`, the table `How layers coloured by category are redrawn` has five rows, an area and the categories drawn as it: `改札外通路` with `walkway, ramp, road`, down to `階段・エスカレーター` with `stairs, escalator, opentobelow`. `新幹線改札内` has no row, and `vegetation` is in none.
- **Upload.** Set `[data-testid="color-theme-zip-input"]` to the zip. Wait for the heading `Recolour DemoSta_6677`. The current stage is `2 · Check`.
- **Counts.** The region `What this station gets` reads `Changes 129`, `Layers 2`, `Left as is 6`, `Files back untouched 11 / 13`. The table gains a `Rows` column: `白` reads `40` with `3 left as is`, and `進入制限あり` reads `0`.
- **Needs attention.** The region `Needs attention` lists `赤` (3 rows, not in the table) and `DemoSta_B1_Space.dbf` (3 rows, the new value does not fit `color2 (24 bytes)`). A station with nothing to report shows `Nothing needs attention` instead.
- **Layers.** Choose `Layers (2)`. Run `getByText(/^Layers \(\d+\)$/).click()`. Each row gives the path, encoding, width, changes and the rows left as is. `DemoSta_B1_Space.dbf` is `24 bytes` wide, and `階段・エスカレーター` is 30 bytes in UTF-8, so `白` stays as it is there.
- **Download.** Run `getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Download', exact: true }).click()` and wait for the browser's `download` event. The bar reads `Downloaded DemoSta_6677_new-colors.zip` (the file name appears once), the button becomes `Download again`, and the current stage is `3 · Deliver`.
- **Proof.** Screenshot the checked page and the delivered page, and record the download's suggested file name. Write `artifacts/verify-shp2imdf/color-theme/`.

### A geodatabase

Preconditions: the backend found a Python with `osgeo` at startup (`GDB_GDAL_PYTHON`, else its own, else ArcGIS Pro's `arcgispro-py3`). `capture.mjs` builds `DemoSta_3857.zip` from `demo_geodatabase()` in `backend/tests/gdb_fixtures.py` through that Python, and skips the `color-theme-gdb-*` screens with a logged reason where there is none.

- **Upload.** On the checked or delivered page, set `[data-testid="color-theme-zip-input"]` to the zip. Wait for the heading `Recolour DemoSta_3857`.
- **Counts.** `What this station gets` reads `Changes 42`, `Layers 4`, `Left as is 3` and `Geodatabases 1`. `Files back untouched` is not shown for a geodatabase, because an edited feature class changes several files and GDAL adds `.freelist` files.
- **Layers.** Each row's path is `DemoSta_3857.gdb/<feature class>`, its encoding `utf-8 · geodatabase`, and its width in characters: `254 characters`, `12 characters`, `no limit` (`DemoSta_0_Space`, width 0) and `8 characters`. `DemoSta_1_Facility` has no `color2` and is not listed.
- **Needs attention.** `赤` (2 rows) and `DemoSta_2_Space` (1 row, the new value does not fit `color2 (8 characters)`). `階段・エスカレーター` is 10 characters, so it fits the width-12 class.
- **What comes back.** Only the geodatabase paragraph (GDAL rewrites each changed row, `Shape_Area` and `Shape_Length` are recomputed, convert a copy and open it in ArcGIS Pro first), and `Left out: 2 stale geodatabase lock files.`
- **Download.** As above. The bar reads `Downloaded DemoSta_3857_new-colors.zip`. The download is the real GDAL update, not a mock.

### Layer files and projects

Preconditions: none beyond the station's. `capture.mjs` builds `DemoSta_layers.zip` from `demo_layer_files()` in `backend/tests/color_theme_fixtures.py`: `DemoSta_0_Space.lyrx` (one Tokyo layer, its 14 classes), `DemoSta.aprx` (that layer, `DemoSta_1_Space` with an extra `赤` class, `DemoSta_1_Facility` coloured by `category` with old-colour values, and `DemoSta_B1_Space` coloured by an Arcade expression on `color2`) and `DemoSta_units.aprx` (shaped like Shinjuku's: `DemoSta_1_unit` and `DemoSta_B1_unit` with its 30 `category` classes, and `DemoSta_1_fixture` with `checkin.kiosk` and `equipment`).

- **Upload.** Set `[data-testid="color-theme-zip-input"]` to the zip. Wait for the heading `Recolour DemoSta_layers`.
- **Counts.** `What this station gets` reads `Changes 0`, `Layers 0`, `Layers redrawn 5` and `Files back untouched 0 / 3`. There is no `Layers (n)` row list and the rule table has no `Rows` column, because no table carries `color2`. `capture.mjs` scrolls to the `Symbology` region before both shots.
- **Symbology.** The region `Symbology` has one card per file. `DemoSta_0_Space.lyrx` reads `Layer file` and `1 redrawn`. `DemoSta.aprx` reads `Project`, `2 redrawn · 1 left as is` and the caveat that Esri does not document editing a project outside ArcGIS Pro. Each card's `Layers (n)` is open (eight renderers or fewer), and its `Coloured by` column reads `color2` or `category`. `DemoSta_1_Space` reads `color2`, `15 → 7`, six swatches, `Redrawn` and `Kept as it was: 赤`. `DemoSta_B1_Space` reads `Coloured by an Arcade expression on color2; left as it is`. `DemoSta_units.aprx` reads `2 redrawn`; each unit layer reads `category`, `30 → 6`, five swatches (no `新幹線改札内`), `Redrawn` and `Kept as it was: vegetation`.
- **Not listed.** `DemoSta_1_Facility` and `DemoSta_1_fixture`. A renderer keyed on `category` is taken up only when it draws polygons and holds a category the table knows; fixture and amenity layers are coloured by `category` too, and are neither touched nor reported.
- **Needs attention.** `DemoSta_B1_Space` (the Arcade reason), `DemoSta_1_Space` (`赤` kept in its old class), and one line `2 layers` for `DemoSta_units.aprx` (`vegetation` kept in their old classes). Layers of one file that keep the same values share a line: Shinjuku's project shows one line for its 58 unit layers.
- **What comes back.** The layer-file paragraph (six classes, TurquoiseGray 1000 outline, old colours still listed, the 濃鼠 toilet exception) and the category paragraph (one class per area the categories belong to, data not changed, a category outside the table keeps its class). No shapefile or geodatabase paragraph. A project with only category layers shows the category paragraph alone.
- **Download.** The bar's title reads `5 layers are redrawn`. After the download it reads `Downloaded DemoSta_layers_new-colors.zip`.

### A station with `category` and no `color2`

Preconditions: none. `capture.mjs` builds `DemoUnits_6677.zip` from `demo_category_station()`: two unit tables with `name` and `category`.

- **Upload.** Set `[data-testid="color-theme-zip-input"]` to the zip. Wait for the heading `Recolour DemoUnits_6677`.
- **Summary.** `What this station gets` reads `Changes 0`, `Layers 0`, `Left as is 0`, `Files back untouched 8 / 8`, and under the counts: `No layer here has a color2 field. This station is coloured by category in its layer file or project, so drop its .lyrx or .aprx to recolour it.` A geodatabase says the same (Shinjuku's reads 529 tables, 449 of them with `category`). Tables with neither field read `No layer here has a color2 field, so there is nothing to rewrite.`
- **Download.** Disabled. The bar reads `Nothing to change` and `No layer has a color2 field.` There is no delivered screen.
- **Not shown.** The sentence is absent when a table carries `color2`, when the upload is only layer files, and when the station's own project came with it and was redrawn.

## Gotchas

- The page scrolls inside the shell and the table is taller than 1440×960, so `fullPage: true` still cuts it off. `capture.mjs` uses a 1440×1700 viewport for these screens.
- The hub's drop zone never opens this tool. It reads a station folder or zip as a shapefile import, so choose `Recolour a station` under `Tools` first.
- Nothing is stored on the server and no project appears on the hub. The files stay in the browser tab, `Download` sends them again, and a reload returns to the empty page.
- A single `.zip` is read as a zipped station and its stem names the station. A zip inside a folder upload is one more file that comes back untouched.
- The page has three file inputs. `color-theme-drop-input` is the page-wide drop zone, `color-theme-folder-input` is `Choose folder` and takes a folder path, and `color-theme-zip-input` is `Choose file`, the only one with an `accept` filter (`.zip,.lyrx,.aprx`).
- A lone `.lyrx` or `.aprx` is a file, not a station zip: the download is `<its stem>_new-colors.zip` holding it. A second run reports every renderer `Already new` and Download is disabled with `Every value is already new.`
- A category class lists only the categories the layer already drew, never the area name, because the data keeps its categories. A unit layer's `vegetation` class, and any category outside the table, keeps its own symbol and label after the area classes.
- Tokyo's project holds two unit layers keyed on `category` (`TOFROM_YAESU_1_unit`, `TOFROM_YAESU_B2_unit`) beside its 127 `color2` layers, so it reads `129 redrawn`.
- Upload the download again and `Download` is disabled. The bar reads `Nothing to change` with the reason `Rows match an old colour, but the new value does not fit color2.`, because the B1 rows are still too narrow. `Changes` is `0` and `Files back untouched` is `13 / 13`. A second run changes nothing by design.
- Japanese labels are `駅の色を新しくする`, `要確認`, `ダウンロード` and `もう一度ダウンロード`. The values written to `color2` are Japanese in both languages.
- A backend with no `osgeo` Python lists the geodatabase under `Needs attention` as one that cannot be edited on this server, and it comes back as uploaded. Shapefiles in the same upload still convert.
- A dropped `.gdb` folder sends no `*.lock` files: the page leaves them out (Tokyo's holds 1,057 of 3,022 files). A zip carries them to the server, which leaves them out of the download. The `Left out` line counts both.
