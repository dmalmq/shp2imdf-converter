"""Session store durability and shared-PC capacity."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from pathlib import Path

import pytest

from backend.main import _load_session_manager
from backend.src.schemas import CleanupSummary, ImportedFile
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
    monkeypatch.delenv("MAX_SESSIONS", raising=False)
    monkeypatch.setenv("SESSION_DATA_DIR", str(tmp_path))

    manager = _load_session_manager()
    assert manager.max_sessions == 50
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
