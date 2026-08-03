# Illustrator Multi-Floor Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user partition one `.ai` file into floors by drawing boxes on the artwork preview, then place each floor — shared scale/rotation by default, per-floor translation — and export per-floor georeferenced files.

**Architecture:** The conversion cache gains a stored floor assignment (`floors.json` per entry). The server stays dumb: it stores regions, re-computes feature membership from full-fidelity geometry at export, and materializes per-`(floor, layer)` tables. The shared-frame semantics (linked floors, derivation, pinning) live entirely in the frontend reducer, where they are unit-testable.

**Tech Stack:** As the existing feature: FastAPI, geopandas/shapely, stdlib sqlite3, React 18 + TS, react-map-gl/maplibre, vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-08-03-illustrator-multifloor-design.md`

## Global Constraints

- Membership rule: a feature belongs to floor F iff `centroid(feature) ∈ box(F)` and its `ai_layer` is in F's allowed set (when restricted). **First matching floor in request order wins** — no feature is emitted twice.
- Unassigned features (in no box) are excluded from export and counted in `export_report.json`.
- Table names at export: `{sanitized_floor_label}_{sanitized_layer_table}`; every emitted feature carries a `floor` attribute equal to its floor label.
- No stored assignment → exactly one floor in the export request, region = whole artwork bounds, `layer_names = None`. This path must produce byte-identical geometry to the pre-multi-floor export.
- Shared frame semantics (reducer): linked floors share `frame.rotationDeg/metresPerPoint/workingCrs`; dragging a floor **unlinks** it; frame operations affect linked floors only; with **one** floor, dragging keeps it linked (pin/unlink is meaningless without a second floor — this preserves the existing single-floor UX exactly).
- `positionBuilding` requires a linked active floor and degrades to `dragFloor` when it is not.
- All existing single-floor behaviour must keep passing: the golden fixture, the export tests, the reducer tests.
- `always_xy=True` on every pyproj transformer; true-north rotation with convergence subtraction in `SimilarityTransform.to_affine_matrix` — unchanged.
- Frontend tests: `globals: true`, no import of `test`/`expect`. Bilingual strings via `useUiLanguage().t`.

---

## File Structure

**Backend — modify**

| File | Change |
|---|---|
| `backend/src/illustrator_store.py` | `CachedConversion.floors: list[dict] \| None`; `floors.json` per entry; `ConversionStore.assign(conversion_id, floors) -> CachedConversion` |
| `backend/src/illustrator_export.py` | `ExportFloor` dataclass; `compute_assignment_summary(cached, floors)`; multi-floor `build_georeferenced_bundle`; `FloorExportError` |
| `backend/src/schemas.py` | `FloorRegionPayload`, `AssignFloorsRequest`, `AssignFloorSummary`, `AssignFloorsResponse`, `FloorExportPayload`, export request rework, placement rework |
| `backend/routers/import_router.py` | `POST /{id}/assign`; export request join; placement payloads |
| `backend/src/placements.py` | `floors` JSON column replaces the flat transform columns |
| `backend/main.py` | `FloorExportError` handler (422 `FLOOR_MISMATCH`) |

**Frontend — modify / create**

| File | Change |
|---|---|
| `frontend/src/lib/svgPreview.ts` (new) | GeoJSON → SVG paths; `partitionByFloors` |
| `frontend/src/hooks/useIllustratorPlacement.ts` | Floor model + frame reducer |
| `frontend/src/components/illustrator/AssignmentPanel.tsx` (new) | Box drawing, labels, layer restriction |
| `frontend/src/components/illustrator/PlacementMap.tsx` | Per-floor sources, active-floor handles |
| `frontend/src/components/illustrator/TransformHandles.tsx` | Frame ops, active floor |
| `frontend/src/components/illustrator/TransformPanel.tsx` | Frame controls + floor selector |
| `frontend/src/components/illustrator/ControlPointList.tsx` | Active floor |
| `frontend/src/components/illustrator/PlacementLibrary.tsx` | Floor sets |
| `frontend/src/pages/IllustratorPage.tsx` | Three-phase flow; export payload from floors |
| `frontend/src/api/client.ts` | Assign + new export/placement types |

---

## Task 1: Store floors assignment

**Files:**
- Modify: `backend/src/illustrator_store.py`, `backend/tests/test_illustrator_store.py`

**Interfaces:**
- Consumes: `CachedConversion`, `ConversionStore` as built.
- Produces: `CachedConversion.floors: list[dict] | None` (each dict `{label, box, layer_names}`); `ConversionStore.assign(conversion_id: str, floors: list[dict]) -> CachedConversion` writing `floors.json` into the entry directory; `get()` returns the stored floors.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_illustrator_store.py`:

```python
from backend.src.illustrator_importer import parse_ai

FLOORS = [
    {"label": "1F", "box": [0.0, 0.0, 200.0, 200.0], "layer_names": None},
    {"label": "2F", "box": [200.0, 0.0, 400.0, 200.0], "layer_names": ["壁"]},
]


@pytest.mark.georef
def test_new_conversions_have_no_assignment(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    assert cached.floors is None


@pytest.mark.georef
def test_assign_stores_and_round_trips_floors(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    stored = store.assign(cached.conversion_id, FLOORS)
    assert stored.floors == FLOORS

    fetched = store.get(cached.conversion_id)
    assert fetched.floors == FLOORS


@pytest.mark.georef
def test_assign_replaces_a_previous_assignment(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    store.assign(cached.conversion_id, FLOORS)
    replaced = store.assign(cached.conversion_id, [FLOORS[0]])
    assert replaced.floors == [FLOORS[0]]


@pytest.mark.georef
def test_assign_to_an_unknown_id_raises(store: ConversionStore) -> None:
    with pytest.raises(ConversionExpiredError):
        store.assign("does-not-exist", FLOORS)


@pytest.mark.georef
def test_prune_removes_the_floors_file_too(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=-1, max_entries=10)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    store.assign(cached.conversion_id, FLOORS)
    assert store.prune() == 1
    assert not cached.directory.exists()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_store.py -v`
Expected: FAIL — `AttributeError: 'CachedConversion' object has no attribute 'floors'` / `ConversionStore has no attribute 'assign'`.

- [ ] **Step 3: Write the implementation**

In `backend/src/illustrator_store.py`:

- Add `_FLOORS_NAME = "floors.json"` beside `_META_NAME`.
- Add the field to the dataclass and to `put()`/`_load()`:

```python
@dataclass(slots=True)
class CachedConversion:
    conversion_id: str
    directory: Path
    stem: str
    written_layers: list[dict[str, str]]
    layer_order: list[str]
    report: dict
    created_at: float
    floors: list[dict] | None = None
```

In `put()`, after the meta write, add `floors=None` to the `CachedConversion(...)` constructor call (the meta JSON does not carry floors; that is a separate file).

In `_load()`, read the floors file when present:

```python
        floors_path = meta_path.parent / _FLOORS_NAME
        floors = None
        if floors_path.is_file():
            floors = json.loads(floors_path.read_text(encoding="utf-8"))
        return CachedConversion(
            conversion_id=payload["conversion_id"],
            directory=meta_path.parent,
            stem=payload["stem"],
            written_layers=payload["written_layers"],
            layer_order=payload["layer_order"],
            report=payload["report"],
            created_at=float(payload["created_at"]),
            floors=floors,
        )
```

Add the assign method:

```python
    def assign(self, conversion_id: str, floors: list[dict]) -> CachedConversion:
        """Store a floor assignment for a conversion and return it reloaded."""
        cached = self.get(conversion_id)  # raises ConversionExpiredError for unknown ids
        (cached.directory / _FLOORS_NAME).write_text(
            json.dumps(floors, ensure_ascii=False), encoding="utf-8"
        )
        return self.get(conversion_id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_store.py -v`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/illustrator_store.py backend/tests/test_illustrator_store.py
git commit -m "feat: store floor assignments in the conversion cache"
```

---

## Task 2: Export materialization

**Files:**
- Modify: `backend/src/illustrator_export.py`, `backend/tests/test_illustrator_export.py`

**Interfaces:**
- Consumes: `CachedConversion` (with `floors` from Task 1), `SimilarityTransform`.
- Produces: `ExportFloor` dataclass (`label: str`, `transform: SimilarityTransform`, `region: list[float]`, `layer_names: list[str] | None`); `FloorExportError(RuntimeError)`; `compute_assignment_summary(cached, floors) -> tuple[list[dict], int]` returning `([{label, feature_count, artwork_bounds, layer_counts}], unassigned_count)`; `build_georeferenced_bundle(cached, floors: list[ExportFloor], output_crs, formats) -> tuple[bytes, str]` — the zip now contains `export_report.json`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_illustrator_export.py`:

