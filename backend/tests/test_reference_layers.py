"""Reference overlay layers for the placement map."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import LineString, Point, Polygon, shape

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


def _footprints(count: int, spacing_m: float, *, rounded: bool = True) -> list[Polygon]:
    """``count`` building-sized outlines strung out over a wide area.

    ``rounded`` outlines are 20 m-radius rings of many short segments, which is
    what makes a collapse visible: a bare rectangle is already the simplest ring
    there is, so Douglas-Peucker leaves it alone however coarse the tolerance.
    Square outlines stand in for ordinary building footprints, which really are
    this plain - the 12k-polygon station extract behind this fix averages seven
    vertices a feature.
    """
    if rounded:
        return [Point(-7000 + i * spacing_m, -35000).buffer(20.0) for i in range(count)]
    return [
        Polygon(
            [
                (-7000 + i * spacing_m, -35000),
                (-6960 + i * spacing_m, -35000),
                (-6960 + i * spacing_m, -34960),
                (-7000 + i * spacing_m, -34960),
            ]
        )
        for i in range(count)
    ]


def _regional_shapefile(
    tmp_path: Path, count: int, spacing_m: float, name: str, *, rounded: bool = True
) -> list[tuple[str, bytes]]:
    """Loose shapefile components for ``count`` footprints spread over a region.

    Every other fixture here holds one building, so the dataset's extent and its
    feature size are the same number - the single case where scaling a tolerance
    to the extent happens to be harmless.
    """
    gdf = gpd.GeoDataFrame(
        {"geometry": _footprints(count, spacing_m, rounded=rounded)},
        geometry="geometry",
        crs=TOKYO_CS9,
    )
    directory = tmp_path / name
    directory.mkdir(parents=True, exist_ok=True)
    gdf.to_file(directory / f"{name}.shp")
    return [(path.name, path.read_bytes()) for path in directory.iterdir()]


def test_small_features_keep_their_shape_when_the_dataset_spans_a_region(tmp_path: Path) -> None:
    """A 40 m footprint must keep its area however far away the next one is.

    The tolerance used to be the dataset's diagonal / 2000, so features 100 km
    apart produced a 50 m tolerance - wider than the buildings themselves - and
    ``preserve_topology`` reduced each outline to the smallest ring it could
    legally keep. That is why a station extract covering a whole branch office
    arrived as a field of triangles.

    Area rather than vertex count is the assertion, because the honest tolerance
    is still allowed to drop vertices that sit within 5 cm of the line they are
    on; what it may not do is change the shape.
    """
    blobs = _regional_shapefile(tmp_path, count=2, spacing_m=100_000, name="regional")

    layers = read_reference_layers(blobs)

    features = layers[0].geojson["features"]
    assert len(features) == 2
    expected = sorted(gpd.GeoSeries(_footprints(2, 100_000), crs=TOKYO_CS9).to_crs(4326).area)
    actual = sorted(shape(feature["geometry"]).area for feature in features)
    for want, got in zip(expected, actual):
        assert got == pytest.approx(want, rel=0.01), "footprint area changed - the outline was deformed"


def test_a_file_of_small_footprints_arrives_complete(tmp_path: Path) -> None:
    """The cap counts vertices, so thousands of tiny buildings all fit.

    A flat 5000-feature limit silently dropped more than half of a 12k-polygon
    station extract, and file order decides which half.
    """
    blobs = _regional_shapefile(tmp_path, count=6000, spacing_m=100, name="many", rounded=False)

    layer = read_reference_layers(blobs)[0]

    assert layer.feature_count == 6000
    assert layer.truncated is False
    assert len(layer.geojson["features"]) == 6000


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
