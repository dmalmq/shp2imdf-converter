"""Importing a File Geodatabase, and splitting by picked layers and groups."""

from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
from typing import Any
import zipfile

import geopandas as gpd
import pyogrio
import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Point, box, mapping

from backend.src.importer import import_file_blobs

pytestmark = [
    pytest.mark.phase1,
    pytest.mark.skipif(
        "w" not in pyogrio.list_drivers().get("OpenFileGDB", ""), reason="GDAL cannot write a File Geodatabase"
    ),
]

_CRS = "EPSG:6677"
_WEST = (-6000.0, -36000.0)
_EAST = (-5550.0, -36000.0)
_KEYWORDS = "backend/config/filename_keywords.json"


def _squares(origin: tuple[float, float], count: int) -> list[Any]:
    x, y = origin
    return [box(x + 10 + 30 * i, y + 10, x + 30 + 30 * i, y + 30) for i in range(count)]


def _write(gdb: Path, layer: str, geometries: list[Any], dataset: str | None = None) -> None:
    frame = gpd.GeoDataFrame({"name": [f"{layer}-{i}" for i in range(len(geometries))]}, geometry=geometries, crs=_CRS)
    options = {"FEATURE_DATASET": dataset} if dataset else {}
    pyogrio.write_dataframe(frame, gdb, layer=layer, driver="OpenFileGDB", layer_options=options, append=gdb.exists())


@pytest.fixture()
def station_gdb(tmp_path: Path) -> Path:
    """Two buildings, each in its own feature dataset, and a door between them at the root."""
    gdb = tmp_path / "Station.gdb"
    _write(gdb, "West_1F_Space", _squares(_WEST, 3), "West")
    _write(gdb, "West_1F_Floor", [box(_WEST[0], _WEST[1], _WEST[0] + 100, _WEST[1] + 100)], "West")
    _write(gdb, "East_1F_Space", _squares(_EAST, 2), "East")
    # Drawn inside the west building's footprint, but it is the east building's door.
    _write(gdb, "East_1F_Opening", [Point(_WEST[0] + 50, _WEST[1] + 50)], "East")
    _write(gdb, "背景_1F_Space", [box(_WEST[0] + 270, _WEST[1], _WEST[0] + 280, _WEST[1] + 10)])
    pyogrio.write_dataframe(
        gpd.pd.DataFrame({"note": ["not spatial"]}), gdb, layer="Notes", driver="OpenFileGDB", append=True
    )
    (gdb / "a00000001.gdbtable.sr.lock").write_bytes(b"stale")
    return gdb


def _members(gdb: Path, prefix: str) -> list[tuple[str, bytes]]:
    return [(f"{prefix}{file.relative_to(gdb.parent).as_posix()}", file.read_bytes()) for file in sorted(gdb.rglob("*")) if file.is_file()]


