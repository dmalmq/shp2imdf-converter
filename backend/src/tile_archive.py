"""The ``.vtiles`` folder inside a finished build's download, read one file at a time for the tile viewer.

The download already holds every tile, so the viewer is served from it as it
is: nothing is unpacked, nothing more is kept on disk, and the viewer's link
lasts exactly as long as the job. A file is found by its path inside the
``.vtiles`` folder in an index built once; a path that is not in the index is
simply not there, so no request can reach outside the folder.
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path, PurePosixPath
import threading
import zipfile

from pydantic import BaseModel

TILES_FOLDER = "vector_tiles"


class TileLevel(BaseModel):
    """The tiles stored for one zoom level, as Esri lays them out: ``tile/<level>/<row>/<column>.pbf``."""

    z: int
    count: int
    rows: tuple[int, int]
    columns: tuple[int, int]


class TileIndex(BaseModel):
    name: str
    """The ``.vtiles`` folder's name, without the suffix."""
    levels: list[TileLevel]
    """Lowest level first."""


class TileArchive:
    def __init__(self, path: Path) -> None:
        self._zip = zipfile.ZipFile(path)
        self._lock = threading.Lock()
        self._closed = False
        folder = _vtiles_folder(self._zip.namelist())
        self.name = PurePosixPath(folder).stem if folder else ""
        prefix = f"{folder}/"
        self._files = {
            info.filename[len(prefix) :]: info
            for info in self._zip.infolist()
            if folder and info.filename.startswith(prefix) and not info.is_dir()
        }

    def read(self, path: str) -> bytes | None:
        info = self._files.get(path)
        if info is None:
            return None
        with self._lock:
            # A job pruned between the lookup and the read is gone, like one pruned before it.
            return None if self._closed else self._zip.read(info)

    def index(self) -> TileIndex:
        return TileIndex(name=self.name, levels=tile_levels(self._files))

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._zip.close()


def _vtiles_folder(names: list[str]) -> str | None:
    """``vector_tiles/<name>.vtiles``, the one folder a build adds; None for a download without one."""
    for name in names:
        parts = name.split("/")
        if len(parts) > 2 and parts[0] == TILES_FOLDER and parts[1].casefold().endswith(".vtiles"):
            return f"{parts[0]}/{parts[1]}"
    return None


def tile_levels(paths) -> list[TileLevel]:
    """Each level's tile count and row and column range, from paths of the form ``tile/<z>/<row>/<column>.<ext>``."""
    found: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for path in paths:
        parts = path.split("/")
        if len(parts) != 4 or parts[0] != "tile":
            continue
        z, row, column = parts[1], parts[2], parts[3].split(".", 1)[0]
        if z.isdigit() and row.isdigit() and column.isdigit():
            found[int(z)].append((int(row), int(column)))
    return [
        TileLevel(
            z=z,
            count=len(tiles),
            rows=(min(row for row, _ in tiles), max(row for row, _ in tiles)),
            columns=(min(column for _, column in tiles), max(column for _, column in tiles)),
        )
        for z, tiles in sorted(found.items())
    ]
