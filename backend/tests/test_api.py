"""API tests for Phase 1 endpoints."""

from __future__ import annotations

from io import BytesIO
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import zipfile

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


@pytest.mark.phase3
def test_wizard_project_creates_venue_address_feature(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "1-9-1 Marunouchi",
                "locality": "Chiyoda-ku",
                "country": "JP",
                "province": "JP-13",
            },
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["wizard"]["project"]["venue_name"] == "Tokyo Station"
    assert payload["address_feature"]["feature_type"] == "address"
    assert payload["address_feature"]["properties"]["address"] == "1-9-1 Marunouchi"


@pytest.mark.phase3
def test_missing_street_address_uses_venue_name(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "",
                "locality": "Chiyoda-ku",
                "country": "JP",
                "province": "JP-13",
            },
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["address_feature"]["properties"]["address"] == "Tokyo Station"


@pytest.mark.phase3
def test_wizard_buildings_creates_building_specific_address(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    project_response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "1-9-1 Marunouchi",
                "locality": "Chiyoda-ku",
                "country": "JP",
            },
        },
    )
    assert project_response.status_code == 200

    response = test_client.patch(
        f"/api/session/{session_id}/wizard/buildings",
        json={
            "buildings": [
                {
                    "id": "building-1",
                    "name": "Main",
                    "category": "unspecified",
                    "restriction": None,
                    "file_stems": ["JRTokyoSta_B1_Space"],
                    "address_mode": "same_as_venue",
                    "address": None,
                },
                {
                    "id": "building-2",
                    "name": "Annex",
                    "category": "transit",
                    "restriction": None,
                    "file_stems": ["JRTokyoSta_GF_Space"],
                    "address_mode": "different_address",
                    "address": {
                        "address": "2-1-1 Annex Rd",
                        "locality": "Chiyoda-ku",
                        "country": "JP",
                    },
                },
            ]
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["address_features"]) == 1
    annex = next(item for item in payload["wizard"]["buildings"] if item["id"] == "building-2")
    assert annex["address_feature_id"] is not None


@pytest.mark.phase3
def test_company_mappings_upload_refreshes_preview(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    mappings_response = test_client.patch(
        f"/api/session/{session_id}/wizard/mappings",
        json={
            "unit": {
                "code_column": "COMPANY_CO",
                "name_column": "NAME",
                "alt_name_column": None,
                "restriction_column": None,
                "accessibility_column": None,
                "preview": [],
            }
        },
    )
    assert mappings_response.status_code == 200

    upload_body = {
        "default_category": "unspecified",
        "mappings": {
            "SHOP": "retail",
            "OFFICE": "office",
        },
    }
    response = test_client.post(
        f"/api/session/{session_id}/config/company-mappings",
        files={
            "file": ("company_mappings.json", json.dumps(upload_body).encode("utf-8"), "application/json")
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["mappings_count"] == 2
    codes = {item["code"] for item in payload["preview"]}
    assert "SHOP" in codes
    assert "OFFICE" in codes


@pytest.mark.phase3
def test_generate_draft_adds_unlocated_address_and_building(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    project_response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "1-9-1 Marunouchi",
                "locality": "Chiyoda-ku",
                "country": "JP",
            },
        },
    )
    assert project_response.status_code == 200

    generate_response = test_client.post(f"/api/session/{session_id}/generate")
    assert generate_response.status_code == 200
    assert generate_response.json()["status"] == "draft"

    features_response = test_client.get(f"/api/session/{session_id}/features")
    payload = features_response.json()
    feature_types = [item["feature_type"] for item in payload["features"]]
    assert "address" in feature_types
    assert "building" in feature_types


@pytest.mark.phase3
def test_export_includes_manifest_json(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    project_response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en-US",
            "address": {
                "address": "1-9-1 Marunouchi",
                "locality": "Chiyoda-ku",
                "country": "JP",
            },
        },
    )
    assert project_response.status_code == 200

    export_response = test_client.get(f"/api/session/{session_id}/export")
    assert export_response.status_code == 200
    assert export_response.headers["content-type"] == "application/zip"

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "manifest.json" in names
        assert "features.geojson" in names

        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        assert manifest["version"] == "1.0.0"
        assert manifest["language"] == "en-US"
        assert isinstance(manifest["created"], str)
        assert manifest["created"]
        assert manifest["generated_by"] == "shp2imdf-converter phase3"
        assert "extensions" in manifest
