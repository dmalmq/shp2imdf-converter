# Illustrator Page-to-Floor Assignment — Design

Date: 2026-08-05
Status: Approved for planning
Extends: `2026-08-03-illustrator-multifloor-design.md` (implemented)

## Problem

An `.ai`/InDesign document with more than one page renders every page on top of
every other page. `_convert()` (`backend/src/illustrator_importer.py:513-515`)
loops `PDFPage.create_pages()` and appends every painted path into one flat
`device.records` list with no page tag, and pdfminer's `process_page`
normalizes each page's `MediaBox` lower-left to the origin
(`ctm = (1, 0, 0, 1, -x0, -y0)`), so all pages occupy the same
`[0..W] × [0..H]` box. The user sees one illegible stack and cannot separate
the floors.

`report.page_count` (`illustrator_importer.py:61`) is the only page awareness
in the codebase. It reaches the client as
`IllustratorConversionReport.page_count` (`frontend/src/api/client.ts:435`) and
is never rendered.

The useful consequence of that same normalization: artwork keeps its offset from
its own sheet's lower-left corner, so pages of equal size stay co-registered.
One-floor-per-page documents therefore need no georeferencing work — placing one
floor places them all, which the existing linked-floor model
(`useIllustratorPlacement.ts:100-127`) already handles. This is an assignment
problem, not a georeferencing problem.

Verified by probe against `pdfminer` before this spec was planned: a 3-page PDF
whose second page carries an offset `MediaBox` of `[100 100 300 300]` with its
artwork drawn at `(150, 150)` lands at `(50, 50)` — pixel-identical to page 1's
artwork at `(50, 50)` on a `[0 0 200 200]` sheet. `begin_page` fires exactly once
per page, in order, before that page's paths, which is what makes the
`_RecorderDevice` page counter below correct.

## Goals

- Assign each PDF page of a multi-page `.ai` to a floor.
- Page becomes a third membership dimension alongside the existing
  `centroid ∈ box` and layer restriction, expressed in the same predicate chain.
- Several pages may share one floor; a page may be excluded from the export.
- A page holding several floor plans still supports box assignment, scoped to
  that page.
- A single-page file behaves exactly as today.

## Non-goals

- Guessing which page is which floor from page content, labels or order beyond
  the editable `1F, 2F, …` default. The user assigns; the tool never decides.
- Auto-aligning pages of unequal size. Explicitly rejected: translating each
  page so its content centres coincide silently mis-georeferences the
  legitimate case of a small upper floor that sits off to one side of the
  footprint.
- Changing the placement step. It is label-keyed and page-agnostic.
- Per-page export tables. Export granularity stays per-`(floor, layer)`.

## Decisions

| Question | Decision |
|---|---|
| Assign screen for N pages | Grid of page cards with editable floor names; a card drills into the existing `AssignmentPanel` scoped to that page |
| Page → floor cardinality | The floor name is the grouping key: two pages given the same name merge into one floor |
| Excluding a page | Explicit "not a floor plan" toggle; excluded features land in the existing unassigned count and `export_report.json` |
| Unequal page sizes | Detected and warned in the grid; no geometry is moved. Because artwork is anchored to each sheet's lower-left corner, visually centred plans on differently sized sheets land offset by half the size difference. Floors start linked and stacked; the existing drag-to-unlink handles the odd sheet out |
| Data model | One `page` column on the existing GeoPackage rows; the floor record gains `pages`. Table grouping stays `(layer, role)` |
| Membership authority | Unchanged — the server re-computes from full-fidelity geometry at export; the client filter is display-only |
| Floor bounds for placement | Taken from the assign response's per-floor `artwork_bounds`, which `compute_assignment_summary` already derives from matched geometry |

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| One GeoPackage table per `(page, layer, role)` | N×M×2 tables; breaks the `written_layers` / `IllustratorLayerSummary` contract, duplicates every layer in the restriction UI, and wrecks the `.qgs` layer ordering built by `illustrator_qgis.py` |
| One cached conversion per page | Destroys the shared layer order and the single `.qgs` export; the placement step would have to juggle N artworks |
| Page tabs instead of a grid | Cannot see all pages at once to sanity-check the floor order before committing |
| Page show/hide checklist over today's stacked canvas | Leaves the stacking that prompted the request on screen |

