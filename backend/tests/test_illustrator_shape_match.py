"""Selected-outline matching against posted WGS84 reference polygons."""

from __future__ import annotations

import time
import warnings
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.affinity import affine_transform
from shapely.geometry import LineString
from shapely.geometry import MultiLineString
from shapely.geometry import Point
from shapely.geometry import Polygon
from shapely.geometry import mapping
from shapely.geometry import shape

from backend.src.illustrator_export import build_preview
from backend.src.illustrator_georeference import SimilarityTransform
from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_shape_match import match_shapes
from backend.src.illustrator_store import CachedConversion
from backend.src.illustrator_store import ConversionStore
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf

TRUTH_SCALE = 0.25
TRUTH_ROTATION = 18.0
TRUTH_ANCHOR = (139.7671, 35.6812)
WORKING_CRS = "EPSG:6677"

ARTWORK_L = Polygon(
    [(0.0, 0.0), (120.0, 0.0), (120.0, 40.0), (40.0, 40.0), (40.0, 120.0), (0.0, 120.0), (0.0, 0.0)]
)


def _truth_transform() -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=(40.0, 40.0),
        map_anchor=TRUTH_ANCHOR,
        rotation_deg=TRUTH_ROTATION,
        metres_per_point=TRUTH_SCALE,
        working_crs=WORKING_CRS,
    )


def _current_transform(*, rotation: float = 0.0, scale: float = TRUTH_SCALE) -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=(0.0, 0.0),
        map_anchor=TRUTH_ANCHOR,
        rotation_deg=rotation,
        metres_per_point=scale,
        working_crs=WORKING_CRS,
    )


def _to_wgs84(geom, crs: str = WORKING_CRS):
    return gpd.GeoSeries([geom], crs=crs).to_crs("EPSG:4326").iloc[0]


def _placed_wgs84(geom, transform: SimilarityTransform):
    placed = affine_transform(geom, transform.to_affine_matrix())
    return _to_wgs84(placed, transform.working_crs)


def _feature(geom, **properties) -> dict:
    return {"type": "Feature", "properties": properties, "geometry": mapping(geom)}


def _collection(*geoms) -> dict:
    return {"type": "FeatureCollection", "features": [_feature(geom) for geom in geoms]}


def _cached_shapes(
    tmp_path: Path,
    geoms: list,
    *,
    floors: list[dict] | None,
    roles: list[str] | None = None,
    pages: list[int] | None = None,
) -> CachedConversion:
    roles = roles or ["polygon"] * len(geoms)
    page_values = pages or [1] * len(geoms)
    polygon_rows = []
    polygon_geoms = []
    line_rows = []
    line_geoms = []
    for geom, role, page in zip(geoms, roles, page_values, strict=True):
        row = {
            "page": page,
            "ai_layer": "Buildings",
            "role": role,
            "fill_color": "#ff0000",
            "stroke_color": None,
            "line_width": 0.0,
            "dashed": False,
        }
        if role == "polygon":
            polygon_rows.append(row)
            polygon_geoms.append(geom)
        else:
            line_rows.append(row)
            line_geoms.append(geom)
    written = []
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*'crs' was not provided.*")
        gpkg = tmp_path / "artwork.gpkg"
        if polygon_geoms:
            gpd.GeoDataFrame(polygon_rows, geometry=polygon_geoms, crs=None).to_file(
                gpkg, driver="GPKG", layer="Buildings"
            )
            written.append({"table": "Buildings", "ai_layer": "Buildings", "role": "polygon"})
        if line_geoms:
            gpd.GeoDataFrame(line_rows, geometry=line_geoms, crs=None).to_file(
                gpkg, driver="GPKG", layer="Buildings__lines", mode="a" if polygon_geoms else "w"
            )
            written.append({"table": "Buildings__lines", "ai_layer": "Buildings", "role": "line"})
    return CachedConversion(
        conversion_id="synthetic",
        directory=tmp_path,
        stem="synthetic",
        written_layers=written,
        layer_order=["Buildings"],
        report={
            "page_count": max(page_values),
            "total_features": len(geoms),
            "pages": [
                {"index": index, "width_pt": 200.0, "height_pt": 200.0}
                for index in range(1, max(page_values) + 1)
            ],
        },
        created_at=time.time(),
        floors=floors,
    )


def _unrestricted_floor(label: str = "1F") -> list[dict]:
    return [{"label": label, "box": None, "pages": None, "layer_names": None}]


def _page_floors(*labels: str) -> list[dict]:
    return [
        {"label": label, "box": None, "pages": [index], "layer_names": None}
        for index, label in enumerate(labels, start=1)
    ]


