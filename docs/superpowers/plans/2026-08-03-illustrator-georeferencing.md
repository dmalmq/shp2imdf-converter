# Illustrator Georeferencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user search for a building on a map, place converted Illustrator artwork onto it with rotation and a derived scale, and export georeferenced GeoPackage, shapefile and QGIS files.

**Architecture:** The parsed `.ai` is cached server-side once, because parsing costs seconds and the geometry is needed twice. The browser holds a 4-parameter similarity transform and previews it in Web-Mercator metres; the server re-reads the cached GeoPackage, applies the transform with `shapely`, reprojects with `pyproj`, and writes the bundle. The transform maths exists in both Python and TypeScript, pinned together by a shared golden fixture.

**Tech Stack:** FastAPI, geopandas/shapely/pyproj/fiona, stdlib `sqlite3`, React 18 + TypeScript, `react-map-gl/maplibre` with `maplibre-gl` 4.5, Vite, pytest, vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-illustrator-georeferencing-design.md`

## Global Constraints

- Artwork coordinates are PDF points, y-up, bottom-left origin. **No axis flip anywhere.**
- The transform is 4-DOF: translate, rotate, uniform scale. **Never** introduce shear or non-uniform scale.
- `rotation_deg` is CCW from **true north at the anchor**, never from a projection's grid north. The backend subtracts the meridian convergence when flattening to an affine. Measured: getting this wrong puts a 59 m artwork 8 cm out and a 2.4 km site 297 cm out.
- `working_crs` is the metric frame geometry is built in; `output_crs` only changes the written file's CRS. **Never re-fit a transform into a different CRS.**
- `map_anchor` is stored as WGS84 lon/lat, never as projected coordinates.
- Japan Plane Rectangular CS I–XIX under JGD2011 is EPSG:6669–6687, in that order.
- `metres_per_point` for a 1:N drawing is exactly `(25.4 / 72) * N / 1000`.
- JPR CRSs declare axis order X=north, Y=east. **Every** `pyproj.Transformer` here MUST pass `always_xy=True`.
- Add no frontend dependencies. Use Web-Mercator maths directly; `proj4` is not installed and must not be.
- `POST /api/convert/illustrator` keeps working unchanged.
- New pytest marker `georef`. Backend: `pytest backend/tests/<file>.py::<test> -v`. Frontend: `cd frontend && npx vitest run <path>`.
- Frontend tests use `globals: true` — call `test`/`expect` without importing, as in `frontend/src/components/wizard/HoursEditor.test.tsx`.
- UI strings are bilingual: `const { t } = useUiLanguage()` then `t("English", "日本語")`.
- UI primitives come from `../components/ui` (`Button`, `Card`, `Badge`).

---

## File Structure

**Backend — create**

| File | Responsibility |
|---|---|
| `backend/src/illustrator_georeference.py` | `SimilarityTransform`, affine flattening, Helmert fit, residuals, JPR zone tables, projection helpers. Pure, no I/O. |
| `backend/src/illustrator_store.py` | TTL- and count-capped disk cache of parsed conversions. |
| `backend/src/illustrator_export.py` | Preview payload; apply transform, reproject, write gpkg/shp/qgs into a zip. |
| `backend/src/placements.py` | SQLite-backed named placement CRUD. |

**Backend — modify**

| File | Change |
|---|---|
| `backend/src/illustrator_qgis.py:25-32,127,156` | Replace `_UNKNOWN_SRS` with a CRS-derived block; add `crs` to `build_qgs_project`. |
| `backend/src/illustrator_importer.py:559` | Add public `parse_ai` so the store can cache the parse. |
| `backend/src/schemas.py` | Pydantic models for the new endpoints. |
| `backend/routers/import_router.py` | Preview, export, geocode, placement endpoints. |
| `backend/main.py:64-88,151-154` | App state, new exception handlers, cache prune in the cleanup loop. |
| `pyproject.toml:3-11` | Register the `georef` marker. |
| `.env.example`, `.gitignore` | Cache settings; ignore `data/placements.db`. |

**Frontend — create**

| File | Responsibility |
|---|---|
| `frontend/src/lib/similarity.ts` | Transform maths mirroring the Python module. Pure. |
| `frontend/src/hooks/useIllustratorPlacement.ts` | Transform reducer and placement state. |
| `frontend/src/components/shared/basemapStyles.ts` | OSM / GSI aerial / GSI standard styles. |
| `frontend/src/components/illustrator/PlacementMap.tsx` | Map, basemap switcher, artwork overlay. |
| `frontend/src/components/illustrator/TransformHandles.tsx` | Move / rotate / scale gizmo. |
| `frontend/src/components/illustrator/TransformPanel.tsx` | Search, numeric fields, scale lock, calibration. |
| `frontend/src/components/illustrator/ControlPointList.tsx` | Control-point pairs and residuals. |
| `frontend/src/components/illustrator/PlacementLibrary.tsx` | Saved placements. |
| `frontend/src/pages/IllustratorPage.tsx` | Route: convert, then place and export. |

**Frontend — modify**

| File | Change |
|---|---|
| `frontend/src/App.tsx:17-22` | Add the `/illustrator` route. |
| `frontend/src/api/client.ts:469` | Add preview/export/geocode/placement calls. |
| `frontend/src/pages/UploadPage.tsx:697-750` | Illustrator button navigates instead of downloading. |

---

## Task 1: Similarity transform core

**Files:**
- Create: `backend/src/illustrator_georeference.py`
- Create: `backend/tests/test_illustrator_georeference.py`
- Modify: `pyproject.toml:3-11`

**Interfaces:**
- Consumes: nothing.
- Produces: `SimilarityTransform` (fields `artwork_anchor: tuple[float, float]`, `map_anchor: tuple[float, float]`, `rotation_deg: float`, `metres_per_point: float`, `working_crs: str`) with `to_affine_matrix() -> list[float]`; `project_point(lon, lat, crs) -> tuple[float, float]`; `unproject_point(east, north, crs) -> tuple[float, float]`; `grid_convergence(lon, lat, crs) -> float`; `metres_per_point_for_scale(denominator: float) -> float`; `GeoreferenceError(ValueError)`.

- [ ] **Step 1: Register the pytest marker**

In `pyproject.toml`, add a comma to the `phase6` line and append:

```toml
    "phase6: Polish and edge cases",
    "georef: Illustrator georeferencing (transform, zones, placement)"
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_illustrator_georeference.py`:

```python
"""Similarity transform and zone resolution tests."""

from __future__ import annotations

import math

import pytest
from shapely.affinity import affine_transform
from shapely.geometry import Polygon

from backend.src.illustrator_georeference import (
    GeoreferenceError,
    SimilarityTransform,
    grid_convergence,
    metres_per_point_for_scale,
    project_point,
    unproject_point,
)

# Golden fixture. Mirrored verbatim in frontend/src/lib/similarity.test.ts.
GOLDEN_ARTWORK = [(100.0, 200.0), (400.0, 200.0), (400.0, 350.0), (100.0, 350.0)]
GOLDEN_ANCHOR_LON = 139.700258
GOLDEN_ANCHOR_LAT = 35.690921
GOLDEN_ROTATION = 30.0
GOLDEN_SCALE = 0.176389  # 1:500


def golden_transform() -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=(100.0, 200.0),
        map_anchor=(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT),
        rotation_deg=GOLDEN_ROTATION,
        metres_per_point=GOLDEN_SCALE,
        working_crs="EPSG:6677",
    )


@pytest.mark.georef
def test_scale_from_drawing_denominator() -> None:
    assert metres_per_point_for_scale(500) == pytest.approx(0.1763888888, abs=1e-9)
    assert metres_per_point_for_scale(1) == pytest.approx(0.0003527777, abs=1e-9)


@pytest.mark.georef
def test_scale_rejects_non_positive_denominator() -> None:
    with pytest.raises(GeoreferenceError):
        metres_per_point_for_scale(0)


@pytest.mark.georef
def test_projection_uses_always_xy_easting_first() -> None:
    east, north = project_point(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT, "EPSG:6677")
    # JPR IX origin is 36N 139-50E; Shinjuku is south and west of it.
    assert east == pytest.approx(-12044.0, abs=1.0)
    assert north == pytest.approx(-34282.6, abs=1.0)
    assert abs(east) < abs(north), "easting must come first, not northing"


@pytest.mark.georef
def test_projection_round_trips() -> None:
    east, north = project_point(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT, "EPSG:6677")
    lon, lat = unproject_point(east, north, "EPSG:6677")
    assert lon == pytest.approx(GOLDEN_ANCHOR_LON, abs=1e-9)
    assert lat == pytest.approx(GOLDEN_ANCHOR_LAT, abs=1e-9)


@pytest.mark.georef
def test_artwork_anchor_lands_exactly_on_map_anchor() -> None:
    transform = golden_transform()
    expected = project_point(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT, "EPSG:6677")
    placed = affine_transform(Polygon(GOLDEN_ARTWORK), transform.to_affine_matrix())
    assert math.dist(placed.exterior.coords[0], expected) == pytest.approx(0.0, abs=1e-9)


@pytest.mark.georef
def test_transform_preserves_shape_and_applies_scale() -> None:
    transform = golden_transform()
    art = Polygon(GOLDEN_ARTWORK)
    placed = affine_transform(art, transform.to_affine_matrix())
    edge = math.dist(placed.exterior.coords[0], placed.exterior.coords[1])
    assert edge == pytest.approx(300 * GOLDEN_SCALE, abs=1e-9)
    assert placed.area == pytest.approx(art.area * GOLDEN_SCALE**2, rel=1e-12)


@pytest.mark.georef
def test_grid_convergence_at_tokyo_matches_the_closed_form() -> None:
    gamma = grid_convergence(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT, "EPSG:6677")
    closed_form = -(GOLDEN_ANCHOR_LON - (139 + 50 / 60)) * math.sin(
        math.radians(GOLDEN_ANCHOR_LAT)
    )
    assert gamma == pytest.approx(0.0776, abs=1e-3)
    assert gamma == pytest.approx(closed_form, abs=1e-3)


@pytest.mark.georef
def test_convergence_is_zero_on_the_central_meridian() -> None:
    assert grid_convergence(139 + 50 / 60, 35.0, "EPSG:6677") == pytest.approx(0.0, abs=1e-9)


@pytest.mark.georef
def test_matrix_rotation_is_true_north_minus_convergence() -> None:
    """The matrix lives in grid space, so it carries theta - gamma, not theta."""
    a, _b, d, _e, _x, _y = golden_transform().to_affine_matrix()
    gamma = grid_convergence(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT, "EPSG:6677")
    assert math.degrees(math.atan2(d, a)) == pytest.approx(GOLDEN_ROTATION - gamma, abs=1e-9)


@pytest.mark.georef
def test_zero_rotation_points_artwork_y_at_true_north() -> None:
    """Artwork +y must reach a point due north of the anchor, not grid north."""
    transform = golden_transform()
    transform.rotation_deg = 0.0
    matrix = transform.to_affine_matrix()
    tip = (
        matrix[0] * 100.0 + matrix[1] * 350.0 + matrix[4],
        matrix[2] * 100.0 + matrix[3] * 350.0 + matrix[5],
    )
    lon, lat = unproject_point(*tip, "EPSG:6677")
    assert lon == pytest.approx(GOLDEN_ANCHOR_LON, abs=1e-7)
    assert lat > GOLDEN_ANCHOR_LAT


@pytest.mark.georef
def test_shape_is_rigid_under_rotation() -> None:
    """Rotation must not distort: every edge length is preserved."""
    def edges(degrees: float) -> list[float]:
        transform = golden_transform()
        transform.rotation_deg = degrees
        placed = affine_transform(Polygon(GOLDEN_ARTWORK), transform.to_affine_matrix())
        coords = list(placed.exterior.coords)
        return [math.dist(coords[i], coords[i + 1]) for i in range(len(coords) - 1)]

    for a, b in zip(edges(0.0), edges(73.25)):
        assert a == pytest.approx(b, abs=1e-9)


@pytest.mark.georef
def test_non_positive_scale_is_rejected() -> None:
    transform = golden_transform()
    transform.metres_per_point = 0.0
    with pytest.raises(GeoreferenceError):
        transform.to_affine_matrix()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_georeference.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.src.illustrator_georeference'`

- [ ] **Step 4: Write the implementation**

Create `backend/src/illustrator_georeference.py`:

```python
"""Similarity georeferencing for Illustrator artwork.

Artwork coordinates are PDF points, y-up from a bottom-left origin, so no axis
flip is needed anywhere in this module.

A placement is a 4-DOF similarity transform stored relative to an anchor the
user can see: rotation pivots about that anchor and changing the scale does not
translate the drawing. ``map_anchor`` is WGS84 lon/lat so a saved placement
survives a change of output CRS; ``working_crs`` is the metric frame that
``rotation_deg`` is measured in and is fixed for the life of a placement.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

from pyproj import Transformer

MM_PER_INCH = 25.4
POINTS_PER_INCH = 72.0


class GeoreferenceError(ValueError):
    """Raised when a placement cannot be computed from the given inputs."""


@lru_cache(maxsize=64)
def _transformer(source: str, target: str) -> Transformer:
    # always_xy is mandatory: JPR CRSs declare X=north, Y=east, so the default
    # authority-compliant order would silently swap easting and northing.
    return Transformer.from_crs(source, target, always_xy=True)


def project_point(lon: float, lat: float, crs: str) -> tuple[float, float]:
    """WGS84 lon/lat to ``(easting, northing)`` in ``crs``."""
    east, north = _transformer("EPSG:4326", crs).transform(lon, lat)
    return float(east), float(north)


def unproject_point(east: float, north: float, crs: str) -> tuple[float, float]:
    """``(easting, northing)`` in ``crs`` back to WGS84 ``(lon, lat)``."""
    lon, lat = _transformer(crs, "EPSG:4326").transform(east, north)
    return float(lon), float(lat)


def grid_convergence(lon: float, lat: float, crs: str) -> float:
    """Degrees CCW from ``crs`` grid north to true north at this point.

    Measured rather than approximated by ``(lon - lon0) * sin(lat)``, so it is
    correct for any projected CRS, not only a transverse Mercator zone.
    """
    east0, north0 = project_point(lon, lat, crs)
    east1, north1 = project_point(lon, lat + 0.0005, crs)
    return math.degrees(math.atan2(east1 - east0, north1 - north0))


def metres_per_point_for_scale(denominator: float) -> float:
    """Ground metres per PDF point for a ``1:denominator`` drawing."""
    if denominator <= 0:
        raise GeoreferenceError("Drawing scale denominator must be positive.")
    return (MM_PER_INCH / POINTS_PER_INCH) * denominator / 1000.0


@dataclass(slots=True)
class SimilarityTransform:
    """Translate, rotate and uniformly scale artwork points onto the ground."""

    artwork_anchor: tuple[float, float]
    map_anchor: tuple[float, float]
    rotation_deg: float
    metres_per_point: float
    working_crs: str

    def to_affine_matrix(self) -> list[float]:
        """Coefficients for ``shapely.affinity.affine_transform``.

        ``rotation_deg`` is measured from true north, but the matrix operates in
        ``working_crs`` grid space, so the meridian convergence is subtracted
        here. Skipping it is a silent error: 8 cm across a 59 m artwork, ~3 m
        across a 2.4 km site.
        """
        if self.metres_per_point <= 0:
            raise GeoreferenceError("metres_per_point must be positive.")
        lon, lat = self.map_anchor
        theta = math.radians(
            self.rotation_deg - grid_convergence(lon, lat, self.working_crs)
        )
        scale = self.metres_per_point
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        a, b = scale * cos_t, -scale * sin_t
        d, e = scale * sin_t, scale * cos_t
        x0, y0 = self.artwork_anchor
        east, north = project_point(lon, lat, self.working_crs)
        return [a, b, d, e, east - (a * x0 + b * y0), north - (d * x0 + e * y0)]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_georeference.py -v`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml backend/src/illustrator_georeference.py backend/tests/test_illustrator_georeference.py
git commit -m "feat: similarity transform core for Illustrator georeferencing"
```

---
## Task 2: Helmert control-point fit

**Files:**
- Modify: `backend/src/illustrator_georeference.py`
- Modify: `backend/tests/test_illustrator_georeference.py`

**Interfaces:**
- Consumes: `SimilarityTransform`, `project_point`, `unproject_point`, `GeoreferenceError` from Task 1.
- Produces: `fit_helmert(artwork_points, map_points, working_crs, fixed_metres_per_point=None) -> SimilarityTransform`; `residuals(transform, artwork_points, map_points) -> tuple[list[float], float]`. `artwork_points` are PDF points; `map_points` are WGS84 `(lon, lat)`. Both need at least two pairs — the "one control point plus the current anchor" case is handled by the caller supplying the anchor as the second pair.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_illustrator_georeference.py`:

```python
from backend.src.illustrator_georeference import fit_helmert, residuals


def _synthesise_pairs(rotation_deg: float, scale: float) -> tuple[list, list]:
    """Artwork points, and the WGS84 points a known transform maps them to."""
    truth = SimilarityTransform(
        artwork_anchor=(0.0, 0.0),
        map_anchor=(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT),
        rotation_deg=rotation_deg,
        metres_per_point=scale,
        working_crs="EPSG:6677",
    )
    matrix = truth.to_affine_matrix()
    artwork = [(0.0, 0.0), (500.0, 0.0), (500.0, 300.0)]
    mapped = []
    for x, y in artwork:
        east = matrix[0] * x + matrix[1] * y + matrix[4]
        north = matrix[2] * x + matrix[3] * y + matrix[5]
        mapped.append(unproject_point(east, north, "EPSG:6677"))
    return artwork, mapped


@pytest.mark.georef
def test_helmert_recovers_known_rotation_and_scale() -> None:
    artwork, mapped = _synthesise_pairs(rotation_deg=42.5, scale=0.25)
    fitted = fit_helmert(artwork, mapped, "EPSG:6677")
    assert fitted.rotation_deg == pytest.approx(42.5, abs=1e-6)
    assert fitted.metres_per_point == pytest.approx(0.25, abs=1e-9)


@pytest.mark.georef
def test_helmert_with_locked_scale_solves_rotation_only() -> None:
    artwork, mapped = _synthesise_pairs(rotation_deg=-17.25, scale=0.176389)
    fitted = fit_helmert(artwork, mapped, "EPSG:6677", fixed_metres_per_point=0.176389)
    assert fitted.metres_per_point == 0.176389
    assert fitted.rotation_deg == pytest.approx(-17.25, abs=1e-6)


@pytest.mark.georef
def test_helmert_normalises_rotation_into_180_range() -> None:
    artwork, mapped = _synthesise_pairs(rotation_deg=200.0, scale=0.2)
    fitted = fit_helmert(artwork, mapped, "EPSG:6677")
    assert -180.0 < fitted.rotation_deg <= 180.0
    assert fitted.rotation_deg == pytest.approx(-160.0, abs=1e-6)


@pytest.mark.georef
def test_residuals_are_zero_for_an_exact_fit() -> None:
    artwork, mapped = _synthesise_pairs(rotation_deg=10.0, scale=0.3)
    fitted = fit_helmert(artwork, mapped, "EPSG:6677")
    per_point, rmse = residuals(fitted, artwork, mapped)
    assert len(per_point) == 3
    assert rmse == pytest.approx(0.0, abs=1e-6)


@pytest.mark.georef
def test_residuals_expose_a_mistyped_control_point() -> None:
    artwork, mapped = _synthesise_pairs(rotation_deg=10.0, scale=0.3)
    bad = list(mapped)
    bad[2] = (bad[2][0] + 0.001, bad[2][1])  # roughly 90 m east
    fitted = fit_helmert(artwork, bad, "EPSG:6677")
    per_point, rmse = residuals(fitted, artwork, bad)
    assert rmse > 1.0
    assert max(per_point) > 1.0


@pytest.mark.georef
def test_helmert_requires_two_pairs() -> None:
    with pytest.raises(GeoreferenceError):
        fit_helmert([(0.0, 0.0)], [(139.7, 35.7)], "EPSG:6677")


@pytest.mark.georef
def test_helmert_rejects_mismatched_pair_counts() -> None:
    with pytest.raises(GeoreferenceError):
        fit_helmert([(0.0, 0.0), (1.0, 1.0)], [(139.7, 35.7)], "EPSG:6677")


@pytest.mark.georef
def test_helmert_rejects_coincident_artwork_points() -> None:
    with pytest.raises(GeoreferenceError):
        fit_helmert(
            [(10.0, 10.0), (10.0, 10.0)],
            [(139.70, 35.69), (139.71, 35.69)],
            "EPSG:6677",
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_georeference.py -m georef -v`
Expected: FAIL — `ImportError: cannot import name 'fit_helmert'`

