"""Autofix tests for Phase 5."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from backend.src.autofix import apply_autofix
from backend.src.validator import validate_feature_collection


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sample_dir.glob(f"{stem}.*"):
        files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


def _generated_collection(test_client, sample_dir: Path) -> dict:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]
    assert test_client.patch(
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
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    return test_client.get(f"/api/session/{session_id}/features").json()


@pytest.mark.phase5
def test_autofix_repairs_invalid_geometry(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    unit = next(item for item in mutated["features"] if item["feature_type"] == "unit")
    unit["geometry"] = {
        "type": "Polygon",
        "coordinates": [
            [
                [139.0, 35.0],
                [139.001, 35.001],
                [139.001, 35.0],
                [139.0, 35.001],
                [139.0, 35.0],
            ]
        ],
    }
    before = validate_feature_collection(mutated)
    assert any(issue.check == "invalid_geometry" for issue in before.errors)

    fixed, fixes_applied, _ = apply_autofix(mutated, before, apply_prompted=False)
    after = validate_feature_collection(fixed)
    assert any(item.action == "make_valid" for item in fixes_applied)
    assert not any(issue.check == "invalid_geometry" for issue in after.errors)


@pytest.mark.phase5
def test_autofix_prompts_and_applies_duplicate_deletion(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    units = [item for item in mutated["features"] if item["feature_type"] == "unit"]
    assert len(units) >= 2
    units[1]["geometry"] = copy.deepcopy(units[0]["geometry"])

    validation = validate_feature_collection(mutated)
    assert any(issue.check == "duplicate_geometry_warning" for issue in validation.warnings)

    _, _, prompts = apply_autofix(mutated, validation, apply_prompted=False)
    assert any(prompt.check == "duplicate_geometry_warning" for prompt in prompts)

    applied_collection, fixes_applied, _ = apply_autofix(mutated, validation, apply_prompted=True)
    assert any(item.action == "delete_feature" for item in fixes_applied)
    assert len(applied_collection["features"]) < len(mutated["features"])
