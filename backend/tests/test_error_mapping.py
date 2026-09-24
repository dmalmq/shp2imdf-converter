"""Only a missing session may tell the browser its session has expired."""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from backend.routers import export_router
from backend.src.schemas import CleanupSummary, ImportedFile


def _seed_session(test_client):
    feature = {
        "type": "Feature",
        "id": "unit-1",
        "feature_type": "unit",
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]},
        "properties": {"category": "room"},
    }
    return test_client.app.state.session_manager.create_session(
        files=[ImportedFile(stem="seed", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": [feature]},
    )


@pytest.mark.phase1
def test_second_delete_of_a_feature_is_not_session_expiry(test_client) -> None:
    session = _seed_session(test_client)
    url = f"/api/session/{session.session_id}/features/unit-1"
    assert test_client.delete(url).status_code == 200

    response = test_client.delete(url)
    assert response.status_code == 404
    assert response.json()["code"] == "NOT_FOUND"


@pytest.mark.phase1
def test_unknown_file_stem_is_not_session_expiry(test_client) -> None:
    session = _seed_session(test_client)
    response = test_client.patch(f"/api/session/{session.session_id}/files/nope", json={"detected_type": "unit"})
    assert response.status_code == 404
    assert response.json()["code"] == "NOT_FOUND"


@pytest.mark.phase1
def test_unknown_placement_is_not_session_expiry(test_client) -> None:
    response = test_client.delete("/api/placements/987654321")
    assert response.status_code == 404
    assert response.json()["code"] == "NOT_FOUND"


@pytest.mark.phase1
def test_missing_session_is_still_session_expiry(test_client) -> None:
    for response in (
        test_client.post("/api/session/does-not-exist/validate"),
        test_client.post("/api/session/does-not-exist/generate"),
        test_client.get("/api/session/does-not-exist/wizard"),
        test_client.delete("/api/session/does-not-exist/features/unit-1"),
    ):
        assert response.status_code == 404
        assert response.json()["code"] == "SESSION_NOT_FOUND"


@pytest.mark.phase1
def test_stray_key_error_is_a_server_error(test_client, monkeypatch) -> None:
    session = _seed_session(test_client)

    def broken(_feature_collection):
        raise KeyError("properties")

    monkeypatch.setattr(export_router, "validate_feature_collection", broken)
    client = TestClient(test_client.app, raise_server_exceptions=False)
    response = client.post(f"/api/session/{session.session_id}/validate")
    assert response.status_code == 500
    assert response.json()["code"] == "INTERNAL_ERROR"


@pytest.mark.phase1
def test_corrupt_zip_upload_is_a_bad_request(test_client) -> None:
    client = TestClient(test_client.app, raise_server_exceptions=False)
    response = client.post(
        "/api/import",
        files=[("files", ("broken.zip", b"PK\x03\x04 not really a zip", "application/zip"))],
    )
    assert response.status_code == 400
    assert response.json()["code"] == "BAD_REQUEST"
