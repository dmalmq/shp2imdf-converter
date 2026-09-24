"""Source data must survive import unchanged: text encodings and file identity."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import tempfile
import zipfile

import geopandas as gpd
import pytest
from shapely.geometry import Point

from backend.src.importer import import_file_blobs

KEYWORDS = "backend/config/filename_keywords.json"
LABELS = ["改札口", "トイレ"]


def _write_cp932_shapefile_without_cpg(root: Path, stem: str) -> dict[str, bytes]:
    gdf = gpd.GeoDataFrame(
        {"name": LABELS},
        geometry=[Point(139.767, 35.681), Point(139.768, 35.682)],
        crs="EPSG:4326",
    )
    gdf.to_file(root / f"{stem}.shp", driver="ESRI Shapefile", encoding="cp932", index=False)
    (root / f"{stem}.cpg").unlink()
    components = {path.suffix: path.read_bytes() for path in root.glob(f"{stem}.*")}
    assert components[".dbf"][29] == 0
    assert "改札口".encode("cp932") in components[".dbf"]
    return components


@pytest.mark.phase1
def test_cp932_dbf_without_cpg_is_decoded_as_cp932() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        components = _write_cp932_shapefile_without_cpg(Path(tmpdir), "gates")

    artifacts = import_file_blobs(
        [(f"gates{suffix}", content) for suffix, content in components.items()],
        filename_keywords_path=KEYWORDS,
    )

    names = [feature["properties"]["metadata"]["name"] for feature in artifacts.source_feature_collection["features"]]
    assert names == LABELS
    assert any("gates.dbf" in warning and "cp932" in warning for warning in artifacts.warnings)


@pytest.mark.phase1
def test_utf8_dbf_without_cpg_imports_without_encoding_warning() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        gdf = gpd.GeoDataFrame({"name": LABELS}, geometry=[Point(0, 0), Point(1, 1)], crs="EPSG:4326")
        gdf.to_file(root / "gates.shp", driver="ESRI Shapefile", encoding="utf-8", index=False)
        (root / "gates.cpg").unlink()
        blobs = [(path.name, path.read_bytes()) for path in root.glob("gates.*")]

    artifacts = import_file_blobs(blobs, filename_keywords_path=KEYWORDS)

    names = [feature["properties"]["metadata"]["name"] for feature in artifacts.source_feature_collection["features"]]
    assert names == LABELS
    assert not any("cp932" in warning for warning in artifacts.warnings)


@pytest.mark.phase1
def test_shapefile_export_rereads_cp932_source_without_cpg(test_client) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        components = _write_cp932_shapefile_without_cpg(Path(tmpdir), "gates")

    upload = [
        ("files", (f"gates{suffix}", content, "application/octet-stream"))
        for suffix, content in components.items()
    ]
    session_id = test_client.post("/api/import", files=upload).json()["session_id"]

    response = test_client.post(f"/api/session/{session_id}/export/shapefiles", json={"encoding": "utf-8"})
    assert response.status_code == 200
    with tempfile.TemporaryDirectory() as tmpdir:
        with zipfile.ZipFile(BytesIO(response.content)) as archive:
            archive.extractall(tmpdir)
        exported = gpd.read_file(Path(tmpdir) / "gates.shp", encoding="utf-8")
    assert exported["name"].tolist() == LABELS


class _Cp932ZipInfo(zipfile.ZipInfo):
    """What Windows Explorer and most Japanese archivers write: cp932 names, no UTF-8 flag."""

    def _encodeFilenameFlags(self):  # noqa: N802
        return self.filename.encode("cp932"), self.flag_bits


def _cp932_named_zip(members: dict[str, bytes]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(_Cp932ZipInfo(name), content)
    return buffer.getvalue()


@pytest.mark.phase1
def test_zip_member_names_without_utf8_flag_are_decoded_as_cp932(test_client) -> None:
    stem = "新宿_1F_改札"
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        gdf = gpd.GeoDataFrame({"name": LABELS}, geometry=[Point(0, 0), Point(1, 1)], crs="EPSG:4326")
        gdf.to_file(root / "src.shp", driver="ESRI Shapefile", encoding="utf-8", index=False)
        members = {f"{stem}{path.suffix}": path.read_bytes() for path in root.glob("src.*")}
    payload = _cp932_named_zip(members)
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        assert all(not info.flag_bits & 0x800 for info in archive.infolist())
        assert f"{stem}.shp" not in archive.namelist()

    artifacts = import_file_blobs([("upload.zip", payload)], filename_keywords_path=KEYWORDS)
    assert [item.stem for item in artifacts.files] == [stem]

    response = test_client.post("/api/import", files=[("files", ("upload.zip", payload, "application/zip"))])
    assert response.status_code == 201
    assert [item["stem"] for item in response.json()["files"]] == [stem]