- [ ] **Step 3: Write the implementation**

Append to `backend/src/illustrator_georeference.py`:

```python
def _validate_pairs(
    artwork_points: list[tuple[float, float]],
    map_points: list[tuple[float, float]],
) -> None:
    if len(artwork_points) != len(map_points):
        raise GeoreferenceError("Each control point needs both an artwork and a map position.")
    if len(artwork_points) < 2:
        raise GeoreferenceError("At least two control points are required.")


def fit_helmert(
    artwork_points: list[tuple[float, float]],
    map_points: list[tuple[float, float]],
    working_crs: str,
    fixed_metres_per_point: float | None = None,
) -> SimilarityTransform:
    """Least-squares 4-parameter Helmert fit, or 3-parameter when scale is locked.

    Closed form in the complex plane: with artwork points ``p`` and target
    points ``q`` taken about their centroids, ``s*exp(i*theta)`` equals
    ``sum(q * conj(p)) / sum(|p|^2)``. Locking the scale reduces this to the
    argument of the numerator alone, which is better conditioned.
    """
    _validate_pairs(artwork_points, map_points)

    projected = [project_point(lon, lat, working_crs) for lon, lat in map_points]
    p_bar = complex(
        sum(x for x, _ in artwork_points) / len(artwork_points),
        sum(y for _, y in artwork_points) / len(artwork_points),
    )
    q_bar = complex(
        sum(e for e, _ in projected) / len(projected),
        sum(n for _, n in projected) / len(projected),
    )
    p = [complex(x, y) - p_bar for x, y in artwork_points]
    q = [complex(e, n) - q_bar for e, n in projected]

    denominator = sum(abs(value) ** 2 for value in p)
    if denominator <= 0:
        raise GeoreferenceError("Control points in the artwork must not all be the same point.")

    numerator = sum(qi * pi.conjugate() for qi, pi in zip(q, p))
    if numerator == 0:
        raise GeoreferenceError("Control points on the map must not all be the same point.")

    grid_rotation = math.degrees(math.atan2(numerator.imag, numerator.real))
    scale = (
        fixed_metres_per_point
        if fixed_metres_per_point is not None
        else abs(numerator) / denominator
    )
    if scale <= 0:
        raise GeoreferenceError("Fitted scale must be positive.")

    anchor_lon, anchor_lat = unproject_point(q_bar.real, q_bar.imag, working_crs)
    # The fit ran in grid space; SimilarityTransform stores true-north rotation.
    rotation = grid_rotation + grid_convergence(anchor_lon, anchor_lat, working_crs)
    return SimilarityTransform(
        artwork_anchor=(p_bar.real, p_bar.imag),
        map_anchor=(anchor_lon, anchor_lat),
        rotation_deg=(rotation + 180.0) % 360.0 - 180.0,
        metres_per_point=scale,
        working_crs=working_crs,
    )


def residuals(
    transform: SimilarityTransform,
    artwork_points: list[tuple[float, float]],
    map_points: list[tuple[float, float]],
) -> tuple[list[float], float]:
    """Per-point misfit in metres, and their RMSE."""
    _validate_pairs(artwork_points, map_points)
    a, b, d, e, xoff, yoff = transform.to_affine_matrix()
    distances: list[float] = []
    for (x, y), (lon, lat) in zip(artwork_points, map_points):
        east, north = project_point(lon, lat, transform.working_crs)
        distances.append(math.dist((a * x + b * y + xoff, d * x + e * y + yoff), (east, north)))
    rmse = math.sqrt(sum(value**2 for value in distances) / len(distances))
    return distances, rmse
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_georeference.py -m georef -v`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/illustrator_georeference.py backend/tests/test_illustrator_georeference.py
git commit -m "feat: Helmert control-point fit with residual reporting"
```

---

## Task 3: Japan Plane Rectangular zone resolution

**Files:**
- Modify: `backend/src/illustrator_georeference.py`
- Modify: `backend/tests/test_illustrator_georeference.py`

**Interfaces:**
- Consumes: `project_point`, `GeoreferenceError` from Task 1.
- Produces: `JPR_ZONES: tuple[str, ...]`; `ZONE_ORIGINS: dict[str, tuple[float, float]]` mapping Roman numeral to `(lat0, lon0)`; `PREFECTURE_ZONES: dict[str, tuple[str, ...]]` keyed by ISO 3166-2 code; `zone_epsg(roman: str) -> int`; `resolve_working_crs(lon, lat, prefecture_code=None) -> str`; `zone_label(crs: str) -> str`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_illustrator_georeference.py`:

```python
from pyproj import CRS

from backend.src.illustrator_georeference import (
    JPR_ZONES,
    PREFECTURE_ZONES,
    ZONE_ORIGINS,
    resolve_working_crs,
    zone_epsg,
    zone_label,
)


@pytest.mark.georef
def test_zone_epsg_codes_span_6669_to_6687_in_order() -> None:
    assert len(JPR_ZONES) == 19
    assert [zone_epsg(z) for z in JPR_ZONES] == list(range(6669, 6688))


@pytest.mark.georef
@pytest.mark.parametrize("roman", JPR_ZONES)
def test_hardcoded_zone_origins_match_pyproj(roman: str) -> None:
    """The origin table is law, but pin it so a typo cannot slip through."""
    params = CRS.from_epsg(zone_epsg(roman)).to_dict()
    lat0, lon0 = ZONE_ORIGINS[roman]
    assert params["lat_0"] == pytest.approx(lat0, abs=1e-9)
    assert params["lon_0"] == pytest.approx(lon0, abs=1e-9)


@pytest.mark.georef
def test_prefecture_table_covers_all_47_codes() -> None:
    assert len(PREFECTURE_ZONES) == 47
    assert {f"JP-{n:02d}" for n in range(1, 48)} == set(PREFECTURE_ZONES)


@pytest.mark.georef
@pytest.mark.parametrize(
    ("code", "lon", "lat", "expected"),
    [
        ("JP-13", 139.7671, 35.6812, 6677),   # Tokyo
        ("JP-27", 135.4959, 34.7024, 6674),   # Osaka
        ("JP-23", 136.8816, 35.1709, 6675),   # Nagoya
        ("JP-40", 130.4200, 33.5900, 6670),   # Fukuoka
        ("JP-42", 129.8737, 32.7448, 6669),   # Nagasaki, the sole zone I prefecture
        ("JP-01", 141.3507, 43.0687, 6680),   # Sapporo, Hokkaido zone XII
        ("JP-01", 140.7288, 41.7687, 6679),   # Hakodate, Hokkaido zone XI
        ("JP-47", 127.6792, 26.2124, 6683),   # Naha, Okinawa zone XV
        ("JP-47", 124.1558, 24.3448, 6684),   # Ishigaki, Okinawa zone XVI
    ],
)
def test_prefecture_code_resolves_the_correct_zone(code, lon, lat, expected) -> None:
    assert resolve_working_crs(lon, lat, code) == f"EPSG:{expected}"


@pytest.mark.georef
def test_hakodate_needs_the_prefecture_code_to_be_correct() -> None:
    """Regression guard: geometry alone puts Hakodate in zone X across the strait."""
    assert resolve_working_crs(140.7288, 41.7687, "JP-01") == "EPSG:6679"
    assert resolve_working_crs(140.7288, 41.7687, None) == "EPSG:6678"


@pytest.mark.georef
@pytest.mark.parametrize(
    ("lon", "lat", "expected"),
    [
        (139.7671, 35.6812, 6677),
        (135.4959, 34.7024, 6674),
        (130.4200, 33.5900, 6670),
        (141.3507, 43.0687, 6680),
    ],
)
def test_geometric_fallback_without_a_prefecture_code(lon, lat, expected) -> None:
    assert resolve_working_crs(lon, lat, None) == f"EPSG:{expected}"


@pytest.mark.georef
def test_unknown_prefecture_code_falls_back_to_geometry() -> None:
    assert resolve_working_crs(139.7671, 35.6812, "XX-99") == "EPSG:6677"


@pytest.mark.georef
def test_every_prefecture_capital_sits_inside_its_zone_envelope() -> None:
    """A zone is designed for +/-130 km of easting; a wrong row shows up here."""
    capitals = {
        "JP-02": (140.7400, 40.8244), "JP-03": (141.1527, 39.7036),
        "JP-04": (140.8719, 38.2688), "JP-05": (140.1024, 39.7186),
        "JP-06": (140.3633, 38.2404), "JP-07": (140.4676, 37.7500),
        "JP-08": (140.4468, 36.3418), "JP-09": (139.8836, 36.5658),
        "JP-10": (139.0608, 36.3912), "JP-11": (139.6489, 35.8569),
        "JP-12": (140.1233, 35.6051), "JP-14": (139.6425, 35.4478),
        "JP-15": (139.0232, 37.9026), "JP-16": (137.2113, 36.6953),
        "JP-17": (136.6256, 36.5947), "JP-18": (136.2216, 36.0652),
        "JP-19": (138.5683, 35.6642), "JP-20": (138.1812, 36.6513),
        "JP-21": (136.7222, 35.3912), "JP-22": (138.3831, 34.9769),
        "JP-24": (136.5086, 34.7303), "JP-25": (135.8686, 35.0045),
        "JP-26": (135.7556, 35.0211), "JP-28": (135.1830, 34.6913),
        "JP-29": (135.8328, 34.6851), "JP-30": (135.1675, 34.2261),
        "JP-31": (134.2380, 35.5039), "JP-32": (133.0505, 35.4723),
        "JP-33": (133.9350, 34.6618), "JP-34": (132.4596, 34.3853),
        "JP-35": (131.4714, 34.1859), "JP-36": (134.5594, 34.0658),
        "JP-37": (134.0434, 34.3401), "JP-38": (132.7657, 33.8416),
        "JP-39": (133.5311, 33.5597), "JP-41": (130.2988, 33.2494),
        "JP-43": (130.7417, 32.7898), "JP-44": (131.6126, 33.2382),
        "JP-45": (131.4239, 31.9077), "JP-46": (130.5581, 31.5602),
    }
    for code, (lon, lat) in capitals.items():
        crs = resolve_working_crs(lon, lat, code)
        east, _north = project_point(lon, lat, crs)
        assert abs(east) < 130_000, f"{code} easting {east:.0f} m in {crs}"


@pytest.mark.georef
def test_zone_label_is_human_readable() -> None:
    assert zone_label("EPSG:6677") == "EPSG:6677 — JPR CS IX"
    assert zone_label("EPSG:4326") == "EPSG:4326"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_georeference.py -m georef -v`
Expected: FAIL — `ImportError: cannot import name 'JPR_ZONES'`

- [ ] **Step 3: Write the implementation**

Append to `backend/src/illustrator_georeference.py`:

```python
# Japan Plane Rectangular CS I-XIX under JGD2011, EPSG:6669-6687 in order.
JPR_ZONES: tuple[str, ...] = (
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
    "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX",
)

# (lat_0, lon_0) per zone, fixed by 測量法施行令 and pinned by test.
ZONE_ORIGINS: dict[str, tuple[float, float]] = {
    "I": (33.0, 129.5), "II": (33.0, 131.0), "III": (36.0, 132.0 + 10 / 60),
    "IV": (33.0, 133.5), "V": (36.0, 134.0 + 20 / 60), "VI": (36.0, 136.0),
    "VII": (36.0, 137.0 + 10 / 60), "VIII": (36.0, 138.5),
    "IX": (36.0, 139.0 + 50 / 60), "X": (40.0, 140.0 + 50 / 60),
    "XI": (44.0, 140.25), "XII": (44.0, 142.25), "XIII": (44.0, 144.25),
    "XIV": (26.0, 142.0), "XV": (26.0, 127.5), "XVI": (26.0, 124.0),
    "XVII": (26.0, 131.0), "XVIII": (20.0, 136.0), "XIX": (26.0, 154.0),
}

# ISO 3166-2:JP code to candidate zones. Forty-three prefectures have exactly
# one. Hokkaido, Tokyo, Okinawa and Kagoshima span several and are narrowed
# geometrically among their own candidates.
PREFECTURE_ZONES: dict[str, tuple[str, ...]] = {
    "JP-01": ("XI", "XII", "XIII"), "JP-02": ("X",), "JP-03": ("X",),
    "JP-04": ("X",), "JP-05": ("X",), "JP-06": ("X",), "JP-07": ("IX",),
    "JP-08": ("IX",), "JP-09": ("IX",), "JP-10": ("IX",), "JP-11": ("IX",),
    "JP-12": ("IX",), "JP-13": ("IX", "XIV", "XVIII", "XIX"), "JP-14": ("IX",),
    "JP-15": ("VIII",), "JP-16": ("VII",), "JP-17": ("VII",), "JP-18": ("VI",),
    "JP-19": ("VIII",), "JP-20": ("VIII",), "JP-21": ("VII",), "JP-22": ("VIII",),
    "JP-23": ("VII",), "JP-24": ("VI",), "JP-25": ("VI",), "JP-26": ("VI",),
    "JP-27": ("VI",), "JP-28": ("V",), "JP-29": ("VI",), "JP-30": ("VI",),
    "JP-31": ("V",), "JP-32": ("III",), "JP-33": ("V",), "JP-34": ("III",),
    "JP-35": ("III",), "JP-36": ("IV",), "JP-37": ("IV",), "JP-38": ("IV",),
    "JP-39": ("IV",), "JP-40": ("II",), "JP-41": ("II",), "JP-42": ("I",),
    "JP-43": ("II",), "JP-44": ("II",), "JP-45": ("II",), "JP-46": ("II", "I"),
    "JP-47": ("XV", "XVI", "XVII"),
}


def zone_epsg(roman: str) -> int:
    """EPSG code for a JPR zone given its Roman numeral."""
    try:
        return 6669 + JPR_ZONES.index(roman)
    except ValueError as exc:
        raise GeoreferenceError(f"Unknown Japan Plane Rectangular zone: {roman}") from exc


def _nearest_zone(lon: float, lat: float, candidates: tuple[str, ...]) -> str:
    def separation(roman: str) -> float:
        lat0, lon0 = ZONE_ORIGINS[roman]
        return math.hypot((lon - lon0) * math.cos(math.radians(lat)), lat - lat0)

    return min(candidates, key=separation)


def resolve_working_crs(lon: float, lat: float, prefecture_code: str | None = None) -> str:
    """Pick the JPR zone for a location.

    Zone membership is defined by prefecture, so an ISO 3166-2 code is
    authoritative and is used whenever one is available. Without one — the
    geocoder is optional — the nearest zone origin is used instead. That is
    right for 20 of 21 reference cities but places Hakodate in zone X rather
    than XI, because zone X's origin is closer across the Tsugaru Strait.
    """
    candidates = PREFECTURE_ZONES.get(prefecture_code or "", JPR_ZONES)
    if len(candidates) == 1:
        return f"EPSG:{zone_epsg(candidates[0])}"
    return f"EPSG:{zone_epsg(_nearest_zone(lon, lat, candidates))}"


def zone_label(crs: str) -> str:
    """``"EPSG:6677 — JPR CS IX"`` for JPR zones, the bare code otherwise."""
    try:
        code = int(crs.split(":")[1])
    except (IndexError, ValueError):
        return crs
    if 6669 <= code <= 6687:
        return f"{crs} — JPR CS {JPR_ZONES[code - 6669]}"
    return crs
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_georeference.py -m georef -v`
Expected: PASS. The parametrised origin test contributes 19 cases.

- [ ] **Step 5: Commit**

```bash
git add backend/src/illustrator_georeference.py backend/tests/test_illustrator_georeference.py
git commit -m "feat: prefecture-driven Japan Plane Rectangular zone resolution"
```

---
## Task 4: QGIS project CRS

**Files:**
- Modify: `backend/src/illustrator_qgis.py:25-32,105-130,150-160`
- Create: `backend/tests/test_illustrator_qgis_crs.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `build_qgs_project(layers, gpkg_filename, project_name, crs: str | None = None) -> str`. With `crs=None` the output is identical to today's, so the existing ungeoreferenced endpoint is unaffected.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_illustrator_qgis_crs.py`:

```python
"""The generated QGIS project must declare the export CRS."""

from __future__ import annotations

from xml.etree import ElementTree

import pytest

from backend.src.illustrator_qgis import QgisLayerSpec, build_qgs_project

LAYERS = [QgisLayerSpec(table="floor", display_name="Floor", role="polygon")]


@pytest.mark.georef
def test_project_without_crs_is_unchanged() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a")
    assert "<authid></authid>" in xml
    assert "<srid>0</srid>" in xml


@pytest.mark.georef
def test_project_declares_the_requested_authority_code() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a", crs="EPSG:6677")
    assert "<authid>EPSG:6677</authid>" in xml
    assert "<srid>6677</srid>" in xml
    assert "<geographicflag>false</geographicflag>" in xml


@pytest.mark.georef
def test_geographic_crs_sets_the_geographic_flag() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a", crs="EPSG:4326")
    assert "<authid>EPSG:4326</authid>" in xml
    assert "<geographicflag>true</geographicflag>" in xml


@pytest.mark.georef
def test_both_project_and_layer_carry_the_crs_and_xml_parses() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a", crs="EPSG:6677")
    assert xml.count("<authid>EPSG:6677</authid>") >= 2
    assert ElementTree.fromstring(xml).tag == "qgis"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_qgis_crs.py -v`
Expected: FAIL — `TypeError: build_qgs_project() got an unexpected keyword argument 'crs'`

- [ ] **Step 3: Add the SRS builder**

In `backend/src/illustrator_qgis.py`, directly after the `_UNKNOWN_SRS` constant (it currently ends at line 32), add:

```python
def _srs_xml(crs: str | None) -> str:
    """A QGIS ``<spatialrefsys>`` block for ``crs``, or the unknown-CRS block."""
    if not crs:
        return _UNKNOWN_SRS

    from pyproj import CRS as _PyprojCRS  # local import keeps module import cheap

    parsed = _PyprojCRS.from_user_input(crs)
    authority = parsed.to_authority()
    authid = f"{authority[0]}:{authority[1]}" if authority else crs
    srid = authority[1] if authority else "0"
    return (
        '<spatialrefsys nativeFormat="Wkt">'
        f"<wkt>{escape(parsed.to_wkt())}</wkt><proj4>{escape(parsed.to_proj4())}</proj4>"
        f"<srsid>{escape(str(srid))}</srsid><srid>{escape(str(srid))}</srid>"
        f"<authid>{escape(authid)}</authid>"
        f"<description>{escape(parsed.name)}</description>"
        "<projectionacronym></projectionacronym><ellipsoidacronym></ellipsoidacronym>"
        f"<geographicflag>{'true' if parsed.is_geographic else 'false'}</geographicflag>"
        "</spatialrefsys>"
    )
```