## Data model

### Floor assignment (stored in the conversion cache entry as `floors.json`)

```json
{
  "label": "1F",
  "pages": [1] | null,
  "box": [minx, miny, maxx, maxy] | null,
  "layer_names": ["壁", "柱"] | null
}
```

Every filter is independently optional and `null` means "no restriction on
this dimension". Membership is the conjunction:

```
page ∈ floor.pages                 (or floor.pages is null)
AND ai_layer ∈ floor.layer_names   (or floor.layer_names is null)
AND centroid ∈ floor.box           (or floor.box is null)
```

This subsumes every existing case. Today's box assignment is
`{pages: null, box: [...]}`; the implicit single floor is all-null; a page
floor is `{pages: [n], box: null}`; a box drawn while drilled into page `n` is
`{pages: [n], box: [...]}`. First matching floor wins, as now.

### Backward compatibility

- A `floors.json` written before this change has no `pages` key → `null` →
  identical behaviour.
- A cached GeoPackage written before this change has no `page` column.
  `_read_layers` (`illustrator_export.py:82-86`) backfills `gdf["page"] = 1`
  when the column is absent — one place, no per-row cost.
- `FloorRegionPayload.box` relaxing from required to optional is additive for
  existing clients.

## Backend

| File | Change |
|---|---|
| `backend/src/illustrator_importer.py` | `_RecorderDevice` overrides `begin_page` to increment a 1-based page counter; `_PathRecord` gains `page: int`; `_records_to_rows` writes it as a column; `ConversionReport` gains `pages: [{index, width_pt, height_pt}]` from each `page.mediabox` |
| `backend/src/illustrator_export.py` | `build_preview` returns `pages[]`; `ExportFloor.region` becomes optional and gains `pages`; membership generalises to the three-predicate chain; `_read_layers` backfills a missing `page` column |
| `backend/src/schemas.py` | New `IllustratorPagePreview`; `IllustratorPreviewResponse.pages`; `FloorRegionPayload.box` becomes `list[float] \| None = None`, keeping its 4-element length constraint when present, plus `pages: list[int] \| None = None` |
| `backend/routers/import_router.py` | `assign_illustrator_floors` validates page indices, and its `ExportFloor` construction (`:321-326`) passes `pages` and tolerates `region=None` now that `box` is optional; `export_illustrator` passes `pages` from the stored assignment |

`_write_geopackage` (`illustrator_importer.py:410-446`) is untouched beyond the
extra row key — grouping stays `(layer, role)` and table names do not change.

### Preview payload

`build_preview` gains a `pages` array beside the existing fields:

```
pages: [{ index, bounds: [minx, miny, maxx, maxy],
          width_pt, height_pt,
          feature_count, preview_feature_count }]
```

`bounds` is that page's content bounds, used as the card thumbnail's viewBox
and as the drill-in canvas bounds. `width_pt`/`height_pt` come from the
`MediaBox` and drive the unequal-size warning. `artwork_bounds` stays the union
and `preview` stays one FeatureCollection in artwork points — each feature's
`properties.page` flows through from the GeoDataFrame automatically.

Decimation is unchanged. Tolerance is `union diagonal / 2000`; after `MediaBox`
normalization the union is approximately the largest page, so a per-page
tolerance would compute the same number.

### Membership implementation

`_matches_floor`'s row-wise `.apply(axis=1)`
(`illustrator_export.py:187-189`, `276-278`) becomes a composed vectorized
mask, so a page-only floor costs no Python-level row iteration at all:

