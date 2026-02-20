"""API tests for Phase 1 endpoints."""

from __future__ import annotations

from io import BytesIO
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import zipfile

import pytest

from backend.src.geocoding import GeocodeAddressParts, GeocodeMatch, GeocodingError
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
def test_wizard_auto_detects_unit_mapping_columns(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    response = test_client.get(f"/api/session/{session_id}/wizard")
    assert response.status_code == 200
    payload = response.json()
    unit_mapping = payload["wizard"]["mappings"]["unit"]
    assert unit_mapping["code_column"] == "COMPANY_CO"
    assert unit_mapping["name_column"] == "NAME"


@pytest.mark.phase3
def test_wizard_auto_detects_opening_mapping_columns(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Opening"))
    session_id = import_response.json()["session_id"]

    response = test_client.get(f"/api/session/{session_id}/wizard")
    assert response.status_code == 200
    payload = response.json()
    opening_mapping = payload["wizard"]["mappings"]["opening"]
    assert opening_mapping["category_column"] == "TYPE"


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
def test_unit_category_override_updates_preview_for_same_raw_code(test_client, sample_dir: Path) -> None:
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
                "available_categories": [],
                "preview": [],
            }
        },
    )
    assert mappings_response.status_code == 200

    response = test_client.patch(
        f"/api/session/{session_id}/wizard/mappings",
        json={
            "unit_category_overrides": {
                "SHOP": "foodservice",
            }
        },
    )
    assert response.status_code == 200
    payload = response.json()
    shop_row = next(item for item in payload["wizard"]["mappings"]["unit"]["preview"] if item["code"] == "SHOP")
    assert shop_row["resolved_category"] == "foodservice"
    assert shop_row["unresolved"] is False
    assert payload["wizard"]["company_mappings"]["SHOP"] == "foodservice"