def _reference_set(truth: SimilarityTransform) -> tuple[Polygon, Polygon, Polygon]:
    matched = _placed_wgs84(ARTWORK_L, truth)
    # Place distractors well away from the matched footprint in working CRS.
    origin = gpd.GeoSeries([Point(truth.map_anchor)], crs="EPSG:4326").to_crs(WORKING_CRS).iloc[0]
    east, north = float(origin.x), float(origin.y)
    circle = _to_wgs84(Point(east + 80.0, north + 80.0).buffer(18.0))
    strip = _to_wgs84(
        Polygon(
            [
                (east - 90.0, north - 20.0),
                (east - 20.0, north - 20.0),
                (east - 20.0, north - 12.0),
                (east - 90.0, north - 12.0),
                (east - 90.0, north - 20.0),
            ]
        )
    )
    return matched, circle, strip


@pytest.mark.georef
def test_known_transformed_outline_ranks_first_and_recovers_fit(tmp_path: Path) -> None:
    cached = _cached_shapes(tmp_path, [ARTWORK_L], floors=_unrestricted_floor())
    truth = _truth_transform()
    matched, circle, strip = _reference_set(truth)
    matches = match_shapes(
        cached,
        floor_label="1F",
        source_table="Buildings",
        source_row=0,
        current=_current_transform(),
        scale_locked=False,
        reference=_collection(matched, circle, strip),
    )
    assert len(matches) == 3
    best = matches[0]
    assert best["rank"] == 1
    assert best["reference_feature_index"] == 0
    assert best["reference_part_index"] == 0
    assert best["overlap_iou"] > 0.9
    assert best["transform"]["rotation_deg"] == pytest.approx(TRUTH_ROTATION, abs=0.5)
    assert best["transform"]["metres_per_point"] == pytest.approx(TRUTH_SCALE, rel=0.02)
    assert best["transform"]["working_crs"] == WORKING_CRS
    assert len(best["residual_vectors"]) == 12
    assert {item["reference_feature_index"] for item in matches[1:]} == {1, 2}
    assert matches[0]["score"] > matches[1]["score"]
    assert matches[0]["relative_gap"] is not None
    assert matches[-1]["relative_gap"] is None


@pytest.mark.georef
def test_locked_scale_stays_exact(tmp_path: Path) -> None:
    cached = _cached_shapes(tmp_path, [ARTWORK_L], floors=_unrestricted_floor())
    truth = _truth_transform()
    matched, circle, strip = _reference_set(truth)
    scaled = affine_transform(ARTWORK_L, [0.6, 0, 0, 0.6, 8.0, 8.0])
    scaled_ref = _placed_wgs84(
        scaled,
        SimilarityTransform(
            artwork_anchor=(40.0, 40.0),
            map_anchor=(139.7680, 35.6820),
            rotation_deg=40.0,
            metres_per_point=TRUTH_SCALE,
            working_crs=WORKING_CRS,
        ),
    )
    matches = match_shapes(
        cached,
        floor_label="1F",
        source_table="Buildings",
        source_row=0,
        current=_current_transform(),
        scale_locked=True,
        reference=_collection(matched, scaled_ref, circle, strip),
    )
    assert matches[0]["reference_feature_index"] == 0
    assert matches[0]["transform"]["metres_per_point"] == TRUTH_SCALE
    assert matches[0]["transform"]["rotation_deg"] == pytest.approx(TRUTH_ROTATION, abs=0.5)


@pytest.mark.georef
def test_empty_or_non_polygon_reference_returns_no_matches(tmp_path: Path) -> None:
    cached = _cached_shapes(tmp_path, [ARTWORK_L], floors=_unrestricted_floor())
    kwargs = dict(
        floor_label="1F",
        source_table="Buildings",
        source_row=0,
        current=_current_transform(),
        scale_locked=False,
    )
    assert match_shapes(cached, reference=_collection(), **kwargs) == []
    line = _feature(LineString([(139.76, 35.68), (139.77, 35.69)]))
    point = _feature(Point(139.76, 35.68))
    assert (
        match_shapes(
            cached,
            reference={"type": "FeatureCollection", "features": [line, point]},
            **kwargs,
        )
        == []
    )


@pytest.mark.georef
def test_multipolygon_part_index_is_the_matching_ring(tmp_path: Path) -> None:
    cached = _cached_shapes(tmp_path, [ARTWORK_L], floors=_unrestricted_floor())
    truth = _truth_transform()
    matched, circle, _strip = _reference_set(truth)
    from shapely.geometry import MultiPolygon

    multi = MultiPolygon([circle, matched])
    matches = match_shapes(
        cached,
        floor_label="1F",
        source_table="Buildings",
        source_row=0,
        current=_current_transform(),
        scale_locked=False,
        reference=_collection(multi),
    )
    assert matches[0]["reference_feature_index"] == 0
    assert matches[0]["reference_part_index"] == 1
    assert matches[0]["overlap_iou"] > 0.9