```python
from backend.src.illustrator_export import ExportFloor

# The fixture's polygon layer sits in the first 170x170 pt corner of the
# artwork (see _build_minimal_ai_pdf); the line layer spans further.
FLOOR_A = ExportFloor(
    label="1F",
    transform=_transform_factory(0.0),
    region=[0.0, 0.0, 200.0, 200.0],
    layer_names=None,
)


def _transform_factory(rotation: float) -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=(85.0, 80.0),
        map_anchor=(ANCHOR_LON, ANCHOR_LAT),
        rotation_deg=rotation,
        metres_per_point=0.176389,
        working_crs="EPSG:6677",
    )


def _floors(*entries: ExportFloor) -> list[ExportFloor]:
    return list(entries)


@pytest.mark.georef
def test_assignment_summary_counts_centroids_in_boxes(cached) -> None:
    floors, unassigned = compute_assignment_summary(
        cached, [ExportFloor("1F", _transform_factory(0.0), [0, 0, 200, 200], None)]
    )
    assert floors[0]["feature_count"] == cached.report["total_features"]
    assert unassigned == 0
    assert floors[0]["artwork_bounds"][0] >= 0


@pytest.mark.georef
def test_assignment_summary_counts_unassigned_features(cached) -> None:
    floors, unassigned = compute_assignment_summary(
        cached,
        [ExportFloor("1F", _transform_factory(0.0), [0, 0, 30, 30], None)],
    )
    assert floors[0]["feature_count"] >= 0
    assert unassigned == cached.report["total_features"] - floors[0]["feature_count"]


@pytest.mark.georef
def test_export_materializes_per_floor_tables(cached, tmp_path: Path) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        _floors(FLOOR_A),
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "mf.gpkg")
    layers = set()
    for spec in cached.written_layers:
        gdf = gpd.read_file(gpkg, layer=f"1F_{spec['table']}")
        layers.add(f"1F_{spec['table']}")
        assert (gdf["floor"] == "1F").all()
    assert layers == {f"1F_{spec['table']}" for spec in cached.written_layers}


@pytest.mark.georef
def test_two_floors_split_a_straddling_layer(cached, tmp_path: Path) -> None:
    """Two disjoint boxes over one layer: each floor gets its own table."""
    payload, _ = build_georeferenced_bundle(
        cached,
        _floors(
            ExportFloor("1F", _transform_factory(0.0), [0, 0, 100, 200], None),
            ExportFloor("2F", _transform_factory(0.0), [100, 0, 300, 200], None),
        ),
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "split.gpkg")
    tables = {
        t
        for spec in cached.written_layers
        for t in (f"1F_{spec['table']}", f"2F_{spec['table']}")
    }
    with sqlite3.connect(gpkg) as conn:
        actual = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables <= actual


@pytest.mark.georef
def test_export_applies_each_floors_own_transform(cached, tmp_path: Path) -> None:
    """The same layer table, emitted under two floors, lands at two places."""
    turned = ExportFloor(
        "1F",
        _transform_factory(0.0),
        [0, 0, 200, 200],
        None,
    )
    shifted = ExportFloor(
        "2F",
        SimilarityTransform(
            artwork_anchor=(85.0, 80.0),
            map_anchor=(139.700758, 35.691421),  # ~90 m north-east of ANCHOR
            rotation_deg=0.0,
            metres_per_point=0.176389,
            working_crs="EPSG:6677",
        ),
        [200, 0, 400, 200],
        None,
    )
    payload, _ = build_georeferenced_bundle(
        cached, _floors(turned, shifted), "EPSG:6677", ExportFormats(shapefile=False, qgis=False)
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "twoplace.gpkg")
    table = f"1F_{cached.written_layers[0]['table']}"
    first = gpd.read_file(gpkg, layer=table)
    second = gpd.read_file(gpkg, layer=table.replace("1F_", "2F_"))
    assert first.total_bounds[0] < second.total_bounds[0]
    assert first.total_bounds[1] < second.total_bounds[1]


@pytest.mark.georef
def test_export_report_counts_floors_and_unassigned(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        _floors(ExportFloor("1F", _transform_factory(0.0), [0, 0, 30, 30], None)),
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        report = json.loads(archive.read("export_report.json").decode("utf-8"))
    assert report["floors"][0]["label"] == "1F"
    assert report["unassigned_count"] >= 0
    assert isinstance(report["warnings"], list)


@pytest.mark.georef
def test_layer_restriction_excludes_other_layers(cached) -> None:
    restricted = ExportFloor("1F", _transform_factory(0.0), [0, 0, 300, 300], ["Fill Layer"])
    floors, _unassigned = compute_assignment_summary(cached, [restricted])
    covered = {row["ai_layer"] for row in floors[0]["layer_counts"]}
    assert covered == {"Fill Layer"}
```

Add `import json` and `import sqlite3` at the top of the test file. Replace the existing `_transform` helper usage: keep it, and add `_transform_factory` as above. Existing single-floor tests must keep passing — `build_georeferenced_bundle` now takes `floors`, so update the existing helper-based tests to pass `[ExportFloor("artwork", _transform(cached), [-1e9, -1e9, 1e9, 1e9], None)]` (a box covering everything reproduces the old behaviour exactly).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_export.py -v`
Expected: FAIL — `ImportError: cannot import name 'ExportFloor'`.

- [ ] **Step 3: Write the implementation**

In `backend/src/illustrator_export.py`:

```python
class FloorExportError(RuntimeError):
    """Raised when an export request does not match the stored assignment."""


@dataclass(slots=True)
class ExportFloor:
    label: str
    transform: SimilarityTransform
    region: list[float]
    layer_names: list[str] | None


def _centroid_inside(geometry, region: list[float]) -> bool:
    if geometry is None or geometry.is_empty:
        return False
    minx, miny, maxx, maxy = region
    cx, cy = geometry.centroid.x, geometry.centroid.y
    return minx <= cx <= maxx and miny <= cy <= maxy


def _matches_floor(row, region: list[float], layer_names: list[str] | None) -> bool:
    if not _centroid_inside(row.geometry, region):
        return False
    return layer_names is None or row["ai_layer"] in layer_names
```

Rewrite `build_georeferenced_bundle` to take `floors: list[ExportFloor]` and add the summary function. The per-layer loop becomes:

```python
        report_floors: list[dict] = []
        unassigned_total = 0
        warnings: list[str] = []
        for spec, gdf in _read_layers(cached):
            if gdf.empty:
                continue
            remaining = gdf
            layer_assigned = 0
            for floor in floors:
                mask = remaining.apply(_matches_floor, axis=1, region=floor.region, layer_names=floor.layer_names)
                subset = remaining[mask]
                remaining = remaining[~mask]
                if subset.empty:
                    continue
                placed = subset.copy()
                placed["geometry"] = placed.geometry.affine_transform(floor.transform.to_affine_matrix())
                placed = placed.set_crs(floor.transform.working_crs, allow_override=True)
                placed["floor"] = floor.label
                if output_crs != floor.transform.working_crs:
                    placed = placed.to_crs(output_crs)
                table = f"{_sanitize_label(floor.label)}_{spec['table']}"
                if formats.geopackage or formats.qgis:
                    placed.to_file(gpkg_path, driver="GPKG", layer=table)
                if formats.shapefile:
                    placed.to_file(
                        shapefile_dir / f"{table}.shp",
                        driver="ESRI Shapefile",
                        index=False,
                        encoding="utf-8",
                    )
                layer_assigned += len(subset)
                _report_row(report_floors, floor.label, table, len(subset))
            if layer_assigned == 0:
                warnings.append(f"Layer '{spec['ai_layer']}' was not assigned to any floor.")
            unassigned_total += len(remaining)
```

with helpers:

```python
def _sanitize_label(label: str) -> str:
    from backend.src.illustrator_importer import _sanitize_layer_name

    return _sanitize_layer_name(label, set())


def _report_row(report_floors: list[dict], label: str, table: str, count: int) -> None:
    entry = next((f for f in report_floors if f["label"] == label), None)
    if entry is None:
        entry = {"label": label, "feature_count": 0, "tables": []}
        report_floors.append(entry)
    entry["feature_count"] += count
    entry["tables"].append(table)