`escape` is already imported in this module — it is used at line 125.

- [ ] **Step 4: Thread the parameter through**

Give the layer-XML helper a new final parameter `srs_xml: str`, and at line 127 replace

```python
        f"<srs>{_UNKNOWN_SRS}</srs>"
```

with

```python
        f"<srs>{srs_xml}</srs>"
```

At line 156 replace

```python
        f"<projectCrs>{_UNKNOWN_SRS}</projectCrs>"
```

with

```python
        f"<projectCrs>{srs_xml}</projectCrs>"
```

Add `crs: str | None = None` as the final keyword parameter of `build_qgs_project`, compute `srs_xml = _srs_xml(crs)` as its first statement, and pass `srs_xml` into the layer helper at its call site.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_qgis_crs.py backend/tests/test_illustrator_import.py -v`
Expected: PASS. The pre-existing illustrator tests must still pass, which is what proves the `crs=None` path is untouched.

- [ ] **Step 6: Commit**

```bash
git add backend/src/illustrator_qgis.py backend/tests/test_illustrator_qgis_crs.py
git commit -m "feat: declare a real CRS in generated QGIS projects"
```

---

## Task 5: Cached conversion store

**Files:**
- Create: `backend/src/illustrator_store.py`
- Create: `backend/tests/test_illustrator_store.py`
- Modify: `backend/src/illustrator_importer.py` (append after line 559)

**Interfaces:**
- Consumes: `_ConversionResult` from `illustrator_importer`.
- Produces: `parse_ai(ai_bytes: bytes, source_name: str) -> _ConversionResult`; `ConversionExpiredError(Exception)`; `CachedConversion` (fields `conversion_id: str`, `directory: Path`, `stem: str`, `written_layers: list[dict[str, str]]`, `layer_order: list[str]`, `report: dict`, `created_at: float`, property `gpkg_path: Path`); `ConversionStore(root: Path, ttl_seconds: float, max_entries: int)` with `put(result) -> CachedConversion`, `get(conversion_id) -> CachedConversion`, `prune() -> int`.

- [ ] **Step 1: Expose the parser**

Append to `backend/src/illustrator_importer.py`:

```python
def parse_ai(ai_bytes: bytes, source_name: str) -> _ConversionResult:
    """Parse an ``.ai``/PDF into vector layers without georeferencing it.

    Exposed so :mod:`backend.src.illustrator_store` can cache the expensive
    parse and reuse it for both preview and export.
    """
    return _convert(ai_bytes, source_name)
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/test_illustrator_store.py`:

```python
"""Cached-conversion store tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import ConversionExpiredError, ConversionStore
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf


@pytest.fixture()
def store(tmp_path: Path) -> ConversionStore:
    return ConversionStore(root=tmp_path, ttl_seconds=3600, max_entries=3)


@pytest.mark.georef
def test_put_then_get_round_trips_a_conversion(store: ConversionStore) -> None:
    result = parse_ai(_build_minimal_ai_pdf(), "sample.ai")
    cached = store.put(result)

    fetched = store.get(cached.conversion_id)
    assert fetched.stem == "sample"
    assert fetched.gpkg_path.exists()
    assert fetched.gpkg_path.read_bytes() == result.gpkg_bytes
    assert fetched.written_layers == result.written_layers
    assert fetched.report["total_features"] == result.report.total_features


@pytest.mark.georef
def test_unknown_id_raises_expired(store: ConversionStore) -> None:
    with pytest.raises(ConversionExpiredError):
        store.get("does-not-exist")


@pytest.mark.georef
def test_expired_entry_raises_and_is_removed(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=-1, max_entries=3)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    with pytest.raises(ConversionExpiredError):
        store.get(cached.conversion_id)
    assert not cached.directory.exists()


@pytest.mark.georef
def test_oldest_entries_are_evicted_beyond_the_cap(store: ConversionStore) -> None:
    payload = _build_minimal_ai_pdf()
    first = store.put(parse_ai(payload, "one.ai"))
    for name in ("two.ai", "three.ai", "four.ai"):
        store.put(parse_ai(payload, name))

    with pytest.raises(ConversionExpiredError):
        store.get(first.conversion_id)
    assert not first.directory.exists()


@pytest.mark.georef
def test_prune_reports_how_many_it_removed(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=-1, max_entries=10)
    payload = _build_minimal_ai_pdf()
    store.put(parse_ai(payload, "one.ai"))
    store.put(parse_ai(payload, "two.ai"))
    assert store.prune() == 2
    assert store.prune() == 0
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.src.illustrator_store'`

- [ ] **Step 4: Write the implementation**

Create `backend/src/illustrator_store.py`:

```python
"""Disk cache of parsed Illustrator conversions.

Parsing a station-sized ``.ai`` costs seconds, and the georeferencing flow needs
the same geometry twice: once to preview, once to export. Each entry is a
directory holding the untransformed GeoPackage plus the metadata needed to
rebuild the bundle, expired by age and capped by count.

Deliberately not built on ``SessionManager``: that store is shaped around IMDF
``SessionRecord`` objects, and a conversion is an unrelated bag of coloured
paths with no IMDF semantics.
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from backend.src.illustrator_importer import _ConversionResult

_META_NAME = "conversion.json"
_GPKG_NAME = "artwork.gpkg"


class ConversionExpiredError(Exception):
    """Raised when a conversion id is unknown or has aged out of the cache."""


@dataclass(slots=True)
class CachedConversion:
    conversion_id: str
    directory: Path
    stem: str
    written_layers: list[dict[str, str]]
    layer_order: list[str]
    report: dict
    created_at: float

    @property
    def gpkg_path(self) -> Path:
        return self.directory / _GPKG_NAME


