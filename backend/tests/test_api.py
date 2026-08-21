"""API tests for Phase 1 endpoints."""

from __future__ import annotations

from io import BytesIO
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import sqlite3
import shutil
import tempfile
from uuid import UUID, uuid4
import zipfile

import geopandas as gpd
import pytest
from shapely.geometry import GeometryCollection, LineString, Point, Polygon, shape
from shapely.ops import unary_union

from backend.src.geocoding import GeocodeAddressParts, GeocodeMatch, GeocodingError
from backend.src.schemas import CleanupSummary, ImportedFile
from backend.src.session import MemorySessionBackend, SessionManager


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sample_dir.glob(f"{stem}.*"):
        files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


def _upload_file(path: Path) -> list[tuple[str, tuple[str, bytes, str]]]:
    return [("files", (path.name, path.read_bytes(), "application/octet-stream"))]


def _write_geopackage(
    root: Path,
    stem: str,
    layers: list[tuple[str, gpd.GeoDataFrame]],
    add_non_spatial_layer: bool = False,
) -> Path:
    path = root / f"{stem}.gpkg"
    for layer_name, gdf in layers:
        gdf.to_file(path, layer=layer_name, driver="GPKG")
    if add_non_spatial_layer:
        connection = sqlite3.connect(path)
        try:
            connection.execute("CREATE TABLE plain_table (id INTEGER PRIMARY KEY, name TEXT)")
            connection.execute("INSERT INTO plain_table (name) VALUES ('plain')")
            connection.commit()
        finally:
            connection.close()
    return path


@pytest.mark.phase1
def test_import_endpoint_creates_session(test_client, sample_dir: Path) -> None:
    response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    assert response.status_code == 201
    payload = response.json()
    assert payload["session_id"]
    assert payload["files"]
    assert "cleanup_summary" in payload
    assert payload["files"][0]["source_format"] == "shapefile"
    assert payload["files"][0]["source_layer"] is None


