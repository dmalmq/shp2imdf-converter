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


from backend.src.illustrator_georeference import fit_helmert, residuals


def _synthesise_pairs(rotation_deg: float, scale: float) -> tuple[list, list]:
    """Artwork points, and the WGS84 points a known transform maps them to.

    The truth transform anchors at the artwork centroid so that the fitted
    centroid lands exactly on the truth anchor: a fitted rotation is expressed
    about the fit's own anchor, and comparing it against a rotation expressed
    about a different anchor would carry the meridian-convergence gradient.
    """
    artwork = [(0.0, 0.0), (500.0, 0.0), (500.0, 300.0)]
    centroid = (sum(x for x, _ in artwork) / 3, sum(y for _, y in artwork) / 3)
    truth = SimilarityTransform(
        artwork_anchor=centroid,
        map_anchor=(GOLDEN_ANCHOR_LON, GOLDEN_ANCHOR_LAT),
        rotation_deg=rotation_deg,
        metres_per_point=scale,
        working_crs="EPSG:6677",
    )
    matrix = truth.to_affine_matrix()
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