class ConversionStore:
    """TTL- and count-capped store of parsed conversions."""

    def __init__(self, root: Path, ttl_seconds: float, max_entries: int) -> None:
        self.root = Path(root)
        self.ttl_seconds = float(ttl_seconds)
        self.max_entries = int(max_entries)
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, result: _ConversionResult) -> CachedConversion:
        conversion_id = uuid4().hex
        directory = self.root / conversion_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / _GPKG_NAME).write_bytes(result.gpkg_bytes)

        cached = CachedConversion(
            conversion_id=conversion_id,
            directory=directory,
            stem=result.stem,
            written_layers=result.written_layers,
            layer_order=result.layer_order,
            report=result.report.to_dict(),
            created_at=time.time(),
        )
        (directory / _META_NAME).write_text(
            json.dumps(
                {
                    "conversion_id": cached.conversion_id,
                    "stem": cached.stem,
                    "written_layers": cached.written_layers,
                    "layer_order": cached.layer_order,
                    "report": cached.report,
                    "created_at": cached.created_at,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self._enforce_cap()
        return cached

    def get(self, conversion_id: str) -> CachedConversion:
        directory = self.root / conversion_id
        meta_path = directory / _META_NAME
        if not meta_path.is_file():
            raise ConversionExpiredError(
                "That conversion is no longer available. Convert the file again."
            )
        cached = self._load(meta_path)
        if self._is_expired(cached):
            self._discard(directory)
            raise ConversionExpiredError("That conversion has expired. Convert the file again.")
        return cached

    def prune(self) -> int:
        removed = 0
        for meta_path in self.root.glob(f"*/{_META_NAME}"):
            try:
                cached = self._load(meta_path)
            except (OSError, ValueError, KeyError):
                self._discard(meta_path.parent)
                removed += 1
                continue
            if self._is_expired(cached):
                self._discard(cached.directory)
                removed += 1
        return removed

    def _load(self, meta_path: Path) -> CachedConversion:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
        return CachedConversion(
            conversion_id=payload["conversion_id"],
            directory=meta_path.parent,
            stem=payload["stem"],
            written_layers=payload["written_layers"],
            layer_order=payload["layer_order"],
            report=payload["report"],
            created_at=float(payload["created_at"]),
        )

    def _is_expired(self, cached: CachedConversion) -> bool:
        return (time.time() - cached.created_at) > self.ttl_seconds

    def _enforce_cap(self) -> None:
        entries = []
        for meta_path in self.root.glob(f"*/{_META_NAME}"):
            try:
                entries.append(self._load(meta_path))
            except (OSError, ValueError, KeyError):
                self._discard(meta_path.parent)
        surplus = len(entries) - self.max_entries
        if surplus <= 0:
            return
        for cached in sorted(entries, key=lambda item: item.created_at)[:surplus]:
            self._discard(cached.directory)

    @staticmethod
    def _discard(directory: Path) -> None:
        shutil.rmtree(directory, ignore_errors=True)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_store.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/illustrator_store.py backend/src/illustrator_importer.py backend/tests/test_illustrator_store.py
git commit -m "feat: TTL-capped cache of parsed Illustrator conversions"
```

---
## Task 6: Preview payload and georeferenced export

**Files:**
- Create: `backend/src/illustrator_export.py`
- Create: `backend/tests/test_illustrator_export.py`

**Interfaces:**
- Consumes: `CachedConversion` (Task 5); `SimilarityTransform` (Task 1); `build_qgs_project` with `crs` (Task 4); `_order_layers` from `illustrator_importer`.
- Produces: `build_preview(cached, tolerance_divisor: float = 2000.0) -> dict` returning keys `artwork_bounds`, `preview`, `preview_features`, `total_features`, `layers`; `ExportFormats` dataclass (`geopackage: bool = True`, `shapefile: bool = True`, `qgis: bool = True`); `build_georeferenced_bundle(cached, transform, output_crs: str, formats: ExportFormats) -> tuple[bytes, str]`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_illustrator_export.py`:

```python
"""Preview construction and georeferenced export."""

from __future__ import annotations

import io
import math
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest

from backend.src.illustrator_export import (
    ExportFormats,
    build_georeferenced_bundle,
    build_preview,
)
from backend.src.illustrator_georeference import SimilarityTransform, project_point
from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import ConversionStore
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf

ANCHOR_LON = 139.700258
ANCHOR_LAT = 35.690921


@pytest.fixture()
def cached(tmp_path: Path):
    store = ConversionStore(root=tmp_path, ttl_seconds=3600, max_entries=5)
    return store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))


def _transform(cached) -> SimilarityTransform:
    bounds = build_preview(cached)["artwork_bounds"]
    return SimilarityTransform(
        artwork_anchor=((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2),
        map_anchor=(ANCHOR_LON, ANCHOR_LAT),
        rotation_deg=0.0,
        metres_per_point=0.176389,
        working_crs="EPSG:6677",
    )


def _iter_coords(geometry):
    def walk(node):
        if isinstance(node, (list, tuple)):
            if node and isinstance(node[0], (int, float)):
                yield float(node[0]), float(node[1])
            else:
                for child in node:
                    yield from walk(child)

    yield from walk(geometry["coordinates"])


def _extract(payload: bytes, suffix: str, destination: Path) -> Path:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        name = next(n for n in archive.namelist() if n.endswith(suffix))
        destination.write_bytes(archive.read(name))
    return destination


@pytest.mark.georef
def test_preview_reports_bounds_and_counts(cached) -> None:
    preview = build_preview(cached)
    minx, miny, maxx, maxy = preview["artwork_bounds"]
    assert maxx > minx and maxy > miny
    assert preview["total_features"] >= 1
    assert preview["preview_features"] <= preview["total_features"]
    assert preview["preview"]["type"] == "FeatureCollection"


@pytest.mark.georef
def test_preview_features_carry_layer_and_colour_properties(cached) -> None:
    feature = build_preview(cached)["preview"]["features"][0]
    assert set(feature["properties"]) >= {"ai_layer", "role", "fill_color", "stroke_color"}


@pytest.mark.georef
def test_preview_coordinates_stay_in_artwork_points(cached) -> None:
    preview = build_preview(cached)
    minx, miny, maxx, maxy = preview["artwork_bounds"]
    for feature in preview["preview"]["features"]:
        for x, y in _iter_coords(feature["geometry"]):
            assert minx - 1 <= x <= maxx + 1
            assert miny - 1 <= y <= maxy + 1


@pytest.mark.georef
def test_preview_layer_summaries_match_the_written_tables(cached) -> None:
    summaries = build_preview(cached)["layers"]
    assert {s["table"] for s in summaries} == {s["table"] for s in cached.written_layers}
    assert all(s["feature_count"] >= 0 for s in summaries)


@pytest.mark.georef
def test_export_places_the_anchor_at_the_requested_location(cached, tmp_path: Path) -> None:
    payload, filename = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:6677", ExportFormats()
    )
    assert filename.endswith(".zip")

    gpkg = _extract(payload, ".gpkg", tmp_path / "out.gpkg")
    gdf = gpd.read_file(gpkg, layer=cached.written_layers[0]["table"])
    expected = project_point(ANCHOR_LON, ANCHOR_LAT, "EPSG:6677")
    minx, miny, maxx, maxy = gdf.total_bounds
    assert math.dist(((minx + maxx) / 2, (miny + maxy) / 2), expected) < 1.0
    assert gdf.crs.to_epsg() == 6677


@pytest.mark.georef
def test_export_contains_every_requested_format(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:6677", ExportFormats()
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert any(n.endswith(".qgs") for n in names)
    for suffix in (".shp", ".prj", ".dbf", ".shx"):
        assert any(n.endswith(suffix) for n in names), suffix


@pytest.mark.georef
def test_export_honours_format_selection(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        _transform(cached),
        "EPSG:6677",
        ExportFormats(geopackage=True, shapefile=False, qgis=False),
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert not any(n.endswith(".shp") for n in names)
    assert not any(n.endswith(".qgs") for n in names)


@pytest.mark.georef
def test_prj_declares_the_output_crs(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:4326", ExportFormats()
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        prj = next(n for n in archive.namelist() if n.endswith(".prj"))
        text = archive.read(prj).decode("utf-8", "replace")
    assert "WGS" in text.upper() or "4326" in text


@pytest.mark.georef
def test_reprojection_to_4326_yields_plausible_lonlat(cached, tmp_path: Path) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:4326", ExportFormats(shapefile=False, qgis=False)
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "reproj.gpkg")
    gdf = gpd.read_file(gpkg, layer=cached.written_layers[0]["table"])
    minx, miny, maxx, maxy = gdf.total_bounds
    assert 139.6 < (minx + maxx) / 2 < 139.8
    assert 35.6 < (miny + maxy) / 2 < 35.8


@pytest.mark.georef
def test_rotation_changes_the_footprint_but_not_its_area(cached, tmp_path: Path) -> None:
    upright = _transform(cached)
    turned = _transform(cached)
    turned.rotation_deg = 45.0

    areas = []
    for index, transform in enumerate((upright, turned)):
        payload, _ = build_georeferenced_bundle(
            cached, transform, "EPSG:6677", ExportFormats(shapefile=False, qgis=False)
        )
        gpkg = _extract(payload, ".gpkg", tmp_path / f"rot{index}.gpkg")
        gdf = gpd.read_file(gpkg, layer=cached.written_layers[0]["table"])
        areas.append(float(gdf.geometry.area.sum()))
    assert areas[0] == pytest.approx(areas[1], rel=1e-9)


@pytest.mark.georef
def test_export_rejects_a_non_positive_scale(cached) -> None:
    transform = _transform(cached)
    transform.metres_per_point = 0.0
    with pytest.raises(ValueError):
        build_georeferenced_bundle(cached, transform, "EPSG:6677", ExportFormats())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_illustrator_export.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.src.illustrator_export'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/illustrator_export.py`:

```python
"""Preview payloads and georeferenced export bundles.

Preview geometry stays in artwork points and is decimated so dragging a
station-sized plan is responsive; export re-reads the same cached GeoPackage at
full fidelity, applies the placement and reprojects to the requested CRS.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import geopandas as gpd

from backend.src.illustrator_georeference import SimilarityTransform
from backend.src.illustrator_importer import _order_layers
from backend.src.illustrator_qgis import build_qgs_project
from backend.src.illustrator_store import CachedConversion

_PREVIEW_TOLERANCE_DIVISOR = 2000.0


@dataclass(slots=True)
class ExportFormats:
    geopackage: bool = True
    shapefile: bool = True
    qgis: bool = True


def _read_layers(cached: CachedConversion) -> list[tuple[dict[str, str], gpd.GeoDataFrame]]:
    return [
        (spec, gpd.read_file(cached.gpkg_path, layer=spec["table"]))
        for spec in cached.written_layers
    ]


def _diagonal_of(geometry) -> float:
    if geometry is None or geometry.is_empty:
        return 0.0
    minx, miny, maxx, maxy = geometry.bounds
    return ((maxx - minx) ** 2 + (maxy - miny) ** 2) ** 0.5


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
    for spec, gdf in layers:
        total += len(gdf)
        summaries.append({**spec, "feature_count": int(len(gdf))})
        if gdf.empty:
            continue
        simplified = gdf.copy()
        if tolerance > 0:
            simplified["geometry"] = simplified.geometry.simplify(
                tolerance, preserve_topology=True
            )
            simplified = simplified[simplified.geometry.apply(_diagonal_of) >= tolerance]
        if simplified.empty:
            continue
        features.extend(json.loads(simplified.to_json(na="null"))["features"])

    return {
        "artwork_bounds": [float(value) for value in bounds],
        "preview": {"type": "FeatureCollection", "features": features},
        "preview_features": len(features),
        "total_features": int(total),
        "layers": summaries,
    }


def build_georeferenced_bundle(
    cached: CachedConversion,
    transform: SimilarityTransform,
    output_crs: str,
    formats: ExportFormats,
) -> tuple[bytes, str]:
    """Apply ``transform``, reproject to ``output_crs`` and zip the outputs."""
    matrix = transform.to_affine_matrix()  # raises for a non-positive scale
    stem = cached.stem
    gpkg_name = f"{stem}_georeferenced.gpkg"
    qgs_name = f"{stem}_georeferenced.qgs"

    buffer = BytesIO()
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        gpkg_path = workdir / gpkg_name
        shapefile_dir = workdir / "shapefiles"
        shapefile_dir.mkdir()

        wrote_any = False
        for spec, gdf in _read_layers(cached):
            if gdf.empty:
                continue
            placed = gdf.copy()
            placed["geometry"] = placed.geometry.affine_transform(matrix)
            placed = placed.set_crs(transform.working_crs, allow_override=True)
            if output_crs != transform.working_crs:
                placed = placed.to_crs(output_crs)

            # The QGIS project references the GeoPackage, so it is written
            # whenever either output is requested.
            if formats.geopackage or formats.qgis:
                placed.to_file(gpkg_path, driver="GPKG", layer=spec["table"])
            if formats.shapefile:
                placed.to_file(
                    shapefile_dir / f"{spec['table']}.shp",
                    driver="ESRI Shapefile",
                    index=False,
                    encoding="utf-8",
                )
            wrote_any = True

        if not wrote_any:
            raise ValueError("The cached conversion contains no geometry to export.")

        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            if formats.geopackage:
                archive.write(gpkg_path, gpkg_name)
            if formats.qgis:
                ordered = _order_layers(cached.written_layers, cached.layer_order)
                archive.writestr(
                    qgs_name,
                    build_qgs_project(
                        ordered,
                        gpkg_filename=gpkg_name,
                        project_name=stem,
                        crs=output_crs,
                    ).encode("utf-8"),
                )
            if formats.shapefile:
                for path in sorted(shapefile_dir.iterdir()):
                    archive.write(path, f"shapefiles/{path.name}")

    return buffer.getvalue(), f"{stem}_georeferenced.zip"
```

A QGIS project without its GeoPackage would have a broken datasource, so Task 7 rejects that combination at the API boundary.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_illustrator_export.py -v`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/illustrator_export.py backend/tests/test_illustrator_export.py
git commit -m "feat: decimated preview payload and georeferenced export bundle"
```

---
## Task 7: Preview, export and geocode endpoints

**Files:**
- Modify: `backend/src/schemas.py`, `backend/routers/import_router.py`, `backend/main.py:64-88,151-154`, `.env.example`
- Create: `backend/tests/test_illustrator_api.py`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `POST /api/convert/illustrator/preview`, `POST /api/convert/illustrator/{conversion_id}/export`, `GET /api/geocode`; models `TransformPayload`, `ExportFormatsPayload`, `IllustratorExportRequest`, `IllustratorLayerSummary`, `IllustratorPreviewResponse`, `GeocodeSearchResponse`.

- [ ] **Step 1: Add the schemas**

Append to `backend/src/schemas.py` (ensure `from typing import Any` is imported at the top):

```python
class TransformPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artwork_anchor: list[float] = Field(min_length=2, max_length=2)
    map_anchor: list[float] = Field(min_length=2, max_length=2)
    rotation_deg: float = 0.0
    metres_per_point: float = Field(gt=0)
    working_crs: str


class ExportFormatsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    geopackage: bool = True
    shapefile: bool = True
    qgis: bool = True


class IllustratorExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transform: TransformPayload
    output_crs: str = "EPSG:4326"
    formats: ExportFormatsPayload = Field(default_factory=ExportFormatsPayload)


class IllustratorLayerSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: str
    ai_layer: str
    role: str
    feature_count: int


class IllustratorPreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversion_id: str
    report: dict[str, Any]
    layers: list[IllustratorLayerSummary] = Field(default_factory=list)
    artwork_bounds: list[float]
    preview: dict[str, Any]
    preview_features: int
    total_features: int
    suggested_crs: str
    suggested_crs_label: str


class GeocodeSearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    language: str
    results: list[GeocodeResultItem] = Field(default_factory=list)
```

- [ ] **Step 2: Wire app state, cleanup and the expired handler**

In `backend/main.py`, add beside the existing illustrator import at line 23:

```python
from backend.src.illustrator_store import ConversionExpiredError, ConversionStore
```

Inside `lifespan`, after line 72:

```python
    app.state.illustrator_store = ConversionStore(
        root=Path(os.getenv("TEMP_DATA_DIR", "./data/tmp")) / "illustrator",
        ttl_seconds=float(os.getenv("ILLUSTRATOR_CACHE_TTL_MINUTES", "120")) * 60,
        max_entries=int(os.getenv("ILLUSTRATOR_CACHE_MAX_ENTRIES", "20")),
    )
```

Replace `_session_cleanup_loop` (lines 55-61) so the same hourly tick prunes both stores:

```python
async def _session_cleanup_loop(app: FastAPI, stop: asyncio.Event) -> None:
    while True:
        try:
            await asyncio.wait_for(stop.wait(), timeout=3600)
            break
        except TimeoutError:
            app.state.session_manager.prune_expired()
            app.state.illustrator_store.prune()
```

and update line 82 to `cleanup_task = asyncio.create_task(_session_cleanup_loop(app, stop_event))`.

After the existing illustrator handler (line 154), add:

```python
@app.exception_handler(ConversionExpiredError)
async def conversion_expired_handler(_: Request, exc: ConversionExpiredError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="CONVERSION_EXPIRED")
    return JSONResponse(status_code=404, content=payload.model_dump())
```

- [ ] **Step 3: Add the endpoints**

In `backend/routers/import_router.py`, add imports:

```python
from backend.src.illustrator_export import (
    ExportFormats,
    build_georeferenced_bundle,
    build_preview,
)
from backend.src.illustrator_georeference import (
    SimilarityTransform,
    resolve_working_crs,
    zone_label,
)
from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import ConversionStore
from backend.src.schemas import (
    GeocodeSearchResponse,
    IllustratorExportRequest,
    IllustratorPreviewResponse,
)
```

Add helpers beside `_max_upload_bytes` (line 36):

```python
def _illustrator_store(request: Request) -> ConversionStore:
    return request.app.state.illustrator_store


def _validate_ai_upload(request: Request, file: UploadFile, payload: bytes) -> str:
    """Shared guard for both Illustrator entry points; returns the filename."""
    if not payload:
        raise ValueError("The uploaded file is empty.")
    if len(payload) > _max_upload_bytes(request):
        raise ValueError("Upload exceeds configured limit (MAX_UPLOAD_MB).")
    name = file.filename or "illustrator.ai"
    if not name.lower().endswith((".ai", ".pdf")):
        raise ValueError("Upload an Adobe Illustrator (.ai) or PDF file.")
    if not payload.lstrip()[:5].startswith(b"%PDF"):
        raise ValueError(
            "Not a PDF-based Illustrator file. Re-save the .ai with 'Create PDF Compatible File' enabled."
        )
    return name
```

Then the endpoints:

```python
@router.post("/convert/illustrator/preview", response_model=IllustratorPreviewResponse)
async def preview_illustrator(
    request: Request,
    file: Annotated[UploadFile, File(description="Adobe Illustrator (.ai) or PDF file")],
) -> IllustratorPreviewResponse:
    """Parse an Illustrator file once and cache it for placement and export."""
    payload = await file.read()
    name = _validate_ai_upload(request, file, payload)

    cached = _illustrator_store(request).put(parse_ai(payload, name))
    preview = build_preview(cached)
    # Placement has no location yet; the client re-resolves the zone once the
    # user picks a search result, passing the prefecture code from Nominatim.
    suggested = resolve_working_crs(139.7671, 35.6812, None)
    return IllustratorPreviewResponse(
        conversion_id=cached.conversion_id,
        report=cached.report,
        layers=preview["layers"],
        artwork_bounds=preview["artwork_bounds"],
        preview=preview["preview"],
        preview_features=preview["preview_features"],
        total_features=preview["total_features"],
        suggested_crs=suggested,
        suggested_crs_label=zone_label(suggested),
    )


@router.post("/convert/illustrator/{conversion_id}/export")
async def export_illustrator(
    conversion_id: str,
    request: Request,
    payload: IllustratorExportRequest,
) -> Response:
    """Apply a placement to a cached conversion and return a zipped bundle."""
    if payload.formats.qgis and not payload.formats.geopackage:
        raise ValueError(
            "A QGIS project needs the GeoPackage; enable it or disable the project."
        )
    if not (payload.formats.geopackage or payload.formats.shapefile or payload.formats.qgis):
        raise ValueError("Select at least one output format.")

    cached = _illustrator_store(request).get(conversion_id)
    transform = SimilarityTransform(
        artwork_anchor=(payload.transform.artwork_anchor[0], payload.transform.artwork_anchor[1]),
        map_anchor=(payload.transform.map_anchor[0], payload.transform.map_anchor[1]),
        rotation_deg=payload.transform.rotation_deg,
        metres_per_point=payload.transform.metres_per_point,
        working_crs=payload.transform.working_crs,
    )
    zip_bytes, filename = build_georeferenced_bundle(
        cached,
        transform,
        payload.output_crs,
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


@router.get("/geocode", response_model=GeocodeSearchResponse)
async def geocode(
    request: Request,
    query: str,
    language: str = "ja",
    limit: int = 5,
) -> GeocodeSearchResponse:
    """Address search with no session, for placing artwork."""
    from backend.routers.wizard_router import _match_to_schema
    from backend.src.geocoding import GeocodingError

    geocoder = getattr(request.app.state, "geocoder", None)
    if geocoder is None:
        raise GeocodingError(
            "Geocoding is disabled on this server.",
            code="GEOCODER_DISABLED",
            status_code=503,
        )
    cleaned = query.strip()
    if not cleaned:
        return GeocodeSearchResponse(query="", language=language, results=[])
    matches = geocoder.search(cleaned, language=language, limit=max(1, min(limit, 10)))
    return GeocodeSearchResponse(
        query=cleaned, language=language, results=[_match_to_schema(m) for m in matches]
    )
```

Refactor the existing `convert_illustrator` (line 142-155) to call `_validate_ai_upload` rather than repeating the four checks.

`GeoreferenceError` subclasses `ValueError`, so the handler at `main.py:127` already maps it to 400.

- [ ] **Step 4: Add the environment settings**

Append to `.env.example` after the `TEMP_DATA_DIR` line:

```
# Illustrator georeferencing cache
ILLUSTRATOR_CACHE_TTL_MINUTES=120
ILLUSTRATOR_CACHE_MAX_ENTRIES=20
```

- [ ] **Step 5: Write the endpoint tests**

Create `backend/tests/test_illustrator_api.py`:

```python
"""Endpoint tests for the georeferencing flow."""

from __future__ import annotations

import io
import zipfile

import pytest

from backend.src.geocoding import GeocodeAddressParts, GeocodeMatch
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf


def _preview(test_client):
    return test_client.post(
        "/api/convert/illustrator/preview",
        files=[("file", ("sample.ai", _build_minimal_ai_pdf(), "application/postscript"))],
    )


def _body(bounds):
    return {
        "transform": {
            "artwork_anchor": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
            "map_anchor": [139.700258, 35.690921],
            "rotation_deg": 12.5,
            "metres_per_point": 0.176389,
            "working_crs": "EPSG:6677",
        },
        "output_crs": "EPSG:6677",
        "formats": {"geopackage": True, "shapefile": True, "qgis": True},
    }


@pytest.mark.georef
def test_preview_returns_a_conversion_id_and_bounds(test_client) -> None:
    response = _preview(test_client)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["conversion_id"]
    assert len(payload["artwork_bounds"]) == 4
    assert payload["total_features"] >= 1
    assert payload["preview"]["type"] == "FeatureCollection"
    assert "JPR CS" in payload["suggested_crs_label"]


@pytest.mark.georef
def test_preview_rejects_a_non_pdf_upload(test_client) -> None:
    response = test_client.post(
        "/api/convert/illustrator/preview",
        files=[("file", ("bad.ai", b"not a pdf", "application/postscript"))],
    )
    assert response.status_code == 400


@pytest.mark.georef
def test_export_returns_a_zip_with_every_format(test_client) -> None:
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
    assert any(n.endswith(".prj") for n in names)


@pytest.mark.georef
def test_export_with_an_unknown_id_is_404(test_client) -> None:
    response = test_client.post(
        "/api/convert/illustrator/deadbeef/export", json=_body([0.0, 0.0, 100.0, 100.0])
    )
    assert response.status_code == 404
    assert response.json()["code"] == "CONVERSION_EXPIRED"


@pytest.mark.georef
def test_export_rejects_a_qgis_project_without_its_geopackage(test_client) -> None:
    payload = _preview(test_client).json()
    body = _body(payload["artwork_bounds"])
    body["formats"] = {"geopackage": False, "shapefile": False, "qgis": True}
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 400


@pytest.mark.georef
def test_export_rejects_a_non_positive_scale(test_client) -> None:
    payload = _preview(test_client).json()
    body = _body(payload["artwork_bounds"])
    body["transform"]["metres_per_point"] = 0
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 422


@pytest.mark.georef
def test_geocode_endpoint_needs_no_session(test_client) -> None:
    class FakeGeocoder:
        def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
            assert query == "新宿駅"
            return [
                GeocodeMatch(
                    display_name="新宿駅",
                    latitude=35.690921,
                    longitude=139.700258,
                    source="fake",
                    address=GeocodeAddressParts(locality="新宿区", province="JP-13"),
                )
            ]

        def reverse(self, latitude: float, longitude: float, language: str):
            return None

    test_client.app.state.geocoder = FakeGeocoder()
    response = test_client.get("/api/geocode", params={"query": "新宿駅", "language": "ja"})
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["longitude"] == pytest.approx(139.700258)
    assert results[0]["address"]["province"] == "JP-13"


@pytest.mark.georef
def test_geocode_reports_when_disabled(test_client) -> None:
    test_client.app.state.geocoder = None
    response = test_client.get("/api/geocode", params={"query": "新宿駅"})
    assert response.status_code == 503
    assert response.json()["code"] == "GEOCODER_DISABLED"


@pytest.mark.georef
def test_legacy_direct_download_endpoint_still_works(test_client) -> None:
    response = test_client.post(
        "/api/convert/illustrator",
        files=[("file", ("sample.ai", _build_minimal_ai_pdf(), "application/postscript"))],
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
```

- [ ] **Step 6: Run the whole backend suite**

Run: `pytest backend/tests -v`
Expected: PASS. Every pre-existing test must still pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/schemas.py backend/routers/import_router.py backend/main.py .env.example backend/tests/test_illustrator_api.py
git commit -m "feat: preview, georeferenced export and unsessioned geocode endpoints"
```

---
## Task 8: Named placement library

**Files:**
- Create: `backend/src/placements.py`, `backend/tests/test_placements.py`
- Modify: `backend/src/schemas.py`, `backend/routers/import_router.py`, `backend/main.py`, `.gitignore`, `backend/tests/test_illustrator_api.py`

**Interfaces:**
- Consumes: `TransformPayload` (Task 7).
- Produces: `Placement` dataclass (`id`, `name`, `transform: dict`, `artwork_bounds: list[float]`, `created_at`, `updated_at`); `PlacementStore(db_path)` with `list_all()`, `create(name, transform, artwork_bounds)`, `update(placement_id, name, transform, artwork_bounds)`, `delete(placement_id)`, static `bounds_mismatch(placement, artwork_bounds) -> str | None`; `DuplicatePlacementError(Exception)`; `PlacementNotFoundError(KeyError)`; endpoints `GET/POST /api/placements`, `PUT/DELETE /api/placements/{placement_id}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_placements.py`:

```python
"""Named placement storage."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.src.placements import (
    DuplicatePlacementError,
    PlacementNotFoundError,
    PlacementStore,
)

TRANSFORM = {
    "artwork_anchor": [250.0, 275.0],
    "map_anchor": [139.700258, 35.690921],
    "rotation_deg": 12.5,
    "metres_per_point": 0.176389,
    "working_crs": "EPSG:6677",
}
BOUNDS = [0.0, 0.0, 500.0, 550.0]


@pytest.fixture()
def store(tmp_path: Path) -> PlacementStore:
    return PlacementStore(tmp_path / "placements.db")


@pytest.mark.georef
def test_create_then_list_round_trips(store: PlacementStore) -> None:
    created = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    assert created.id > 0
    listed = store.list_all()
    assert [p.name for p in listed] == ["Shinjuku Station"]
    assert listed[0].transform["working_crs"] == "EPSG:6677"
    assert listed[0].transform["map_anchor"] == [139.700258, 35.690921]
    assert listed[0].artwork_bounds == BOUNDS


@pytest.mark.georef
def test_duplicate_names_are_rejected(store: PlacementStore) -> None:
    store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    with pytest.raises(DuplicatePlacementError):
        store.create("Shinjuku Station", TRANSFORM, BOUNDS)


@pytest.mark.georef
def test_update_replaces_the_transform(store: PlacementStore) -> None:
    created = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    updated = store.update(
        created.id, "Shinjuku Station", dict(TRANSFORM, rotation_deg=-40.0), BOUNDS
    )
    assert updated.transform["rotation_deg"] == -40.0
    assert updated.updated_at >= created.created_at


@pytest.mark.georef
def test_delete_removes_the_row(store: PlacementStore) -> None:
    created = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    store.delete(created.id)
    assert store.list_all() == []


@pytest.mark.georef
def test_missing_placement_raises(store: PlacementStore) -> None:
    with pytest.raises(PlacementNotFoundError):
        store.delete(4242)


@pytest.mark.georef
def test_two_writers_do_not_lose_an_update(tmp_path: Path) -> None:
    """Colleagues share one server; a JSON file would drop one of these."""
    path = tmp_path / "placements.db"
    PlacementStore(path).create("Floor 1", TRANSFORM, BOUNDS)
    PlacementStore(path).create("Floor 2", TRANSFORM, BOUNDS)
    assert {p.name for p in PlacementStore(path).list_all()} == {"Floor 1", "Floor 2"}


@pytest.mark.georef
def test_matching_bounds_produce_no_warning(store: PlacementStore) -> None:
    placement = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    assert store.bounds_mismatch(placement, [0.0, 0.0, 500.0, 550.0]) is None
    assert store.bounds_mismatch(placement, [10.0, 10.0, 512.0, 563.0]) is None


@pytest.mark.georef
def test_a_shifted_artboard_warns(store: PlacementStore) -> None:
    placement = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    warning = store.bounds_mismatch(placement, [0.0, 0.0, 700.0, 550.0])
    assert warning is not None
    assert "artboard" in warning.lower()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest backend/tests/test_placements.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.src.placements'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/placements.py`:

```python
"""Named placements, so the floors of one building are positioned once.

SQLite rather than a JSON file: this runs on a shared PC, and a
read-modify-write over JSON silently loses one of two concurrent saves.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# A saved placement is anchored on the artboard it was authored against; warn if
# the new drawing differs by more than this fraction in width or height.
_BOUNDS_TOLERANCE = 0.01

_SCHEMA = """
CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  working_crs TEXT NOT NULL,
  anchor_lon REAL NOT NULL,
  anchor_lat REAL NOT NULL,
  artwork_anchor_x REAL NOT NULL,
  artwork_anchor_y REAL NOT NULL,
  rotation_deg REAL NOT NULL,
  metres_per_point REAL NOT NULL,
  artwork_bounds TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""


class DuplicatePlacementError(Exception):
    """Raised when a placement name is already taken."""


class PlacementNotFoundError(KeyError):
    """Raised when a placement id does not exist."""


@dataclass(slots=True)
class Placement:
    id: int
    name: str
    transform: dict
    artwork_bounds: list[float]
    created_at: str
    updated_at: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PlacementStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10, isolation_level="IMMEDIATE")
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _to_placement(row: sqlite3.Row) -> Placement:
        return Placement(
            id=row["id"],
            name=row["name"],
            transform={
                "artwork_anchor": [row["artwork_anchor_x"], row["artwork_anchor_y"]],
                "map_anchor": [row["anchor_lon"], row["anchor_lat"]],
                "rotation_deg": row["rotation_deg"],
                "metres_per_point": row["metres_per_point"],
                "working_crs": row["working_crs"],
            },
            artwork_bounds=json.loads(row["artwork_bounds"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _columns(name: str, transform: dict, artwork_bounds: list[float]) -> tuple:
        return (
            name.strip(),
            transform["working_crs"],
            transform["map_anchor"][0],
            transform["map_anchor"][1],
            transform["artwork_anchor"][0],
            transform["artwork_anchor"][1],
            transform["rotation_deg"],
            transform["metres_per_point"],
            json.dumps(artwork_bounds),
        )

    def list_all(self) -> list[Placement]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM placements ORDER BY name").fetchall()
        return [self._to_placement(row) for row in rows]

    def create(self, name: str, transform: dict, artwork_bounds: list[float]) -> Placement:
        stamp = _now()
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    "INSERT INTO placements (name, working_crs, anchor_lon, anchor_lat,"
                    " artwork_anchor_x, artwork_anchor_y, rotation_deg, metres_per_point,"
                    " artwork_bounds, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (*self._columns(name, transform, artwork_bounds), stamp, stamp),
                )
                row = connection.execute(
                    "SELECT * FROM placements WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
        except sqlite3.IntegrityError as exc:
            raise DuplicatePlacementError(f"A placement named '{name}' already exists.") from exc
        return self._to_placement(row)

    def update(
        self, placement_id: int, name: str, transform: dict, artwork_bounds: list[float]
    ) -> Placement:
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    "UPDATE placements SET name = ?, working_crs = ?, anchor_lon = ?,"
                    " anchor_lat = ?, artwork_anchor_x = ?, artwork_anchor_y = ?,"
                    " rotation_deg = ?, metres_per_point = ?, artwork_bounds = ?,"
                    " updated_at = ? WHERE id = ?",
                    (*self._columns(name, transform, artwork_bounds), _now(), placement_id),
                )
                if cursor.rowcount == 0:
                    raise PlacementNotFoundError(f"No placement with id {placement_id}.")
                row = connection.execute(
                    "SELECT * FROM placements WHERE id = ?", (placement_id,)
                ).fetchone()
        except sqlite3.IntegrityError as exc:
            raise DuplicatePlacementError(f"A placement named '{name}' already exists.") from exc
        return self._to_placement(row)

    def delete(self, placement_id: int) -> None:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM placements WHERE id = ?", (placement_id,))
            if cursor.rowcount == 0:
                raise PlacementNotFoundError(f"No placement with id {placement_id}.")

    @staticmethod
    def bounds_mismatch(placement: Placement, artwork_bounds: list[float]) -> str | None:
        """Warn when a saved placement is applied to a differently sized artboard."""
        saved_w = placement.artwork_bounds[2] - placement.artwork_bounds[0]
        saved_h = placement.artwork_bounds[3] - placement.artwork_bounds[1]
        new_w = artwork_bounds[2] - artwork_bounds[0]
        new_h = artwork_bounds[3] - artwork_bounds[1]
        if saved_w <= 0 or saved_h <= 0:
            return None
        if (
            abs(new_w - saved_w) / saved_w <= _BOUNDS_TOLERANCE
            and abs(new_h - saved_h) / saved_h <= _BOUNDS_TOLERANCE
        ):
            return None
        return (
            f"This drawing's artboard is {new_w:.0f}x{new_h:.0f} pt but the saved placement "
            f"was made against {saved_w:.0f}x{saved_h:.0f} pt. Check the alignment."
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest backend/tests/test_placements.py -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add schemas and endpoints**

Append to `backend/src/schemas.py`:

```python
class PlacementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    transform: TransformPayload
    artwork_bounds: list[float] = Field(min_length=4, max_length=4)


class PlacementItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    transform: TransformPayload
    artwork_bounds: list[float]
    created_at: str
    updated_at: str


class PlacementListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    placements: list[PlacementItem] = Field(default_factory=list)
```

In `backend/main.py` add `from backend.src.placements import DuplicatePlacementError, PlacementStore`, this line inside `lifespan`:

```python
    app.state.placement_store = PlacementStore(
        Path(os.getenv("PLACEMENTS_DB", "./data/placements.db"))
    )
```

and this handler:

```python
@app.exception_handler(DuplicatePlacementError)
async def duplicate_placement_handler(_: Request, exc: DuplicatePlacementError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="PLACEMENT_NAME_TAKEN")
    return JSONResponse(status_code=409, content=payload.model_dump())
```

`PlacementNotFoundError` subclasses `KeyError`, which `main.py:120` already maps to 404.

In `backend/routers/import_router.py` add `from backend.src.placements import PlacementStore` plus the placement schemas, then:

```python
def _placement_store(request: Request) -> PlacementStore:
    return request.app.state.placement_store


def _placement_item(placement) -> PlacementItem:
    return PlacementItem(
        id=placement.id,
        name=placement.name,
        transform=TransformPayload(**placement.transform),
        artwork_bounds=placement.artwork_bounds,
        created_at=placement.created_at,
        updated_at=placement.updated_at,
    )


@router.get("/placements", response_model=PlacementListResponse)
async def list_placements(request: Request) -> PlacementListResponse:
    return PlacementListResponse(
        placements=[_placement_item(p) for p in _placement_store(request).list_all()]
    )


@router.post("/placements", response_model=PlacementItem, status_code=201)
async def create_placement(request: Request, payload: PlacementRequest) -> PlacementItem:
    return _placement_item(
        _placement_store(request).create(
            payload.name, payload.transform.model_dump(), payload.artwork_bounds
        )
    )


@router.put("/placements/{placement_id}", response_model=PlacementItem)
async def update_placement(
    placement_id: int, request: Request, payload: PlacementRequest
) -> PlacementItem:
    return _placement_item(
        _placement_store(request).update(
            placement_id, payload.name, payload.transform.model_dump(), payload.artwork_bounds
        )
    )


@router.delete("/placements/{placement_id}", status_code=204)
async def delete_placement(placement_id: int, request: Request) -> Response:
    _placement_store(request).delete(placement_id)
    return Response(status_code=204)
```

Add to `.gitignore` under the runtime artifacts block:

```
data/placements.db
```

- [ ] **Step 6: Add endpoint tests**

Append to `backend/tests/test_illustrator_api.py`:

```python
PLACEMENT_BODY = {
    "name": "Placement CRUD Test",
    "transform": {
        "artwork_anchor": [250.0, 275.0],
        "map_anchor": [139.700258, 35.690921],
        "rotation_deg": 12.5,
        "metres_per_point": 0.176389,
        "working_crs": "EPSG:6677",
    },
    "artwork_bounds": [0.0, 0.0, 500.0, 550.0],
}


@pytest.mark.georef
def test_placement_crud_round_trip(test_client) -> None:
    created = test_client.post("/api/placements", json=PLACEMENT_BODY)
    assert created.status_code == 201, created.text
    placement_id = created.json()["id"]
    try:
        listed = test_client.get("/api/placements").json()["placements"]
        assert any(p["id"] == placement_id for p in listed)

        changed = {
            **PLACEMENT_BODY,
            "transform": {**PLACEMENT_BODY["transform"], "rotation_deg": -3.0},
        }
        updated = test_client.put(f"/api/placements/{placement_id}", json=changed)
        assert updated.status_code == 200
        assert updated.json()["transform"]["rotation_deg"] == -3.0
    finally:
        assert test_client.delete(f"/api/placements/{placement_id}").status_code == 204


@pytest.mark.georef
def test_duplicate_placement_name_is_409(test_client) -> None:
    body = {**PLACEMENT_BODY, "name": "Duplicate Name Test"}
    first = test_client.post("/api/placements", json=body)
    assert first.status_code == 201
    try:
        conflict = test_client.post("/api/placements", json=body)
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "PLACEMENT_NAME_TAKEN"
    finally:
        test_client.delete(f"/api/placements/{first.json()['id']}")


@pytest.mark.georef
def test_deleting_an_unknown_placement_is_404(test_client) -> None:
    assert test_client.delete("/api/placements/999999").status_code == 404
```

- [ ] **Step 7: Run the backend suite**

Run: `pytest backend/tests -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/placements.py backend/tests/test_placements.py backend/src/schemas.py backend/routers/import_router.py backend/main.py backend/tests/test_illustrator_api.py .gitignore
git commit -m "feat: named placement library backed by SQLite"
```

---
## Task 9: Frontend transform maths and cross-language parity

**Files:**
- Create: `frontend/src/lib/similarity.ts`, `frontend/src/lib/similarity.test.ts`
- Modify: `backend/tests/test_illustrator_georeference.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SimilarityTransform = { artworkAnchor: [number, number]; mapAnchor: [number, number]; rotationDeg: number; metresPerPoint: number; workingCrs: string }`; `SimilarityError`; `metresPerPointForScale(denominator)`; `meridianRadius(lat)`; `primeVerticalRadius(lat)`; `enuToLngLat(east, north, anchorLon, anchorLat)`; `lngLatToEnu(lon, lat, anchorLon, anchorLat)`; `toEnuMatrix(transform)`; `applyMatrix(matrix, x, y)`; `transformGeoJson(collection, transform)`; `fitHelmert(artworkPoints, enuPoints, workingCrs, fixedMetresPerPoint?)`; `residuals(transform, artworkPoints, enuPoints)`. Control-point map positions are **ENU metres about the anchor**, not lon/lat — callers convert with `lngLatToEnu`.

**Why ENU and not Web Mercator.** Web Mercator is not conformal on the ellipsoid: its north
scale is `a·sec φ / M(φ)` and its east scale `a·sec φ / (N·cos φ)`, which differ by about
0.45% at Tokyo. A similarity transform in Mercator metres is therefore not a similarity on
the ground and the artwork arrives stretched. Measured worst-case disagreement with the
authoritative export, on a 59 m artwork: Web Mercator + grid north 23.35 cm, Web Mercator +
true north 17.01 cm, ENU + grid north 8.00 cm, **ENU + true north 0.58 cm**.

- [ ] **Step 1: Pin the shared golden constants on the backend**

Append to `backend/tests/test_illustrator_georeference.py`:

```python
# The same four values are asserted in frontend/src/lib/similarity.test.ts.
# They are what makes the two independent implementations one contract.
GOLDEN_LNGLAT = [
    (139.700258000, 35.690921000),
    (139.700764350, 35.691159486),
    (139.700618180, 35.691366023),
    (139.700111829, 35.691127536),
]


@pytest.mark.georef
def test_golden_fixture_lands_on_the_shared_constants() -> None:
    placed = affine_transform(Polygon(GOLDEN_ARTWORK), golden_transform().to_affine_matrix())
    for (east, north), (want_lon, want_lat) in zip(placed.exterior.coords, GOLDEN_LNGLAT):
        lon, lat = unproject_point(east, north, "EPSG:6677")
        assert lon == pytest.approx(want_lon, abs=1e-8)
        assert lat == pytest.approx(want_lat, abs=1e-8)
```

Run: `pytest backend/tests/test_illustrator_georeference.py -m georef -v`
Expected: PASS.

- [ ] **Step 2: Write the failing frontend test**

Create `frontend/src/lib/similarity.test.ts`:

```typescript
import {
  applyMatrix,
  enuToLngLat,
  fitHelmert,
  lngLatToEnu,
  metresPerPointForScale,
  residuals,
  toEnuMatrix,
  transformGeoJson,
  type SimilarityTransform
} from "./similarity";

// Golden fixture. GOLDEN_LNGLAT is asserted identically in
// backend/tests/test_illustrator_georeference.py.
const GOLDEN_ARTWORK: [number, number][] = [
  [100, 200],
  [400, 200],
  [400, 350],
  [100, 350]
];
const GOLDEN_LNGLAT: [number, number][] = [
  [139.700258, 35.690921],
  [139.70076435, 35.691159486],
  [139.70061818, 35.691366023],
  [139.700111829, 35.691127536]
];
const GOLDEN: SimilarityTransform = {
  artworkAnchor: [100, 200],
  mapAnchor: [139.700258, 35.690921],
  rotationDeg: 30,
  metresPerPoint: 0.176389,
  workingCrs: "EPSG:6677"
};

// 6 decimal degrees is about 5.5 cm. The correct implementation lands 0.58 cm
// from the backend; the two bugs this guards against land 8 cm (grid-north
// rotation) and 23 cm (Web Mercator), so both fail this tolerance.
const DEGREE_PRECISION = 6;

test("drawing scale converts to metres per point exactly", () => {
  expect(metresPerPointForScale(500)).toBeCloseTo(0.1763888888, 9);
  expect(metresPerPointForScale(1)).toBeCloseTo(0.0003527777, 9);
});

test("a non-positive drawing scale is rejected", () => {
  expect(() => metresPerPointForScale(0)).toThrow();
});

test("the golden fixture matches the backend constants", () => {
  const matrix = toEnuMatrix(GOLDEN);
  GOLDEN_ARTWORK.forEach((point, index) => {
    const [east, north] = applyMatrix(matrix, point[0], point[1]);
    const [lon, lat] = enuToLngLat(east, north, GOLDEN.mapAnchor[0], GOLDEN.mapAnchor[1]);
    expect(lon).toBeCloseTo(GOLDEN_LNGLAT[index][0], DEGREE_PRECISION);
    expect(lat).toBeCloseTo(GOLDEN_LNGLAT[index][1], DEGREE_PRECISION);
  });
});

test("the artwork anchor lands exactly on the map anchor", () => {
  const matrix = toEnuMatrix(GOLDEN);
  const [east, north] = applyMatrix(matrix, GOLDEN.artworkAnchor[0], GOLDEN.artworkAnchor[1]);
  expect(east).toBeCloseTo(0, 9);
  expect(north).toBeCloseTo(0, 9);
});

test("zero rotation points artwork +y at true north", () => {
  const matrix = toEnuMatrix({ ...GOLDEN, rotationDeg: 0 });
  const [east, north] = applyMatrix(matrix, 100, 350);
  expect(east).toBeCloseTo(0, 9);
  expect(north).toBeGreaterThan(0);
});

test("a 300 pt edge becomes 300 * scale metres", () => {
  const matrix = toEnuMatrix(GOLDEN);
  const a = applyMatrix(matrix, 100, 200);
  const b = applyMatrix(matrix, 400, 200);
  expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(300 * GOLDEN.metresPerPoint, 9);
});

test("scale is uniform, so a square stays square", () => {
  const matrix = toEnuMatrix(GOLDEN);
  const origin = applyMatrix(matrix, 0, 0);
  const alongX = applyMatrix(matrix, 100, 0);
  const alongY = applyMatrix(matrix, 0, 100);
  expect(Math.hypot(alongX[0] - origin[0], alongX[1] - origin[1])).toBeCloseTo(
    Math.hypot(alongY[0] - origin[0], alongY[1] - origin[1]),
    9
  );
});

test("rotation is recoverable from the matrix", () => {
  const [a, , d] = toEnuMatrix(GOLDEN);
  expect((Math.atan2(d, a) * 180) / Math.PI).toBeCloseTo(GOLDEN.rotationDeg, 9);
});

test("ENU and lon/lat round-trip", () => {
  const [east, north] = lngLatToEnu(139.7015, 35.6915, GOLDEN.mapAnchor[0], GOLDEN.mapAnchor[1]);
  const [lon, lat] = enuToLngLat(east, north, GOLDEN.mapAnchor[0], GOLDEN.mapAnchor[1]);
  expect(lon).toBeCloseTo(139.7015, 9);
  expect(lat).toBeCloseTo(35.6915, 9);
});

test("transformGeoJson places a polygon on the golden constants", () => {
  const collection = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature",
        properties: { ai_layer: "floor" },
        geometry: { type: "Polygon", coordinates: [GOLDEN_ARTWORK] }
      }
    ]
  };
  const placed = transformGeoJson(collection, GOLDEN);
  const ring = placed.features[0].geometry.coordinates[0] as [number, number][];
  ring.forEach(([lon, lat], index) => {
    expect(lon).toBeCloseTo(GOLDEN_LNGLAT[index][0], DEGREE_PRECISION);
    expect(lat).toBeCloseTo(GOLDEN_LNGLAT[index][1], DEGREE_PRECISION);
  });
  expect(placed.features[0].properties.ai_layer).toBe("floor");
});

test("Helmert recovers a known rotation and scale", () => {
  const truth: SimilarityTransform = {
    ...GOLDEN,
    artworkAnchor: [0, 0],
    rotationDeg: 42.5,
    metresPerPoint: 0.25
  };
  const artwork: [number, number][] = [
    [0, 0],
    [500, 0],
    [500, 300]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));
  const fitted = fitHelmert(artwork, mapped, "EPSG:6677");
  expect(fitted.rotationDeg).toBeCloseTo(42.5, 6);
  expect(fitted.metresPerPoint).toBeCloseTo(0.25, 9);
});

test("Helmert with a locked scale keeps that scale", () => {
  const truth: SimilarityTransform = { ...GOLDEN, artworkAnchor: [0, 0], rotationDeg: -17.25 };
  const artwork: [number, number][] = [
    [0, 0],
    [400, 120]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));
  const fitted = fitHelmert(artwork, mapped, "EPSG:6677", GOLDEN.metresPerPoint);
  expect(fitted.metresPerPoint).toBe(GOLDEN.metresPerPoint);
  expect(fitted.rotationDeg).toBeCloseTo(-17.25, 6);
});

test("Helmert normalises rotation into (-180, 180]", () => {
  const truth: SimilarityTransform = { ...GOLDEN, artworkAnchor: [0, 0], rotationDeg: 200 };
  const artwork: [number, number][] = [
    [0, 0],
    [500, 0]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));
  expect(fitHelmert(artwork, mapped, "EPSG:6677").rotationDeg).toBeCloseTo(-160, 6);
});

test("Helmert refuses fewer than two pairs", () => {
  expect(() => fitHelmert([[0, 0]], [[0, 0]], "EPSG:6677")).toThrow();
});

test("Helmert refuses mismatched pair counts", () => {
  expect(() =>
    fitHelmert(
      [
        [0, 0],
        [1, 1]
      ],
      [[0, 0]],
      "EPSG:6677"
    )
  ).toThrow();
});

test("Helmert refuses coincident artwork points", () => {
  expect(() =>
    fitHelmert(
      [
        [5, 5],
        [5, 5]
      ],
      [
        [0, 0],
        [10, 0]
      ],
      "EPSG:6677"
    )
  ).toThrow();
});

test("residuals are zero for an exact fit and large for a bad point", () => {
  const truth: SimilarityTransform = { ...GOLDEN, artworkAnchor: [0, 0] };
  const artwork: [number, number][] = [
    [0, 0],
    [500, 0],
    [500, 300]
  ];
  const matrix = toEnuMatrix(truth);
  const mapped = artwork.map((p) => applyMatrix(matrix, p[0], p[1]));

  expect(residuals(truth, artwork, mapped).rmse).toBeCloseTo(0, 6);

  const broken: [number, number][] = [...mapped];
  broken[2] = [broken[2][0] + 90, broken[2][1]];
  const bad = residuals(truth, artwork, broken);
  expect(bad.rmse).toBeGreaterThan(1);
  expect(Math.max(...bad.perPoint)).toBeGreaterThan(1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/similarity.test.ts`
Expected: FAIL — cannot resolve `./similarity`.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/lib/similarity.ts`:

```typescript
/**
 * Similarity transform for placing Illustrator artwork on the map.
 *
 * Artwork coordinates are PDF points, y-up from a bottom-left origin, which
 * already matches GIS axis convention — there is no flip anywhere here.
 *
 * Preview maths runs in a local ENU tangent frame anchored at `mapAnchor`,
 * using the WGS84 radii of curvature. Web Mercator is deliberately NOT used:
 * it is not conformal on the ellipsoid (north and east scales differ by about
 * 0.45% at Tokyo), so a similarity in Mercator metres is not a similarity on
 * the ground. Measured against the authoritative backend export on a 59 m
 * artwork, Mercator lands 23 cm out; this ENU frame lands 0.58 cm out.
 *
 * `rotationDeg` is measured CCW from TRUE north, which is also ENU +north, so
 * no convergence correction belongs here. The backend applies the convergence
 * when it converts to its projected grid.
 */

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;
const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

export type SimilarityTransform = {
  artworkAnchor: [number, number];
  mapAnchor: [number, number];
  rotationDeg: number;
  metresPerPoint: number;
  workingCrs: string;
};

export type AffineMatrix = [number, number, number, number, number, number];

export class SimilarityError extends Error {}

/** Ground metres per PDF point for a 1:denominator drawing. */
export function metresPerPointForScale(denominator: number): number {
  if (!(denominator > 0)) {
    throw new SimilarityError("Drawing scale denominator must be positive.");
  }
  return ((MM_PER_INCH / POINTS_PER_INCH) * denominator) / 1000;
}

/** Meridian radius of curvature, metres per radian of latitude. */
export function meridianRadius(latitude: number): number {
  const w = 1 - WGS84_E2 * Math.sin((latitude * Math.PI) / 180) ** 2;
  return (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5);
}

/** Prime-vertical radius of curvature. */
export function primeVerticalRadius(latitude: number): number {
  const w = 1 - WGS84_E2 * Math.sin((latitude * Math.PI) / 180) ** 2;
  return WGS84_A / Math.sqrt(w);
}

/** Local ENU metres about an anchor to lon/lat. */
export function enuToLngLat(
  east: number,
  north: number,
  anchorLon: number,
  anchorLat: number
): [number, number] {
  const lat = anchorLat + (north / meridianRadius(anchorLat)) * (180 / Math.PI);
  const lon =
    anchorLon +
    (east / (primeVerticalRadius(anchorLat) * Math.cos((anchorLat * Math.PI) / 180))) *
      (180 / Math.PI);
  return [lon, lat];
}

/** Inverse of {@link enuToLngLat}. */
export function lngLatToEnu(
  lon: number,
  lat: number,
  anchorLon: number,
  anchorLat: number
): [number, number] {
  const north = ((lat - anchorLat) * Math.PI) / 180 * meridianRadius(anchorLat);
  const east =
    ((lon - anchorLon) * Math.PI) / 180 *
    primeVerticalRadius(anchorLat) *
    Math.cos((anchorLat * Math.PI) / 180);
  return [east, north];
}

/** Affine mapping artwork points into ENU metres about `mapAnchor`. */
export function toEnuMatrix(transform: SimilarityTransform): AffineMatrix {
  if (!(transform.metresPerPoint > 0)) {
    throw new SimilarityError("metresPerPoint must be positive.");
  }
  const theta = (transform.rotationDeg * Math.PI) / 180;
  const scale = transform.metresPerPoint;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const a = scale * cos;
  const b = -scale * sin;
  const d = scale * sin;
  const e = scale * cos;
  const [x0, y0] = transform.artworkAnchor;
  return [a, b, d, e, -(a * x0 + b * y0), -(d * x0 + e * y0)];
}

export function applyMatrix(matrix: AffineMatrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[1] * y + matrix[4], matrix[2] * x + matrix[3] * y + matrix[5]];
}

type GeoJsonCollection = { type: "FeatureCollection"; features: any[] };

/** Place an artwork-space FeatureCollection onto the map as lon/lat. */
export function transformGeoJson(
  collection: GeoJsonCollection,
  transform: SimilarityTransform
): GeoJsonCollection {
  const matrix = toEnuMatrix(transform);
  const [anchorLon, anchorLat] = transform.mapAnchor;
  const move = (coords: any): any => {
    if (typeof coords[0] === "number") {
      const [east, north] = applyMatrix(matrix, coords[0], coords[1]);
      return enuToLngLat(east, north, anchorLon, anchorLat);
    }
    return coords.map(move);
  };
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: { ...feature.geometry, coordinates: move(feature.geometry.coordinates) }
    }))
  };
}

/**
 * Least-squares similarity fit. `enuPoints` are ENU metres about the current
 * anchor; convert map clicks with {@link lngLatToEnu} first.
 *
 * Two pairs are the minimum. The "one control point plus the existing anchor"
 * case is handled by the caller supplying the anchor as the second pair.
 */
export function fitHelmert(
  artworkPoints: [number, number][],
  enuPoints: [number, number][],
  workingCrs: string,
  fixedMetresPerPoint?: number
): SimilarityTransform {
  if (artworkPoints.length !== enuPoints.length) {
    throw new SimilarityError("Each control point needs both an artwork and a map position.");
  }
  if (artworkPoints.length < 2) {
    throw new SimilarityError("At least two control points are required.");
  }

  const n = artworkPoints.length;
  const pBar: [number, number] = [
    artworkPoints.reduce((sum, p) => sum + p[0], 0) / n,
    artworkPoints.reduce((sum, p) => sum + p[1], 0) / n
  ];
  const qBar: [number, number] = [
    enuPoints.reduce((sum, p) => sum + p[0], 0) / n,
    enuPoints.reduce((sum, p) => sum + p[1], 0) / n
  ];

  let denominator = 0;
  let real = 0;
  let imag = 0;
  for (let i = 0; i < n; i += 1) {
    const px = artworkPoints[i][0] - pBar[0];
    const py = artworkPoints[i][1] - pBar[1];
    const qx = enuPoints[i][0] - qBar[0];
    const qy = enuPoints[i][1] - qBar[1];
    denominator += px * px + py * py;
    real += qx * px + qy * py;
    imag += qy * px - qx * py;
  }
  if (denominator <= 0) {
    throw new SimilarityError("Control points in the artwork must not all be the same point.");
  }
  if (real === 0 && imag === 0) {
    throw new SimilarityError("Control points on the map must not all be the same point.");
  }

  const rotation = (Math.atan2(imag, real) * 180) / Math.PI;
  return {
    artworkAnchor: pBar,
    mapAnchor: [qBar[0], qBar[1]],
    rotationDeg: ((rotation + 180) % 360) - 180,
    metresPerPoint: fixedMetresPerPoint ?? Math.hypot(real, imag) / denominator,
    workingCrs
  };
}

/** Per-point misfit in metres and their RMSE. */
export function residuals(
  transform: SimilarityTransform,
  artworkPoints: [number, number][],
  enuPoints: [number, number][]
): { perPoint: number[]; rmse: number } {
  const matrix = toEnuMatrix(transform);
  const perPoint = artworkPoints.map((point, index) => {
    const [east, north] = applyMatrix(matrix, point[0], point[1]);
    return Math.hypot(east - enuPoints[index][0], north - enuPoints[index][1]);
  });
  const rmse = Math.sqrt(perPoint.reduce((sum, d) => sum + d * d, 0) / perPoint.length);
  return { perPoint, rmse };
}
```

`fitHelmert` returns `mapAnchor` as ENU metres, which the caller immediately converts back
to lon/lat with `enuToLngLat` before storing it — see Task 12.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/similarity.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/similarity.ts frontend/src/lib/similarity.test.ts backend/tests/test_illustrator_georeference.py
git commit -m "feat: ENU-frame frontend transform with cross-language golden fixture"
```

---
## Task 10: Basemap styles

**Files:**
- Create: `frontend/src/components/shared/basemapStyles.ts`, `frontend/src/components/shared/basemapStyles.test.ts`

**Interfaces:**
- Consumes: `STREET_MAP_STYLE` from `./streetMapStyle`.
- Produces: `type BasemapId = "osm" | "gsi-photo" | "gsi-std"`; `BASEMAP_ORDER: BasemapId[]`; `BASEMAP_STYLES: Record<BasemapId, StyleSpecification>`; `basemapLabel(id, t): string`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/shared/basemapStyles.test.ts`:

```typescript
import { BASEMAP_ORDER, BASEMAP_STYLES, basemapLabel } from "./basemapStyles";

test("every basemap in the order has a style", () => {
  for (const id of BASEMAP_ORDER) {
    expect(BASEMAP_STYLES[id]).toBeDefined();
  }
});

test("OSM stays the first and default option", () => {
  expect(BASEMAP_ORDER[0]).toBe("osm");
});

test("aerial imagery is offered, because OSM often lacks the footprint", () => {
  expect(BASEMAP_ORDER).toContain("gsi-photo");
});

test("every style carries an attribution", () => {
  for (const id of BASEMAP_ORDER) {
    const sources = Object.values(BASEMAP_STYLES[id].sources) as { attribution?: string }[];
    for (const source of sources) {
      expect(source.attribution).toBeTruthy();
    }
  }
});

test("GSI layers credit 国土地理院 as their terms require", () => {
  for (const id of ["gsi-photo", "gsi-std"] as const) {
    const sources = Object.values(BASEMAP_STYLES[id].sources) as { attribution?: string }[];
    expect(sources.some((source) => source.attribution?.includes("国土地理院"))).toBe(true);
  }
});

test("tile templates use xyz placeholders", () => {
  for (const id of BASEMAP_ORDER) {
    const sources = Object.values(BASEMAP_STYLES[id].sources) as { tiles?: string[] }[];
    for (const source of sources) {
      expect(source.tiles?.[0]).toMatch(/\{z\}\/\{x\}\/\{y\}/);
    }
  }
});

test("labels are bilingual", () => {
  const en = (a: string) => a;
  const ja = (_a: string, b: string) => b;
  expect(basemapLabel("gsi-photo", en)).toBe("Aerial (GSI)");
  expect(basemapLabel("gsi-photo", ja)).toBe("写真（地理院）");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/shared/basemapStyles.test.ts`
Expected: FAIL — cannot resolve `./basemapStyles`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/shared/basemapStyles.ts`:

```typescript
import type { StyleSpecification } from "maplibre-gl";

import { STREET_MAP_STYLE } from "./streetMapStyle";

/**
 * Basemaps for artwork placement.
 *
 * OSM frequently has no building footprint for the site, which makes alignment
 * impossible; the GSI aerial layer shows the actual roof, and GSI's standard
 * map carries authoritative Japanese labels. Both require the attribution
 * 出典：国土地理院. All three endpoints were verified serving tiles at z17.
 */
export type BasemapId = "osm" | "gsi-photo" | "gsi-std";

export const BASEMAP_ORDER: BasemapId[] = ["osm", "gsi-photo", "gsi-std"];

const GSI_ATTRIBUTION =
  '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>';

function rasterStyle(
  id: string,
  tiles: string[],
  attribution: string,
  maxzoom: number
): StyleSpecification {
  return {
    version: 8,
    sources: { [id]: { type: "raster", tiles, tileSize: 256, attribution, maxzoom } },
    layers: [{ id, type: "raster", source: id }]
  };
}

export const BASEMAP_STYLES: Record<BasemapId, StyleSpecification> = {
  osm: STREET_MAP_STYLE,
  "gsi-photo": rasterStyle(
    "gsi-photo",
    ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
    GSI_ATTRIBUTION,
    18
  ),
  "gsi-std": rasterStyle(
    "gsi-std",
    ["https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"],
    GSI_ATTRIBUTION,
    18
  )
};

export function basemapLabel(id: BasemapId, t: (en: string, ja: string) => string): string {
  if (id === "osm") return t("Street", "地図");
  if (id === "gsi-photo") return t("Aerial (GSI)", "写真（地理院）");
  return t("GSI map", "地理院地図");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/shared/basemapStyles.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/shared/basemapStyles.ts frontend/src/components/shared/basemapStyles.test.ts
git commit -m "feat: OSM and GSI basemap styles for placement"
```

---

## Task 11: API client functions

**Files:**
- Modify: `frontend/src/api/client.ts` (append after `convertIllustrator`, which ends at line 469)

**Interfaces:**
- Consumes: existing `handleJson`, `buildApiClientError`, `GeocodeResultItem`, `IllustratorConversionReport` in this module.
- Produces: types `IllustratorLayerSummary`, `IllustratorPreviewResponse`, `TransformPayload`, `ExportFormatsPayload`, `PlacementItem`; functions `previewIllustrator`, `exportIllustrator`, `geocodeSearch`, `listPlacements`, `createPlacement`, `updatePlacement`, `deletePlacement`.

- [ ] **Step 1: Append the client code**

Append to `frontend/src/api/client.ts`:

```typescript
export type IllustratorLayerSummary = {
  table: string;
  ai_layer: string;
  role: string;
  feature_count: number;
};

export type IllustratorPreviewResponse = {
  conversion_id: string;
  report: IllustratorConversionReport;
  layers: IllustratorLayerSummary[];
  artwork_bounds: [number, number, number, number];
  preview: { type: "FeatureCollection"; features: any[] };
  preview_features: number;
  total_features: number;
  suggested_crs: string;
  suggested_crs_label: string;
};

export type TransformPayload = {
  artwork_anchor: [number, number];
  map_anchor: [number, number];
  rotation_deg: number;
  metres_per_point: number;
  working_crs: string;
};

export type ExportFormatsPayload = {
  geopackage: boolean;
  shapefile: boolean;
  qgis: boolean;
};

export type PlacementItem = {
  id: number;
  name: string;
  transform: TransformPayload;
  artwork_bounds: [number, number, number, number];
  created_at: string;
  updated_at: string;
};

export type PlacementRequestBody = {
  name: string;
  transform: TransformPayload;
  artwork_bounds: [number, number, number, number];
};

export async function previewIllustrator(file: File): Promise<IllustratorPreviewResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/convert/illustrator/preview", {
    method: "POST",
    body: formData
  });
  return handleJson<IllustratorPreviewResponse>(response);
}

export async function exportIllustrator(
  conversionId: string,
  body: { transform: TransformPayload; output_crs: string; formats: ExportFormatsPayload }
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/convert/illustrator/${conversionId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw buildApiClientError(response.status, (await response.text()) || "");
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return {
    blob: await response.blob(),
    filename: starMatch ? decodeURIComponent(starMatch[1]) : plainMatch?.[1] ?? "output.zip"
  };
}

export async function geocodeSearch(
  query: string,
  language: string,
  limit = 5
): Promise<GeocodeResultItem[]> {
  const params = new URLSearchParams({ query, language, limit: String(limit) });
  const response = await fetch(`/api/geocode?${params.toString()}`);
  const payload = await handleJson<{ results: GeocodeResultItem[] }>(response);
  return payload.results;
}

export async function listPlacements(): Promise<PlacementItem[]> {
  const response = await fetch("/api/placements");
  const payload = await handleJson<{ placements: PlacementItem[] }>(response);
  return payload.placements;
}

export async function createPlacement(body: PlacementRequestBody): Promise<PlacementItem> {
  const response = await fetch("/api/placements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return handleJson<PlacementItem>(response);
}

export async function updatePlacement(
  id: number,
  body: PlacementRequestBody
): Promise<PlacementItem> {
  const response = await fetch(`/api/placements/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return handleJson<PlacementItem>(response);
}

export async function deletePlacement(id: number): Promise<void> {
  const response = await fetch(`/api/placements/${id}`, { method: "DELETE" });
  if (!response.ok) {
    throw buildApiClientError(response.status, (await response.text()) || "");
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd frontend && npx tsc -b`
Expected: no errors. If `handleJson` is declared below this point in the file, hoisting
applies to `function` declarations, so no reordering is needed.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat: API client for Illustrator preview, export and placements"
```

---
## Task 12: Placement state hook

**Files:**
- Create: `frontend/src/hooks/useIllustratorPlacement.ts`, `frontend/src/hooks/useIllustratorPlacement.test.ts`

**Interfaces:**
- Consumes: `SimilarityTransform`, `metresPerPointForScale`, `fitHelmert`, `residuals`, `lngLatToEnu`, `enuToLngLat` (Task 9); `TransformPayload` (Task 11).
- Produces: `type ControlPoint = { id: string; artwork: [number, number]; map: [number, number] }` where `map` is **lon/lat**; `type PlacementState = { transform: SimilarityTransform; scaleLocked: boolean; controlPoints: ControlPoint[] }`; `placementReducer(state, action)`; `toTransformPayload`; `fromTransformPayload`; `currentResiduals(state)`; `useIllustratorPlacement(initial)`. Actions: `moveAnchor`, `rotate`, `scale`, `setDrawingScale`, `calibrateDistance`, `unlockScale`, `setWorkingCrs`, `addControlPoint`, `removeControlPoint`, `fitControlPoints`, `applyTransform`.

Control points are stored as lon/lat because that is what the map hands over and what a
saved placement must survive on; the reducer converts to ENU only for the duration of a fit.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/hooks/useIllustratorPlacement.test.ts`:

```typescript
import {
  currentResiduals,
  fromTransformPayload,
  placementReducer,
  toTransformPayload,
  type PlacementState
} from "./useIllustratorPlacement";

const BASE: PlacementState = {
  transform: {
    artworkAnchor: [250, 275],
    mapAnchor: [139.700258, 35.690921],
    rotationDeg: 0,
    metresPerPoint: 0.176389,
    workingCrs: "EPSG:6677"
  },
  scaleLocked: false,
  controlPoints: []
};

test("moving the anchor changes only the anchor", () => {
  const next = placementReducer(BASE, { type: "moveAnchor", mapAnchor: [139.8, 35.7] });
  expect(next.transform.mapAnchor).toEqual([139.8, 35.7]);
  expect(next.transform.rotationDeg).toBe(BASE.transform.rotationDeg);
  expect(next.transform.metresPerPoint).toBe(BASE.transform.metresPerPoint);
  expect(next.transform.artworkAnchor).toEqual(BASE.transform.artworkAnchor);
});

test("rotating changes only the rotation", () => {
  const next = placementReducer(BASE, { type: "rotate", rotationDeg: 33 });
  expect(next.transform.rotationDeg).toBe(33);
  expect(next.transform.mapAnchor).toEqual(BASE.transform.mapAnchor);
  expect(next.transform.metresPerPoint).toBe(BASE.transform.metresPerPoint);
});

test("rotation is normalised into (-180, 180]", () => {
  expect(placementReducer(BASE, { type: "rotate", rotationDeg: 200 }).transform.rotationDeg).toBe(
    -160
  );
  expect(placementReducer(BASE, { type: "rotate", rotationDeg: -540 }).transform.rotationDeg).toBe(
    180
  );
  expect(placementReducer(BASE, { type: "rotate", rotationDeg: 360 }).transform.rotationDeg).toBe(0);
});

test("setting a drawing scale locks the scale", () => {
  const next = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  expect(next.transform.metresPerPoint).toBeCloseTo(0.1763888888, 9);
  expect(next.scaleLocked).toBe(true);
});

test("an invalid drawing scale is ignored", () => {
  expect(placementReducer(BASE, { type: "setDrawingScale", denominator: 0 })).toBe(BASE);
});

test("distance calibration locks the scale", () => {
  const next = placementReducer(BASE, {
    type: "calibrateDistance",
    artworkDistance: 400,
    realMetres: 70.5556
  });
  expect(next.transform.metresPerPoint).toBeCloseTo(0.1763889, 6);
  expect(next.scaleLocked).toBe(true);
});

test("a locked scale ignores scale-handle drags", () => {
  const locked = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  const dragged = placementReducer(locked, { type: "scale", metresPerPoint: 9 });
  expect(dragged.transform.metresPerPoint).toBeCloseTo(0.1763888888, 9);
});

test("unlocking lets the scale handle work again", () => {
  const locked = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  const unlocked = placementReducer(locked, { type: "unlockScale" });
  expect(placementReducer(unlocked, { type: "scale", metresPerPoint: 0.5 }).transform.metresPerPoint).toBe(
    0.5
  );
});

test("a non-positive scale is rejected", () => {
  expect(placementReducer(BASE, { type: "scale", metresPerPoint: 0 }).transform.metresPerPoint).toBe(
    BASE.transform.metresPerPoint
  );
});

test("the working CRS can be set once the location is known", () => {
  const next = placementReducer(BASE, { type: "setWorkingCrs", workingCrs: "EPSG:6674" });
  expect(next.transform.workingCrs).toBe("EPSG:6674");
  expect(next.transform.mapAnchor).toEqual(BASE.transform.mapAnchor);
});

test("control points are added and removed by id", () => {
  const added = placementReducer(BASE, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  expect(added.controlPoints).toHaveLength(1);
  expect(placementReducer(added, { type: "removeControlPoint", id: "a" }).controlPoints).toHaveLength(
    0
  );
});

test("fitting with fewer than two control points leaves the transform alone", () => {
  const added = placementReducer(BASE, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  expect(placementReducer(added, { type: "fitControlPoints" }).transform).toEqual(added.transform);
});

test("fitting two control points recovers a placement that hits them", () => {
  let state = BASE;
  for (const point of [
    { id: "a", artwork: [0, 0] as [number, number], map: [139.7000, 35.6900] as [number, number] },
    { id: "b", artwork: [500, 0] as [number, number], map: [139.7010, 35.6903] as [number, number] }
  ]) {
    state = placementReducer(state, { type: "addControlPoint", point });
  }
  const fitted = placementReducer(state, { type: "fitControlPoints" });
  const fit = currentResiduals(fitted);
  expect(fit).not.toBeNull();
  expect(fit!.rmse).toBeLessThan(0.01);
});

test("fitting keeps a locked scale", () => {
  let state = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  for (const point of [
    { id: "a", artwork: [0, 0] as [number, number], map: [139.7000, 35.6900] as [number, number] },
    { id: "b", artwork: [500, 0] as [number, number], map: [139.7010, 35.6903] as [number, number] }
  ]) {
    state = placementReducer(state, { type: "addControlPoint", point });
  }
  const fitted = placementReducer(state, { type: "fitControlPoints" });
  expect(fitted.transform.metresPerPoint).toBeCloseTo(0.1763888888, 9);
});

test("a fitted anchor is stored as lon/lat, not metres", () => {
  let state = BASE;
  for (const point of [
    { id: "a", artwork: [0, 0] as [number, number], map: [139.7000, 35.6900] as [number, number] },
    { id: "b", artwork: [500, 0] as [number, number], map: [139.7010, 35.6903] as [number, number] }
  ]) {
    state = placementReducer(state, { type: "addControlPoint", point });
  }
  const fitted = placementReducer(state, { type: "fitControlPoints" });
  expect(fitted.transform.mapAnchor[0]).toBeGreaterThan(139);
  expect(fitted.transform.mapAnchor[0]).toBeLessThan(140);
  expect(fitted.transform.mapAnchor[1]).toBeGreaterThan(35);
  expect(fitted.transform.mapAnchor[1]).toBeLessThan(36);
});

test("applying a saved transform locks the scale", () => {
  const applied = placementReducer(BASE, {
    type: "applyTransform",
    transform: { ...BASE.transform, rotationDeg: 77 }
  });
  expect(applied.transform.rotationDeg).toBe(77);
  expect(applied.scaleLocked).toBe(true);
});

test("payload conversion round-trips", () => {
  const payload = toTransformPayload(BASE.transform);
  expect(payload.working_crs).toBe("EPSG:6677");
  expect(payload.map_anchor).toEqual([139.700258, 35.690921]);
  expect(fromTransformPayload(payload)).toEqual(BASE.transform);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useIllustratorPlacement.test.ts`
Expected: FAIL — cannot resolve `./useIllustratorPlacement`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/hooks/useIllustratorPlacement.ts`:

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

export type ControlPoint = {
  id: string;
  artwork: [number, number];
  /** WGS84 lon/lat. Converted to ENU only for the duration of a fit. */
  map: [number, number];
};

export type PlacementState = {
  transform: SimilarityTransform;
  scaleLocked: boolean;
  controlPoints: ControlPoint[];
};

export type PlacementAction =
  | { type: "moveAnchor"; mapAnchor: [number, number] }
  | { type: "rotate"; rotationDeg: number }
  | { type: "scale"; metresPerPoint: number }
  | { type: "setDrawingScale"; denominator: number }
  | { type: "calibrateDistance"; artworkDistance: number; realMetres: number }
  | { type: "unlockScale" }
  | { type: "setWorkingCrs"; workingCrs: string }
  | { type: "addControlPoint"; point: ControlPoint }
  | { type: "removeControlPoint"; id: string }
  | { type: "fitControlPoints" }
  | { type: "applyTransform"; transform: SimilarityTransform };

function normaliseRotation(degrees: number): number {
  const wrapped = ((degrees + 180) % 360) - 180;
  return wrapped <= -180 ? wrapped + 360 : wrapped;
}

/** Control points as ENU metres about the current anchor. */
function toEnuPairs(state: PlacementState): [number, number][] {
  const [lon0, lat0] = state.transform.mapAnchor;
  return state.controlPoints.map((point) => lngLatToEnu(point.map[0], point.map[1], lon0, lat0));
}

export function placementReducer(state: PlacementState, action: PlacementAction): PlacementState {
  switch (action.type) {
    case "moveAnchor":
      return { ...state, transform: { ...state.transform, mapAnchor: action.mapAnchor } };

    case "rotate":
      return {
        ...state,
        transform: { ...state.transform, rotationDeg: normaliseRotation(action.rotationDeg) }
      };

    case "scale":
      // A locked scale came from the drawing itself; dragging must not destroy it.
      if (state.scaleLocked || !(action.metresPerPoint > 0)) return state;
      return { ...state, transform: { ...state.transform, metresPerPoint: action.metresPerPoint } };

    case "setDrawingScale":
      if (!(action.denominator > 0)) return state;
      return {
        ...state,
        scaleLocked: true,
        transform: {
          ...state.transform,
          metresPerPoint: metresPerPointForScale(action.denominator)
        }
      };

    case "calibrateDistance":
      if (!(action.artworkDistance > 0) || !(action.realMetres > 0)) return state;
      return {
        ...state,
        scaleLocked: true,
        transform: {
          ...state.transform,
          metresPerPoint: action.realMetres / action.artworkDistance
        }
      };

    case "unlockScale":
      return { ...state, scaleLocked: false };

    case "setWorkingCrs":
      return { ...state, transform: { ...state.transform, workingCrs: action.workingCrs } };

    case "addControlPoint":
      return { ...state, controlPoints: [...state.controlPoints, action.point] };

    case "removeControlPoint":
      return {
        ...state,
        controlPoints: state.controlPoints.filter((point) => point.id !== action.id)
      };

    case "fitControlPoints": {
      if (state.controlPoints.length < 2) return state;
      const [lon0, lat0] = state.transform.mapAnchor;
      const fitted = fitHelmert(
        state.controlPoints.map((point) => point.artwork),
        toEnuPairs(state),
        state.transform.workingCrs,
        state.scaleLocked ? state.transform.metresPerPoint : undefined
      );
      // fitHelmert returns the anchor in ENU metres; store lon/lat.
      const [lon, lat] = enuToLngLat(fitted.mapAnchor[0], fitted.mapAnchor[1], lon0, lat0);
      return { ...state, transform: { ...fitted, mapAnchor: [lon, lat] } };
    }

    case "applyTransform":
      return { ...state, transform: action.transform, scaleLocked: true };

    default:
      return state;
  }
}

/** Residuals of the current control points, or null below the fit minimum. */
export function currentResiduals(state: PlacementState): { perPoint: number[]; rmse: number } | null {
  if (state.controlPoints.length < 2) return null;
  return residuals(
    state.transform,
    state.controlPoints.map((point) => point.artwork),
    toEnuPairs(state)
  );
}

export function toTransformPayload(transform: SimilarityTransform): TransformPayload {
  return {
    artwork_anchor: transform.artworkAnchor,
    map_anchor: transform.mapAnchor,
    rotation_deg: transform.rotationDeg,
    metres_per_point: transform.metresPerPoint,
    working_crs: transform.workingCrs
  };
}

export function fromTransformPayload(payload: TransformPayload): SimilarityTransform {
  return {
    artworkAnchor: payload.artwork_anchor,
    mapAnchor: payload.map_anchor,
    rotationDeg: payload.rotation_deg,
    metresPerPoint: payload.metres_per_point,
    workingCrs: payload.working_crs
  };
}

export function useIllustratorPlacement(initial: PlacementState) {
  const [state, dispatch] = useReducer(placementReducer, initial);
  return { state, dispatch };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/useIllustratorPlacement.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useIllustratorPlacement.ts frontend/src/hooks/useIllustratorPlacement.test.ts
git commit -m "feat: placement reducer with scale locking and control-point fitting"
```

---
## Task 13: Placement map and transform handles

**Files:**
- Create: `frontend/src/components/illustrator/TransformHandles.tsx`, `frontend/src/components/illustrator/PlacementMap.tsx`

**Interfaces:**
- Consumes: `BASEMAP_STYLES`, `BASEMAP_ORDER`, `basemapLabel`, `BasemapId` (Task 10); `transformGeoJson`, `toEnuMatrix`, `applyMatrix`, `enuToLngLat`, `lngLatToEnu` (Task 9); `PlacementState`, `PlacementAction` (Task 12).
- Produces: `TransformHandles({ state, dispatch, map, artworkBounds })` rendering nothing and driving the `placement-handles` source; `PlacementMap({ preview, artworkBounds, state, dispatch, pickingControlPoint, onPickMap })`.

- [ ] **Step 1: Write the handles component**

Create `frontend/src/components/illustrator/TransformHandles.tsx`:

```tsx
import { useEffect } from "react";
import type { MapRef } from "react-map-gl/maplibre";

import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { applyMatrix, enuToLngLat, lngLatToEnu, toEnuMatrix } from "../../lib/similarity";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  map: MapRef | null;
  artworkBounds: [number, number, number, number];
};

const HANDLE_SOURCE = "placement-handles";
const HANDLE_LAYER = "placement-handle-circles";

/**
 * Move, rotate and scale gizmo.
 *
 * MapLibre has no transform widget, so the handles are their own GeoJSON source
 * and pointer events are captured on the canvas. Panning is disabled for the
 * duration of a drag and updates are throttled to animation frames. All maths
 * happens in the same local ENU frame the preview uses, so the handles and the
 * artwork can never disagree.
 */
export function TransformHandles({ state, dispatch, map, artworkBounds }: Props) {
  useEffect(() => {
    if (!map) return undefined;
    const instance = map.getMap();
    const canvas = instance.getCanvas();
    const [lon0, lat0] = state.transform.mapAnchor;
    const matrix = toEnuMatrix(state.transform);
    const [minX, minY, maxX, maxY] = artworkBounds;

    const handleAt = (x: number, y: number) => {
      const [east, north] = applyMatrix(matrix, x, y);
      return enuToLngLat(east, north, lon0, lat0);
    };

    const source = instance.getSource(HANDLE_SOURCE) as
      | { setData: (data: unknown) => void }
      | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { role: "anchor" }, geometry: { type: "Point", coordinates: [lon0, lat0] } },
        { type: "Feature", properties: { role: "rotate" }, geometry: { type: "Point", coordinates: handleAt((minX + maxX) / 2, maxY) } },
        { type: "Feature", properties: { role: "scale" }, geometry: { type: "Point", coordinates: handleAt(maxX, minY) } }
      ]
    });

    let active: string | null = null;
    let frame = 0;

    const roleAt = (point: { x: number; y: number }): string | null => {
      if (!instance.getLayer(HANDLE_LAYER)) return null;
      const hits = instance.queryRenderedFeatures([point.x, point.y], { layers: [HANDLE_LAYER] });
      return (hits[0]?.properties?.role as string) ?? null;
    };

    const onDown = (event: any) => {
      const role = roleAt(event.point);
      if (!role) return;
      active = role;
      instance.dragPan.disable();
      canvas.style.cursor = "grabbing";
      event.preventDefault();
    };

    const onMove = (event: any) => {
      if (!active) {
        canvas.style.cursor = roleAt(event.point) ? "grab" : "";
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (active === "anchor") {
          dispatch({ type: "moveAnchor", mapAnchor: [event.lngLat.lng, event.lngLat.lat] });
          return;
        }
        // Offset of the pointer from the anchor, in ENU metres.
        const [east, north] = lngLatToEnu(event.lngLat.lng, event.lngLat.lat, lon0, lat0);

        if (active === "rotate") {
          // ENU +north is true north, which is the frame rotation_deg uses.
          const raw = (Math.atan2(east, north) * 180) / Math.PI;
          const snapped = event.originalEvent?.shiftKey ? Math.round(raw / 15) * 15 : raw;
          dispatch({ type: "rotate", rotationDeg: snapped });
          return;
        }
        if (active === "scale" && !state.scaleLocked) {
          const [ax, ay] = state.transform.artworkAnchor;
          const reach = Math.hypot(maxX - ax, minY - ay);
          if (reach > 0) {
            dispatch({ type: "scale", metresPerPoint: Math.hypot(east, north) / reach });
          }
        }
      });
    };

    const onUp = () => {
      if (!active) return;
      active = null;
      instance.dragPan.enable();
      canvas.style.cursor = "";
    };

    instance.on("mousedown", onDown);
    instance.on("mousemove", onMove);
    instance.on("mouseup", onUp);
    return () => {
      instance.off("mousedown", onDown);
      instance.off("mousemove", onMove);
      instance.off("mouseup", onUp);
      if (frame) cancelAnimationFrame(frame);
      instance.dragPan.enable();
    };
  }, [map, state, dispatch, artworkBounds]);

  return null;
}
```

- [ ] **Step 2: Write the map component**

Create `frontend/src/components/illustrator/PlacementMap.tsx`:

```tsx
import { useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { transformGeoJson } from "../../lib/similarity";
import {
  BASEMAP_ORDER,
  BASEMAP_STYLES,
  basemapLabel,
  type BasemapId
} from "../shared/basemapStyles";
import { Button } from "../ui";
import { TransformHandles } from "./TransformHandles";

type Props = {
  preview: { type: "FeatureCollection"; features: any[] };
  artworkBounds: [number, number, number, number];
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  pickingControlPoint: boolean;
  onPickMap: (lngLat: [number, number]) => void;
};

export function PlacementMap({
  preview,
  artworkBounds,
  state,
  dispatch,
  pickingControlPoint,
  onPickMap
}: Props) {
  const { t } = useUiLanguage();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<BasemapId>("osm");

  const placed = useMemo(
    () => transformGeoJson(preview, state.transform),
    [preview, state.transform]
  );

  const controlPointData = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: state.controlPoints.map((point, index) => ({
        type: "Feature" as const,
        properties: { label: String(index + 1) },
        geometry: { type: "Point" as const, coordinates: point.map }
      }))
    }),
    [state.controlPoints]
  );

  const onClick = (event: MapLayerMouseEvent) => {
    if (!pickingControlPoint) return;
    onPickMap([event.lngLat.lng, event.lngLat.lat]);
  };

  return (
    <div className="relative h-full w-full">
      <MapGL
        ref={mapRef}
        mapLib={import("maplibre-gl")}
        initialViewState={{
          longitude: state.transform.mapAnchor[0],
          latitude: state.transform.mapAnchor[1],
          zoom: 17
        }}
        mapStyle={BASEMAP_STYLES[basemap]}
        style={{ width: "100%", height: "100%" }}
        onLoad={() => setReady(true)}
        onClick={onClick}
        cursor={pickingControlPoint ? "crosshair" : undefined}
      >
        <Source id="placement-artwork" type="geojson" data={placed}>
          <Layer
            id="placement-artwork-fill"
            type="fill"
            filter={["==", ["geometry-type"], "Polygon"]}
            paint={{
              "fill-color": ["coalesce", ["get", "fill_color"], "#3b82f6"],
              "fill-opacity": 0.45
            }}
          />
          <Layer
            id="placement-artwork-line"
            type="line"
            paint={{
              "line-color": [
                "coalesce",
                ["get", "stroke_color"],
                ["get", "fill_color"],
                "#1d4ed8"
              ],
              "line-width": 1
            }}
          />
        </Source>

        <Source id="placement-control-points" type="geojson" data={controlPointData}>
          <Layer
            id="placement-control-point-circles"
            type="circle"
            paint={{
              "circle-radius": 6,
              "circle-color": "#f59e0b",
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2
            }}
          />
        </Source>

        <Source
          id="placement-handles"
          type="geojson"
          data={{ type: "FeatureCollection", features: [] }}
        >
          <Layer
            id="placement-handle-circles"
            type="circle"
            paint={{
              "circle-radius": 8,
              "circle-color": [
                "match",
                ["get", "role"],
                "anchor",
                "#2563eb",
                "rotate",
                "#16a34a",
                "#dc2626"
              ],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2
            }}
          />
        </Source>

        {ready ? (
          <TransformHandles
            state={state}
            dispatch={dispatch}
            map={mapRef.current}
            artworkBounds={artworkBounds}
          />
        ) : null}
      </MapGL>

      <div className="absolute left-3 top-3 flex gap-1 rounded-[var(--radius-md)] bg-white/90 p-1 shadow">
        {BASEMAP_ORDER.map((id) => (
          <Button
            key={id}
            size="sm"
            variant={id === basemap ? "primary" : "secondary"}
            onClick={() => setBasemap(id)}
          >
            {basemapLabel(id, t)}
          </Button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/illustrator/PlacementMap.tsx frontend/src/components/illustrator/TransformHandles.tsx
git commit -m "feat: placement map with basemap switcher and transform gizmo"
```

---

## Task 14: Transform panel, control points and placement library

**Files:**
- Create: `frontend/src/components/illustrator/TransformPanel.tsx`, `ControlPointList.tsx`, `PlacementLibrary.tsx` (all under `frontend/src/components/illustrator/`)

**Interfaces:**
- Consumes: `PlacementState`, `PlacementAction`, `currentResiduals`, `toTransformPayload`, `fromTransformPayload` (Task 12); `geocodeSearch`, `listPlacements`, `createPlacement`, `deletePlacement`, `type GeocodeResultItem`, `type PlacementItem` (Task 11).
- Produces: `TransformPanel({ state, dispatch })`; `ControlPointList({ state, dispatch, picking, onTogglePicking })`; `PlacementLibrary({ state, dispatch, artworkBounds })`.

- [ ] **Step 1: Write the transform panel**

Create `frontend/src/components/illustrator/TransformPanel.tsx`:

```tsx
import { useState } from "react";

import { geocodeSearch, type GeocodeResultItem } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
};

const FIELD = "w-full rounded-[var(--radius-md)] border px-2 py-1";

export function TransformPanel({ state, dispatch }: Props) {
  const { t, uiLanguage } = useUiLanguage();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [denominator, setDenominator] = useState("500");
  const [artworkDistance, setArtworkDistance] = useState("");
  const [realMetres, setRealMetres] = useState("");

  const runSearch = async () => {
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await geocodeSearch(query, uiLanguage));
    } catch {
      // Search is a convenience; placement stays usable by panning.
      setSearchError(
        t(
          "Address search is unavailable. Pan the map to the building instead.",
          "住所検索を利用できません。地図を手動で移動してください。"
        )
      );
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <section>
        <label className="block text-xs font-medium">{t("Find the building", "建物を検索")}</label>
        <div className="mt-1 flex gap-2">
          <input
            className={FIELD}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
            placeholder={t("e.g. 新宿駅", "例: 新宿駅")}
          />
          <Button size="sm" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
            {searching ? t("Searching...", "検索中...") : t("Search", "検索")}
          </Button>
        </div>
        {searchError ? (
          <p className="mt-1 text-xs text-[var(--color-error)]">{searchError}</p>
        ) : null}
        {results.length > 0 ? (
          <ul className="mt-1 max-h-40 overflow-auto rounded-[var(--radius-md)] border">
            {results.map((result) => (
              <li key={`${result.latitude},${result.longitude}`}>
                <button
                  type="button"
                  className="w-full px-2 py-1 text-left text-xs hover:bg-black/5"
                  onClick={() =>
                    dispatch({
                      type: "moveAnchor",
                      mapAnchor: [result.longitude, result.latitude]
                    })
                  }
                >
                  {result.display_name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <label className="block text-xs font-medium">
          {t("Rotation (from true north)", "回転（真北基準）")}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="number"
            step="0.1"
            className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
            value={state.transform.rotationDeg}
            onChange={(event) =>
              dispatch({ type: "rotate", rotationDeg: Number(event.target.value) })
            }
          />
          <span className="text-xs text-[var(--color-text-muted)]">°</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => dispatch({ type: "rotate", rotationDeg: 0 })}
          >
            {t("Reset", "リセット")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {t("Hold Shift while dragging to snap to 15°.", "ドラッグ中に Shift で15度刻み。")}
        </p>
      </section>

      <section>
        <label className="block text-xs font-medium">
          {t("Scale", "縮尺")}{" "}
          {state.scaleLocked ? (
            <span className="text-[var(--color-success)]">{t("(locked)", "（固定）")}</span>
          ) : null}
        </label>
        <p className="mt-1 text-xs">
          {state.transform.metresPerPoint.toFixed(6)} {t("m per point", "m/pt")}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-xs">1:</span>
          <input
            type="number"
            className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
            value={denominator}
            onChange={(event) => setDenominator(event.target.value)}
          />
          <Button
            size="sm"
            onClick={() => dispatch({ type: "setDrawingScale", denominator: Number(denominator) })}
          >
            {t("Apply", "適用")}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            className="w-20 rounded-[var(--radius-md)] border px-2 py-1"
            placeholder="pt"
            value={artworkDistance}
            onChange={(event) => setArtworkDistance(event.target.value)}
          />
          <span className="text-xs">=</span>
          <input
            type="number"
            className="w-20 rounded-[var(--radius-md)] border px-2 py-1"
            placeholder="m"
            value={realMetres}
            onChange={(event) => setRealMetres(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              dispatch({
                type: "calibrateDistance",
                artworkDistance: Number(artworkDistance),
                realMetres: Number(realMetres)
              })
            }
          >
            {t("Calibrate", "校正")}
          </Button>
        </div>
        {state.scaleLocked ? (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => dispatch({ type: "unlockScale" })}
          >
            {t("Unlock scale", "縮尺の固定を解除")}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Write the control-point list**

Create `frontend/src/components/illustrator/ControlPointList.tsx`:

```tsx
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  currentResiduals,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  picking: boolean;
  onTogglePicking: () => void;
};

export function ControlPointList({ state, dispatch, picking, onTogglePicking }: Props) {
  const { t } = useUiLanguage();
  const fit = currentResiduals(state);

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t("Control points", "基準点")}</span>
        <Button size="sm" variant={picking ? "primary" : "secondary"} onClick={onTogglePicking}>
          {picking ? t("Click the map...", "地図をクリック...") : t("Add point", "点を追加")}
        </Button>
      </div>

      {state.controlPoints.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(
            "Optional. Use these when the basemap shows the building.",
            "任意。地図に建物が表示されている場合に使用します。"
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {state.controlPoints.map((point, index) => (
            <li key={point.id} className="flex items-center justify-between text-xs">
              <span>
                #{index + 1} ({point.artwork[0].toFixed(1)}, {point.artwork[1].toFixed(1)}) pt
                {fit ? ` — ${fit.perPoint[index].toFixed(2)} m` : ""}
              </span>
              <button
                type="button"
                className="text-[var(--color-error)]"
                onClick={() => dispatch({ type: "removeControlPoint", id: point.id })}
              >
                {t("Remove", "削除")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {fit ? (
        <p className="text-xs">
          RMSE: <strong>{fit.rmse.toFixed(2)} m</strong>
        </p>
      ) : null}

      <Button
        size="sm"
        className="w-full"
        disabled={state.controlPoints.length < 2}
        onClick={() => dispatch({ type: "fitControlPoints" })}
      >
        {t("Fit to control points", "基準点に合わせる")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Write the placement library**

Create `frontend/src/components/illustrator/PlacementLibrary.tsx`:

```tsx
import { useEffect, useState } from "react";

import {
  createPlacement,
  deletePlacement,
  listPlacements,
  type PlacementItem
} from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  fromTransformPayload,
  toTransformPayload,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  artworkBounds: [number, number, number, number];
};

/** Warn when a saved placement was authored against a different artboard. */
function boundsWarning(
  saved: [number, number, number, number],
  current: [number, number, number, number]
): boolean {
  const savedW = saved[2] - saved[0];
  const savedH = saved[3] - saved[1];
  if (savedW <= 0 || savedH <= 0) return false;
  return (
    Math.abs(current[2] - current[0] - savedW) / savedW > 0.01 ||
    Math.abs(current[3] - current[1] - savedH) / savedH > 0.01
  );
}

export function PlacementLibrary({ state, dispatch, artworkBounds }: Props) {
  const { t } = useUiLanguage();
  const [placements, setPlacements] = useState<PlacementItem[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setPlacements(await listPlacements());
    } catch {
      setError(t("Could not load saved placements.", "保存済み配置を読み込めません。"));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    setError(null);
    try {
      await createPlacement({
        name: name.trim(),
        transform: toTransformPayload(state.transform),
        artwork_bounds: artworkBounds
      });
      setName("");
      await refresh();
    } catch {
      setError(t("That name is already taken.", "その名前は既に使用されています。"));
    }
  };

  const apply = (placement: PlacementItem) => {
    dispatch({ type: "applyTransform", transform: fromTransformPayload(placement.transform) });
    setWarning(
      boundsWarning(placement.artwork_bounds, artworkBounds)
        ? t(
            "This drawing's artboard differs from the saved placement. Check the alignment.",
            "この図面のアートボードは保存時と異なります。位置合わせを確認してください。"
          )
        : null
    );
  };

  return (
    <div className="space-y-2 text-sm">
      <span className="text-xs font-medium">{t("Saved placements", "保存済み配置")}</span>
      <div className="flex gap-2">
        <input
          className="w-full rounded-[var(--radius-md)] border px-2 py-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("Building name", "建物名")}
        />
        <Button size="sm" disabled={!name.trim()} onClick={() => void save()}>
          {t("Save", "保存")}
        </Button>
      </div>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      {warning ? <p className="text-xs text-[var(--color-warning)]">{warning}</p> : null}
      <ul className="space-y-1">
        {placements.map((placement) => (
          <li key={placement.id} className="flex items-center justify-between text-xs">
            <button type="button" className="text-left underline" onClick={() => apply(placement)}>
              {placement.name}
            </button>
            <button
              type="button"
              className="text-[var(--color-error)]"
              onClick={async () => {
                await deletePlacement(placement.id);
                await refresh();
              }}
            >
              {t("Delete", "削除")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/illustrator/TransformPanel.tsx frontend/src/components/illustrator/ControlPointList.tsx frontend/src/components/illustrator/PlacementLibrary.tsx
git commit -m "feat: transform panel, control-point list and placement library"
```

---
## Task 15: Illustrator page, route and Upload rewire

**Files:**
- Create: `frontend/src/pages/IllustratorPage.tsx`
- Modify: `frontend/src/App.tsx:17-22`, `frontend/src/pages/UploadPage.tsx:697-750`

**Interfaces:**
- Consumes: `previewIllustrator`, `exportIllustrator`, `type IllustratorPreviewResponse` (Task 11); `useIllustratorPlacement`, `toTransformPayload` (Task 12); `PlacementMap` (Task 13); `TransformPanel`, `ControlPointList`, `PlacementLibrary` (Task 14); `lngLatToEnu` is not needed here.
- Produces: route `/illustrator`.

- [ ] **Step 1: Write the page**

Create `frontend/src/pages/IllustratorPage.tsx`:

```tsx
import { useState } from "react";

import {
  exportIllustrator,
  previewIllustrator,
  type ExportFormatsPayload,
  type IllustratorPreviewResponse
} from "../api/client";
import { ControlPointList } from "../components/illustrator/ControlPointList";
import { PlacementLibrary } from "../components/illustrator/PlacementLibrary";
import { PlacementMap } from "../components/illustrator/PlacementMap";
import { TransformPanel } from "../components/illustrator/TransformPanel";
import { Button, Card } from "../components/ui";
import {
  placementReducer,
  toTransformPayload,
  type PlacementState
} from "../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { useReducer } from "react";

const CRS_CHOICES = (suggested: string, suggestedLabel: string) => [
  { value: suggested, label: suggestedLabel },
  { value: "EPSG:4326", label: "EPSG:4326 — WGS84 lon/lat" }
];

function initialState(preview: IllustratorPreviewResponse): PlacementState {
  const [minX, minY, maxX, maxY] = preview.artwork_bounds;
  return {
    transform: {
      // The anchor is set once, at the artwork centre, and never recomputed.
      artworkAnchor: [(minX + maxX) / 2, (minY + maxY) / 2],
      mapAnchor: [139.7671, 35.6812],
      rotationDeg: 0,
      metresPerPoint: 0.176389,
      workingCrs: preview.suggested_crs
    },
    scaleLocked: false,
    controlPoints: []
  };
}

export function IllustratorPage() {
  const { t } = useUiLanguage();
  const [preview, setPreview] = useState<IllustratorPreviewResponse | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [outputCrs, setOutputCrs] = useState("EPSG:4326");
  const [formats, setFormats] = useState<ExportFormatsPayload>({
    geopackage: true,
    shapefile: true,
    qgis: true
  });
  const [state, dispatch] = useReducer(
    placementReducer,
    null as unknown as PlacementState,
    () => ({
      transform: {
        artworkAnchor: [0, 0],
        mapAnchor: [139.7671, 35.6812],
        rotationDeg: 0,
        metresPerPoint: 0.176389,
        workingCrs: "EPSG:6677"
      },
      scaleLocked: false,
      controlPoints: []
    })
  );

  const convert = async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const response = await previewIllustrator(file);
      setPreview(response);
      setLastFile(file);
      setOutputCrs(response.suggested_crs);
      dispatch({ type: "applyTransform", transform: initialState(response).transform });
      dispatch({ type: "unlockScale" });
    } catch {
      setError(
        t(
          "Could not read that file. Re-save the .ai with 'Create PDF Compatible File' enabled.",
          "ファイルを読み込めません。「PDF互換ファイルを作成」を有効にして保存し直してください。"
        )
      );
    } finally {
      setLoading(false);
    }
  };

  const download = async () => {
    if (!preview) return;
    setError(null);
    try {
      const result = await exportIllustrator(preview.conversion_id, {
        transform: toTransformPayload(state.transform),
        output_crs: outputCrs,
        formats
      });
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      // The cache may have expired; the browser still holds the file.
      setError(
        t(
          "The conversion expired. Convert the file again.",
          "変換の有効期限が切れました。もう一度変換してください。"
        )
      );
      if (lastFile) void convert(lastFile);
    }
  };

  if (!preview) {
    return (
      <div className="flex flex-1 items-start justify-center px-4 py-10">
        <Card padding="lg" className="w-full max-w-2xl">
          <h1 className="text-lg font-semibold">
            {t("Place Illustrator artwork", "Illustrator図面の配置")}
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {t(
              "Convert an .ai file, position it on the map, then export georeferenced files.",
              ".ai を変換し、地図上に配置してから、座標付きファイルを書き出します。"
            )}
          </p>
          <input
            type="file"
            accept=".ai,.pdf"
            className="hidden"
            id="illustrator-georef-input"
            disabled={loading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void convert(file);
              event.target.value = "";
            }}
          />
          <Button
            className="mt-4 w-full"
            disabled={loading}
            onClick={() => document.getElementById("illustrator-georef-input")?.click()}
          >
            {loading ? t("Converting...", "変換中...") : t("Choose .ai file", ".ai を選択")}
          </Button>
          {error ? (
            <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p>
          ) : null}
        </Card>
      </div>
    );
  }

  const bounds = preview.artwork_bounds;

  return (
    <div className="flex flex-1 gap-4 p-4">
      <div className="w-80 shrink-0 space-y-4 overflow-auto">
        <Card padding="md">
          <TransformPanel state={state} dispatch={dispatch} />
        </Card>
        <Card padding="md">
          <ControlPointList
            state={state}
            dispatch={dispatch}
            picking={picking}
            onTogglePicking={() => setPicking((value) => !value)}
          />
        </Card>
        <Card padding="md">
          <PlacementLibrary state={state} dispatch={dispatch} artworkBounds={bounds} />
        </Card>
        <Card padding="md">
          <span className="text-xs font-medium">{t("Export", "書き出し")}</span>
          <select
            className="mt-1 w-full rounded-[var(--radius-md)] border px-2 py-1 text-sm"
            value={outputCrs}
            onChange={(event) => setOutputCrs(event.target.value)}
          >
            {CRS_CHOICES(preview.suggested_crs, preview.suggested_crs_label).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {(["geopackage", "shapefile", "qgis"] as const).map((key) => (
            <label key={key} className="mt-1 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={formats[key]}
                onChange={(event) => setFormats({ ...formats, [key]: event.target.checked })}
              />
              {key}
            </label>
          ))}
          <Button className="mt-2 w-full" onClick={() => void download()}>
            {t("Export", "書き出し")}
          </Button>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {t(
              `Preview shows ${preview.preview_features} of ${preview.total_features} shapes.`,
              `プレビューは ${preview.total_features} 図形中 ${preview.preview_features} 件を表示。`
            )}
          </p>
          {error ? <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p> : null}
        </Card>
      </div>

      <div className="min-h-[600px] flex-1 overflow-hidden rounded-[var(--radius-md)] border">
        <PlacementMap
          preview={preview.preview}
          artworkBounds={bounds}
          state={state}
          dispatch={dispatch}
          pickingControlPoint={picking}
          onPickMap={(lngLat) => {
            dispatch({
              type: "addControlPoint",
              point: {
                id: `${Date.now()}`,
                artwork: state.transform.artworkAnchor,
                map: lngLat
              }
            });
            setPicking(false);
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

In `frontend/src/App.tsx`, add the import beside the other pages and a route inside `<Routes>`:

```tsx
import { IllustratorPage } from "./pages/IllustratorPage";
```

```tsx
            <Route path="/illustrator" element={<IllustratorPage />} />
```

Place it after the `/review` route and before the catch-all `<Route path="*" ... />`.

- [ ] **Step 3: Rewire the Upload page button**

In `frontend/src/pages/UploadPage.tsx`, replace the Illustrator block at lines 697-750 with a
navigation action. Add `useNavigate` to the existing `react-router-dom` usage, then:

```tsx
        {/* Illustrator (.ai) -> georeferenced export */}
        <div className="mt-4">
          <Button variant="secondary" className="w-full" onClick={() => navigate("/illustrator")}>
            {t("Illustrator (.ai) → place on map", "Illustrator (.ai) → 地図に配置")}
          </Button>
          <p className="mt-1 text-center text-xs text-[var(--color-text-muted)]">
            {t(
              "Convert .ai layers, position them on the map, then export GeoPackage, shapefiles and a QGIS project",
              ".ai のレイヤーを変換し地図に配置して、GeoPackage・シェープファイル・QGISプロジェクトを書き出し"
            )}
          </p>
        </div>
```

Then delete the now-unused `aiLoading`, `aiError`, `aiReport` state declarations (around line
117), the `runIllustratorConvert` function (around line 291), and the `convertIllustrator` /
`IllustratorConversionReport` imports if nothing else uses them.

- [ ] **Step 4: Verify build and the existing frontend suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass, including the pre-existing `App.test.tsx`,
`ReviewPage.test.tsx`, `HoursEditor.test.tsx` and `TablePanel.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/IllustratorPage.tsx frontend/src/App.tsx frontend/src/pages/UploadPage.tsx
git commit -m "feat: Illustrator placement page wired into the app"
```

---

## Task 16: Smoke test and documentation

**Files:**
- Modify: `README.md:63`, `CLAUDE.md:28-38`

**Interfaces:**
- Consumes: everything.
- Produces: no code.

- [ ] **Step 1: Run the whole test suite**

Run: `pytest backend/tests -v`
Then: `cd frontend && npm run test && npm run build`
Expected: all pass. Fix anything that does not before continuing.

- [ ] **Step 2: Smoke test against a real file**

Start the app with `./dev.ps1`, then:

1. Open `http://localhost:5173/illustrator` and load a real station `.ai`.
2. Confirm the report shows a plausible layer and shape count.
3. Search for the building by name; confirm the map flies there and the artwork appears.
4. Set the drawing scale (e.g. `1:500`) and confirm the scale field locks.
5. Drag, rotate (with and without Shift), and confirm the artwork tracks the cursor without
   the map panning underneath.
6. Switch to the GSI aerial basemap and confirm the roof is visible.
7. Export with all three formats to EPSG:6677.
8. Open the `.qgs` from the zip in QGIS over an imagery layer and confirm the artwork sits on
   the building. **This is the acceptance test for the whole feature.**
9. Save the placement under a name, convert a second floor of the same building, apply the
   saved placement, and confirm it lands in the same spot.

- [ ] **Step 3: Update the README**

In `README.md`, replace the Illustrator bullet at line 63 with:

```markdown
- Standalone Adobe Illustrator (`.ai`) → georeferenced GeoPackage, shapefiles and QGIS
  project: search for the building, place the artwork on OSM or GSI aerial imagery with a
  scale derived from the drawing, then export in a chosen CRS. Placements can be saved by
  name and reapplied to the other floors of the same building.
```

- [ ] **Step 4: Update CLAUDE.md**

In `CLAUDE.md`, add to the test-markers section after the `phase5` line:

```bash
pytest -m georef     # Illustrator georeferencing (transform, zones, placement)
```

and add to the Layout table:

```markdown
| `data/placements.db` | Saved Illustrator placements (SQLite, gitignored) |
```

Add to Notes:

```markdown
- Illustrator placement stores `rotation_deg` against **true north**; the backend subtracts
  the meridian convergence when building a projected affine. The preview runs in a local ENU
  frame for the same reason — Web Mercator is not conformal on the ellipsoid and was measured
  23 cm out. The cross-language golden fixture in `test_illustrator_georeference.py` and
  `similarity.test.ts` is what keeps the two implementations honest; if you change one, run
  both.
```

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document Illustrator georeferencing"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: transform model → 1; control
points → 2; zone auto-pick → 3; QGIS CRS → 4; conversion cache → 5; preview decimation and
export → 6; endpoints, error handling and env → 7; placement library → 8; frontend maths and
parity → 9; basemaps → 10; client → 11; reducer → 12; map and gizmo → 13; panels → 14; page,
route and rewire → 15; smoke test and docs → 16.

**Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task N". Every code
step carries the real code.

**Type consistency.** `SimilarityTransform` uses snake_case fields in Python and camelCase in
TypeScript, converted only at the API boundary by `toTransformPayload` /
`fromTransformPayload`. `ControlPoint.map` is lon/lat everywhere; ENU conversion happens only
inside `fitControlPoints` and `currentResiduals`. `build_qgs_project(..., crs=None)` keeps the
existing call site in `convert_ai_to_geopackage_bundle` valid.

**Deviations from the spec, both measured.**

1. The spec's cross-language fixture was to be coordinate-identical. It cannot be: Python
   works in EPSG:6677 and TypeScript has no projection library. The fixture instead asserts
   the shared WGS84 output to 6 decimal degrees (~5.5 cm), which passes the correct
   implementation at 0.58 cm and fails both known failure modes.
2. `rotation_deg` moved from grid north to **true north** after measurement showed the
   grid-north definition put a 59 m artwork 8 cm out and a 2.4 km site ~3 m out. The spec has
   been updated to match.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-illustrator-georeferencing.md`.
Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast
   iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution
   with checkpoints.
