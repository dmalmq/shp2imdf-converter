"""Validator tests for Phase 5."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from backend.src.validator import validate_feature_collection


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sample_dir.glob(f"{stem}.*"):
        files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


def _generated_collection(test_client, sample_dir: Path) -> dict:
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
                "province": "JP-13",
            },
        },
    )
    assert project_response.status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    return test_client.get(f"/api/session/{session_id}/features").json()


@pytest.mark.phase5
def test_valid_output_passes_without_errors(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    result = validate_feature_collection(collection)
    assert result.summary.error_count == 0


@pytest.mark.phase5
def test_missing_venue_error(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    mutated["features"] = [item for item in mutated["features"] if item["feature_type"] != "venue"]
    result = validate_feature_collection(mutated)
    assert any(issue.check == "missing_venue" for issue in result.errors)


@pytest.mark.phase5
def test_duplicate_uuids_error(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    units = [item for item in mutated["features"] if item["feature_type"] == "unit"]
    assert len(units) >= 2
    units[1]["id"] = units[0]["id"]
    result = validate_feature_collection(mutated)
    assert any(issue.check == "duplicate_uuids" for issue in result.errors)


@pytest.mark.phase5
def test_opening_must_be_linestring(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    opening = next(item for item in mutated["features"] if item["feature_type"] == "opening")
    opening["geometry"] = {
        "type": "Polygon",
        "coordinates": [[[139.0, 35.0], [139.0, 35.001], [139.001, 35.001], [139.0, 35.0]]],
    }
    result = validate_feature_collection(mutated)
    assert any(issue.check == "opening_must_be_linestring" for issue in result.errors)
