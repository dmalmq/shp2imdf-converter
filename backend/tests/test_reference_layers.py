"""Reference overlay layers for the placement map."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import LineString, Polygon

from backend.src.importer import read_reference_layers

# JGD2011 / Japan Plane Rectangular CS IX, the zone Tokyo drawings use. A
# building-sized square near Tokyo Station, in metres.
TOKYO_CS9 = "EPSG:6677"
SQUARE = Polygon([(-7000, -35000), (-6960, -35000), (-6960, -34960), (-7000, -34960)])
LINE = LineString([(-7000, -35000), (-6900, -34900)])


def _shapefile_zip(tmp_path: Path, name: str = "platforms", crs: str | None = TOKYO_CS9) -> bytes:
    gdf = gpd.GeoDataFrame(
        {"NAME": ["A", "B"], "geometry": [SQUARE, LINE.buffer(1)]},
        geometry="geometry",
        crs=crs,
    )
    directory = tmp_path / name
    directory.mkdir(parents=True, exist_ok=True)
    gdf.to_file(directory / f"{name}.shp")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path in directory.iterdir():
            archive.writestr(path.name, path.read_bytes())
    return buffer.getvalue()


def test_a_zipped_shapefile_is_read_and_reprojected_to_wgs84(tmp_path: Path) -> None:
    layers = read_reference_layers([("platforms.zip", _shapefile_zip(tmp_path))])

    assert len(layers) == 1
    layer = layers[0]
    assert layer.name == "platforms"
    assert layer.feature_count == 2
    assert "6677" in (layer.crs or "")

    # Coordinates must come back as lon/lat near Tokyo, not projected metres.
    coords = layer.geojson["features"][0]["geometry"]["coordinates"][0][0]
    assert 139.0 < coords[0] < 141.0
    assert 35.0 < coords[1] < 36.0


def test_attributes_are_dropped_because_the_overlay_is_display_only(tmp_path: Path) -> None:
    layers = read_reference_layers([("platforms.zip", _shapefile_zip(tmp_path))])
    properties = layers[0].geojson["features"][0]["properties"]
    assert properties == {} or properties is None


def test_loose_shapefile_components_are_accepted(tmp_path: Path) -> None:
    """Users pick .shp/.shx/.dbf/.prj together as often as they zip them."""
    gdf = gpd.GeoDataFrame({"geometry": [SQUARE]}, geometry="geometry", crs=TOKYO_CS9)
    directory = tmp_path / "loose"
    directory.mkdir()
    gdf.to_file(directory / "tracks.shp")
    blobs = [(path.name, path.read_bytes()) for path in directory.iterdir()]

    layers = read_reference_layers(blobs)
    assert [layer.name for layer in layers] == ["tracks"]
    assert layers[0].feature_count == 1


def test_an_upload_without_geometry_is_rejected() -> None:
    with pytest.raises(ValueError):
        read_reference_layers([("notes.txt", b"not spatial data")])


def test_empty_upload_is_rejected() -> None:
    with pytest.raises(ValueError):
        read_reference_layers([])


def test_endpoint_returns_layers_for_a_zipped_shapefile(test_client, tmp_path: Path) -> None:
    response = test_client.post(
        "/api/reference-layers",
        files=[("files", ("platforms.zip", _shapefile_zip(tmp_path), "application/zip"))],
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["layers"]) == 1
    layer = payload["layers"][0]
    assert layer["name"] == "platforms"
    assert layer["feature_count"] == 2
    assert layer["truncated"] is False
    assert layer["geojson"]["type"] == "FeatureCollection"


def test_endpoint_rejects_a_non_spatial_upload(test_client) -> None:
    response = test_client.post(
        "/api/reference-layers",
        files=[("files", ("notes.txt", b"not spatial data", "text/plain"))],
    )
    assert response.status_code == 400