@pytest.mark.phase1
def test_import_endpoint_accepts_geopackage(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "station",
            [
                (
                    "units",
                    gpd.GeoDataFrame(
                        [{"name": "Shop", "geometry": Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        response = test_client.post("/api/import", files=_upload_file(path))

    assert response.status_code == 201
    payload = response.json()
    assert payload["files"][0]["source_format"] == "gpkg"
    assert payload["files"][0]["source_layer"] == "units"
    assert payload["files"][0]["stem"] == "station__units"


@pytest.mark.phase1
def test_import_endpoint_accepts_mixed_shapefile_and_geopackage(test_client, sample_dir: Path) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "mixed_sources",
            [
                (
                    "openings",
                    gpd.GeoDataFrame(
                        [{"name": "Door", "geometry": LineString([(0, 0), (1, 0)])}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        response = test_client.post(
            "/api/import",
            files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_file(path),
        )

    assert response.status_code == 201
    payload = response.json()
    assert {item["source_format"] for item in payload["files"]} == {"shapefile", "gpkg"}


@pytest.mark.phase1
def test_import_persists_uploaded_artifacts_and_prune_removes_them(test_client, sample_dir: Path) -> None:
    previous_upload_dir = test_client.app.state.session_uploads_dir
    with tempfile.TemporaryDirectory() as temp_dir:
        test_client.app.state.session_uploads_dir = Path(temp_dir)
        try:
            response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
            assert response.status_code == 201
            session_id = response.json()["session_id"]

            manager = test_client.app.state.session_manager
            session = manager.get_session(session_id, touch=False)
            assert session is not None
            assert session.upload_artifact_dir is not None

            artifact_dir = Path(session.upload_artifact_dir)
            assert artifact_dir.exists()
            assert any(artifact_dir.iterdir())

            session.last_accessed = datetime.now(UTC) - timedelta(hours=48)
            manager.backend.save(session)
            removed = manager.prune_expired()

            assert removed >= 1
            assert not artifact_dir.exists()
        finally:
            test_client.app.state.session_uploads_dir = previous_upload_dir


@pytest.mark.phase1
def test_import_rejects_upload_over_configured_max_size(test_client) -> None:
    previous_limit = test_client.app.state.max_upload_bytes
    test_client.app.state.max_upload_bytes = 16
    try:
        response = test_client.post(
            "/api/import",
            files=[("files", ("oversized.shp", b"x" * 20, "application/octet-stream"))],
        )
    finally:
        test_client.app.state.max_upload_bytes = previous_limit

    assert response.status_code == 400
    payload = response.json()
    assert payload["code"] == "BAD_REQUEST"
    assert "configured limit" in payload["detail"]


@pytest.mark.phase1
def test_shapefile_export_rejects_geopackage_sessions(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "station",
            [
                (
                    "units",
                    gpd.GeoDataFrame(
                        [{"name": "Shop", "geometry": Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        import_response = test_client.post("/api/import", files=_upload_file(path))

    session_id = import_response.json()["session_id"]
    export_response = test_client.post(f"/api/session/{session_id}/export/shapefiles", json={})
    assert export_response.status_code == 400
    assert "GeoPackage sources" in export_response.json()["detail"]


@pytest.mark.phase1
def test_shapefile_export_rejects_mixed_source_sessions(test_client, sample_dir: Path) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "mixed_sources",
            [
                (
                    "units",
                    gpd.GeoDataFrame(
                        [{"name": "Shop", "geometry": Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        import_response = test_client.post(
            "/api/import",
            files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_file(path),
        )

    session_id = import_response.json()["session_id"]
    export_response = test_client.post(f"/api/session/{session_id}/export/shapefiles", json={})
    assert export_response.status_code == 400
    assert "GeoPackage sources" in export_response.json()["detail"]


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
def test_patch_file_rebuilds_mixed_geopackage_layer_into_polygons(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "station",
            [
                (
                    "source",
                    gpd.GeoDataFrame(
                        [
                            {"name": "Shop A", "geometry": Polygon([(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)])},
                            {"name": "Centerline", "geometry": LineString([(0, 0), (2, 2)])},
                            {
                                "name": "Shop B",
                                "geometry": GeometryCollection(
                                    [
                                        Polygon([(3, 0), (5, 0), (5, 2), (3, 2), (3, 0)]),
                                        LineString([(3, 0), (5, 2)]),
                                    ]
                                ),
                            },
                        ],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        import_response = test_client.post("/api/import", files=_upload_file(path))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    imported_file = import_response.json()["files"][0]
    assert imported_file["stem"] == "station__source"
    assert imported_file["geometry_type"] == "Mixed"
    assert imported_file["feature_count"] == 4

    response = test_client.patch(
        f"/api/session/{session_id}/files/station__source",
        json={"detected_type": "unit"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["file"]["detected_type"] == "unit"
    assert payload["file"]["geometry_type"] == "Polygon"
    assert payload["file"]["feature_count"] == 2
    assert any("GeoPackage normalization:" in warning for warning in payload["file"]["warnings"])

    features_response = test_client.get(f"/api/session/{session_id}/features")
    assert features_response.status_code == 200
    features_payload = features_response.json()
    assert len(features_payload["features"]) == 2
    assert all(item["geometry"]["type"] == "Polygon" for item in features_payload["features"])

    session = test_client.app.state.session_manager.get_session(session_id, touch=False)
    assert session is not None
    assert session.source_feature_collection is not None
    assert len(session.source_feature_collection["features"]) == 4
    assert len(session.feature_collection["features"]) == 2


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
def test_wizard_buildings_rejects_duplicate_file_stem_assignments(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

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
                    "category": "unspecified",
                    "restriction": None,
                    "file_stems": ["JRTokyoSta_B1_Space", "JRTokyoSta_GF_Space"],
                    "address_mode": "same_as_venue",
                    "address": None,
                },
            ]
        },
    )
    assert response.status_code == 400
    payload = response.json()
    assert payload["code"] == "BAD_REQUEST"
    assert "only be assigned to one building" in payload["detail"]


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
def test_iso_subdivisions_endpoint_returns_japan_prefectures(test_client) -> None:
    response = test_client.get("/api/reference/iso-subdivisions", params={"country": "jp"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["country"] == "JP"
    codes = {item["code"] for item in payload["subdivisions"]}
    assert "JP-13" in codes
    tokyo = next(item for item in payload["subdivisions"] if item["code"] == "JP-13")
    assert tokyo["name"] == "Tokyo"


@pytest.mark.phase3
def test_iso_subdivisions_endpoint_unknown_country_is_empty(test_client) -> None:
    response = test_client.get("/api/reference/iso-subdivisions", params={"country": "ZZ"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["country"] == "ZZ"
    assert payload["subdivisions"] == []


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
def test_wizard_address_autofill_prefers_representative_point_inside_geometry(test_client) -> None:
    polygon_geometry = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [0, 2], [0.8, 2], [0.8, 0.8], [2, 0.8], [2, 0], [0, 0]]],
    }
    polygon = shape(polygon_geometry)
    manager = test_client.app.state.session_manager
    session = manager.create_session(
        files=[
            ImportedFile(
                stem="L_SHAPE",
                geometry_type="Polygon",
                feature_count=1,
                attribute_columns=[],
                detected_type="unit",
                detected_level=0,
                confidence="green",
            )
        ],
        cleanup_summary=CleanupSummary(),
        feature_collection={
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "feature-1",
                    "feature_type": "source",
                    "geometry": polygon_geometry,
                    "properties": {
                        "source_file": "L_SHAPE",
                        "status": "mapped",
                        "issues": [],
                        "metadata": {},
                    },
                }
            ],
        },
    )

    class FakeGeocoder:
        def __init__(self) -> None:
            self.called_with: tuple[float, float] | None = None

        def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
            return []

        def reverse(self, latitude: float, longitude: float, language: str) -> GeocodeMatch | None:
            self.called_with = (longitude, latitude)
            return None

    fake_geocoder = FakeGeocoder()
    test_client.app.state.geocoder = fake_geocoder
    response = test_client.post(f"/api/session/{session.session_id}/wizard/address/autofill", params={"language": "en"})
    assert response.status_code == 200
    assert fake_geocoder.called_with is not None
    longitude, latitude = fake_geocoder.called_with
    point = Point(longitude, latitude)
    assert point.within(polygon) or point.touches(polygon)
    assert [longitude, latitude] != [1.0, 1.0]


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


@pytest.mark.phase5
def test_export_as_zip_returns_same_archive_with_zip_extension(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200

    imdf_response = test_client.get(f"/api/session/{session_id}/export")
    zip_response = test_client.get(f"/api/session/{session_id}/export", params={"ext": "zip"})

    assert zip_response.status_code == 200
    assert zip_response.headers["content-type"] == "application/zip"
    assert zip_response.headers["content-disposition"].endswith('.zip"')
    assert imdf_response.headers["content-disposition"].endswith('.imdf"')

    # Same files inside, just a different download extension.
    with zipfile.ZipFile(BytesIO(zip_response.content)) as zip_archive:
        zip_names = set(zip_archive.namelist())
    with zipfile.ZipFile(BytesIO(imdf_response.content)) as imdf_archive:
        imdf_names = set(imdf_archive.namelist())
    assert zip_names == imdf_names
    assert "manifest.json" in zip_names


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
def test_resolve_unit_overlap_pair_clips_or_deletes_loser(test_client, sample_dir: Path) -> None:
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
    units = [item for item in features if item["feature_type"] == "unit"]
    assert len(units) >= 2
    keep = units[0]
    clip = units[1]

    assert test_client.patch(
        f"/api/session/{session_id}/features/{clip['id']}",
        json={"geometry": keep["geometry"]},
    ).status_code == 200

    before_validation = test_client.post(f"/api/session/{session_id}/validate").json()
    before_overlap_count = before_validation["summary"]["overlap_count"]
    assert before_overlap_count > 0

    resolve_response = test_client.post(
        f"/api/session/{session_id}/overlaps/resolve",
        json={"keep_feature_id": keep["id"], "clip_feature_id": clip["id"]},
    )
    assert resolve_response.status_code == 200
    payload = resolve_response.json()
    assert payload["resolved_pairs"] == 1
    assert payload["deleted_count"] == 1
    assert payload["validation"]["summary"]["overlap_count"] < before_overlap_count

    after_features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    assert all(item["id"] != clip["id"] for item in after_features)


@pytest.mark.phase5
def test_resolve_unit_overlaps_safe_fixes_detected_safe_pairs(test_client, sample_dir: Path) -> None:
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
    units = [item for item in features if item["feature_type"] == "unit"]
    assert len(units) >= 2
    keep = units[0]
    clip = units[1]

    assert test_client.patch(
        f"/api/session/{session_id}/features/{clip['id']}",
        json={"geometry": keep["geometry"]},
    ).status_code == 200

    before_validation = test_client.post(f"/api/session/{session_id}/validate").json()
    before_overlap_count = before_validation["summary"]["overlap_count"]
    assert before_overlap_count > 0

    safe_response = test_client.post(f"/api/session/{session_id}/overlaps/fix-safe")
    assert safe_response.status_code == 200
    payload = safe_response.json()
    assert payload["resolved_pairs"] >= 1
    assert payload["validation"]["summary"]["overlap_count"] < before_overlap_count


def _overlap_unit_feature(category: str, coordinates: list[list[list[float]]]) -> dict:
    return {
        "type": "Feature",
        "id": str(uuid4()),
        "feature_type": "unit",
        "geometry": {"type": "Polygon", "coordinates": coordinates},
        "properties": {"category": category, "level_id": "level-1", "name": None},
    }


@pytest.mark.phase5
def test_safe_overlap_resolution_keeps_column_and_clips_surrounding_unit() -> None:
    from backend.routers.features_router import _choose_safe_overlap_resolution

    # Column fully contained in a room: without the category rule the
    # containment heuristic would clip (delete) the column instead.
    room = _overlap_unit_feature(
        "room",
        [[[0.0, 0.0], [0.001, 0.0], [0.001, 0.001], [0.0, 0.001], [0.0, 0.0]]],
    )
    column = _overlap_unit_feature(
        "column",
        [[[0.0004, 0.0004], [0.0006, 0.0004], [0.0006, 0.0006], [0.0004, 0.0006], [0.0004, 0.0004]]],
    )

    assert _choose_safe_overlap_resolution(room, column) == (column["id"], room["id"])
    assert _choose_safe_overlap_resolution(column, room) == (column["id"], room["id"])


@pytest.mark.phase5
def test_safe_overlap_resolution_column_pair_falls_back_to_heuristics() -> None:
    from backend.routers.features_router import _choose_safe_overlap_resolution

    # Two columns barely touching: neither ratio matches a safe heuristic,
    # so the pair stays unresolved rather than one column winning by category.
    left = _overlap_unit_feature(
        "column",
        [[[0.0, 0.0], [0.0002, 0.0], [0.0002, 0.0002], [0.0, 0.0002], [0.0, 0.0]]],
    )
    right = _overlap_unit_feature(
        "column",
        [[[0.00015, 0.0], [0.00035, 0.0], [0.00035, 0.0002], [0.00015, 0.0002], [0.00015, 0.0]]],
    )

    assert _choose_safe_overlap_resolution(left, right) is None


@pytest.mark.phase5
def test_resolve_unit_overlaps_safe_removes_empty_geometry_units(test_client, sample_dir: Path) -> None:
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]
    assert test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {"address": "1-9-1 Marunouchi", "locality": "Chiyoda-ku", "country": "JP"},
        },
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200

    # Inject an empty-geometry unit directly into the session (clipping won't touch
    # it because empty geometry has no overlap), then run Fix Overlaps.
    manager = test_client.app.state.session_manager
    session = manager.get_session(session_id, touch=False)
    units = [item for item in session.feature_collection["features"] if item["feature_type"] == "unit"]
    assert units
    empty_unit_id = units[0]["id"]
    units[0]["geometry"] = {"type": "Polygon", "coordinates": []}
    manager.save_session(session)

    safe_response = test_client.post(f"/api/session/{session_id}/overlaps/fix-safe")
    assert safe_response.status_code == 200
    assert safe_response.json()["deleted_count"] >= 1

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    assert empty_unit_id not in {item["id"] for item in features}


@pytest.mark.phase5
def test_export_allowed_even_with_validation_errors(test_client, sample_dir: Path) -> None:
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

    # Export should succeed even with validation errors — users can fix issues
    # in Apple IMDF Sandbox.
    export_response = test_client.get(f"/api/session/{session_id}/export")
    assert export_response.status_code == 200
    assert export_response.headers["content-type"] == "application/zip"


@pytest.mark.phase5
def test_shapefile_export_writes_updated_unit_categories(test_client, sample_dir: Path) -> None:
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
    unit_ids = [item["id"] for item in features if item["feature_type"] == "unit"]
    assert unit_ids
    assert test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={
            "feature_ids": unit_ids,
            "action": "patch",
            "properties": {"category": "room"},
        },
    ).status_code == 200

    export_response = test_client.post(f"/api/session/{session_id}/export/shapefiles", json={})
    assert export_response.status_code == 200
    assert export_response.headers["content-type"] == "application/zip"

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "JRTokyoSta_B1_unit.shp" in names
        assert "JRTokyoSta_B1_unit.shx" in names
        assert "JRTokyoSta_B1_unit.dbf" in names
        assert "export_report.json" in names

        with tempfile.TemporaryDirectory() as tmpdir:
            archive.extractall(tmpdir)
            gdf = gpd.read_file(Path(tmpdir) / "JRTokyoSta_B1_unit.shp")
            assert "IMDF_CAT" in gdf.columns
            exported_categories = {str(value).lower() for value in gdf["IMDF_CAT"].dropna().tolist()}
            assert exported_categories == {"room"}


@pytest.mark.phase5
def test_shapefile_export_reports_unapplied_unit_with_missing_source_linkage(test_client, sample_dir: Path) -> None:
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
        json={"properties": {"source_row_index": None, "source_feature_ref": None}},
    ).status_code == 200

    export_response = test_client.post(f"/api/session/{session_id}/export/shapefiles", json={})
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        report = json.loads(archive.read("export_report.json").decode("utf-8"))
        matches = [item for item in report.get("unapplied_features", []) if item.get("feature_id") == unit["id"]]
        assert matches
        assert matches[0]["reason"] == "missing_source_linkage"


@pytest.mark.phase5
def test_shapefile_export_uses_wizard_company_mappings_for_legacy_codes(test_client, sample_dir: Path) -> None:
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

    assert test_client.patch(
        f"/api/session/{session_id}/wizard/mappings",
        json={"unit_category_overrides": {"B0001": "room"}},
    ).status_code == 200

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    unit_ids = [item["id"] for item in features if item["feature_type"] == "unit"]
    assert unit_ids
    assert test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={
            "feature_ids": unit_ids,
            "action": "patch",
            "properties": {"category": "room"},
        },
    ).status_code == 200

    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"unit": {"overwrite_legacy_code_field": "COMP_CODE"}},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        report = json.loads(archive.read("export_report.json").decode("utf-8"))
        assert report["legacy_code_map_source"] == "wizard_company_mappings"
        assert report["legacy_code_conflicts"] == []

        with tempfile.TemporaryDirectory() as tmpdir:
            archive.extractall(tmpdir)
            gdf = gpd.read_file(Path(tmpdir) / "JRTokyoSta_B1_unit.shp")
            assert "COMP_CODE" in gdf.columns
            exported_codes = {str(value) for value in gdf["COMP_CODE"].dropna().tolist()}
            assert exported_codes == {"B0001"}


@pytest.mark.phase5
def test_shapefile_export_prefers_explicit_legacy_map_over_wizard_defaults(test_client, sample_dir: Path) -> None:
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

    assert test_client.patch(
        f"/api/session/{session_id}/wizard/mappings",
        json={"unit_category_overrides": {"B0001": "room"}},
    ).status_code == 200

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    unit_ids = [item["id"] for item in features if item["feature_type"] == "unit"]
    assert unit_ids
    assert test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={
            "feature_ids": unit_ids,
            "action": "patch",
            "properties": {"category": "room"},
        },
    ).status_code == 200

    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={
            "unit": {
                "overwrite_legacy_code_field": "COMP_CODE",
                "legacy_code_map": {"room": "R1234"},
            }
        },
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        report = json.loads(archive.read("export_report.json").decode("utf-8"))
        assert report["legacy_code_map_source"] == "payload"
        assert report["legacy_code_conflicts"] == []

        with tempfile.TemporaryDirectory() as tmpdir:
            archive.extractall(tmpdir)
            gdf = gpd.read_file(Path(tmpdir) / "JRTokyoSta_B1_unit.shp")
            assert "COMP_CODE" in gdf.columns
            exported_codes = {str(value) for value in gdf["COMP_CODE"].dropna().tolist()}
            assert exported_codes == {"R1234"}


@pytest.mark.phase5
def test_shapefile_export_normalizes_unit_columns_and_renames_space_stem(test_client, sample_dir: Path) -> None:
    stem = "JRTokyoSta_B1_Space"
    with tempfile.TemporaryDirectory() as tmpdir:
        working_dir = Path(tmpdir)
        for extension in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
            source = sample_dir / f"{stem}{extension}"
            if source.exists():
                shutil.copy2(source, working_dir / source.name)

        gdf = gpd.read_file(working_dir / f"{stem}.shp")
        gdf["id"] = [f"legacy-{index}" for index in range(len(gdf))]
        gdf["category"] = gdf["COMPANY_CO"]
        gdf["floor_id"] = [f"floor-{index}" for index in range(len(gdf))]
        gdf["restricted"] = 2
        gdf["suite"] = "S1"
        gdf["nonpublic"] = 1
        gdf["toll"] = 2
        gdf["source"] = 1
        gdf["color"] = "blue"
        gdf.to_file(working_dir / f"{stem}.shp", driver="ESRI Shapefile", index=False)

        import_response = test_client.post("/api/import", files=_upload_payload(working_dir, stem))
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
    unit_ids = [item["id"] for item in features if item["feature_type"] == "unit"]
    assert unit_ids
    assert test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={
            "feature_ids": unit_ids,
            "action": "patch",
            "properties": {"category": "room"},
        },
    ).status_code == 200

    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"unit": {"imdf_category_field": "category"}},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "JRTokyoSta_B1_unit.shp" in names
        assert "JRTokyoSta_B1_unit.shx" in names
        assert "JRTokyoSta_B1_unit.dbf" in names

        report = json.loads(archive.read("export_report.json").decode("utf-8"))
        assert "JRTokyoSta_B1_Space" in report["unit_schema_normalized_stems"]
        assert {"from": "JRTokyoSta_B1_Space", "to": "JRTokyoSta_B1_unit"} in report["unit_stem_renames"]

        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            exported = gpd.read_file(Path(output_dir) / "JRTokyoSta_B1_unit.shp")
            expected = {"id", "category", "restrict", "name", "alt_name", "level_id", "source", "display_po", "geometry"}
            assert set(exported.columns) == expected
            assert "restricted" not in exported.columns
            assert "floor_id" not in exported.columns
            assert "suite" not in exported.columns
            assert "nonpublic" not in exported.columns
            assert "toll" not in exported.columns
            assert "color" not in exported.columns
            exported_categories = {str(value).lower() for value in exported["category"].dropna().tolist()}
            assert exported_categories == {"room"}


@pytest.mark.phase5
def test_shapefile_export_canonicalizes_compact_uuid_ids(test_client, sample_dir: Path) -> None:
    stem = "JRTokyoSta_B1_Space"
    with tempfile.TemporaryDirectory() as tmpdir:
        working_dir = Path(tmpdir)
        for extension in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
            source = sample_dir / f"{stem}{extension}"
            if source.exists():
                shutil.copy2(source, working_dir / source.name)

        gdf = gpd.read_file(working_dir / f"{stem}.shp")
        compact_ids = [f"{index + 1:032x}" for index in range(len(gdf))]
        compact_floor_ids = [f"{index + 101:032x}" for index in range(len(gdf))]
        gdf["id"] = compact_ids
        gdf["floor_id"] = compact_floor_ids
        gdf["category"] = gdf["COMPANY_CO"]
        gdf.to_file(working_dir / f"{stem}.shp", driver="ESRI Shapefile", index=False)

        import_response = test_client.post("/api/import", files=_upload_payload(working_dir, stem))
        assert import_response.status_code == 201
        session_id = import_response.json()["session_id"]

    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"unit": {"imdf_category_field": "category"}},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            exported = gpd.read_file(Path(output_dir) / "JRTokyoSta_B1_unit.shp")
            exported_ids = {str(value) for value in exported["id"].dropna().tolist()}
            exported_level_ids = {str(value) for value in exported["level_id"].dropna().tolist()}

    expected_ids = {str(UUID(value)) for value in compact_ids}
    expected_level_ids = {str(UUID(value)) for value in compact_floor_ids}
    assert exported_ids == expected_ids
    assert exported_level_ids == expected_level_ids


@pytest.mark.phase5
def test_shapefile_export_normalizes_other_feature_schemas_and_renames_suffixes(test_client) -> None:
    stems = {
        "unit": "DemoSta_2_Space",
        "opening": "DemoSta_2_Opening",
        "fixture": "DemoSta_2_Fixture",
        "detail": "DemoSta_2_Drawing",
        "level": "DemoSta_2_Floor",
    }

    with tempfile.TemporaryDirectory() as tmpdir:
        working_dir = Path(tmpdir)

        unit_gdf = gpd.GeoDataFrame(
            {
                "NAME": ["Unit A"],
                "COMPANY_CO": ["SHOP"],
            },
            geometry=[
                Polygon(
                    [
                        (139.7000, 35.6900),
                        (139.7001, 35.6900),
                        (139.7001, 35.6901),
                        (139.7000, 35.6901),
                        (139.7000, 35.6900),
                    ]
                )
            ],
            crs="EPSG:4326",
        )
        unit_gdf.to_file(working_dir / f"{stems['unit']}.shp", driver="ESRI Shapefile", index=False)

        opening_gdf = gpd.GeoDataFrame(
            {
                "id": ["opening-old-1"],
                "floor_id": ["legacy-floor-id"],
                "name": ["Gate A"],
                "source": [1],
            },
            geometry=[
                Polygon(
                    [
                        (139.7002, 35.6900),
                        (139.7003, 35.6900),
                        (139.7003, 35.6901),
                        (139.7002, 35.6901),
                        (139.7002, 35.6900),
                    ]
                )
            ],
            crs="EPSG:4326",
        )
        opening_gdf.to_file(working_dir / f"{stems['opening']}.shp", driver="ESRI Shapefile", index=False)

        fixture_gdf = gpd.GeoDataFrame(
            {
                "id": ["fixture-old-1"],
                "category": ["C104"],
                "floor_id": ["legacy-floor-id"],
                "source": [1],
            },
            geometry=[
                Polygon(
                    [
                        (139.7004, 35.6900),
                        (139.7005, 35.6900),
                        (139.7005, 35.6901),
                        (139.7004, 35.6901),
                        (139.7004, 35.6900),
                    ]
                )
            ],
            crs="EPSG:4326",
        )
        fixture_gdf.to_file(working_dir / f"{stems['fixture']}.shp", driver="ESRI Shapefile", index=False)

        detail_gdf = gpd.GeoDataFrame(
            {
                "id": ["detail-old-1"],
                "floor_id": ["legacy-floor-id"],
                "source": [1],
            },
            geometry=[
                Polygon(
                    [
                        (139.7006, 35.6900),
                        (139.7007, 35.6900),
                        (139.7007, 35.6901),
                        (139.7006, 35.6901),
                        (139.7006, 35.6900),
                    ]
                )
            ],
            crs="EPSG:4326",
        )
        detail_gdf.to_file(working_dir / f"{stems['detail']}.shp", driver="ESRI Shapefile", index=False)

        level_gdf = gpd.GeoDataFrame(
            {
                "id": ["level-old-1"],
                "category": [1],
                "name": ["2F"],
                "ordinal": [2.0],
                "short_name": ["2F"],
                "source": [1],
            },
            geometry=[
                Polygon(
                    [
                        (139.7008, 35.6900),
                        (139.7009, 35.6900),
                        (139.7009, 35.6901),
                        (139.7008, 35.6901),
                        (139.7008, 35.6900),
                    ]
                )
            ],
            crs="EPSG:4326",
        )
        level_gdf.to_file(working_dir / f"{stems['level']}.shp", driver="ESRI Shapefile", index=False)

        payload: list[tuple[str, tuple[str, bytes, str]]] = []
        for stem in stems.values():
            payload.extend(_upload_payload(working_dir, stem))

        import_response = test_client.post("/api/import", files=payload)
        assert import_response.status_code == 201
        session_id = import_response.json()["session_id"]

    assert test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Demo Station",
            "venue_name": "Demo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "1-1 Demo",
                "locality": "Shinjuku",
                "country": "JP",
            },
        },
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200

    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"unit": {"imdf_category_field": "category"}},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "DemoSta_2_unit.shp" in names
        assert "DemoSta_2_opening.shp" in names
        assert "DemoSta_2_fixture.shp" in names
        assert "DemoSta_2_detail.shp" in names
        assert "DemoSta_2_level.shp" in names

        report = json.loads(archive.read("export_report.json").decode("utf-8"))
        assert {"from": "DemoSta_2_Opening", "to": "DemoSta_2_opening", "feature_type": "opening"} in report["stem_renames"]
        assert {"from": "DemoSta_2_Fixture", "to": "DemoSta_2_fixture", "feature_type": "fixture"} in report["stem_renames"]
        assert {"from": "DemoSta_2_Drawing", "to": "DemoSta_2_detail", "feature_type": "detail"} in report["stem_renames"]
        assert {"from": "DemoSta_2_Floor", "to": "DemoSta_2_level", "feature_type": "level"} in report["stem_renames"]

        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)

            opening = gpd.read_file(Path(output_dir) / "DemoSta_2_opening.shp")
            assert set(opening.columns) == {
                "id",
                "name",
                "source",
                "category",
                "access_con",
                "door",
                "alt_name",
                "level_id",
                "display_po",
                "geometry",
            }
            assert "floor_id" not in opening.columns

            fixture = gpd.read_file(Path(output_dir) / "DemoSta_2_fixture.shp")
            assert set(fixture.columns) == {
                "id",
                "category",
                "source",
                "name",
                "alt_name",
                "level_id",
                "display_po",
                "geometry",
            }
            assert "floor_id" not in fixture.columns

            detail = gpd.read_file(Path(output_dir) / "DemoSta_2_detail.shp")
            assert set(detail.columns) == {
                "id",
                "level_id",
                "category",
                "source",
                "geometry",
            }
            assert "floor_id" not in detail.columns

            level = gpd.read_file(Path(output_dir) / "DemoSta_2_level.shp")
            assert set(level.columns) == {
                "id",
                "category",
                "name",
                "source",
                "restrict",
                "display_po",
                "short_name",
                "outdoor",
                "ordinal",
                "address_id",
                "geometry",
            }
            # category (ODC spec 8.1.3 屋内外区分) is preserved from the source floor.
            assert str(level.iloc[0]["category"]).strip() in {"1", "1.0"}


def _write_imdf_schema_shapefiles(root: Path, *, facility_category: str = "F001") -> dict[str, str]:
    site_id = "11111111-1111-4111-8111-111111111111"
    building_id = "22222222-2222-4222-8222-222222222222"
    level_id = "33333333-3333-4333-8333-333333333333"
    unit_id = "44444444-4444-4444-8444-444444444444"
    amenity_id = "77777777-7777-4777-8777-777777777777"
    occupant_id = "88888888-8888-4888-8888-888888888888"
    section_id = "99999999-9999-4999-8999-999999999999"
    floor_connect_id = "aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaa1"

    site_geom = Polygon([(139.7000, 35.6900), (139.7010, 35.6900), (139.7010, 35.6910), (139.7000, 35.6910), (139.7000, 35.6900)])
    floor_geom = Polygon([(139.7001, 35.6901), (139.7009, 35.6901), (139.7009, 35.6909), (139.7001, 35.6909), (139.7001, 35.6901)])
    unit_geom = Polygon([(139.7002, 35.6902), (139.7004, 35.6902), (139.7004, 35.6904), (139.7002, 35.6904), (139.7002, 35.6902)])

    gpd.GeoDataFrame(
        {
            "id": [site_id],
            "category": ["A001"],
            "name": ["Demo Station"],
            "country": ["JP"],
            "city": ["Tokyo"],
            "address1": ["1-1 Demo"],
            "postalcode": ["100-0001"],
            "source": ["1"],
        },
        geometry=[site_geom],
        crs="EPSG:4326",
    ).to_file(root / "Demo_Site.shp", driver="ESRI Shapefile", index=False)
    gpd.GeoDataFrame(
        {"id": [building_id], "name": ["Main"], "source": ["1"]},
        geometry=[site_geom],
        crs="EPSG:4326",
    ).to_file(root / "Demo_Building.shp", driver="ESRI Shapefile", index=False)
    gpd.GeoDataFrame(
        {
            "id": [level_id],
            "category": ["1"],
            "name": ["First Floor"],
            "ordinal": [0.0],
            "short_name": ["1F"],
            "source": ["1"],
        },
        geometry=[floor_geom],
        crs="EPSG:4326",
    ).to_file(root / "Demo_1F_Floor.shp", driver="ESRI Shapefile", index=False)
    gpd.GeoDataFrame(
        {
            "id": [unit_id],
            "category": ["B001"],
            "floor_id": [level_id],
            "name": ["Shop A"],
            "restricted": [None],
            "suite": ["S-1"],
            "nonpublic": [None],
            "toll": [None],
            "source": ["1"],
        },
        geometry=[unit_geom],
        crs="EPSG:4326",
    ).to_file(root / "Demo_1F_Space.shp", driver="ESRI Shapefile", index=False)
    gpd.GeoDataFrame(
        {
            "id": [amenity_id],
            "category": [facility_category],
            "floor_id": [level_id],
            "name": ["Info Desk"],
            "source": ["1"],
        },
        geometry=[Point(139.7003, 35.6903)],
        crs="EPSG:4326",
    ).to_file(root / "Demo_1F_Facility.shp", driver="ESRI Shapefile", index=False)
    gpd.GeoDataFrame(
        {
            "id": [occupant_id],
            "postalcode": ["100-0001"],
            "country": ["JP"],
            "province": ["JP-13"],
            "city": ["Tokyo"],
            "address1": ["1-1 Demo"],
            "address2": [None],
            "address3": [None],
            "category": ["shop"],
            "floor_id": [level_id],
            "link_id": [None],
            "hours1": ["Mo-Su 10:00-20:00"],
            "hours2": [None],
            "name": ["Shop A Tenant"],
            "phone": ["+81-3-0000-0000"],
            "suite": ["S-1"],
            "taxonomy": ["retail"],
            "website": ["https://example.com"],
            "source": ["1"],
        },
        geometry=[Point(139.7003, 35.69035)],
        crs="EPSG:4326",
    ).to_file(root / "Demo_1F_Occupant.shp", driver="ESRI Shapefile", index=False)
    gpd.GeoDataFrame(
        {"id": [section_id], "floor_id": [level_id], "name": ["Platform 1"], "source": ["1"]},
        geometry=[
            Polygon([(139.7005, 35.6905), (139.7006, 35.6905), (139.7006, 35.6906), (139.7005, 35.6906), (139.7005, 35.6905)])
        ],
        crs="EPSG:4326",
    ).to_file(root / "Demo_1F_Segment.shp", driver="ESRI Shapefile", index=False)
    gpd.GeoDataFrame(
        {
            "id": [floor_connect_id],
            "floor_id": [level_id],
            "node_id": [None],
            "anch_id_1": [None],
            "direction1": ["1"],
            "anch_id_2": [None],
            "direction2": [None],
        },
        geometry=[Point(139.7004, 35.6904)],
        crs="EPSG:4326",
    ).to_file(root / "Demo_1F_Floor_Connect.shp", driver="ESRI Shapefile", index=False)
    return {
        "site_id": site_id,
        "building_id": building_id,
        "level_id": level_id,
        "unit_id": unit_id,
        "amenity_id": amenity_id,
        "occupant_id": occupant_id,
        "section_id": section_id,
        "floor_connect_id": floor_connect_id,
    }


def _upload_all_shapefiles(root: Path) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sorted(root.glob("*")):
        if path.suffix.lower() in {".shp", ".shx", ".dbf", ".prj", ".cpg"}:
            files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


@pytest.mark.phase5
def test_imdf_schema_shapefile_import_creates_review_session(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert response.status_code == 201
    payload = response.json()
    assert payload["import_profile"] == "imdf_shapefile"
    session_id = payload["session_id"]

    session = test_client.app.state.session_manager.get_session(session_id, touch=False)
    assert session is not None
    assert session.import_profile == "imdf_shapefile"
    assert session.wizard.generation_status == "generated"

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    level = next(item for item in features if item["feature_type"] == "level")
    unit = next(item for item in features if item["feature_type"] == "unit")
    venue = next(item for item in features if item["feature_type"] == "venue")
    assert level["id"] == ids["level_id"]
    assert unit["id"] == ids["unit_id"]
    assert unit["properties"]["level_id"] == ids["level_id"]
    assert unit["properties"]["category"] == "B001"
    assert venue["properties"]["category"] == "A001"

    amenity = next(item for item in features if item["feature_type"] == "amenity")
    assert amenity["id"] == ids["amenity_id"]
    assert amenity["geometry"]["type"] == "Point"
    assert amenity["properties"]["category"] == "unspecified"
    assert amenity["properties"]["metadata"]["category"] == "F001"
    assert amenity["properties"]["metadata"]["__odc_level_id"] == ids["level_id"]

    occupant = next(item for item in features if item["feature_type"] == "occupant")
    assert occupant["id"] == ids["occupant_id"]
    assert occupant["geometry"] is None
    assert occupant["properties"]["metadata"]["__odc_geometry"]["type"] == "Point"
    assert occupant["properties"]["metadata"]["__odc_level_id"] == ids["level_id"]

    section = next(item for item in features if item["feature_type"] == "section")
    assert section["id"] == ids["section_id"]

    footprint = next(item for item in features if item["feature_type"] == "footprint")
    assert footprint["properties"]["category"] == "ground"
    assert footprint["properties"]["building_ids"] == [ids["building_id"]]

    validation = test_client.post(f"/api/session/{session_id}/validate").json()
    error_checks = {issue["check"] for issue in validation["errors"]}
    assert "building_missing_footprint" not in error_checks
    assert "duplicate_uuids" not in error_checks

    files_response = test_client.get(f"/api/session/{session_id}/files")
    assert files_response.json()["import_profile"] == "imdf_shapefile"


@pytest.mark.phase5
def test_imdf_schema_shapefile_import_merges_levels_with_same_name(test_client) -> None:
    duplicate_level_id = "55555555-5555-4555-8555-555555555555"
    duplicate_unit_id = "66666666-6666-4666-8666-666666666666"

    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        duplicate_floor_geom = Polygon(
            [(139.7011, 35.6901), (139.7019, 35.6901), (139.7019, 35.6909), (139.7011, 35.6909), (139.7011, 35.6901)]
        )
        duplicate_unit_geom = Polygon(
            [(139.7012, 35.6902), (139.7014, 35.6902), (139.7014, 35.6904), (139.7012, 35.6904), (139.7012, 35.6902)]
        )
        gpd.GeoDataFrame(
            {
                "id": [duplicate_level_id],
                "category": ["1"],
                "name": ["First Floor"],
                "ordinal": [0.0],
                "short_name": ["1F East"],
                "source": ["1"],
            },
            geometry=[duplicate_floor_geom],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_Z_Floor.shp", driver="ESRI Shapefile", index=False)
        gpd.GeoDataFrame(
            {
                "id": [duplicate_unit_id],
                "category": ["retail"],
                "floor_id": [duplicate_level_id],
                "name": ["Shop B"],
                "restricted": [None],
                "suite": ["S-2"],
                "nonpublic": [None],
                "toll": [None],
                "source": ["1"],
            },
            geometry=[duplicate_unit_geom],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_Z_Space.shp", driver="ESRI Shapefile", index=False)
        response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert response.status_code == 201
    session_id = response.json()["session_id"]
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    levels = [item for item in features if item["feature_type"] == "level"]
    units = {item["id"]: item for item in features if item["feature_type"] == "unit"}

    assert len(levels) == 1
    assert levels[0]["id"] == ids["level_id"]
    assert units[ids["unit_id"]]["properties"]["level_id"] == ids["level_id"]
    assert units[duplicate_unit_id]["properties"]["level_id"] == ids["level_id"]


@pytest.mark.phase5
def test_odc2026_shapefile_export_from_imdf_schema_import(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root, facility_category="F012a")
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "Demo_Station_Site.shp" in names
        assert "Demo_Station_Building.shp" in names
        assert "Demo_Station_1_Floor.shp" in names
        assert "Demo_Station_1_Space.shp" in names
        assert "Demo_Station_1_Facility.shp" in names
        assert "Demo_Station_1_Occupant.shp" not in names
        assert "Demo_Station_1_Segment.shp" not in names
        assert "Demo_Station_1_Floor_Connect.shp" not in names
        assert "export_report.json" in names

        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            space = gpd.read_file(Path(output_dir) / "Demo_Station_1_Space.shp")
            assert set(space.columns) == {
                "id",
                "category",
                "floor_id",
                "name",
                "restricted",
                "suite",
                "nonpublic",
                "toll",
                "source",
                "geometry",
            }
            assert space.iloc[0]["id"] == ids["unit_id"]
            assert space.iloc[0]["category"] == "B001"
            assert space.iloc[0]["floor_id"] == ids["level_id"]
            assert space.iloc[0]["suite"] == "S-1"

            floor = gpd.read_file(Path(output_dir) / "Demo_Station_1_Floor.shp")
            assert floor.iloc[0]["id"] == ids["level_id"]
            assert floor.iloc[0]["category"] == "1"
            assert float(floor.iloc[0]["ordinal"]) == 0.0
            assert floor.crs.to_epsg() == 6668

            facility = gpd.read_file(Path(output_dir) / "Demo_Station_1_Facility.shp")
            assert set(facility.columns) == {"id", "category", "floor_id", "name", "source", "geometry"}
            assert facility.iloc[0]["id"] == ids["amenity_id"]
            assert facility.iloc[0]["category"] == "F012a"
            assert facility.iloc[0]["floor_id"] == ids["level_id"]

            building = gpd.read_file(Path(output_dir) / "Demo_Station_Building.shp")
            assert len(building) == 1
            assert building.geometry.iloc[0].equals_exact(floor.geometry.iloc[0], tolerance=1e-12)
            assert space.crs.to_epsg() == 6668
            assert facility.crs.to_epsg() == 6668


@pytest.mark.phase5
def test_odc2026_export_keeps_every_level_of_one_floor(test_client) -> None:
    # 新宿 1F is ten Level features (eight platforms, 1F and 1F屋外) that all share
    # the "1" floor token, and ODC names files by floor. Writing a file per level
    # made the floor's last level clobber every other level's rows.
    west_level_id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2"
    west_unit_id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        gpd.GeoDataFrame(
            {
                "id": [west_level_id],
                "category": ["1"],
                "name": ["First Floor West"],
                "ordinal": [0.0],
                "short_name": ["1F"],
                "source": ["1"],
            },
            geometry=[
                Polygon(
                    [
                        (139.7011, 35.6901),
                        (139.7019, 35.6901),
                        (139.7019, 35.6909),
                        (139.7011, 35.6909),
                        (139.7011, 35.6901),
                    ]
                )
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_West_Floor.shp", driver="ESRI Shapefile", index=False)
        gpd.GeoDataFrame(
            {
                "id": [west_unit_id],
                "category": ["B002"],
                "floor_id": [west_level_id],
                "name": ["Shop B"],
                "restricted": [None],
                "suite": [None],
                "nonpublic": [None],
                "toll": [None],
                "source": ["1"],
            },
            geometry=[
                Polygon(
                    [
                        (139.7012, 35.6902),
                        (139.7014, 35.6902),
                        (139.7014, 35.6904),
                        (139.7012, 35.6904),
                        (139.7012, 35.6902),
                    ]
                )
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_West_Space.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        report = json.loads(archive.read("export_report.json"))
        # Each layer is written once, so no level can overwrite another's file.
        assert sorted(report["layers_written"]) == sorted(set(report["layers_written"]))
        assert report["rows_skipped"] == []
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            floor = gpd.read_file(Path(output_dir) / "Demo_Station_1_Floor.shp")
            space = gpd.read_file(Path(output_dir) / "Demo_Station_1_Space.shp")
            assert set(floor["id"]) == {ids["level_id"], west_level_id}
            assert dict(zip(space["id"], space["floor_id"])) == {
                ids["unit_id"]: ids["level_id"],
                west_unit_id: west_level_id,
            }
            # The Building polygon is the whole ground floor, not one level of it.
            building = gpd.read_file(Path(output_dir) / "Demo_Station_Building.shp")
            assert building.geometry.iloc[0].equals(unary_union(list(floor.geometry)))


@pytest.mark.phase5
def test_odc2026_export_binds_facility_merge_to_the_level_it_falls_in(test_client) -> None:
    # Facility_Merge is one station-wide point layer: a point belongs to whichever
    # level of its floor it falls in, and 新宿 labels basements "B1" with no
    # trailing F, which the floor token has to resolve from the file stem.
    west_level_id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4"
    basement_level_id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc5"
    west_point_id = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"
    basement_point_id = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        _write_imdf_schema_shapefiles(root)
        gpd.GeoDataFrame(
            {
                "id": [west_level_id],
                "category": ["1"],
                "name": ["First Floor West"],
                "ordinal": [0.0],
                "short_name": ["1F"],
                "source": ["1"],
            },
            geometry=[
                Polygon(
                    [
                        (139.7011, 35.6901),
                        (139.7019, 35.6901),
                        (139.7019, 35.6909),
                        (139.7011, 35.6909),
                        (139.7011, 35.6901),
                    ]
                )
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_West_Floor.shp", driver="ESRI Shapefile", index=False)
        gpd.GeoDataFrame(
            {
                "id": [basement_level_id],
                "category": ["1"],
                "name": ["B1ラチ内"],
                "ordinal": [-1.0],
                "short_name": ["B1"],
                "source": ["1"],
            },
            geometry=[
                Polygon(
                    [
                        (139.7001, 35.6921),
                        (139.7009, 35.6921),
                        (139.7009, 35.6929),
                        (139.7001, 35.6929),
                        (139.7001, 35.6921),
                    ]
                )
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_B1_Floor.shp", driver="ESRI Shapefile", index=False)
        gpd.GeoDataFrame(
            {
                "id": [west_point_id, basement_point_id],
                "category": ["toilet", "toilet"],
                "image": ["/marker/male.png", "/marker/female.png"],
                "floor": ["F1", "B1"],
                "name": ["West toilet", "Basement toilet"],
                "source": ["1", "1"],
            },
            geometry=[Point(139.7015, 35.6905), Point(139.7005, 35.6925)],
            crs="EPSG:4326",
        ).to_file(root / "Facility_Merge.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        report = json.loads(archive.read("export_report.json"))
        assert report["facility_merge_unmapped"] == []
        assert report["facility_merge_outside_building"] == []
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            ground = gpd.read_file(Path(output_dir) / "Demo_Station_1_Facility.shp")
            basement = gpd.read_file(Path(output_dir) / "Demo_Station_B1_Facility.shp")
            assert dict(zip(ground["id"], ground["floor_id"])) == {west_point_id: west_level_id}
            assert dict(zip(basement["id"], basement["floor_id"])) == {basement_point_id: basement_level_id}
            assert list(ground["category"]) == ["F001"]
            assert list(basement["category"]) == ["F002"]


@pytest.mark.phase5
def test_odc2026_export_maps_facility_merge_categories_to_f_codes(test_client) -> None:
    inside_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
    no_image_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"
    ticket_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6"
    platform_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7"
    baby_toilet_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    baby_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc"
    children_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd"
    escalator_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8"
    stairs_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9"
    elevator_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba"
    basement_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3"
    outside_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4"
    unmapped_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5"
    basement_level_id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        # A basement concourse that lies completely outside the 1F footprint,
        # mirroring the Keiyo line levels at Tokyo station.
        gpd.GeoDataFrame(
            {
                "id": [basement_level_id],
                "category": ["1"],
                "name": ["B3F"],
                "ordinal": [-3.0],
                "short_name": ["B3F"],
                "source": ["1"],
            },
            geometry=[
                Polygon(
                    [
                        (139.7020, 35.6920),
                        (139.7028, 35.6920),
                        (139.7028, 35.6928),
                        (139.7020, 35.6928),
                        (139.7020, 35.6920),
                    ]
                )
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_B3_Floor.shp", driver="ESRI Shapefile", index=False)
        gpd.GeoDataFrame(
            {
                "id": [
                    inside_id,
                    no_image_id,
                    ticket_id,
                    platform_id,
                    escalator_id,
                    stairs_id,
                    elevator_id,
                    baby_toilet_id,
                    baby_id,
                    children_id,
                    basement_id,
                    outside_id,
                    unmapped_id,
                ],
                "category": [
                    "toilet",
                    "movement",
                    "Fare adjustment",
                    "home",
                    "movement",
                    "movement",
                    "movement",
                    "toilet",
                    "area",
                    "toilet",
                    "toilet",
                    "toilet",
                    "toilet",
                ],
                "image": [
                    "/marker/male.png",
                    None,
                    "/marker/ticket.png",
                    # Platform logo: no F-code.
                    "/marker/T01_s.svg",
                    "/marker/escalator.png",
                    "/marker/stairs_up.png",
                    "/marker/elevator.png",
                    # baby.png under toilet → null.
                    "/marker/baby.png",
                    # baby.png without toilet → F021.
                    "/marker/baby.png",
                    # children.png → null.
                    "/marker/children.png",
                    "/marker/unisex.png",
                    "/marker/female.png",
                    "/marker/multipurpose.png",
                ],
                "floor": ["F1"] * 10 + ["KB3", "F1", "F7"],
                "name": [
                    "Toilet",
                    "Escalator",
                    "Fare adjustment",
                    "Platform 1",
                    "Escalator",
                    "Stairs",
                    "Elevator",
                    "Baby toilet",
                    "Nursing room",
                    "こどもトイレ",
                    "Keiyo toilet",
                    "Outside toilet",
                    "Tower toilet",
                ],
                "source": ["1"] * 13,
            },
            geometry=[
                Point(139.7003, 35.6903),
                Point(139.7004, 35.6904),
                Point(139.70055, 35.69055),
                Point(139.70065, 35.69065),
                Point(139.70025, 35.69025),
                Point(139.70035, 35.69035),
                Point(139.70045, 35.69045),
                Point(139.7005, 35.6902),
                Point(139.7006, 35.6903),
                Point(139.7007, 35.6904),
                # Inside the B3 concourse, far outside the 1F footprint.
                Point(139.7024, 35.6924),
                # Outside every level polygon.
                Point(139.7100, 35.7000),
                Point(139.7005, 35.6905),
            ],
            crs="EPSG:4326",
        ).to_file(root / "Facility_Merge.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert export_response.status_code == 200
    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        report = json.loads(archive.read("export_report.json"))
        assert report["facility_merge_unmapped"] == [{"feature_id": unmapped_id, "floor": "F7"}]
        assert report["facility_merge_outside_building"] == [{"feature_id": outside_id, "floor": "F1"}]
        assert "facility_merge_missing_image" not in report
        assert sorted(report["facility_merge_missing_category"], key=lambda item: item["feature_id"]) == sorted(
            [
                {"feature_id": no_image_id, "floor": "F1"},
                {"feature_id": platform_id, "floor": "F1"},
                {"feature_id": baby_toilet_id, "floor": "F1"},
                {"feature_id": children_id, "floor": "F1"},
            ],
            key=lambda item: item["feature_id"],
        )
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            facility = gpd.read_file(Path(output_dir) / "Demo_Station_1_Facility.shp")
            assert set(facility.columns) == {"id", "category", "floor_id", "name", "source", "geometry"}
            by_id = {
                row["id"]: row["category"]
                for _, row in facility.iterrows()
            }
            assert by_id == {
                inside_id: "F001",
                no_image_id: None,
                # ticket.png is always F101, including fare-adjustment rows.
                ticket_id: "F101",
                # Platform logos and unlisted icons export as null.
                platform_id: None,
                escalator_id: "F013",
                stairs_id: "F011",
                elevator_id: "F012",
                baby_toilet_id: None,
                baby_id: "F021",
                children_id: None,
            }
            assert set(facility["floor_id"]) == {ids["level_id"]}
            assert ids["amenity_id"] not in set(facility["id"])

            # A facility inside its own basement level survives even though it
            # falls outside the 1F building outline.
            basement = gpd.read_file(Path(output_dir) / "Demo_Station_B3_Facility.shp")
            assert list(basement["id"]) == [basement_id]
            assert list(basement["category"]) == ["F003"]
            assert "image" not in basement.columns
            assert list(basement["floor_id"]) == [basement_level_id]


@pytest.mark.phase5
def test_odc2026_export_uses_facility_merge_when_present(test_client) -> None:
    merge_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root, facility_category="F012a")
        gpd.GeoDataFrame(
            {
                "id": [merge_id],
                "category": ["movement"],
                "image": ["/marker/escalator.png"],
                "floor": ["F1"],
                "name": ["Escalator"],
                "source": ["1"],
            },
            geometry=[Point(139.7003, 35.6903)],
            crs="EPSG:4326",
        ).to_file(root / "Facility_Merge.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )

    assert export_response.status_code == 200
    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            facility = gpd.read_file(Path(output_dir) / "Demo_Station_1_Facility.shp")
            assert list(facility["id"]) == [merge_id]
            assert list(facility["category"]) == ["F013"]
            assert "image" not in facility.columns


@pytest.mark.phase5
def test_odc2026_shapefile_export_requires_explicit_export_name(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        _write_imdf_schema_shapefiles(root)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "   "},
    )

    assert export_response.status_code == 400
    assert export_response.json()["detail"] == "Open data export requires a file name prefix."


@pytest.mark.phase5
def test_odc2026_shapefile_export_honors_custom_export_name(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        _write_imdf_schema_shapefiles(root)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "TokyoSta"},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "TokyoSta_Site.shp" in names
        assert "TokyoSta_Building.shp" in names
        assert "TokyoSta_1_Floor.shp" in names
        assert "TokyoSta_1_Space.shp" in names
        # The derived project name must no longer prefix any file.
        assert not any(name.startswith("Demo_Station") for name in names)


@pytest.mark.phase5
def test_odc2026_export_skips_mismatched_geometry_rows(test_client) -> None:
    bad_unit_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        gpd.GeoDataFrame(
            {
                "id": [bad_unit_id],
                "category": ["retail"],
                "floor_id": [ids["level_id"]],
                "name": ["Broken"],
                "restricted": [None],
                "suite": [None],
                "nonpublic": [None],
                "toll": [None],
                "source": ["1"],
            },
            geometry=[LineString([(139.7005, 35.6905), (139.7006, 35.6906)])],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_Y_Space.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert export_response.status_code == 200

    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        report = json.loads(archive.read("export_report.json"))
        skipped_ids = {item["feature_id"] for item in report["rows_skipped"]}
        assert bad_unit_id in skipped_ids
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            space = gpd.read_file(Path(output_dir) / "Demo_Station_1_Space.shp")
            assert bad_unit_id not in set(space["id"])
            assert ids["unit_id"] in set(space["id"])


@pytest.mark.phase5
def test_imdf_schema_shapefile_import_dedupes_duplicate_ids(test_client) -> None:
    duplicate_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        gpd.GeoDataFrame(
            {
                "id": [duplicate_id, duplicate_id],
                "floor_id": [ids["level_id"], ids["level_id"]],
                "source": ["1", "1"],
            },
            geometry=[
                LineString([(139.7002, 35.6905), (139.7003, 35.6905)]),
                LineString([(139.7002, 35.6906), (139.7003, 35.6906)]),
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_Drawing.shp", driver="ESRI Shapefile", index=False)
        response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert response.status_code == 201
    session_id = response.json()["session_id"]
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]

    details = [item for item in features if item["feature_type"] == "detail"]
    assert len(details) == 2
    detail_ids = [item["id"] for item in details]
    assert duplicate_id in detail_ids
    assert len(set(detail_ids)) == 2

    all_ids = [item["id"] for item in features]
    assert len(all_ids) == len(set(all_ids))


@pytest.mark.phase5
def test_imdf_schema_import_redirects_column_units_to_fixture(test_client) -> None:
    column_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        gpd.GeoDataFrame(
            {
                "id": [column_id],
                "category": ["column"],
                "floor_id": [ids["level_id"]],
                "name": [None],
                "restriction": [None],
                "source": ["1"],
            },
            geometry=[
                Polygon([(139.7005, 35.6905), (139.7006, 35.6905), (139.7006, 35.6906), (139.7005, 35.6906), (139.7005, 35.6905)])
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_floor_unit.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    # Columns should be imported as fixture, not unit (per ODC spec §8.1.5).
    fixtures = [item for item in features if item["feature_type"] == "fixture"]
    column_fixtures = [item for item in fixtures if item.get("id") == column_id]
    assert len(column_fixtures) == 1
    properties = column_fixtures[0].get("properties", {})
    assert properties.get("category", "").lower() == "column"
    assert properties.get("level_id") == ids["level_id"]

    # Export via ODC2026 and confirm the column appears in Fixture.shp with C001.
    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert export_response.status_code == 200
    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        names = set(archive.namelist())
        assert "Demo_Station_1_Fixture.shp" in names
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            fixture_shp = gpd.read_file(Path(output_dir) / "Demo_Station_1_Fixture.shp")
            assert column_id in set(fixture_shp["id"])
            assert "C001" in set(fixture_shp["category"])


@pytest.mark.phase5
def test_imdf_schema_import_redirects_vegetation_units_to_fixture(test_client) -> None:
    # 植栽・花壇 is a Fixture in the spec (別表8.5.1 C009) and has no Space code,
    # so a unit tagged "vegetation" belongs in Fixture rather than under Space
    # with the その他部屋 fallback.
    planting_id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc9"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        gpd.GeoDataFrame(
            {
                "id": [planting_id],
                "category": ["vegetation"],
                "floor_id": [ids["level_id"]],
                "name": [None],
                "source": ["1"],
            },
            geometry=[
                Polygon(
                    [
                        (139.7007, 35.6907),
                        (139.7008, 35.6907),
                        (139.7008, 35.6908),
                        (139.7007, 35.6908),
                        (139.7007, 35.6907),
                    ]
                )
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_Z_Space.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    assert planting_id in {item["id"] for item in features if item["feature_type"] == "fixture"}
    assert planting_id not in {item["id"] for item in features if item["feature_type"] == "unit"}

    export_response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert export_response.status_code == 200
    with zipfile.ZipFile(BytesIO(export_response.content)) as archive:
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            fixture = gpd.read_file(Path(output_dir) / "Demo_Station_1_Fixture.shp")
            assert dict(zip(fixture["id"], fixture["category"]))[planting_id] == "C009"
            space = gpd.read_file(Path(output_dir) / "Demo_Station_1_Space.shp")
            assert planting_id not in set(space["id"])


@pytest.mark.phase5
def test_imdf_schema_import_links_orphan_floor_uuid_column_by_filename_label(test_client) -> None:
    column_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    orphan_floor_id = "deadbeef-dead-4dea-8dea-deaddeaddead"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        ids = _write_imdf_schema_shapefiles(root)
        assert orphan_floor_id != ids["level_id"]
        # Filename floor label "1F" matches the built level's short_name, but the
        # source floor_id is a UUID absent from the dataset's levels. The importer
        # must fall back to the filename label to rescue the orphaned column.
        gpd.GeoDataFrame(
            {
                "id": [column_id],
                "category": ["column"],
                "floor_id": [orphan_floor_id],
                "name": [None],
                "restriction": [None],
                "source": ["1"],
            },
            geometry=[
                Polygon([(139.7005, 35.6905), (139.7006, 35.6905), (139.7006, 35.6906), (139.7005, 35.6906), (139.7005, 35.6905)])
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1F_floor_unit.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]

    # The column is redirected to a fixture (per ODC spec §8.1.5).
    column_fixtures = [f for f in features if f["feature_type"] == "fixture" and f.get("id") == column_id]
    assert len(column_fixtures) == 1
    props = column_fixtures[0]["properties"]
    assert props.get("category", "").lower() == "column"

    # The orphan floor_id must be rescued to the real level via the filename label,
    # never left pointing at the non-existent UUID.
    assert props.get("level_id") == ids["level_id"]
    assert props.get("level_id") != orphan_floor_id
    level_ids = {f["id"] for f in features if f["feature_type"] == "level"}
    assert props.get("level_id") in level_ids

    # The column must not also leak out as a unit.
    assert all(f.get("id") != column_id for f in features if f["feature_type"] == "unit")


@pytest.mark.phase5
def test_imdf_schema_import_column_only_synthesizes_levels_and_links_mezzanine(test_client) -> None:
    first_floor_column_id = "11111111-1111-4111-8111-111111111111"
    mezzanine_column_id = "22222222-2222-4222-8222-222222222222"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        # Only column ("壁あり" / floor_unit) shapefiles, with NO Floor file at all,
        # so the importer must reach _synthesize_levels. The floor_id UUIDs are
        # deliberately absent from the dataset's levels, and the two squares are
        # disjoint so their unions cannot side-location conflict for the wrong
        # reason -- the crash regression is about the synthesize union path itself.
        gpd.GeoDataFrame(
            {
                "id": [first_floor_column_id],
                "category": ["column"],
                "floor_id": ["deadbeef-dead-4dea-8dea-deaddead0001"],
                "name": [None],
                "restriction": [None],
                "source": ["1"],
            },
            geometry=[
                Polygon([(139.7005, 35.6905), (139.7006, 35.6905), (139.7006, 35.6906), (139.7005, 35.6906), (139.7005, 35.6905)])
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_1FL_floor_unit.shp", driver="ESRI Shapefile", index=False)
        # "M2FL" carries no numeric ordinal (detect_level_ordinal returns None), so
        # this exercises the mezzanine grouping-by-filename-label path.
        gpd.GeoDataFrame(
            {
                "id": [mezzanine_column_id],
                "category": ["column"],
                "floor_id": ["deadbeef-dead-4dea-8dea-deaddead0002"],
                "name": [None],
                "restriction": [None],
                "source": ["1"],
            },
            geometry=[
                Polygon([(139.7010, 35.6910), (139.7011, 35.6910), (139.7011, 35.6911), (139.7010, 35.6911), (139.7010, 35.6910)])
            ],
            crs="EPSG:4326",
        ).to_file(root / "Demo_M2FL_floor_unit.shp", driver="ESRI Shapefile", index=False)
        import_response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))

    # Crash regression: unioning near-coincident column polygons with NO Floor file
    # previously raised a GEOS TopologyException and returned HTTP 500.
    assert import_response.status_code == 201
    session_id = import_response.json()["session_id"]
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]

    level_ids = {f["id"] for f in features if f["feature_type"] == "level"}
    assert level_ids  # at least one level was synthesized despite no Floor file

    resolved: dict[str, str] = {}
    for column_id in (first_floor_column_id, mezzanine_column_id):
        # Each column is emitted as a fixture with category "column", never a unit.
        column_fixtures = [
            f for f in features if f["feature_type"] == "fixture" and f.get("id") == column_id
        ]
        assert len(column_fixtures) == 1
        props = column_fixtures[0]["properties"]
        assert props.get("category", "").lower() == "column"
        assert all(f.get("id") != column_id for f in features if f["feature_type"] == "unit")

        # Orphaning regression: the column links to a level that actually exists in
        # the returned collection (zero orphans), including the mezzanine floor.
        level_id = props.get("level_id")
        assert level_id is not None
        assert level_id in level_ids
        resolved[column_id] = level_id

    # 1FL and M2FL are distinct floors, so they must resolve to distinct levels.
    assert resolved[first_floor_column_id] != resolved[mezzanine_column_id]


@pytest.mark.phase5
def test_safe_union_tolerates_invalid_geometry() -> None:
    from backend.src.imdf_shapefile_importer import _safe_union

    bowtie = Polygon([(0, 0), (1, 1), (1, 0), (0, 1), (0, 0)])
    square = Polygon([(2, 0), (3, 0), (3, 1), (2, 1), (2, 0)])
    assert not bowtie.is_valid  # the input really is self-intersecting

    result = _safe_union([bowtie, square])
    assert result is not None
    assert result.is_valid
    assert not result.is_empty
    assert result.contains(square.representative_point()) or result.intersects(square)

    assert _safe_union([]) is None