def _l_line(*, closed: bool) -> LineString:
    coords = list(ARTWORK_L.exterior.coords)
    if not closed:
        coords = coords[:-1]
    return LineString(coords)


def _line_matches(tmp_path: Path, geom) -> list[dict]:
    cached = _cached_shapes(tmp_path, [geom], roles=["line"], floors=_unrestricted_floor())
    truth = _truth_transform()
    matched, circle, strip = _reference_set(truth)
    return match_shapes(
        cached,
        floor_label="1F",
        source_table="Buildings__lines",
        source_row=0,
        current=_current_transform(),
        scale_locked=False,
        reference=_collection(matched, circle, strip),
    )


@pytest.mark.georef
def test_closed_line_outline_ranks_first_like_a_polygon(tmp_path: Path) -> None:
    matches = _line_matches(tmp_path, _l_line(closed=True))
    assert matches[0]["reference_feature_index"] == 0
    assert matches[0]["overlap_iou"] > 0.9
    assert matches[0]["transform"]["rotation_deg"] == pytest.approx(TRUTH_ROTATION, abs=0.5)
    assert matches[0]["transform"]["metres_per_point"] == pytest.approx(TRUTH_SCALE, rel=0.02)


@pytest.mark.georef
def test_open_line_outline_closes_and_ranks_first(tmp_path: Path) -> None:
    matches = _line_matches(tmp_path, _l_line(closed=False))
    assert matches[0]["reference_feature_index"] == 0
    assert matches[0]["overlap_iou"] > 0.9
    assert matches[0]["transform"]["rotation_deg"] == pytest.approx(TRUTH_ROTATION, abs=0.5)


@pytest.mark.georef
def test_multiline_outline_merges_and_ranks_first(tmp_path: Path) -> None:
    coords = list(ARTWORK_L.exterior.coords)[:-1]
    mid = len(coords) // 2
    matches = _line_matches(tmp_path, MultiLineString([coords[: mid + 1], coords[mid:]]))
    assert matches[0]["reference_feature_index"] == 0
    assert matches[0]["overlap_iou"] > 0.9


@pytest.mark.georef
def test_invalid_table_row_and_floor_raise_value_error(tmp_path: Path) -> None:
    other = Polygon([(200.0, 0.0), (260.0, 0.0), (260.0, 40.0), (200.0, 40.0), (200.0, 0.0)])
    cached = _cached_shapes(
        tmp_path,
        [ARTWORK_L, other, LineString([(0.0, 0.0), (10.0, 10.0)])],
        roles=["polygon", "polygon", "line"],
        floors=[
            {"label": "1F", "box": [-10.0, -10.0, 150.0, 150.0], "pages": None, "layer_names": None},
            {"label": "2F", "box": [180.0, -10.0, 300.0, 80.0], "pages": None, "layer_names": None},
        ],
    )
    kwargs = dict(current=_current_transform(), scale_locked=False, reference=_collection())
    with pytest.raises(ValueError, match="Unknown source table"):
        match_shapes(cached, floor_label="1F", source_table="missing", source_row=0, **kwargs)
    with pytest.raises(ValueError, match="Unknown source row"):
        match_shapes(cached, floor_label="1F", source_table="Buildings", source_row=9, **kwargs)
    with pytest.raises(ValueError, match="Unknown floor label"):
        match_shapes(cached, floor_label="3F", source_table="Buildings", source_row=0, **kwargs)
    with pytest.raises(ValueError, match="not assigned to floor"):
        match_shapes(cached, floor_label="2F", source_table="Buildings", source_row=0, **kwargs)
    with pytest.raises(ValueError, match="usable outline"):
        match_shapes(cached, floor_label="1F", source_table="Buildings__lines", source_row=0, **kwargs)


@pytest.mark.georef
def test_missing_assignment_is_a_bad_request(tmp_path: Path) -> None:
    cached = _cached_shapes(tmp_path, [ARTWORK_L], floors=None)
    with pytest.raises(ValueError, match="No floor assignment"):
        match_shapes(
            cached,
            floor_label="1F",
            source_table="Buildings",
            source_row=0,
            current=_current_transform(),
            scale_locked=False,
            reference=_collection(),
        )


