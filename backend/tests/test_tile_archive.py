"""Reading a build's ``.vtiles`` folder out of its download, for the tile viewer."""

from __future__ import annotations

import os
from pathlib import Path
import zipfile

import pytest

from backend.src.tile_archive import TileArchive, TileLevel, tile_levels

pytestmark = [pytest.mark.colortheme, pytest.mark.vectortiles]


def test_levels_are_read_as_esri_lays_tiles_out_row_before_column() -> None:
    paths = [
        "tile/16/25802/58198.pbf",
        "tile/16/25804/58200.pbf",
        "tile/16/25803/58201.pbf",
        "tile/0/0/0.pbf",
        "tile/16/x/1.pbf",
        "tile/16/1.pbf",
        "tilemap/root.json",
        "resources/styles/root.json",
    ]

    assert tile_levels(paths) == [
        TileLevel(z=0, count=1, rows=(0, 0), columns=(0, 0)),
        TileLevel(z=16, count=3, rows=(25802, 25804), columns=(58198, 58201)),
    ]


def test_a_download_without_tiles_has_an_empty_index(tmp_path) -> None:
    download = tmp_path / "download.zip"
    with zipfile.ZipFile(download, "w") as archive:
        archive.writestr("東京/0/Space.dbf", b"x")
        archive.writestr("vector_tiles/build_log.txt", b"log")

    tiles = TileArchive(download)

    assert tiles.index().model_dump() == {"name": "", "levels": []}
    assert tiles.read("build_log.txt") is None
    tiles.close()


def test_a_closed_archive_reads_nothing(tmp_path) -> None:
    download = tmp_path / "download.zip"
    with zipfile.ZipFile(download, "w") as archive:
        archive.writestr("vector_tiles/a.vtiles/tile/0/0/0.pbf", b"t")
    tiles = TileArchive(download)
    assert tiles.read("tile/0/0/0.pbf") == b"t"

    tiles.close()

    assert tiles.read("tile/0/0/0.pbf") is None
    download.unlink()


@pytest.mark.skipif(not os.environ.get("SHINJUKU_VTILES"), reason="SHINJUKU_VTILES names no .vtiles folder")
def test_a_real_vtiles_folder_frames_shinjuku(tmp_path) -> None:
    """``SHINJUKU_VTILES``: a ``.vtiles`` folder that ArcGIS Pro extracted from Shinjuku's package."""
    vtiles = Path(os.environ["SHINJUKU_VTILES"])
    download = tmp_path / "download.zip"
    with zipfile.ZipFile(download, "w") as archive:
        for file in vtiles.rglob("*"):
            if file.is_file():
                archive.write(file, f"vector_tiles/{vtiles.name}/{file.relative_to(vtiles).as_posix()}")

    tiles = TileArchive(download)
    deepest = tiles.index().levels[-1]
    style = tiles.read("resources/styles/root.json")
    tiles.close()

    # Shinjuku Station, 139.70 E 35.69 N, is column 58201 and row 25803 at level 16.
    assert deepest.z == 16
    assert deepest.columns[0] <= 58201 <= deepest.columns[1]
    assert deepest.rows[0] <= 25803 <= deepest.rows[1]
    assert style == (vtiles / "resources" / "styles" / "root.json").read_bytes()
