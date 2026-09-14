"""Consensus snap of every large artwork outline onto posted Station_pg polygons."""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from shapely.affinity import affine_transform
from shapely.affinity import rotate
from shapely.affinity import translate
from shapely.geometry import LineString
from shapely.geometry import Polygon
from shapely.geometry import shape

from backend.src.illustrator_georeference import SimilarityTransform
from backend.src.illustrator_georeference import project_point
from backend.src.illustrator_outline_match import build_candidates
from backend.src.illustrator_outline_match import outline_match
from backend.src.illustrator_store import ConversionStore
from backend.src.illustrator_survey_snap import match_survey_consensus
from backend.tests.test_illustrator_region_match import _install_cached
from backend.tests.test_illustrator_shape_match import TRUTH_ANCHOR
from backend.tests.test_illustrator_shape_match import WORKING_CRS
from backend.tests.test_illustrator_shape_match import _cached_shapes
from backend.tests.test_illustrator_shape_match import _collection
from backend.tests.test_illustrator_shape_match import _page_floors
from backend.tests.test_illustrator_shape_match import _placed_wgs84

# 1:1000, the locked drawing scale of every station plan.
SCALE = 0.3528
SURVEY_ROTATION = 18.0
SHEET_ANCHOR = (570.0, 500.0)


def _platform(x: float, y: float, length: float, width: float) -> Polygon:
    """A platform strip with one tapered end, so its 180° flip is a different shape."""
    taper = width * 0.3
    return Polygon(
        [
            (x, y),
            (x + length, y),
            (x + length + 40.0, y + taper),
            (x + length + 40.0, y + width - taper),
            (x + length, y + width),
            (x, y + width),
            (x, y),
        ]
    )


# Five parallel platforms of unequal length, width, offset and spacing, like a
# real station and unlike a grid, so a pose shifted by one platform pairs badly.
PLATFORMS = [
    _platform(100.0, 100.0, 900.0, 40.0),
    _platform(160.0, 190.0, 700.0, 30.0),
    _platform(90.0, 310.0, 950.0, 45.0),
    _platform(220.0, 385.0, 600.0, 28.0),
    _platform(130.0, 525.0, 800.0, 60.0),
]
# The drawn whole-station outline: the largest artwork shape, U-shaped.
STATION_OUTLINE = Polygon(
    [
        (150.0, 640.0),
        (650.0, 640.0),
        (650.0, 1080.0),
        (500.0, 1080.0),
        (500.0, 800.0),
        (300.0, 800.0),
        (300.0, 1080.0),
        (150.0, 1080.0),
        (150.0, 640.0),
    ]
)
# The surveyed station building, the largest Station_pg polygon, covering only
# part of the drawn outline at a different angle.
HONYA = translate(rotate(Polygon([(0, 0), (400, 0), (400, 400), (0, 400)]), 20.0, origin=(0, 0)), 230.0, 680.0)
FLIPPED_PLATFORM = translate(rotate(PLATFORMS[0], 180.0, origin="centroid"), 0.0, -150.0)
UNDRAWN_PLATFORM = _platform(140.0, 1150.0, 850.0, 38.0)
SHEDS = [translate(Polygon([(0, 0), (110, 0), (110, 85), (0, 85)]), 700.0 + i * 150.0, 900.0) for i in range(3)]
KIOSK = Polygon([(700.0, 700.0), (720.0, 700.0), (720.0, 720.0), (700.0, 720.0)])


def _survey_truth() -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=SHEET_ANCHOR,
        map_anchor=TRUTH_ANCHOR,
        rotation_deg=SURVEY_ROTATION,
        metres_per_point=SCALE,
        working_crs=WORKING_CRS,
    )


def _current() -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=SHEET_ANCHOR,
        map_anchor=TRUTH_ANCHOR,
        rotation_deg=0.0,
        metres_per_point=SCALE,
        working_crs=WORKING_CRS,
    )


def _surveyed(index: int, platform: Polygon) -> Polygon:
    """Each survey platform sits a little off the drawing, like a real digitisation."""
    moved = rotate(platform, (index - 2) * 0.15, origin="centroid")
    return translate(moved, (index - 2) * 3.0, (2 - index) * 2.0)


