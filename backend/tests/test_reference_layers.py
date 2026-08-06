"""Reference overlay layers for the placement map."""

from __future__ import annotations

import io
import math
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


def _wgs84_shapefile(
    tmp_path: Path, coords: list[tuple[float, float]], name: str = "stations"
) -> list[tuple[str, bytes]]:
    """Loose shapefile components already in EPSG:4326, one small square per (lon, lat).

    Writing the fixture in WGS84 keeps the assertions in the same frame as the
    focus box, so the 1 km margin can be computed and checked exactly.
    """
    gdf = gpd.GeoDataFrame(
        {
            "geometry": [
                Polygon(
                    [
                        (lon, lat),
                        (lon + 0.0002, lat),
                        (lon + 0.0002, lat + 0.0002),
                        (lon, lat + 0.0002),
                    ]
                )
                for lon, lat in coords
            ]
        },
        geometry="geometry",
        crs="EPSG:4326",
    )
    directory = tmp_path / name
    directory.mkdir(parents=True, exist_ok=True)
    gdf.to_file(directory / f"{name}.shp")
    return [(path.name, path.read_bytes()) for path in directory.iterdir()]


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


def test_focus_keeps_nearby_features_while_feature_count_reports_the_source_total(tmp_path: Path) -> None:
    """A focus box trims the payload but not the count the UI shows as "N of M"."""
    blobs = _wgs84_shapefile(
        tmp_path, [(140.0, 35.0), (140.005, 35.0), (140.05, 35.0)], name="focus"
    )

    layer = read_reference_layers(blobs, focus=(140.0, 35.0, 140.0, 35.0))[0]

    # ~450 m and ~4.6 km east: the first survives the 1 km margin, the second does not.
    assert len(layer.geojson["features"]) == 2
    assert layer.feature_count == 3


def test_without_focus_every_feature_is_kept_exactly_as_before(tmp_path: Path) -> None:
    """No focus box means no spatial trim: the old behaviour, byte for byte."""
    blobs = _wgs84_shapefile(tmp_path, [(140.0, 35.0), (140.05, 35.0), (141.0, 36.0)], name="nofocus")

    layer = read_reference_layers(blobs)[0]

    assert layer.feature_count == 3
    assert layer.truncated is False
    assert len(layer.geojson["features"]) == 3
    assert layer.warnings == []


def test_features_just_outside_the_focus_box_survive_the_margin(tmp_path: Path) -> None:
    """The box is a hint about where the artwork sits; the 1 km margin is the
    real filter, so features just beyond the box edge are still kept.
    """
    blobs = _wgs84_shapefile(tmp_path, [(140.0, 35.0), (140.02, 35.0), (140.03, 35.0)], name="margin")

    layer = read_reference_layers(blobs, focus=(139.99, 34.99, 140.01, 35.01))[0]

    # 140.02 is ~910 m east of the box edge (within the margin), 140.03 is ~1.8 km (beyond).
    assert len(layer.geojson["features"]) == 2
    assert layer.feature_count == 3


def test_focus_matching_nothing_returns_an_empty_layer_with_a_warning(tmp_path: Path) -> None:
    """An empty result is a fact to tell the operator about, not a volume cap."""
    blobs = _wgs84_shapefile(tmp_path, [(140.0, 35.0)], name="nowhere")

    layer = read_reference_layers(blobs, focus=(141.0, 36.0, 141.0, 36.0))[0]

    assert layer.geojson["features"] == []
    assert layer.feature_count == 1
    assert layer.truncated is False
    assert "nowhere: no features within 1 km of the artwork." in layer.warnings


def test_focus_margin_is_computed_per_axis(tmp_path: Path) -> None:
    """A longitude-only offset between the latitude figure and the cosine-corrected
    degree distance must still be inside the margin.

    At 35N the degree lengths differ by ~20%, so reusing the latitude constant
    for longitude would drop this feature: the offset is beyond 1000/111320
    degrees of longitude but within 1000/(111320 * cos(35)) of it.
    """
    mid_lat = 35.0
    dlat = 1000.0 / 111_320.0
    dlon = 1000.0 / (111_320.0 * math.cos(math.radians(mid_lat)))
    offset = (dlat + dlon) / 2.0
    assert dlat < offset < dlon

    blobs = _wgs84_shapefile(tmp_path, [(140.0, mid_lat), (140.0 + offset, mid_lat)], name="axis")

    layer = read_reference_layers(blobs, focus=(140.0, mid_lat, 140.0, mid_lat))[0]

    assert len(layer.geojson["features"]) == 2
    assert layer.feature_count == 2


def test_endpoint_ignores_a_malformed_focus_bounds(test_client, tmp_path: Path) -> None:
    """A bad hint is an optimisation that never gets to break an upload."""
    blobs = _wgs84_shapefile(tmp_path, [(140.0, 35.0), (140.05, 35.0)], name="malformed")
    files = [("files", (name, content, "application/octet-stream")) for name, content in blobs]

    for bad in ("not,a,box", "1,2", "1,2,3", "140,35,140,nope", "140,35,140,NaN"):
        response = test_client.post("/api/reference-layers", files=files, data={"focus_bounds": bad})
        assert response.status_code == 200, (bad, response.text)
        layer = response.json()["layers"][0]
        assert layer["feature_count"] == 2
        assert len(layer["geojson"]["features"]) == 2


def test_endpoint_honors_a_valid_focus_bounds(test_client, tmp_path: Path) -> None:
    """The parsed box must actually reach the reader, or the feature is dead at the API."""
    blobs = _wgs84_shapefile(tmp_path, [(140.0, 35.0), (140.05, 35.0)], name="valid")
    files = [("files", (name, content, "application/octet-stream")) for name, content in blobs]

    response = test_client.post(
        "/api/reference-layers", files=files, data={"focus_bounds": "140.0,35.0,140.0,35.0"}
    )
    assert response.status_code == 200, response.text
    layer = response.json()["layers"][0]
    assert layer["feature_count"] == 2
    assert len(layer["geojson"]["features"]) == 1
