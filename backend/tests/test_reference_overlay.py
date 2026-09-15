"""Preloaded 駅データ overlay: configured path, skip Station_pl until opt-in."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import LineString, Point, Polygon

from backend.src.importer import import_file_blobs, read_reference_layers
from backend.src.reference_overlay import (
    PRELOADED_LABEL,
    SURVEY_LINE_STEM,
    ReferenceOverlayStore,
    unpack_overlay_archive,
    write_stub_dbf,
)

CHIBA = (140.1134, 35.6132)
FAR = (141.5, 36.5)
CHIBA_FOCUS = (140.1134, 35.6132, 140.1134, 35.6132)
EKI_ZIP = Path(
    "/cursor/stores/bc-8ab4ff79-0a7c-4ed6-adb5-b39c76b13c2c/internal/test-data/eki-data.zip"
)
KEYWORDS = Path("backend/config/filename_keywords.json")
POISON_DBF = b"NOT_A_REAL_STATION_PL_DBF" * 2048


def _square(lon: float, lat: float) -> Polygon:
    return Polygon(
        [
            (lon, lat),
            (lon + 0.0002, lat),
            (lon + 0.0002, lat + 0.0002),
            (lon, lat + 0.0002),
        ]
    )


def _write_layer(directory: Path, stem: str, kind: str) -> None:
    if kind == "line":
        geometry = [
            LineString([(CHIBA[0], CHIBA[1]), (CHIBA[0] + 0.0003, CHIBA[1] + 0.0001)]),
            LineString([(FAR[0], FAR[1]), (FAR[0] + 0.0003, FAR[1])]),
        ]
    elif kind == "point":
        geometry = [Point(*CHIBA), Point(*FAR)]
    else:
        geometry = [_square(*CHIBA), _square(*FAR)]
    gdf = gpd.GeoDataFrame(
        {"NAME": ["near", "far"], "geometry": geometry},
        geometry="geometry",
        crs="EPSG:4326",
    )
    gdf.to_file(directory / f"{stem}.shp")


def _synthetic_eki_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "eki-dir"
    directory.mkdir(parents=True, exist_ok=True)
    _write_layer(directory, "StationUse", "polygon")
    _write_layer(directory, "Station_pg", "polygon")
    _write_layer(directory, "Station_pl", "line")
    _write_layer(directory, "Station_pt", "point")
    return directory


def _synthetic_eki_zip(tmp_path: Path, *, poison_pl_dbf: bool = True) -> Path:
    directory = _synthetic_eki_dir(tmp_path / "src")
    zip_path = tmp_path / "eki-data.zip"
    with zipfile.ZipFile(zip_path, "w") as archive:
        for path in directory.iterdir():
            data = path.read_bytes()
            if poison_pl_dbf and path.name == "Station_pl.dbf":
                data = POISON_DBF
            archive.writestr(path.name, data)
    return zip_path


@pytest.fixture
def configure_overlay(test_client, tmp_path: Path):
    previous = test_client.app.state.reference_overlay

    def _configure(source: Path | None) -> ReferenceOverlayStore:
        store = ReferenceOverlayStore(source, tmp_path / "overlay-cache")
        test_client.app.state.reference_overlay = store
        return store

    yield _configure
    test_client.app.state.reference_overlay = previous


def test_stub_dbf_is_readable_by_gdal(tmp_path: Path) -> None:
    directory = tmp_path / "stub"
    directory.mkdir()
    gdf = gpd.GeoDataFrame({"geometry": [_square(*CHIBA)]}, geometry="geometry", crs="EPSG:4326")
    gdf.to_file(directory / "tracks.shp")
    write_stub_dbf(directory / "tracks.dbf", 1)
    loaded = gpd.read_file(directory / "tracks.shp", columns=["geometry"])
    assert len(loaded) == 1


@pytest.mark.georef
def test_unpack_skips_station_pl_until_opt_in_and_never_keeps_the_real_dbf(tmp_path: Path) -> None:
    zip_path = _synthetic_eki_zip(tmp_path)
    dest = tmp_path / "unpacked"
    unpack_overlay_archive(zip_path, dest, include_lines=False)
    names = {path.name for path in dest.iterdir()}
    assert "Station_pg.shp" in names
    assert "Station_pt.shp" in names
    assert "StationUse.shp" in names
    assert not any(name.lower().startswith("station_pl") for name in names)

    unpack_overlay_archive(zip_path, dest, include_lines=True)
    dbf = dest / f"{SURVEY_LINE_STEM}.dbf"
    assert (dest / f"{SURVEY_LINE_STEM}.shp").exists()
    assert dbf.exists()
    assert POISON_DBF not in dbf.read_bytes()
    assert dbf.stat().st_size < 1024


@pytest.mark.georef
def test_store_skips_survey_lines_until_opt_in(tmp_path: Path) -> None:
    store = ReferenceOverlayStore(_synthetic_eki_zip(tmp_path), tmp_path / "cache")
    layers = store.read(focus=CHIBA_FOCUS, include_lines=False)
    names = [layer.name for layer in layers]
    assert names == ["StationUse", "Station_pg", "Station_pt"]
    for layer in layers:
        assert len(layer.geojson["features"]) == 1

    with_lines = store.read(focus=CHIBA_FOCUS, include_lines=True)
    assert [layer.name for layer in with_lines] == [
        "StationUse",
        "Station_pg",
        "Station_pl",
        "Station_pt",
    ]
    pl = next(layer for layer in with_lines if layer.name == "Station_pl")
    assert len(pl.geojson["features"]) == 1
    cache_files = list((tmp_path / "cache").rglob("Station_pl.dbf"))
    assert cache_files
    assert POISON_DBF not in cache_files[0].read_bytes()


@pytest.mark.georef
def test_store_reads_a_folder_in_place(tmp_path: Path) -> None:
    directory = _synthetic_eki_dir(tmp_path)
    store = ReferenceOverlayStore(directory, tmp_path / "cache")
    layers = store.read(focus=CHIBA_FOCUS, include_lines=False)
    assert "Station_pl" not in [layer.name for layer in layers]
    assert "Station_pg" in [layer.name for layer in layers]


@pytest.mark.georef
def test_overlay_upload_skips_a_poisoned_station_pl_dbf(tmp_path: Path) -> None:
    zip_path = _synthetic_eki_zip(tmp_path)
    layers = read_reference_layers(
        [("eki-data.zip", zip_path.read_bytes())], focus=CHIBA_FOCUS
    )
    names = [layer.name for layer in layers]
    assert "Station_pl" in names
    assert "Station_pg" in names


@pytest.mark.georef
def test_wizard_import_still_requires_the_real_dbf(tmp_path: Path) -> None:
    directory = tmp_path / "wizard"
    directory.mkdir()
    _write_layer(directory, "tracks", "polygon")
    blobs = [
        (path.name, path.read_bytes())
        for path in directory.iterdir()
        if path.suffix.lower() != ".dbf"
    ]
    with pytest.raises(ValueError, match=r"\.dbf"):
        import_file_blobs(blobs, KEYWORDS)


@pytest.mark.georef
def test_preloaded_info_is_hidden_when_unconfigured(test_client, configure_overlay) -> None:
    configure_overlay(None)
    response = test_client.get("/api/reference-layers/preloaded")
    assert response.status_code == 200
    assert response.json() == {"available": False, "label": PRELOADED_LABEL}


@pytest.mark.georef
def test_preloaded_info_is_available_when_the_extract_exists(
    test_client, tmp_path: Path, configure_overlay
) -> None:
    configure_overlay(_synthetic_eki_zip(tmp_path))
    response = test_client.get("/api/reference-layers/preloaded")
    assert response.status_code == 200
    assert response.json() == {"available": True, "label": PRELOADED_LABEL}


@pytest.mark.georef
def test_preloaded_endpoint_requires_a_pin(
    test_client, tmp_path: Path, configure_overlay
) -> None:
    configure_overlay(_synthetic_eki_zip(tmp_path))
    missing = test_client.post("/api/reference-layers/preloaded", json={"include_lines": False})
    assert missing.status_code == 422
    bad = test_client.post(
        "/api/reference-layers/preloaded", json={"focus_bounds": "not-a-box"}
    )
    assert bad.status_code == 400
    configure_overlay(None)
    unavailable = test_client.post(
        "/api/reference-layers/preloaded",
        json={"focus_bounds": "140.1134,35.6132,140.1134,35.6132"},
    )
    assert unavailable.status_code == 400


@pytest.mark.georef
def test_preloaded_endpoint_returns_layers_without_survey_lines(
    test_client, tmp_path: Path, configure_overlay
) -> None:
    configure_overlay(_synthetic_eki_zip(tmp_path))
    response = test_client.post(
        "/api/reference-layers/preloaded",
        json={"focus_bounds": "140.1134,35.6132,140.1134,35.6132", "include_lines": False},
    )
    assert response.status_code == 200, response.text
    names = [layer["name"] for layer in response.json()["layers"]]
    assert names == ["StationUse", "Station_pg", "Station_pt"]

    with_lines = test_client.post(
        "/api/reference-layers/preloaded",
        json={"focus_bounds": "140.1134,35.6132,140.1134,35.6132", "include_lines": True},
    )
    assert with_lines.status_code == 200, with_lines.text
    assert "Station_pl" in [layer["name"] for layer in with_lines.json()["layers"]]


@pytest.mark.georef
def test_picker_upload_still_works_when_preload_is_configured(
    test_client, tmp_path: Path, configure_overlay
) -> None:
    configure_overlay(_synthetic_eki_zip(tmp_path))
    gdf = gpd.GeoDataFrame({"geometry": [_square(*CHIBA)]}, geometry="geometry", crs="EPSG:4326")
    other = tmp_path / "other"
    other.mkdir()
    gdf.to_file(other / "platforms.shp")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path in other.iterdir():
            archive.writestr(path.name, path.read_bytes())
    response = test_client.post(
        "/api/reference-layers",
        files=[("files", ("platforms.zip", buffer.getvalue(), "application/zip"))],
        data={"focus_bounds": "140.1134,35.6132,140.1134,35.6132"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["layers"][0]["name"] == "platforms"


@pytest.mark.georef
@pytest.mark.skipif(not EKI_ZIP.is_file(), reason="eki-data.zip is not in the agent store")
def test_real_eki_extract_skips_station_pl_dbf_and_chiba_has_survey_polygons(
    tmp_path: Path,
) -> None:
    store = ReferenceOverlayStore(EKI_ZIP, tmp_path / "cache")
    layers = store.read(focus=CHIBA_FOCUS, include_lines=False)
    names = [layer.name for layer in layers]
    assert "Station_pl" not in names
    assert set(names) >= {"Station_pg", "Station_pt", "StationUse"}
    pg = next(layer for layer in layers if layer.name == "Station_pg")
    assert len(pg.geojson["features"]) > 0
    cached = list((tmp_path / "cache").rglob("*"))
    assert not any(path.name.lower().startswith("station_pl") for path in cached)

    with_lines = store.read(focus=CHIBA_FOCUS, include_lines=True)
    assert any(layer.name == "Station_pl" for layer in with_lines)
    dbfs = [path for path in (tmp_path / "cache").rglob("Station_pl.dbf")]
    assert dbfs
    # Real table is 322 MB; the stub is a few MB for 1.5M empty records.
    assert dbfs[0].stat().st_size < 10_000_000
    with zipfile.ZipFile(EKI_ZIP) as archive:
        assert archive.getinfo("Station_pl.dbf").file_size == 322_506_080