def _survey_collection(platforms=PLATFORMS, truth: SimilarityTransform | None = None) -> dict:
    truth = truth or _survey_truth()
    shapes = [_surveyed(index, platform) for index, platform in enumerate(platforms)]
    shapes += [HONYA, FLIPPED_PLATFORM, UNDRAWN_PLATFORM, *SHEDS]
    return _collection(*(_placed_wgs84(geom, truth) for geom in shapes))


def _station_artwork(directory: Path, *, assigned: bool = True):
    """Two platforms on page 1 (1F) and three plus the outline on page 2 (2F)."""
    directory.mkdir(parents=True, exist_ok=True)
    return _cached_shapes(
        directory,
        [*PLATFORMS, STATION_OUTLINE, KIOSK],
        floors=_page_floors("1F", "2F") if assigned else None,
        pages=[1, 1, 2, 2, 2, 2, 2],
    )


def _anchor_error_m(transform: dict) -> float:
    got = project_point(*transform["map_anchor"], WORKING_CRS)
    want = project_point(*TRUTH_ANCHOR, WORKING_CRS)
    return math.dist(got, want)


def _as_transform(payload: dict) -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=tuple(payload["artwork_anchor"]),
        map_anchor=tuple(payload["map_anchor"]),
        rotation_deg=payload["rotation_deg"],
        metres_per_point=payload["metres_per_point"],
        working_crs=payload["working_crs"],
    )


def _iou(left, right) -> float:
    return float(left.intersection(right).area / left.union(right).area)


@pytest.mark.georef
def test_platforms_across_floors_vote_the_survey_pose(tmp_path: Path) -> None:
    cached = _station_artwork(tmp_path)
    match = match_survey_consensus(cached, reference=_survey_collection(), current=_current())
    assert match is not None
    assert match["rank"] == 1
    transform = match["transform"]
    assert transform["rotation_deg"] == pytest.approx(SURVEY_ROTATION, abs=0.5)
    assert transform["metres_per_point"] == SCALE
    assert transform["working_crs"] == WORKING_CRS
    assert transform["artwork_anchor"] == [SHEET_ANCHOR[0], SHEET_ANCHOR[1]]
    assert _anchor_error_m(transform) < 3.0
    assert match["overlap_iou"] > 0.9
    assert match["boundary_rmse_m"] < 1.0
    assert len(match["residual_vectors"]) == 12
    # The ghost is every survey polygon that voted: all five platforms, which
    # only happens when both floors' outlines are collected.
    ghost = shape(match["reference_geometry"])
    assert ghost.geom_type == "MultiPolygon"
    assert len(ghost.geoms) == 5


@pytest.mark.georef
def test_largest_pair_overlaps_poorly_and_does_not_decide(tmp_path: Path) -> None:
    truth = _survey_truth()
    matrix = truth.to_affine_matrix()
    outline = build_candidates([STATION_OUTLINE], minimum_area=0.0, limit=1)[0]
    honya = build_candidates([affine_transform(HONYA, matrix)], minimum_area=0.0, limit=1)[0]
    sheet = (1200.0, 1200.0)
    largest = outline_match(outline, honya, sheet, fixed_scale=SCALE, min_iou=0.0, max_normalized_rmse=1e9)
    platform_ious = []
    for index, platform in enumerate(PLATFORMS):
        source = build_candidates([platform], minimum_area=0.0, limit=1)[0]
        target = build_candidates([affine_transform(_surveyed(index, platform), matrix)], minimum_area=0.0, limit=1)[0]
        fitted = outline_match(source, target, sheet, fixed_scale=SCALE, min_iou=0.0, max_normalized_rmse=1e9)
        platform_ious.append(fitted.overlap_iou)
    assert largest.overlap_iou < 0.55
    assert min(platform_ious) > 0.95
    assert largest.overlap_iou / min(platform_ious) < 0.6

    cached = _station_artwork(tmp_path)
    match = match_survey_consensus(cached, reference=_survey_collection(), current=_current())
    assert match is not None
    snapped = _as_transform(match["transform"]).to_affine_matrix()
    for index, platform in enumerate(PLATFORMS):
        placed = affine_transform(platform, snapped)
        assert _iou(placed, affine_transform(_surveyed(index, platform), matrix)) > 0.8
    assert _iou(affine_transform(STATION_OUTLINE, snapped), affine_transform(HONYA, matrix)) < 0.6


