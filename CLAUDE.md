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
- Floor ordinals in the standard flow are decided for the whole import at once
  (`detect_levels` in `detector.py`), because a mezzanine moves the floors above it.
  1F is 0 and B1F is -1 as before. `M<n>`/`M<n>F`/`M<n>FL` is a mezzanine **between
  floors n-1 and n** (中n階): Shinjuku's and Tokyo's M2F lie over 1F and under 2F, so
  1F 0, M2F 1, 2F 2, 3F 3. Every floor above a mezzanine moves up one ordinal and keeps
  its label as `short_name` ("2F" stays "2F"); M1F takes the slot above 1F, below any M2F.
  `RF`, `R`, `PH` and `屋上` are the roof: one ordinal above the top floor, outdoor.
  The generator stays one level per ordinal and takes names from `short_name`, so a
  mezzanine is its own level feature. Tokyo's own Floor table gives M2F ordinal 2, the
  same as 2F, which IMDF allows, but 43% of M2F overlaps 2F, so they can't share a plane.
  Floor-code parsing (`canonical_floor_label`) is shared with the IMDF-schema importer.
- Splitting an import by building (`backend/src/split.py`, `/p/:id/bring-in/split`) is
  opt-in: a Bring in checkbox, unticked by default, sends the operator there instead of Set
  up. It does not wait for "Needs you": each child opens at its own Bring in with the files
  it took, types and confidence copied, so an undecided file is decided there, and only by
  the building that took it. A source row goes to the drawn polygon holding its centroid, the Illustrator rule. The
  importer makes one feature per part of a multipart row, and the row is assigned whole
  (centroid of all its parts), or the shapefile export would hand a row to two buildings.
  Shapes may not overlap, and what falls outside every shape is reported, not dropped
  silently. A split that fails part way deletes the projects it already made.
  Each shape becomes a new standard project made through `create_session` from the filtered
  source features and the parent's confirmed files, named by `SessionRecord.split_from`; the
  parent is never written. Downstream (wizard, generator, validator) sees an ordinary
  project, which is the point: keep it that way rather than teaching the generator about
  buildings. IMDF-schema imports are not offered the split. A child gets its own byte copy
  of the parent's uploaded files for its stems (each project deletes its upload folder when
  it goes, so it cannot borrow the parent's); the copies still hold every building's rows,
  and the round-trip shapefile export keeps only the source rows the child's features name.
  A building can also be picked files instead of, or as well as, a shape: a row whose file a
  building picked goes to it wherever it lies, any other row falls back to the centroid rule,
  and a file may be picked by one building only. The page resolves picked groups to file
  stems and sends `files`; `assign_features` checks the stems against the import and refuses a
  file picked twice, for preview and split alike. Groups (`GET .../split/groups`) are the
  geodatabase feature datasets (`ImportedFile.feature_dataset`) and the group layers of every
  map of an `.aprx` uploaded with the import, read once at import by `read_project_layers` into
  `SessionRecord.project_groups`. A layer joins its group by data source: the same feature
  class in a `.gdb` of the same folder name, or the shapefile of that stem. Two uploaded
  geodatabases of one name (`A/Station.gdb`, `B/Station.gdb`) are kept apart by
  `ImportedFile.source_container`, the geodatabase's path within the upload; a layer goes to
  the one sharing the longest path tail with its `DATABASE=` path resolved against the
  project's folder, and to neither on a tie. A project group's id names its `.aprx`, since
  projects copied from one template reuse CIM uRIs. Shinjuku's
  `JRShinjukuSta.gdb` has no feature datasets at all (266 feature classes at the root), so its
  buildings come from the project's groups or from the page's layer filter with "Tick all shown".
  Only `.aprx` groups are read; an `.mxd` is a binary format nothing here parses without arcpy
  (Pro's Insert → Import Map turns one into an `.aprx` map). Checked on 2026-10-15 with a copy
  of `Shinjuku Station 2 local.aprx` and the 2026-10-01 `JRShinjukuSta.gdb`: 197 groups, one
  per building and floor under `ordinal_<n>` (`ordinal_-1 › JRShinjukuSta_B1` → its 5 layers),
  and splitting by them into JR新宿駅, ルミネ1 and ヨドバシカメラ generated all three. Display
  copies such as `地下背景 › 他地下階表示用ordinal_-1 › JRShinjukuSta_B1` hold a subset of the
  same layers, so the same file sits in several groups; picking two of them for one building
  is fine, for two buildings it is refused. Projects hold no whole-building group.
- The standard import reads File Geodatabases: a zipped `*.gdb` folder, or a folder upload
  whose relative paths travel in `paths` parts as on the colour page. Each feature class is an
  `ImportedFile` with `source_format="gdb"`, its stem the class name (Japanese kept, since
  detection reads the stem; prefixed with the geodatabase's name only on a clash). Reading goes
  through pyogrio's OpenFileGDB, never the osgeo worker, and opens each class's own
  `a<id>.gdbtable` (id from `GDB_SystemCatalog`): opening the geodatabase per class read every
  table header each time and took Shinjuku 186 s against 15 s. The upload-tree helpers
  (`upload_tree.py`: `gdb_root`, lock files) are shared with the colour tool. The session's
  stored upload keeps shapefile parts under their flat import names, which the shapefile
  exporter looks them up by, and each geodatabase whole under its own path. `/api/import`
  reads its own form with `FORM_PARTS` (as the colour page does): a geodatabase is more than
  Starlette's default 1,000 parts (Shinjuku's is 1,361 files).
- Two kinds of station layer are not floor plans. A feature class whose name ends in `_nw`
  (`O_3_NW`, `ShinjukuYodobashi_Camera_1_nw`) is pedestrian network and is skipped at GDB
  import with a warning. A layer named for the surroundings (`周辺`, `surrounding`, as in
  `新宿周辺_街区`) is detected as `unknown`, the type the Bring in dropdown calls "Unknown —
  decide later". It is not an IMDF type, so the generator and the exports built from it pass
  over it, and the round-trip shapefile export, which copies the uploaded files, filters it
  (`stems_left_out` in its report). Bring in lists it under "Look right" with no floor, and
  picking a real type brings it in. The dropdown once cleared the type to null for this
  option, which reset the control and put the file back under "Needs you"; null now only
  means "not detected". A type or floor changed in Bring in after generating throws the
  generated draft away (`_drop_stale_draft`, as a Set up change does), because export reads the
  generated features as they stand and once delivered a left-out file's units; renaming a
  floor keeps it. Any IMDF keyword in the name beats the unknown one, however short
  (`Station_1_surrounding_Space` is a unit); only an exact learned suffix rule outranks that.
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
  the same-named folder under the unpacked upload and fails naming any layer still broken
  that was chosen on the page; a broken layer the operator left out is only logged (Tokyo's
  `2F\背景_グレー_2F` points at a geodatabase that is in neither the upload nor the share).
  Before that, each file geodatabase the map reads from a network drive (UNC, or a drive
  `GetDriveTypeW` calls remote, as `Q:` is) is copied without its `*.lock` files to
  `out/data` and the layers pointed at the copy by editing their CIM data connection:
  Shinjuku's 943 layers on `Q:` took 5½ minutes just for `isBroken` and the build 26 min,
  against 55 s and 14½ min local. `aprx.updateConnectionProperties` is no substitute; it
  silently left 519 of 611 layers on the share. Shapefile folders on a share are not copied.
  The server stamps each build log line with the time it arrived and ends the log with a
  table of how long each step took.
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
  `Map`, then `layers` uRIs down through the groups) and marks the default: every feature layer,
  whatever visibility the project saved (Tokyo and Shinjuku save lower floors hidden), less any
  layer whose name, or a group's above it, matches a glob in
  `backend/config/vector_tile_exclusions.json` (case-insensitive, validated at startup; the
  first match is the one the page names), and less any layer whose renderer holds only
  `CIMPointSymbol`s (the CIM names no geometry type; no symbols, or mixed ones, keep it in).
  Ticking a floor group ticks everything in it, excluded layers too, so the layer list also
  offers each pattern found in the map, and "Point layers", as one tick across every floor
  (`tileLayerKinds` in `lib/tileLayers.ts`). Convert takes `tile_layers`, the uRI of **every**
  layer to tile rather than a delta, so the build matches what the page showed even if the
  pattern file changed in between; left out, that map's defaults. An unknown map, a map without
  layers, layers of another map, group uRIs and an empty choice are 400s before a job exists. The
  worker gets every layer's and group's visibility in `layers.json` and sets it **in memory
  after** the repair's `aprx.save()`; nothing saves it, and nothing keeps a choice anywhere
  (no localStorage, no server state): every build starts from the uploaded project and the
  pattern file. A group left with nothing chosen is a log warning. Shutdown kills a running
  worker (`TileJobs.close` in the lifespan), since the next server empties `TILE_JOBS_DIR`.
  Only `CIMFeatureLayer`s are listed: Tokyo's tiled map draws an empty Graphics Layer as saved,
  which failed the index with ERROR 001852 (Shinjuku's is saved hidden and built). The worker
  switches off every visible layer the plan does not name, so a basemap or graphics layer never
  reaches the GP tools. Confirmed on 2026-10-15: Tokyo then built in 10:26 (z15 9 tiles, z16 24),
  its log naming the Graphics Layer it switched off.
  The page does not follow a build itself: `TileBuildProvider` (`TileBuildMonitor.tsx`), mounted
  above the routes in `App.tsx`, polls the job and shows `TileBuildNotice` on every route until
  the operator dismisses it. Builds end minutes after Download, often with the operator elsewhere,
  and a toast that expired or a page that unmounted once made a failure silent. It keeps the job
  id and outcome in `sessionStorage`, so a reload resumes polling; that is the build's status, not
  a layer choice. A finished build is downloaded once, never again on reload.
  arcpy has no long-path support, so a job whose deepest path (the unpacked upload, or a z21
  tile under `out/tiles/<name>.vtiles`) passes 250 characters is refused up front.
  **Real builds have run** on Shinjuku on a licensed machine (#102: 15:39 with network data
  copied locally, 722 layers repointed, none broken), so the tool calls, the scratch
  `index.gdb`, map matching and the `.vtiles` layout have been seen working. The stored levels
  stop at z16 (z15 9 tiles, z16 18), most likely because Indexed tiling stops where each
  tile's data fits the vertex limit (inferred, not from Esri's docs); clients overzoom z16. The
  check therefore flags only a deepest stored level below that maxzoom; it once expected
  z15-z21 and flagged every good build. Whether the GP tools honour `layer.visible` set in
  memory has not been compared against a build with the layers saved hidden. This machine's
  Claude sessions cannot use the licence even where the operator's own terminal can, so the
  tests drive `fake_tile_worker.py` and a stub `arcpy`, and real builds go through a server
  the operator starts. The capture script reaches the layer list by
  telling only the browser that tiles are available (`page.route`); the server still refuses.
  The tile viewer (`/color-theme/tiles/:jobId`, opened in a new tab by "View tiles" once a build
  is done) reads the build's `.vtiles` folder file by file out of its `download.zip`
  (`tile_archive.py`: `GET /jobs/{id}/tiles` for the folder's name and each level's row and
  column range, `/jobs/{id}/tiles/{path}` for one file). Nothing is unpacked or kept, so the
  link dies with the job; a path is looked up in the zip's own index, so none reaches outside
  the folder. A missing tile is a bare 404 and draws as empty: Esri stores no empty tiles.
  `TileJobs.prune` closes the open zip first, or Windows refuses to delete it. Without a job id
  the page opens a `.vtiles` folder picked from disk, which is the path for tiles made by hand
  in Pro and for builds lost to a restart. Both go through one MapLibre protocol, `vtiles://`
  (`lib/vtiles.ts`), and tiles are laid out `tile/<z>/<row>/<column>.pbf`, row first. The style's
  zoom range wins over the service `root.json`'s, which wins over the levels on disk; Pro wrote
  Shinjuku's style with the source capped at z16 and the service at z15–z21, which is what the
  panel's "enlarged ×n" is for. `SHINJUKU_VTILES` points a test at a real extracted folder.