```

The zip gains the report:

```python
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "export_report.json",
                json.dumps(
                    {
                        "floors": report_floors,
                        "unassigned_count": unassigned_total,
                        "warnings": warnings,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            )
            # ...existing format writes...
```

The `.qgs` groups layers by floor: replace the flat `ordered` list with floor-grouped entries. Keep the existing `_order_layers` output for the layer order inside each floor group and emit a `<layer-tree-group>` per floor. (If this proves fiddly in the hand-written XML, emit one group per floor with the same `QgisLayerSpec`s; the tree-group wrapper is already used for the top level.)

`compute_assignment_summary` reuses the membership rule without transforming:

```python
def compute_assignment_summary(
    cached: CachedConversion, floors: list[ExportFloor]
) -> tuple[list[dict], int]:
    per_floor: list[dict] = []
    unassigned = 0
    for spec, gdf in _read_layers(cached):
        if gdf.empty:
            continue
        remaining = gdf
        for floor in floors:
            mask = remaining.apply(_matches_floor, axis=1, region=floor.region, layer_names=floor.layer_names)
            subset = remaining[mask]
            remaining = remaining[~mask]
            if subset.empty:
                continue
            entry = next((f for f in per_floor if f["label"] == floor.label), None)
            if entry is None:
                entry = {
                    "label": floor.label,
                    "feature_count": 0,
                    "artwork_bounds": None,
                    "layer_counts": [],
                }
                per_floor.append(entry)
            entry["feature_count"] += len(subset)
            minx, miny, maxx, maxy = subset.total_bounds
            entry["artwork_bounds"] = (
                [minx, miny, maxx, maxy]
                if entry["artwork_bounds"] is None
                else [
                    min(entry["artwork_bounds"][0], minx),
                    min(entry["artwork_bounds"][1], miny),
                    max(entry["artwork_bounds"][2], maxx),
                    max(entry["artwork_bounds"][3], maxy),
                ]
            )
            row = next(
                (r for r in entry["layer_counts"] if r["table"] == spec["table"]),
                None,
            )
            if row is None:
                row = {"table": spec["table"], "ai_layer": spec["ai_layer"], "count": 0}
                entry["layer_counts"].append(row)
            row["count"] += len(subset)
        unassigned += len(remaining)
    for entry in per_floor:
        entry["artwork_bounds"] = entry["artwork_bounds"] or [0.0, 0.0, 1.0, 1.0]
    return per_floor, unassigned
```

Keep the old single-transform path working internally: the endpoint (Task 3) converts a single implicit floor into `[ExportFloor("artwork", transform, artwork_bounds, None)]` — no code duplication in the writer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_export.py backend/tests/test_illustrator_api.py -v`
Expected: PASS. The endpoint tests are updated in Task 3; until then they fail to import `build_georeferenced_bundle` with the old signature only if they call it — they call it via the API, so they still pass until Task 3 changes the request shape.

- [ ] **Step 5: Commit**

```bash
git add backend/src/illustrator_export.py backend/tests/test_illustrator_export.py
git commit -m "feat: multi-floor export with per-floor tables and report"
```
## Task 3: Assign and export endpoints

**Files:**
- Modify: `backend/src/schemas.py`, `backend/routers/import_router.py`, `backend/main.py`, `backend/tests/test_illustrator_api.py`

**Interfaces:**
- Consumes: `ConversionStore.assign`, `ExportFloor`, `compute_assignment_summary`, `build_georeferenced_bundle`, `FloorExportError` (Tasks 1–2).
- Produces: `POST /api/convert/illustrator/{id}/assign`; reworked `POST /api/convert/illustrator/{id}/export` body `{floors: [{label, transform}], output_crs, formats}`; schemas `FloorRegionPayload`, `AssignFloorsRequest`, `AssignFloorSummary`, `AssignFloorsResponse`, `FloorExportPayload`; `IllustratorExportRequest` loses `transform`, gains `floors`.

- [ ] **Step 1: Add the schemas**

Append to `backend/src/schemas.py`:

```python
class FloorRegionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=40)
    box: list[float] = Field(min_length=4, max_length=4)
    layer_names: list[str] | None = None


class AssignFloorsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    floors: list[FloorRegionPayload] = Field(min_length=1)


class AssignLayerCount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: str
    ai_layer: str
    count: int


class AssignFloorSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    feature_count: int
    artwork_bounds: list[float]
    layer_counts: list[AssignLayerCount] = Field(default_factory=list)


class AssignFloorsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    floors: list[AssignFloorSummary] = Field(default_factory=list)
    unassigned_count: int
    total_features: int


class FloorExportPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    transform: TransformPayload
```

Replace `IllustratorExportRequest`:

```python
class IllustratorExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    floors: list[FloorExportPayload] = Field(min_length=1)
    output_crs: str = "EPSG:4326"
    formats: ExportFormatsPayload = Field(default_factory=ExportFormatsPayload)
```

- [ ] **Step 2: Add the `FloorExportError` handler**

In `backend/main.py`, add the import `from backend.src.illustrator_export import FloorExportError` and, beside the other handlers:

```python
@app.exception_handler(FloorExportError)
async def floor_export_error_handler(_: Request, exc: FloorExportError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="FLOOR_MISMATCH")
    return JSONResponse(status_code=422, content=payload.model_dump())
```

- [ ] **Step 3: Add the assign endpoint and rework export**

In `backend/routers/import_router.py`, add imports for the new schemas and:

```python
from backend.src.illustrator_export import (
    ExportFloor,
    FloorExportError,
    build_georeferenced_bundle,
    build_preview,
    compute_assignment_summary,
)
```

The assign endpoint:

```python
@router.post("/convert/illustrator/{conversion_id}/assign", response_model=AssignFloorsResponse)
async def assign_illustrator_floors(
    conversion_id: str,
    request: Request,
    payload: AssignFloorsRequest,
) -> AssignFloorsResponse:
    """Store a floor assignment (boxes + optional layer restrictions)."""
    cached = _illustrator_store(request).get(conversion_id)
    labels = [floor.label for floor in payload.floors]
    if len(set(labels)) != len(labels):
        raise ValueError("Floor labels must be unique.")
    known_layers = {spec["ai_layer"] for spec in cached.written_layers}
    for floor in payload.floors:
        if floor.layer_names:
            unknown = [name for name in floor.layer_names if name not in known_layers]
            if unknown:
                raise ValueError(f"Unknown layer name(s): {', '.join(unknown)}")

    floors = [floor.model_dump() for floor in payload.floors]
    _illustrator_store(request).assign(conversion_id, floors)
    summaries, unassigned = compute_assignment_summary(
        cached,
        [
            ExportFloor(
                label=floor["label"],
                transform=_placeholder_transform(),  # summary needs no transform; see note
                region=floor["box"],
                layer_names=floor["layer_names"],
            )
            for floor in floors
        ],
    )
    return AssignFloorsResponse(
        floors=summaries,
        unassigned_count=unassigned,
        total_features=cached.report["total_features"],
    )
```

**Note:** `compute_assignment_summary` only needs the regions, but its signature takes `ExportFloor`. Pass a module-level `_PLACEHOLDER_TRANSFORM = SimilarityTransform(artwork_anchor=(0, 0), map_anchor=(139.7, 35.7), rotation_deg=0.0, metres_per_point=1.0, working_crs="EPSG:4326")`. (If preferred, refactor `compute_assignment_summary` to take `(region, layer_names)` pairs instead; the summary is testable either way.)

The export endpoint:

```python
@router.post("/convert/illustrator/{conversion_id}/export")
async def export_illustrator(
    conversion_id: str,
    request: Request,
    payload: IllustratorExportRequest,
) -> Response:
    """Apply per-floor placements to a cached conversion and return a zip."""
    if payload.formats.qgis and not payload.formats.geopackage:
        raise ValueError("A QGIS project needs the GeoPackage; enable it or disable the project.")
    if not (payload.formats.geopackage or payload.formats.shapefile or payload.formats.qgis):
        raise ValueError("Select at least one output format.")

    cached = _illustrator_store(request).get(conversion_id)
    if cached.floors:
        stored = {floor["label"] for floor in cached.floors}
        requested = {floor.label for floor in payload.floors}
        if requested != stored:
            missing = stored - requested
            extra = requested - stored
            detail = []
            if missing:
                detail.append(f"missing floor(s): {', '.join(sorted(missing))}")
            if extra:
                detail.append(f"unknown floor(s): {', '.join(sorted(extra))}")
            raise FloorExportError("Export does not match the stored assignment: " + "; ".join(detail))

        regions = {floor["label"]: floor for floor in cached.floors}
        floors = [
            ExportFloor(
                label=floor.label,
                transform=_transform_from_payload(floor.transform),
                region=regions[floor.label]["box"],
                layer_names=regions[floor.label]["layer_names"],
            )
            for floor in payload.floors
        ]
    else:
        if len(payload.floors) != 1:
            raise FloorExportError(
                "This file has no floor assignment; send exactly one floor covering the artwork."
            )
        single = payload.floors[0]
        bounds = build_preview(cached)["artwork_bounds"]
        floors = [
            ExportFloor(
                label=single.label,
                transform=_transform_from_payload(single.transform),
                region=bounds,
                layer_names=None,
            )
        ]

    zip_bytes, filename = build_georeferenced_bundle(
        cached, floors, payload.output_crs,
        ExportFormats(
            geopackage=payload.formats.geopackage,
            shapefile=payload.formats.shapefile,
            qgis=payload.formats.qgis,
        ),
    )
    ascii_name = filename.encode("ascii", "ignore").decode() or "output.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
            ),
        },
    )
```

with the helper:

```python
def _transform_from_payload(payload: TransformPayload) -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=(payload.artwork_anchor[0], payload.artwork_anchor[1]),
        map_anchor=(payload.map_anchor[0], payload.map_anchor[1]),
        rotation_deg=payload.rotation_deg,
        metres_per_point=payload.metres_per_point,
        working_crs=payload.working_crs,
    )
```

Import `TransformPayload` in the router (already imported for placements).

- [ ] **Step 4: Update the endpoint tests**

In `backend/tests/test_illustrator_api.py`, change `_body(bounds)` to return the new shape:

```python
def _body(bounds, **overrides):
    body = {
        "floors": [
            {
                "label": "artwork",
                "transform": {
                    "artwork_anchor": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
                    "map_anchor": [139.700258, 35.690921],
                    "rotation_deg": 12.5,
                    "metres_per_point": 0.176389,
                    "working_crs": "EPSG:6677",
                },
            }
        ],
        "output_crs": "EPSG:6677",
        "formats": {"geopackage": True, "shapefile": True, "qgis": True},
    }
    body.update(overrides)
    return body
```

Append new tests:

```python
def _assign_body():
    return {
        "floors": [
            {"label": "1F", "box": [0.0, 0.0, 200.0, 200.0], "layer_names": None},
            {"label": "2F", "box": [200.0, 0.0, 400.0, 200.0], "layer_names": None},
        ]
    }


@pytest.mark.georef
def test_assign_returns_per_floor_counts(test_client) -> None:
    payload = _preview(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign",
        json=_assign_body(),
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert {floor["label"] for floor in data["floors"]} == {"1F", "2F"}
    assert data["total_features"] == payload["total_features"]
    assert data["unassigned_count"] + sum(
        floor["feature_count"] for floor in data["floors"]
    ) == data["total_features"]


@pytest.mark.georef
def test_assign_rejects_duplicate_labels(test_client) -> None:
    payload = _preview(test_client).json()
    body = _assign_body()
    body["floors"][1]["label"] = "1F"
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign", json=body
    )
    assert response.status_code == 400


@pytest.mark.georef
def test_export_after_assignment_requires_all_floors(test_client) -> None:
    payload = _preview(test_client).json()
    assert test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign", json=_assign_body()
    ).status_code == 200
    bounds = payload["artwork_bounds"]
    body = _body(bounds)
    body["floors"] = body["floors"][:1]
    body["floors"][0]["label"] = "1F"
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 422
    assert response.json()["code"] == "FLOOR_MISMATCH"


@pytest.mark.georef
def test_export_after_assignment_with_all_floors_succeeds(test_client) -> None:
    payload = _preview(test_client).json()
    assert test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign", json=_assign_body()
    ).status_code == 200
    bounds = payload["artwork_bounds"]
    body = _body(bounds)
    body["floors"] = [
        {
            "label": label,
            "transform": body["floors"][0]["transform"],
        }
        for label in ("1F", "2F")
    ]
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert "export_report.json" in names


@pytest.mark.georef
def test_export_without_assignment_still_works_single_floor(test_client) -> None:
    """Backward compatibility: one implicit floor, no assign call."""
    payload = _preview(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export",
        json=_body(payload["artwork_bounds"]),
    )
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert any(n.endswith(".qgs") for n in names)
```

- [ ] **Step 5: Run the whole backend suite**

Run: `pytest backend/tests -v`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Commit**

```bash
git add backend/src/schemas.py backend/routers/import_router.py backend/main.py backend/tests/test_illustrator_api.py
git commit -m "feat: floor assignment and multi-floor export endpoints"
```

---

## Task 4: Placements floors column

**Files:**
- Modify: `backend/src/placements.py`, `backend/src/schemas.py`, `backend/routers/import_router.py`, `backend/tests/test_placements.py`, `backend/tests/test_illustrator_api.py`

**Interfaces:**
- Consumes: `FloorExportPayload` (Task 3).
- Produces: `Placement` gains `floors: list[dict]` (each `{label, transform:{...}}`); `PlacementStore.create/update` take `floors` instead of a single `transform`; `PlacementRequest`/`PlacementItem` become `{name, floors, artwork_bounds}`.

- [ ] **Step 1: Update the store tests**

Rewrite the fixtures and assertions in `backend/tests/test_placements.py`:

```python
FLOORS = [
    {
        "label": "1F",
        "transform": {
            "artwork_anchor": [85.0, 80.0],
            "map_anchor": [139.700258, 35.690921],
            "rotation_deg": 12.5,
            "metres_per_point": 0.176389,
            "working_crs": "EPSG:6677",
        },
    },
    {
        "label": "2F",
        "transform": {
            "artwork_anchor": [285.0, 80.0],
            "map_anchor": [139.701, 35.6912],
            "rotation_deg": 12.5,
            "metres_per_point": 0.176389,
            "working_crs": "EPSG:6677",
        },
    },
]
BOUNDS = [0.0, 0.0, 500.0, 550.0]
```

Replace every `TRANSFORM` usage in `create`/`update` calls with `FLOORS`, and update assertions:

- `test_create_then_list_round_trips`: `listed[0].floors[0]["transform"]["working_crs"] == "EPSG:6677"`; `listed[0].floors[1]["label"] == "2F"`.
- `test_update_replaces_the_transform`: `updated.floors[0]["transform"]["rotation_deg"] == -40.0`.

- [ ] **Step 2: Run to verify they fail**

Run: `pytest backend/tests/test_placements.py -v`
Expected: FAIL — signature/attribute errors.

- [ ] **Step 3: Write the implementation**

In `backend/src/placements.py`, replace the schema and the column helpers:

```sql
CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  floors TEXT NOT NULL,
  artwork_bounds TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

```python
@dataclass(slots=True)
class Placement:
    id: int
    name: str
    floors: list[dict]
    artwork_bounds: list[float]
    created_at: str
    updated_at: str
```

```python
    @staticmethod
    def _to_placement(row: sqlite3.Row) -> Placement:
        return Placement(
            id=row["id"],
            name=row["name"],
            floors=json.loads(row["floors"]),
            artwork_bounds=json.loads(row["artwork_bounds"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
```

`create`/`update` gain `floors: list[dict]` and write `json.dumps(floors)`; drop `_columns`.

In `backend/src/schemas.py`, replace `PlacementRequest`/`PlacementItem`:

```python
class PlacementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    floors: list[FloorExportPayload] = Field(min_length=1)
    artwork_bounds: list[float] = Field(min_length=4, max_length=4)


class PlacementItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    floors: list[FloorExportPayload]
    artwork_bounds: list[float]
    created_at: str
    updated_at: str
```

In `backend/routers/import_router.py`, update `_placement_item` and the create/update calls to pass `payload.floors` and `[FloorExportPayload(**f) for f in placement.floors]`.

- [ ] **Step 4: Update the API tests**

In `backend/tests/test_illustrator_api.py`, replace `PLACEMENT_BODY`:

```python
PLACEMENT_BODY = {
    "name": "Placement CRUD Test",
    "floors": [
        {
            "label": "1F",
            "transform": {
                "artwork_anchor": [85.0, 80.0],
                "map_anchor": [139.700258, 35.690921],
                "rotation_deg": 12.5,
                "metres_per_point": 0.176389,
                "working_crs": "EPSG:6677",
            },
        }
    ],
    "artwork_bounds": [0.0, 0.0, 500.0, 550.0],
}
```

and the update assertion `updated.json()["floors"][0]["transform"]["rotation_deg"] == -3.0`.

- [ ] **Step 5: Run the whole backend suite**

Run: `pytest backend/tests -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/placements.py backend/src/schemas.py backend/routers/import_router.py backend/tests/test_placements.py backend/tests/test_illustrator_api.py
git commit -m "feat: placements store a set of floor transforms"
```
## Task 5: Reducer floor model

**Files:**
- Modify: `frontend/src/hooks/useIllustratorPlacement.ts`, `frontend/src/hooks/useIllustratorPlacement.test.ts`

**Interfaces:**
- Consumes: `SimilarityTransform`, `lngLatToEnu`, `enuToLngLat`, `metresPerPointForScale` from `lib/similarity`; `TransformPayload` from `api/client`.
- Produces: types `FloorPlacement`, `PlacementState`, `PlacementAction`; `resolvedTransform(state, floor) -> SimilarityTransform`; `toFloorPayloads(state) -> {label, transform: TransformPayload}[]`; `floorPayloadsToState(floors: {label, transform: TransformPayload}[], current: PlacementState) -> PlacementState` (used by placement apply); `placementReducer`, `currentResiduals`, `useIllustratorPlacement`.

```ts
export type FloorPlacement = {
  label: string;
  linked: boolean;
  artworkAnchor: [number, number];
  mapAnchor: [number, number];
  controlPoints: ControlPoint[];
  artworkBounds: [number, number, number, number];
  /** Own scale/rotation once unlinked; undefined while linked (frame is used). */
  rotationDeg?: number;
  metresPerPoint?: number;
};

export type PlacementState = {
  frame: { rotationDeg: number; metresPerPoint: number; workingCrs: string };
  floors: FloorPlacement[];
  activeFloorLabel: string | null;
  scaleLocked: boolean;
};

export type PlacementAction =
  | { type: "positionBuilding"; mapAnchor: [number, number] }
  | { type: "dragFloor"; label: string; mapAnchor: [number, number] }
  | { type: "rotateFrame"; rotationDeg: number }
  | { type: "scaleFrame"; metresPerPoint: number }
  | { type: "setDrawingScale"; denominator: number }
  | { type: "calibrateDistance"; artworkDistance: number; realMetres: number }
  | { type: "unlockScale" }
  | { type: "unlockFloor"; label: string }
  | { type: "relinkFloor"; label: string }
  | { type: "setActiveFloor"; label: string }
  | { type: "setWorkingCrs"; workingCrs: string }
  | { type: "addControlPoint"; point: ControlPoint }
  | { type: "removeControlPoint"; id: string }
  | { type: "fitControlPoints" }
  | { type: "applyFloors"; floors: { label: string; transform: TransformPayload }[] };
```

- [ ] **Step 1: Write the failing tests**

Rewrite `frontend/src/hooks/useIllustratorPlacement.test.ts`. The single-floor cases must keep passing (they now go through the frame); new floor cases pin the derivation math with exact golden values.

```typescript
import {
  currentResiduals,
  floorPayloadsToState,
  placementReducer,
  resolvedTransform,
  toFloorPayloads,
  type FloorPlacement,
  type PlacementState
} from "./useIllustratorPlacement";
import { enuToLngLat, lngLatToEnu, type SimilarityTransform } from "../lib/similarity";

const ANCHOR: [number, number] = [139.700258, 35.690921];

function floor(label: string, anchor: [number, number], linked = true): FloorPlacement {
  return {
    label,
    linked,
    artworkAnchor: label === "1F" ? [85, 80] : [285, 80],
    mapAnchor: anchor,
    controlPoints: [],
    artworkBounds: label === "1F" ? [0, 0, 170, 160] : [200, 0, 370, 160]
  };
}

const BASE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  floors: [floor("1F", ANCHOR), floor("2F", [139.700258, 35.690921])],
  activeFloorLabel: "1F",
  scaleLocked: false
};

// ---- existing single-floor behaviour through the frame ----

test("positioning the active floor moves every linked floor by derivation", () => {
  const target: [number, number] = [139.71, 35.70];
  const next = placementReducer(BASE, { type: "positionBuilding", mapAnchor: target });
  expect(next.floors[0].mapAnchor).toEqual(target);
  // 1F -> 2F artwork offset is (200, 0) pt; at s=0.176389 that is 35.2778 m east.
  const [e, n] = lngLatToEnu(next.floors[1].mapAnchor[0], next.floors[1].mapAnchor[1], target[0], target[1]);
  expect(e).toBeCloseTo(200 * 0.176389, 6);
  expect(n).toBeCloseTo(0, 6);
});

test("rotateFrame rotates linked offsets about the active anchor", () => {
  const next = placementReducer(BASE, { type: "rotateFrame", rotationDeg: 90 });
  expect(next.frame.rotationDeg).toBe(90);
  const [e, n] = lngLatToEnu(next.floors[1].mapAnchor[0], next.floors[1].mapAnchor[1], ANCHOR[0], ANCHOR[1]);
  // (200,0) pt rotated 90deg CCW -> (0, 200) pt -> 35.2778 m north.
  expect(e).toBeCloseTo(0, 6);
  expect(n).toBeCloseTo(200 * 0.176389, 6);
});

test("dragging a floor unlinks it and leaves others alone", () => {
  const dragged: [number, number] = [139.72, 35.71];
  const next = placementReducer(BASE, { type: "dragFloor", label: "2F", mapAnchor: dragged });
  expect(next.floors[1].linked).toBe(false);
  expect(next.floors[1].mapAnchor).toEqual(dragged);
  expect(next.floors[0].mapAnchor).toEqual(ANCHOR);
  expect(next.floors[0].linked).toBe(true);
});

test("frame operations ignore unlinked floors", () => {
  let state = placementReducer(BASE, { type: "dragFloor", label: "2F", mapAnchor: [139.72, 35.71] });
  state = placementReducer(state, { type: "rotateFrame", rotationDeg: 45 });
  const unlinked = state.floors[1];
  const [e, n] = lngLatToEnu(unlinked.mapAnchor[0], unlinked.mapAnchor[1], ANCHOR[0], ANCHOR[1]);
  expect(e).toBeCloseTo(200 * 0.176389, 6); // unchanged by the rotation
  expect(n).toBeCloseTo(0, 6);
});

test("relinkFloor restores derivation from the frame", () => {
  let state = placementReducer(BASE, { type: "dragFloor", label: "2F", mapAnchor: [139.72, 35.71] });
  state = placementReducer(state, { type: "relinkFloor", label: "2F" });
  expect(state.floors[1].linked).toBe(true);
  const [e, n] = lngLatToEnu(state.floors[1].mapAnchor[0], state.floors[1].mapAnchor[1], ANCHOR[0], ANCHOR[1]);
  expect(e).toBeCloseTo(200 * 0.176389, 6);
});

test("unlockFloor freezes the frame values into the floor", () => {
  const state = placementReducer(BASE, { type: "unlockFloor", label: "2F" });
  const f = state.floors[1];
  expect(f.linked).toBe(false);
  expect(f.rotationDeg).toBe(0);
  expect(f.metresPerPoint).toBeCloseTo(0.176389, 9);
});

test("single-floor dragging keeps the floor linked", () => {
  const single: PlacementState = { ...BASE, floors: [floor("1F", ANCHOR)] };
  const next = placementReducer(single, { type: "dragFloor", label: "1F", mapAnchor: [139.72, 35.71] });
  expect(next.floors[0].linked).toBe(true);
});

test("a locked scale rejects scaleFrame", () => {
  let state = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  state = placementReducer(state, { type: "scaleFrame", metresPerPoint: 9 });
  expect(state.frame.metresPerPoint).toBeCloseTo(0.1763888888, 9);
});

test("rotateFrame without any linked floor no-ops", () => {
  let state = placementReducer(BASE, { type: "unlockFloor", label: "1F" });
  state = placementReducer(state, { type: "unlockFloor", label: "2F" });
  const next = placementReducer(state, { type: "rotateFrame", rotationDeg: 33 });
  expect(next.frame.rotationDeg).toBe(0);
});

test("resolvedTransform uses the frame for linked floors", () => {
  const resolved = resolvedTransform(BASE, BASE.floors[1]);
  expect(resolved.rotationDeg).toBe(0);
  expect(resolved.metresPerPoint).toBeCloseTo(0.176389, 9);
  expect(resolved.workingCrs).toBe("EPSG:6677");
});

test("resolvedTransform uses the floor's own values once unlinked", () => {
  const state = placementReducer(BASE, { type: "unlockFloor", label: "2F" });
  const f = state.floors[1];
  const resolved = resolvedTransform(state, f);
  expect(resolved.rotationDeg).toBe(0);
  expect(resolved.artworkAnchor).toEqual(f.artworkAnchor);
});

test("toFloorPayloads emits one payload per floor", () => {
  const payloads = toFloorPayloads(BASE);
  expect(payloads.map((p) => p.label)).toEqual(["1F", "2F"]);
  expect(payloads[0].transform.working_crs).toBe("EPSG:6677");
});

test("floorPayloadsToState rebuilds linked floors and the frame", () => {
  const saved = [
    { label: "1F", transform: { artwork_anchor: [85, 80], map_anchor: [139.701, 35.701], rotation_deg: 10, metres_per_point: 0.176389, working_crs: "EPSG:6677" } },
    { label: "2F", transform: { artwork_anchor: [285, 80], map_anchor: [139.7015, 35.7018], rotation_deg: 10, metres_per_point: 0.176389, working_crs: "EPSG:6677" } }
  ];
  const state = floorPayloadsToState(saved, BASE);
  expect(state.floors.every((f) => f.linked)).toBe(true);
  expect(state.frame.rotationDeg).toBe(10);
  expect(state.frame.metresPerPoint).toBeCloseTo(0.176389, 9);
  expect(state.floors[0].mapAnchor).toEqual([139.701, 35.701]);
  expect(state.floors[0].artworkAnchor).toEqual([85, 80]);
});

test("control points act on the active floor", () => {
  let state = placementReducer(BASE, { type: "setActiveFloor", label: "2F" });
  state = placementReducer(state, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  expect(state.floors[1].controlPoints).toHaveLength(1);
  expect(state.floors[0].controlPoints).toHaveLength(0);
  state = placementReducer(state, { type: "removeControlPoint", id: "a" });
  expect(state.floors[1].controlPoints).toHaveLength(0);
});

// ---- retained single-floor reducer behaviour ----

test("rotation is normalised into (-180, 180]", () => {
  expect(placementReducer(BASE, { type: "rotateFrame", rotationDeg: 200 }).frame.rotationDeg).toBe(-160);
  expect(placementReducer(BASE, { type: "rotateFrame", rotationDeg: -540 }).frame.rotationDeg).toBe(180);
});

test("setting a drawing scale locks the scale", () => {
  const next = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  expect(next.frame.metresPerPoint).toBeCloseTo(0.1763888888, 9);
  expect(next.scaleLocked).toBe(true);
});

test("unlocking the scale lets scaleFrame work again", () => {
  let state = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  state = placementReducer(state, { type: "unlockScale" });
  state = placementReducer(state, { type: "scaleFrame", metresPerPoint: 0.5 });
  expect(state.frame.metresPerPoint).toBe(0.5);
});

test("distance calibration locks the scale", () => {
  const next = placementReducer(BASE, {
    type: "calibrateDistance",
    artworkDistance: 400,
    realMetres: 70.5556
  });
  expect(next.frame.metresPerPoint).toBeCloseTo(0.1763889, 6);
  expect(next.scaleLocked).toBe(true);
});

test("residuals use the active floor's control points", () => {
  let state = placementReducer(BASE, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  state = placementReducer(state, {
    type: "addControlPoint",
    point: { id: "b", artwork: [500, 0], map: [139.701, 35.6903] }
  });
  const fit = currentResiduals(state);
  expect(fit).not.toBeNull();
  expect(fit!.rmse).toBeLessThan(0.01);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/hooks/useIllustratorPlacement.test.ts`
Expected: FAIL — types and actions do not exist yet.

- [ ] **Step 3: Write the implementation**

Rewrite `frontend/src/hooks/useIllustratorPlacement.ts`:

```typescript
import { useReducer } from "react";

import type { TransformPayload } from "../api/client";
import {
  enuToLngLat,
  fitHelmert,
  lngLatToEnu,
  metresPerPointForScale,
  residuals,
  type SimilarityTransform
} from "../lib/similarity";

export type ControlPoint = { id: string; artwork: [number, number]; map: [number, number] };

export type FloorPlacement = {
  label: string;
  linked: boolean;
  artworkAnchor: [number, number];
  mapAnchor: [number, number];
  controlPoints: ControlPoint[];
  artworkBounds: [number, number, number, number];
  rotationDeg?: number;
  metresPerPoint?: number;
};

export type PlacementState = {
  frame: { rotationDeg: number; metresPerPoint: number; workingCrs: string };
  floors: FloorPlacement[];
  activeFloorLabel: string | null;
  scaleLocked: boolean;
};

export type PlacementAction =
  | { type: "positionBuilding"; mapAnchor: [number, number] }
  | { type: "dragFloor"; label: string; mapAnchor: [number, number] }
  | { type: "rotateFrame"; rotationDeg: number }
  | { type: "scaleFrame"; metresPerPoint: number }
  | { type: "setDrawingScale"; denominator: number }
  | { type: "calibrateDistance"; artworkDistance: number; realMetres: number }
  | { type: "unlockScale" }
  | { type: "unlockFloor"; label: string }
  | { type: "relinkFloor"; label: string }
  | { type: "setActiveFloor"; label: string }
  | { type: "setWorkingCrs"; workingCrs: string }
  | { type: "addControlPoint"; point: ControlPoint }
  | { type: "removeControlPoint"; id: string }
  | { type: "fitControlPoints" }
  | { type: "applyFloors"; floors: { label: string; transform: TransformPayload }[] };

function normaliseRotation(degrees: number): number {
  const wrapped = ((degrees + 180) % 360) - 180;
  return wrapped <= -180 ? wrapped + 360 : wrapped;
}

export function resolvedTransform(state: PlacementState, floor: FloorPlacement): SimilarityTransform {
  return {
    artworkAnchor: floor.artworkAnchor,
    mapAnchor: floor.mapAnchor,
    rotationDeg: floor.linked ? state.frame.rotationDeg : (floor.rotationDeg ?? state.frame.rotationDeg),
    metresPerPoint: floor.linked ? state.frame.metresPerPoint : (floor.metresPerPoint ?? state.frame.metresPerPoint),
    workingCrs: state.frame.workingCrs
  };
}

/** The active linked floor, or null. */
function activeFloor(state: PlacementState): FloorPlacement | null {
  return state.floors.find((f) => f.label === state.activeFloorLabel) ?? null;
}

/** Derived anchor for a linked floor: active anchor + frame applied to the artwork offset. */
function deriveAnchor(state: PlacementState, floor: FloorPlacement): [number, number] {
  const active = activeFloor(state);
  if (!active) return floor.mapAnchor;
  const dx = floor.artworkAnchor[0] - active.artworkAnchor[0];
  const dy = floor.artworkAnchor[1] - active.artworkAnchor[1];
  const theta = (state.frame.rotationDeg * Math.PI) / 180;
  const s = state.frame.metresPerPoint;
  const east = s * (Math.cos(theta) * dx - Math.sin(theta) * dy);
  const north = s * (Math.sin(theta) * dx + Math.cos(theta) * dy);
  return enuToLngLat(east, north, active.mapAnchor[0], active.mapAnchor[1]);
}

function recomputeLinked(state: PlacementState): PlacementState {
  const active = activeFloor(state);
  if (!active) return state;
  return {
    ...state,
    floors: state.floors.map((f) =>
      f.label === active.label || !f.linked ? f : { ...f, mapAnchor: deriveAnchor(state, f) }
    )
  };
}

export function toFloorPayloads(state: PlacementState): { label: string; transform: TransformPayload }[] {
  return state.floors.map((f) => {
    const t = resolvedTransform(state, f);
    return {
      label: f.label,
      transform: {
        artwork_anchor: t.artworkAnchor,
        map_anchor: t.mapAnchor,
        rotation_deg: t.rotationDeg,
        metres_per_point: t.metresPerPoint,
        working_crs: t.workingCrs
      }
    };
  });
}

export function floorPayloadsToState(
  floors: { label: string; transform: TransformPayload }[],
  current: PlacementState
): PlacementState {
  const active = floors[0]?.label ?? null;
  const frameTransform = floors.find((f) => f.label === active)?.transform;
  const byLabel = new Map(floors.map((f) => [f.label, f.transform]));
  return {
    frame: {
      rotationDeg: frameTransform?.rotation_deg ?? current.frame.rotationDeg,
      metresPerPoint: frameTransform?.metres_per_point ?? current.frame.metresPerPoint,
      workingCrs: frameTransform?.working_crs ?? current.frame.workingCrs
    },
    activeFloorLabel: active,
    scaleLocked: true,
    floors: current.floors.map((f) => {
      const saved = byLabel.get(f.label);
      return saved
        ? {
            ...f,
            linked: true,
            mapAnchor: [saved.map_anchor[0], saved.map_anchor[1]] as [number, number],
            rotationDeg: undefined,
            metresPerPoint: undefined,
            controlPoints: []
          }
        : f;
    })
  };
}

export function placementReducer(state: PlacementState, action: PlacementAction): PlacementState {
  switch (action.type) {
    case "positionBuilding": {
      const active = activeFloor(state);
      if (!active) return state;
      const moved = {
        ...state,
        floors: state.floors.map((f) =>
          f.label === active.label ? { ...f, mapAnchor: action.mapAnchor } : f
        )
      };
      return active.linked ? recomputeLinked(moved) : moved;
    }

    case "dragFloor": {
      const single = state.floors.length === 1;
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === action.label
            ? { ...f, mapAnchor: action.mapAnchor, linked: single ? f.linked : false }
            : f
        )
      };
    }

    case "rotateFrame": {
      const rotationDeg = normaliseRotation(action.rotationDeg);
      if (!state.floors.some((f) => f.linked)) return state;
      return recomputeLinked({ ...state, frame: { ...state.frame, rotationDeg } });
    }

    case "scaleFrame": {
      if (state.scaleLocked || !(action.metresPerPoint > 0)) return state;
      return recomputeLinked({
        ...state,
        frame: { ...state.frame, metresPerPoint: action.metresPerPoint }
      });
    }

    case "setDrawingScale": {
      if (!(action.denominator > 0)) return state;
      return recomputeLinked({
        ...state,
        scaleLocked: true,
        frame: { ...state.frame, metresPerPoint: metresPerPointForScale(action.denominator) }
      });
    }

    case "calibrateDistance": {
      if (!(action.artworkDistance > 0) || !(action.realMetres > 0)) return state;
      return recomputeLinked({
        ...state,
        scaleLocked: true,
        frame: { ...state.frame, metresPerPoint: action.realMetres / action.artworkDistance }
      });
    }

    case "unlockScale":
      return { ...state, scaleLocked: false };

    case "setWorkingCrs":
      return { ...state, frame: { ...state.frame, workingCrs: action.workingCrs } };

    case "unlockFloor":
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === action.label
            ? {
                ...f,
                linked: false,
                rotationDeg: state.frame.rotationDeg,
                metresPerPoint: state.frame.metresPerPoint
              }
            : f
        )
      };

    case "relinkFloor": {
      const floor = state.floors.find((f) => f.label === action.label);
      if (!floor || floor.linked) return state;
      const linked = { ...floor, linked: true, rotationDeg: undefined, metresPerPoint: undefined };
      return recomputeLinked({ ...state, floors: state.floors.map((f) => (f.label === action.label ? linked : f)) });
    }

    case "setActiveFloor":
      return { ...state, activeFloorLabel: action.label };

    case "addControlPoint":
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === state.activeFloorLabel
            ? { ...f, controlPoints: [...f.controlPoints, action.point] }
            : f
        )
      };

    case "removeControlPoint":
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === state.activeFloorLabel
            ? { ...f, controlPoints: f.controlPoints.filter((p) => p.id !== action.id) }
            : f
        )
      };

    case "fitControlPoints": {
      const active = activeFloor(state);
      if (!active || active.controlPoints.length < 2) return state;
      const [lon0, lat0] = active.mapAnchor;
      const enu = active.controlPoints.map((p) => lngLatToEnu(p.map[0], p.map[1], lon0, lat0));
      const fitted = fitHelmert(
        active.controlPoints.map((p) => p.artwork),
        enu,
        state.frame.workingCrs,
        active.linked && state.scaleLocked ? state.frame.metresPerPoint : undefined
      );
      const [lon, lat] = enuToLngLat(fitted.mapAnchor[0], fitted.mapAnchor[1], lon0, lat0);
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === active.label
            ? { ...f, mapAnchor: [lon, lat], linked: f.linked && fitted.rotationDeg === 0 ? f.linked : false }
            : f
        )
      };
    }

    case "applyFloors":
      return floorPayloadsToState(action.floors, state);

    default:
      return state;
  }
}