```python
mask = pd.Series(True, index=remaining.index)
if floor.pages is not None:
    mask &= remaining["page"].isin(floor.pages)
if floor.layer_names is not None:
    mask &= remaining["ai_layer"].isin(floor.layer_names)
if floor.region is not None:
    minx, miny, maxx, maxy = floor.region
    c = remaining.geometry.centroid
    mask &= c.x.between(minx, maxx) & c.y.between(miny, maxy)
```

`between` is inclusive, matching `_centroid_inside`'s `minx <= cx <= maxx`;
empty geometries yield a NaN centroid, which compares false, matching
`_centroid_inside`'s empty-geometry guard. Both semantics are already pinned by
`test_illustrator_export.py` (features straddling a box edge, layer
restriction) — those tests must keep passing unchanged.

### Endpoint contract

```
POST /api/convert/illustrator/preview
  → { ..., pages: [{index, bounds, width_pt, height_pt,
                    feature_count, preview_feature_count}] }

POST /api/convert/illustrator/{conversion_id}/assign
  { floors: [{ label, pages: [int] | null,
               box: [4] | null, layer_names: [str] | null }] }
  → unchanged AssignFloorsResponse
```

New validation, joining the existing unique-label and known-layer checks
(`import_router.py:306-314`): every page index must be within
`1..report.page_count`, else 422. All-null floors stay legal — that is the
existing implicit whole-artwork floor.

The export endpoint's stored-vs-requested label check
(`import_router.py:352-366`) is unaffected; floors are matched by label and
labels remain unique after merging.

## Frontend

| Unit | Change |
|---|---|
| `components/illustrator/PageAssignmentPanel.tsx` (new) | The page grid |
| `components/illustrator/AssignmentPanel.tsx` | Unchanged component contract; receives a page-filtered `preview` and that page's `artworkBounds` when drilled into |
| `lib/svgPreview.ts` | New `splitByPage`; `PartitionFloor` gains `pages` and a nullable `box`; `partitionByFloors` mirrors the server's three-predicate chain |
| `pages/IllustratorPage.tsx` | `AssignedRegion.box` nullable plus `pages`; the `assignment === null` branch picks grid vs. panel; floor bounds come from the assign response |
| `api/client.ts` | `IllustratorPagePreview`, `IllustratorPreviewResponse.pages`, `assignFloors` payload |

### Page grid

Rendered instead of `AssignmentPanel` when `preview.pages.length > 1`. One card
per page, in page order:

- Thumbnail via the existing `buildSvgPaths(pageFeatures, page.bounds)`, with
  the same y-flip group the assign panel uses.
- Page number and sheet size.
- Floor-name input, defaulting to `1F, 2F, …` by page order — the same default
  the box flow already uses (`AssignmentPanel.tsx:89`).
- A "not a floor plan" toggle. A page with zero features defaults to excluded.
- A "Split this page…" action for a page holding several plans.

Two cards given the same name merge into one floor, surfaced as a "2 pages →
1F" hint on both. The running "Unassigned: N of M preview shapes" line and the
"Skip — one floor for everything" escape hatch are kept, so a user who wants
today's single stacked floor can still have it deliberately.

A warning banner appears when `width_pt`/`height_pt` are not uniform across
pages, stating that floors may need individual positioning on the map.

### Drill-in

"Split this page…" mounts the existing `AssignmentPanel` with `preview` set to
that page's features and `artworkBounds` set to that page's bounds. The boxes
it returns are tagged `pages: [n]`, so a box floor and a page floor are the
same record type and nothing downstream special-cases either. Returning from
the drill-in replaces that page's single floor with its boxes.

### Floor bounds

`initialStateFromAssignment` (`IllustratorPage.tsx:45-73`) currently derives
each floor's `artworkAnchor` and `artworkBounds` from the drawn box, and
`onAssigned` discards the assign response (`IllustratorPage.tsx:263`). It will
use the response's per-floor `artwork_bounds` instead, which
`compute_assignment_summary` (`illustrator_export.py:288-298`) already computes
from matched geometry. This is exact for page floors, which have no box, and
strictly better for box floors, whose drawn box is usually larger than the
geometry it caught.

