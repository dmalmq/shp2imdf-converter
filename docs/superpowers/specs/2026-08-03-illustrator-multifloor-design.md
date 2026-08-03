# Illustrator Multi-Floor Placement — Design

Date: 2026-08-03
Status: Approved for planning
Extends: `2026-08-03-illustrator-georeferencing-design.md` (implemented, merged `db12fe7`)

## Problem

A single `.ai` file sometimes contains more than one floor plan. The current
feature applies **one** transform to the whole artwork, so a multi-floor file
can only be placed as one undifferentiated unit. Two capabilities are needed:

1. Let the user choose which part of the artwork belongs to which floor.
2. Let the user drag each floor's position on the map independently.

## Goals

- Partition artwork into floors by drawing boxes on the artwork preview;
  boxes optionally constrained to specific layers for files where floors are
  overlaid at the same coordinates.
- Per-floor transforms: shared scale/rotation by default, per-floor
  translation, with a per-floor unlock to full independence.
- Export materializes per-`(floor, layer)` tables, each transformed by its
  floor's placement.
- Saved placements carry a set of floor transforms, applied by floor label.
- A file with no floor boxes behaves exactly as today (single implicit floor).

## Non-goals

- Automatic floor detection from layer names or geometry. The user assigns;
  the tool never guesses which box is "1F".
- Per-feature editing inside a box (no lasso/split tools). A feature belongs
  to the floor whose box contains its centroid, period.
- Changing the single-transform flow for files that don't use floors.

## Current state (post-merge)

| Piece | State |
|---|---|
| `POST /api/convert/illustrator/preview` | Parses once, caches untransformed GeoPackage + report; returns decimated artwork-space preview |
| `POST /api/convert/illustrator/{id}/export` | Body `{ transform, output_crs, formats }`; applies one affine to every layer |
| `build_georeferenced_bundle` | One matrix → all layers → gpkg/shp/qgs zip |
| Placement reducer | Single `SimilarityTransform`, `scaleLocked`, `controlPoints` |
| `PlacementStore` | SQLite, one transform per named placement |
| Map gizmo | One artwork source + one handle set |

## Decisions

| Question | Decision |
|---|---|
| Assignment granularity | Spatial regions (boxes) on the artwork preview; optional per-box layer restriction |
| Membership rule | Feature belongs to floor F iff `centroid(feature) ∈ box(F)` and its layer is in F's allowed set (if restricted) |
| Unassigned features | Excluded from export; counted in the UI and the export report |
| Transform model | Shared frame (scale/rotation/CRS) by default; per-floor translation; drag or unlock splits a floor into an independent transform; relink rejoins |
| Export granularity | Per-`(floor, layer)` tables `1F_壁`, `2F_壁`, `floor` attribute, `.qgs` grouped by floor |
| Membership authority | Server re-computes from the full-fidelity geometry at export; the client filter is display-only |
| Placements | Named placement = set of `{label, transform}`; applied by label with warnings on mismatch |

## Data model

### Floor assignment (stored server-side in the conversion cache entry)

```json
{
  "label": "1F",
  "box": [minx, miny, maxx, maxy],
  "layer_names": ["壁", "柱"] | null
}
```

`layer_names: null` means all layers. Labels are user-entered, sanitized
identically to layer names when used in table names.

### Placement state (client)

```ts
type FloorPlacement = {
  label: string;
  linked: boolean;          // true: scale/rotation follow the frame, anchor derived
  artworkAnchor: [number, number];   // region centroid (points)
  mapAnchor: [number, number];       // WGS84 lon/lat
  controlPoints: ControlPoint[];
  artworkBounds: [number, number, number, number];  // region bounds (points)
};

type PlacementState = {
  frame: { rotationDeg: number; metresPerPoint: number; workingCrs: string };
  floors: FloorPlacement[];
  activeFloorLabel: string | null;
  scaleLocked: boolean;
};
```

**Shared-frame semantics** (pinned by reducer tests):

