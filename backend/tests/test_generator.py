"""Generator tests for Phase 4."""

from __future__ import annotations

from pathlib import Path

import pytest
from shapely.geometry import shape


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sample_dir.glob(f"{stem}.*"):
        files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


def _prepare_generated(test_client, sample_dir: Path) -> tuple[str, list[dict]]:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_B1_Opening")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    project_response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "1-9-1 Marunouchi",
                "locality": "Chiyoda-ku",
                "country": "JP",
            },
        },
    )
    assert project_response.status_code == 200

    generate_response = test_client.post(f"/api/session/{session_id}/generate")
    assert generate_response.status_code == 200

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    return session_id, features


@pytest.mark.phase4
def test_generated_levels_have_building_ids(test_client, sample_dir: Path) -> None:
    _, features = _prepare_generated(test_client, sample_dir)
    levels = [item for item in features if item["feature_type"] == "level"]
    assert levels
    for level in levels:
        properties = level["properties"]
        assert properties["building_ids"]
        assert isinstance(properties["building_ids"], list)


@pytest.mark.phase4
def test_generated_units_and_openings_reference_level_ids(test_client, sample_dir: Path) -> None:
    _, features = _prepare_generated(test_client, sample_dir)
    level_ids = {item["id"] for item in features if item["feature_type"] == "level"}
    assert level_ids

    units = [item for item in features if item["feature_type"] == "unit"]
    openings = [item for item in features if item["feature_type"] == "opening"]
    assert units
    assert openings

    assert all(item["properties"]["level_id"] in level_ids for item in units)
    assert all(item["properties"]["level_id"] in level_ids for item in openings)


@pytest.mark.phase4
def test_generated_unlocated_features_have_null_geometry(test_client, sample_dir: Path) -> None:
    _, features = _prepare_generated(test_client, sample_dir)
    addresses = [item for item in features if item["feature_type"] == "address"]
    buildings = [item for item in features if item["feature_type"] == "building"]
    assert addresses
    assert buildings
    assert all(item["geometry"] is None for item in addresses)
    assert all(item["geometry"] is None for item in buildings)


@pytest.mark.phase4
def test_venue_geometry_includes_subterranean_footprints_when_ground_exists(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    project_response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "1-9-1 Marunouchi",
                "locality": "Chiyoda-ku",
                "country": "JP",
            },
        },
    )
    assert project_response.status_code == 200

    generate_response = test_client.post(f"/api/session/{session_id}/generate")
    assert generate_response.status_code == 200

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    venue = next(item for item in features if item["feature_type"] == "venue")
    footprints = [item for item in features if item["feature_type"] == "footprint"]
    ground = [item for item in footprints if item["properties"].get("category") == "ground"]
    subterranean = [item for item in footprints if item["properties"].get("category") == "subterranean"]
    assert ground
    assert subterranean

    venue_geom = shape(venue["geometry"])
    assert all(venue_geom.intersects(shape(item["geometry"])) for item in ground)
    assert all(venue_geom.intersects(shape(item["geometry"])) for item in subterranean)
