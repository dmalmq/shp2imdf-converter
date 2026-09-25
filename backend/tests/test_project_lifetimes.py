"""How long projects stay on the shared PC, and which go first at the cap."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
import logging
import os
from pathlib import Path
import time

from fastapi.testclient import TestClient
import pytest

import backend.main as main
from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import ConversionExpiredError, ConversionStore
from backend.src.project_limits import ProjectLimits
from backend.src.projects import mark_changed, mark_delivered
from backend.src.schemas import CleanupSummary, ImportedFile
from backend.src.session import FileSystemSessionBackend, SessionManager
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf

DAY = 24 * 3600
LEGACY_NAMES = (
    "SESSION_TTL_HOURS",
    "MAX_SESSIONS",
    "ILLUSTRATOR_CACHE_TTL_MINUTES",
    "ILLUSTRATOR_CACHE_MAX_ENTRIES",
    "PROJECT_IDLE_DAYS",
    "MAX_PROJECTS",
)


@pytest.fixture(autouse=True)
def _no_lifetime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in LEGACY_NAMES:
        monkeypatch.delenv(name, raising=False)


def _app_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SESSION_DATA_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("SESSION_UPLOADS_DIR", str(tmp_path / "session_uploads"))
    monkeypatch.setenv("TEMP_DATA_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("ILLUSTRATOR_DATA_DIR", str(tmp_path / "illustrator"))
    monkeypatch.setenv("PLACEMENTS_DB", str(tmp_path / "placements.db"))


def _create(manager: SessionManager, stem: str = "sample", upload_artifact_dir: str | None = None):
    return manager.create_session(
        files=[ImportedFile(stem=stem, geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": []},
        upload_artifact_dir=upload_artifact_dir,
    )


def _age_session(manager: SessionManager, session_id: str, *, hours: float) -> None:
    record = manager.get_session(session_id, touch=False)
    record.last_accessed = datetime.now(UTC) - timedelta(hours=hours)
    manager.backend.save(record)


def _session_ids(manager: SessionManager) -> set[str]:
    return {summary.session_id for summary in manager.backend.list_summaries()}


# Defaults and legacy settings


@pytest.mark.phase6
def test_both_flows_default_to_thirty_days_and_two_hundred_projects(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _app_env(monkeypatch, tmp_path)

    manager = main._load_session_manager()
    store = main._load_illustrator_store()

    assert manager.ttl == timedelta(days=30)
    assert manager.max_sessions == 200
    assert store.ttl_seconds == 30 * DAY
    assert store.max_entries == 200


@pytest.mark.phase6
def test_project_limits_expose_the_effective_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PROJECT_IDLE_DAYS", "10")
    monkeypatch.setenv("MAX_PROJECTS", "40")
    monkeypatch.setenv("ILLUSTRATOR_CACHE_TTL_MINUTES", "120")

    limits = ProjectLimits.from_env()

    assert limits.to_dict() == {
        "sessions": {"idle_seconds": 10 * DAY, "max_projects": 40, "legacy_settings": []},
        "artwork": {
            "idle_seconds": 7200,
            "max_projects": 40,
            "legacy_settings": ["ILLUSTRATOR_CACHE_TTL_MINUTES"],
        },
        "protected_seconds": DAY,
        "orphan_upload_seconds": DAY,
    }


@pytest.mark.phase6
@pytest.mark.parametrize("name", ["PROJECT_IDLE_DAYS", "MAX_PROJECTS"])
def test_non_positive_limits_are_refused(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setenv(name, "0")
    with pytest.raises(ValueError, match=name):
        ProjectLimits.from_env()


@pytest.mark.phase6
def test_legacy_settings_win_when_set(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _app_env(monkeypatch, tmp_path)
    monkeypatch.setenv("PROJECT_IDLE_DAYS", "30")
    monkeypatch.setenv("MAX_PROJECTS", "200")
    monkeypatch.setenv("SESSION_TTL_HOURS", "24")
    monkeypatch.setenv("MAX_SESSIONS", "50")
    monkeypatch.setenv("ILLUSTRATOR_CACHE_TTL_MINUTES", "120")
    monkeypatch.setenv("ILLUSTRATOR_CACHE_MAX_ENTRIES", "20")

    manager = main._load_session_manager()
    store = main._load_illustrator_store()

    assert manager.ttl == timedelta(hours=24)
    assert manager.max_sessions == 50
    assert store.ttl_seconds == 7200
    assert store.max_entries == 20


@pytest.mark.phase6
def test_startup_warns_about_legacy_settings_naming_the_effective_values(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _app_env(monkeypatch, tmp_path)
    monkeypatch.setenv("SESSION_TTL_HOURS", "24")
    monkeypatch.setenv("ILLUSTRATOR_CACHE_TTL_MINUTES", "120")

    with caplog.at_level(logging.INFO, logger="backend"), TestClient(main.app) as client:
        assert client.app.state.project_limits.sessions.idle_seconds == DAY

    warnings = [record.getMessage() for record in caplog.records if record.levelno == logging.WARNING]
    session_warning = next(message for message in warnings if "SESSION_TTL_HOURS=24" in message)
    assert "24 h" in session_warning and "200" in session_warning
    artwork_warning = next(message for message in warnings if "ILLUSTRATOR_CACHE_TTL_MINUTES=120" in message)
    assert "2 h" in artwork_warning and "200" in artwork_warning


@pytest.mark.phase6
def test_startup_without_legacy_settings_does_not_warn(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _app_env(monkeypatch, tmp_path)

    with caplog.at_level(logging.INFO, logger="backend"), TestClient(main.app):
        pass

    messages = [record.getMessage() for record in caplog.records if record.name.startswith("backend")]
    assert not [record for record in caplog.records if record.levelno >= logging.WARNING]
    assert any("30 days" in message and "200" in message for message in messages)


@pytest.mark.phase6
def test_startup_logs_store_sizes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _app_env(monkeypatch, tmp_path)
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path / "sessions"))
    _create(manager)
    _create(manager)
    ConversionStore(root=tmp_path / "illustrator", ttl_seconds=DAY, max_entries=5).put(
        parse_ai(_build_minimal_ai_pdf(), "one.ai")
    )

    with caplog.at_level(logging.INFO, logger="backend"), TestClient(main.app):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            messages = [record.getMessage() for record in caplog.records]
            if sum("on disk" in message for message in messages) >= 2:
                break
            time.sleep(0.05)

    sizes = [message for message in messages if "on disk" in message]
    assert any(message.startswith("Shapefile sessions on disk: 2 projects") for message in sizes)
    assert any(message.startswith("Artwork conversions on disk: 1 project,") for message in sizes)


# Session eviction at the cap


@pytest.mark.phase6
def test_session_cap_never_evicts_one_opened_within_a_day(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), max_sessions=2)
    older = _create(manager, "older")
    recent = _create(manager, "recent")
    _age_session(manager, older.session_id, hours=30)
    _age_session(manager, recent.session_id, hours=23)

    newest = _create(manager, "newest")

    assert _session_ids(manager) == {recent.session_id, newest.session_id}


@pytest.mark.phase6
def test_session_cap_evicts_the_oldest_last_opened(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), max_sessions=3)
    sessions = [_create(manager, stem) for stem in ("a", "b", "c")]
    for session, days in zip(sessions, (3, 9, 5)):
        _age_session(manager, session.session_id, hours=days * 24)

    _create(manager, "d")

    remaining = _session_ids(manager)
    assert sessions[1].session_id not in remaining
    assert {sessions[0].session_id, sessions[2].session_id} <= remaining


@pytest.mark.phase6
def test_session_cap_prefers_a_delivered_unchanged_one_only_on_a_tie(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), max_sessions=3)
    oldest, reworked, delivered = (_create(manager, stem) for stem in ("a", "b", "c"))
    stamp = datetime.now(UTC) - timedelta(days=4)
    for session, changed_after in ((oldest, False), (reworked, True), (delivered, False)):
        record = manager.get_session(session.session_id, touch=False)
        mark_delivered(record, "imdf", 0)
        if changed_after:
            mark_changed(record, "features_edited")
        record.last_accessed = stamp if session is not oldest else stamp - timedelta(days=4)
        manager.backend.save(record)

    _create(manager, "d")
    remaining = _session_ids(manager)
    assert oldest.session_id not in remaining
    assert {reworked.session_id, delivered.session_id} <= remaining

    _create(manager, "e")
    remaining = _session_ids(manager)
    assert delivered.session_id not in remaining
    assert reworked.session_id in remaining


@pytest.mark.phase6
def test_session_delivery_state_for_the_cap_survives_a_restart(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), max_sessions=2)
    reworked, delivered = _create(manager, "a"), _create(manager, "b")
    stamp = datetime.now(UTC) - timedelta(days=4)
    for session in (reworked, delivered):
        record = manager.get_session(session.session_id, touch=False)
        mark_delivered(record, "imdf", 0)
        if session is reworked:
            mark_changed(record, "features_edited")
        record.last_accessed = stamp
        manager.backend.save(record)

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), max_sessions=2)
    _create(restarted, "c")

    remaining = _session_ids(restarted)
    assert delivered.session_id not in remaining
    assert reworked.session_id in remaining


@pytest.mark.phase6
def test_session_cap_overflows_and_logs_when_every_session_is_fresh(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), max_sessions=2)
    first, second = _create(manager, "a"), _create(manager, "b")

    with caplog.at_level(logging.WARNING, logger="backend.src.session"):
        third = _create(manager, "c")

    assert _session_ids(manager) == {first.session_id, second.session_id, third.session_id}
    overflow = [record.getMessage() for record in caplog.records if record.levelno == logging.WARNING]
    assert len(overflow) == 1
    assert "cap of 2" in overflow[0] and "24 h" in overflow[0]


@pytest.mark.phase6
def test_session_eviction_and_pruning_read_meta_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24 * 30, max_sessions=3)
    sessions = [_create(manager, stem) for stem in ("a", "b", "c")]
    _age_session(manager, sessions[0].session_id, hours=24 * 31)
    _age_session(manager, sessions[1].session_id, hours=24 * 5)
    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24 * 30, max_sessions=2)

    calls = {"count": 0}
    real_loads = json.loads

    def counting_loads(*args, **kwargs):
        calls["count"] += 1
        return real_loads(*args, **kwargs)

    monkeypatch.setattr("backend.src.session.json.loads", counting_loads)
    assert restarted.prune_expired() == 1
    _create(restarted, "d")

    assert calls["count"] == 0
    assert sessions[1].session_id not in _session_ids(restarted)


# Artwork eviction at the cap


def _put(store: ConversionStore, name: str):
    return store.put(parse_ai(_build_minimal_ai_pdf(), name))


def _set_last_opened(cached, seconds_ago: float) -> None:
    stamp = time.time() - seconds_ago
    os.utime(cached.directory / "last_used", (stamp, stamp))


def _mark_delivered_unchanged(cached) -> None:
    path = cached.directory / "project.json"
    project = json.loads(path.read_text(encoding="utf-8"))
    project["content_changed_at"] = "2026-01-01T00:00:00+00:00"
    project["delivered_at"] = "2026-01-02T00:00:00+00:00"
    path.write_text(json.dumps(project), encoding="utf-8")


@pytest.mark.georef
def test_artwork_cap_never_evicts_one_opened_within_a_day(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=30 * DAY, max_entries=2)
    older, recent = _put(store, "older.ai"), _put(store, "recent.ai")
    _set_last_opened(older, 30 * 3600)
    _set_last_opened(recent, 23 * 3600)

    newest = _put(store, "newest.ai")

    assert not older.directory.exists()
    assert recent.directory.exists() and newest.directory.exists()


@pytest.mark.georef
def test_artwork_cap_evicts_the_oldest_last_opened_even_if_another_is_delivered(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=30 * DAY, max_entries=3)
    entries = [_put(store, f"{name}.ai") for name in ("a", "b", "c")]
    for cached, days in zip(entries, (3, 9, 5)):
        _set_last_opened(cached, days * DAY)
    _mark_delivered_unchanged(entries[0])

    _put(store, "d.ai")

    assert not entries[1].directory.exists()
    assert entries[0].directory.exists() and entries[2].directory.exists()


@pytest.mark.georef
def test_artwork_cap_prefers_a_delivered_unchanged_one_on_a_tie(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=30 * DAY, max_entries=2)
    tied = sorted((_put(store, "a.ai"), _put(store, "b.ai")), key=lambda item: item.conversion_id)
    # The delivered one lists last, so directory order cannot pick it by luck.
    still_open, delivered = tied
    stamp = time.time() - 4 * DAY
    for cached in tied:
        os.utime(cached.directory / "last_used", (stamp, stamp))
    _mark_delivered_unchanged(delivered)

    _put(store, "new.ai")

    assert not delivered.directory.exists()
    assert store.get(still_open.conversion_id).stem == still_open.stem


@pytest.mark.georef
def test_artwork_cap_overflows_and_logs_when_every_entry_is_fresh(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=30 * DAY, max_entries=2)
    entries = [_put(store, "a.ai"), _put(store, "b.ai")]

    with caplog.at_level(logging.WARNING, logger="backend.src.illustrator_store"):
        entries.append(_put(store, "c.ai"))

    for cached in entries:
        assert store.get(cached.conversion_id) is not None
    overflow = [record.getMessage() for record in caplog.records if record.levelno == logging.WARNING]
    assert len(overflow) == 1
    assert "cap of 2" in overflow[0] and "24 h" in overflow[0]


@pytest.mark.georef
def test_an_evicted_artwork_entry_is_gone(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=30 * DAY, max_entries=1)
    old = _put(store, "old.ai")
    _set_last_opened(old, 2 * DAY)
    _put(store, "new.ai")
    with pytest.raises(ConversionExpiredError):
        store.get(old.conversion_id)


# Orphaned upload directories


def _age_path(path: Path, hours: float) -> None:
    stamp = time.time() - hours * 3600
    os.utime(path, (stamp, stamp))


@pytest.mark.phase6
@pytest.mark.parametrize("session_ttl_hours", [None, "72", "1"])
def test_orphan_uploads_are_cleaned_after_a_day_whatever_the_session_lifetime(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, session_ttl_hours: str | None
) -> None:
    _app_env(monkeypatch, tmp_path)
    if session_ttl_hours is not None:
        monkeypatch.setenv("SESSION_TTL_HOURS", session_ttl_hours)
    uploads = tmp_path / "session_uploads"
    uploads.mkdir()
    stale, fresh = uploads / "stale", uploads / "fresh"
    for directory in (stale, fresh):
        directory.mkdir()
        (directory / "a.shp").write_bytes(b"x")
    _age_path(stale, 30)
    _age_path(fresh, 2)

    with TestClient(main.app):
        deadline = time.monotonic() + 5
        while stale.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        time.sleep(0.1)

    assert not stale.exists()
    assert fresh.exists()
