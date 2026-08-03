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
