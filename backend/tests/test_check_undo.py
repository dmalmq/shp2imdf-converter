"""Undo for Check's fixes: each fix returns what restores it, and restoring is a real edit."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend.src.feature_undo import restore_features, undo_between
from backend.src.projects import derive_session_project
from backend.src.schemas import FeatureUndo
from backend.tests.test_session_projects import _features, _generated_session, _overlap_two_units, _rev, _stored

pytestmark = pytest.mark.phase5


def _content(client, session_id: str) -> dict[str, Any]:
    """Features by id without the validation annotations, which every check rewrites."""
    rows = client.get(f"/api/session/{session_id}/features").json()["features"]
    return {
        row["id"]: {
            "feature_type": row["feature_type"],
            "geometry": row["geometry"],
            "properties": {key: value for key, value in row["properties"].items() if key not in ("status", "issues")},
        }
        for row in rows
    }


def _counts(validation: dict[str, Any]) -> tuple[int, int]:
    return validation["summary"]["error_count"], validation["summary"]["warning_count"]


def _undo(client, session_id: str, undo: dict[str, Any]):
    return client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"action": "restore", "feature_ids": undo["remove_ids"], "features": undo["features"]},
    )


def _listed(client, session_id: str) -> dict[str, Any]:
    return next(item for item in client.get("/api/projects").json()["projects"] if item["id"] == session_id)


def _shifted(geometry: dict[str, Any], dx: float) -> dict[str, Any]:
    return {"type": "Polygon", "coordinates": [[[x + dx, y] for x, y in ring] for ring in geometry["coordinates"]]}


def test_undoing_an_overlap_that_deleted_a_unit_brings_it_back(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    keep, clip = _overlap_two_units(test_client, session_id)
    before = _content(test_client, session_id)
    counts = _counts(test_client.post(f"/api/session/{session_id}/validate").json())

    fixed = test_client.post(
        f"/api/session/{session_id}/overlaps/resolve",
        json={"keep_feature_id": keep["id"], "clip_feature_id": clip["id"]},
    ).json()
    assert fixed["deleted_count"] == 1
    assert fixed["undo"]["remove_ids"] == []
    assert [row["id"] for row in fixed["undo"]["features"]] == [clip["id"]]
    assert _counts(fixed["validation"]) != counts

    rev = _rev(test_client, session_id)
    undone = _undo(test_client, session_id, fixed["undo"])

    assert undone.status_code == 200, undone.text
    assert _content(test_client, session_id) == before
    assert _counts(undone.json()["validation"]) == counts
    assert _rev(test_client, session_id) == rev + 1
    listed = _listed(test_client, session_id)
    assert (listed["blockers"], listed["can_wait"]) == counts
    assert listed["stage"] == derive_session_project(_stored(test_client, session_id)).stage


def test_undoing_a_trimmed_overlap_puts_the_shape_back_in_place(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    keep, clip = _features(test_client, session_id, "unit")[:2]
    overlapping = _shifted(keep["geometry"], 1e-6)
    assert test_client.patch(f"/api/session/{session_id}/features/{clip['id']}", json={"geometry": overlapping}).status_code == 200
    order = [row["id"] for row in test_client.get(f"/api/session/{session_id}/features").json()["features"]]
    before = _content(test_client, session_id)

    fixed = test_client.post(
        f"/api/session/{session_id}/overlaps/resolve",
        json={"keep_feature_id": keep["id"], "clip_feature_id": clip["id"]},
    ).json()
    assert fixed["updated_count"] == 1
    assert _content(test_client, session_id)[clip["id"]]["geometry"] != overlapping

    assert _undo(test_client, session_id, fixed["undo"]).status_code == 200
    assert _content(test_client, session_id) == before
    assert [row["id"] for row in test_client.get(f"/api/session/{session_id}/features").json()["features"]] == order


def test_undoing_a_snap_moves_the_opening_back(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    opening = _features(test_client, session_id, "opening")[0]
    unit = _features(test_client, session_id, "unit")[0]
    before = _content(test_client, session_id)

    fixed = test_client.post(
        f"/api/session/{session_id}/snap_opening", json={"opening_id": opening["id"], "unit_id": unit["id"]}
    ).json()
    assert [row["id"] for row in fixed["undo"]["features"]] == [opening["id"]]
    assert _content(test_client, session_id)[opening["id"]]["geometry"] != opening["geometry"]

    assert _undo(test_client, session_id, fixed["undo"]).status_code == 200
    assert _content(test_client, session_id) == before


def _loose_door_with_label(client, session_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """An opening moved 2 m off its wall, its label point on its middle vertex, the way imports write it."""
    opening = _features(client, session_id, "opening")[0]
    line = [[x + 2e-5, y] for x, y in opening["geometry"]["coordinates"]]
    line.insert(1, [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2])
    geometry = {"type": "LineString", "coordinates": line}
    label = {"type": "Point", "coordinates": line[1]}
    response = client.patch(
        f"/api/session/{session_id}/features/{opening['id']}",
        json={"geometry": geometry, "properties": {"display_point": label}},
    )
    assert response.status_code == 200, response.text
    return response.json(), _features(client, session_id, "unit")[0]


def test_snapping_a_door_takes_its_label_point_along(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    opening, unit = _loose_door_with_label(test_client, session_id)
    loose = test_client.post(f"/api/session/{session_id}/validate").json()
    assert not [issue for issue in loose["errors"] if issue["feature_id"] == opening["id"]]

    fixed = test_client.post(
        f"/api/session/{session_id}/snap_opening", json={"opening_id": opening["id"], "unit_id": unit["id"]}
    ).json()

    assert fixed["validation"]["summary"]["error_count"] <= loose["summary"]["error_count"]
    assert "display_point_within_geometry" not in {issue["check"] for issue in fixed["validation"]["errors"]}
    moved = _content(test_client, session_id)[opening["id"]]
    assert moved["properties"]["display_point"]["coordinates"] == pytest.approx(moved["geometry"]["coordinates"][1], abs=1e-12)

    _undo(test_client, session_id, fixed["undo"])
    restored = _content(test_client, session_id)[opening["id"]]
    assert restored["properties"]["display_point"] == opening["properties"]["display_point"]
    assert restored["geometry"] == opening["geometry"]


def test_trimming_an_overlap_keeps_the_trimmed_units_label_inside(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    keep, clip = _features(test_client, session_id, "unit")[:2]
    overlapping = _shifted(keep["geometry"], 1e-6)
    ring = overlapping["coordinates"][0]
    inside_keep = {"type": "Point", "coordinates": [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2]}
    test_client.patch(
        f"/api/session/{session_id}/features/{clip['id']}",
        json={"geometry": overlapping, "properties": {"display_point": inside_keep}},
    )

    fixed = test_client.post(
        f"/api/session/{session_id}/overlaps/resolve",
        json={"keep_feature_id": keep["id"], "clip_feature_id": clip["id"]},
    ).json()

    assert fixed["updated_count"] == 1
    assert "display_point_within_geometry" not in {issue["check"] for issue in fixed["validation"]["errors"]}
    _undo(test_client, session_id, fixed["undo"])
    assert _content(test_client, session_id)[clip["id"]]["properties"]["display_point"] == inside_keep


def test_undoing_an_autofix_restores_the_coordinates(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    unit = _features(test_client, session_id, "unit")[0]
    ring = [[x + 1e-11, y + 1e-11] for x, y in unit["geometry"]["coordinates"][0][:-1]]
    ring.append(ring[0])
    assert test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}", json={"geometry": {"type": "Polygon", "coordinates": [ring]}}
    ).status_code == 200
    before = _content(test_client, session_id)
    counts = _counts(test_client.post(f"/api/session/{session_id}/validate").json())

    fixed = test_client.post(f"/api/session/{session_id}/autofix", json={"apply_prompted": False}).json()
    assert fixed["total_fixed"] >= 1
    assert unit["id"] in {row["id"] for row in fixed["undo"]["features"]}

    undone = _undo(test_client, session_id, fixed["undo"]).json()
    assert _content(test_client, session_id) == before
    assert _counts(undone["validation"]) == counts


def test_a_restore_that_changes_nothing_is_not_an_edit(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    unit = test_client.get(f"/api/session/{session_id}/features").json()["features"][0]
    rev = _rev(test_client, session_id)

    response = _undo(test_client, session_id, {"remove_ids": [], "features": [unit]})

    assert response.status_code == 200, response.text
    assert _rev(test_client, session_id) == rev
    assert response.json()["validation"] is not None


def test_the_stored_validation_is_returned_only_while_current(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    assert test_client.get(f"/api/session/{session_id}/validation").json() is None

    validated = test_client.post(f"/api/session/{session_id}/validate").json()
    assert test_client.get(f"/api/session/{session_id}/validation").json() == validated

    unit = _features(test_client, session_id, "unit")[0]
    test_client.patch(f"/api/session/{session_id}/features/{unit['id']}", json={"properties": {"category": "room"}})
    assert test_client.get(f"/api/session/{session_id}/validation").json() is None


def test_undo_between_groups_duplicate_ids() -> None:
    first = {"id": "a", "feature_type": "unit", "geometry": None, "properties": {}}
    twin = {"id": "a", "feature_type": "unit", "geometry": None, "properties": {"name": "twin"}}
    renumbered = {**twin, "id": "b"}

    undo = undo_between([first, twin], [first, renumbered])

    assert undo.remove_ids == ["a", "b"]
    assert undo.features == [first, twin]
    assert restore_features([first, renumbered], undo) == [first, twin]


def test_restore_ignores_the_validation_annotations() -> None:
    row = {"id": "a", "feature_type": "unit", "geometry": None, "properties": {"status": "error", "issues": [1]}}
    annotated = {**row, "properties": {"status": "mapped", "issues": []}}

    assert undo_between([row], [annotated]) == FeatureUndo()
