# shp2imdf-converter

Web app that converts Shapefiles into IMDF-compliant GeoJSON archives for Apple Indoor
Maps and similar platforms. FastAPI backend + React/TypeScript frontend with MapLibre
GL for review. Runs on a shared Windows PC; colleagues use it via browser with no
client install. See `README.md` for the product overview.

## Commands

```powershell
./dev.ps1            # starts backend (uvicorn --reload) and frontend (npm run dev) together
./dev.sh             # bash equivalent
```

```bash
uvicorn backend.main:app --reload --reload-dir backend --port 8310   # backend only
cd frontend && npm run dev                       # frontend only
pytest                               # testpaths = backend/tests
cd frontend && npx vitest            # frontend unit tests
cd frontend && npx tsc --noEmit -p tsconfig.app.json && npx tsc --noEmit -p tsconfig.node.json   # type gate
node .cursor/skills/verify-shp2imdf/scripts/capture.mjs --label baseline   # screenshots, see below
node audit-ui.mjs                    # UI audit helper
node audit-review.mjs                # review-screen audit helper
```

**Ports: frontend 5310, backend 8310** — deliberately off the framework defaults,
because this machine runs other projects and Vite's 5173 / FastAPI's 8000 collide
with any other Vite or uvicorn app. The two must stay in step: `frontend/vite.config.ts`
sets the dev-server port AND proxies `/api` to the backend port, `dev.ps1`/`dev.sh` pass
`--port` to uvicorn, and `CORS_ALLOWED_ORIGINS` must name the frontend port or the
browser blocks every API call. `HOST`/`PORT` in `.env.example` are documentation of what
to pass on the command line, not settings the app reads — there is no `uvicorn.run()`.

The type gate is the two `-p` runs above. `npx tsc --noEmit -p .` passes without
checking anything: `frontend/tsconfig.json` is `files: []` with project references.

There are no Playwright specs, so `npx playwright test` runs nothing. The live check
is the capture script: it drives Upload, every wizard section, Review, the
Illustrator route and the colour-theme route (`/color-theme`) in light/dark and
EN/日本語, writing PNGs and `manifest.json` to
`artifacts/captures/<label>/` (gitignored). `--frontend-port`/`--backend-port` run it on
a separate pair (a worktree beside the shared 5310/8310), `--cleanup` stops only the
servers it started. Details in `.cursor/skills/verify-shp2imdf/SKILL.md`.

`dev.ps1` spawns two `pwsh` windows and kills both on exit — if a port is still held
after a crash, check for orphaned uvicorn/node processes.

`--reload-dir backend` is load-bearing. Without it uvicorn watches the whole checkout,
including agent worktrees under `.claude/worktrees/`, so every file an agent saves restarts
the shared server; a burst of saves races the reloader and leaves it dead with
`PermissionError: [WinError 5]` from `multiprocessing.spawn`. It needs uvicorn 0.34.3 or later:
earlier versions add the working directory to the watch list even with `--reload-dir`.

## Test markers

`pyproject.toml` registers phase markers matching the build plan, so you can run a
slice of the suite:

```bash
pytest -m phase3     # wizard mapping (mapper, config, generation setup)
pytest -m phase5     # validation and export (converter, validator, autofix)
pytest -m georef     # Illustrator georeferencing (transform, zones, placement)
pytest -m colortheme # station colour theme (tables, DBF patch, upload tree, geodatabases, symbology)
pytest -m vectortiles # colour tool vector tile builds (worker logic, arcpy probe, job queue, download)
```

`phase0` generates test fixtures; `phase1`–`phase6` run foundation → polish.

## Layout

| Path | What |
|---|---|
| `backend/routers/` | FastAPI route modules |
| `backend/src/` | Conversion core: detection, mapping, generation, validation |
| `backend/src/color_theme.py`, `dbf_table.py`, `recolor.py`, `gdb.py`, `gdb_worker.py`, `cim_symbology.py`, `qgis_style.py` | Station colour-theme tool: the old → new table, DBF byte patch, upload tree, File Geodatabase worker, ArcGIS Pro symbology, QGIS and ArcGIS Pro style files |
| `backend/config/` | Server-side configuration |
| `backend/tests/` | pytest suite (phase-marked) |
| `frontend/src/` | React wizard, map view, table view |
| `tools/` | Supporting scripts |
| `shape_data/`, `data/` | Sample and working shapefile data |
| `symbology-style.db` | Symbology lookup used during generation |
| `data/placements.db` | Saved Illustrator placements (SQLite, gitignored) |

## Notes

- IMDF output is a **spec-conformant archive** — validation failures are the point of
  the validation phase, not incidental. When changing the generator, run `pytest -m phase5`
  before assuming output is still valid.