def _zipped(members: list[tuple[str, bytes]]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in members:
            archive.writestr(name, data)
    return buffer.getvalue()


def test_each_feature_class_becomes_a_file_with_its_feature_dataset(station_gdb: Path) -> None:
    artifacts = import_file_blobs([("Station.zip", _zipped(_members(station_gdb, "")))], _KEYWORDS)

    files = {item.stem: item for item in artifacts.files}
    assert set(files) == {"West_1F_Space", "West_1F_Floor", "East_1F_Space", "East_1F_Opening", "背景_1F_Space"}
    space = files["West_1F_Space"]
    assert (space.source_format, space.source_layer, space.source_container, space.feature_dataset) == (
        "gdb",
        "West_1F_Space",
        "Station/Station.gdb",
        "West",
    )
    assert files["背景_1F_Space"].feature_dataset is None
    assert space.feature_count == 3
    assert (space.detected_type, space.detected_level) == ("unit", files["East_1F_Space"].detected_level)
    assert files["East_1F_Opening"].detected_type == "opening"
    assert any("1 table(s) without geometry" in warning for warning in artifacts.warnings)
    lon, lat = artifacts.source_feature_collection["features"][0]["geometry"]["coordinates"][0][0][:2]
    assert 139 < lon < 140 and 35 < lat < 36


def test_a_feature_class_named_like_a_shapefile_keeps_both(station_gdb: Path, tmp_path: Path) -> None:
    shapefile = tmp_path / "West_1F_Space.shp"
    gpd.GeoDataFrame({"name": ["x"]}, geometry=_squares(_WEST, 1), crs=_CRS).to_file(shapefile)
    loose = [(file.name, file.read_bytes()) for file in tmp_path.glob("West_1F_Space.*")]

    artifacts = import_file_blobs(loose + _members(station_gdb, "Upload/"), _KEYWORDS)

    stems = {item.stem: item.source_format for item in artifacts.files}
    assert stems["West_1F_Space"] == "shapefile"
    assert stems["Station__West_1F_Space"] == "gdb"


def _upload_folder(client: TestClient, members: list[tuple[str, bytes]]) -> str:
    response = client.post(
        "/api/import",
        files=[("files", (Path(path).name, data, "application/octet-stream")) for path, data in members],
        data={"paths": [path for path, _ in members]},
    )
    assert response.status_code == 201, response.text
    return response.json()["session_id"]


def _wgs84_box(origin: tuple[float, float], margin: float = 10) -> dict[str, Any]:
    x, y = origin
    area = gpd.GeoSeries([box(x - margin, y - margin, x + 100 + margin, y + 100 + margin)], crs=_CRS).to_crs(4326)
    return mapping(area.iloc[0])


def test_a_folder_upload_splits_by_feature_dataset_and_a_picked_file_beats_a_shape(
    test_client: TestClient, station_gdb: Path
) -> None:
    session_id = _upload_folder(test_client, _members(station_gdb, "Upload/"))

    groups = test_client.get(f"/api/session/{session_id}/split/groups").json()["groups"]
    assert [(group["name"], group["kind"], sorted(group["stems"])) for group in groups] == [
        ("East", "feature_dataset", ["East_1F_Opening", "East_1F_Space"]),
        ("West", "feature_dataset", ["West_1F_Floor", "West_1F_Space"]),
    ]
    east = next(group for group in groups if group["name"] == "East")
    shapes = [
        {"name": "West", "polygon": _wgs84_box(_WEST)},
        {"name": "East", "files": east["stems"]},
    ]

    preview = test_client.post(f"/api/session/{session_id}/split/preview", json={"shapes": shapes})

    assert preview.status_code == 200, preview.text
    west_counts, east_counts = preview.json()["shapes"]
    assert west_counts["files"] == {"West_1F_Floor": 1, "West_1F_Space": 3}
    assert east_counts["files"] == {"East_1F_Opening": 1, "East_1F_Space": 2}
    assert preview.json()["unassigned"] == {"背景_1F_Space": 1}

    split = test_client.post(f"/api/session/{session_id}/split", json={"shapes": shapes})
    assert split.status_code == 201, split.text
    east_id = split.json()["projects"][1]["session_id"]
    east_files = test_client.get(f"/api/session/{east_id}/files").json()["files"]
    assert {item["stem"]: item["source_format"] for item in east_files} == {"East_1F_Opening": "gdb", "East_1F_Space": "gdb"}


@pytest.mark.parametrize(
    ("shapes", "message"),
    [
        ([{"name": "A", "files": ["West_1F_Space"]}, {"name": "B", "files": ["West_1F_Space"]}], "picked by both"),
        ([{"name": "A", "files": ["Nowhere"]}], "not a file of this import"),
        ([{"name": "A"}], "neither a shape nor picked layers"),
    ],
)
def test_split_refuses_picks_it_cannot_honour(
    test_client: TestClient, station_gdb: Path, shapes: list[dict[str, Any]], message: str
) -> None:
    session_id = _upload_folder(test_client, _members(station_gdb, ""))

    for path in ("split/preview", "split"):
        response = test_client.post(f"/api/session/{session_id}/{path}", json={"shapes": shapes})
        assert response.status_code == 400
        assert message in response.json()["detail"]


def _layer(name: str, dataset: str, database: str = "Station.gdb", workspace: str | None = None) -> dict[str, Any]:
    """``workspace`` is the DATABASE path as Pro wrote it; left out, a sibling ``data`` folder's ``database``."""
    workspace = workspace or f"..\\..\\data\\{database}"
    return {
        "type": "CIMFeatureLayer",
        "name": name,
        "visibility": True,
        "featureTable": {
            "type": "CIMFeatureTable",
            "dataConnection": {
                "type": "CIMStandardDataConnection",
                "workspaceConnectionString": f"DATABASE={workspace}",
                "workspaceFactory": "FileGDB",
                "dataset": dataset,
                "datasetType": "esriDTFeatureClass",
            },
        },
    }


def _aprx(tree: list[tuple[str, Any]]) -> bytes:
    """A project with one map; ``tree`` is (name, layer document) for a layer and (name, [children]) for a group."""
    members: dict[str, dict[str, Any]] = {}
    numbers = iter(range(1000))

    def add(name: str, node: Any) -> str:
        uri = f"CIMPATH=map/{next(numbers)}.json"
        doc = {**node, "name": name} if isinstance(node, dict) else {
            "type": "CIMGroupLayer",
            "name": name,
            "layers": [add(*child) for child in node],
        }
        members[uri.removeprefix("CIMPATH=")] = {**doc, "uRI": uri}
        return uri

    members["map/map.json"] = {"type": "CIMMap", "name": "マップ レイヤー", "layers": [add(*node) for node in tree]}
    project = {"projectItems": [{"itemType": "Map", "name": "マップ レイヤー", "catalogPath": "CIMPATH=map/map.json"}]}
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("GISProject.json", json.dumps(project))
        for name, doc in members.items():
            archive.writestr(name, json.dumps(doc, ensure_ascii=False))
    return buffer.getvalue()


def test_the_projects_group_layers_become_groups_of_the_files_they_draw(test_client: TestClient, station_gdb: Path) -> None:
    project = _aprx(
        [
            (
                "1F",
                [
                    ("JRWest_1F", [("Space", _layer("Space", "WEST_1F_SPACE")), ("Floor", _layer("Floor", "West_1F_Floor"))]),
                    ("JREast_1F", [("Space", _layer("Space", "East_1F_Space"))]),
                    ("Elsewhere", [("Other", _layer("Other", "West_1F_Space", database="Other.gdb"))]),
                    ("Missing", [("Gone", _layer("Gone", "NotImported"))]),
                ],
            ),
        ]
    )
    session_id = _upload_folder(test_client, _members(station_gdb, "Shinjuku/") + [("Shinjuku/Station.aprx", project)])

    groups = test_client.get(f"/api/session/{session_id}/split/groups").json()["groups"]

    from_project = {group["name"]: group["stems"] for group in groups if group["kind"] == "project_group"}
    assert from_project == {
        "1F": ["West_1F_Space", "West_1F_Floor", "East_1F_Space"],
        "1F › JRWest_1F": ["West_1F_Space", "West_1F_Floor"],
        "1F › JREast_1F": ["East_1F_Space"],
        # Another geodatabase's layer of the same name is not this import's file.
    }


def test_two_projects_copied_from_one_template_keep_their_own_groups(test_client: TestClient, station_gdb: Path) -> None:
    # The builder numbers uRIs the same way every time, as two copies of one project would.
    west = _aprx([("1F", [("Building", [("Space", _layer("Space", "West_1F_Space"))])])])
    east = _aprx([("1F", [("Building", [("Space", _layer("Space", "East_1F_Space"))])])])
    session_id = _upload_folder(
        test_client,
        _members(station_gdb, "Shinjuku/") + [("Shinjuku/West.aprx", west), ("Shinjuku/East copy.aprx", east)],
    )

    groups = test_client.get(f"/api/session/{session_id}/split/groups").json()["groups"]

    from_project = [group for group in groups if group["kind"] == "project_group"]
    assert len({group["id"] for group in from_project}) == len(from_project) == 4
    assert {group["name"]: group["stems"] for group in from_project} == {
        "West › 1F": ["West_1F_Space"],
        "West › 1F › Building": ["West_1F_Space"],
        "East copy › 1F": ["East_1F_Space"],
        "East copy › 1F › Building": ["East_1F_Space"],
    }


def test_same_named_geodatabases_stay_apart_in_groups_and_layer_matching(test_client: TestClient, tmp_path: Path) -> None:
    for folder, count in (("A", 2), ("B", 3)):
        (tmp_path / folder).mkdir()
        _write(tmp_path / folder / "Station.gdb", "Space_1F", _squares(_WEST, count), "Building")
    project = _aprx(
        [
            ("Here", [("Space", _layer("Space", "Space_1F", workspace=".\\Station.gdb"))]),
            ("There", [("Space", _layer("Space", "Space_1F", workspace="..\\B\\Station.gdb"))]),
        ]
    )
    members = [
        (f"Upload/{folder}/{file.relative_to(tmp_path / folder).as_posix()}", file.read_bytes())
        for folder in ("A", "B")
        for file in sorted((tmp_path / folder).rglob("*"))
        if file.is_file()
    ]
    session_id = _upload_folder(test_client, members + [("Upload/A/Station.aprx", project)])

    files = test_client.get(f"/api/session/{session_id}/files").json()["files"]
    assert {item["stem"]: (item["source_container"], item["feature_count"]) for item in files} == {
        "Space_1F": ("Upload/A/Station.gdb", 2),
        "Station__Space_1F": ("Upload/B/Station.gdb", 3),
    }

    groups = test_client.get(f"/api/session/{session_id}/split/groups").json()["groups"]
    assert len({group["id"] for group in groups}) == len(groups)
    assert [(group["name"], group["stems"]) for group in groups if group["kind"] == "feature_dataset"] == [
        ("Upload/A/Station.gdb › Building", ["Space_1F"]),
        ("Upload/B/Station.gdb › Building", ["Station__Space_1F"]),
    ]
    from_project = {group["name"]: group["stems"] for group in groups if group["kind"] == "project_group"}
    assert from_project == {"Here": ["Space_1F"], "There": ["Station__Space_1F"]}
