"""QGIS project export tests (QGIS is mocked; never invoked)."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import tempfile
import zipfile

import pytest

from backend.src import qgis_export
from backend.src.qgis_export import QgisExportError, QgisUnavailableError
from backend.tests.test_api import _upload_all_shapefiles, _write_imdf_schema_shapefiles


def _import_imdf_session(test_client) -> str:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        _write_imdf_schema_shapefiles(root)
        response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))
    assert response.status_code == 201
    return response.json()["session_id"]


@pytest.mark.phase5
def test_qgis_export_bundles_qgz_with_shapefiles(test_client, monkeypatch) -> None:
    session_id = _import_imdf_session(test_client)

    def _fake_generate(folder: Path, output_qgz: Path, station: str) -> None:
        output_qgz = Path(output_qgz)
        with zipfile.ZipFile(output_qgz, mode="w") as project:
            project.writestr(f"{output_qgz.stem}.qgs", "<qgis version='3.40'></qgis>")

    monkeypatch.setattr("backend.src.qgis_export.generate_qgis_project_for_folder", _fake_generate)

    response = test_client.post(
        f"/api/session/{session_id}/export/qgis",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"

    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        names = archive.namelist()
        qgz_names = [name for name in names if name.endswith(".qgz")]
        assert qgz_names, f"expected a bundled .qgz in {names}"
        assert "Demo_Station_1_Space.shp" in names
        assert "Demo_Station_Building.shp" in names

        with zipfile.ZipFile(BytesIO(archive.read(qgz_names[0]))) as project:
            assert any(member.endswith(".qgs") for member in project.namelist())


@pytest.mark.phase5
def test_qgis_export_503_when_qgis_unavailable(test_client, monkeypatch) -> None:
    session_id = _import_imdf_session(test_client)

    def _raise_unavailable(folder: Path, output_qgz: Path, station: str) -> None:
        raise QgisUnavailableError("QGIS not installed")

    monkeypatch.setattr("backend.src.qgis_export.generate_qgis_project_for_folder", _raise_unavailable)

    response = test_client.post(
        f"/api/session/{session_id}/export/qgis",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert response.status_code == 503
    assert response.json()["code"] == "QGIS_UNAVAILABLE"


@pytest.mark.phase5
def test_qgis_export_500_when_generation_fails(test_client, monkeypatch) -> None:
    session_id = _import_imdf_session(test_client)

    def _raise_export_error(folder: Path, output_qgz: Path, station: str) -> None:
        raise QgisExportError("boom")

    monkeypatch.setattr("backend.src.qgis_export.generate_qgis_project_for_folder", _raise_export_error)

    response = test_client.post(
        f"/api/session/{session_id}/export/qgis",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert response.status_code == 500
    assert response.json()["code"] == "QGIS_EXPORT_FAILED"


@pytest.mark.phase5
def test_resolve_qgis_python_prefers_env(monkeypatch) -> None:
    monkeypatch.setenv("QGIS_PYTHON", r"C:\custom\python-qgis.bat")
    assert qgis_export._resolve_qgis_python() == r"C:\custom\python-qgis.bat"


@pytest.mark.phase5
def test_generate_raises_unavailable_when_no_qgis(monkeypatch) -> None:
    monkeypatch.setattr("backend.src.qgis_export._resolve_qgis_python", lambda: None)
    with tempfile.TemporaryDirectory() as tmpdir:
        folder = Path(tmpdir)
        with pytest.raises(QgisUnavailableError):
            qgis_export.generate_qgis_project_for_folder(folder, folder / "x.qgz", "Demo")