## Error handling

| Case | Behaviour |
|---|---|
| Page index outside `1..page_count` | 422 |
| Duplicate floor labels after merging | Cannot occur — merging is by name; the existing 422 still guards the API |
| Every page excluded | "Done" disabled with a hint; the API would otherwise receive an empty floor list, which `AssignFloorsRequest` already rejects |
| Page with zero features named as a floor | Allowed; the floor reports `feature_count: 0` in the assign summary |
| Unequal page sizes | Warning banner, export proceeds |
| Cached conversion predating the `page` column | Treated as a single page |

## Testing

Backend, driven by a new three-page fixture PDF built the same way as
`_build_minimal_ai_pdf` (`test_illustrator_import.py:22-65`). The page shapes are
the ones the probe already exercised, chosen so one fixture covers both the
co-registered and the unequal-sheet paths:

| Page | `MediaBox` | Artwork at | Normalizes to | Covers |
|---|---|---|---|---|
| 1 | `[0 0 200 200]` | `(50, 50)` | `(50, 50)` | baseline |
| 2 | `[100 100 300 300]` | `(150, 150)` | `(50, 50)` | offset origin, same size → co-registered |
| 3 | `[0 0 400 400]` | `(50, 50)` | `(50, 50)` | same origin, larger sheet → unequal-size warning |

- `page_count == 3` and `pages[]` metadata (index, size) correct, including the
  differing size on page 3.
- Rows carry the right page; each page's geometry is separable despite all three
  normalizing to the same coordinates.
- `build_preview` returns per-page bounds and per-page feature counts, and
  preview features carry `properties.page`.
- Membership: page-only floor takes that whole page; page + layer restriction;
  page + box (the drill-in case); two pages merged under one label; an excluded
  page counted in `unassigned_count` and `export_report.json`.
- Two page floors export with their own transforms, as the existing two-box
  test already asserts for boxes.
- 422 on an out-of-range page index.
- A box-only assignment (no `pages`) still exports identically — the
  backward-compatibility path.
- `floors.json` round-trips `pages` with a null `box`.
- The existing single-page fixture assertions
  (`test_illustrator_import.py:72`, and every centroid/layer test in
  `test_illustrator_export.py`) must pass unchanged.

Frontend:

- `svgPreview.test.ts`: `splitByPage`; `partitionByFloors` with the page
  predicate, page + layer, page + box, and two pages merged under one label.
  This file is the parity check against the server rule, so it moves in
  lockstep with `_matches_floor`.
- New `PageAssignmentPanel.test.tsx`: default `1F, 2F` naming by page order;
  duplicate name merges and shows the hint; exclude toggle removes the floor
  and raises the unassigned count; zero-feature page defaults to excluded;
  size-mismatch warning appears only when sizes differ; "Done" disabled when
  every page is excluded.
- `useIllustratorPlacement.test.ts` is unaffected; the placement reducer does
  not change.

Verification before completion: `pytest -m georef`, `pytest -m phase5`,
`npx vitest`, then a browser smoke test loading a real multi-page `.ai` —
assign pages to floors, place one floor, export, and confirm the zip contains
one table set per floor with the pages separated.

## Risks

| Risk | Mitigation |
|---|---|
| Pages of unequal size land offset and the user does not notice | Explicit banner plus per-card sheet size; the offset is lower-left-anchored, so it is proportional to the sheet size difference and plainly visible on both the thumbnail and the placement map |
| Vectorizing `_matches_floor` changes box-edge or empty-geometry semantics | `between` is inclusive and NaN compares false, matching the current guards; the existing straddle and restriction tests are the check |
| A cached conversion from before the change is reused | `_read_layers` backfills `page = 1`; cache entries are short-lived and evicted (`test_illustrator_store.py`) |
| Many pages make the grid unwieldy | Cards are thumbnails in a wrapping grid; page order is fixed, so scanning is linear |
| Merging by name hides a typo, silently combining two floors | The "2 pages → 1F" hint fires on every merge, including accidental ones |