- Input shapefiles arrive per-floor from CAD/GIS workflows and are inconsistent by
  nature; detection/classification is heuristic. Prefer widening a heuristic with a new
  fixture over special-casing one dataset.
- Illustrator placement stores `rotation_deg` against **true north**; the backend subtracts
  the meridian convergence when building a projected affine. The preview runs in a local ENU
  frame for the same reason — Web Mercator is not conformal on the ellipsoid and was measured
  23 cm out. The cross-language golden fixture in `test_illustrator_georeference.py` and
  `similarity.test.ts` is what keeps the two implementations honest; if you change one, run
  both.
- Illustrator multi-floor placement: assignment is by box on the artwork preview, membership
  is `centroid ∈ box` plus an optional layer restriction, re-verified server-side at export
  (the preview filter is display-only). Linked floors share scale/rotation; dragging a floor
  unlinks it (drag = pin); frame operations touch linked floors only. With one floor the
  floor stays linked, preserving the single-floor behaviour exactly.
- Generated `.qgs` projects need **both** `<projectCrs>` and
  `<properties><SpatialRefSys><ProjectionsEnabled type="int">1</...>`. QGIS parses the
  first and then discards it unless the second says projections are on, so a project can
  name the right CRS in its XML and still open with none — which is what shipped until it
  was caught by loading the output in QGIS rather than by reading it. String assertions
  cannot see this class of bug: `test_illustrator_qgis_crs.py` ends with a test that runs
  the real PyQGIS (auto-skipped when QGIS is absent), and that is the one worth trusting.
- Reference overlays are decimated for the browser, but the tolerance is a fixed ground
  distance (`_REFERENCE_TOLERANCE_METRES`, 5 cm) because artwork gets aligned against
  them. It was once the dataset's own extent / 2000, which is fine for a one-building
  file and catastrophic for a regional extract: a 159 km station dataset produced a 79.5 m
  tolerance and every 1.2 m footprint collapsed to a triangle. Fixtures here need small
  features spread over a wide area — a single building hides this entirely, since extent
  and feature size are then the same number.
  Regional extracts are also trimmed spatially: the placement screen sends the
  station pin as a degenerate WGS84 `focus_bounds` box (`pinFocusBounds`), and
  the reader keeps only what falls within `_REFERENCE_FOCUS_MARGIN_METRES`
  (1 km) of it, pushing that box down into GDAL so distant features are never
  even read. Omitting the field keeps the untrimmed behaviour, so the upload
  endpoint stays usable on its own. The shared-PC 駅データ extract is read from
  `REFERENCE_OVERLAY_PATH` via `POST /api/reference-layers/preloaded` so pin and
  gizmo moves re-query that copy instead of re-uploading the zip. `Station_pl`
  is skipped until the operator opts in. The file picker still POSTs other
  shapefiles to `POST /api/reference-layers`.
- ODC output is one file **per floor**, and a floor routinely holds several Level
  features: 新宿 2F is ラチ内 / ラチ外 / 屋外, 1F is eight platforms plus 1F and
  1F屋外. `_write_odc2026_shapefiles` therefore accumulates rows per
  `(floor token, layer)` and writes each file once. Writing inside the level loop
  looked correct and silently destroyed data — every level of a floor rewrote the
  same `<base>_<floor>_Space.shp`, so only the last one survived (Shinjuku
  exported 152 of 458 units, and layers whose owning level lost the race kept a
  `floor_id` that was absent from `_Floor.shp`). Any per-floor lookup has the same
  trap: keep all levels of a token, and route Facility_Merge points to the level
  they actually fall in. Fixtures for a fixture-only level hid the bug further,
  because `_write_odc_layer` skips empty row sets instead of truncating the file.
