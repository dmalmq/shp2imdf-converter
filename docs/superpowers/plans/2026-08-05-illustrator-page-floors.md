# Illustrator Page-to-Floor Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user assign each page of a multi-page `.ai`/InDesign document to a floor, instead of every page rendering stacked on top of every other page.

**Architecture:** Page becomes a third membership dimension beside the existing `centroid ∈ box` and layer restriction. The importer tags every painted path with its 1-based PDF page; that page rides along as one extra GeoPackage column. A floor record generalises from `{label, box, layer_names}` to `{label, pages?, box?, layer_names?}` where every filter is independently optional and `null` means "no restriction on this dimension". The assign screen gains a page grid whose cards drill into the existing box-drawing panel for a page holding several plans. The placement step does not change — it is label-keyed and page-agnostic.

**Tech Stack:** As the existing feature: FastAPI, pdfminer.six, geopandas/shapely/pandas, React 18 + TS, vitest + @testing-library/react, pytest.

**Spec:** `docs/superpowers/specs/2026-08-05-illustrator-page-floors-design.md`

## Global Constraints

- Membership rule: a feature belongs to floor F iff `page ∈ F.pages` (or `F.pages is None`) **and** `ai_layer ∈ F.layer_names` (or `F.layer_names is None`) **and** `centroid ∈ F.box` (or `F.box is None`). **First matching floor in request order wins** — no feature is emitted twice.
- Box bounds are **inclusive** (`minx <= cx <= maxx`) and an empty geometry never matches. Both semantics exist today in `_centroid_inside` and are pinned by existing tests; the vectorized replacement must preserve them exactly.
- `pages` is **1-based**. Page 1 is the first page of the document.
- A conversion cached before this change has no `page` column; `_read_layers` backfills `page = 1`. A `floors.json` written before this change has no `pages` key, which loads as `None`.
- The single-page flow must be untouched end to end: `preview.pages.length === 1` renders the existing `AssignmentPanel` directly, a box-only assignment exports identically, and every existing test passes unchanged.
- Unassigned features (matching no floor) are excluded from export and counted in `export_report.json` — unchanged. An excluded page is simply a page no floor claims.
- Table names at export stay `{sanitized_floor_label}_{sanitized_layer_table}`; every emitted feature keeps its `floor` attribute. Export granularity does **not** become per-page.
- No geometry is ever auto-translated to align pages. Unequal sheet sizes are warned about, not corrected.
- Frontend tests: `globals: true` (no importing `test`/`expect`), jsdom, `@testing-library/react`. All user-facing strings bilingual via `useUiLanguage().t(en, ja)`.
- Backend tests carry `@pytest.mark.georef`.

---

## File Structure

**Backend — modify**

| File | Responsibility after the change |
|---|---|
| `backend/src/illustrator_importer.py` | Tags each `_PathRecord` with its page; writes `page` as a GeoPackage column; records per-page sheet sizes on `ConversionReport` |
| `backend/src/illustrator_export.py` | `_read_layers` backfills a missing `page`; `build_preview` returns a `pages[]` array; `ExportFloor` carries optional `region` + `pages`; `_floor_mask` replaces the row-wise `_matches_floor` |
| `backend/src/schemas.py` | `IllustratorPagePreview`; `IllustratorPreviewResponse.pages`; `FloorRegionPayload.box` optional + `pages` |
| `backend/routers/import_router.py` | Preview returns `pages`; assign validates page indices and stores `pages`; export forwards `pages` |

`backend/src/illustrator_store.py` needs **no change** — `floors.json` is opaque JSON written from `model_dump()`, so `pages` round-trips for free. `backend/src/placements.py` needs no change — placements store transforms only, never boxes or pages.

**Frontend — modify / create**

| File | Responsibility after the change |
|---|---|
| `frontend/src/lib/svgPreview.ts` | `splitByPage`; `PartitionFloor` gains `pages` and a nullable `box`; `partitionByFloors` mirrors the server's three-predicate chain |
| `frontend/src/components/illustrator/PageAssignmentPanel.tsx` (new) | The page grid: thumbnails, floor names, merge, exclude, size warning, drill-in host |
| `frontend/src/components/illustrator/AssignmentPanel.tsx` | Unchanged behaviour; gains an optional `page` prop that tags its boxes, and an optional `onCancel` for the drill-in back button |
| `frontend/src/pages/IllustratorPage.tsx` | Picks grid vs. panel; `AssignedRegion` gains `pages` and a nullable `box`; floor bounds come from the assign response |
| `frontend/src/api/client.ts` | `IllustratorPagePreview`; `pages` on the preview and report types; `assignFloors` payload |

---

## Task 1: Tag every path with its PDF page

**Files:**
- Modify: `backend/src/illustrator_importer.py:56-96` (`ConversionReport`, `_PathRecord`), `:280-331` (`_RecorderDevice`), `:387-407` (`_records_to_rows`), `:497-525` (`_convert`)
- Test: `backend/tests/test_illustrator_import.py`

**Interfaces:**
- Consumes: `_RecorderDevice`, `_LayerInterpreter`, `ConversionReport`, `parse_ai` as built.
- Produces: `_PathRecord.page: int` (1-based); a `page` integer column on every written GeoPackage table; `ConversionReport.pages: list[dict]` where each entry is `{"index": int, "width_pt": float, "height_pt": float}`, also present in `ConversionReport.to_dict()` under `"pages"`; a test helper `_build_multipage_ai_pdf() -> bytes` importable by other test modules the way `_build_minimal_ai_pdf` already is.

- [ ] **Step 1: Write the failing tests**

Add the three-page fixture builder to `backend/tests/test_illustrator_import.py`, after `_build_minimal_ai_pdf` (which ends at line 65). The page shapes are chosen so one fixture covers both the co-registered and the unequal-sheet paths, and so all three pages normalize to identical coordinates — which makes it a real test of page tagging, since geometry alone cannot separate them:

```python
def _build_multipage_ai_pdf() -> bytes:
    """A three-page PDF-based Illustrator file, one red rectangle per page.

    All three rectangles normalize to the same artwork coordinates, so only the
    `page` column distinguishes them:

    | Page | MediaBox            | Rect at    | Normalizes to |
    |------|---------------------|------------|---------------|
    | 1    | [0 0 200 200]       | (50, 50)   | (50, 50)      |
    | 2    | [100 100 300 300]   | (150, 150) | (50, 50)      |
    | 3    | [0 0 400 400]       | (50, 50)   | (50, 50)      |

    Page 2 proves an offset MediaBox is normalized away (equal-size pages stay
    co-registered); page 3 is a larger sheet, for the unequal-size warning.
    """
    def content(x: int, y: int) -> bytes:
        return (
            b"/OC /MC0 BDC\n"
            b"0 1 1 0 k\n"                      # CMYK red -> #FF0000
            + f"{x} {y} 100 60 re\n".encode()   # 100x60 rectangle
            + b"f\n"
            b"EMC\n"
        )

    pages = [
        (b"[0 0 200 200]", content(50, 50)),
        (b"[100 100 300 300]", content(150, 150)),
        (b"[0 0 400 400]", content(50, 50)),
    ]

    objects: list[bytes | None] = [
        b"<< /Type /Catalog /Pages 2 0 R "
        b"/OCProperties << /OCGs [3 0 R] /D << /Order [3 0 R] >> >> >>",
        None,  # /Pages, filled in once the page object ids are known
        b"<< /Type /OCG /Name (Fill Layer) >>",
    ]
    page_ids: list[int] = []
    for mediabox, stream in pages:
        page_id = len(objects) + 1
        stream_id = len(objects) + 2
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox " + mediabox
            + b" /Resources << /Properties << /MC0 3 0 R >> >> /Contents "
            + str(stream_id).encode() + b" 0 R >>"
        )
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream"
        )
        page_ids.append(page_id)
    kids = b" ".join(f"{i} 0 R".encode() for i in page_ids)
    objects[1] = (
        b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(len(pages)).encode() + b" >>"
    )

    out = bytearray(b"%PDF-1.6\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        assert body is not None
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return bytes(out)
```

Then append the tests:

```python
@pytest.mark.georef
def test_multipage_report_records_each_page_size() -> None:
    _gpkg, _name, report = convert_ai_to_geopackage(_build_multipage_ai_pdf(), "three.ai")
    assert report.page_count == 3
    assert report.pages == [
        {"index": 1, "width_pt": 200.0, "height_pt": 200.0},
        {"index": 2, "width_pt": 200.0, "height_pt": 200.0},
        {"index": 3, "width_pt": 400.0, "height_pt": 400.0},
    ]
    assert report.to_dict()["pages"] == report.pages


@pytest.mark.georef
def test_multipage_rows_carry_their_page_number() -> None:
    gpkg, _name, report = convert_ai_to_geopackage(_build_multipage_ai_pdf(), "three.ai")
    assert report.total_features == 3
    gdf = _read_layer(gpkg, "Fill Layer")
    assert sorted(int(p) for p in gdf["page"]) == [1, 2, 3]


@pytest.mark.georef
def test_multipage_geometry_stacks_so_only_page_separates_it() -> None:
    """Every page normalizes to its own MediaBox origin, so all three coincide."""
    gpkg, _name, _report = convert_ai_to_geopackage(_build_multipage_ai_pdf(), "three.ai")
    gdf = _read_layer(gpkg, "Fill Layer")
    assert {tuple(round(v, 3) for v in geom.bounds) for geom in gdf.geometry} == {
        (50.0, 50.0, 150.0, 110.0)
    }


@pytest.mark.georef
def test_single_page_file_still_reports_one_page() -> None:
    _gpkg, _name, report = convert_ai_to_geopackage(_build_minimal_ai_pdf(), "sample.ai")
    assert report.page_count == 1
    assert report.pages == [{"index": 1, "width_pt": 200.0, "height_pt": 200.0}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_import.py -v`
