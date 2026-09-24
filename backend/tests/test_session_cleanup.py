"""The hourly cleanup must keep running, and restarts must not leak upload dirs."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

import backend.main as main
from backend.src.schemas import CleanupSummary, ImportedFile
from backend.src.session import FileSystemSessionBackend, SessionManager


class _Flaky:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> int:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("disk hiccup")
        return 0


@pytest.mark.phase6
def test_cleanup_loop_survives_a_failing_prune(monkeypatch) -> None:
    monkeypatch.setattr(main, "_CLEANUP_INTERVAL_SECONDS", 0.01, raising=False)
    sessions, conversions = _Flaky(), _Flaky()
    app = SimpleNamespace(
        state=SimpleNamespace(
            session_manager=SimpleNamespace(prune_expired=sessions),
            illustrator_store=SimpleNamespace(prune=conversions),
        )
    )

    async def run() -> None:
        stop = asyncio.Event()
        task = asyncio.create_task(main._session_cleanup_loop(app, stop))
        await asyncio.sleep(0.3)
        stop.set()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(run())
    assert sessions.calls >= 3
    assert conversions.calls >= 3


def _age(path: Path, hours: float) -> None:
    stamp = time.time() - hours * 3600
    os.utime(path, (stamp, stamp))


@pytest.mark.phase6
def test_startup_prunes_only_old_orphaned_upload_dirs(monkeypatch, tmp_path: Path) -> None:
    uploads = tmp_path / "uploads"
    sessions_dir = tmp_path / "sessions"
    uploads.mkdir()
    old_orphan = uploads / "old-orphan"
    fresh_orphan = uploads / "fresh-orphan"
    live = uploads / "live"
    for directory in (old_orphan, fresh_orphan, live):
        directory.mkdir()
        (directory / "a.shp").write_bytes(b"x")
    _age(old_orphan, 48)
    _age(live, 48)

    SessionManager(backend=FileSystemSessionBackend(sessions_dir)).create_session(
        files=[ImportedFile(stem="live", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": []},
        upload_artifact_dir=str(live),
    )

    monkeypatch.setenv("SESSION_UPLOADS_DIR", str(uploads))
    monkeypatch.setenv("SESSION_DATA_DIR", str(sessions_dir))
    monkeypatch.setenv("SESSION_TTL_HOURS", "24")
    with TestClient(main.app):
        deadline = time.monotonic() + 5
        while old_orphan.exists() and time.monotonic() < deadline:
            time.sleep(0.05)

    assert not old_orphan.exists()
    assert fresh_orphan.exists()
    assert live.exists()


@pytest.mark.phase6
def test_test_client_keeps_runtime_data_out_of_the_repo(test_client, tmp_path: Path) -> None:
    state = test_client.app.state
    assert tmp_path in Path(state.session_uploads_dir).parents
    assert tmp_path in Path(state.illustrator_store.root).parents
