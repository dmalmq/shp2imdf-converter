"""The export listing names exactly what each download holds, and records nothing."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import zipfile

import pytest

from backend.tests.test_api import _upload_file


def _tokyo_session(test_client, sample_dir: Path) -> str:
    files = [part for path in sorted(sample_dir.iterdir()) if path.is_file() for part in _upload_file(path)]
    session_id = test_client.post("/api/import", files=files).json()["session_id"]
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
    return session_id


def _fake_qgis(monkeypatch: pytest.MonkeyPatch) -> None:
    def generate(folder: Path, output_qgz: Path, station: str) -> None:
        with zipfile.ZipFile(output_qgz, mode="w") as project:
            project.writestr(f"{Path(output_qgz).stem}.qgs", "<qgis/>")

    monkeypatch.setattr("backend.src.qgis_export.generate_qgis_project_for_folder", generate)
    monkeypatch.setattr("backend.src.export_contents._resolve_qgis_python", lambda: "python-qgis.bat")


def _download(test_client, session_id: str, export_format: str) -> tuple[str, list[str]]:
    base = f"/api/session/{session_id}"
    odc = {"profile": "odc2026", "export_name": "JRTokyoSta"}
    response = {
        "imdf": lambda: test_client.get(f"{base}/export"),
        "imdf_zip": lambda: test_client.get(f"{base}/export?ext=zip"),
        "shapefiles": lambda: test_client.post(f"{base}/export/shapefiles", json={}),
        "odc2026_shapefiles": lambda: test_client.post(f"{base}/export/shapefiles", json=odc),
        "qgis_project": lambda: test_client.post(f"{base}/export/qgis", json=odc),
    }[export_format]()
    assert response.status_code == 200, response.text
    filename = response.headers["content-disposition"].split('filename="')[1].rstrip('"')
    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        return filename, sorted(archive.namelist())


@pytest.mark.phase5
def test_export_contents_match_every_download_and_record_nothing(test_client, sample_dir: Path, monkeypatch) -> None:
    _fake_qgis(monkeypatch)
    session_id = _tokyo_session(test_client, sample_dir)
    manager = test_client.app.state.session_manager
    before = manager.get_session(session_id, touch=False)
    revisions = (before.content_rev, before.validation_rev)

    response = test_client.get(f"/api/session/{session_id}/export/contents", params={"export_name": "JRTokyoSta"})
    assert response.status_code == 200
    outputs = {item["format"]: item for item in response.json()["outputs"]}

    after = manager.get_session(session_id, touch=False)
    assert after.delivered is None
    assert (after.content_rev, after.validation_rev) == revisions

    assert list(outputs) == ["imdf", "imdf_zip", "shapefiles", "odc2026_shapefiles", "qgis_project"]
    for export_format, listed in outputs.items():
        assert listed["unavailable"] is None
        assert (listed["filename"], sorted(listed["entries"])) == _download(test_client, session_id, export_format)
    assert any(name.startswith("JRTokyoSta_B1_") for name in outputs["odc2026_shapefiles"]["entries"])


@pytest.mark.phase5
def test_export_contents_say_why_a_format_is_unavailable(test_client, sample_dir: Path, monkeypatch) -> None:
    monkeypatch.setattr("backend.src.export_contents._resolve_qgis_python", lambda: None)
    session_id = _tokyo_session(test_client, sample_dir)

    outputs = {
        item["format"]: item
        for item in test_client.get(f"/api/session/{session_id}/export/contents").json()["outputs"]
    }

    assert outputs["imdf"]["filename"] == "Tokyo_Station.imdf"
    assert outputs["odc2026_shapefiles"]["filename"] is None
    assert outputs["odc2026_shapefiles"]["reason"] == "no_prefix"
    assert outputs["qgis_project"]["reason"] == "no_prefix"

    with_prefix = {
        item["format"]: item
        for item in test_client.get(
            f"/api/session/{session_id}/export/contents", params={"export_name": "JRTokyoSta"}
        ).json()["outputs"]
    }
    assert with_prefix["odc2026_shapefiles"]["filename"] == "JRTokyoSta_odc2026_shapefiles.zip"
    assert with_prefix["qgis_project"]["reason"] == "qgis_missing"


@pytest.mark.phase5
def test_a_format_that_fails_to_list_leaves_the_others_listed(test_client, sample_dir: Path, monkeypatch) -> None:
    _fake_qgis(monkeypatch)
    session_id = _tokyo_session(test_client, sample_dir)

    def broken(*_args, **_kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr("backend.src.export_contents.build_shapefile_export_archive", broken)
    response = test_client.get(f"/api/session/{session_id}/export/contents", params={"export_name": "JRTokyoSta"})

    assert response.status_code == 200
    outputs = {item["format"]: item for item in response.json()["outputs"]}
    assert outputs["shapefiles"]["reason"] == "failed"
    assert outputs["shapefiles"]["filename"] is None
    assert outputs["odc2026_shapefiles"]["filename"] == "JRTokyoSta_odc2026_shapefiles.zip"
    assert outputs["imdf"]["filename"] == "Tokyo_Station.imdf"


@pytest.mark.phase5
def test_listings_are_built_once_per_content_revision(test_client, sample_dir: Path, monkeypatch) -> None:
    _fake_qgis(monkeypatch)
    session_id = _tokyo_session(test_client, sample_dir)
    import backend.src.export_contents as contents

    calls: list[str] = []
    real = contents.build_export_archive
    monkeypatch.setattr(contents, "build_export_archive", lambda *a, **k: calls.append("imdf") or real(*a, **k))
    url = f"/api/session/{session_id}/export/contents"

    first = test_client.get(url, params={"export_name": "JRTokyoSta"}).json()
    assert test_client.get(url, params={"export_name": "JRTokyoSta"}).json() == first
    assert calls == ["imdf"]

    unit = next(item for item in test_client.get(f"/api/session/{session_id}/features").json()["features"] if item["feature_type"] == "unit")
    assert test_client.patch(f"/api/session/{session_id}/features/{unit['id']}", json={"properties": {**unit["properties"], "category": "room"}}).status_code == 200
    test_client.get(url, params={"export_name": "JRTokyoSta"})
    assert calls == ["imdf", "imdf"]
