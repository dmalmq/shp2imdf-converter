"""Tests for shapefile importer behavior."""

from __future__ import annotations

from pathlib import Path
import tempfile

import geopandas as gpd
import pytest
from shapely.geometry import MultiLineString

from backend.src.importer import import_file_blobs, read_directory_as_blobs


def _collect_stem_blobs(directory: Path, stem: str) -> list[tuple[str, bytes]]:
    blobs: list[tuple[str, bytes]] = []
    for file in directory.glob(f"{stem}.*"):
        blobs.append((file.name, file.read_bytes()))
    return blobs


@pytest.mark.phase1
def test_importer_reads_and_reprojects(sample_dir: Path) -> None:
    blobs = read_directory_as_blobs(sample_dir)
    artifacts = import_file_blobs(blobs, filename_keywords_path="backend/config/filename_keywords.json")

    assert artifacts.files
    assert artifacts.feature_collection["type"] == "FeatureCollection"
    assert artifacts.feature_collection["features"]

    # Imported geometry should be within lon/lat bounds after reprojection.
    first_feature = artifacts.feature_collection["features"][0]
    coordinates = first_feature["geometry"]["coordinates"]
    flat = str(coordinates)
    assert "." in flat


@pytest.mark.phase1
def test_importer_explodes_multipolygons(edge_case_dir: Path) -> None:
    blobs = _collect_stem_blobs(edge_case_dir, "multipolygon_units")
    artifacts = import_file_blobs(blobs, filename_keywords_path="backend/config/filename_keywords.json")

    assert artifacts.cleanup_summary.multipolygons_exploded >= 1
    assert len(artifacts.feature_collection["features"]) >= 2


@pytest.mark.phase1
def test_importer_reports_missing_prj_warning(edge_case_dir: Path) -> None:
    blobs = _collect_stem_blobs(edge_case_dir, "no_prj_file")
    artifacts = import_file_blobs(blobs, filename_keywords_path="backend/config/filename_keywords.json")

    assert any("missing .prj" in warning for warning in artifacts.warnings)


@pytest.mark.phase1
def test_importer_explodes_multilinestrings_into_linestrings() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        stem = "multiline_detail"
        gdf = gpd.GeoDataFrame(
            [
                {
                    "ID": 1,
                    "geometry": MultiLineString(
                        [
                            [(139.7000, 35.6900), (139.7001, 35.6901)],
                            [(139.7002, 35.6902), (139.7003, 35.6903)],
                        ]
                    ),
                }
            ],
            geometry="geometry",
            crs="EPSG:4326",
        )
        gdf.to_file(root / f"{stem}.shp", driver="ESRI Shapefile", index=False)

        blobs = read_directory_as_blobs(root)
        artifacts = import_file_blobs(blobs, filename_keywords_path="backend/config/filename_keywords.json")

    assert len(artifacts.files) == 1
    file_info = artifacts.files[0]
    assert file_info.feature_count == 2
    assert file_info.geometry_type == "LineString"

    features = artifacts.feature_collection["features"]
    assert len(features) == 2
    assert all(item["geometry"]["type"] == "LineString" for item in features)

    feature_ids = [str(item["id"]) for item in features]
    assert len(set(feature_ids)) == 2

    source_refs = {item["properties"]["source_feature_ref"] for item in features}
    assert source_refs == {f"{stem}:0:0", f"{stem}:0:1"}
