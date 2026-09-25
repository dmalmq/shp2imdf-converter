"""Handover: visits, their bounded change log, and the project note."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from backend.src.handover import (
    MAX_EVENTS_PER_VISIT,
    MAX_VISITS,
    begin_or_continue_visit,
    gap_setting_problem,
    last_visit,
    record_event,
    visit_gap,
)
from backend.src.schemas import Handover, SessionRecord
from backend.src.session import FileSystemSessionBackend, SessionManager
from backend.tests.test_projects_api import _reopen_sessions
from backend.tests.test_session_projects import _PROJECT, _import

_T0 = datetime(2026, 9, 1, 9, 0, tzinfo=UTC)


def _record(client, session_id: str) -> SessionRecord:
    record = client.app.state.session_manager.get_session(session_id, touch=False)
    assert record is not None
    return record


def _age(client, session_id: str, delta: timedelta) -> None:
    """Moves the session's clock back, as if the last visit ended ``delta`` ago."""
    manager: SessionManager = client.app.state.session_manager
    record = _record(client, session_id)
    record.last_accessed -= delta
    handover = record.handover
    if handover.visit_started_at is not None:
        handover.visit_started_at -= delta
    for visit in handover.visits:
        visit.started_at -= delta
        visit.ended_at -= delta
        for event in visit.events:
            event.at -= delta
    manager.backend.save(record)


def _events(client, session_id: str) -> list[tuple[str, int, dict]]:
    return [
        (event.kind, event.n, event.params)
        for visit in _record(client, session_id).handover.visits
        for event in visit.events
    ]


def _first_feature(client, session_id: str) -> dict:
    features = client.get(f"/api/session/{session_id}/features").json()["features"]
    return next(item for item in features if item.get("feature_type") == "unit")


# Event log bounds


def test_events_of_one_kind_coalesce_within_a_visit() -> None:
    handover = Handover(visit_started_at=_T0)
    record_event(handover, "features_edited", _T0, n=1)
    record_event(handover, "setup_changed", _T0 + timedelta(minutes=1), section="project")
    record_event(handover, "features_edited", _T0 + timedelta(minutes=2), n=3)

    (visit,) = handover.visits
    assert [(event.kind, event.n) for event in visit.events] == [("setup_changed", 1), ("features_edited", 4)]
    assert visit.events[-1].at == _T0 + timedelta(minutes=2)
    assert visit.ended_at == _T0 + timedelta(minutes=2)


def test_events_with_different_params_stay_apart() -> None:
    handover = Handover(visit_started_at=_T0)
    record_event(handover, "setup_changed", _T0, section="project")
    record_event(handover, "setup_changed", _T0, section="levels")
    assert [event.params for event in handover.visits[0].events] == [{"section": "project"}, {"section": "levels"}]


def test_a_visit_keeps_its_newest_events_and_counts_the_rest() -> None:
    handover = Handover(visit_started_at=_T0)
    for index in range(MAX_EVENTS_PER_VISIT + 5):
        record_event(handover, "file_changed", _T0 + timedelta(seconds=index), stem=f"f{index}")

    (visit,) = handover.visits
    assert len(visit.events) == MAX_EVENTS_PER_VISIT
    assert visit.events[0].params == {"stem": "f5"}
    assert visit.events[-1].params == {"stem": f"f{MAX_EVENTS_PER_VISIT + 4}"}
    assert visit.dropped == 5


def test_only_the_newest_visits_are_kept() -> None:
    handover = Handover()
    gap = visit_gap()
    now = _T0
    for _ in range(MAX_VISITS + 3):
        begin_or_continue_visit(handover, previous=now - gap, now=now)
        record_event(handover, "features_edited", now)
        now += gap * 2

    assert len(handover.visits) == MAX_VISITS
    assert handover.visits[0].started_at == _T0 + gap * 2 * 3
    assert handover.visits[-1].started_at == now - gap * 2


# Visits


def test_activity_within_the_gap_continues_the_visit() -> None:
    handover = Handover()
    begin_or_continue_visit(handover, previous=_T0 - timedelta(days=1), now=_T0)
    record_event(handover, "features_edited", _T0)
    later = _T0 + visit_gap() - timedelta(seconds=1)
    begin_or_continue_visit(handover, previous=_T0, now=later)
    record_event(handover, "features_deleted", later)

    (visit,) = handover.visits
    assert visit.started_at == _T0
    assert [event.kind for event in visit.events] == ["features_edited", "features_deleted"]


