"""Interactive boxed-region matching between two assigned floors."""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import pytest
from shapely.affinity import affine_transform
from shapely.geometry import Polygon

from backend.src.illustrator_georeference import SimilarityTransform
from backend.src.illustrator_shape_match import match_regions
from backend.src.illustrator_store import ConversionStore
from backend.tests.test_illustrator_shape_match import ARTWORK_L
from backend.tests.test_illustrator_shape_match import TRUTH_ROTATION
from backend.tests.test_illustrator_shape_match import TRUTH_SCALE
from backend.tests.test_illustrator_shape_match import _cached_shapes
from backend.tests.test_illustrator_shape_match import _current_transform
from backend.tests.test_illustrator_shape_match import _truth_transform

SHARED_ROTATION = 25.0
SHARED_SCALE = 1.2
SHARED_OFFSET = (80.0, 40.0)
DISTRACTOR = Polygon(
    [(400.0, 400.0), (480.0, 400.0), (480.0, 480.0), (400.0, 480.0), (400.0, 400.0)]
)


def _artwork_matrix(
    scale: float, rotation_deg: float, offset: tuple[float, float]
) -> tuple[float, float, float, float, float, float]:
    theta = math.radians(rotation_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    a = scale * cos_t
    b = -scale * sin_t
    d = scale * sin_t
    e = scale * cos_t
    return (a, b, d, e, offset[0], offset[1])


def _padded_bounds(geom, pad: float = 12.0) -> list[float]:
    minx, miny, maxx, maxy = geom.bounds
    return [minx - pad, miny - pad, maxx + pad, maxy + pad]


def _as_transform(payload: dict) -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=(payload["artwork_anchor"][0], payload["artwork_anchor"][1]),
        map_anchor=(payload["map_anchor"][0], payload["map_anchor"][1]),
        rotation_deg=payload["rotation_deg"],
        metres_per_point=payload["metres_per_point"],
        working_crs=payload["working_crs"],
    )


def _overlap(left, right) -> float:
    union_area = float(left.union(right).area)
    if union_area <= 0:
        return 0.0
    return float(left.intersection(right).area) / union_area


def _partial_floors(
    tmp_path: Path,
    *,
    scale: float = SHARED_SCALE,
    rotation_deg: float = SHARED_ROTATION,
):
    matrix = _artwork_matrix(scale, rotation_deg, SHARED_OFFSET)
    shared_reference = affine_transform(ARTWORK_L, matrix)
    cached = _cached_shapes(
        tmp_path,
        [shared_reference, DISTRACTOR, ARTWORK_L, DISTRACTOR],
        floors=[
            {"label": "1F", "box": None, "pages": [1], "layer_names": None},
            {"label": "4F", "box": None, "pages": [2], "layer_names": None},
        ],
        pages=[1, 1, 2, 2],
    )
    return cached, shared_reference, matrix


def _match_kwargs(shared_reference, *, scale_locked: bool = False, **overrides):
    kwargs = {
        "floor_label": "4F",
        "region": _padded_bounds(ARTWORK_L),
        "current": _current_transform(),
        "scale_locked": scale_locked,
        "reference_floor_label": "1F",
        "reference_transform": _truth_transform(),
        "reference_region": _padded_bounds(shared_reference),
    }
    kwargs.update(overrides)
    return kwargs


@pytest.mark.georef
def test_boxed_partial_overlap_recovers_rotation_and_scale(tmp_path: Path) -> None:
    cached, shared_reference, matrix = _partial_floors(tmp_path)
    matches = match_regions(cached, **_match_kwargs(shared_reference))
    assert matches
    best = matches[0]
    composed = _as_transform(best["transform"])
    placed_active = affine_transform(ARTWORK_L, composed.to_affine_matrix())
    placed_reference = affine_transform(
        shared_reference, _truth_transform().to_affine_matrix()
    )
    assert _overlap(placed_active, placed_reference) > 0.9
    assert composed.rotation_deg == pytest.approx(
        TRUTH_ROTATION + SHARED_ROTATION, abs=0.5
    )
    assert composed.metres_per_point == pytest.approx(TRUTH_SCALE * SHARED_SCALE, rel=0.02)
    assert composed.artwork_anchor == _current_transform().artwork_anchor
    assert composed.working_crs == _truth_transform().working_crs
    # Out-of-box squares correspond by identity; using them would drop the 25° turn.
    assert composed.rotation_deg != pytest.approx(TRUTH_ROTATION, abs=0.5)
    assert best["reference_part_index"] == 0
    assert best["overlap_iou"] > 0.9
    assert 1 <= best["rank"] <= 3
    assert len(best["residual_vectors"]) <= 12
    assert "type" in best["reference_geometry"]


