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


def _as_a_browser_sends(value: Any) -> Any:
    """JavaScript has one number type, so 3.0 comes back as 3."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_as_a_browser_sends(item) for item in value]
    if isinstance(value, dict):
        return {key: _as_a_browser_sends(item) for key, item in value.items()}
    return value


def _undo(client, session_id: str, undo: dict[str, Any]):
    return client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"action": "restore", "undo": _as_a_browser_sends(undo)},
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


def _trimmed(client, session_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    keep, clip = _features(client, session_id, "unit")[:2]
    assert client.patch(
        f"/api/session/{session_id}/features/{clip['id']}", json={"geometry": _shifted(keep["geometry"], 1e-6)}
    ).status_code == 200
    fixed = client.post(
        f"/api/session/{session_id}/overlaps/resolve",
        json={"keep_feature_id": keep["id"], "clip_feature_id": clip["id"]},
    ).json()
    return keep, clip, fixed["undo"]


def test_undo_is_refused_after_a_later_edit_to_what_the_fix_touched(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    _, clip, undo = _trimmed(test_client, session_id)
    test_client.patch(f"/api/session/{session_id}/features/{clip['id']}", json={"properties": {"name": {"en": "Renamed"}}})
    rev = _rev(test_client, session_id)

    response = _undo(test_client, session_id, undo)

    assert response.status_code == 409
    assert response.json()["code"] == "UNDO_STALE"
    assert _content(test_client, session_id)[clip["id"]]["properties"]["name"] == {"en": "Renamed"}
    assert _rev(test_client, session_id) == rev


def test_undo_is_refused_after_the_trimmed_unit_was_merged_away(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    keep, clip, undo = _trimmed(test_client, session_id)
    merged = test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"feature_ids": [keep["id"], clip["id"]], "action": "merge_units"},
    )
    assert merged.status_code == 200
    before = _content(test_client, session_id)

    response = _undo(test_client, session_id, undo)

    assert response.status_code == 409
    assert _content(test_client, session_id) == before


def test_undo_is_refused_twice(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    _, _, undo = _trimmed(test_client, session_id)

    assert _undo(test_client, session_id, undo).status_code == 200
    assert _undo(test_client, session_id, undo).status_code == 409


def test_undo_naming_features_the_fix_did_not_touch_is_rejected(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    keep, _, undo = _trimmed(test_client, session_id)
    rows = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    stranger = next(row for row in rows if row["id"] not in undo["fingerprints"])

    widened = {**undo, "remove_ids": [*undo["remove_ids"], stranger["id"]]}
    swapped = {**undo, "features": [{**undo["features"][0], "properties": {"category": "room"}}]}
    unsealed = {"remove_ids": undo["remove_ids"], "features": undo["features"]}

    for payload in (widened, swapped, unsealed):
        response = _undo(test_client, session_id, payload)
        assert response.status_code == 400, response.text
        assert response.json()["code"] == "UNDO_INVALID"
    assert stranger["id"] in _content(test_client, session_id)


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
