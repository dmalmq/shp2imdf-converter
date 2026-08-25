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
uvicorn backend.main:app --reload --port 8310   # backend only
cd frontend && npm run dev                       # frontend only
pytest                               # testpaths = backend/tests
cd frontend && npx vitest            # frontend unit tests
npx playwright test                  # e2e
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

`dev.ps1` spawns two `pwsh` windows and kills both on exit — if a port is still held
after a crash, check for orphaned uvicorn/node processes.

## Test markers

`pyproject.toml` registers phase markers matching the build plan, so you can run a
slice of the suite:

```bash
pytest -m phase3     # wizard mapping (mapper, config, generation setup)
pytest -m phase5     # validation and export (converter, validator, autofix)
pytest -m georef     # Illustrator georeferencing (transform, zones, placement)
```

`phase0` generates test fixtures; `phase1`–`phase6` run foundation → polish.

## Layout

| Path | What |
|---|---|
| `backend/routers/` | FastAPI route modules |
| `backend/src/` | Conversion core: detection, mapping, generation, validation |
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
  cannot see this class of bug: `test_illustrator_qgis_crs.py` and `test_odc_qgis.py` each
  end with a test that runs the real PyQGIS (auto-skipped when QGIS is absent), and those
  are the ones worth trusting. Both hand-written project exports go through
  `project_document` in `backend/src/qgis_xml.py`, which emits the pair together so
  neither can lose one half.
- Reference overlays are decimated for the browser, but the tolerance is a fixed ground
  distance (`_REFERENCE_TOLERANCE_METRES`, 5 cm) because artwork gets aligned against
  them. It was once the dataset's own extent / 2000, which is fine for a one-building
  file and catastrophic for a regional extract: a 159 km station dataset produced a 79.5 m
  tolerance and every 1.2 m footprint collapsed to a triangle. Fixtures here need small
  features spread over a wide area — a single building hides this entirely, since extent
  and feature size are then the same number.
  Regional extracts are also trimmed spatially: the placement screen sends the placed
  artwork's WGS84 box as `focus_bounds`, and the reader keeps only what falls within
  `_REFERENCE_FOCUS_MARGIN_METRES` (1 km) of it, pushing that box down into GDAL so
  distant features are never even read. Omitting the field keeps the untrimmed
  behaviour, so the endpoint stays usable on its own.
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
- The open-data zip also carries `<base>_qgis.qgs` (`backend/src/odc_qgis.py`): floors as
  groups top-down, openings red, one color per Space category. It is written as XML by
  hand, so it works on machines with no QGIS — unlike the separate `/export/qgis` `.qgz`,
  which shells out to PyQGIS and 503s without it. A categorized renderer needs its values
  enumerated, so the Space codes are collected while the shapefile is written
  (`OdcQgisLayer.categories`) rather than by reading the DBF back. Adding an ODC layer
  means adding it to `FLOOR_KIND_ORDER`/`_STYLES` too; the project silently omits kinds it
  cannot order or style, which is what `test_every_odc_layer_can_be_placed_and_styled`
  guards.
  A generated project also has to say **where it opens**, or QGIS uses its own default
  extent and the station is off screen — every layer present, nothing visible. Three
  elements carry that, and all three are written from the union of the layers actually
  placed: `<mapcanvas>` (the saved view the GUI restores, and the only one a plain
  `QgsProject.read` cannot see — the probe in `test_odc_qgis.py` builds an offscreen
  `QgsMapCanvas` to check it), `DefaultViewExtent` (what QGIS opens at) and
  `PresetFullExtent` (what Zoom Full uses). The exact `ProjectViewSettings` schema came
  from making QGIS write a project with those settings and reading the XML back, not from
  guessing. A zero-area extent (one Facility point) is padded, because that is another way
  to get a blank canvas.
