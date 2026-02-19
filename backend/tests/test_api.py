"""API tests for Phase 1 endpoints."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from backend.src.schemas import CleanupSummary, ImportedFile
from backend.src.session import MemorySessionBackend, SessionManager


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sample_dir.glob(f"{stem}.*"):
        files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


@pytest.mark.phase1
def test_import_endpoint_creates_session(test_client, sample_dir: Path) -> None:
    response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    assert response.status_code == 201
    payload = response.json()
    assert payload["session_id"]
    assert payload["files"]
    assert "cleanup_summary" in payload


@pytest.mark.phase1
def test_features_endpoint_returns_geojson(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    response = test_client.get(f"/api/session/{session_id}/features")
    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "FeatureCollection"
    assert len(payload["features"]) > 0


@pytest.mark.phase1
def test_unknown_session_returns_404(test_client) -> None:
    response = test_client.get("/api/session/does-not-exist/features")
    assert response.status_code == 404
    payload = response.json()
    assert payload["code"] == "SESSION_NOT_FOUND"


@pytest.mark.phase1
def test_session_cleanup_prunes_expired_sessions() -> None:
    manager = SessionManager(backend=MemorySessionBackend(), ttl_hours=1, max_sessions=5)
    session = manager.create_session(
        files=[
            ImportedFile(
                stem="sample",
                geometry_type="Polygon",
                feature_count=1,
                attribute_columns=[],
                confidence="green",
            )
        ],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": []},
    )
    record = manager.get_session(session.session_id, touch=False)
    assert record is not None
    record.last_accessed = datetime.now(UTC) - timedelta(hours=2)
    manager.backend.save(record)

    removed = manager.prune_expired()
    assert removed == 1
    assert manager.get_session(session.session_id) is None

