"""Tests for shapefile importer behavior."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
import zipfile

import geopandas as gpd
import pytest
from shapely.geometry import GeometryCollection, LineString, MultiLineString, Point, Polygon

from backend.src.importer import import_file_blobs, read_directory_as_blobs


def _collect_stem_blobs(directory: Path, stem: str) -> list[tuple[str, bytes]]:
    blobs: list[tuple[str, bytes]] = []
    for file in directory.glob(f"{stem}.*"):
        blobs.append((file.name, file.read_bytes()))
    return blobs


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
def test_importer_reads_geopackage_layers() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "demo_station",
            [
                (
                    "units",
                    gpd.GeoDataFrame(
                        [{"name": "Ticket Gate", "geometry": Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        artifacts = import_file_blobs([(path.name, path.read_bytes())], filename_keywords_path="backend/config/filename_keywords.json")

    assert len(artifacts.files) == 1
    imported = artifacts.files[0]
    assert imported.stem == "demo_station__units"
    assert imported.source_format == "gpkg"
    assert imported.source_layer == "units"
    assert imported.feature_count == 1
    assert len(artifacts.feature_collection["features"]) == 1


@pytest.mark.phase1
def test_importer_reads_geopackage_from_zip_archive() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "zip_station",
            [
                (
                    "levels",
                    gpd.GeoDataFrame(
                        [{"name": "Ground", "geometry": Point(139.7671, 35.6812)}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )
        archive_bytes = BytesIO()
        with zipfile.ZipFile(archive_bytes, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(path.name, path.read_bytes())

        artifacts = import_file_blobs(
            [("gpkg-upload.zip", archive_bytes.getvalue())],
            filename_keywords_path="backend/config/filename_keywords.json",
        )

    assert len(artifacts.files) == 1
    assert artifacts.files[0].source_format == "gpkg"
    assert artifacts.files[0].source_layer == "levels"


@pytest.mark.phase1
def test_importer_creates_one_dataset_per_geopackage_layer() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "multi_layer",
            [
                (
                    "units",
                    gpd.GeoDataFrame(
                        [{"name": "Shop", "geometry": Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                ),
                (
                    "openings",
                    gpd.GeoDataFrame(
                        [{"name": "Door", "geometry": LineString([(0, 0), (1, 0)])}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                ),
            ],
        )

        artifacts = import_file_blobs([(path.name, path.read_bytes())], filename_keywords_path="backend/config/filename_keywords.json")

    assert {item.source_layer for item in artifacts.files} == {"units", "openings"}
    assert {item.stem for item in artifacts.files} == {"multi_layer__units", "multi_layer__openings"}


@pytest.mark.phase1
def test_importer_skips_non_spatial_geopackage_layers_with_warning() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "with_plain_table",
            [
                (
                    "fixtures",
                    gpd.GeoDataFrame(
                        [{"name": "ATM", "geometry": Point(139.7671, 35.6812)}],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
            add_non_spatial_layer=True,
        )

        artifacts = import_file_blobs([(path.name, path.read_bytes())], filename_keywords_path="backend/config/filename_keywords.json")

    assert len(artifacts.files) == 1
    assert any("skipped non-spatial GeoPackage layer 'plain_table'" in warning for warning in artifacts.warnings)


@pytest.mark.phase1
def test_importer_reports_missing_crs_warning_for_geopackage_layer() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "no_crs",
            [
                (
                    "units",
                    gpd.GeoDataFrame(
                        [{"name": "Shop", "geometry": Point(139.7671, 35.6812)}],
                        geometry="geometry",
                    ),
                )
            ],
        )

        artifacts = import_file_blobs([(path.name, path.read_bytes())], filename_keywords_path="backend/config/filename_keywords.json")

    assert len(artifacts.files) == 1
    assert artifacts.files[0].crs_detected is None
    assert any("missing CRS metadata" in warning for warning in artifacts.warnings)


@pytest.mark.phase1
def test_importer_flattens_geopackage_geometrycollection_levels_to_polygons() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "station_1F",
            [
                (
                    "level",
                    gpd.GeoDataFrame(
                        [
                            {
                                "name": "Concourse",
                                "geometry": GeometryCollection(
                                    [
                                        Polygon([(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)]),
                                        Polygon([(5, 0), (7, 0), (7, 2), (5, 2), (5, 0)]),
                                    ]
                                ),
                            }
                        ],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        artifacts = import_file_blobs([(path.name, path.read_bytes())], filename_keywords_path="backend/config/filename_keywords.json")

    assert len(artifacts.files) == 1
    imported = artifacts.files[0]
    assert imported.detected_type == "level"
    assert imported.geometry_type == "Polygon"
    assert imported.feature_count == 2
    assert len(artifacts.source_feature_collection["features"]) == 2
    assert len(artifacts.feature_collection["features"]) == 2
    assert all(item["geometry"]["type"] == "Polygon" for item in artifacts.feature_collection["features"])


@pytest.mark.phase1
def test_importer_normalizes_geopackage_unit_layers_to_polygons() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "station_1F",
            [
                (
                    "unit",
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

        artifacts = import_file_blobs([(path.name, path.read_bytes())], filename_keywords_path="backend/config/filename_keywords.json")

    assert len(artifacts.files) == 1
    imported = artifacts.files[0]
    assert imported.detected_type == "unit"
    assert imported.geometry_type == "Polygon"
    assert imported.feature_count == 2
    assert len(artifacts.source_feature_collection["features"]) == 4
    assert len(artifacts.feature_collection["features"]) == 2
    assert all(item["geometry"]["type"] == "Polygon" for item in artifacts.feature_collection["features"])
    assert any("GeoPackage normalization:" in warning for warning in imported.warnings)
    assert any("GeoPackage normalization:" in warning for warning in artifacts.warnings)


@pytest.mark.phase1
def test_importer_normalizes_geopackage_detail_layers_to_linestrings() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        path = _write_geopackage(
            root,
            "station_1F",
            [
                (
                    "detail",
                    gpd.GeoDataFrame(
                        [
                            {
                                "name": "Guide",
                                "geometry": GeometryCollection(
                                    [
                                        LineString([(0, 0), (2, 0)]),
                                        Polygon([(3, 0), (4, 0), (4, 1), (3, 1), (3, 0)]),
                                    ]
                                ),
                            },
                            {"name": "Guide 2", "geometry": LineString([(0, 1), (2, 1)])},
                        ],
                        geometry="geometry",
                        crs="EPSG:4326",
                    ),
                )
            ],
        )

        artifacts = import_file_blobs([(path.name, path.read_bytes())], filename_keywords_path="backend/config/filename_keywords.json")

    assert len(artifacts.files) == 1
    imported = artifacts.files[0]
    assert imported.detected_type == "detail"
    assert imported.geometry_type == "LineString"
    assert imported.feature_count == 2
    assert len(artifacts.source_feature_collection["features"]) == 3
    assert len(artifacts.feature_collection["features"]) == 2
    assert all(item["geometry"]["type"] == "LineString" for item in artifacts.feature_collection["features"])
    assert any("GeoPackage normalization:" in warning for warning in imported.warnings)


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