- The **active** linked floor is the frame's reference. Positioning it
  (`positionBuilding(mapAnchor)`) moves every linked floor by derivation:
  `anchor_k = anchor_active + frame·(regionCentroid_k − regionCentroid_active)`
  in ENU metres about the active anchor. This is the "position one floor, the
  whole building follows" operation.
- `rotateFrame(θ)` / `scaleFrame(s)` update the frame and recompute linked
  floors' derived anchors about the active anchor; **pinned (unlinked) floors
  keep their absolute transforms** — this is the approved pinned-floor rule.
- `dragFloor(label, mapAnchor)` sets that floor's anchor and **unlinks** it
  (drag = pin). An explicit `relinkFloor` rejoins it to the frame, recomputing
  its anchor by derivation. `unlockFloor` is the button form of the same
  operation; `positionBuilding` requires the active floor to be linked, and
  degrades to `dragFloor` when it is not.
- Frame operations rotate/scale the **active linked floor's** reference; if no
  floor is linked, they no-op and the UI hints to relink a floor.
- Unlinked floors have their own full transform (anchor, scale, rotation) and
  are ignored by frame operations.
- **No boxes drawn** → the assignment is empty and the client sends one
  implicit floor ("artwork") whose region is the whole artwork bounds →
  identical behaviour to the current single-transform flow.

## Backend

### Modules

| File | Change |
|---|---|
| `backend/src/illustrator_export.py` | `build_georeferenced_bundle(cached, floors, output_crs, formats)` where `floors = [{label, transform, region, layer_names}]`; membership filter; per-(floor, layer) tables; `export_report.json` in the zip |
| `backend/src/illustrator_store.py` | `CachedConversion` gains `floors` (stored `floors.json` in the entry directory); `assign(cached_id, floors) -> CachedConversion` |
| `backend/src/schemas.py` | `FloorRegionPayload`, `AssignFloorsRequest`, `AssignFloorsResponse`, `FloorExportPayload`, new export request shape |
| `backend/routers/import_router.py` | `POST /api/convert/illustrator/{id}/assign`; export request rework |
| `backend/src/placements.py` | `floors` JSON column replaces the flat transform columns |

### Endpoints

```
POST /api/convert/illustrator/{conversion_id}/assign
  { floors: [{ label, box: [4], layer_names: [str] | null }] }
  → { floors: [{ label, feature_count, artwork_bounds,
                 layer_counts: [{table, ai_layer, count}] }],
      unassigned_count, total_features }
```

Stores the assignment in the cache entry (replaces any previous). Validation:
labels non-empty and unique; boxes within the artwork bounds (warn, not
reject, for boxes extending beyond); unknown layer names rejected.

```
POST /api/convert/illustrator/{conversion_id}/export
  { floors: [{ label, transform: TransformPayload }], output_crs, formats }
  → zip
```

- If an assignment is stored: every stored floor must appear in the request
  (422 otherwise — silently dropping a floor would lose data), and no request
  floor may lack a stored region (422).
- If no assignment is stored: exactly one floor expected, treated as covering
  the whole artwork — the backward-compatible path.
- Membership is re-computed from the full-fidelity geometry by
  `centroid ∈ box` (and layer restriction). Unassigned features are dropped;
  their count and the affected layers land in `export_report.json`:
  `{ floors: [{label, feature_count, tables}], unassigned_count, warnings }`.
- Tables: `{sanitized_label}_{sanitized_layer_table}`, e.g. `1F_壁`,
  `1F_壁__lines`. A `floor` attribute is written on every feature.
- `.qgs`: layers grouped under a floor group per floor; CRS handling unchanged.

### Placements

