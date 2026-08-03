# Illustrator Georeferencing — Design

Date: 2026-08-03
Status: Approved for planning

## Problem

`.ai` artwork has no coordinate system. The converter at `POST /api/convert/illustrator`
emits a GeoPackage and QGIS project in raw PDF points, explicitly not georeferenced
(`illustrator_importer.py:14-15`). Every output therefore needs manual georeferencing in
QGIS before it is usable.

This adds a placement step to the converter: find the building on a map, position, rotate
and scale the artwork against it, then export georeferenced files.

## Goals

- Locate a building by address search and place the converted artwork on it.
- Rotate and scale interactively, with scale derived from the drawing rather than eyeballed.
- Optional control-point refinement when the basemap shows the building.
- Export georeferenced GeoPackage, shapefile set and QGIS project in a chosen CRS.
- Reuse a saved placement across the floors of one building.

## Non-goals

- Non-uniform scale, shear or rubber-sheeting. Similarity transform only; a to-scale plan
  that needs stretching is a broken input.
- Loading an existing georeferenced layer as an alignment underlay.
- Changing the IMDF/shapefile wizard flow. This is confined to the standalone converter.

## Current state

| Piece | State |
|---|---|
| `POST /api/convert/illustrator` | Stateless: upload `.ai`, receive `.zip` in the same response |
| `backend/src/illustrator_importer.py` | pdfminer walk → GeoPackage, one table per layer/geometry role |
| `backend/src/illustrator_qgis.py` | `.qgs` with data-defined colors, no CRS |
| `backend/src/shapefile_exporter.py` | Existing `ESRI Shapefile` writer with encoding handling |
| `backend/src/geocoding.py` | `NominatimGeocoder`, reachable only via session-scoped wizard routes |
| `frontend/src/pages/UploadPage.tsx` | Button → fetch → object-URL download |
| `frontend/src/components/shared/streetMapStyle.ts` | OSM raster, sole basemap |
| Deps | `pyproj`, `shapely`, `geopandas` present; `sqlite3` stdlib; no `proj4` in the frontend |

Artwork coordinates are y-up from a bottom-left origin, matching GIS axis convention. No
flip is required.

## Decisions

| Question | Decision |
|---|---|
| Placement method | Geocode search for coarse position, interactive drag/rotate/scale, optional control points |
| Basemap | OSM, GSI 全国最新写真, GSI 標準地図 — three-way switch |
| Underlay | Out of scope |
| Output | GeoPackage + `.qgs` + shapefile set, zipped |
| Output CRS | Chosen at export; defaults to the auto-detected Japan Plane Rectangular zone |
| Scale | Nominal drawing scale input *or* two-point distance calibration; both set a lock |
| State | Server caches the parsed conversion; the client sends transform parameters |
| Multi-floor | Named placements saved server-side and applied to later files |

Verified live at z17 over Tokyo: GSI `seamlessphoto` (200, 19.5 KB), GSI `std` (200,
22.7 KB), Esri World Imagery (200, 23.2 KB). GSI requires the attribution 出典：国土地理院.
Esri is not used — its tile endpoint is open but the ToS expects an ArcGIS account for
production use.

## Transform model

Anchor-relative similarity transform, four degrees of freedom:

```
[E]     [cos θ  -sin θ] [x - x0]   [E0]
[ ] = s [              ] [      ] + [  ]
[N]     [sin θ   cos θ] [y - y0]   [N0]
```

```
Transform {
  artwork_anchor:   [x0, y0]     # PDF points
  map_anchor:       [lon, lat]   # WGS84
  rotation_deg:     θ            # CCW from TRUE north at map_anchor
  metres_per_point: s
  working_crs:      "EPSG:6677"  # fixed when placement begins
}
```

Anchor-relative rather than raw affine coefficients: rotation pivots about the visible
handle, and correcting scale does not translate the drawing. Flattened at export to
`shapely.affinity.affine_transform([a, b, d, e, xoff, yoff])` with

```
θg = θ - γ                  # γ = grid bearing of true north at the anchor
a =  s·cos θg               b = -s·sin θg
d =  s·sin θg               e =  s·cos θg
xoff = E0 - s(x0·cos θg - y0·sin θg)
yoff = N0 - s(x0·sin θg + y0·cos θg)
```

where `(E0, N0)` is `map_anchor` projected into `working_crs`.

### Rotation is measured from true north

Rotation is defined CCW from **true north at the anchor**, not from any projection's grid
north. Grid north differs from true north by the meridian convergence, `+0.0776°` in JPR
zone IX at Tokyo. The backend subtracts that convergence when flattening to a
`working_crs` affine; `θ` itself is projection-independent, which is what makes a saved
placement portable and the preview frame agree with the export frame.

This was measured, not assumed. Defining `θ` in grid north while previewing in a
true-north frame put a 59 m artwork **8.00 cm** out and a 2.4 km site **297 cm** out.