export function currentResiduals(state: PlacementState): { perPoint: number[]; rmse: number } | null {
  const active = activeFloor(state);
  if (!active || active.controlPoints.length < 2) return null;
  const [lon0, lat0] = active.mapAnchor;
  const enu = active.controlPoints.map((p) => lngLatToEnu(p.map[0], p.map[1], lon0, lat0));
  return residuals(
    resolvedTransform(state, active),
    active.controlPoints.map((p) => p.artwork),
    enu
  );
}

export function useIllustratorPlacement(initial: PlacementState) {
  const [state, dispatch] = useReducer(placementReducer, initial);
  return { state, dispatch };
}
```

Note on `fitControlPoints`: a fitted rotation is a *map* rotation about the fitted anchor; for a linked floor the rotation is stored on the frame, so a fit that changes rotation must unlink the floor (otherwise the fitted rotation would silently diverge from the frame). The reducer above unlinks when the fitted rotation is non-zero. (If the fit produces rotation 0, the floor may stay linked.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run src/hooks/useIllustratorPlacement.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Verify the rest of the frontend still builds**

Run: `cd frontend && npx tsc -b`
Expected: the components still import the old `placementReducer` shape, so expect type errors in `IllustratorPage.tsx`/`PlacementMap.tsx`/panels — those are fixed in Tasks 7–9. **Do not commit with a broken build.** Either land this task with a temporary compatibility shim, or commit Task 5 and Task 8's interface fix together. Recommended: commit Task 5 alone is not buildable — so this task's commit includes the minimal mechanical updates to the components so `tsc` passes (their full multi-floor behaviour lands in Tasks 7–9):

- `PlacementMap.tsx`: render `transformGeoJson(preview, resolvedTransform(state, active))` for the active floor only (single-floor visual parity), keep the rest of the props.
- `TransformHandles.tsx`: use the active floor's resolved transform and region bounds.
- `IllustratorPage.tsx`: build the initial state with one implicit floor; export payload via `toFloorPayloads`.
- Panels: read/write through the frame.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useIllustratorPlacement.ts frontend/src/hooks/useIllustratorPlacement.test.ts frontend/src/pages/IllustratorPage.tsx frontend/src/components/illustrator/
git commit -m "feat: floor-based placement reducer with shared frame"
```
## Task 6: SVG preview painter and floor partition

