"""Converter tests for Phase 5."""

from __future__ import annotations

import pytest

from backend.src.converter import build_imdf_geojson_files


@pytest.mark.phase5
def test_converter_splits_feature_collection_by_imdf_type() -> None:
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "a",
                "feature_type": "address",
                "geometry": None,
                "properties": {"address": "1 Main", "status": "mapped", "issues": []},
            },
            {
                "type": "Feature",
                "id": "u",
                "feature_type": "unit",
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
                "properties": {
                    "category": "retail",
                    "level_id": "lvl",
                    "status": "warning",
                    "issues": [{"check": "x"}],
                    "metadata": {"raw": "value"},
                    "source_file": "sample",
                },
            },
        ],
    }

    files = build_imdf_geojson_files(payload)
    assert "address.geojson" in files
    assert "unit.geojson" in files
    assert "opening.geojson" not in files
    assert "detail.geojson" not in files

    unit = files["unit.geojson"]["features"][0]
    assert "status" not in unit["properties"]
    assert "issues" not in unit["properties"]
    assert "metadata" not in unit["properties"]
    assert "source_file" not in unit["properties"]


@pytest.mark.phase5
def test_converter_includes_required_files_even_when_empty() -> None:
    payload = {"type": "FeatureCollection", "features": []}
    files = build_imdf_geojson_files(payload)
    for required in ("address.geojson", "venue.geojson", "building.geojson", "footprint.geojson", "level.geojson", "unit.geojson"):
        assert required in files


@pytest.mark.phase5
def test_converter_translates_raw_gsi_codes_to_imdf_categories() -> None:
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "v",
                "feature_type": "venue",
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
                "properties": {"category": "A001"},
            },
            {
                "type": "Feature",
                "id": "u1",
                "feature_type": "unit",
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
                "properties": {"category": "B001"},
            },
            {
                "type": "Feature",
                "id": "u2",
                "feature_type": "unit",
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
                "properties": {"category": "B999"},
            },
            {
                "type": "Feature",
                "id": "u3",
                "feature_type": "unit",
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
                "properties": {"category": "retail"},
            },
        ],
    }

    files = build_imdf_geojson_files(payload)
    venue = files["venue.geojson"]["features"][0]
    assert venue["properties"]["category"] == "transitstation"

    units = {feat["id"]: feat for feat in files["unit.geojson"]["features"]}
    assert units["u1"]["properties"]["category"] == "retail"
    # Unknown spec codes fall back to the code file's default category.
    assert units["u2"]["properties"]["category"] == "unspecified"
    # Already-valid IMDF categories pass through untouched.
    assert units["u3"]["properties"]["category"] == "retail"
