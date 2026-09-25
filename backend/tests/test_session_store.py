"""Session store durability and shared-PC capacity."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from pathlib import Path

import pytest

from backend.main import _load_session_manager
from backend.src.schemas import SESSION_RECORD_SCHEMA_VERSION, CleanupSummary, ImportedFile
from backend.src.session import FileSystemSessionBackend, SessionManager


def _create(manager: SessionManager, stem: str = "sample"):
    return manager.create_session(
        files=[ImportedFile(stem=stem, geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": []},
    )


@pytest.mark.phase1
def test_default_session_manager_is_durable_and_roomy(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("SESSION_BACKEND", raising=False)
    for name in ("MAX_SESSIONS", "SESSION_TTL_HOURS", "MAX_PROJECTS", "PROJECT_IDLE_DAYS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SESSION_DATA_DIR", str(tmp_path))

    manager = _load_session_manager()
    assert manager.max_sessions == 200
    assert manager.ttl == timedelta(days=30)
    session = _create(manager)

    restarted = _load_session_manager()
    survivor = restarted.get_session(session.session_id)
    assert survivor is not None
    assert survivor.files[0].stem == "sample"


@pytest.mark.phase1
def test_filesystem_get_does_not_rewrite_session_file(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    path = tmp_path / f"{session.session_id}.json"
    before = path.read_bytes()

    for _ in range(3):
        assert manager.get_session(session.session_id) is not None

    assert path.read_bytes() == before


@pytest.mark.phase1
def test_filesystem_touch_persists_on_next_save(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    record = manager.get_session(session.session_id, touch=False)
    record.last_accessed = datetime.now(UTC) - timedelta(hours=2)
    manager.backend.save(record)

    touched = manager.get_session(session.session_id)
    manager.save_session(touched)

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=1)
    assert restarted.prune_expired() == 0
    assert restarted.get_session(session.session_id) is not None


@pytest.mark.phase1
def test_filesystem_prune_survives_restart(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=1)
    session = _create(manager)
    record = manager.get_session(session.session_id, touch=False)
    record.last_accessed = datetime.now(UTC) - timedelta(hours=2)
    manager.backend.save(record)

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=1)
    assert restarted.prune_expired() == 1
    assert restarted.get_session(session.session_id) is None
    assert not (tmp_path / f"{session.session_id}.json").exists()


@pytest.mark.phase1
def test_filesystem_create_does_not_reparse_every_session(monkeypatch, tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24, max_sessions=50)
    for index in range(5):
        _create(manager, stem=f"s{index}")

    calls = {"count": 0}
    real_loads = json.loads

    def counting_loads(*args, **kwargs):
        calls["count"] += 1
        return real_loads(*args, **kwargs)

    monkeypatch.setattr("backend.src.session.json.loads", counting_loads)
    _create(manager, stem="new")

    assert calls["count"] == 0


@pytest.mark.phase1
def test_filesystem_save_leaves_no_temp_files(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    manager.save_session(session)
    manager.save_session(session)

    assert sorted(item.name for item in tmp_path.iterdir() if item.suffix == ".tmp") == []
    json.loads((tmp_path / f"{session.session_id}.json").read_text(encoding="utf-8"))


def _write_record_from_a_newer_version(tmp_path: Path) -> str:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    path = tmp_path / f"{session.session_id}.json"
    record = json.loads(path.read_text(encoding="utf-8"))
    record["project_id"] = "added-by-a-later-version"
    record["files"][0]["source_hash"] = "abc"
    record["cleanup_summary"]["future_counter"] = 3
    record["wizard"]["future_step"] = {"done": True}
    record["wizard"]["footprint"]["future_knob"] = 1.5
    record["wizard"]["mappings"]["unit"]["future_column"] = "X"
    record["wizard"]["levels"]["items"] = [
        {"stem": "sample", "ordinal": 0, "future_flag": True}
    ]
    record["wizard"]["project"] = {
        "venue_name": "Tokyo Station",
        "venue_category": "transitstation",
        "address": {"locality": "Chiyoda-ku", "country": "JP", "future_line": "x"},
        "future_setting": 1,
    }
    record["validation"] = {
        "errors": [
            {"check": "c", "message": "m", "severity": "error", "future_hint": "h"}
        ],
        "summary": {"error_count": 1, "future_total": 9},
        "future_section": [],
    }
    path.write_text(json.dumps(record), encoding="utf-8")
    return session.session_id


@pytest.mark.phase1
def test_stored_records_with_unknown_fields_still_load(tmp_path: Path) -> None:
    session_id = _write_record_from_a_newer_version(tmp_path)

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    loaded = restarted.get_session(session_id)

    assert loaded is not None
    assert loaded.files[0].stem == "sample"
    assert loaded.wizard.project is not None
    assert loaded.wizard.project.address.locality == "Chiyoda-ku"
    assert loaded.wizard.levels.items[0].ordinal == 0
    assert loaded.validation is not None
    assert loaded.validation.errors[0].check == "c"
    assert loaded.validation.summary.error_count == 1
    assert "project_id" not in loaded.model_dump()


@pytest.mark.phase1
def test_stored_record_with_unknown_fields_is_served_over_http(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    sessions = tmp_path / "sessions"
    session_id = _write_record_from_a_newer_version(sessions)
    monkeypatch.setenv("SESSION_DATA_DIR", str(sessions))
    monkeypatch.setenv("SESSION_UPLOADS_DIR", str(tmp_path / "session_uploads"))
    monkeypatch.setenv("TEMP_DATA_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("PLACEMENTS_DB", str(tmp_path / "placements.db"))
    with TestClient(app) as client:
        response = client.get(f"/api/session/{session_id}/wizard")
    assert response.status_code == 200, response.text
    assert response.json()["wizard"]["project"]["venue_name"] == "Tokyo Station"


@pytest.mark.phase1
def test_records_carry_a_schema_version(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    stored = json.loads((tmp_path / f"{session.session_id}.json").read_text(encoding="utf-8"))
    assert stored["schema_version"] == SESSION_RECORD_SCHEMA_VERSION

    del stored["schema_version"]
    (tmp_path / f"{session.session_id}.json").write_text(json.dumps(stored), encoding="utf-8")
    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    assert restarted.get_session(session.session_id).schema_version == SESSION_RECORD_SCHEMA_VERSION


def _mark_newer(path: Path) -> None:
    record = json.loads(path.read_text(encoding="utf-8"))
    record["schema_version"] = SESSION_RECORD_SCHEMA_VERSION + 1
    path.write_text(json.dumps(record), encoding="utf-8")


@pytest.mark.phase1
def test_an_unchanged_save_keeps_the_newer_record_byte_identical(tmp_path: Path) -> None:
    session_id = _write_record_from_a_newer_version(tmp_path)
    path = tmp_path / f"{session_id}.json"
    _mark_newer(path)
    before = path.read_bytes()

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    restarted.save_session(restarted.get_session(session_id))

    assert path.read_bytes() == before


@pytest.mark.phase1
def test_a_changed_save_writes_this_versions_shape(tmp_path: Path) -> None:
    session_id = _write_record_from_a_newer_version(tmp_path)
    path = tmp_path / f"{session_id}.json"
    _mark_newer(path)

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = restarted.get_session(session_id)
    session.warnings.append("changed")
    restarted.save_session(session)

    rewritten = json.loads(path.read_text(encoding="utf-8"))
    assert rewritten["schema_version"] == SESSION_RECORD_SCHEMA_VERSION
    assert rewritten["warnings"] == ["changed"]
    assert "project_id" not in rewritten


@pytest.mark.phase1
def test_a_lossy_load_warns_once_naming_the_session_and_keys(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    session_id = _write_record_from_a_newer_version(tmp_path)
    _mark_newer(tmp_path / f"{session_id}.json")

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    with caplog.at_level("WARNING", logger="backend.src.session"):
        restarted.get_session(session_id)
        restarted.get_session(session_id)

    warnings = [record.getMessage() for record in caplog.records if record.levelname == "WARNING"]
    assert len(warnings) == 1
    assert session_id in warnings[0]
    for key in ("project_id", "wizard.footprint.future_knob", "validation.errors[0].future_hint"):
        assert key in warnings[0]
    assert str(SESSION_RECORD_SCHEMA_VERSION + 1) in warnings[0]


@pytest.mark.phase1
def test_a_newer_version_alone_is_warned_about(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    _mark_newer(tmp_path / f"{session.session_id}.json")

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    with caplog.at_level("WARNING", logger="backend.src.session"):
        restarted.get_session(session.session_id)

    assert any(session.session_id in record.getMessage() for record in caplog.records)


@pytest.mark.phase1
def test_viewing_a_record_over_http_leaves_the_file_byte_identical(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    sessions = tmp_path / "sessions"
    monkeypatch.setenv("SESSION_DATA_DIR", str(sessions))
    monkeypatch.setenv("SESSION_UPLOADS_DIR", str(tmp_path / "session_uploads"))
    monkeypatch.setenv("TEMP_DATA_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("PLACEMENTS_DB", str(tmp_path / "placements.db"))

    with TestClient(app) as client:
        session = _create(client.app.state.session_manager)
        assert client.get(f"/api/session/{session.session_id}/wizard").status_code == 200

    path = sessions / f"{session.session_id}.json"
    record = json.loads(path.read_text(encoding="utf-8"))
    record["project_id"] = "added-by-a-later-version"
    record["wizard"]["footprint"]["future_knob"] = 1.5
    record["schema_version"] = SESSION_RECORD_SCHEMA_VERSION + 1
    path.write_text(json.dumps(record), encoding="utf-8")
    before = path.read_bytes()

    with TestClient(app) as client:
        for route in ("wizard", "files", "features", "wizard"):
            response = client.get(f"/api/session/{session.session_id}/{route}")
            assert response.status_code == 200, response.text

    assert path.read_bytes() == before


@pytest.mark.phase1
@pytest.mark.parametrize(
    "corruption",
    [
        lambda record: "not json at all",
        lambda record: json.dumps({**record, "files": "not a list"}),
        lambda record: json.dumps({key: value for key, value in record.items() if key != "session_id"}),
    ],
    ids=["not-json", "wrong-type", "missing-required"],
)
def test_an_unreadable_record_is_not_found_and_logged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture, corruption
) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    sessions = tmp_path / "sessions"
    manager = SessionManager(backend=FileSystemSessionBackend(sessions), ttl_hours=24)
    session = _create(manager)
    path = sessions / f"{session.session_id}.json"
    path.write_text(corruption(json.loads(path.read_text(encoding="utf-8"))), encoding="utf-8")

    monkeypatch.setenv("SESSION_DATA_DIR", str(sessions))
    monkeypatch.setenv("SESSION_UPLOADS_DIR", str(tmp_path / "session_uploads"))
    monkeypatch.setenv("TEMP_DATA_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("PLACEMENTS_DB", str(tmp_path / "placements.db"))
    with caplog.at_level("ERROR", logger="backend.src.session"), TestClient(app) as client:
        response = client.get(f"/api/session/{session.session_id}/wizard")

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "SESSION_NOT_FOUND"
    assert any(session.session_id in record.getMessage() for record in caplog.records)
    assert path.exists()


_PROJECT_BODY = {
    "venue_name": "Tokyo Station",
    "venue_category": "transitstation",
    "address": {"locality": "Chiyoda-ku", "country": "JP"},
}


@pytest.mark.phase1
@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("wizard/project", {**_PROJECT_BODY, "future_setting": 1}),
        (
            "wizard/project",
            {**_PROJECT_BODY, "address": {**_PROJECT_BODY["address"], "future_line": "x"}},
        ),
        ("wizard/levels", {"items": [{"stem": "sample", "future_flag": True}]}),
        ("wizard/footprint", {"method": "union_buffer", "future_knob": 1.5}),
    ],
)
def test_request_bodies_still_reject_unknown_fields(test_client, route: str, body: dict) -> None:
    session = _create(test_client.app.state.session_manager)
    response = test_client.patch(f"/api/session/{session.session_id}/{route}", json=body)
    assert response.status_code == 422, response.text
    assert "extra" in response.text.lower() or "forbidden" in response.text.lower()