- `restriction` is an IMDF enum (`employeesonly` / `restricted`) that source data spells by
  hand and gets wrong: 池袋 1F ships `enpliyeesonly` while its own B1 file spells it
  correctly. Nothing validated it, so it travelled into `unit.geojson` and the ODC Space
  layer verbatim. `normalize_restriction` (`backend/src/mapper.py`) repairs near misses
  (`difflib` ratio ≥ 0.8 — typos of these two values score ≥ 0.84, unrelated words ≤ 0.46)
  and leaves anything else untouched rather than dropping it. It has to be applied at
  **both** ends: the import paths fix `properties.restriction`, and the ODC exporter
  normalizes again because it reads the raw source row first (by design, so a source value
  is never outranked) and would otherwise bypass the repair.
  What the repair cannot resolve is caught instead of exported: the `restriction_valid`
  check errors on any non-null value outside the enum, on every feature type that carries
  one (venue, building, level, unit, section — not just units). The two halves are
  deliberate. Repairing everything would mean guessing at values like `staffonly`, and
  clamping them to null would silently mark a staff-only room public, so those are reported
  for the source data to fix.
- The two shapefile profiles disagree about UUID form **on purpose**. ODC delivers bare
  hex (`_compact_uuid_columns` strips the dashes from `id`/`floor_id` in every layer, at
  the single exit point `_write_odc_layer`), because the datasets it feeds do not use the
  dashed form. The roundtrip profile does the opposite (`_canonicalize_uuid_value` writes
  the dashed form) because its ids have to match the source shapefile it writes back to.
  `export_report.json` also stays dashed: it points at the review screen, which keys
  features by session id. Only values that parse as UUIDs are touched, so a source key
  like `shop-12` keeps its dashes — they are part of what it says.
- Adding data to a session that already holds a dataset (`backend/src/append_importer.py`)
  is a *rebind*, not a merge of two feature collections. Each import pipeline mints its own
  address/venue/building/levels, so a batch's copies are dropped and every reference to them
  is redirected at the host's ids in one pass (`level_id`, `address_id`, `anchor_id`,
  `building_ids`, `unit_ids` and `metadata.__odc_level_id` — amenities, occupants and floor
  connects keep their level only in that last one). Id collisions are settled *before* the
  references are rewritten, so a reference to a reminted feature follows it.
  Levels are matched name → floor label → ordinal, in that order and for a reason: floor
  labels are not unique (新宿 2F is three levels), so "2F" cannot say which is meant while
  the name can, and a source file with no ordinal column defaults every level to 0, which
  would bind an entire batch to one host level. A tie reports `ambiguous` and asks; an
  unmatched floor refuses to commit until the caller says create or leave out, because
  inventing a floor and discarding one are both real edits.
- The standard profile appends through a **scratch session**, never by regenerating the host.
  `generate_feature_collection` rebuilds everything from source rows and wizard state, so
  running it on the host would silently discard every review-screen edit. Mapping choices are
  therefore applied by re-staging (`PATCH .../import/stage/{batch_id}`) rather than at commit:
  generation mints new level ids, so deciding levels against one plan and then regenerating
  would leave those decisions pointing at levels that no longer exist.
  A batch holding only an openings or fixtures layer used to produce nothing at all — a level's
  outline is the union of its own *units*, and with no level the generator drops every feature
  that needed one. `generate_feature_collection` now takes `level_geometry_by_ordinal`, and the
  append passes the floors the host already has.
- Appends are staged before they are applied, and layer-name collisions are **refused**, not
  renamed. `source_file` plus `source_row_index` is the key the shapefile exports write rows
  back through and the artifact directory holds one file per stem, so two layers sharing a stem
  cross-wire both. Renaming is not a safe repair either: the ODC layer type is read off the
  stem's trailing token and the floor off its first floor-shaped token, so any disambiguating
  suffix changes how the file is classified.