- The colour-theme tool (`/color-theme`) patches `color2` bytes inside each `.dbf` and
  carries every other file through untouched. It must never round-trip a shapefile through
  geopandas or GDAL. A geopandas read→write was measured turning a C(20) field into
  C(80) and an N(4,0) holding a null into N(24,15), and the same trip drops M from
  PolygonZM, regenerates `.prj` and re-encodes the table. The values it writes are the
  new area names (改札外通路, 施設 and so on). The old and new vocabularies must stay
  disjoint, because that is what makes a second run change nothing, and
  `load_color_theme` refuses a table where they overlap. The table is
  `backend/config/color_theme.json`.
  A File Geodatabase (any folder named `*.gdb` in the upload) is the exception, because
  pyogrio cannot update one: `gdb_worker.py` runs in a Python that has GDAL's `osgeo`
  (`GDB_GDAL_PYTHON`, else this one, else ArcGIS Pro's `arcgispro-py3`, which needs no
  licence) and sets `color2` in place, with `SetFeature` on the planned FIDs, on a
  temporary copy. Never copy a geodatabase through GDAL instead (VectorTranslate drops
  metadata, `Shape_Length`/`Shape_Area`, feature datasets and aliases), and never REPACK
  (measured: it rewrote 106 tables for 64 edited and deleted the spatial and attribute
  indexes, after which a filter on `color2` raised). The guarantee is per table: a table
  without edits comes back byte for byte, and an edited row gets `Shape_Area` recomputed.
  GDAL rewrites that row's geometry too, and it groups rings by containment, so a
  clockwise ring drawn inside another (filled, to ArcGIS) would come back as a hole: Tokyo's
  0F floor lost 19% of its area that way until the worker regrouped polygons by their
  stored winding before writing. Compare `Shape_Area` before and after when touching it.
  GDB text widths count characters, not bytes, and 0 means no limit; GDAL enforces no
  width, so the planner's `too_wide` is the only guard. Stale `*.lock` files inside a
  `.gdb` are left out (Tokyo's held 1,057 of 3,022 files). Without an `osgeo` Python a
  geodatabase is reported `gdb_unavailable` and comes back as uploaded, and its tests skip.
  ArcGIS Pro layer files (`.lyrx`) and projects (`.aprx`, a zip of CIM JSON members) in
  the upload get their `color2` unique-value renderers rewritten by `cim_symbology.py`:
  one class per area, each listing the written value and every old value whose default
  rule maps to it, so data draws the same before and after conversion. Strokes keep
  their width (Tokyo draws 白 at 0.7 pt on 66 of 127 layers, 0.3 elsewhere). In a
  project every other member comes back with the same name, date, compression and bytes;
  a renderer naming `color2` with other fields or through Arcade is reported, not
  touched. Esri's own deserializer in `ArcGIS.Core.dll` parses the result without a
  licence (`backend/tests/esri_cim.py`), but it accepts unknown properties and a value
  in two classes, so it proves parsing, not rendering. `TOKYO_APRX` points the
  real-data test at a copy of the station project.
  Stations from the Revit/IMDF pipeline (Shinjuku, Ikebukuro) have no `color2`: their
  `unit` layers are drawn by a unique-value renderer on `category`. The theme's second
  table, `category_areas`, maps category to area for exactly that case, and the same
  rewrite runs from it (`_Keying` in `cim_symbology.py`; do not fork a second path).
  Three things differ on purpose. The data is never edited, so a class lists only the
  categories the renderer already drew and no written value. A category outside the
  table (`vegetation`) keeps its class and is reported. And a `category` renderer is
  taken up only when it is keyed on that field alone, draws polygons and holds a known
  category, otherwise it is neither touched nor reported: fixture and amenity layers
  are coloured by `category` too (Shinjuku has 6 such layers, Tokyo 20), and reporting
  them would bury the real findings. Tokyo's project has two such unit layers of its
  own, so it rewrites 129 members, not 127. `SHINJUKU_APRX` points a real-data test at
  a copy of Shinjuku's project (58 unit layers). A geodatabase or shapefile set with
  `category` and no `color2` has nothing to rewrite; `DatasetInfo.category_only_tables`
  is what lets the page say the colours live in the layer file or project.
  Style files are the one thing the tool adds. With `style_files=true` (the page's
  checkbox, on by default) each polygon shapefile the theme can colour gets a `<stem>.qml`
  and a `<stem>.lyrx` after its last file: classed by `color2` where the table has it as
  text, else by `category` when a row holds a category the table knows. Both writers
  (`qgis_style.py`, `layer_document` in `cim_symbology.py`) and the retheming of existing
  renderers take their class lists from `colour_classes` / `category_classes` in
  `color_theme.py`; add a value there, never in a writer, or a generated `.lyrx` stops
  being a fixed point of `retheme_document` and a second run starts rewriting the tool's
  own output. "Polygon" is the shape type in the `.shp` header (5, 15, 25) and that is all
  the tool may read of a `.shp`: no record, and never through GDAL. A `.qml` or `.lyrx`
  already there is kept and reported, never replaced. The category table is the unit
  catalogue's, so a category style or retheme needs `unit` in the layer, dataset or file
  name: Shinjuku's `_level` shapefiles are all `category = unspecified`, a word the table
  lists for units, and were once styled as restricted areas.
  The `.qml` is the QGIS-notes lesson again: it reads correctly as XML whether or not QGIS
  draws anything (drop the category whose value is empty and unknown values are simply not
  drawn), so `test_style_files_qgis.py` opens a converted download in the real QGIS and
  asks which symbol each feature gets; it skips without QGIS and is the one to trust. The
  `.lyrx` is only proven to parse (`test_cim_esri_parser.py`). ArcGIS Pro resolving
  `DATABASE=.` + `<stem>.shp` and drawing it is unverified, because `arcpy` needs a licence
  this machine does not have; do not claim more in the page copy until someone opens one.
  "Build vector tiles" (`vector_tiles=true`, off by default) runs `backend/src/build_tiles.py`
  in a Python whose `arcpy` is **licensed for the account that runs uvicorn**: `ARCPY_PYTHON`,
  else Pro's `arcgispro-py3` (`arcgis_pro.py` holds the one Program Files lookup; `gdb.py`
  shares it). Unlicensed, `import arcpy` raises "The Product License has not been initialized."
  Startup probes `arcpy.ProductInfo()` in a background thread and `GET
  /api/color-theme/vector-tiles` reports `checking` / `available` / `unavailable` with a reason
  code the page translates. Convert then answers 202 with a job id instead of the zip; refusals
  are 409 (no licence) and 400 (not exactly one `.aprx`). `tile_jobs.py` runs one build at a
  time on one thread: queued(position) → running(step of 5) → done | failed(reason), held in
  memory, folders under `TILE_JOBS_DIR` (emptied at startup, so a restart loses jobs and the
  page reports 404), pruned `TILE_JOB_TTL_HOURS` after finishing, 2 h timeout. The download is
  the converted archive's entries unchanged plus `vector_tiles/<name>.vtiles/...` and
  `vector_tiles/build_log.txt`. The worker speaks one ASCII JSON object per stdout line;
  parse those, never its prose. Before tiling it repoints data sources broken by the move at
  the same-named folder under the unpacked upload and fails naming any layer still broken.
  The worker reconfigures its own stdout and stderr to UTF-8: a pipe gets the console code page
  (cp932 on a Japanese Windows) and `-I` ignores `PYTHONIOENCODING`, so stderr once reached
  `build_log.txt` as mojibake.
  Which map and which layers are tiled is chosen on the page. A station project usually has two
  maps: Insert → Import Map of the `.mxd` adds `マップ レイヤー` beside the template's empty `マップ`.
  Inspection lists every map with its id (the `CIMPATH=` catalog path, which is also the map's
  uRI) and layer tree; the default is the only map with layers, else the one with the most, the
  first on a tie, and the page says which. A map without a layer is listed, greyed out; only a
  project where no map has one is refused up front. Convert takes `tile_map` (left out, the
  default), and the worker gets it in `layers.json` beside the layers, since the layer uRIs only
  mean anything inside that map. It finds the map by `getDefinition("V3").uRI`, else by a unique
  name with a log warning, else fails naming every map. Inspection reads each map's layer tree
  from the `.aprx`'s CIM JSON without arcpy (`tile_layers.py`: `GISProject.json` items of type
  `Map`, then `layers` uRIs down through the groups) and marks the default: drawn as saved, less
  any layer whose name, or a group's above it, matches a glob in
  `backend/config/vector_tile_exclusions.json` (case-insensitive, validated at startup; the
  first match is the one the page names). Convert takes `tile_layers`, the uRI of **every**
  layer to tile rather than a delta, so the build matches what the page showed even if the
  pattern file changed in between; left out, that map's defaults. An unknown map, a map without
  layers, layers of another map, group uRIs and an empty choice are 400s before a job exists. The
  worker gets every layer's and group's visibility in `layers.json` and sets it **in memory
  after** the repair's `aprx.save()`; nothing saves it, and nothing keeps a choice anywhere
  (no localStorage, no server state): every build starts from the uploaded project and the
  pattern file. A group left with nothing chosen is a log warning. Shutdown kills a running
  worker (`TileJobs.close` in the lifespan), since the next server empties `TILE_JOBS_DIR`.
  arcpy has no long-path support, so a job whose deepest path (the unpacked upload, or a z21
  tile under `out/tiles/<name>.vtiles`) passes 250 characters is refused up front.
  **The real arcpy path has run once**, on Shinjuku on a licensed machine, and stopped at the
  old one-map rule; nothing past opening the project has been seen. This machine is
  unlicensed, so the tests drive `fake_tile_worker.py` and a stub `arcpy`. Matching the map by
  uRI is unverified too. The tool calls, the scratch `index.gdb` in the
  output folder (the project's default geodatabase is a path on the machine it was saved on),
  whether the GP tools see `updateConnectionProperties`, metadata and `layer.visible` changes
  made in memory, and the real depth of the extracted `.vtiles` tree are unverified until
  someone runs a build on a licensed machine. The capture script reaches the layer list by
  telling only the browser that tiles are available (`page.route`); the server still refuses.