Expected: FAIL — `AttributeError: 'ConversionReport' object has no attribute 'pages'`, and a `KeyError: 'page'` from the row test.

- [ ] **Step 3: Add the page field to the report and the record**

In `backend/src/illustrator_importer.py`, replace `ConversionReport` (lines 56-80) and `_PathRecord` (lines 83-93):

```python
@dataclass(slots=True)
class ConversionReport:
    """Summary of a conversion, suitable for JSON serialization."""

    source_name: str
    page_count: int = 0
    # One entry per page: {"index": 1-based, "width_pt": ..., "height_pt": ...}.
    # Sizes are the visual extent, so a /Rotate 90 page reports them swapped.
    pages: list[dict[str, float]] = field(default_factory=list)
    layers: dict[str, dict[str, int]] = field(default_factory=dict)
    total_features: int = 0
    warnings: list[str] = field(default_factory=list)
    layer_order: list[str] = field(default_factory=list)

    def record(self, layer: str, role: str) -> None:
        counts = self.layers.setdefault(layer, {"polygon": 0, "line": 0})
        counts[role] += 1
        self.total_features += 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_name": self.source_name,
            "page_count": self.page_count,
            "pages": self.pages,
            "total_features": self.total_features,
            "layers": self.layers,
            "layer_order": self.layer_order,
            "warnings": self.warnings,
        }


@dataclass(slots=True)
class _PathRecord:
    """A single painted path, resolved to its page, layer, role and color."""

    page: int  # 1-based PDF page the path was painted on
    layer: str
    role: str  # "polygon" or "line"
    subpaths: list[list[tuple[float, float]]]
    fill_color: str | None
    stroke_color: str | None
    line_width: float
    dashed: bool
```

- [ ] **Step 4: Count pages in the recorder and tag painted paths**

In the same file, add a page counter to `_RecorderDevice.__init__` (line 280-284) and a `begin_page` override. Replace lines 280-301:

```python
    def __init__(self, rsrcmgr: PDFResourceManager) -> None:
        super().__init__(rsrcmgr)
        self.records: list[_PathRecord] = []
        self.ctm: tuple = (1, 0, 0, 1, 0, 0)
        self.page_no = 0
        self._mc_stack: list[str | None] = []

    def begin_page(self, page: Any, ctm: tuple) -> None:
        # pdfminer calls this once per page, in order, before that page's
        # content stream — so a simple counter is the page number. Reset the
        # marked-content stack too: a page with unbalanced BDC/EMC must not
        # leak its active layer into the next page.
        super().begin_page(page, ctm)
        self.page_no += 1
        self._mc_stack.clear()

    def set_ctm(self, ctm: tuple) -> None:
        self.ctm = ctm

    # The interpreter subclass passes an already-resolved layer name (or None).
    def begin_tag(self, tag: Any, props: Any = None) -> None:
        self._mc_stack.append(props if isinstance(props, str) else None)

    def end_tag(self) -> None:
        if self._mc_stack:
            self._mc_stack.pop()

    def _current_layer(self) -> str:
        for layer in reversed(self._mc_stack):
            if layer:
                return layer
        return NO_LAYER
```

Then add `page=self.page_no,` as the first argument of **both** `_PathRecord(...)` constructions in `paint_path` (lines 309-319 and 321-330), so they read:

```python
        if fill:
            self.records.append(
                _PathRecord(
                    page=self.page_no,
                    layer=layer,
                    role="polygon",
                    subpaths=subpaths,
                    fill_color=_color_to_hex(gs.ncolor),
                    stroke_color=_color_to_hex(gs.scolor) if stroke else None,
                    line_width=float(gs.linewidth or 0.0),
                    dashed=_is_dashed(gs.dash),
                )
            )
        elif stroke:
            self.records.append(
                _PathRecord(
                    page=self.page_no,
                    layer=layer,
                    role="line",
                    subpaths=subpaths,
                    fill_color=None,
                    stroke_color=_color_to_hex(gs.scolor),
                    line_width=float(gs.linewidth or 0.0),
                    dashed=_is_dashed(gs.dash),
                )
            )
```

- [ ] **Step 5: Write the page column and collect page sizes**

In `_records_to_rows` (line 395-404), add `page` to the row dict:

```python
        rows.append(
            {
                "page": rec.page,
                "ai_layer": rec.layer,
                "role": rec.role,
                "fill_color": rec.fill_color,
                "stroke_color": rec.stroke_color,
                "line_width": round(rec.line_width, 4),
                "dashed": rec.dashed,
            }
        )
```

In `_convert`, replace the page loop (lines 513-515):

```python
        for page in PDFPage.create_pages(document):
            report.page_count += 1
            x0, y0, x1, y1 = page.mediabox
            width, height = abs(x1 - x0), abs(y1 - y0)
            if page.rotate in (90, 270):
                # pdfminer folds /Rotate into the base CTM, so the visual
                # extent is the MediaBox with its axes swapped.
                width, height = height, width
            report.pages.append(
                {
                    "index": report.page_count,
                    "width_pt": round(width, 4),
                    "height_pt": round(height, 4),
                }
            )
            interpreter.process_page(page)
```

- [ ] **Step 6: Run the importer tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_import.py -v`
Expected: PASS — the four new tests plus every pre-existing test in the file.

- [ ] **Step 7: Commit**

```bash
git add backend/src/illustrator_importer.py backend/tests/test_illustrator_import.py
git commit -m "feat: tag illustrator paths with their PDF page"
```

---

## Task 2: Per-page preview payload

**Files:**
- Modify: `backend/src/illustrator_export.py:82-86` (`_read_layers`), `:96-147` (`build_preview`)
- Test: `backend/tests/test_illustrator_export.py`

**Interfaces:**
- Consumes: `ConversionReport.pages` and the `page` column from Task 1; `CachedConversion`.
- Produces: `build_preview(cached)` return dict gains `"pages": list[dict]`, each `{"index": int, "bounds": [minx, miny, maxx, maxy], "width_pt": float, "height_pt": float, "feature_count": int, "preview_feature_count": int}`, ordered by `index` and containing **one entry per document page** including pages with no geometry. `_read_layers` guarantees every returned GeoDataFrame has a `page` column.

- [ ] **Step 1: Write the failing tests**

Add a multi-page fixture and tests to `backend/tests/test_illustrator_export.py`. The import at line 25 becomes:

```python
from backend.tests.test_illustrator_import import (
    _build_minimal_ai_pdf,
    _build_multipage_ai_pdf,
)
```

Add the fixture next to `cached` (line 32-35):

```python
@pytest.fixture()
def multipage_cached(tmp_path: Path):
    store = ConversionStore(root=tmp_path / "mp", ttl_seconds=3600, max_entries=5)
    return store.put(parse_ai(_build_multipage_ai_pdf(), "three.ai"))
```

Then append the tests:

```python
@pytest.mark.georef
def test_preview_lists_every_page_with_its_sheet_size(multipage_cached) -> None:
    pages = build_preview(multipage_cached)["pages"]
    assert [p["index"] for p in pages] == [1, 2, 3]
    assert [(p["width_pt"], p["height_pt"]) for p in pages] == [
        (200.0, 200.0),
        (200.0, 200.0),
        (400.0, 400.0),
    ]


@pytest.mark.georef
def test_preview_reports_per_page_bounds_and_counts(multipage_cached) -> None:
    pages = build_preview(multipage_cached)["pages"]
    for page in pages:
        assert page["feature_count"] == 1
        # All three rectangles normalize to the same artwork coordinates.
        assert [round(v, 3) for v in page["bounds"]] == [50.0, 50.0, 150.0, 110.0]


@pytest.mark.georef
def test_preview_features_carry_their_page(multipage_cached) -> None:
    preview = build_preview(multipage_cached)["preview"]
    assert sorted(f["properties"]["page"] for f in preview["features"]) == [1, 2, 3]


@pytest.mark.georef
def test_preview_of_a_single_page_file_lists_one_page(cached) -> None:
    preview = build_preview(cached)
    assert [p["index"] for p in preview["pages"]] == [1]
    assert preview["pages"][0]["feature_count"] == preview["total_features"]
    # The existing top-level fields are unchanged.
    assert preview["artwork_bounds"] == build_preview(cached)["artwork_bounds"]


@pytest.mark.georef
def test_read_layers_backfills_page_for_older_caches(cached) -> None:
    """A conversion cached before per-page tagging is treated as single-page.

    Simulates the old cache by dropping the column from the GeoPackage on disk,
    which is what an entry written by the previous version actually looks like.
    """
    from backend.src.illustrator_export import _read_layers

    with sqlite3.connect(cached.gpkg_path) as conn:
        for spec in cached.written_layers:
            conn.execute(f'ALTER TABLE "{spec["table"]}" DROP COLUMN page')

    for _spec, gdf in _read_layers(cached):
        assert "page" in gdf.columns
        assert set(gdf["page"]) == {1}