def test_an_idle_gap_starts_a_new_visit_and_closes_the_last_one() -> None:
    handover = Handover()
    begin_or_continue_visit(handover, previous=_T0 - timedelta(days=1), now=_T0)
    record_event(handover, "features_edited", _T0)
    last_seen = _T0 + timedelta(minutes=10)
    begin_or_continue_visit(handover, previous=_T0, now=last_seen)
    resumed = last_seen + visit_gap()
    begin_or_continue_visit(handover, previous=last_seen, now=resumed)

    assert handover.visit_started_at == resumed
    (visit,) = handover.visits
    assert visit.ended_at == last_seen
    assert last_visit(handover) == visit

    record_event(handover, "features_deleted", resumed + timedelta(minutes=1))
    assert [item.started_at for item in handover.visits] == [_T0, resumed]
    assert last_visit(handover) == visit


def test_a_visit_without_edits_leaves_no_visit_behind() -> None:
    handover = Handover()
    begin_or_continue_visit(handover, previous=_T0 - timedelta(days=1), now=_T0)
    begin_or_continue_visit(handover, previous=_T0, now=_T0 + timedelta(minutes=5))
    assert handover.visits == []
    assert last_visit(handover) is None


def test_an_edit_long_after_the_visit_began_is_a_new_visit_even_if_the_start_was_missed() -> None:
    handover = Handover(visit_started_at=_T0)
    record_event(handover, "features_edited", _T0)
    late = _T0 + visit_gap() * 3
    record_event(handover, "features_deleted", late)
    assert [visit.started_at for visit in handover.visits] == [_T0, late]


def test_the_gap_can_be_shortened_for_a_live_check(monkeypatch) -> None:
    monkeypatch.setenv("HANDOVER_VISIT_GAP_MINUTES", "0.1")
    assert visit_gap() == timedelta(seconds=6)


# Through the API


def test_import_opens_the_first_visit_with_what_was_brought_in(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    assert _events(test_client, session_id) == [("imported", 1, {"files": 3})]
    body = test_client.get(f"/api/session/{session_id}/handover").json()
    assert body["last_visit"] is None
    assert body["note"] is None


def test_a_no_op_edit_records_nothing(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    assert test_client.patch(f"/api/session/{session_id}/wizard/project", json=_PROJECT).status_code == 200
    rev = _record(test_client, session_id).content_rev
    before = _events(test_client, session_id)

    assert test_client.patch(f"/api/session/{session_id}/wizard/project", json=_PROJECT).status_code == 200
    feature = _first_feature(test_client, session_id)
    patched = test_client.patch(
        f"/api/session/{session_id}/features/{feature['id']}", json={"properties": feature["properties"]}
    )
    assert patched.status_code == 200
    stem = _record(test_client, session_id).files[0]
    assert (
        test_client.patch(
            f"/api/session/{session_id}/files/{stem.stem}", json={"detected_type": stem.detected_type}
        ).status_code
        == 200
    )
    bulk = test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"feature_ids": [feature["id"]], "properties": feature["properties"]},
    )
    assert bulk.status_code == 200

    assert _record(test_client, session_id).content_rev == rev
    assert _events(test_client, session_id) == before
    assert before == [("imported", 1, {"files": 3}), ("setup_changed", 1, {"section": "project"})]