@pytest.mark.georef
def test_geometry_outside_the_boxes_is_ignored(tmp_path: Path) -> None:
    cached, shared_reference, _matrix = _partial_floors(tmp_path)
    matches = match_regions(cached, **_match_kwargs(shared_reference))
    assert matches
    composed = _as_transform(matches[0]["transform"])
    placed_distractor = affine_transform(DISTRACTOR, composed.to_affine_matrix())
    identity_distractor = affine_transform(
        DISTRACTOR, _truth_transform().to_affine_matrix()
    )
    assert _overlap(placed_distractor, identity_distractor) < 0.2


@pytest.mark.georef
def test_locked_scale_keeps_current_metres_per_point(tmp_path: Path) -> None:
    cached, shared_reference, _matrix = _partial_floors(
        tmp_path, scale=1.0, rotation_deg=SHARED_ROTATION
    )
    current = _current_transform(scale=TRUTH_SCALE)
    matches = match_regions(
        cached,
        **_match_kwargs(shared_reference, scale_locked=True, current=current),
    )
    assert matches
    assert matches[0]["transform"]["metres_per_point"] == current.metres_per_point
    assert matches[0]["transform"]["rotation_deg"] == pytest.approx(
        TRUTH_ROTATION + SHARED_ROTATION, abs=0.5
    )


@pytest.mark.georef
def test_same_floor_reference_is_rejected(tmp_path: Path) -> None:
    cached, shared_reference, _matrix = _partial_floors(tmp_path)
    with pytest.raises(ValueError, match="different from the selected floor"):
        match_regions(
            cached,
            **_match_kwargs(shared_reference, reference_floor_label="4F"),
        )


@pytest.mark.georef
def test_unknown_floor_label_raises_value_error(tmp_path: Path) -> None:
    cached, shared_reference, _matrix = _partial_floors(tmp_path)
    with pytest.raises(ValueError, match="Unknown floor label"):
        match_regions(cached, **_match_kwargs(shared_reference, floor_label="3F"))
    with pytest.raises(ValueError, match="Unknown floor label"):
        match_regions(
            cached,
            **_match_kwargs(shared_reference, reference_floor_label="3F"),
        )


@pytest.mark.georef
def test_empty_region_returns_no_matches(tmp_path: Path) -> None:
    cached, shared_reference, _matrix = _partial_floors(tmp_path)
    assert (
        match_regions(
            cached,
            **_match_kwargs(shared_reference, region=[800.0, 800.0, 900.0, 900.0]),
        )
        == []
    )


def _install_cached(store: ConversionStore, cached) -> str:
    dest = store.root / cached.conversion_id
    dest.mkdir(parents=True, exist_ok=True)
    if cached.gpkg_path != dest / "artwork.gpkg":
        shutil.copy2(cached.gpkg_path, dest / "artwork.gpkg")
    (dest / "conversion.json").write_text(
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
    if cached.floors is not None:
        (dest / "floors.json").write_text(
            json.dumps(cached.floors, ensure_ascii=False), encoding="utf-8"
        )
    return cached.conversion_id


def _transform_payload(transform: SimilarityTransform) -> dict:
    return {
        "artwork_anchor": [transform.artwork_anchor[0], transform.artwork_anchor[1]],
        "map_anchor": [transform.map_anchor[0], transform.map_anchor[1]],
        "rotation_deg": transform.rotation_deg,
        "metres_per_point": transform.metres_per_point,
        "working_crs": transform.working_crs,
    }


@pytest.mark.georef
def test_region_matches_endpoint_returns_suggestions_and_rejects_same_floor(
    test_client, tmp_path: Path
) -> None:
    cached, shared_reference, _matrix = _partial_floors(tmp_path)
    store = ConversionStore(root=tmp_path / "illustrator", ttl_seconds=3600, max_entries=5)
    conversion_id = _install_cached(store, cached)
    previous = test_client.app.state.illustrator_store
    test_client.app.state.illustrator_store = store
    try:
        body = {
            "floor_label": "4F",
            "region": _padded_bounds(ARTWORK_L),
            "current_transform": _transform_payload(_current_transform()),
            "scale_locked": False,
            "reference_floor": {
                "label": "1F",
                "transform": _transform_payload(_truth_transform()),
                "region": _padded_bounds(shared_reference),
            },
        }
        response = test_client.post(
            f"/api/convert/illustrator/{conversion_id}/region-matches", json=body
        )
        assert response.status_code == 200
        payload = response.json()
        assert "matches" in payload
        assert payload["matches"]
        match = payload["matches"][0]
        assert match["rank"] == 1
        assert "score" in match
        assert "transform" in match
        assert match["transform"]["working_crs"] == _truth_transform().working_crs
        assert "boundary_rmse_m" in match
        assert "residual_vectors" in match
        assert len(match["residual_vectors"]) <= 12
        assert "reference_geometry" in match
        same_floor = dict(body)
        same_floor["reference_floor"] = {
            **body["reference_floor"],
            "label": "4F",
        }
        rejected = test_client.post(
            f"/api/convert/illustrator/{conversion_id}/region-matches",
            json=same_floor,
        )
        assert rejected.status_code == 400
    finally:
        test_client.app.state.illustrator_store = previous