**Files:**
- Create: `frontend/src/lib/svgPreview.ts`, `frontend/src/lib/svgPreview.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SvgPath = { d: string; fill: string | null; stroke: string | null; role: string }`; `geometryToPath(geometry): string`; `buildSvgPaths(preview, bounds): { viewBox: string; paths: SvgPath[] }`; `featureCentroid(feature): [number, number]`; `partitionByFloors(preview, floors): { perFloor: Map<string, any[]>; unassigned: any[] }` where `floors = { label: string; box: [number, number, number, number]; layerNames: string[] | null }[]`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/svgPreview.test.ts`:

```typescript
import {
  buildSvgPaths,
  featureCentroid,
  geometryToPath,
  partitionByFloors
} from "./svgPreview";

const POLYGON = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0]
    ]
  ]
};
const LINE = { type: "LineString", coordinates: [[0, 0], [5, 5]] };
const MULTI = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0]
      ]
    ],
    [
      [
        [4, 0],
        [6, 0],
        [6, 2],
        [4, 2],
        [4, 0]
      ]
    ]
  ]
};

test("a polygon becomes a closed M/L/Z path", () => {
  const d = geometryToPath(POLYGON as any);
  expect(d.startsWith("M0,0")).toBe(true);
  expect(d.endsWith("Z")).toBe(true);
  expect(d).toContain("L10,0");
});

