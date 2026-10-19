"""Files whose type is "unknown, decide later" are left out of everything delivered."""

from __future__ import annotations

import io
import json
from pathlib import Path
import zipfile

import geopandas as gpd
import pytest
from fastapi.testclient import TestClient
from shapely.geometry import box

pytestmark = pytest.mark.phase5

_ORIGIN = (-6000.0, -36000.0)


def _write(root: Path, stem: str, x: float) -> None:
    geometry = [box(_ORIGIN[0] + x, _ORIGIN[1], _ORIGIN[0] + x + 20, _ORIGIN[1] + 20)]
    gpd.GeoDataFrame({"name": [stem]}, geometry=geometry, crs="EPSG:6677").to_file(root / f"{stem}.shp")


def test_the_shapefile_export_leaves_out_unknown_files(test_client: TestClient, tmp_path: Path) -> None:
    root = tmp_path / "upload"
    root.mkdir()
    _write(root, "Site_1F_Space", 0)
    _write(root, "新宿周辺_道路", 100)
    upload = [("files", (path.name, path.read_bytes(), "application/octet-stream")) for path in root.iterdir()]
    session_id = test_client.post("/api/import", files=upload).json()["session_id"]
    files = {item["stem"]: item["detected_type"] for item in test_client.get(f"/api/session/{session_id}/files").json()["files"]}
    assert files["新宿周辺_道路"] == "unknown"

    response = test_client.post(f"/api/session/{session_id}/export/shapefiles", json={})

    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert not [name for name in names if "周辺" in name]
        assert any(name.endswith(".shp") for name in names)
        report = json.loads(next(archive.read(name) for name in names if name.endswith(".json")))
    assert report["stems_left_out"] == ["新宿周辺_道路"]


_PROJECT = {
    "project_name": "Site",
    "venue_name": "Site",
    "venue_category": "shoppingcenter",
    "language": "en",
    "address": {"address": "1-1", "locality": "Chuo-ku", "country": "JP"},
}


def _generated_project(client: TestClient, tmp_path: Path) -> str:
    root = tmp_path / "generated"
    root.mkdir()
    _write(root, "Site_1F_Space", 0)
    _write(root, "Site_1F_Opening_Space", 40)
    upload = [("files", (path.name, path.read_bytes(), "application/octet-stream")) for path in root.iterdir()]
    session_id = client.post("/api/import", files=upload).json()["session_id"]
    assert client.patch(f"/api/session/{session_id}/wizard/project", json=_PROJECT).status_code == 200
    assert client.post(f"/api/session/{session_id}/generate").status_code == 200
    return session_id


def _from(client: TestClient, session_id: str, stem: str) -> list[dict]:
    features = client.get(f"/api/session/{session_id}/features").json()["features"]
    return [feature for feature in features if feature["properties"].get("source_file") == stem]


def test_leaving_out_a_file_after_generating_throws_the_draft_away(test_client: TestClient, tmp_path: Path) -> None:
    session_id = _generated_project(test_client, tmp_path)
    assert _from(test_client, session_id, "Site_1F_Opening_Space")
    rev = test_client.get(f"/api/session/{session_id}/features").json()["content_rev"]

    response = test_client.patch(f"/api/session/{session_id}/files/Site_1F_Opening_Space", json={"detected_type": "unknown"})

    assert response.status_code == 200
    wizard = test_client.get(f"/api/session/{session_id}/wizard").json()["wizard"]
    assert wizard["generation_status"] == "not_started"
    features = test_client.get(f"/api/session/{session_id}/features").json()
    assert "venue" not in {feature["feature_type"] for feature in features["features"]}
    assert features["content_rev"] == rev + 1
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    assert _from(test_client, session_id, "Site_1F_Opening_Space") == []
    assert _from(test_client, session_id, "Site_1F_Space")


def test_renaming_a_floor_keeps_the_draft(test_client: TestClient, tmp_path: Path) -> None:
    session_id = _generated_project(test_client, tmp_path)

    test_client.patch(f"/api/session/{session_id}/files/Site_1F_Space", json={"short_name": "GF"})

    assert test_client.get(f"/api/session/{session_id}/wizard").json()["wizard"]["generation_status"] == "generated"
