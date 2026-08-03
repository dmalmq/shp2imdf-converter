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