- A session opened from an IMDF archive has no source rows behind its features, and the
  roundtrip shapefile export only asks "is there an artifact directory?". Adding one layer to
  such a session satisfies that check, so the export stops refusing outright and starts
  producing an archive holding *only* the added layer, with the rest reported as
  `missing_source_linkage`. The stage preview warns about this before the append rather than
  leaving it to be discovered in the download. Committing an append also clears
  `session.validation`, because the stored verdict describes the dataset as it was before.
- Only part of a layer can be brought in. The three ways of choosing — by feature type and
  attribute value, by ticking rows, by drawing a box — are one state, not three: filters
  decide the baseline and `excluded_feature_ids` / `included_feature_ids` record deviations
  from it, so ticking a row does not silently rewrite a filter (and un-ticking something the
  filters already drop stores nothing). The selection travels **declaratively** and is
  re-evaluated by `select_feature_ids` at commit; `appendSelection.ts` is the same rule
  reimplemented for the preview and the live counts, and the two have to stay in step. This
  is the split the Illustrator floor assignment already uses — what the preview draws is
  never what decides.
  Levels are exempt from selection: they carry the floor decisions rather than content, and
  dropping one here would orphan whatever it holds. A floor asked for with `create` whose
  features were all left out is not created, because a bare floor is not worth adding.
- Only the rows actually taken are written to `source_feature_collection`, which is what
  makes a second pass possible: `_already_imported_rows` reads it to know what is
  outstanding. So the same layer **may** be uploaded again to collect what was left behind —
  but only if it is byte-identical to the copy in the artifact directory (`.shp` and `.dbf`
  compared), because that is the file the shapefile exports rewrite rows in and a different
  file under the same name would cross-wire them. A second pass records no new entry in
  `session.files`, so `AppendBatchSummary.file_stems` lists only the stems a batch actually
  introduced — otherwise undoing the second pass would delete the layer out from under the
  first.
- Anything that unions source geometry goes through `safe_union` (`backend/src/geometry.py`).
  Station drawings arrive with near-coincident edges and self-intersecting rings, and GEOS
  answers those with `TopologyException: side location conflict`, which crashed the request
  as a bare 500. The helper retries with each part made valid and the union snapped to a
  progressively coarser grid, then falls back to an envelope union that cannot conflict.
  It lived only in `imdf_shapefile_importer` while `generator.py` unioned raw, so the wizard
  path and the standard-profile append (which generates in a scratch session, so it unions
  the same way) both went down on data the ODC import handled fine. The regression test
  poisons `geometry.unary_union` *and* `generator.unary_union`: the first is caught and
  recovered, the second has no guard, so a union that goes back to being raw escapes and
  fails the test.
- The selection map holds a whole batch at once — 139 layers of 高輪ゲートウェイ is 18,731
  features — so two things in `AppendSelectionPanel.tsx` are load-bearing rather than
  stylistic. Which features are selected rides in MapLibre **feature-state**, not in the
  GeoJSON: re-emitting the collection with a `selected` property on every click cost 3.6 s
  each, and the source is now built once from `features` alone while an effect diffs the
  selected set and touches only what changed. And `selectionMatcher` indexes
  `includedIds`/`excludedIds` into Sets before looping: after "select none" those lists hold
  one entry per feature, and `Array.includes` per feature is quadratic — 930 ms a click on a
  full station, 61 ms once indexed. Anything that walks every candidate must build the
  matcher once and reuse it.
  Unselected geometry is drawn as **outline only**. A filled version failed twice: at normal
  opacity a batch stacks every floor of the building into an unreadable smear, and turned
  down far enough to fix that it disappeared and the map looked broken. The zero-opacity
  fill layer is still there, because a transparent fill is still hit-tested and that is what
  makes clicking a room to add it work.
- Drawing a selection box is an explicit mode, not what any drag does. Taking the map's own
  drag away meant it could never be panned, so panning to look at a building committed a box
  wherever the mouse came up — usually a tiny one that matched nothing, which read as "the
  filters stopped working" because the map was already blank. Drags under `MIN_BOX_PIXELS`
  are treated as clicks, and a box that selects nothing says so above the map instead of
  leaving it to be inferred from a count.
