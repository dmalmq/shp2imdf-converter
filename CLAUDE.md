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
  cannot see this class of bug: `test_illustrator_qgis_crs.py` ends with a test that runs
  the real PyQGIS (auto-skipped when QGIS is absent), and that is the one worth trusting.
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
