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


@pytest.mark.phase2
def test_detect_endpoint_reruns_detection(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    response = test_client.post(f"/api/session/{session_id}/detect")
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session_id
    assert len(payload["files"]) >= 2
    assert any(item["confidence"] in {"green", "yellow", "red"} for item in payload["files"])


@pytest.mark.phase2
def test_patch_file_updates_type_and_returns_learning_prompt(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    response = test_client.patch(
        f"/api/session/{session_id}/files/JRTokyoSta_B1_Space",
        json={"detected_type": "opening"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["file"]["detected_type"] == "opening"
    assert payload["learning_suggestion"] is not None


@pytest.mark.phase2
def test_apply_learning_updates_other_files(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    first_patch = test_client.patch(
        f"/api/session/{session_id}/files/JRTokyoSta_B1_Space",
        json={"detected_type": "opening"},
    )
    suggestion = first_patch.json()["learning_suggestion"]
    assert suggestion is not None

    response = test_client.patch(
        f"/api/session/{session_id}/files/JRTokyoSta_B1_Space",
        json={
            "detected_type": "opening",
            "apply_learning": True,
            "learning_keyword": suggestion["keyword"],
        },
    )
    assert response.status_code == 200
    payload = response.json()
    gf = next(item for item in payload["files"] if item["stem"] == "JRTokyoSta_GF_Space")
    assert gf["detected_type"] == "opening"
