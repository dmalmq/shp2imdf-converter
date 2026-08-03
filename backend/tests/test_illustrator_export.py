"""Preview construction and georeferenced export."""

from __future__ import annotations

import io
import math
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest

from backend.src.illustrator_export import (
    ExportFormats,
    build_georeferenced_bundle,
    build_preview,
)
from backend.src.illustrator_georeference import SimilarityTransform, project_point
from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import ConversionStore
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf

ANCHOR_LON = 139.700258
ANCHOR_LAT = 35.690921


@pytest.fixture()
def cached(tmp_path: Path):
    store = ConversionStore(root=tmp_path, ttl_seconds=3600, max_entries=5)
    return store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))


def _transform(cached) -> SimilarityTransform:
    bounds = build_preview(cached)["artwork_bounds"]
    return SimilarityTransform(
        artwork_anchor=((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2),
        map_anchor=(ANCHOR_LON, ANCHOR_LAT),
        rotation_deg=0.0,
        metres_per_point=0.176389,
        working_crs="EPSG:6677",
    )


def _iter_coords(geometry):
    def walk(node):
        if isinstance(node, (list, tuple)):
            if node and isinstance(node[0], (int, float)):
                yield float(node[0]), float(node[1])
            else:
                for child in node:
                    yield from walk(child)

    yield from walk(geometry["coordinates"])


def _extract(payload: bytes, suffix: str, destination: Path) -> Path:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        name = next(n for n in archive.namelist() if n.endswith(suffix))
        destination.write_bytes(archive.read(name))
    return destination


@pytest.mark.georef
def test_preview_reports_bounds_and_counts(cached) -> None:
    preview = build_preview(cached)
    minx, miny, maxx, maxy = preview["artwork_bounds"]
    assert maxx > minx and maxy > miny
    assert preview["total_features"] >= 1
    assert preview["preview_features"] <= preview["total_features"]
    assert preview["preview"]["type"] == "FeatureCollection"


@pytest.mark.georef
def test_preview_features_carry_layer_and_colour_properties(cached) -> None:
    feature = build_preview(cached)["preview"]["features"][0]
    assert set(feature["properties"]) >= {"ai_layer", "role", "fill_color", "stroke_color"}


@pytest.mark.georef
def test_preview_coordinates_stay_in_artwork_points(cached) -> None:
    preview = build_preview(cached)
    minx, miny, maxx, maxy = preview["artwork_bounds"]
    for feature in preview["preview"]["features"]:
        for x, y in _iter_coords(feature["geometry"]):
            assert minx - 1 <= x <= maxx + 1
            assert miny - 1 <= y <= maxy + 1


@pytest.mark.georef
def test_preview_layer_summaries_match_the_written_tables(cached) -> None:
    summaries = build_preview(cached)["layers"]
    assert {s["table"] for s in summaries} == {s["table"] for s in cached.written_layers}
    assert all(s["feature_count"] >= 0 for s in summaries)


@pytest.mark.georef
def test_export_places_the_anchor_at_the_requested_location(cached, tmp_path: Path) -> None:
    """The union bbox centre lands on the anchor (its own defining point)."""
    payload, filename = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:6677", ExportFormats()
    )
    assert filename.endswith(".zip")

    gpkg = _extract(payload, ".gpkg", tmp_path / "out.gpkg")
    bounds = None
    first_crs = None
    for spec in cached.written_layers:
        gdf = gpd.read_file(gpkg, layer=spec["table"])
        first_crs = first_crs or gdf.crs
        minx, miny, maxx, maxy = gdf.total_bounds
        bounds = (
            [minx, miny, maxx, maxy]
            if bounds is None
            else [
                min(bounds[0], minx),
                min(bounds[1], miny),
                max(bounds[2], maxx),
                max(bounds[3], maxy),
            ]
        )
    expected = project_point(ANCHOR_LON, ANCHOR_LAT, "EPSG:6677")
    assert math.dist(((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2), expected) < 1.0
    assert first_crs.to_epsg() == 6677


@pytest.mark.georef
def test_export_contains_every_requested_format(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:6677", ExportFormats()
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert any(n.endswith(".qgs") for n in names)
    for suffix in (".shp", ".prj", ".dbf", ".shx"):
        assert any(n.endswith(suffix) for n in names), suffix


@pytest.mark.georef
def test_export_honours_format_selection(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        _transform(cached),
        "EPSG:6677",
        ExportFormats(geopackage=True, shapefile=False, qgis=False),
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert not any(n.endswith(".shp") for n in names)
    assert not any(n.endswith(".qgs") for n in names)


@pytest.mark.georef
def test_prj_declares_the_output_crs(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:4326", ExportFormats()
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        prj = next(n for n in archive.namelist() if n.endswith(".prj"))
        text = archive.read(prj).decode("utf-8", "replace")
    assert "WGS" in text.upper() or "4326" in text


@pytest.mark.georef
def test_reprojection_to_4326_yields_plausible_lonlat(cached, tmp_path: Path) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _transform(cached), "EPSG:4326", ExportFormats(shapefile=False, qgis=False)
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "reproj.gpkg")
    gdf = gpd.read_file(gpkg, layer=cached.written_layers[0]["table"])
    minx, miny, maxx, maxy = gdf.total_bounds
    assert 139.6 < (minx + maxx) / 2 < 139.8
    assert 35.6 < (miny + maxy) / 2 < 35.8


@pytest.mark.georef
def test_rotation_changes_the_footprint_but_not_its_area(cached, tmp_path: Path) -> None:
    upright = _transform(cached)
    turned = _transform(cached)
    turned.rotation_deg = 45.0

    areas = []
    for index, transform in enumerate((upright, turned)):
        payload, _ = build_georeferenced_bundle(
            cached, transform, "EPSG:6677", ExportFormats(shapefile=False, qgis=False)
        )
        gpkg = _extract(payload, ".gpkg", tmp_path / f"rot{index}.gpkg")
        gdf = gpd.read_file(gpkg, layer=cached.written_layers[0]["table"])
        areas.append(float(gdf.geometry.area.sum()))
    assert areas[0] == pytest.approx(areas[1], rel=1e-9)


@pytest.mark.georef
def test_export_rejects_a_non_positive_scale(cached) -> None:
    transform = _transform(cached)
    transform.metres_per_point = 0.0
    with pytest.raises(ValueError):
        build_georeferenced_bundle(cached, transform, "EPSG:6677", ExportFormats())
