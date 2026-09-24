"""Sliver deletion must be confirmed, spare structural units, and measure in metres."""

from __future__ import annotations

import math
from uuid import uuid4

import pytest
from pyproj import Transformer
from shapely.geometry import Polygon, mapping
from shapely.ops import transform

from backend.src.autofix import apply_autofix
from backend.src.validator import validate_feature_collection

LAT = 35.0
LON = 139.7


def _rect(east_m: float, north_m: float, width_m: float, height_m: float) -> Polygon:
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(LAT))
    x0 = LON + east_m / m_per_deg_lon
    y0 = LAT + north_m / m_per_deg_lat
    x1 = x0 + width_m / m_per_deg_lon
    y1 = y0 + height_m / m_per_deg_lat
    return Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)])


def _feature(feature_type: str, geometry: Polygon | None, **props) -> dict:
    return {
        "type": "Feature",
        "id": str(uuid4()),
        "feature_type": feature_type,
        "geometry": mapping(geometry) if geometry is not None else None,
        "properties": props,
    }


def _collection() -> tuple[dict, dict[str, dict]]:
    level = _feature("level", _rect(0, 0, 50, 50), category="unspecified", ordinal=0)
    level_id = level["id"]
    room = _feature("unit", _rect(1, 1, 10, 10), category="room", level_id=level_id)
    column = _feature("unit", _rect(20, 20, 0.6, 0.6), category="column", level_id=level_id)
    sliver = _feature("unit", _rect(30, 30, 0.1, 0.5), category="room", level_id=level_id)
    amenity = {
        "type": "Feature",
        "id": str(uuid4()),
        "feature_type": "amenity",
        "geometry": {"type": "Point", "coordinates": [LON + 0.00002, LAT + 0.00002]},
        "properties": {"category": "information", "unit_ids": [room["id"], sliver["id"]]},
    }
    rows = [level, room, column, sliver, amenity]
    collection = {"type": "FeatureCollection", "features": rows}
    return collection, {"level": level, "room": room, "column": column, "sliver": sliver, "amenity": amenity}


def _ids(collection: dict) -> set[str]:
    return {row["id"] for row in collection["features"]}


@pytest.mark.phase5
def test_column_is_not_treated_as_sliver() -> None:
    collection, named = _collection()
    validation = validate_feature_collection(collection)
    sliver_ids = {issue.feature_id for issue in validation.warnings if issue.check == "unit_sliver"}
    assert named["column"]["id"] not in sliver_ids
    assert named["sliver"]["id"] in sliver_ids

    fixed, _, _ = apply_autofix(collection, validation, apply_prompted=True)
    assert named["column"]["id"] in _ids(fixed)


@pytest.mark.phase5
def test_sliver_is_prompted_and_deleted_only_once_confirmed() -> None:
    collection, named = _collection()
    sliver_id = named["sliver"]["id"]
    validation = validate_feature_collection(collection)

    fixed, fixes_applied, prompts = apply_autofix(collection, validation, apply_prompted=False)
    assert sliver_id in _ids(fixed)
    assert not any(item.feature_id == sliver_id for item in fixes_applied)
    assert [(p.feature_id, p.action) for p in prompts if p.check == "unit_sliver"] == [(sliver_id, "delete_sliver")]

    confirmed, fixes_applied, _ = apply_autofix(collection, validation, apply_prompted=True)
    assert sliver_id not in _ids(confirmed)
    assert named["room"]["id"] in _ids(confirmed)
    assert any(item.feature_id == sliver_id and item.action == "delete_feature" for item in fixes_applied)
    amenity = next(row for row in confirmed["features"] if row["id"] == named["amenity"]["id"])
    assert amenity["properties"]["unit_ids"] == [named["room"]["id"]]


@pytest.mark.phase5
def test_area_in_square_metres_matches_projected_area_at_35n() -> None:
    from backend.src.validator import area_sq_m

    geom = _rect(0, 0, 0.6, 0.6)
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32654", always_xy=True).transform
    expected = transform(to_utm, geom).area
    assert area_sq_m(geom) == pytest.approx(expected, rel=0.01)


@pytest.mark.phase5
def test_auto_fixable_count_matches_what_autofix_resolves() -> None:
    collection, named = _collection()
    duplicate = _feature("unit", None, category="room", level_id=named["level"]["id"])
    duplicate["geometry"] = named["room"]["geometry"]
    collection["features"].append(duplicate)

    validation = validate_feature_collection(collection)
    assert validation.summary.auto_fixable_count > 0

    fixed, fixes_applied, prompts = apply_autofix(collection, validation, apply_prompted=False)
    revalidation = validate_feature_collection(fixed)
    remaining = [issue for issue in [*revalidation.errors, *revalidation.warnings] if issue.auto_fixable]
    prompted = {(p.check, p.feature_id) for p in prompts} | {(p.check, p.related_feature_id) for p in prompts}
    assert remaining
    assert all((issue.check, issue.feature_id) in prompted for issue in remaining)

    confirmed, _, _ = apply_autofix(collection, validation, apply_prompted=True)
    assert validate_feature_collection(confirmed).summary.auto_fixable_count == 0
