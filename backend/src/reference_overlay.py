"""Server-side 駅データ overlay: unpack once, bbox-query, skip unused attributes."""

from __future__ import annotations

from datetime import date
from hashlib import sha1
from pathlib import Path
import shutil
import struct
import threading
import zipfile

from backend.src.importer import (
    LoadedSource,
    ReferenceLayer,
    SUPPORTED_SHAPEFILE_EXTENSIONS,
    _expand_focus_box,
    _read_geopackage_blob,
    _read_shapefile_overlay_path,
    _to_reference_layer,
)

SURVEY_LINE_STEM = "Station_pl"
PRELOADED_LABEL = "駅データ"


def shapefile_record_count(shx_path: Path) -> int:
    size = shx_path.stat().st_size
    if size < 100:
        return 0
    return (size - 100) // 8


def write_stub_dbf(path: Path, n_records: int) -> None:
    """One unused 1-char field so GDAL has a table without the real attributes."""
    n_records = max(0, int(n_records))
    today = date.today()
    header_length = 32 + 32 + 1
    record_length = 2
    header = bytearray(32)
    header[0] = 0x03
    header[1] = today.year % 100
    header[2] = today.month
    header[3] = today.day
    struct.pack_into("<I", header, 4, n_records)
    struct.pack_into("<H", header, 8, header_length)
    struct.pack_into("<H", header, 10, record_length)
    field = bytearray(32)
    field[0:1] = b"G"
    field[11:12] = b"C"
    field[16] = 1
    # Deletion flag + one-character field, both spaces (not deleted, unused).
    record = b"  "
    with path.open("wb") as handle:
        handle.write(header)
        handle.write(field)
        handle.write(b"\r")
        if n_records:
            handle.write(record * n_records)
        handle.write(b"\x1a")


def ensure_stub_dbf(shapefile_path: Path) -> None:
    dbf_path = shapefile_path.with_suffix(".dbf")
    if dbf_path.exists():
        return
    shx_path = shapefile_path.with_suffix(".shx")
    if not shx_path.exists():
        raise ValueError(f"Missing required shapefile sidecars for '{shapefile_path.stem}': .shx")
    write_stub_dbf(dbf_path, shapefile_record_count(shx_path))


def _cache_key(source: Path) -> str:
    stat = source.stat()
    payload = f"{source.resolve()}|{stat.st_mtime_ns}|{stat.st_size}"
    return sha1(payload.encode("utf-8")).hexdigest()[:16]


def _should_extract(info: zipfile.ZipInfo, include_lines: bool) -> bool:
    name = Path(info.filename).name
    if not name or info.is_dir():
        return False
    stem = Path(name).stem
    suffix = Path(name).suffix.lower()
    if stem.lower() == SURVEY_LINE_STEM.lower() and suffix == ".dbf":
        return False
    if stem.lower() == SURVEY_LINE_STEM.lower() and not include_lines:
        return False
    return suffix in SUPPORTED_SHAPEFILE_EXTENSIONS or suffix == ".gpkg"


def unpack_overlay_archive(zip_path: Path, dest: Path, *, include_lines: bool) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            if not _should_extract(info, include_lines):
                continue
            name = Path(info.filename).name
            target = dest / name
            if target.exists() and target.stat().st_size == info.file_size:
                continue
            with archive.open(info) as src, target.open("wb") as out:
                while True:
                    chunk = src.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
    line_shp = dest / f"{SURVEY_LINE_STEM}.shp"
    if include_lines and line_shp.exists():
        ensure_stub_dbf(line_shp)


class ReferenceOverlayStore:
    """Configured regional extract on disk. Unpacked once, then bbox-queried."""

    def __init__(self, source_path: Path | None, cache_dir: Path) -> None:
        self.source_path = source_path.resolve() if source_path is not None else None
        self.cache_dir = cache_dir
        self._lock = threading.Lock()

    def available(self) -> bool:
        return self.source_path is not None and self.source_path.exists()

    def working_directory(self, *, include_lines: bool) -> Path:
        if not self.available() or self.source_path is None:
            raise ValueError("No preloaded 駅データ. Set REFERENCE_OVERLAY_PATH to the zip or folder.")
        source = self.source_path
        if source.is_dir():
            return self._directory_root(source, include_lines=include_lines)
        if source.suffix.lower() != ".zip":
            raise ValueError("REFERENCE_OVERLAY_PATH must be a .zip or a folder of shapefiles.")
        dest = self.cache_dir / _cache_key(source)
        with self._lock:
            unpack_overlay_archive(source, dest, include_lines=include_lines)
        return dest

    def _directory_root(self, source: Path, *, include_lines: bool) -> Path:
        """Read a folder in place. Stub Station_pl.dbf without copying the extract."""
        if not include_lines:
            return source
        line_shp = source / f"{SURVEY_LINE_STEM}.shp"
        if not line_shp.exists() or line_shp.with_suffix(".dbf").exists():
            return source
        try:
            ensure_stub_dbf(line_shp)
            return source
        except OSError:
            dest = self.cache_dir / _cache_key(source)
            dest.mkdir(parents=True, exist_ok=True)
            for path in source.iterdir():
                if not path.is_file():
                    continue
                target = dest / path.name
                if not target.exists():
                    shutil.copy2(path, target)
            copied = dest / f"{SURVEY_LINE_STEM}.shp"
            if copied.exists():
                ensure_stub_dbf(copied)
            return dest

    def read(
        self,
        *,
        focus: tuple[float, float, float, float],
        include_lines: bool = False,
    ) -> list[ReferenceLayer]:
        directory = self.working_directory(include_lines=include_lines)
        return read_overlay_directory(directory, focus=focus, include_lines=include_lines)


def _shapefile_stems(directory: Path) -> list[str]:
    stems = sorted({path.stem for path in directory.glob("*.shp")})
    return stems


def read_overlay_directory(
    directory: Path,
    *,
    focus: tuple[float, float, float, float] | None,
    include_lines: bool,
) -> list[ReferenceLayer]:
    focus_bbox_4326 = _expand_focus_box(focus) if focus is not None else None
    stems = _shapefile_stems(directory)
    if not include_lines:
        stems = [stem for stem in stems if stem.lower() != SURVEY_LINE_STEM.lower()]
    used_stems = {stem.lower() for stem in stems}
    sources: list[LoadedSource] = []
    for stem in stems:
        shapefile_path = directory / f"{stem}.shp"
        sources.append(
            _read_shapefile_overlay_path(shapefile_path, focus_bbox_4326=focus_bbox_4326)
        )
    for package in sorted(directory.glob("*.gpkg")):
        package_sources, _warnings = _read_geopackage_blob(
            package.stem, package.read_bytes(), used_stems, focus_bbox_4326=focus_bbox_4326
        )
        sources.extend(package_sources)
        used_stems.update(source.stem.lower() for source in package_sources)
    if not sources:
        raise ValueError("No spatial data layers found in the preloaded overlay.")
    return [_to_reference_layer(source, focus_bbox_4326=focus_bbox_4326) for source in sources]