@pytest.mark.georef
def test_two_agreeing_platforms_are_not_a_consensus(tmp_path: Path) -> None:
    cached = _station_artwork(tmp_path)
    reference = _survey_collection(PLATFORMS[:2])
    assert match_survey_consensus(cached, reference=reference, current=_current()) is None


@pytest.mark.georef
def test_two_equally_supported_poses_are_not_a_consensus(tmp_path: Path) -> None:
    cached = _station_artwork(tmp_path)
    truth = _survey_truth()
    mirrored = SimilarityTransform(
        artwork_anchor=SHEET_ANCHOR,
        map_anchor=(TRUTH_ANCHOR[0] + 0.004, TRUTH_ANCHOR[1]),
        rotation_deg=SURVEY_ROTATION + 180.0,
        metres_per_point=SCALE,
        working_crs=WORKING_CRS,
    )
    reference = _survey_collection(truth=truth)
    reference["features"] += _survey_collection(truth=mirrored)["features"]
    assert match_survey_consensus(cached, reference=reference, current=_current()) is None


@pytest.mark.georef
def test_missing_assignment_raises_the_assignment_error(tmp_path: Path) -> None:
    cached = _station_artwork(tmp_path, assigned=False)
    with pytest.raises(ValueError, match="No floor assignment"):
        match_survey_consensus(cached, reference=_survey_collection(), current=_current())


@pytest.mark.georef
def test_unclosable_strokes_are_not_outlines(tmp_path: Path) -> None:
    segment = LineString([(0.0, 0.0), (900.0, 300.0)])
    collinear = LineString([(10.0, 10.0), (20.0, 20.0), (30.0, 30.0)])
    (tmp_path / "segments").mkdir()
    only_segments = _cached_shapes(
        tmp_path / "segments",
        [segment, collinear],
        roles=["line", "line"],
        floors=_page_floors("1F"),
    )
    assert match_survey_consensus(only_segments, reference=_survey_collection(), current=_current()) is None

    rings = [LineString(platform.exterior.coords) for platform in PLATFORMS]
    (tmp_path / "strokes").mkdir()
    stroked = _cached_shapes(
        tmp_path / "strokes",
        [*rings, segment, collinear],
        roles=["line"] * 7,
        floors=_page_floors("1F"),
    )
    match = match_survey_consensus(stroked, reference=_survey_collection(), current=_current())
    assert match is not None
    assert match["transform"]["rotation_deg"] == pytest.approx(SURVEY_ROTATION, abs=0.5)


def _transform_payload(transform: SimilarityTransform) -> dict:
    return {
        "artwork_anchor": list(transform.artwork_anchor),
        "map_anchor": list(transform.map_anchor),
        "rotation_deg": transform.rotation_deg,
        "metres_per_point": transform.metres_per_point,
        "working_crs": transform.working_crs,
    }


@pytest.mark.georef
def test_survey_snap_endpoint_returns_the_consensus_or_null(test_client, tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path / "illustrator", ttl_seconds=3600, max_entries=5)
    assigned = _install_cached(store, _station_artwork(tmp_path / "assigned"))
    unassigned_cached = _station_artwork(tmp_path / "unassigned", assigned=False)
    unassigned_cached.conversion_id = "unassigned"
    unassigned = _install_cached(store, unassigned_cached)
    previous = test_client.app.state.illustrator_store
    test_client.app.state.illustrator_store = store
    try:
        body = {
            "current_transform": _transform_payload(_current()),
            "scale_locked": False,
            "reference": _survey_collection(),
        }
        response = test_client.post(f"/api/convert/illustrator/{assigned}/survey-snap", json=body)
        assert response.status_code == 200, response.text
        match = response.json()["match"]
        assert match["transform"]["rotation_deg"] == pytest.approx(SURVEY_ROTATION, abs=0.5)
        assert match["transform"]["metres_per_point"] == SCALE
        assert match["reference_geometry"]["type"] == "MultiPolygon"

        weak = {**body, "reference": _survey_collection(PLATFORMS[:2])}
        response = test_client.post(f"/api/convert/illustrator/{assigned}/survey-snap", json=weak)
        assert response.status_code == 200, response.text
        assert response.json() == {"match": None, "reason": "no_consensus"}

        response = test_client.post(f"/api/convert/illustrator/{unassigned}/survey-snap", json=body)
        assert response.status_code == 400
        assert "No floor assignment" in response.json()["detail"]
    finally:
        test_client.app.state.illustrator_store = previous