def test_visiting_sections_records_nothing(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    _age(test_client, session_id, timedelta(hours=3))
    visits = len(_record(test_client, session_id).handover.visits)

    for path in ("wizard", "files", "features", "handover", "validation"):
        test_client.get(f"/api/session/{session_id}/{path}")

    record = _record(test_client, session_id)
    assert len(record.handover.visits) == visits
    assert _events(test_client, session_id) == [("imported", 1, {"files": 3})]


def test_resuming_after_the_gap_shows_the_last_visit(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    feature = _first_feature(test_client, session_id)
    renamed = {**feature["properties"], "name": {"en": "Renamed"}}
    assert (
        test_client.patch(
            f"/api/session/{session_id}/features/{feature['id']}", json={"properties": renamed}
        ).status_code
        == 200
    )
    _age(test_client, session_id, timedelta(hours=3))

    body = test_client.get(f"/api/session/{session_id}/handover").json()
    last = body["last_visit"]
    assert [(event["kind"], event["n"]) for event in last["events"]] == [("imported", 1), ("features_edited", 1)]
    assert datetime.fromisoformat(body["visit_started_at"]) > datetime.fromisoformat(last["ended_at"])

    deleted = test_client.delete(f"/api/session/{session_id}/features/{feature['id']}")
    assert deleted.status_code == 200
    again = test_client.get(f"/api/session/{session_id}/handover").json()
    assert again["last_visit"] == last
    assert again["visit_started_at"] == body["visit_started_at"]


# Note


def test_the_note_is_kept_on_the_project_and_is_not_an_edit(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    record = _record(test_client, session_id)
    rev, events = record.content_rev, _events(test_client, session_id)

    saved = test_client.put(f"/api/session/{session_id}/handover/note", json={"text": "  屋外 outline provisional. "})
    assert saved.status_code == 200, saved.text
    assert saved.json()["note"]["text"] == "屋外 outline provisional."

    _reopen_sessions(test_client)
    body = test_client.get(f"/api/session/{session_id}/handover").json()
    assert body["note"]["text"] == "屋外 outline provisional."
    assert "at" in body["note"]
    assert _record(test_client, session_id).content_rev == rev
    assert _events(test_client, session_id) == events


def test_a_blank_note_clears_it(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    test_client.put(f"/api/session/{session_id}/handover/note", json={"text": "hello"})
    cleared = test_client.put(f"/api/session/{session_id}/handover/note", json={"text": "   "})
    assert cleared.status_code == 200
    assert cleared.json()["note"] is None


def test_an_overlong_note_is_refused(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    response = test_client.put(f"/api/session/{session_id}/handover/note", json={"text": "x" * 2001})
    assert response.status_code in (400, 422)


# Listing


def test_listing_neither_touches_nor_starts_a_visit(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    _age(test_client, session_id, timedelta(hours=3))
    before = _record(test_client, session_id)
    last_accessed, started = before.last_accessed, before.handover.visit_started_at

    assert test_client.get("/api/projects").status_code == 200
    assert test_client.get(f"/api/projects/shapefiles/{session_id}").status_code == 200

    (summary,) = [
        item for item in test_client.app.state.session_manager.backend.list_summaries() if item.session_id == session_id
    ]
    assert summary.last_accessed == last_accessed
    assert _record(test_client, session_id).handover.visit_started_at == started


def test_the_meta_file_carries_no_handover(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    test_client.put(f"/api/session/{session_id}/handover/note", json={"text": "a note for the meta"})
    manager: SessionManager = test_client.app.state.session_manager
    meta = (Path(manager.backend.data_dir) / f"{session_id}.meta.json").read_text(encoding="utf-8")
    assert "imported" not in meta
    assert "a note for the meta" not in meta


# A visit boundary outlives the cache and a restart


def _resume_by_touch(client, session_id: str) -> str:
    _age(client, session_id, timedelta(hours=3))
    assert client.get(f"/api/session/{session_id}/files").status_code == 200
    started = _record(client, session_id).handover.visit_started_at
    assert started is not None and datetime.now(UTC) - started < timedelta(minutes=1)
    return started.isoformat().replace("+00:00", "Z")


def _same_instant(left: str, right: str) -> bool:
    return datetime.fromisoformat(left.replace("Z", "+00:00")) == datetime.fromisoformat(right.replace("Z", "+00:00"))


def test_a_visit_started_by_a_touch_survives_cache_eviction(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    current: SessionManager = test_client.app.state.session_manager
    manager = SessionManager(
        FileSystemSessionBackend(current.backend.data_dir, cache_size=1),
        ttl_hours=int(current.ttl.total_seconds() // 3600),
        max_sessions=current.max_sessions,
    )
    test_client.app.state.session_manager = manager
    started = _resume_by_touch(test_client, session_id)

    other = _import(test_client, sample_dir)
    assert test_client.get(f"/api/session/{other}/files").status_code == 200
    assert session_id not in manager.backend._cache

    body = test_client.get(f"/api/session/{session_id}/handover").json()
    assert _same_instant(body["visit_started_at"], started)
    assert body["last_visit"] is not None


def test_a_visit_started_by_a_touch_survives_a_restart(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    started = _resume_by_touch(test_client, session_id)

    _reopen_sessions(test_client)
    body = test_client.get(f"/api/session/{session_id}/handover").json()
    assert _same_instant(body["visit_started_at"], started)
    assert body["last_visit"] is not None


def test_a_touch_within_a_visit_does_not_rewrite_the_record(test_client, sample_dir: Path, monkeypatch) -> None:
    session_id = _import(test_client, sample_dir)
    manager: SessionManager = test_client.app.state.session_manager
    saves: list[str] = []
    original = manager.backend.save

    def counting(session: SessionRecord) -> None:
        saves.append(session.session_id)
        original(session)

    monkeypatch.setattr(manager.backend, "save", counting)
    for _ in range(3):
        assert test_client.get(f"/api/session/{session_id}/files").status_code == 200
    assert saves == []


# Gap setting


@pytest.mark.parametrize("raw", ["inf", "-inf", "nan", "0", "-5", "0.01", "100000", "soon"])
def test_an_unusable_gap_falls_back_to_the_default(monkeypatch, raw: str) -> None:
    monkeypatch.setenv("HANDOVER_VISIT_GAP_MINUTES", raw)
    assert visit_gap() == timedelta(minutes=30)
    assert gap_setting_problem() is not None


def test_a_usable_gap_reports_no_problem(monkeypatch) -> None:
    monkeypatch.setenv("HANDOVER_VISIT_GAP_MINUTES", str(7 * 24 * 60))
    assert visit_gap() == timedelta(days=7)
    assert gap_setting_problem() is None
    monkeypatch.delenv("HANDOVER_VISIT_GAP_MINUTES")
    assert gap_setting_problem() is None


def test_an_unusable_gap_is_warned_about_at_startup(monkeypatch, tmp_path: Path, caplog) -> None:
    from backend.main import _load_session_manager

    monkeypatch.setenv("SESSION_DATA_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("HANDOVER_VISIT_GAP_MINUTES", "inf")
    with caplog.at_level("WARNING"):
        _load_session_manager()
    assert any("HANDOVER_VISIT_GAP_MINUTES='inf'" in record.getMessage() for record in caplog.records)


def test_an_infinite_gap_does_not_break_requests(test_client, sample_dir: Path, monkeypatch) -> None:
    session_id = _import(test_client, sample_dir)
    monkeypatch.setenv("HANDOVER_VISIT_GAP_MINUTES", "inf")
    assert test_client.get(f"/api/session/{session_id}/handover").status_code == 200


# No-op comparison as JSON sees it


def test_a_change_from_one_to_true_is_stored_and_counts(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    feature = _first_feature(test_client, session_id)
    url = f"/api/session/{session_id}/features/{feature['id']}"
    assert test_client.patch(url, json={"properties": {**feature["properties"], "flag": 1}}).status_code == 200
    rev = _record(test_client, session_id).content_rev

    assert test_client.patch(url, json={"properties": {**feature["properties"], "flag": True}}).status_code == 200
    assert test_client.get(url).json()["properties"]["flag"] is True
    assert _record(test_client, session_id).content_rev == rev + 1

    bulk = f"/api/session/{session_id}/features/bulk"
    assert test_client.patch(bulk, json={"feature_ids": [feature["id"]], "properties": {"flag": 1}}).status_code == 200
    assert test_client.get(url).json()["properties"]["flag"] == 1
    assert _record(test_client, session_id).content_rev == rev + 2


def test_the_same_geometry_as_tuples_or_lists_does_not_count(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    feature = _first_feature(test_client, session_id)
    record = _record(test_client, session_id)
    row = next(item for item in record.feature_collection["features"] if item["id"] == feature["id"])

    def as_tuples(value):
        return tuple(as_tuples(item) for item in value) if isinstance(value, list) else value

    row["geometry"] = {**row["geometry"], "coordinates": as_tuples(row["geometry"]["coordinates"])}
    rev = record.content_rev
    events = _events(test_client, session_id)
    url = f"/api/session/{session_id}/features/{feature['id']}"
    assert test_client.patch(url, json={"geometry": feature["geometry"]}).status_code == 200
    bulk = test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"feature_ids": [feature["id"]], "properties": {}},
    )
    assert bulk.status_code == 200
    assert _record(test_client, session_id).content_rev == rev
    assert _events(test_client, session_id) == events
