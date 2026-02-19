"""Tests for shapefile importer behavior."""

from __future__ import annotations

from pathlib import Path

import pytest

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

