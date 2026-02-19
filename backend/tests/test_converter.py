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