@pytest.mark.georef
def test_preview_source_row_resolves_the_cached_polygon(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path / "store", ttl_seconds=3600, max_entries=5)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    store.assign(cached.conversion_id, _unrestricted_floor("artwork"))
    cached = store.get(cached.conversion_id)
    preview = build_preview(cached)

    polygon = next(f for f in preview["preview"]["features"] if f["properties"]["role"] == "polygon")
    art = shape(polygon["geometry"])
    truth = _truth_transform()
    matches = match_shapes(
        cached,
        floor_label="artwork",
        source_table=polygon["properties"]["source_table"],
        source_row=int(polygon["properties"]["source_row"]),
        current=_current_transform(),
        scale_locked=False,
        reference=_collection(_placed_wgs84(art, truth)),
    )
    assert matches[0]["reference_feature_index"] == 0
    assert matches[0]["overlap_iou"] > 0.9
    # The PDF fixture is a 100x60 rectangle, identical under a 180° rotation.
    # Helmert may recover the planted heading or its opposite; both yield IoU ≈ 1.
    got = matches[0]["transform"]["rotation_deg"]
    delta = abs((got - TRUTH_ROTATION + 180.0) % 360.0 - 180.0)
    assert min(delta, abs(180.0 - delta)) <= 0.5


@pytest.mark.georef
def test_another_floor_outline_ranks_like_a_posted_polygon(tmp_path: Path) -> None:
    cached = _cached_shapes(
        tmp_path,
        [ARTWORK_L, ARTWORK_L],
        floors=_page_floors("1F", "2F"),
        pages=[1, 2],
    )
    matches = match_shapes(
        cached,
        floor_label="2F",
        source_table="Buildings",
        source_row=1,
        current=_current_transform(),
        scale_locked=False,
        reference_floor_label="1F",
        reference_transform=_truth_transform(),
    )
    assert matches[0]["rank"] == 1
    assert matches[0]["overlap_iou"] > 0.9
    assert matches[0]["transform"]["rotation_deg"] == pytest.approx(TRUTH_ROTATION, abs=0.5)
    assert matches[0]["transform"]["metres_per_point"] == pytest.approx(TRUTH_SCALE, rel=0.02)


@pytest.mark.georef
def test_another_floor_line_outline_is_usable_reference(tmp_path: Path) -> None:
    cached = _cached_shapes(
        tmp_path,
        [_l_line(closed=True), ARTWORK_L],
        roles=["line", "polygon"],
        floors=_page_floors("1F", "2F"),
        pages=[1, 2],
    )
    matches = match_shapes(
        cached,
        floor_label="2F",
        source_table="Buildings",
        source_row=0,
        current=_current_transform(),
        scale_locked=False,
        reference_floor_label="1F",
        reference_transform=_truth_transform(),
    )
    assert matches[0]["overlap_iou"] > 0.9
    assert matches[0]["transform"]["rotation_deg"] == pytest.approx(TRUTH_ROTATION, abs=0.5)


@pytest.mark.georef
def test_same_floor_reference_is_rejected(tmp_path: Path) -> None:
    cached = _cached_shapes(tmp_path, [ARTWORK_L, ARTWORK_L], floors=_page_floors("1F", "2F"), pages=[1, 2])
    with pytest.raises(ValueError, match="different from the selected floor"):
        match_shapes(
            cached,
            floor_label="1F",
            source_table="Buildings",
            source_row=0,
            current=_current_transform(),
            scale_locked=False,
            reference_floor_label="1F",
            reference_transform=_truth_transform(),
        )


@pytest.mark.georef
def test_unknown_reference_floor_raises_value_error(tmp_path: Path) -> None:
    cached = _cached_shapes(tmp_path, [ARTWORK_L, ARTWORK_L], floors=_page_floors("1F", "2F"), pages=[1, 2])
    with pytest.raises(ValueError, match="Unknown floor label"):
        match_shapes(
            cached,
            floor_label="1F",
            source_table="Buildings",
            source_row=0,
            current=_current_transform(),
            scale_locked=False,
            reference_floor_label="3F",
            reference_transform=_truth_transform(),
        )


@pytest.mark.georef
def test_reference_floor_without_usable_outlines_returns_no_matches(tmp_path: Path) -> None:
    cached = _cached_shapes(
        tmp_path,
        [ARTWORK_L, LineString([(0.0, 0.0), (10.0, 10.0)])],
        roles=["polygon", "line"],
        floors=_page_floors("1F", "2F"),
        pages=[1, 2],
    )
    matches = match_shapes(
        cached,
        floor_label="1F",
        source_table="Buildings",
        source_row=0,
        current=_current_transform(),
        scale_locked=False,
        reference_floor_label="2F",
        reference_transform=_truth_transform(),
    )
    assert matches == []