test("a line is an open path", () => {
  const d = geometryToPath(LINE as any);
  expect(d.endsWith("Z")).toBe(false);
  expect(d).toContain("L5,5");
});

test("a multipolygon emits one subpath per part", () => {
  const d = geometryToPath(MULTI as any);
  expect(d.match(/M/g)).toHaveLength(2);
});

test("buildSvgPaths produces a viewBox and one path per feature", () => {
  const preview = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { role: "polygon", fill_color: "#ff0000" }, geometry: POLYGON },
      { type: "Feature", properties: { role: "line", stroke_color: "#0000ff" }, geometry: LINE }
    ]
  };
  const { viewBox, paths } = buildSvgPaths(preview as any, [0, 0, 10, 10]);
  expect(viewBox).toBe("0 0 10 10");
  expect(paths).toHaveLength(2);
  expect(paths[0].fill).toBe("#ff0000");
  expect(paths[1].stroke).toBe("#0000ff");
});

test("featureCentroid averages the coordinates", () => {
  const centroid = featureCentroid({ geometry: POLYGON } as any);
  expect(centroid[0]).toBeCloseTo(5, 6);
  expect(centroid[1]).toBeCloseTo(5, 6);
});

test("partitionByFloors assigns by centroid and layer restriction", () => {
  const preview = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { ai_layer: "壁" }, geometry: POLYGON }, // centroid (5,5)
      { type: "Feature", properties: { ai_layer: "柱" }, geometry: { type: "Point", coordinates: [25, 5] } },
      { type: "Feature", properties: { ai_layer: "柱" }, geometry: { type: "Point", coordinates: [100, 100] } }
    ]
  };
  const floors = [
    { label: "1F", box: [0, 0, 20, 20], layerNames: null },
    { label: "2F", box: [20, 0, 40, 20], layerNames: ["柱"] }
  ];
  const { perFloor, unassigned } = partitionByFloors(preview as any, floors);
  expect(perFloor.get("1F")).toHaveLength(1);
  expect(perFloor.get("2F")).toHaveLength(1);
  expect(unassigned).toHaveLength(1); // the (100,100) point is in no box
});

test("layer restriction excludes matching-position features on other layers", () => {
  const preview = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { ai_layer: "壁" }, geometry: { type: "Point", coordinates: [30, 5] } },
      { type: "Feature", properties: { ai_layer: "柱" }, geometry: { type: "Point", coordinates: [30, 5] } }
    ]
  };
  const floors = [{ label: "2F", box: [20, 0, 40, 20], layerNames: ["柱"] }];
  const { perFloor, unassigned } = partitionByFloors(preview as any, floors);
  expect(perFloor.get("2F")).toHaveLength(1);
  expect(unassigned).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/svgPreview.test.ts`
Expected: FAIL — cannot resolve `./svgPreview`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/svgPreview.ts`:

```typescript
/**
 * Artwork-preview painting and floor partitioning.
 *
 * The preview is a decimated GeoJSON FeatureCollection in artwork points. It is
 * rendered to SVG for the assignment panel, and partitioned by the same
 * centroid-in-box rule the server applies at export. The partition here is
 * display-only: the server re-verifies membership from full-fidelity geometry.
 */

export type SvgPath = { d: string; fill: string | null; stroke: string | null; role: string };

type Feature = { type: "Feature"; properties: Record<string, unknown>; geometry: any };
type Preview = { type: "FeatureCollection"; features: Feature[] };

export type PartitionFloor = {
  label: string;
  box: [number, number, number, number];
  layerNames: string[] | null;
};

function pointString(coord: number[]): string {
  return `${coord[0]},${coord[1]}`;
}

function ringToPath(ring: number[][]): string {
  return "M" + ring.map(pointString).join("L") + "Z";
}

export function geometryToPath(geometry: any): string {
  switch (geometry.type) {
    case "Polygon":
      return geometry.coordinates.map(ringToPath).join("");
    case "MultiPolygon":
      return geometry.coordinates.map((poly: any) => poly.map(ringToPath).join("")).join("");
    case "LineString":
      return "M" + geometry.coordinates.map(pointString).join("L");
    case "MultiLineString":
      return geometry.coordinates
        .map((line: any) => "M" + line.map(pointString).join("L"))
        .join("");
    case "Point":
      return `M${pointString(geometry.coordinates)}l0.5,0.5L${geometry.coordinates[0] + 0.5},${geometry.coordinates[1] - 0.5}z`;
    default:
      return "";
  }
}

export function buildSvgPaths(preview: Preview, bounds: [number, number, number, number]): {
  viewBox: string;
  paths: SvgPath[];
} {
  const [minx, miny, maxx, maxy] = bounds;
  return {
    viewBox: `${minx} ${miny} ${maxx - minx} ${maxy - miny}`,
    paths: preview.features.map((feature) => ({
      d: geometryToPath(feature.geometry),
      fill: (feature.properties.fill_color as string) ?? null,
      stroke: (feature.properties.stroke_color as string) ?? null,
      role: (feature.properties.role as string) ?? "polygon"
    }))
  };
}

function ringCentroid(ring: number[][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

export function featureCentroid(feature: Feature): [number, number] {
  const geometry = feature.geometry;
  if (geometry.type === "Point") return [geometry.coordinates[0], geometry.coordinates[1]];
  const parts: number[][][] =
    geometry.type === "Polygon"
      ? [geometry.coordinates[0]]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates.map((poly: any) => poly[0])
        : geometry.type === "MultiLineString"
          ? geometry.coordinates
          : [geometry.coordinates];
  const centroids = parts.map(ringCentroid);
  const x = centroids.reduce((sum, c) => sum + c[0], 0) / centroids.length;
  const y = centroids.reduce((sum, c) => sum + c[1], 0) / centroids.length;
  return [x, y];
}

export function partitionByFloors(
  preview: Preview,
  floors: PartitionFloor[]
): { perFloor: Map<string, Feature[]>; unassigned: Feature[] } {
  const perFloor = new Map<string, Feature[]>(floors.map((f) => [f.label, []]));
  const unassigned: Feature[] = [];

  for (const feature of preview.features) {
    const [cx, cy] = featureCentroid(feature);
    const layer = feature.properties.ai_layer as string | undefined;
    const match = floors.find((floor) => {
      const [minx, miny, maxx, maxy] = floor.box;
      if (!(minx <= cx && cx <= maxx && miny <= cy && cy <= maxy)) return false;
      return floor.layerNames === null || floor.layerNames.includes(layer ?? "");
    });
    if (match) {
      perFloor.get(match.label)!.push(feature);
    } else {
      unassigned.push(feature);
    }
  }
  return { perFloor, unassigned };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run src/lib/svgPreview.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/svgPreview.ts frontend/src/lib/svgPreview.test.ts
git commit -m "feat: SVG artwork preview painter and floor partition"
```

