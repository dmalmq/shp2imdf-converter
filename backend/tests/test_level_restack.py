"""Changing a file's type re-stacks the floors when it adds or removes one."""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Point, box

pytestmark = pytest.mark.phase2


def _import(client: TestClient, root: Path, stems: list[str], points: tuple[str, ...] = ()) -> str:
    root.mkdir()
    for index, stem in enumerate(stems):
        x = -6000.0 + 40 * index
        geometry = [Point(x + 10, -35990.0) if stem in points else box(x, -36000.0, x + 20, -35980.0)]
        gpd.GeoDataFrame({"name": [stem]}, geometry=geometry, crs="EPSG:6677").to_file(root / f"{stem}.shp")
    upload = [("files", (path.name, path.read_bytes(), "application/octet-stream")) for path in root.iterdir()]
    return client.post("/api/import", files=upload).json()["session_id"]


def _levels(client: TestClient, session_id: str) -> dict[str, tuple[int | None, str | None, bool]]:
    files = client.get(f"/api/session/{session_id}/files").json()["files"]
    return {item["stem"]: (item["detected_level"], item["short_name"], item["outdoor"]) for item in files}


STEMS = ["Site_1F_Space", "Site_M2F_Space", "Site_2F_Space", "Site_RF_Space"]
STACKED = {
    "Site_1F_Space": (0, None, False),
    "Site_M2F_Space": (1, "M2F", False),
    "Site_2F_Space": (2, "2F", False),
    "Site_RF_Space": (3, "RF", True),
}


def test_a_mezzanine_leaving_the_floors_and_coming_back_restacks_them(test_client: TestClient, tmp_path: Path) -> None:
    session_id = _import(test_client, tmp_path / "upload", STEMS)
    assert _levels(test_client, session_id) == STACKED

    patched = test_client.patch(f"/api/session/{session_id}/files/Site_M2F_Space", json={"detected_type": "amenity"})
    assert patched.status_code == 200, patched.text
    assert _levels(test_client, session_id) == {
        "Site_1F_Space": (0, None, False),
        "Site_M2F_Space": (None, None, False),
        "Site_2F_Space": (1, None, False),
        "Site_RF_Space": (2, "RF", True),
    }

    test_client.patch(f"/api/session/{session_id}/files/Site_M2F_Space", json={"detected_type": "unit"})
    assert _levels(test_client, session_id) == STACKED


def test_a_level_set_by_hand_survives_a_restack(test_client: TestClient, tmp_path: Path) -> None:
    session_id = _import(test_client, tmp_path / "upload", STEMS)
    test_client.patch(f"/api/session/{session_id}/files/Site_2F_Space", json={"detected_level": 5, "short_name": "Upper"})

    test_client.patch(f"/api/session/{session_id}/files/Site_M2F_Space", json={"detected_type": "unknown"})

    levels = _levels(test_client, session_id)
    assert levels["Site_2F_Space"] == (5, "Upper", False)
    assert levels["Site_RF_Space"] == (2, "RF", True)


def test_a_type_change_within_the_floor_types_moves_nothing(test_client: TestClient, tmp_path: Path) -> None:
    session_id = _import(test_client, tmp_path / "upload", STEMS)

    test_client.patch(f"/api/session/{session_id}/files/Site_M2F_Space", json={"detected_type": "fixture"})

    assert _levels(test_client, session_id) == STACKED


def test_a_moved_floor_keeps_its_label_through_a_restack(test_client: TestClient, tmp_path: Path) -> None:
    session_id = _import(test_client, tmp_path / "upload", ["S_1F_Space", "S_M2F_Space", "S_2F_Space"])
    test_client.patch(f"/api/session/{session_id}/files/S_2F_Space", json={"detected_level": 5})

    test_client.patch(f"/api/session/{session_id}/files/S_M2F_Space", json={"detected_type": "amenity"})

    assert _levels(test_client, session_id)["S_2F_Space"] == (5, "2F", False)


def test_learning_a_type_that_adds_a_floor_restacks_them(test_client: TestClient, tmp_path: Path) -> None:
    stems = ["S_1F_Space", "S_M2F_Poi", "S_2F_Space", "S_RF_Space"]
    session_id = _import(test_client, tmp_path / "upload", stems, points=("S_M2F_Poi",))
    assert _levels(test_client, session_id) == {
        "S_1F_Space": (0, None, False),
        "S_M2F_Poi": (None, None, False),
        "S_2F_Space": (1, None, False),
        "S_RF_Space": (2, "RF", True),
    }

    learned = test_client.patch(
        f"/api/session/{session_id}/files/S_M2F_Poi",
        json={"detected_type": "unit", "apply_learning": True, "learning_keyword": "poi"},
    )

    assert learned.status_code == 200, learned.text
    assert _levels(test_client, session_id) == {
        "S_1F_Space": (0, None, False),
        "S_M2F_Poi": (1, "M2F", False),
        "S_2F_Space": (2, "2F", False),
        "S_RF_Space": (3, "RF", True),
    }


def test_guessing_the_types_again_restacks_the_floors(test_client: TestClient, tmp_path: Path) -> None:
    session_id = _import(test_client, tmp_path / "upload", STEMS)
    test_client.patch(f"/api/session/{session_id}/files/Site_M2F_Space", json={"detected_type": "amenity"})
    assert _levels(test_client, session_id)["Site_2F_Space"] == (1, None, False)

    guessed = test_client.post(f"/api/session/{session_id}/detect")

    assert guessed.status_code == 200, guessed.text
    assert _levels(test_client, session_id) == STACKED
