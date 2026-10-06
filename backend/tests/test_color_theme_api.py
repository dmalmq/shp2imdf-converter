"""The colour tool over HTTP: the table before upload, inspect, download, and what is refused."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

import pytest

from backend.tests.color_theme_fixtures import (
    SPACE_FIELDS,
    make_dbf,
    make_zip,
    read_zip,
    space_row,
    station_members,
)

pytestmark = pytest.mark.colortheme

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"


def _folder(members) -> tuple[list, dict]:
    """A dropped folder as the page sends it: bare names in ``files``, relative paths in ``paths``."""
    files = [("files", (Path(name).name, data, "application/octet-stream")) for name, data in members if data is not None]
    paths = [name for name, data in members if data is not None]
    return files, {"paths": paths}


def test_the_table_is_served_before_any_upload(test_client) -> None:
    response = test_client.get("/api/color-theme")

    assert response.status_code == 200
    body = response.json()
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    assert [(rule["old"], rule["area"]) for rule in body["rules"]] == [(rule["old"], rule["area"]) for rule in config["rules"]]
    assert all(rule["rows"] == 0 for rule in body["rules"])
    toilets = next(rule for rule in body["rules"] if rule["categories"])
    assert toilets["categories"] == [f"B{n:03d}" for n in range(7, 15)]
    assert (toilets["value"], toilets["spec"], toilets["hex"]) == ("施設", "Turquoise 150", "#DDEBEC")
    assert toilets["scope"] == {"en": "Toilets coded 濃鼠", "ja": "トイレ（濃鼠）"}
    assert body["totals"]["rows"] == 0


def test_inspect_reports_each_rule_for_a_dropped_folder(test_client) -> None:
    members = [(f"/JRTokyoSta_6677.shp/{name.split('/', 1)[1]}", data) for name, data in station_members()]
    files, data = _folder(members)

    response = test_client.post("/api/color-theme/inspect", files=files, data=data)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dataset"] == {
        "name": "JRTokyoSta_6677",
        "download_name": "JRTokyoSta_6677_new-colors.zip",
        "files": len(files),
    }
    rows = {(rule["old"], tuple(rule["categories"] or ())): rule["rows"] for rule in body["theme"]["rules"]}
    assert rows[("濃鼠", ())] == 1
    assert rows[("濃鼠", tuple(f"B{n:03d}" for n in range(7, 15)))] == 1
    assert rows[("白", ())] == 1
    assert body["theme"]["totals"]["recolor"] == 9
    assert [layer["id"] for layer in body["theme"]["layers"]] == [
        "JRTokyoSta_6677.shp/0/Space.dbf",
        "JRTokyoSta_6677.shp/1/Space.dbf",
    ]
    assert body["theme"]["layers"][0]["encoding"] == {"codec": "utf-8", "source": "cpg"}


def test_convert_downloads_the_station_under_its_japanese_name(test_client) -> None:
    payload = make_zip(station_members(), cp932_names=True)

    response = test_client.post("/api/color-theme/convert", files=[("files", ("東京.zip", payload, "application/zip"))])

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert f"filename*=UTF-8''{quote('東京_new-colors.zip')}" in response.headers["content-disposition"]
    output = read_zip(response.content)
    assert list(output) == [name for name, _ in station_members()]


def test_a_station_of_more_than_a_thousand_files_is_accepted(test_client) -> None:
    space = make_dbf(SPACE_FIELDS, [space_row("白", "B021")])
    members = [("st/a_Space.dbf", space)] + [(f"st/f{index}.idx", b"x") for index in range(1100)]
    files, data = _folder(members)

    response = test_client.post("/api/color-theme/inspect", files=files, data=data)

    assert response.status_code == 200, response.text
    assert response.json()["dataset"]["files"] == 1101


def test_paths_must_pair_with_files(test_client) -> None:
    files, _ = _folder([("st/a.dbf", b"x"), ("st/b.dbf", b"y")])

    response = test_client.post("/api/color-theme/inspect", files=files, data={"paths": ["st/a.dbf"]})

    assert response.status_code == 400
    assert "2 files but 1 paths" in response.json()["detail"]


@pytest.mark.parametrize("bad", ["../x.dbf", "C:/x.dbf"])
def test_an_unsafe_path_is_refused(test_client, bad: str) -> None:
    files, _ = _folder([("x.dbf", b"x")])

    response = test_client.post("/api/color-theme/convert", files=files, data={"paths": [bad]})

    assert response.status_code == 400
    assert "Unsafe path" in response.json()["detail"]


def test_an_upload_over_the_limit_is_refused(test_client, monkeypatch) -> None:
    monkeypatch.setattr(test_client.app.state, "max_upload_bytes", 16)
    files, data = _folder([("st/a.dbf", b"x" * 32)])

    response = test_client.post("/api/color-theme/inspect", files=files, data=data)

    assert response.status_code == 400
    assert "MAX_UPLOAD_MB" in response.json()["detail"]


def test_a_broken_zip_is_refused(test_client) -> None:
    response = test_client.post("/api/color-theme/inspect", files=[("files", ("東京.zip", b"not a zip", "application/zip"))])

    assert response.status_code == 400