---

## Task 7: Assignment panel

**Files:**
- Create: `frontend/src/components/illustrator/AssignmentPanel.tsx`
- Modify: `frontend/src/api/client.ts`, `frontend/src/pages/IllustratorPage.tsx`

**Interfaces:**
- Consumes: `buildSvgPaths`, `partitionByFloors`, `PartitionFloor` (Task 6); `previewIllustrator` types, new `assignFloors` client function.
- Produces: `assignFloors(conversionId, floors: {label, box, layer_names}[])` in `api/client.ts`; `AssignmentPanel({ preview, layerSummaries, onAssigned })` where `onAssigned(floors: PartitionFloor[])` hands the result up; `IllustratorPage` gains the assignment phase between convert and place.

- [ ] **Step 1: Add the client function**

In `frontend/src/api/client.ts`, after `previewIllustrator`:

```typescript
export type AssignFloorSummary = {
  label: string;
  feature_count: number;
  artwork_bounds: [number, number, number, number];
  layer_counts: { table: string; ai_layer: string; count: number }[];
};

export type AssignFloorsResponse = {
  floors: AssignFloorSummary[];
  unassigned_count: number;
  total_features: number;
};

export async function assignFloors(
  conversionId: string,
  floors: { label: string; box: [number, number, number, number]; layer_names: string[] | null }[]
): Promise<AssignFloorsResponse> {
  const response = await fetch(`/api/convert/illustrator/${conversionId}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ floors })
  });
  return handleJson<AssignFloorsResponse>(response);
}
```

- [ ] **Step 2: Write the component**

Create `frontend/src/components/illustrator/AssignmentPanel.tsx`:

```tsx
import { useMemo, useRef, useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { buildSvgPaths, partitionByFloors, type PartitionFloor } from "../../lib/svgPreview";
import { Button } from "../ui";

type Props = {
  preview: { type: "FeatureCollection"; features: any[] };
  artworkBounds: [number, number, number, number];
  layerSummaries: { table: string; ai_layer: string; role: string; feature_count: number }[];
  onAssigned: (floors: PartitionFloor[]) => void;
  onSkip: () => void;
};

const BOX_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#d97706", "#0891b2"];

type DraftFloor = {
  label: string;
  box: [number, number, number, number];
  layerNames: string[] | null;
  color: string;
};

export function AssignmentPanel({ preview, artworkBounds, layerSummaries, onAssigned, onSkip }: Props) {
  const { t } = useUiLanguage();
  const [drafts, setDrafts] = useState<DraftFloor[]>([]);
  const [drawing, setDrawing] = useState<{ start: [number, number]; current: [number, number] } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const { viewBox, paths } = useMemo(() => buildSvgPaths(preview, artworkBounds), [preview, artworkBounds]);

  const toArtworkPoint = (event: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const [minx, miny] = [artworkBounds[0], artworkBounds[1]];
    const scaleX = (artworkBounds[2] - artworkBounds[0]) / rect.width;
    const scaleY = (artworkBounds[3] - artworkBounds[1]) / rect.height;
    return [minx + (event.clientX - rect.left) * scaleX, miny + (event.clientY - rect.top) * scaleY];
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    setDrawing({ start: toArtworkPoint(event), current: toArtworkPoint(event) });
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drawing) setDrawing({ ...drawing, current: toArtworkPoint(event) });
  };
  const onPointerUp = () => {
    if (!drawing) return;
    const [x0, y0] = drawing.start;
    const [x1, y1] = drawing.current;
    const box: [number, number, number, number] = [
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1)
    ];
    if (box[2] - box[0] > 2 && box[3] - box[1] > 2) {
      setDrafts((prev) => [
        ...prev,
        { label: `${prev.length + 1}F`, box, layerNames: null, color: BOX_COLORS[prev.length % BOX_COLORS.length] }
      ]);
    }
    setDrawing(null);
  };

  const { perFloor, unassigned } = useMemo(
    () =>
      partitionByFloors(preview, drafts.map((d) => ({ label: d.label, box: d.box, layerNames: d.layerNames }))),
    [preview, drafts]
  );

  const toggleLayer = (index: number, layer: string) => {
    setDrafts((prev) =>
      prev.map((draft, i) => {
        if (i !== index) return draft;
        const current = draft.layerNames ?? [];
        const next = current.includes(layer) ? current.filter((l) => l !== layer) : [...current, layer];
        return { ...draft, layerNames: next.length ? next : null };
      })
    );
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-[var(--color-text-muted)]">
        {t(
          "Draw a box around each floor plan. Boxes touching artwork edges may count differently at export, which uses the full geometry.",
          "各階の平面図を囲むように四角を描いてください。端に触れる四角は、書き出し時（完全な形状で判定）と数が異なる場合があります。"
        )}
      </p>
      <div className="relative overflow-hidden rounded-[var(--radius-md)] border bg-white">
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className="h-64 w-full"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {paths.map((path, index) => (
            <path
              key={index}
              d={path.d}
              fill={path.role === "polygon" ? (path.fill ?? "#cbd5e1") : "none"}
              stroke={path.role === "line" ? (path.stroke ?? "#64748b") : "#64748b"}
              strokeWidth={path.role === "line" ? 0.5 : 0.25}
              fillOpacity={path.role === "polygon" ? 0.6 : 1}
            />
          ))}
          {drafts.map((draft, index) => (
            <g key={index}>
              <rect
                x={draft.box[0]}
                y={draft.box[1]}
                width={draft.box[2] - draft.box[0]}
                height={draft.box[3] - draft.box[1]}
                fill={draft.color}
                fillOpacity={0.15}
                stroke={draft.color}
                strokeWidth={1}
              />
            </g>
          ))}
          {drawing ? (
            <rect
              x={Math.min(drawing.start[0], drawing.current[0])}
              y={Math.min(drawing.start[1], drawing.current[1])}
              width={Math.abs(drawing.current[0] - drawing.start[0])}
              height={Math.abs(drawing.current[1] - drawing.start[1])}
              fill="#2563eb"
              fillOpacity={0.15}
              stroke="#2563eb"
              strokeDasharray="4 2"
            />
          ) : null}
        </svg>
      </div>

      <div className="space-y-2">
        {drafts.map((draft, index) => (
          <div key={index} className="rounded-[var(--radius-md)] border p-2">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: draft.color }} />
              <input
                className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
                value={draft.label}
                onChange={(event) =>
                  setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, label: event.target.value } : d)))
                }
              />
              <span className="text-xs text-[var(--color-text-muted)]">
                {t("features", "図形")}: {perFloor.get(draft.label)?.length ?? 0}
              </span>
              <button
                type="button"
                className="ml-auto text-[var(--color-error)]"
                onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
              >
                {t("Remove", "削除")}
              </button>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs">
                {t("Restrict to layers", "レイヤーを指定")}
              </summary>
              <div className="mt-1 flex flex-wrap gap-1">
                {layerSummaries.map((layer) => {
                  const active = draft.layerNames?.includes(layer.ai_layer) ?? false;
                  return (
                    <button
                      key={layer.ai_layer}
                      type="button"
                      onClick={() => toggleLayer(index, layer.ai_layer)}
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        active ? "bg-blue-100 border-blue-400" : "border-slate-300"
                      }`}
                    >
                      {layer.ai_layer} ({layer.feature_count})
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
        ))}
      </div>

      <p className="text-xs">
        {t(
          `Unassigned: ${unassigned.length} of ${preview.features.length} preview shapes.`,
          `未割当: プレビュー ${preview.features.length} 図形中 ${unassigned.length} 件。`
        )}
      </p>

      <div className="flex gap-2">
        <Button variant="secondary" onClick={onSkip}>
          {t("Skip — one floor for everything", "スキップ — 全図形を1フロアに")}
        </Button>
        <Button
          className="ml-auto"
          disabled={drafts.length === 0}
          onClick={() =>
            onAssigned(drafts.map((d) => ({ label: d.label, box: d.box, layerNames: d.layerNames })))
          }
        >
          {t("Done assigning", "割り当て完了")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire the phase into the page**

In `frontend/src/pages/IllustratorPage.tsx`:

- Add `assignFloors` and the `AssignmentPanel` import.
- Add state: `const [assignment, setAssignment] = useState<{label, box, layer_names}[] | null>(null);`
- After `convert()` succeeds, if `assignment === null` show the `AssignmentPanel` (instead of the map) with `onAssigned={async (floors) => { await assignFloors(preview.conversion_id, floors.map(f => ({label: f.label, box: f.box, layer_names: f.layerNames}))); setAssignment(floors.map(f => ({label: f.label, box: f.box, layer_names: f.layerNames}))); }}` and `onSkip={() => setAssignment([])}`.
- Build the placement state from the assignment: one implicit floor when `assignment.length === 0` (region = artwork bounds), else one floor per assigned region:

```tsx
function initialStateFromAssignment(
  preview: IllustratorPreviewResponse,
  assignment: { label: string; box: [number, number, number, number]; layer_names: string[] | null }[]
): PlacementState {
  const regions = assignment.length ? assignment : [
    { label: "artwork", box: preview.artwork_bounds, layer_names: null }
  ];
  const first = regions[0];
  return {
    frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: preview.suggested_crs },
    activeFloorLabel: first.label,
    scaleLocked: false,
    floors: regions.map((region) => ({
      label: region.label,
      linked: true,
      artworkAnchor: [
        (region.box[0] + region.box[2]) / 2,
        (region.box[1] + region.box[3]) / 2
      ],
      mapAnchor: [139.7671, 35.6812],
      controlPoints: [],
      artworkBounds: region.box
    }))
  };
}
```

Dispatch `applyFloors` with this state after assignment completes (or use `useReducer`'s third argument keyed on the assignment).

- Replace the export payload construction: `body: { floors: toFloorPayloads(state), output_crs: outputCrs, formats }`.

- [ ] **Step 4: Verify**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/components/illustrator/AssignmentPanel.tsx frontend/src/pages/IllustratorPage.tsx
git commit -m "feat: floor assignment panel in the Illustrator flow"
```
## Task 8: Multi-floor map and handles

**Files:**
- Modify: `frontend/src/components/illustrator/PlacementMap.tsx`, `frontend/src/components/illustrator/TransformHandles.tsx`

**Interfaces:**
- Consumes: `PlacementState`, `resolvedTransform`, actions (`positionBuilding`, `dragFloor`, `rotateFrame`, `scaleFrame`, `setActiveFloor`) (Task 5); `transformGeoJson` (existing); per-floor preview features from `partitionByFloors` (Task 6).
- Produces: `PlacementMap` renders one GeoJSON `Source` per floor (tinted per floor), handles for the active floor only, and a floor selector; `TransformHandles` operates on the active floor and dispatches frame actions.

- [ ] **Step 1: Rewrite the map**

`PlacementMap.tsx` — new props:

```tsx
type Props = {
  floors: { label: string; features: any[]; bounds: [number, number, number, number]; color: string }[];
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  pickingControlPoint: boolean;
  onPickMap: (lngLat: [number, number]) => void;
};
```

Key changes:

- Compute per-floor placed GeoJSON: `floors.map((f) => ({ label: f.label, placed: transformGeoJson({ type: "FeatureCollection", features: f.features }, resolvedTransform(state, f)) }))`.
- Render one `<Source id={`floor-${label}`}>` per floor with the same fill/line layers, and a per-floor tint: `"fill-color": ["coalesce", ["get", "fill_color"], FLOOR_TINTS[index]]` where `FLOOR_TINTS = ["#3b82f6", "#16a34a", "#dc2626", "#9333ea", "#d97706", "#0891b2"]`.
- A floor picker (absolute top-left, under the basemap switcher): one button per floor, active highlighted, dispatching `setActiveFloor`.
- The handles source renders only for the active floor, using `resolvedTransform(state, activeFloor)` and the active floor's region `bounds`.
- Control-point source renders the active floor's control points.
- `onPickMap` for control-point picking is unchanged; the control point's `artwork` coordinate uses the active floor's `artworkAnchor`.

- [ ] **Step 2: Rewrite the handles**

`TransformHandles.tsx` — props become:

```tsx
type Props = {
  transform: SimilarityTransform;
  dispatch: (action: PlacementAction) => void;
  map: MapRef | null;
  artworkBounds: [number, number, number, number];
  floorLabel: string;
  linked: boolean;
};
```

Behaviour changes:

- All matrix maths unchanged (ENU frame, `toEnuMatrix(transform)`), but `transform` and `artworkBounds` are now the **active floor's resolved** values, passed in as props instead of derived from `state`.
- `anchor` drag: `dispatch({ type: "dragFloor", label: floorLabel, mapAnchor: [lng, lat] })`.
- `rotate` drag: `dispatch({ type: "rotateFrame", rotationDeg: snapped })` — only when `linked` is true; when false, the handle renders but is inert with a tooltip `t("Relink this floor to rotate with the building", "この階を再リンクすると建物ごと回転できます")`.
- `scale` drag: `dispatch({ type: "scaleFrame", metresPerPoint })` — same `linked` and `scaleLocked` gating (the lock lives on the frame; pass `scaleLocked` as a prop too).

The effect's dependency array becomes `[map, transform, dispatch, artworkBounds, floorLabel, linked, scaleLocked]`.

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass (the reducer tests already cover the frame semantics the handles now dispatch).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/illustrator/PlacementMap.tsx frontend/src/components/illustrator/TransformHandles.tsx
git commit -m "feat: per-floor map rendering with active-floor handles"
```

---

## Task 9: Panels, placement library and page wiring

**Files:**
- Modify: `frontend/src/components/illustrator/TransformPanel.tsx`, `ControlPointList.tsx`, `PlacementLibrary.tsx`, `frontend/src/pages/IllustratorPage.tsx`

**Interfaces:**
- Consumes: `PlacementState` with floors, `resolvedTransform`, `toFloorPayloads`, `floorPayloadsToState`, actions (Task 5); placement client API (Task 11 of the base plan, floors payload per Task 4 backend).
- Produces: the full three-phase Illustrator page.

- [ ] **Step 1: Transform panel — frame controls + floor selector**

`TransformPanel.tsx` changes:

- Add a floor selector at the top:

```tsx
<select
  className={FIELD}
  value={state.activeFloorLabel ?? ""}
  onChange={(event) => dispatch({ type: "setActiveFloor", label: event.target.value })}
>
  {state.floors.map((floor) => (
    <option key={floor.label} value={floor.label}>
      {floor.label}
      {floor.linked ? "" : t(" (unlinked)", "（非連動）")}
    </option>
  ))}
</select>
```

- The rotation field reads `state.frame.rotationDeg`, dispatches `rotateFrame`; the reset button dispatches `rotateFrame` with 0.
- The scale readout shows `state.frame.metresPerPoint`; the `1:N` apply dispatches `setDrawingScale`; calibration dispatches `calibrateDistance`; the unlock button dispatches `unlockScale`.
- When the active floor is unlinked, show a hint and a relink button:

```tsx
{activeFloor && !activeFloor.linked ? (
  <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "relinkFloor", label: activeFloor.label })}>
    {t("Relink to shared frame", "共通フレームに再リンク")}
  </Button>
) : null}
```

- [ ] **Step 2: Control-point list — active floor**

`ControlPointList.tsx`: reads `activeFloor` from state (`state.floors.find((f) => f.label === state.activeFloorLabel)`), operates on its `controlPoints`; `currentResiduals(state)` already targets the active floor. No other changes.

- [ ] **Step 3: Placement library — floor sets**

`PlacementLibrary.tsx`:

- Save: `createPlacement({ name, floors: toFloorPayloads(state), artwork_bounds: artworkBounds })`.
- Apply: `dispatch({ type: "applyFloors", floors: placement.floors })`, then compute warnings by comparing labels:

```tsx
const apply = (placement: PlacementItem) => {
  dispatch({ type: "applyFloors", floors: placement.floors });
  const saved = new Set(placement.floors.map((f) => f.label));
  const current = new Set(state.floors.map((f) => f.label));
  const missing = [...saved].filter((label) => !current.has(label));
  const extra = [...current].filter((label) => !saved.has(label));
  setWarning(
    missing.length || extra.length
      ? t(
          `Saved floors differ from this file's: ${[...missing, ...extra].join(", ")}. Check the alignment.`,
          "保存時のフロアとこのファイルのフロアが異なります。位置合わせを確認してください。"
        )
      : null
  );
};
```

- The artboard-mismatch warning from the base feature is retained.

- [ ] **Step 4: Page — export payload and phases**

`IllustratorPage.tsx`:

- Export: `body: { floors: toFloorPayloads(state), output_crs: outputCrs, formats }`.
- Convert/assign/place phases: after `convert()` the page shows the `AssignmentPanel` until `assignment !== null`; then the placement map and panels render. `initialStateFromAssignment` (Task 7) seeds the reducer.
- The `onPickMap` control-point handler uses the active floor's `artworkAnchor`.
- The "Preview shows X of Y" line stays; add the floor count when `assignment.length > 1`.

- [ ] **Step 5: Verify**

Run: `cd frontend && npx tsc -b && npx vitest run && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/illustrator/ frontend/src/pages/IllustratorPage.tsx
git commit -m "feat: wire floors through panels, placement library and export"
```

---

## Task 10: Smoke test and documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: no code.

- [ ] **Step 1: Run the whole test suite**

Run: `pytest backend/tests -v`
Then: `cd frontend && npm run test && npm run build`
Expected: all green.

- [ ] **Step 2: API-level smoke test**

Write a throwaway script (do not commit) that:

1. Builds a two-region fixture by converting the minimal AI PDF, then calling `POST /assign` with two disjoint boxes.
2. Calls export with two floor transforms (one at the default anchor, one ~90 m east).
3. Asserts the zip contains two per-floor tables and `export_report.json` counts match.
4. Also runs the no-assignment export and asserts the table names have no floor prefix.

- [ ] **Step 3: Update the README**

Replace the Illustrator bullet (already updated for the base feature) with:

```markdown
- Standalone Adobe Illustrator (`.ai`) → georeferenced GeoPackage, shapefiles and QGIS
  project: draw boxes around each floor plan on the artwork preview (optionally restricted
  to specific layers), place the floors on OSM or GSI aerial imagery with a shared
  scale/rotation frame, drag each floor into place, then export in a chosen CRS. Placements
  (including multi-floor sets) can be saved by name and reapplied to other files of the same
  building.