- Facet chips narrow *to* what is clicked. Starting from "All" and treating a click as
  un-ticking one of an implicit full set reads backwards: picking B3F off a floor list means
  you want B3F, not the other seven. Chips render neutral while "All" is active, so they do
  not promise a selection that is not there.
- Clicking a feature on the selection map picks the topmost hit **that the filters admit**,
  not the topmost hit. Every floor of a building is drawn at the same place: sampling a grid
  over 高輪ゲートウェイ B3F found several floors stacked at 28 of 63 points, and at 14 of them
  the topmost was a different floor — so with a floor filtered, roughly a fifth of clicks
  toggled a room on B2F, 4F or 7F instead. `pickableMatcher` also admits anything in
  `includedIds`, so a feature added by hand stays clickable to take back out.
  Three visual states, not two: what is coming in is amber, what the filters admit but is not
  in is blue, everything else is faint grey. With two states a deselected room dropped to the
  same grey as the twenty-five floors underneath and could not be found again to put back.
- The selection has two starting points, and the wrong default silently inverts the result.
  `base: "filters"` takes everything the filters match and treats a click as *removing* one —
  right for "this whole floor except a few". `base: "picked"` starts empty and a click *adds*
  — right for "just these twelve rooms", where the first reading imports everything **but**
  what was chosen. Switching clears `includedIds`/`excludedIds`, because a deviation means the
  opposite thing on either side. `isUnfiltered` returns false for "picked" whatever else is
  set: sending no selection at all would import the whole batch.
  Filters still only scope what *can* be picked in "picked" mode — they never put anything in.
  A drawn box changes meaning with the base too: it narrows under "filters" and adds what it
  covers under "picked", where narrowing an empty set would do nothing at all.
- The floor-assignment step asks only about floors the **selection** touches, and counts what
  it selected rather than what the batch holds. Listing every floor in the batch with its own
  total meant that after picking fourteen rooms the step still read "B2F 5206 / B1F 7821" and
  refused to commit until all twenty-odd were answered — it looked as though everything was
  coming in. `commit_append` resolves the selection *before* `_resolve_level_decisions` for
  the same reason: a floor nothing was selected from is rejected rather than demanded, so the
  API cannot insist on an answer about a floor it is not importing.
- Two datasets can both say WGS84 and disagree by most of a metre. PROJ offers exactly one
  operation for JGD2011 -> WGS84 (`JGD2011 to WGS 84 (1)`, a null transform), so GDAL treats
  them as identical, while an epoch-aware pipeline shifts by however far the plate has moved
  since epoch 2011.0. Real case: shapefiles in EPSG:6677 imported against an FME-built IMDF
  of the same building landed **83.7 cm on bearing 65 degrees** away, with a standard deviation of
  2 mm across 105 matched features and identical shapes. No reprojection setting closes that
  gap, so `measure_alignment` measures it instead, on features present in both keyed by id,
  and the caller decides whether to apply it.
  It matches on the **source rows**, not the mapped features: the standard profile mints a
  fresh UUID for everything it generates, so its output shares no ids with anything, while
  the rows behind it still carry the id the shapefile gave them. `shift_features` moves the
  geometry, the `display_point` and `metadata.__odc_geometry` together, or a feature and its
  own label end up in different places. The measurement is kept on the session
  (`coordinate_alignment`) so a later batch of genuinely new features — which by definition
  shares no ids — can still be placed. An inconsistent spread is reported rather than
  applied: a blanket shift only makes sense when the gap really is constant.
- The selection map draws the current filter; the selection accumulates across filters. Picks
  made on one floor stay in the batch when you move to the next, but stop being drawn and
  stop being clickable — otherwise the floor being worked on disappears under the ones
  already done. The count says how many are off-screen ("12 on other floors") so the total
  does not look wrong.
