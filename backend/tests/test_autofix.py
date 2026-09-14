"""Autofix tests for Phase 5."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from backend.src.autofix import apply_autofix
from backend.src.validator import prune_empty_geometry_features, validate_feature_collection


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


def test_prune_empty_geometry_features_keeps_null_geom_types() -> None:
    features = [
        {"id": "u1", "feature_type": "unit", "geometry": {"type": "Polygon", "coordinates": []}},
        {"id": "u2", "feature_type": "unit", "geometry": None},
        {"id": "u3", "feature_type": "unit",
         "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]}},
        {"id": "a1", "feature_type": "address", "geometry": None},
        {"id": "b1", "feature_type": "building", "geometry": None},
        {"id": "r1", "feature_type": "relationship", "geometry": None},
    ]
    survivors, removed = prune_empty_geometry_features(features)
    assert sorted(removed) == ["u1", "u2"]
    assert [item["id"] for item in survivors] == ["u3", "a1", "b1", "r1"]


@pytest.mark.phase5
def test_autofix_removes_empty_geometry_units_without_prompt(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    unit = next(item for item in mutated["features"] if item["feature_type"] == "unit")
    target_id = unit["id"]
    unit["geometry"] = {"type": "Polygon", "coordinates": []}

    validation = validate_feature_collection(mutated)
    assert any(issue.check == "empty_geometry" for issue in validation.errors)

    # A normal auto-fix (no confirmation) should drop the empty unit, not prompt for it.
    fixed, fixes_applied, prompts = apply_autofix(mutated, validation, apply_prompted=False)
    surviving_ids = {item["id"] for item in fixed["features"]}
    assert target_id not in surviving_ids
    assert any(item.action == "delete_empty_geometry" for item in fixes_applied)
    assert not any(prompt.check == "empty_geometry" for prompt in prompts)

    after = validate_feature_collection(fixed)
    assert not any(issue.check == "empty_geometry" for issue in after.errors)


def _punch_hole(feature: dict) -> tuple[float, float]:
    """Cut a square void out of a polygon feature. Returns (before, after) area."""
    from shapely.geometry import Polygon, mapping, shape

    shell = shape(feature["geometry"])
    centre = shell.representative_point()
    size = (shell.bounds[2] - shell.bounds[0]) / 10
    hole = Polygon(
        [
            (centre.x - size, centre.y - size),
            (centre.x + size, centre.y - size),
            (centre.x + size, centre.y + size),
            (centre.x - size, centre.y + size),
        ]
    )
    holed = shell.difference(hole)
    feature["geometry"] = mapping(holed)
    return shell.area, holed.area


@pytest.mark.phase5
def test_autofix_never_fills_interior_rings_without_confirmation(test_client, sample_dir: Path) -> None:
    """A courtyard is real geometry. Filling it grows the polygon over its
    neighbours and cannot be undone, so it must not happen on a plain auto-fix."""
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    unit = next(item for item in mutated["features"] if item["feature_type"] == "unit")
    _, holed_area = _punch_hole(unit)

    validation = validate_feature_collection(mutated)
    assert any(issue.check == "polygon_has_interior_rings" for issue in validation.warnings)

    fixed, fixes_applied, prompts = apply_autofix(mutated, validation, apply_prompted=False)

    assert not any(item.action == "remove_interior_rings" for item in fixes_applied)
    assert any(prompt.check == "polygon_has_interior_rings" for prompt in prompts)

    from shapely.geometry import shape

    survivor = next(item for item in fixed["features"] if item["id"] == unit["id"])
    assert len(survivor["geometry"]["coordinates"]) == 2
    assert shape(survivor["geometry"]).area == pytest.approx(holed_area)


@pytest.mark.phase5
def test_autofix_fills_interior_rings_once_confirmed(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    unit = next(item for item in mutated["features"] if item["feature_type"] == "unit")
    shell_area, _ = _punch_hole(unit)

    validation = validate_feature_collection(mutated)
    fixed, fixes_applied, _ = apply_autofix(mutated, validation, apply_prompted=True)

    assert any(item.action == "remove_interior_rings" for item in fixes_applied)

    from shapely.geometry import shape

    survivor = next(item for item in fixed["features"] if item["id"] == unit["id"])
    assert len(survivor["geometry"]["coordinates"]) == 1
    assert shape(survivor["geometry"]).area == pytest.approx(shell_area)