```

- [ ] **Step 4: Update CLAUDE.md**

In Notes, extend the georeferencing note:

```markdown
- Illustrator multi-floor placement: assignment is by box on the artwork preview, membership
  is `centroid ∈ box` plus an optional layer restriction, re-verified server-side at export
  (the preview filter is display-only). Linked floors share scale/rotation; dragging a floor
  unlinks it (drag = pin); frame operations touch linked floors only. With one floor the
  floor stays linked, preserving the single-floor behaviour exactly.
```

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document Illustrator multi-floor placement"
```

---

## Self-Review

**Spec coverage.** Region assignment → Tasks 1, 3, 6, 7. Membership rule → Tasks 2, 6. Export
materialization + report → Task 2. Shared-frame semantics → Tasks 5, 8, 9. Placements as floor
sets → Task 4. Backward compat (no boxes = one floor) → Tasks 2 (summary tests), 3 (API test),
5 (single-floor reducer tests), 7 (implicit floor). Errors (FLOOR_MISMATCH, duplicates, unknown
layers) → Tasks 2, 3. Smoke + docs → Task 10.

**Placeholder scan.** No `TBD`; every step carries real code. The one intentionally soft spot is
the `.qgs` floor grouping in Task 2 ("if this proves fiddly…") — resolved by the same
`<layer-tree-group>` pattern the module already uses for the top level; the plan should be read
as: reuse that pattern, one group per floor.

**Type consistency.** `ExportFloor` is the single backend transport (label/transform/region/
layer_names). `FloorExportPayload` (label + TransformPayload) is the wire shape. The reducer's
`floorPayloadsToState` maps wire → state; `toFloorPayloads` maps state → wire. `PartitionFloor`
(label/box/layerNames) mirrors `FloorRegionPayload` (label/box/layer_names) — the snake_case
boundary is at `api/client.ts`, matching the existing convention.

**Retained guarantees.** `SimilarityTransform.to_affine_matrix` is untouched (true-north +
convergence). The golden fixture is untouched. The legacy ungeoreferenced
`POST /api/convert/illustrator` endpoint is untouched.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-illustrator-multifloor.md`.
Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
