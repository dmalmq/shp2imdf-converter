"""Splitting one import into a project per building."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Any

import geopandas as gpd
import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Point, Polygon, box, mapping

from backend.src.session import SessionSummary

pytestmark = pytest.mark.phase1

# Two buildings about 450 m apart in Tokyo, in a projected CRS so the import reprojects.
_CRS = "EPSG:6677"
_WEST = (-6000.0, -36000.0)
_EAST = (-5550.0, -36000.0)


def _square(origin: tuple[float, float], dx: float, dy: float, size: float) -> Polygon:
    x, y = origin
    return box(x + dx, y + dy, x + dx + size, y + dy + size)


def _write(root: Path, stem: str, geometries: list[Any]) -> None:
    gpd.GeoDataFrame({"name": [f"{stem}-{i}" for i in range(len(geometries))]}, geometry=geometries, crs=_CRS).to_file(
        root / f"{stem}.shp"
    )


def _upload(root: Path) -> list[tuple[str, tuple[str, bytes, str]]]:
    return [("files", (path.name, path.read_bytes(), "application/octet-stream")) for path in sorted(root.iterdir())]


@pytest.fixture()
def two_buildings(tmp_path: Path) -> Path:
    root = tmp_path / "upload"
    root.mkdir()
    for floor in ("1F", "2F"):
        _write(root, f"Site_{floor}_Floor", [_square(_WEST, 0, 0, 100), _square(_EAST, 0, 0, 100)])
        # Three units in the west building, two in the east.
        _write(
            root,
            f"Site_{floor}_Space",
            [_square(_WEST, 10, 10, 20), _square(_WEST, 40, 10, 20), _square(_WEST, 10, 50, 20)]
            + [_square(_EAST, 10, 10, 20), _square(_EAST, 50, 50, 20)],
        )
    # A door in the field between them belongs to neither.
    _write(root, "Site_1F_Opening", [Point(_WEST[0] + 50, _WEST[1] + 0.5), Point(_WEST[0] + 270, _WEST[1] + 50)])
    return root


def _wgs84_box(origin: tuple[float, float], margin: float = 10) -> dict[str, Any]:
    x, y = origin
    area = gpd.GeoSeries([box(x - margin, y - margin, x + 100 + margin, y + 100 + margin)], crs=_CRS).to_crs(4326)
    return mapping(area.iloc[0])


def _shapes() -> list[dict[str, Any]]:
    return [{"name": "West", "polygon": _wgs84_box(_WEST)}, {"name": "East", "polygon": _wgs84_box(_EAST)}]


def _import(client: TestClient, root: Path) -> str:
    response = client.post("/api/import", files=_upload(root))
    assert response.status_code == 201, response.text
    return response.json()["session_id"]


def _features(client: TestClient, session_id: str) -> list[dict[str, Any]]:
    return client.get(f"/api/session/{session_id}/features").json()["features"]


def test_preview_counts_each_building_per_file_and_what_falls_outside(test_client: TestClient, two_buildings: Path) -> None:
    session_id = _import(test_client, two_buildings)

    response = test_client.post(f"/api/session/{session_id}/split/preview", json={"shapes": _shapes()})

    assert response.status_code == 200, response.text
    body = response.json()
    west, east = body["shapes"]
    assert west == {
        "name": "West",
        "total": 9,
        "files": {"Site_1F_Floor": 1, "Site_1F_Opening": 1, "Site_1F_Space": 3, "Site_2F_Floor": 1, "Site_2F_Space": 3},
    }
    assert east == {
        "name": "East",
        "total": 6,
        "files": {"Site_1F_Floor": 1, "Site_1F_Space": 2, "Site_2F_Floor": 1, "Site_2F_Space": 2},
    }
    assert body["unassigned_total"] == 1
    assert body["unassigned"] == {"Site_1F_Opening": 1}
    assert sorted(body["owners"].values()).count(0) == 9
    assert sorted(body["owners"].values()).count(1) == 6


def test_split_makes_a_project_per_building_and_leaves_the_import_alone(
    test_client: TestClient, two_buildings: Path
) -> None:
    session_id = _import(test_client, two_buildings)
    before_features = _features(test_client, session_id)
    before_files = test_client.get(f"/api/session/{session_id}/files").json()

    response = test_client.post(f"/api/session/{session_id}/split", json={"shapes": _shapes()})

    assert response.status_code == 201, response.text
    body = response.json()
    assert [(item["name"], item["feature_count"]) for item in body["projects"]] == [("West", 9), ("East", 6)]
    assert body["unassigned_total"] == 1

    west_id, east_id = (item["session_id"] for item in body["projects"])
    assert len({session_id, west_id, east_id}) == 3

    east_files = {item["stem"]: item for item in test_client.get(f"/api/session/{east_id}/files").json()["files"]}
    assert {stem: item["feature_count"] for stem, item in east_files.items()} == {
        "Site_1F_Floor": 1,
        "Site_1F_Space": 2,
        "Site_2F_Floor": 1,
        "Site_2F_Space": 2,
    }
    parent_files = {item["stem"]: item for item in before_files["files"]}
    for stem, item in east_files.items():
        assert item["detected_type"] == parent_files[stem]["detected_type"]
        assert item["detected_level"] == parent_files[stem]["detected_level"]

    east_features = _features(test_client, east_id)
    assert len(east_features) == 6
    east_refs = {feature["properties"]["source_feature_ref"] for feature in east_features}
    west_refs = {feature["properties"]["source_feature_ref"] for feature in _features(test_client, west_id)}
    assert not east_refs & west_refs

    assert _features(test_client, session_id) == before_features
    assert test_client.get(f"/api/session/{session_id}/files").json() == before_files

    for child_id, name in ((west_id, "West"), (east_id, "East")):
        summary = test_client.get(f"/api/projects/shapefiles/{child_id}")
        assert summary.status_code == 200
        assert summary.json()["name"] == name


@pytest.mark.parametrize(
    ("shapes", "message"),
    [
        ([], "at least one"),
        ([{"name": "West", "polygon": _wgs84_box(_WEST)}, {"name": "West", "polygon": _wgs84_box(_EAST)}], "different"),
        ([{"name": "A", "polygon": _wgs84_box(_WEST)}, {"name": "B", "polygon": _wgs84_box(_WEST, margin=20)}], "overlap"),
        ([{"name": " ", "polygon": _wgs84_box(_WEST)}], "name"),
    ],
)
def test_split_refuses_shapes_it_cannot_assign_by(
    test_client: TestClient, two_buildings: Path, shapes: list[dict[str, Any]], message: str
) -> None:
    session_id = _import(test_client, two_buildings)

    for path in ("split/preview", "split"):
        response = test_client.post(f"/api/session/{session_id}/{path}", json={"shapes": shapes})
        assert response.status_code == 400
        assert message in response.json()["detail"]
    assert len(test_client.get("/api/projects").json()["projects"]) == 1


def test_split_refuses_a_building_with_nothing_inside(test_client: TestClient, two_buildings: Path) -> None:
    session_id = _import(test_client, two_buildings)
    empty = {"name": "Field", "polygon": _wgs84_box((_WEST[0] + 200, _WEST[1] + 200), margin=-30)}

    response = test_client.post(f"/api/session/{session_id}/split", json={"shapes": [_shapes()[0], empty]})

    assert response.status_code == 400
    assert "Field" in response.json()["detail"]
    assert len(test_client.get("/api/projects").json()["projects"]) == 1


def _exported_names(content: bytes, root: Path) -> set[str]:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        archive.extractall(root)
    return {name for path in root.rglob("*.shp") for name in gpd.read_file(path)["name"]}


def test_a_split_project_exports_its_own_building_as_shapefiles(
    test_client: TestClient, two_buildings: Path, tmp_path: Path
) -> None:
    session_id = _import(test_client, two_buildings)
    projects = test_client.post(f"/api/session/{session_id}/split", json={"shapes": _shapes()}).json()["projects"]
    east_id = projects[1]["session_id"]

    response = test_client.post(f"/api/session/{east_id}/export/shapefiles", json={})

    assert response.status_code == 200, response.text
    assert _exported_names(response.content, tmp_path / "east") == {
        f"Site_{floor}_{kind}-{row}" for floor in ("1F", "2F") for kind, row in (("Floor", 1), ("Space", 3), ("Space", 4))
    }

    manager = test_client.app.state.session_manager
    parent = manager.get_session(session_id, touch=False)
    manager._delete_session_record(SessionSummary(parent.session_id, parent.last_accessed, parent.upload_artifact_dir))
    again = test_client.post(f"/api/session/{east_id}/export/shapefiles", json={})
    assert again.status_code == 200, again.text