### Why working_crs is separate from output_crs

`working_crs` is the metric frame geometry is built in. Re-fitting a placement into a
different CRS would move geometry, so the pipeline is: fit in `working_crs` → build
geometry → reproject the geometry to `output_crs`. The export CRS control therefore
changes only the output file's declared CRS and can never move the building.

### Inputs

Every editor writes the same four fields.

| Editor | Writes |
|---|---|
| Geocode search | `map_anchor` = result lon/lat. `artwork_anchor` defaults once to the centroid of `artwork_bounds` and is not recomputed afterwards. |
| Drag | `map_anchor` |
| Rotate handle | `rotation_deg`; shift snaps to multiples of 15°, and a reset control returns it to 0° |
| Scale handle | `metres_per_point`; disabled while locked |
| Drawing scale `1:N` | `metres_per_point = (25.4/72)·(N/1000)`; sets lock |
| Distance calibration | Two clicks on the rendered overlay, back-projected through the current transform into artwork points, plus the real distance in metres; sets lock |
| Control points | All four via least squares |

### Control-point fit

With artwork points `p_i`, target points `q_i` and centroids `p̄`, `q̄`, the 4-parameter
Helmert fit has a closed form in complex numbers:

```
s·e^(iθ) = Σ (q_i - q̄)·conj(p_i - p̄) / Σ |p_i - p̄|²
```

with anchors at the centroids. Requires `n ≥ 2`.

When scale is locked — the normal case, since the drawings are to scale — this degenerates
to rotation only:

```
θ = arg Σ (q_i - q̄)·conj(p_i - p̄)
```

which is better conditioned and needs one pair plus the existing anchor. Per-point
residuals and RMSE are reported in metres so a mistyped point is visible rather than
averaged in silently.

### Preview approximation

The browser previews in a **local ENU tangent frame** anchored at `map_anchor`, converting
offsets to lon/lat with the WGS84 radii of curvature — meridian `M(φ) = a(1-e²)/(1-e²sin²φ)^1.5`
and prime vertical `N(φ) = a/√(1-e²sin²φ)`. No `proj4` dependency is added.

**Web Mercator was tried first and rejected.** It is not conformal on the ellipsoid: its
north scale is `a·sec φ / M(φ)` and its east scale `a·sec φ / (N·cos φ)`, differing by
about 0.45% at Tokyo. A similarity transform in Mercator metres is therefore *not* a
similarity on the ground, and the artwork arrives visibly stretched. Measured worst-case
disagreement with the export, on a 59 m artwork:

| Preview frame | Rotation frame | 59 m artwork | 2.4 km site |
|---|---|---|---|
| Web Mercator | grid north | 23.35 cm | 953 cm |
| Web Mercator | true north | 17.01 cm | 751 cm |
| Local ENU | grid north | 8.00 cm | 297 cm |
| **Local ENU** | **true north** | **0.58 cm** | **36.6 cm** |

The residual at 2.4 km is the JPR grid scale factor's own variation and is irrelevant to a
preview. Export is unaffected either way: it uses `pyproj` in `working_crs`.

## Backend

### Modules

| Module | Purpose |
|---|---|
| `backend/src/illustrator_georeference.py` (new) | Transform dataclass, affine flattening, Helmert fit, zone auto-pick, reprojection. Pure. |
| `backend/src/illustrator_store.py` (new) | Conversion cache: id → temp dir with untransformed GeoPackage, report, layer order. TTL sweep. |
| `backend/src/placements.py` (new) | SQLite-backed named placement CRUD. |
| `backend/src/illustrator_importer.py` | Split `_convert` so parsed output persists and reloads; apply transform at write time. |
| `backend/src/illustrator_qgis.py` | Accept a CRS instead of emitting an unreferenced project. |
| `backend/routers/import_router.py` | New endpoints. |

### Endpoints

```
POST /api/convert/illustrator/preview
  multipart: file
  → { conversion_id, report, layers[], artwork_bounds,
      preview (GeoJSON, artwork points, decimated),
      preview_features, total_features }

GET /api/geocode?query=&language=ja&limit=5
  → { query, language, results[] }     # unsessioned; reuses app.state.geocoder

POST /api/convert/illustrator/{conversion_id}/export
  { transform, output_crs, formats: {geopackage, shapefile, qgis} }
  → zip

GET    /api/placements
POST   /api/placements          { name, transform, artwork_bounds }
PUT    /api/placements/{id}
DELETE /api/placements/{id}
```

The existing `POST /api/convert/illustrator` is retained unchanged for the direct,
ungeoreferenced download.

### Conversion cache