@pytest.mark.phase3
def test_wizard_address_search_endpoint_returns_geocoder_results(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    class FakeGeocoder:
        def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
            assert query == "新宿駅"
            assert language == "ja"
            assert limit == 5
            return [
                GeocodeMatch(
                    display_name="新宿駅, 新宿区, 東京都, JP",
                    latitude=35.690921,
                    longitude=139.700258,
                    source="fake",
                    address=GeocodeAddressParts(
                        address="新宿3-38-1",
                        locality="新宿区",
                        province="JP-13",
                        country="JP",
                        postal_code="160-0022",
                    ),
                )
            ]

        def reverse(self, latitude: float, longitude: float, language: str) -> GeocodeMatch | None:
            return None

    test_client.app.state.geocoder = FakeGeocoder()
    response = test_client.get(f"/api/session/{session_id}/wizard/address/search", params={"query": "新宿駅", "language": "ja"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session_id
    assert payload["results"][0]["address"]["country"] == "JP"
    assert payload["results"][0]["source"] == "fake"


@pytest.mark.phase3
def test_wizard_address_autofill_uses_geometry_reverse_geocoding(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    class FakeGeocoder:
        def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
            return []

        def reverse(self, latitude: float, longitude: float, language: str) -> GeocodeMatch | None:
            assert language == "ja"
            return GeocodeMatch(
                display_name="東京駅, 千代田区, 東京都, JP",
                latitude=latitude,
                longitude=longitude,
                source="fake",
                address=GeocodeAddressParts(
                    address="丸の内1-9-1",
                    locality="千代田区",
                    province="JP-13",
                    country="JP",
                    postal_code="100-0005",
                ),
            )

    test_client.app.state.geocoder = FakeGeocoder()
    response = test_client.post(f"/api/session/{session_id}/wizard/address/autofill", params={"language": "ja"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["result"] is not None
    assert payload["result"]["address"]["locality"] == "千代田区"
    assert payload["source_point"] is not None


@pytest.mark.phase3
def test_wizard_address_search_returns_503_when_geocoder_disabled(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    test_client.app.state.geocoder = None
    response = test_client.get(
        f"/api/session/{session_id}/wizard/address/search",
        params={"query": "Tokyo Station", "language": "en"},
    )
    assert response.status_code == 503
    payload = response.json()
    assert payload["code"] == "GEOCODER_DISABLED"


@pytest.mark.phase3
def test_wizard_address_search_surfaces_geocoder_rate_limit_error(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]

    class RateLimitedGeocoder:
        def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
            raise GeocodingError(
                "Geocoding provider rate limit reached.",
                code="GEOCODER_RATE_LIMIT",
                status_code=503,
            )

        def reverse(self, latitude: float, longitude: float, language: str) -> GeocodeMatch | None:
            return None

    test_client.app.state.geocoder = RateLimitedGeocoder()
    response = test_client.get(
        f"/api/session/{session_id}/wizard/address/search",
        params={"query": "Tokyo Station", "language": "en"},
    )
    assert response.status_code == 503
    payload = response.json()
    assert payload["code"] == "GEOCODER_RATE_LIMIT"


@pytest.mark.phase4
def test_generate_creates_review_ready_feature_set(test_client, sample_dir: Path) -> None:
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
    assert generate_response.json()["status"] == "generated"

    features_response = test_client.get(f"/api/session/{session_id}/features")
    payload = features_response.json()
    feature_types = [item["feature_type"] for item in payload["features"]]
    assert "address" in feature_types
    assert "building" in feature_types
    assert "level" in feature_types
    assert "footprint" in feature_types
    assert "unit" in feature_types
    assert "venue" in feature_types


@pytest.mark.phase5
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
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200

    export_response = test_client.get(f"/api/session/{session_id}/export")
    assert export_response.status_code == 200
    assert export_response.headers["content-type"] == "application/zip"

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "manifest.json" in names
        assert "address.geojson" in names
        assert "venue.geojson" in names
        assert "building.geojson" in names
        assert "footprint.geojson" in names
        assert "level.geojson" in names
        assert "unit.geojson" in names

        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        assert manifest["version"] == "1.0.0"
        assert manifest["language"] == "en-US"
        assert isinstance(manifest["created"], str)
        assert manifest["created"]
        assert manifest["generated_by"] == "shp2imdf-converter phase5"
        assert "extensions" in manifest

        units = json.loads(archive.read("unit.geojson").decode("utf-8"))
        assert units["type"] == "FeatureCollection"
        if units["features"]:
            properties = units["features"][0]["properties"]
            assert "status" not in properties
            assert "issues" not in properties
            assert "metadata" not in properties


@pytest.mark.phase4
def test_patch_single_feature_properties(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space")
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
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    unit = next(item for item in features if item["feature_type"] == "unit")

    patch_response = test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"properties": {"category": "office"}},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["properties"]["category"] == "office"


@pytest.mark.phase4
def test_bulk_patch_and_delete_features(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]
    assert test_client.patch(
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
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    unit_ids = [item["id"] for item in features if item["feature_type"] == "unit"][:2]
    assert len(unit_ids) == 2

    bulk_patch = test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={
            "feature_ids": unit_ids,
            "action": "patch",
            "properties": {"category": "retail"},
        },
    )
    assert bulk_patch.status_code == 200
    assert bulk_patch.json()["updated_count"] == 2

    bulk_delete = test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={
            "feature_ids": [unit_ids[0]],
            "action": "delete",
        },
    )
    assert bulk_delete.status_code == 200
    assert bulk_delete.json()["deleted_count"] == 1


@pytest.mark.phase5
def test_validate_endpoint_updates_feature_statuses(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]
    assert test_client.patch(
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
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200

    validate_response = test_client.post(f"/api/session/{session_id}/validate")
    assert validate_response.status_code == 200
    payload = validate_response.json()
    assert "summary" in payload
    assert "errors" in payload
    assert "warnings" in payload

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    statuses = {item["properties"].get("status") for item in features}
    assert statuses.intersection({"mapped", "warning", "error", "unspecified"})


@pytest.mark.phase5
def test_autofix_endpoint_returns_revalidation_payload(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]
    assert test_client.patch(
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
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    assert test_client.post(f"/api/session/{session_id}/validate").status_code == 200

    autofix_response = test_client.post(f"/api/session/{session_id}/autofix", json={"apply_prompted": False})
    assert autofix_response.status_code == 200
    payload = autofix_response.json()
    assert "fixes_applied" in payload
    assert "fixes_requiring_confirmation" in payload
    assert "revalidation" in payload
    assert "summary" in payload["revalidation"]


@pytest.mark.phase5
def test_export_blocked_when_validation_errors_exist(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]
    assert test_client.patch(
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
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    unit = next(item for item in features if item["feature_type"] == "unit")
    assert test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"properties": {"level_id": None}},
    ).status_code == 200

    export_response = test_client.get(f"/api/session/{session_id}/export")
    assert export_response.status_code == 400
    assert "Export blocked" in export_response.json()["detail"]