@pytest.mark.georef
def test_preview_of_a_cache_without_page_metadata_lists_one_page(cached) -> None:
    """An old cache has no report['pages'] either; the grid still gets a page."""
    cached.report.pop("pages", None)
    pages = build_preview(cached)["pages"]
    assert [p["index"] for p in pages] == [1]
    assert pages[0]["bounds"] == build_preview(cached)["artwork_bounds"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_export.py -v -k "page"`
Expected: FAIL — `KeyError: 'pages'` from `build_preview` on the four preview tests, and `assert "page" in gdf.columns` on the backfill test.

- [ ] **Step 3: Backfill the page column when reading layers**

In `backend/src/illustrator_export.py`, replace `_read_layers` (lines 82-86):

```python
def _read_layers(cached: CachedConversion) -> list[tuple[dict[str, str], gpd.GeoDataFrame]]:
    layers: list[tuple[dict[str, str], gpd.GeoDataFrame]] = []
    for spec in cached.written_layers:
        gdf = gpd.read_file(cached.gpkg_path, layer=spec["table"])
        if "page" not in gdf.columns:
            # Conversions cached before per-page tagging were single-page.
            gdf["page"] = 1
        layers.append((spec, gdf))
    return layers
```

- [ ] **Step 4: Return the pages array from build_preview**

Add the import at the top of the file, after line 9 (`from __future__ import annotations`) and among the stdlib imports:

```python
from collections import Counter
```

Replace `build_preview` (lines 96-147):

```python
def build_preview(
    cached: CachedConversion, tolerance_divisor: float = _PREVIEW_TOLERANCE_DIVISOR
) -> dict:
    """Artwork-space GeoJSON for on-map preview, decimated for interactivity."""
    layers = _read_layers(cached)

    bounds = None
    for _spec, gdf in layers:
        if gdf.empty:
            continue
        minx, miny, maxx, maxy = gdf.total_bounds
        bounds = (
            (minx, miny, maxx, maxy)
            if bounds is None
            else (
                min(bounds[0], minx),
                min(bounds[1], miny),
                max(bounds[2], maxx),
                max(bounds[3], maxy),
            )
        )
    if bounds is None:
        bounds = (0.0, 0.0, 1.0, 1.0)

    diagonal = ((bounds[2] - bounds[0]) ** 2 + (bounds[3] - bounds[1]) ** 2) ** 0.5
    tolerance = diagonal / tolerance_divisor if diagonal > 0 else 0.0

    features: list[dict] = []
    total = 0
    summaries: list[dict] = []
    # Per-page rollups. Pages are normalized to their own MediaBox origin, so
    # the union bounds are roughly the largest page and one global decimation
    # tolerance is already page-scale.
    page_bounds: dict[int, tuple[float, float, float, float]] = {}
    page_totals: Counter = Counter()
    page_preview: Counter = Counter()
    for spec, gdf in layers:
        total += len(gdf)
        summaries.append({**spec, "feature_count": int(len(gdf))})
        if gdf.empty:
            continue
        for page, chunk in gdf.groupby("page", sort=True):
            page = int(page)
            page_totals[page] += len(chunk)
            page_bounds[page] = _extend_bounds(page_bounds.get(page), chunk.total_bounds)
        simplified = gdf.copy()
        if tolerance > 0:
            simplified["geometry"] = simplified.geometry.simplify(
                tolerance, preserve_topology=True
            )
            simplified = simplified[simplified.geometry.apply(_diagonal_of) >= tolerance]
        if simplified.empty:
            continue
        for page, chunk in simplified.groupby("page", sort=True):
            page_preview[int(page)] += len(chunk)
        features.extend(json.loads(simplified.to_json(na="null"))["features"])

    return {
        "artwork_bounds": [float(value) for value in bounds],
        "pages": _page_previews(cached, bounds, page_bounds, page_totals, page_preview),
        "preview": {"type": "FeatureCollection", "features": features},
        "preview_features": len(features),
        "total_features": int(total),
        "layers": summaries,
    }
```

Add the two helpers directly above `build_preview` (after `_diagonal_of`, which ends at line 93):

```python
def _extend_bounds(
    current: tuple[float, float, float, float] | None, incoming
) -> tuple[float, float, float, float]:
    minx, miny, maxx, maxy = (float(v) for v in incoming)
    if current is None:
        return (minx, miny, maxx, maxy)
    return (
        min(current[0], minx),
        min(current[1], miny),
        max(current[2], maxx),
        max(current[3], maxy),
    )


def _page_previews(
    cached: CachedConversion,
    artwork_bounds: tuple[float, float, float, float],
    page_bounds: dict[int, tuple[float, float, float, float]],
    page_totals: Counter,
    page_preview: Counter,
) -> list[dict]:
    """One entry per document page, including pages holding no geometry.

    The report's page list is the authority for which pages exist, so a cover
    sheet or a text-only page still gets a card in the assignment grid.
    """
    metas = cached.report.get("pages") or [
        # Cached before per-page tagging: one page spanning the whole artwork.
        {
            "index": 1,
            "width_pt": float(artwork_bounds[2]),
            "height_pt": float(artwork_bounds[3]),
        }
    ]
    previews: list[dict] = []
    for meta in metas:
        index = int(meta["index"])
        width = float(meta["width_pt"])
        height = float(meta["height_pt"])
        found = page_bounds.get(index)
        previews.append(
            {
                "index": index,
                # An empty page has no geometry bounds; fall back to the sheet
                # so the grid thumbnail still has a usable viewBox.
                "bounds": [float(v) for v in (found or (0.0, 0.0, width, height))],
                "width_pt": width,
                "height_pt": height,
                "feature_count": int(page_totals.get(index, 0)),
                "preview_feature_count": int(page_preview.get(index, 0)),
            }
        )
    return previews
```

- [ ] **Step 5: Run the export tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_export.py -v`
Expected: PASS — the five new tests plus every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add backend/src/illustrator_export.py backend/tests/test_illustrator_export.py
git commit -m "feat: return per-page metadata from the illustrator preview"
```

---

## Task 3: Page-aware membership

**Files:**
- Modify: `backend/src/illustrator_export.py:31-38` (`ExportFloor`), `:48-59` (membership), `:186-191` and `:275-280` (both mask call sites)
- Test: `backend/tests/test_illustrator_export.py`

**Interfaces:**
- Consumes: the `page` column guaranteed by Task 2's `_read_layers`.
- Produces: `ExportFloor(label: str, transform: SimilarityTransform, region: list[float] | None = None, layer_names: list[str] | None = None, pages: list[int] | None = None)` — field order preserved so existing positional constructions keep working; `_floor_mask(frame: gpd.GeoDataFrame, floor: ExportFloor) -> pd.Series` returning a boolean mask aligned to `frame.index`. `_centroid_inside` and `_matches_floor` are **removed**.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_illustrator_export.py`:

```python
@pytest.mark.georef
def test_page_only_floor_takes_that_whole_page(multipage_cached) -> None:
    floors, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), pages=[1])],
    )
    assert floors[0]["feature_count"] == 1
    assert unassigned == 2


@pytest.mark.georef
def test_two_pages_merge_under_one_label(multipage_cached) -> None:
    floors, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), pages=[1, 3])],
    )
    assert len(floors) == 1
    assert floors[0]["feature_count"] == 2
    assert unassigned == 1


@pytest.mark.georef
def test_excluded_page_is_counted_as_unassigned(multipage_cached) -> None:
    floors, unassigned = compute_assignment_summary(
        multipage_cached,
        [
            ExportFloor("1F", _transform_at(), pages=[1]),
            ExportFloor("2F", _transform_at(), pages=[2]),
        ],
    )
    assert {f["label"] for f in floors} == {"1F", "2F"}
    assert unassigned == 1  # page 3 claimed by nobody


@pytest.mark.georef
def test_page_and_box_combine(multipage_cached) -> None:
    """The drill-in case: a box scoped to one page."""
    inside, _ = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), region=[0, 0, 200, 200], pages=[1])],
    )
    assert inside[0]["feature_count"] == 1

    outside, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), region=[300, 300, 400, 400], pages=[1])],
    )
    assert outside == []
    assert unassigned == 3


@pytest.mark.georef
def test_page_and_layer_restriction_combine(multipage_cached) -> None:
    matched, _ = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), layer_names=["Fill Layer"], pages=[2])],
    )
    assert matched[0]["feature_count"] == 1

    missed, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), layer_names=["no such layer"], pages=[2])],
    )
    assert missed == []
    assert unassigned == 3


@pytest.mark.georef
def test_all_null_floor_claims_everything(multipage_cached) -> None:
    """The implicit whole-artwork floor: no page, box or layer restriction."""
    floors, unassigned = compute_assignment_summary(
        multipage_cached, [ExportFloor("artwork", _transform_at())]
    )
    assert floors[0]["feature_count"] == 3
    assert unassigned == 0


@pytest.mark.georef
def test_export_applies_each_page_floors_own_transform(
    multipage_cached, tmp_path: Path
) -> None:
    payload, _ = build_georeferenced_bundle(
        multipage_cached,
        [
            ExportFloor("1F", _transform_at(anchor=(ANCHOR_LON, ANCHOR_LAT)), pages=[1]),
            ExportFloor("2F", _transform_at(anchor=(ANCHOR_LON + 0.01, ANCHOR_LAT)), pages=[2]),
        ],
        "EPSG:4326",
        ExportFormats(shapefile=False, qgis=False),
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "pages.gpkg")
    first = gpd.read_file(gpkg, layer="1F_Fill Layer")
    second = gpd.read_file(gpkg, layer="2F_Fill Layer")
    assert (first["floor"] == "1F").all()
    assert (second["floor"] == "2F").all()
    # Same artwork coordinates, different map anchors -> different longitudes.
    assert second.geometry.iloc[0].centroid.x > first.geometry.iloc[0].centroid.x
```

Every test in this module carries the existing `georef` marker; no new pytest marker is introduced.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_export.py -v -k "page or null_floor"`
Expected: FAIL — `TypeError: ExportFloor.__init__() got an unexpected keyword argument 'pages'`.

- [ ] **Step 3: Make region optional and add pages**

In `backend/src/illustrator_export.py`, add the pandas import beside geopandas (line 17):

```python
import geopandas as gpd
import pandas as pd
```

Replace `ExportFloor` (lines 31-38):

```python
@dataclass(slots=True)
class ExportFloor:
    """One floor of an export: optional filters in artwork space plus a placement.

    Every filter is independent and ``None`` means "no restriction on this
    dimension", so an all-``None`` floor claims the whole artwork.
    """

    label: str
    transform: SimilarityTransform
    region: list[float] | None = None
    layer_names: list[str] | None = None
    pages: list[int] | None = None
```

- [ ] **Step 4: Replace the row-wise membership test with a vectorized mask**

Replace `_centroid_inside` and `_matches_floor` (lines 48-59) with a single function:

```python
def _floor_mask(frame: gpd.GeoDataFrame, floor: ExportFloor) -> pd.Series:
    """Membership mask: page AND layer AND centroid-in-box, each optional.

    Composed vectorized so a page-only floor costs no row-wise iteration.
    ``between`` is inclusive and an empty geometry yields a NaN centroid that
    compares false, matching the row-wise rule this replaces.
    """
    mask = pd.Series(True, index=frame.index, dtype=bool)
    if floor.pages is not None:
        mask &= frame["page"].isin(floor.pages)
    if floor.layer_names is not None:
        mask &= frame["ai_layer"].isin(floor.layer_names)
    if floor.region is not None:
        minx, miny, maxx, maxy = floor.region
        centroids = frame.geometry.centroid
        mask &= centroids.x.between(minx, maxx) & centroids.y.between(miny, maxy)
    return mask
```

- [ ] **Step 5: Update both call sites**

In `build_georeferenced_bundle`, replace lines 187-189:

```python
                mask = _floor_mask(remaining, floor)
```

In `compute_assignment_summary`, replace lines 276-278:

```python
            mask = _floor_mask(remaining, floor)
```

- [ ] **Step 6: Run the full export and georeference suites to verify they pass**

Run: `pytest backend/tests/test_illustrator_export.py -v`
Expected: PASS — the new page tests plus every pre-existing membership test (box straddling, layer restriction, two-floor split, per-floor transforms, export report) unchanged. These pre-existing tests are what prove the vectorized mask preserved the inclusive-bounds and empty-geometry semantics.

- [ ] **Step 7: Commit**

```bash
git add backend/src/illustrator_export.py backend/tests/test_illustrator_export.py
git commit -m "feat: page-aware floor membership with a vectorized mask"
```

---

## Task 4: Schemas and routes

**Files:**
- Modify: `backend/src/schemas.py:579-601` (preview models), `:635-640` (`FloorRegionPayload`), `backend/routers/import_router.py:252-276` (preview), `:298-334` (assign), `:367-376` (export)
- Test: `backend/tests/test_illustrator_api.py`

**Interfaces:**
- Consumes: `build_preview(...)["pages"]` from Task 2; `ExportFloor(..., pages=...)` from Task 3.
- Produces: `IllustratorPagePreview` pydantic model; `IllustratorPreviewResponse.pages: list[IllustratorPagePreview]`; `FloorRegionPayload` with `box: list[float] | None = None` (4-element when present) and `pages: list[int] | None = None`. `POST /assign` rejects out-of-range page numbers with 422.

- [ ] **Step 1: Write the failing tests**

Extend the module-level import at `backend/tests/test_illustrator_api.py:11` to pull in the multi-page fixture, matching how `_build_minimal_ai_pdf` is already imported:

```python
from backend.tests.test_illustrator_import import (
    _build_minimal_ai_pdf,
    _build_multipage_ai_pdf,
)
```

Add a multi-page preview helper beside the existing `_preview` (lines 14-18), reusing its `files=[...]` list form and `application/postscript` mimetype:

```python
def _preview_multipage(test_client):
    return test_client.post(
        "/api/convert/illustrator/preview",
        files=[("file", ("three.ai", _build_multipage_ai_pdf(), "application/postscript"))],
    )
```

Then append the tests. Note the status code: this app maps `ValueError` to **400**, not 422 — the existing `test_assign_rejects_duplicate_labels` (line 235-242) asserts 400, and the new page-range rejection uses the same `ValueError` path.

```python
@pytest.mark.georef
def test_preview_returns_page_metadata(test_client) -> None:
    response = _preview_multipage(test_client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["report"]["page_count"] == 3
    assert [p["index"] for p in body["pages"]] == [1, 2, 3]
    assert body["pages"][2]["width_pt"] == 400.0


@pytest.mark.georef
def test_preview_of_a_single_page_file_lists_one_page(test_client) -> None:
    body = _preview(test_client).json()
    assert [p["index"] for p in body["pages"]] == [1]


@pytest.mark.georef
def test_assign_accepts_page_floors(test_client) -> None:
    payload = _preview_multipage(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign",
        json={
            "floors": [
                {"label": "1F", "pages": [1], "box": None, "layer_names": None},
                {"label": "2F", "pages": [2, 3], "box": None, "layer_names": None},
            ]
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert {floor["label"]: floor["feature_count"] for floor in data["floors"]} == {
        "1F": 1,
        "2F": 2,
    }
    assert data["unassigned_count"] == 0


@pytest.mark.georef
def test_assign_rejects_a_page_number_out_of_range(test_client) -> None:
    payload = _preview_multipage(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign",
        json={"floors": [{"label": "9F", "pages": [4], "box": None, "layer_names": None}]},
    )
    assert response.status_code == 400, response.text


@pytest.mark.georef
def test_assign_still_accepts_a_box_only_floor(test_client) -> None:
    """Backward compatibility: a payload with no `pages` key at all."""
    payload = _preview(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign",
        json={"floors": [{"label": "1F", "box": [0, 0, 200, 200], "layer_names": None}]},
    )
    assert response.status_code == 200, response.text


@pytest.mark.georef
def test_export_after_a_page_assignment(test_client) -> None:
    payload = _preview_multipage(test_client).json()
    conversion_id = payload["conversion_id"]
    assigned = test_client.post(
        f"/api/convert/illustrator/{conversion_id}/assign",
        json={
            "floors": [
                {"label": "1F", "pages": [1], "box": None, "layer_names": None},
                {"label": "2F", "pages": [2], "box": None, "layer_names": None},
            ]
        },
    )
    assert assigned.status_code == 200, assigned.text
    transform = {
        "artwork_anchor": [100.0, 80.0],
        "map_anchor": [139.7671, 35.6812],
        "rotation_deg": 0.0,
        "metres_per_point": 0.176389,
        "working_crs": "EPSG:6677",
    }
    response = test_client.post(
        f"/api/convert/illustrator/{conversion_id}/export",
        json={
            "floors": [
                {"label": "1F", "transform": transform},
                {"label": "2F", "transform": transform},
            ],
            "output_crs": "EPSG:4326",
            "formats": {"geopackage": True, "shapefile": False, "qgis": False},
        },
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert any(name.endswith(".gpkg") for name in archive.namelist())


@pytest.mark.georef
def test_floors_json_round_trips_pages_with_a_null_box(tmp_path) -> None:
    from backend.src.illustrator_importer import parse_ai
    from backend.src.illustrator_store import ConversionStore

    store = ConversionStore(root=tmp_path, ttl_seconds=3600, max_entries=5)
    cached = store.put(parse_ai(_build_multipage_ai_pdf(), "three.ai"))
    floors = [{"label": "1F", "box": None, "pages": [1, 2], "layer_names": None}]
    assert store.assign(cached.conversion_id, floors).floors == floors
    assert store.get(cached.conversion_id).floors == floors
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_api.py -v -k "page"`
Expected: FAIL — `KeyError: 'pages'` on the preview body, and a validation rejection of the unknown `pages` field on assign (`extra="forbid"` on `FloorRegionPayload`).

- [ ] **Step 3: Add the page preview model and relax the box**

In `backend/src/schemas.py`, extend the typing import at line 6-7:

```python
from typing import Annotated
from typing import Any
from typing import Literal
```

Add the page model directly after `IllustratorLayerSummary` (which ends at line 585) and add `pages` to `IllustratorPreviewResponse`:

```python
class IllustratorPagePreview(BaseModel):
    """One page of the source document, for the floor-assignment grid."""

    model_config = ConfigDict(extra="forbid")

    index: int
    bounds: list[float] = Field(min_length=4, max_length=4)
    width_pt: float
    height_pt: float
    feature_count: int
    preview_feature_count: int


class IllustratorPreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversion_id: str
    report: dict[str, Any]
    layers: list[IllustratorLayerSummary] = Field(default_factory=list)
    pages: list[IllustratorPagePreview] = Field(default_factory=list)
    artwork_bounds: list[float]
    preview: dict[str, Any]
    preview_features: int
    total_features: int
    suggested_crs: str
    suggested_crs_label: str
```

Replace `FloorRegionPayload` (lines 635-640). The box constraint goes inside `Annotated` because pydantic cannot apply `min_length` directly to a nullable union:

```python
_ArtworkBox = Annotated[list[float], Field(min_length=4, max_length=4)]


class FloorRegionPayload(BaseModel):
    """One floor's filters in artwork space; ``None`` means "no restriction"."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=40)
    box: _ArtworkBox | None = None
    pages: list[int] | None = None
    layer_names: list[str] | None = None
```

- [ ] **Step 4: Wire the routes**

In `backend/routers/import_router.py`, add `pages` to the preview response (inside the `IllustratorPreviewResponse(...)` call at lines 266-276, after `layers=`):

```python
        layers=preview["layers"],
        pages=preview["pages"],
```

In `assign_illustrator_floors`, add page validation after the existing layer-name loop (which ends at line 314) and pass `pages` through. Replace lines 309-329:

```python
    known_layers = {spec["ai_layer"] for spec in cached.written_layers}
    page_count = int(cached.report.get("page_count") or 1)
    for floor in payload.floors:
        if floor.layer_names:
            unknown = [name for name in floor.layer_names if name not in known_layers]
            if unknown:
                raise ValueError(f"Unknown layer name(s): {', '.join(unknown)}")
        if floor.pages:
            out_of_range = sorted({p for p in floor.pages if p < 1 or p > page_count})
            if out_of_range:
                raise ValueError(
                    f"Page number(s) outside 1..{page_count}: "
                    + ", ".join(str(p) for p in out_of_range)
                )

    floors = [floor.model_dump() for floor in payload.floors]
    _illustrator_store(request).assign(conversion_id, floors)
    summaries, unassigned = compute_assignment_summary(
        cached,
        [
            ExportFloor(
                label=floor["label"],
                transform=_PLACEHOLDER_TRANSFORM,  # summary only needs the filters
                region=floor.get("box"),
                layer_names=floor.get("layer_names"),
                pages=floor.get("pages"),
            )
            for floor in floors
        ],
    )
```

In `export_illustrator`, forward `pages` from the stored assignment. Replace lines 367-376:

```python
        regions = {floor["label"]: floor for floor in cached.floors}
        floors = [
            ExportFloor(
                label=floor.label,
                transform=_transform_from_payload(floor.transform),
                region=regions[floor.label].get("box"),
                layer_names=regions[floor.label].get("layer_names"),
                pages=regions[floor.label].get("pages"),
            )
            for floor in payload.floors
        ]
```

- [ ] **Step 5: Run the API tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_api.py -v`
Expected: PASS — the six new tests plus every pre-existing API test (including the single implicit floor backward-compat test).

- [ ] **Step 6: Commit**

```bash
git add backend/src/schemas.py backend/routers/import_router.py backend/tests/test_illustrator_api.py
git commit -m "feat: expose pages in the preview and accept page floors on assign"
```

---

## Task 5: Frontend page splitting and membership parity

**Files:**
- Modify: `frontend/src/lib/svgPreview.ts:14-18` (`PartitionFloor`), `:138-160` (`partitionByFloors`), `frontend/src/api/client.ts:433-439`, `:840-857`, `:911-921`
- Test: `frontend/src/lib/svgPreview.test.ts`

**Interfaces:**
- Consumes: the backend preview payload from Task 4.
- Produces: `PartitionFloor = { label: string; box: [number, number, number, number] | null; pages: number[] | null; layerNames: string[] | null }`; `splitByPage(preview: FeatureCollection): Map<number, FeatureCollection>` ordered by ascending page; `IllustratorPagePreview` type; `assignFloors(conversionId, floors: { label: string; box: [number,number,number,number] | null; pages: number[] | null; layer_names: string[] | null }[])`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/svgPreview.test.ts`:

```typescript
function pageFeature(page: number, x: number, y: number, layer = "Fill Layer") {
  return {
    type: "Feature" as const,
    properties: { page, ai_layer: layer, role: "polygon" },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [x, y],
          [x + 10, y],
          [x + 10, y + 10],
          [x, y + 10],
          [x, y]
        ]
      ]
    }
  };
}

function threePagePreview() {
  return {
    type: "FeatureCollection" as const,
    features: [pageFeature(1, 0, 0), pageFeature(2, 0, 0), pageFeature(3, 50, 50)]
  };
}

test("splitByPage groups features by page in ascending order", () => {
  const byPage = splitByPage(threePagePreview());
  expect([...byPage.keys()]).toEqual([1, 2, 3]);
  expect(byPage.get(1)!.features).toHaveLength(1);
  expect(byPage.get(1)!.type).toBe("FeatureCollection");
});

test("splitByPage treats a feature with no page property as page 1", () => {
  const preview = {
    type: "FeatureCollection" as const,
    features: [{ ...pageFeature(1, 0, 0), properties: { ai_layer: "Fill Layer" } }]
  };
  expect([...splitByPage(preview).keys()]).toEqual([1]);
});

test("partitionByFloors assigns by page when no box is given", () => {
  const { perFloor, unassigned } = partitionByFloors(threePagePreview(), [
    { label: "1F", box: null, pages: [1], layerNames: null }
  ]);
  expect(perFloor.get("1F")).toHaveLength(1);
  expect(unassigned).toHaveLength(2);
});

test("partitionByFloors merges several pages under one label", () => {
  const { perFloor, unassigned } = partitionByFloors(threePagePreview(), [
    { label: "1F", box: null, pages: [1, 3], layerNames: null }
  ]);
  expect(perFloor.get("1F")).toHaveLength(2);
  expect(unassigned).toHaveLength(1);
});

test("partitionByFloors intersects page with box", () => {
  const floors = [
    { label: "1F", box: [40, 40, 80, 80] as [number, number, number, number], pages: [3], layerNames: null }
  ];
  expect(partitionByFloors(threePagePreview(), floors).perFloor.get("1F")).toHaveLength(1);

  const wrongPage = [{ ...floors[0], pages: [1] }];
  expect(partitionByFloors(threePagePreview(), wrongPage).perFloor.get("1F")).toHaveLength(0);
});

test("partitionByFloors intersects page with layer restriction", () => {
  const preview = {
    type: "FeatureCollection" as const,
    features: [pageFeature(1, 0, 0, "walls"), pageFeature(1, 0, 0, "tracks")]
  };
  const { perFloor } = partitionByFloors(preview, [
    { label: "1F", box: null, pages: [1], layerNames: ["walls"] }
  ]);
  expect(perFloor.get("1F")).toHaveLength(1);
});

test("a floor with no page, box or layer restriction claims everything", () => {
  const { perFloor, unassigned } = partitionByFloors(threePagePreview(), [
    { label: "artwork", box: null, pages: null, layerNames: null }
  ]);
  expect(perFloor.get("artwork")).toHaveLength(3);
  expect(unassigned).toHaveLength(0);
});
```

Extend the existing import at the top of the file to include `splitByPage`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/svgPreview.test.ts`
Expected: FAIL — `splitByPage is not a function`, plus type errors on the `pages` property.

- [ ] **Step 3: Add splitByPage and the page predicate**

In `frontend/src/lib/svgPreview.ts`, replace `PartitionFloor` (lines 14-18):

```typescript
export type PartitionFloor = {
  label: string;
  /** Artwork-space box, or null for no spatial restriction. */
  box: [number, number, number, number] | null;
  /** 1-based page numbers, or null for no page restriction. */
  pages: number[] | null;
  layerNames: string[] | null;
};
```

Add `splitByPage` directly after `buildSvgPaths` (which ends at line 62):

```typescript
/**
 * Split a preview into one FeatureCollection per page, keyed by page number.
 *
 * Pages are normalized to their own MediaBox origin by the importer, so every
 * page's geometry overlaps in artwork space and only this split separates them.
 */
export function splitByPage(preview: Preview): Map<number, FeatureCollection> {
  const buckets = new Map<number, Feature[]>();
  for (const feature of preview.features) {
    const page = Number(feature.properties?.page ?? 1);
    const bucket = buckets.get(page);
    if (bucket) bucket.push(feature);
    else buckets.set(page, [feature]);
  }
  return new Map(
    [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, features]) => [
        page,
        { type: "FeatureCollection", features } as FeatureCollection
      ])
  );
}
```

Replace the body of `partitionByFloors` (lines 138-160) so it mirrors the server's three-predicate chain:

```typescript
export function partitionByFloors(
  preview: Preview,
  floors: PartitionFloor[]
): { perFloor: Map<string, Feature[]>; unassigned: Feature[] } {
  const perFloor = new Map<string, Feature[]>(floors.map((f) => [f.label, []]));
  const unassigned: Feature[] = [];

  for (const feature of preview.features) {
    const [cx, cy] = featureCentroid(feature);
    const layer = feature.properties?.ai_layer as string | undefined;
    const page = Number(feature.properties?.page ?? 1);
    // Same conjunction as the server's _floor_mask, in the same order:
    // each filter is optional and null means "no restriction".
    const match = floors.find((floor) => {
      if (floor.pages !== null && !floor.pages.includes(page)) return false;
      if (floor.layerNames !== null && !floor.layerNames.includes(layer ?? "")) return false;
      if (floor.box !== null) {
        const [minx, miny, maxx, maxy] = floor.box;
        if (!(minx <= cx && cx <= maxx && miny <= cy && cy <= maxy)) return false;
      }
      return true;
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

Update the module docstring at lines 4-7 to mention the page dimension:

```typescript
/**
 * Artwork-preview painting and floor partitioning.
 *
 * The preview is a decimated GeoJSON FeatureCollection in artwork points. It is
 * rendered to SVG for the assignment panel, and partitioned by the same
 * page/layer/centroid-in-box rule the server applies at export. The partition
 * here is display-only: the server re-verifies membership from full-fidelity
 * geometry.
 */
```

- [ ] **Step 4: Add the client types**

In `frontend/src/api/client.ts`, add `pages` to `IllustratorConversionReport` (lines 433-439):

```typescript
export type IllustratorConversionReport = {
  source_name: string;
  page_count: number;
  pages: { index: number; width_pt: number; height_pt: number }[];
  total_features: number;
  layers: Record<string, { polygon: number; line: number }>;
  warnings: string[];
};
```

Add the page preview type and field after `IllustratorLayerSummary` (lines 840-857):

```typescript
export type IllustratorPagePreview = {
  index: number;
  bounds: [number, number, number, number];
  width_pt: number;
  height_pt: number;
  feature_count: number;
  preview_feature_count: number;
};

export type IllustratorPreviewResponse = {
  conversion_id: string;
  report: IllustratorConversionReport;
  layers: IllustratorLayerSummary[];
  pages: IllustratorPagePreview[];
  artwork_bounds: [number, number, number, number];
  preview: { type: "FeatureCollection"; features: any[] };
  preview_features: number;
  total_features: number;
  suggested_crs: string;
  suggested_crs_label: string;
};
```

Widen the `assignFloors` payload (lines 911-914):

```typescript
export async function assignFloors(
  conversionId: string,
  floors: {
    label: string;
    box: [number, number, number, number] | null;
    pages: number[] | null;
    layer_names: string[] | null;
  }[]
): Promise<AssignFloorsResponse> {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/svgPreview.test.ts`
Expected: PASS — the seven new tests plus the pre-existing `partitionByFloors` tests. The two pre-existing partition tests will still fail to typecheck until Task 6 and 7 update their callers; that is expected, and `npx vitest run` only executes this file. Fix the two pre-existing test fixtures in this file now by adding `pages: null` to their floor literals.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/svgPreview.ts frontend/src/lib/svgPreview.test.ts frontend/src/api/client.ts
git commit -m "feat: split preview features by page and match the server's floor rule"
```

---

## Task 6: Page assignment grid

**Files:**
- Create: `frontend/src/components/illustrator/PageAssignmentPanel.tsx`
- Create: `frontend/src/components/illustrator/PageAssignmentPanel.test.tsx`
- Modify: `frontend/src/components/illustrator/AssignmentPanel.tsx:13-19` (props), `:23-30` (`DraftFloor`), `:99-106` (partition call), `:244-259` (footer)

**Interfaces:**
- Consumes: `splitByPage`, `buildSvgPaths`, `PartitionFloor` from Task 5; `IllustratorPagePreview` from Task 5.
- Produces: `PageAssignmentPanel` component; pure exported helpers `buildFloors(cards: PageCard[], boxesByPage: Map<number, PartitionFloor[]>): PartitionFloor[]` and `duplicateLabels(floors: PartitionFloor[]): string[]`, plus the exported `PageCard = { index: number; label: string; excluded: boolean }` type. `AssignmentPanel` gains optional props `page?: number | null` (tags its boxes with that page) and `onCancel?: () => void` (renders a back button).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/illustrator/PageAssignmentPanel.test.tsx`:

```typescript
import { fireEvent, render, screen } from "@testing-library/react";

import { PageAssignmentPanel, buildFloors, duplicateLabels } from "./PageAssignmentPanel";
import type { IllustratorPagePreview } from "../../api/client";
import type { PartitionFloor } from "../../lib/svgPreview";


function page(index: number, overrides: Partial<IllustratorPagePreview> = {}): IllustratorPagePreview {
  return {
    index,
    bounds: [0, 0, 200, 200],
    width_pt: 200,
    height_pt: 200,
    feature_count: 1,
    preview_feature_count: 1,
    ...overrides
  };
}

function feature(pageNo: number) {
  return {
    type: "Feature" as const,
    properties: { page: pageNo, ai_layer: "Fill Layer", role: "polygon" },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0]
        ]
      ]
    }
  };
}

function renderPanel(pages: IllustratorPagePreview[], onAssigned = () => {}) {
  const preview = {
    type: "FeatureCollection" as const,
    features: pages.map((p) => feature(p.index))
  };
  render(
    <PageAssignmentPanel
      preview={preview}
      pages={pages}
      layerSummaries={[{ table: "Fill Layer", ai_layer: "Fill Layer", role: "polygon", feature_count: 1 }]}
      onAssigned={onAssigned}
      onSkip={() => {}}
    />
  );
}


test("buildFloors names pages 1F, 2F in page order", () => {
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: false },
      { index: 2, label: "2F", excluded: false }
    ],
    new Map()
  );
  expect(floors).toEqual([
    { label: "1F", box: null, pages: [1], layerNames: null },
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
});

test("buildFloors merges pages that share a label into one floor", () => {
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: false },
      { index: 2, label: "1F", excluded: false },
      { index: 3, label: "2F", excluded: false }
    ],
    new Map()
  );
  expect(floors).toEqual([
    { label: "1F", box: null, pages: [1, 2], layerNames: null },
    { label: "2F", box: null, pages: [3], layerNames: null }
  ]);
});

test("buildFloors drops excluded pages and blank labels", () => {
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: true },
      { index: 2, label: "   ", excluded: false },
      { index: 3, label: "3F", excluded: false }
    ],
    new Map()
  );
  expect(floors).toEqual([{ label: "3F", box: null, pages: [3], layerNames: null }]);
});

test("buildFloors uses a page's boxes instead of a whole-page floor", () => {
  const boxes: PartitionFloor[] = [
    { label: "1F-north", box: [0, 0, 100, 200], pages: [1], layerNames: null },
    { label: "1F-south", box: [100, 0, 200, 200], pages: [1], layerNames: null }
  ];
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: false },
      { index: 2, label: "2F", excluded: false }
    ],
    new Map([[1, boxes]])
  );
  expect(floors).toEqual([
    ...boxes,
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
});

test("duplicateLabels finds a collision between a box floor and a page floor", () => {
  expect(
    duplicateLabels([
      { label: "2F", box: [0, 0, 10, 10], pages: [1], layerNames: null },
      { label: "2F", box: null, pages: [2], layerNames: null }
    ])
  ).toEqual(["2F"]);
  expect(duplicateLabels([{ label: "1F", box: null, pages: [1], layerNames: null }])).toEqual([]);
});

test("a page with no features defaults to excluded", () => {
  renderPanel([page(1), page(2, { feature_count: 0, preview_feature_count: 0 })]);
  const toggles = screen.getAllByRole("checkbox");
  expect(toggles[0]).not.toBeChecked();
  expect(toggles[1]).toBeChecked();
});

test("the size warning appears only when sheet sizes differ", () => {
  renderPanel([page(1), page(2)]);
  expect(screen.queryByTestId("page-size-warning")).toBeNull();
});

test("differing sheet sizes warn that floors may need individual positioning", () => {
  renderPanel([page(1), page(2, { width_pt: 400, height_pt: 400 })]);
  expect(screen.getByTestId("page-size-warning")).toBeInTheDocument();
});

test("two pages named the same show a merge hint", () => {
  renderPanel([page(1), page(2)]);
  const inputs = screen.getAllByLabelText(/floor name/i);
  fireEvent.change(inputs[1], { target: { value: "1F" } });
  expect(screen.getAllByText("2 pages → 1F").length).toBeGreaterThan(0);
});

test("Done assigning emits one floor per page", () => {
  const calls: PartitionFloor[][] = [];
  renderPanel([page(1), page(2)], (floors) => calls.push(floors));
  fireEvent.click(screen.getByRole("button", { name: /done assigning/i }));
  expect(calls[0]).toEqual([
    { label: "1F", box: null, pages: [1], layerNames: null },
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
});

test("Done assigning is disabled when every page is excluded", () => {
  renderPanel([page(1, { feature_count: 0 }), page(2, { feature_count: 0 })]);
  expect(screen.getByRole("button", { name: /done assigning/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/illustrator/PageAssignmentPanel.test.tsx`
Expected: FAIL — cannot resolve `./PageAssignmentPanel`.

- [ ] **Step 3: Let AssignmentPanel tag its boxes with a page**

In `frontend/src/components/illustrator/AssignmentPanel.tsx`, replace the props type (lines 13-19) and `DraftFloor` (lines 23-28):

```typescript
type Props = {
  preview: FeatureCollection;
  artworkBounds: [number, number, number, number];
  layerSummaries: { table: string; ai_layer: string; role: string; feature_count: number }[];
  onAssigned: (floors: PartitionFloor[]) => void;
  onSkip: () => void;
  /** When drilling into one page of a multi-page file, tag boxes with it. */
  page?: number | null;
  /** Renders a back button when set (drill-in mode). */
  onCancel?: () => void;
};
```

```typescript
type DraftFloor = {
  label: string;
  box: [number, number, number, number];
  layerNames: string[] | null;
  color: string;
};
```

(`DraftFloor` is unchanged — the page is not per-draft, it is per-panel.)

Update the signature at line 38:

```typescript
export function AssignmentPanel({
  preview,
  artworkBounds,
  layerSummaries,
  onAssigned,
  onSkip,
  page = null,
  onCancel
}: Props) {
```

Add a memo for the page tag directly after the `svgRef` declaration (line 45):

```typescript
  // Null outside drill-in mode, so a single-page file keeps sending null pages.
  const pageTag = useMemo(() => (page == null ? null : [page]), [page]);
```

Replace the partition call (lines 99-106) so the display filter carries the same page tag:

```typescript
  const { perFloor, unassigned } = useMemo(
    () =>
      partitionByFloors(
        preview,
        drafts.map((d) => ({
          label: d.label,
          box: d.box,
          pages: pageTag,
          layerNames: d.layerNames
        }))
      ),
    [preview, drafts, pageTag]
  );
```

Replace the footer (lines 244-259) to add the back button and the page tag on emit:

```typescript
      <div className="flex gap-2">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            {t("Back to pages", "ページ一覧へ戻る")}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onSkip}>
            {t("Skip — one floor for everything", "スキップ — 全図形を1フロアに")}
          </Button>
        )}
        <Button
          className="ml-auto"
          disabled={drafts.length === 0}
          onClick={() =>
            onAssigned(
              drafts.map((d) => ({
                label: d.label,
                box: d.box,
                pages: pageTag,
                layerNames: d.layerNames
              }))
            )
          }
        >
          {t("Done assigning", "割り当て完了")}
        </Button>
      </div>
```

- [ ] **Step 4: Write the page grid**

Create `frontend/src/components/illustrator/PageAssignmentPanel.tsx`:

```typescript
import { useMemo, useState } from "react";
import type { FeatureCollection } from "geojson";

import type { IllustratorPagePreview } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { buildSvgPaths, splitByPage, type PartitionFloor } from "../../lib/svgPreview";
import { Button } from "../ui";
import { AssignmentPanel } from "./AssignmentPanel";

type Props = {
  preview: FeatureCollection;
  pages: IllustratorPagePreview[];
  layerSummaries: { table: string; ai_layer: string; role: string; feature_count: number }[];
  onAssigned: (floors: PartitionFloor[]) => void;
  onSkip: () => void;
};

export type PageCard = {
  index: number;
  label: string;
  excluded: boolean;
};

const EMPTY_PREVIEW: FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Turn the grid's state into floor records.
 *
 * A page that was split into boxes contributes those boxes (already tagged with
 * their page); every other included page contributes a whole-page floor. Pages
 * sharing a trimmed label merge into one floor — the label is the grouping key.
 */
export function buildFloors(
  cards: PageCard[],
  boxesByPage: Map<number, PartitionFloor[]>
): PartitionFloor[] {
  const boxFloors: PartitionFloor[] = [];
  const merged = new Map<string, number[]>();

  for (const card of cards) {
    if (card.excluded) continue;
    const boxes = boxesByPage.get(card.index);
    if (boxes && boxes.length > 0) {
      boxFloors.push(...boxes);
      continue;
    }
    const label = card.label.trim();
    if (!label) continue;
    const pages = merged.get(label);
    if (pages) pages.push(card.index);
    else merged.set(label, [card.index]);
  }

  return [
    ...boxFloors,
    ...[...merged.entries()].map(([label, pages]) => ({
      label,
      box: null,
      pages,
      layerNames: null
    }))
  ];
}

/** Labels claimed by more than one floor — the assign endpoint rejects these. */
export function duplicateLabels(floors: PartitionFloor[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const floor of floors) {
    if (seen.has(floor.label)) duplicates.add(floor.label);
    seen.add(floor.label);
  }
  return [...duplicates];
}

/**
 * Floor assignment for a multi-page document: one card per page.
 *
 * The common case — one floor plan per page — needs no drawing at all. A page
 * holding several plans drills into AssignmentPanel, whose boxes come back
 * tagged with that page, so a box floor and a page floor are the same record.
 */
export function PageAssignmentPanel({
  preview,
  pages,
  layerSummaries,
  onAssigned,
  onSkip
}: Props) {
  const { t } = useUiLanguage();
  const byPage = useMemo(() => splitByPage(preview), [preview]);
  const [cards, setCards] = useState<PageCard[]>(() =>
    pages.map((page, position) => ({
      index: page.index,
      label: `${position + 1}F`,
      // A blank or text-only sheet is not a floor plan.
      excluded: page.feature_count === 0
    }))
  );
  const [boxesByPage, setBoxesByPage] = useState<Map<number, PartitionFloor[]>>(new Map());
  const [splitting, setSplitting] = useState<number | null>(null);

  const sizesDiffer = useMemo(
    () => new Set(pages.map((page) => `${page.width_pt}x${page.height_pt}`)).size > 1,
    [pages]
  );
  const floors = useMemo(() => buildFloors(cards, boxesByPage), [cards, boxesByPage]);
  const duplicates = useMemo(() => duplicateLabels(floors), [floors]);
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (card.excluded || boxesByPage.get(card.index)?.length) continue;
      const label = card.label.trim();
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  }, [cards, boxesByPage]);

  const update = (index: number, patch: Partial<PageCard>) =>
    setCards((prev) => prev.map((card) => (card.index === index ? { ...card, ...patch } : card)));

  if (splitting !== null) {
    const page = pages.find((candidate) => candidate.index === splitting);
    return (
      <AssignmentPanel
        preview={byPage.get(splitting) ?? EMPTY_PREVIEW}
        artworkBounds={page?.bounds ?? [0, 0, 100, 100]}
        layerSummaries={layerSummaries}
        page={splitting}
        onCancel={() => setSplitting(null)}
        onSkip={() => setSplitting(null)}
        onAssigned={(boxes) => {
          setBoxesByPage((prev) => new Map(prev).set(splitting, boxes));
          setSplitting(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-[var(--color-text-muted)]">
        {t(
          "Name the floor on each page. Pages given the same name become one floor; untick a cover sheet or legend to leave it out.",
          "各ページのフロア名を入力してください。同じ名前のページは1つのフロアにまとまります。表紙や凡例はチェックを外して除外できます。"
        )}
      </p>

      {sizesDiffer ? (
        <p
          data-testid="page-size-warning"
          className="rounded-[var(--radius-md)] border border-amber-400 bg-amber-50 p-2 text-xs"
        >
          {t(
            "The pages are not all the same size, so their floor plans may land offset from each other. Position one floor on the map, then drag any floor that needs its own position.",
            "ページのサイズが揃っていないため、各階の位置がずれる場合があります。地図上で1フロアを配置し、位置が合わないフロアは個別にドラッグしてください。"
          )}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {pages.map((page) => {
          const card = cards.find((candidate) => candidate.index === page.index)!;
          const boxes = boxesByPage.get(page.index) ?? [];
          const pagePreview = byPage.get(page.index) ?? EMPTY_PREVIEW;
          const { viewBox, paths } = buildSvgPaths(pagePreview, page.bounds);
          const [, miny, , maxy] = page.bounds;
          const mergeCount = labelCounts.get(card.label.trim()) ?? 0;
          return (
            <div
              key={page.index}
              className={`rounded-[var(--radius-md)] border p-2 ${
                card.excluded ? "opacity-50" : ""
              }`}
            >
              <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                <span>
                  {t("Page", "ページ")} {page.index}
                </span>
                <span>
                  {Math.round(page.width_pt)} × {Math.round(page.height_pt)} pt
                </span>
              </div>

              <div className="overflow-hidden rounded-[var(--radius-md)] border bg-white">
                <svg viewBox={viewBox} className="h-32 w-full">
                  {/* Artwork points are y-up; SVG user space is y-down. */}
                  <g transform={`translate(0 ${miny + maxy}) scale(1 -1)`}>
                    {paths.map((path, position) => (
                      <path
                        key={position}
                        d={path.d}
                        fill={path.role === "polygon" ? (path.fill ?? "#cbd5e1") : "none"}
                        stroke={path.role === "line" ? (path.stroke ?? "#64748b") : "#64748b"}
                        strokeWidth={path.role === "line" ? 0.5 : 0.25}
                        fillOpacity={path.role === "polygon" ? 0.6 : 1}
                      />
                    ))}
                  </g>
                </svg>
              </div>

              <label className="mt-2 flex items-center gap-2">
                <span className="sr-only">
                  {t(`Floor name for page ${page.index}`, `ページ ${page.index} のフロア名`)}
                </span>
                <input
                  aria-label={t(
                    `Floor name for page ${page.index}`,
                    `ページ ${page.index} のフロア名`
                  )}
                  className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
                  value={card.label}
                  disabled={card.excluded || boxes.length > 0}
                  onChange={(event) => update(page.index, { label: event.target.value })}
                />
                <span className="text-xs text-[var(--color-text-muted)]">
                  {t("shapes", "図形")}: {page.preview_feature_count}
                </span>
              </label>

              {boxes.length > 0 ? (
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {t(`${boxes.length} boxes on this page`, `このページに ${boxes.length} 個の範囲`)}
                </p>
              ) : mergeCount > 1 ? (
                <p className="mt-1 text-xs text-blue-700">
                  {mergeCount} {t("pages", "ページ")} → {card.label.trim()}
                </p>
              ) : null}

              <div className="mt-2 flex items-center justify-between">
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    aria-label={t(
                      `Page ${page.index} is not a floor plan`,
                      `ページ ${page.index} は平面図ではない`
                    )}
                    checked={card.excluded}
                    onChange={(event) =>
                      update(page.index, { excluded: event.target.checked })
                    }
                  />
                  {t("Not a floor plan", "平面図ではない")}
                </label>
                <button
                  type="button"
                  className="text-xs underline"
                  disabled={card.excluded}
                  onClick={() => setSplitting(page.index)}
                >
                  {boxes.length > 0
                    ? t("Edit boxes…", "範囲を編集…")
                    : t("Split this page…", "このページを分割…")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {duplicates.length > 0 ? (
        <p className="text-xs text-[var(--color-error)]">
          {t(
            `Two floors share the name ${duplicates.join(", ")}. Rename one.`,
            `フロア名 ${duplicates.join("、")} が重複しています。いずれかを変更してください。`
          )}
        </p>
      ) : null}

      <p className="text-xs">
        {t(
          `${floors.length} floor(s) from ${pages.length} page(s).`,
          `${pages.length} ページから ${floors.length} フロア。`
        )}
      </p>

      <div className="flex gap-2">
        <Button variant="secondary" onClick={onSkip}>
          {t("Skip — one floor for everything", "スキップ — 全図形を1フロアに")}
        </Button>
        <Button
          className="ml-auto"
          disabled={floors.length === 0 || duplicates.length > 0}
          onClick={() => onAssigned(floors)}
        >
          {t("Done assigning", "割り当て完了")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/illustrator/PageAssignmentPanel.test.tsx`
Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/illustrator/PageAssignmentPanel.tsx frontend/src/components/illustrator/PageAssignmentPanel.test.tsx frontend/src/components/illustrator/AssignmentPanel.tsx
git commit -m "feat: page assignment grid with merge, exclude and drill-in"
```

---

## Task 7: Wire the grid into the wizard

**Files:**
- Modify: `frontend/src/pages/IllustratorPage.tsx:39-43` (`AssignedRegion`), `:45-73` (`initialStateFromAssignment`), `:132-151` (`floorLayers`), `:244-283` (assign step)
- Test: `frontend/src/lib/svgPreview.test.ts` (already covers the partition math); no new test file — this task's deliverable is verified by the typecheck plus the browser smoke test in Task 8.

**Interfaces:**
- Consumes: `PageAssignmentPanel` from Task 6; `AssignFloorsResponse` and `IllustratorPagePreview` from Task 5.
- Produces: `AssignedRegion = { label: string; box: [number, number, number, number] | null; pages: number[] | null; layer_names: string[] | null }`; `initialStateFromAssignment(preview, assignment, summary?)` where `summary?: AssignFloorsResponse` supplies exact per-floor artwork bounds.

- [ ] **Step 1: Widen AssignedRegion and derive floor bounds from the assign response**

In `frontend/src/pages/IllustratorPage.tsx`, replace `AssignedRegion` and `initialStateFromAssignment` (lines 39-73):

```typescript
type AssignedRegion = {
  label: string;
  box: [number, number, number, number] | null;
  pages: number[] | null;
  layer_names: string[] | null;
};

/** Union of the given pages' content bounds, or null when none are known. */
function pageUnionBounds(
  preview: IllustratorPreviewResponse,
  pages: number[] | null
): [number, number, number, number] | null {
  if (!pages || pages.length === 0) return null;
  let union: [number, number, number, number] | null = null;
  for (const page of preview.pages) {
    if (!pages.includes(page.index)) continue;
    const [minx, miny, maxx, maxy] = page.bounds;
    union = union
      ? [
          Math.min(union[0], minx),
          Math.min(union[1], miny),
          Math.max(union[2], maxx),
          Math.max(union[3], maxy)
        ]
      : [minx, miny, maxx, maxy];
  }
  return union;
}

function initialStateFromAssignment(
  preview: IllustratorPreviewResponse,
  assignment: AssignedRegion[],
  summary?: AssignFloorsResponse
): PlacementState {
  const regions: AssignedRegion[] = assignment.length
    ? assignment
    : [{ label: "artwork", box: preview.artwork_bounds, pages: null, layer_names: null }];
  const first = regions[0];
  // The server already computed each floor's bounds from the geometry it
  // matched, which is exact for page floors (no box) and tighter than the
  // drawn box for box floors.
  const boundsFor = (region: AssignedRegion): [number, number, number, number] =>
    summary?.floors.find((floor) => floor.label === region.label)?.artwork_bounds ??
    region.box ??
    pageUnionBounds(preview, region.pages) ??
    preview.artwork_bounds;
  return {
    frame: {
      rotationDeg: 0,
      metresPerPoint: DEFAULT_METRES_PER_POINT,
      workingCrs: preview.suggested_crs
    },
    activeFloorLabel: first.label,
    scaleLocked: false,
    floors: regions.map((region) => {
      const bounds = boundsFor(region);
      return {
        label: region.label,
        linked: true,
        artworkAnchor: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        mapAnchor: [139.7671, 35.6812],
        controlPoints: [],
        artworkBounds: bounds
      };
    })
  };
}
```

Add `AssignFloorsResponse` and `IllustratorPagePreview` to the existing `../api/client` import, and `PageAssignmentPanel` to the illustrator component imports.

- [ ] **Step 2: Carry pages into the display partition**

In the `floorLayers` memo (lines 132-151), replace the implicit-floor literal and the partition call so both carry `pages`:

```typescript
    const regions: AssignedRegion[] = (assignment ?? []).length
      ? (assignment as AssignedRegion[])
      : [{ label: "artwork", box: preview.artwork_bounds, pages: null, layer_names: null }];
    const { perFloor } = partitionByFloors(
      preview.preview,
      regions.map((region) => ({
        label: region.label,
        box: region.box,
        pages: region.pages,
        layerNames: region.layer_names
      }))
    );
```

Read lines 137-151 before editing to keep the rest of the memo (the `FloorLayer` construction and its tint assignment) exactly as it is.

- [ ] **Step 3: Pick the grid for multi-page files**

Replace the assign step (lines 244-283):

```typescript
  if (assignment === null) {
    const commitAssignment = async (floors: PartitionFloor[]) => {
      const regions: AssignedRegion[] = floors.map((floor) => ({
        label: floor.label,
        box: floor.box,
        pages: floor.pages,
        layer_names: floor.layerNames
      }));
      try {
        const summary = await assignFloors(preview.conversion_id, regions);
        setAssignment(regions);
        dispatch({
          type: "resetPlacement",
          state: initialStateFromAssignment(preview, regions, summary)
        });
      } catch {
        setError(
          t(
            "Could not save the floor assignment.",
            "フロア割り当てを保存できませんでした。"
          )
        );
      }
    };

    return (
      <div className="flex flex-1 items-start justify-center px-4 py-10">
        <Card padding="lg" className="w-full max-w-4xl">
          <h1 className="text-lg font-semibold">
            {t("Assign floors", "フロアを割り当て")}
          </h1>
          {preview.pages.length > 1 ? (
            <PageAssignmentPanel
              preview={preview.preview}
              pages={preview.pages}
              layerSummaries={preview.layers}
              onSkip={() => setAssignment([])}
              onAssigned={commitAssignment}
            />
          ) : (
            <AssignmentPanel
              preview={preview.preview}
              artworkBounds={preview.artwork_bounds}
              layerSummaries={preview.layers}
              onSkip={() => setAssignment([])}
              onAssigned={commitAssignment}
            />
          )}
          {error ? <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p> : null}
        </Card>
      </div>
    );
  }
```

Add `type PartitionFloor` to the existing `../lib/svgPreview` import.

- [ ] **Step 4: Typecheck and run the whole frontend suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: PASS — no type errors, every test green. If `tsc` reports a `PartitionFloor` literal missing `pages` anywhere not listed in this plan, add `pages: null` there; that is the correct value for every pre-existing single-page call site.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/IllustratorPage.tsx
git commit -m "feat: route multi-page illustrator files to the page assignment grid"
```

---

## Task 8: Full verification and browser smoke test

**Files:** none modified — this task is proof the deliverable works.

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: evidence. No code.

- [ ] **Step 1: Run the backend slices the spec names**

Run: `pytest -m georef -q` then `pytest -m phase5 -q`
Expected: PASS, no failures, no errors. `phase5` covers converter/validator/autofix and must be unaffected — a failure there means the `page` column leaked into IMDF generation, which it must not.

- [ ] **Step 2: Run the whole backend suite**

Run: `pytest -q`
Expected: PASS. Anything failing here that passed before Task 1 is a regression, not a flake — fix it rather than re-running.

- [ ] **Step 3: Run the whole frontend suite and typecheck**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Smoke test the real flow in a browser**

Start the app with `./dev.ps1` (or `./dev.sh`). Then:

1. Open the app and go to the Illustrator page.
2. Upload a genuinely multi-page `.ai` or PDF. If none is at hand, generate a three-page file with `_build_multipage_ai_pdf()` from `backend/tests/test_illustrator_import.py` and save it as `three.pdf`.
3. Confirm the **page grid** appears — one card per page, each with its own thumbnail rather than one stacked mess. This is the bug being fixed; check it visually.
4. Confirm the sheet sizes are shown and, for the three-page fixture, that the size warning appears (page 3 is 400×400 against 200×200).
5. Rename page 2 to match page 1 and confirm the "2 pages → 1F" merge hint appears on both cards.
6. Untick "Not a floor plan" behaviour: exclude page 3 and confirm the floor count line drops.
7. Click "Split this page…" on page 1, draw a box, confirm it returns to the grid showing "1 boxes on this page", then re-enter and remove it.
8. Click "Done assigning", place one floor on the map, and confirm every floor moves together (they start linked).
9. Export with GeoPackage enabled. Open the zip and confirm one table set per floor, and that `export_report.json` counts the excluded page's features as unassigned.

Expected: each numbered check passes. Record what you observed for steps 3, 5 and 9 specifically — those are the three behaviours a reviewer cannot infer from the test suite.

- [ ] **Step 5: Commit nothing, report**

No commit. Report the verification output and the browser observations. If any step failed, fix it in the owning task's files and re-run that task's tests plus this one.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Parse: `_RecorderDevice.begin_page`, `_PathRecord.page`, `page` column, `ConversionReport.pages` | 1 |
| Preview: `pages[]` with bounds/size/counts, `properties.page`, unchanged decimation | 2 |
| `_read_layers` backfills a missing `page` column | 2 |
| Assign contract: optional `box`, `pages`, three-predicate membership | 3, 4 |
| Vectorized `_floor_mask` preserving inclusive bounds and empty-geometry semantics | 3 |
| Schemas: `IllustratorPagePreview`, `FloorRegionPayload` | 4 |
| Page-index validation (1..page_count → 422) | 4 |
| `floors.json` round-trips `pages` with a null box | 4 |
| Backward compat: box-only assign, old caches, single-page flow | 2, 4, 7 |
| `splitByPage`, `partitionByFloors` parity | 5 |
| Client types | 5 |
| Page grid: thumbnails, `1F/2F` defaults, merge by name, exclude, zero-feature default, size warning, drill-in | 6 |
| Floor bounds from the assign response | 7 |
| Grid vs. panel selection | 7 |
| `pytest -m georef`, `pytest -m phase5`, `npx vitest`, browser smoke | 8 |

Non-goals confirmed absent: no auto-alignment of unequal pages, no per-page export tables, no placement-step changes, no automatic floor naming beyond the editable `1F, 2F` default.

**Type consistency:** `PartitionFloor` carries `{label, box, pages, layerNames}` in Tasks 5, 6, 7 identically. `AssignedRegion` carries the snake_case `{label, box, pages, layer_names}` and is converted at the single boundary in Task 7's `commitAssignment`. `ExportFloor` field order `(label, transform, region, layer_names, pages)` is fixed in Task 3 and used with that order in Task 4. `build_preview`'s `pages` entry keys match `IllustratorPagePreview` (Task 2 ↔ Task 4) and `IllustratorPagePreview` in `client.ts` (Task 5).

**Known follow-through inside the plan:** Task 5 Step 5 notes that the two pre-existing `partitionByFloors` fixtures in `svgPreview.test.ts` need `pages: null` added, and Task 7 Step 4 catches any remaining call site via `tsc -b`. Task 4 Step 1 tells the implementer to reuse whatever `conversion_id` helper `test_illustrator_api.py` already defines rather than adding a second one — that is the only place this plan defers to existing code it does not quote.