Parsing costs several seconds on real files, so it happens once. The cache holds the
untransformed GeoPackage under `TEMP_DATA_DIR`, keyed by a UUID. Entries expire after
`ILLUSTRATOR_CACHE_TTL_MINUTES` (default 120) and are capped at
`ILLUSTRATOR_CACHE_MAX_ENTRIES` (default 20, evicting oldest first), both added to
`.env.example` beside the existing session settings. Nothing about IMDF's `SessionRecord`
fits a bag of colored paths, so this is a separate ~40-line store rather than an extension
of `SessionManager`.

### Zone auto-pick

Japan Plane Rectangular CS I–XIX under JGD2011 is EPSG:6669–6687 (verified: 19 CRSs, zone
IX origin 36°N, 139°50′E).

Zone assignment is defined **by prefecture, not geometry**, so the rule is a prefecture →
zone lookup keyed on the ISO 3166-2 code that `geocoding.py:_iso_3166_2_code` already
extracts from Nominatim (`JP-13` → IX). Forty-three prefectures map to exactly one zone.
Four span several and fall back to nearest-origin among *that prefecture's* zones:
Hokkaido (XI/XII/XIII by subprefecture), Tokyo (IX plus Ogasawara XIV/XVIII/XIX), Okinawa
(XV/XVI/XVII by longitude) and Kagoshima (II plus zone I for western islands).

The 47-entry table was validated by projecting each prefectural capital into its assigned
zone: all 47 fall inside the ±130 km easting design envelope, worst case Tokushima at
+97.8 km.

When the geocoder is unavailable the rule degrades to plain nearest-origin, measured at
20/21 against reference cities. Its one failure is instructive: Hakodate resolves to X
instead of XI because zone X's origin is geometrically closer across the Tsugaru Strait,
while the legal assignment follows the Hokkaido boundary. A `min |easting|` rule was
tested and rejected at 18/21 — it ignores latitude bands and puts Sapporo in zone X.

The result remains a labelled, user-overridable dropdown default, never a silent decision.

### Placement storage

`data/placements.db`, gitignored beside the existing runtime artifacts.