```sql
CREATE TABLE placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  floors TEXT NOT NULL,           -- JSON: [{label, transform:{...}}]
  artwork_bounds TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`PlacementRequest`/`PlacementItem` become `{ name, floors, artwork_bounds }`.
The DB is a fresh gitignored runtime artifact, so replacing the flat transform
columns needs no migration; pre-existing saved placements are lost (acceptable
pre-release — noted in the plan). Applying a saved placement matches floors by
label; missing or extra labels produce a warning, not a rejection.

## Frontend

| Unit | Change |
|---|---|
| `pages/IllustratorPage.tsx` | Third step between convert and place: floor assignment panel; export payload builds from all floors |
| `components/illustrator/AssignmentPanel.tsx` (new) | SVG preview from the decimated GeoJSON, box drawing, per-box label + layer restriction, unassigned count |
| `lib/svgPreview.ts` (new) | GeoJSON → SVG path painter; pure and unit-tested |
| `hooks/useIllustratorPlacement.ts` | State becomes the floor model above; new actions `positionBuilding`, `rotateFrame`, `scaleFrame`, `dragFloor`, `unlockFloor`, `relinkFloor`, `setActiveFloor` |
| `components/illustrator/PlacementMap.tsx` | One GeoJSON `Source` per floor (client-side preview filter by the same centroid rule), active floor's handles only |
| `components/illustrator/TransformPanel.tsx` | Frame controls (rotation/scale act on the frame); floor selector |
| `components/illustrator/ControlPointList.tsx` | Per active floor |
| `components/illustrator/PlacementLibrary.tsx` | Save/apply floor sets |

**Assignment panel flow:** convert → the artwork preview renders as SVG →
drag a box → the box is labeled (default `1F`, `2F`, … editable) and colored →
optional "restrict to layers" opens the layer list from the preview's layer
summaries → "Done" posts the assignment and moves to Place. Unassigned
feature count is visible before leaving. Boxes are drawn on the decimated
preview; the server re-verifies membership at export, so a box hugging a
feature edge may show a slightly different count in the export report — a
known, accepted consequence of decimation, stated in the UI copy.

## Error handling

| Case | Behaviour |
|---|---|
| Export omits a stored floor | 422 `FLOOR_MISSING` |
| Export names an unstored floor | 422 `FLOOR_UNKNOWN` |
| Duplicate floor labels in assignment | 422 |
| Unknown layer name in a restriction | 422 |
| Box beyond artwork bounds | 200 with a warning in the response |
| Placement label mismatch on apply | Client warning, placement still applied by matched labels |

## Testing

Backend:

- Membership: centroid-in-box; layer restriction; features straddling a box
  edge assigned by centroid; unassigned count.
- Two-floor export: `1F_壁` and `2F_壁` tables both present, each transformed
  by its own transform (assert a known point of each lands correctly);
  `floor` attribute written; `export_report.json` counts correct.
- A layer spanning both floors splits correctly.
- No-assignment export matches the single-transform behaviour (same geometry,
  same files, label `artwork`).
- 422s: missing/unknown floor, duplicate labels, unknown layer.
- Placement store round-trip with `floors` JSON; duplicate name 409.

Frontend:

- Reducer: `positionBuilding` derives linked anchors exactly (golden values);
  `rotateFrame` recomputes linked anchors, leaves pinned floors untouched;
  `dragFloor` unlinks; `relinkFloor` restores derivation; unlocked floor
  ignores frame ops.
- `svgPreview` painter: polygon/line/multipart → path strings.
- Client-side preview filter matches the server rule on the golden fixture.

Smoke test before completion: a two-floor fixture `.ai` (two spatially
separated boxes), assigned, placed with one `positionBuilding`, one floor
dragged, exported, opened in QGIS: two floor groups, correct positions.

## Risks

| Risk | Mitigation |
|---|---|
| Box-edge disagreement between decimated preview and full geometry | Stated in UI copy; server is authoritative; counts in the report |
| Dragged floor not following later rotation surprises users | The pinned-floor rule was explicitly approved; tooltip copy states it |
| Table-name explosion with many floors × layers | Sanitized prefixes; floor groups in `.qgs` keep it navigable |
| Lost saved placements on schema change | Fresh artifact, pre-release; noted in the plan |
