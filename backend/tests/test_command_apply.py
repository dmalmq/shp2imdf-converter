"""What the search panel's commands rely on: a revision guard and an opt-in undo on bulk patch."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend.tests.test_check_undo import _as_a_browser_sends, _content, _undo
from backend.tests.test_session_projects import _generated_session, _overlap_two_units

pytestmark = pytest.mark.phase5


def _features(client, session_id: str) -> dict[str, Any]:
    return client.get(f"/api/session/{session_id}/features").json()


def _a_level(client, session_id: str) -> dict[str, Any]:
    return next(row for row in _features(client, session_id)["features"] if row["feature_type"] == "level")


def _move(client, session_id: str, level_id: str, **extra: Any):
    return client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"feature_ids": [level_id], "properties": {"ordinal": 7, "outdoor": True}, **extra},
    )


def test_features_carry_the_content_revision(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    before = _features(test_client, session_id)["content_rev"]
    assert isinstance(before, int)

    _move(test_client, session_id, _a_level(test_client, session_id)["id"])

    assert _features(test_client, session_id)["content_rev"] == before + 1


def test_a_patch_against_an_older_revision_is_refused_and_writes_nothing(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    level = _a_level(test_client, session_id)
    seen = _features(test_client, session_id)["content_rev"]
    test_client.patch(f"/api/session/{session_id}/features/{level['id']}", json={"properties": {"elevation": 3}})
    before = _content(test_client, session_id)

    refused = _move(test_client, session_id, level["id"], base_rev=seen, with_undo=True)

    assert refused.status_code == 409
    assert refused.json()["code"] == "REVISION_STALE"
    assert _content(test_client, session_id) == before


def test_fix_safe_is_refused_against_an_older_revision(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    _overlap_two_units(test_client, session_id)
    seen = _features(test_client, session_id)["content_rev"]
    test_client.patch(
        f"/api/session/{session_id}/features/{_a_level(test_client, session_id)['id']}",
        json={"properties": {"elevation": 3}},
    )

    refused = test_client.post(f"/api/session/{session_id}/overlaps/fix-safe", params={"base_rev": seen})
    current = _features(test_client, session_id)["content_rev"]
    accepted = test_client.post(f"/api/session/{session_id}/overlaps/fix-safe", params={"base_rev": current})

    assert refused.status_code == 409
    assert accepted.status_code == 200, accepted.text


def test_a_patch_with_undo_revalidates_and_undoes_through_restore(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    level = _a_level(test_client, session_id)
    rev = _features(test_client, session_id)["content_rev"]
    before = _content(test_client, session_id)

    applied = _move(test_client, session_id, level["id"], base_rev=rev, with_undo=True)

    assert applied.status_code == 200, applied.text
    body = applied.json()
    assert body["updated_count"] == 1
    assert body["content_rev"] == rev + 1
    assert "summary" in body["validation"]
    assert [row["id"] for row in body["undo"]["features"]] == [level["id"]]
    assert _content(test_client, session_id)[level["id"]]["properties"]["ordinal"] == 7

    undone = _undo(test_client, session_id, body["undo"])

    assert undone.status_code == 200, undone.text
    assert _content(test_client, session_id) == before


def test_undo_of_a_command_is_refused_after_another_edit(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    level = _a_level(test_client, session_id)
    body = _move(test_client, session_id, level["id"], with_undo=True).json()
    test_client.patch(f"/api/session/{session_id}/features/{level['id']}", json={"properties": {"ordinal": 2}})

    refused = _undo(test_client, session_id, body["undo"])

    assert refused.status_code == 409
    assert refused.json()["code"] == "UNDO_STALE"


def test_a_patch_without_undo_keeps_its_response(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)

    plain = _move(test_client, session_id, _a_level(test_client, session_id)["id"]).json()

    assert plain == {"updated_count": 1, "deleted_count": 0, "merged_feature_id": None, "validation": None}


def test_undo_is_only_offered_on_patch(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    level = _a_level(test_client, session_id)

    refused = test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"feature_ids": [level["id"]], "action": "delete", "with_undo": True},
    )

    assert refused.status_code == 400
    assert _as_a_browser_sends(_content(test_client, session_id)).get(level["id"]) is not None