```sql
CREATE TABLE placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  working_crs TEXT NOT NULL,
  anchor_lon REAL NOT NULL, anchor_lat REAL NOT NULL,
  artwork_anchor_x REAL NOT NULL, artwork_anchor_y REAL NOT NULL,
  rotation_deg REAL NOT NULL, metres_per_point REAL NOT NULL,
  artwork_bounds TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

SQLite rather than JSON because several colleagues share one server and a
read-modify-write on a JSON file loses updates. `artwork_bounds` records the artboard the
placement was authored against; applying it to a drawing differing by more than 1% in
width or height warns, and does not block.

## Frontend

New route `/illustrator`, entered from the existing button. `UploadPage.tsx` is already
~730 lines and its job is file intake; the georeferencing workspace does not belong in it.

Two screens: **Convert** (pick file, show report) → **Place & Export** (map, transform
panel, export controls).

| Unit | Purpose | Depends on |
|---|---|---|
| `lib/similarity.ts` | Pure math: apply, flatten, Helmert fit, residuals | — |
| `hooks/useIllustratorPlacement.ts` | Transform state and reducer | `similarity.ts` |
| `components/illustrator/PlacementMap.tsx` | Map, basemap switcher, artwork overlay | maplibre |
| `components/illustrator/TransformHandles.tsx` | Drag/rotate/scale gizmo | `PlacementMap` |
| `components/illustrator/TransformPanel.tsx` | Numeric fields, lock, calibration | reducer |
| `components/illustrator/ControlPointList.tsx` | Pair table and residuals | reducer |
| `components/illustrator/PlacementLibrary.tsx` | Save / apply / delete named placements | API |
| `components/shared/basemapStyles.ts` | OSM, GSI photo, GSI std | — |

MapLibre has no transform widget. The artwork is one GeoJSON source and the handles are a
second (anchor, rotate handle offset along +N, scale handle at a bbox corner).
`pointerdown` disables `dragPan`, pointer moves convert screen px → lng/lat →
local ENU metres → reducer, re-emitting GeoJSON throttled to `requestAnimationFrame`.

The preview is decimated server-side so dragging stays responsive on a station plan.
Tolerance is `1/2000` of the `artwork_bounds` diagonal: geometries are passed through
`shapely.simplify` at that tolerance, and any whose bounding box diagonal falls below it
is dropped entirely. `preview_features / total_features` is shown so it is clear the view
is a proxy. Export transforms full-fidelity geometry and applies neither step.

## Export

- Formats: GeoPackage, shapefile set, QGIS project. Checkboxes, all enabled by default.
- CRS: dropdown defaulting to the auto-detected JPR zone, plus EPSG:4326.
- Shapefile: `stroke_color` truncates to `stroke_col` under the 10-char DBF limit; one file
  set per layer per geometry type; `.prj` from `output_crs`; Japanese layer names use the
  existing `write_encoding` path and `_sanitize_layer_name`.
- QGIS project: declares `output_crs` so it opens over the building.

## Error handling

| Case | Behaviour |
|---|---|
| Geocoder disabled/timeout/rate-limited | Existing `GEOCODER_DISABLED` / `GEOCODER_TIMEOUT` / `GEOCODER_RATE_LIMIT`. Placement stays usable; search is a convenience, panning is not. |
| Expired `conversion_id` | 404 `CONVERSION_EXPIRED`; UI offers one-click re-convert since the browser still holds the `File`. |
| Export without a placement | 422. No silent default at null island. |
| Degenerate control points | 422 with a readable message, not a singular-matrix traceback. |
| Duplicate placement name | 409. |
| Artboard mismatch on apply | 200 with a warning field. |
| Parse failure | Existing `IllustratorConversionError` → 422 handler at `main.py:151`. |
| Disk growth | Temp dirs under `TEMP_DATA_DIR`, TTL sweep and count cap. |

## Testing

The load-bearing test is a **cross-language golden fixture**: one artwork rectangle, one
transform, one expected coordinate set, asserted in both `pytest` and `vitest`. That is
what makes the duplicated preview/export math safe — drift fails a test instead of quietly
misplacing a building.

Backend (`pytest`):

- Golden transform to EPSG:6677, exact to 1e-6 m.
- EPSG:6677 axis-order round-trip against a known Shinjuku coordinate. JPR declares
  X=northing, Y=easting; getting it backwards puts Tokyo in the Pacific.
- Helmert recovery of synthetic `s`, `θ`; scale-locked one-pair case; residual values;
  degenerate input raises.
- Zone auto-pick: prefecture-code path across all 47 codes; nearest-origin fallback across
  the 21 reference cities; the Hakodate case asserted as a *known* fallback miss so the
  prefecture path cannot silently regress to geometry.
- Preview endpoint returns id, bounds and a decimated collection.
- Export zip contains `.gpkg`, `.shp`/`.prj`/`.dbf`, `.qgs`; geometry read back from the
  shapefile lands within tolerance; `.prj` names the requested CRS.
- Expired conversion id → 404.
- Placement CRUD; duplicate name → 409; two concurrent saves both persist.
- Artboard mismatch produces a warning.

Frontend (`vitest`):

- The same golden fixture through `similarity.ts`, matching the Python values.
- Helmert parity with the backend.
- Reducer: each editor mutates only its own field; the lock prevents scale changes.

Smoke test before completion: a real station `.ai`, placed by hand, exported, and opened in
QGIS over imagery. Handle feel is not unit-testable.

## Risks

| Risk | Mitigation |
|---|---|
| Preview/export math drift | Cross-language golden fixture |
| JPR axis order | Explicit round-trip assertion, not trust in `pyproj` defaults |
| Wrong zone near a boundary | Prefecture lookup is authoritative; geometric fallback measured 20/21, known to miss Hakodate. Labelled dropdown, user-overridable. |
| Saved placement applied to a shifted artboard | Bounds comparison warning |
| Large artwork stalls dragging | Server-side decimated preview |
| GSI tile availability or terms | Attribution rendered; OSM remains the default basemap |


## Verification

Numeric claims in this document were measured against `pyproj` 3.7.1 / `shapely` 2.0.7,
not asserted from memory.

| Claim | Result |
|---|---|
| EPSG:6677 axis order is X=north, Y=east | Confirmed. Default transformer returns `(northing, easting)`; `always_xy=True` swaps it. Shinjuku → N −34.3 km, E −12.0 km from the zone IX origin. |
| EPSG 6669–6687 = JPR I–XIX | Confirmed, 19 CRSs. |
| Affine coefficients as written | Exact: anchor error 0.000000000 mm, 300 pt edge → 52.9167 m at 1:500, area ratio 1.000000000000, rotation recovered 30.000000°. |
| `metres_per_point` for 1:500 | 0.176389. |
| Convergence at Tokyo, zone IX | 0.0776°, 40.7 cm across 300 m. Formula sign is negative; grid bearing of true north is positive. |
| Nearest-origin zone rule | 20/21 reference cities; fails Hakodate (X instead of XI). |
| `min \|easting\|` zone rule | 18/21 — rejected; ignores latitude bands, puts Sapporo in zone X. |
| GSI + Esri tile endpoints | Live at z17 over Tokyo (19.5 KB / 22.7 KB / 23.2 KB). GSI used; Esri not, on ToS grounds. |
| Preview/export frame agreement | Measured. Local ENU + true-north rotation agrees with the EPSG:6677 export to **0.58 cm** on a 59 m artwork and 36.6 cm on a 2.4 km site. Web Mercator was measured at 23.35 cm and rejected. |

Remaining frontend claims rest on documented API surface and are checked during
implementation, not before.