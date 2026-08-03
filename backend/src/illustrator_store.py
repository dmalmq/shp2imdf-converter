"""Disk cache of parsed Illustrator conversions.

Parsing a station-sized ``.ai`` costs seconds, and the georeferencing flow needs
the same geometry twice: once to preview, once to export. Each entry is a
directory holding the untransformed GeoPackage plus the metadata needed to
rebuild the bundle, expired by age and capped by count.

Deliberately not built on ``SessionManager``: that store is shaped around IMDF
``SessionRecord`` objects, and a conversion is an unrelated bag of coloured
paths with no IMDF semantics.
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from backend.src.illustrator_importer import _ConversionResult

_META_NAME = "conversion.json"
_GPKG_NAME = "artwork.gpkg"
_FLOORS_NAME = "floors.json"


class ConversionExpiredError(Exception):
    """Raised when a conversion id is unknown or has aged out of the cache."""


@dataclass(slots=True)
class CachedConversion:
    conversion_id: str
    directory: Path
    stem: str
    written_layers: list[dict[str, str]]
    layer_order: list[str]
    report: dict
    created_at: float
    floors: list[dict] | None = None

    @property
    def gpkg_path(self) -> Path:
        return self.directory / _GPKG_NAME


class ConversionStore:
    """TTL- and count-capped store of parsed conversions."""

    def __init__(self, root: Path, ttl_seconds: float, max_entries: int) -> None:
        self.root = Path(root)
        self.ttl_seconds = float(ttl_seconds)
        self.max_entries = int(max_entries)
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, result: _ConversionResult) -> CachedConversion:
        conversion_id = uuid4().hex
        directory = self.root / conversion_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / _GPKG_NAME).write_bytes(result.gpkg_bytes)

        cached = CachedConversion(
            conversion_id=conversion_id,
            directory=directory,
            stem=result.stem,
            written_layers=result.written_layers,
            layer_order=result.layer_order,
            report=result.report.to_dict(),
            created_at=time.time(),
        )
        (directory / _META_NAME).write_text(
            json.dumps(
                {
                    "conversion_id": cached.conversion_id,
                    "stem": cached.stem,
                    "written_layers": cached.written_layers,
                    "layer_order": cached.layer_order,
                    "report": cached.report,
                    "created_at": cached.created_at,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self._enforce_cap()
        return cached

    def get(self, conversion_id: str) -> CachedConversion:
        directory = self.root / conversion_id
        meta_path = directory / _META_NAME
        if not meta_path.is_file():
            raise ConversionExpiredError(
                "That conversion is no longer available. Convert the file again."
            )
        cached = self._load(meta_path)
        if self._is_expired(cached):
            self._discard(directory)
            raise ConversionExpiredError("That conversion has expired. Convert the file again.")
        return cached

    def prune(self) -> int:
        removed = 0
        for meta_path in self.root.glob(f"*/{_META_NAME}"):
            try:
                cached = self._load(meta_path)
            except (OSError, ValueError, KeyError):
                self._discard(meta_path.parent)
                removed += 1
                continue
            if self._is_expired(cached):
                self._discard(cached.directory)
                removed += 1
        return removed

    def assign(self, conversion_id: str, floors: list[dict]) -> CachedConversion:
        """Store a floor assignment for a conversion and return it reloaded."""
        cached = self.get(conversion_id)  # raises ConversionExpiredError for unknown ids
        (cached.directory / _FLOORS_NAME).write_text(
            json.dumps(floors, ensure_ascii=False), encoding="utf-8"
        )
        return self.get(conversion_id)

    def _load(self, meta_path: Path) -> CachedConversion:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
        floors_path = meta_path.parent / _FLOORS_NAME
        floors = None
        if floors_path.is_file():
            floors = json.loads(floors_path.read_text(encoding="utf-8"))
        return CachedConversion(
            conversion_id=payload["conversion_id"],
            directory=meta_path.parent,
            stem=payload["stem"],
            written_layers=payload["written_layers"],
            layer_order=payload["layer_order"],
            report=payload["report"],
            created_at=float(payload["created_at"]),
            floors=floors,
        )

    def _is_expired(self, cached: CachedConversion) -> bool:
        return (time.time() - cached.created_at) > self.ttl_seconds

    def _enforce_cap(self) -> None:
        entries = []
        for meta_path in self.root.glob(f"*/{_META_NAME}"):
            try:
                entries.append(self._load(meta_path))
            except (OSError, ValueError, KeyError):
                self._discard(meta_path.parent)
        surplus = len(entries) - self.max_entries
        if surplus <= 0:
            return
        for cached in sorted(entries, key=lambda item: item.created_at)[:surplus]:
            self._discard(cached.directory)

    @staticmethod
    def _discard(directory: Path) -> None:
        shutil.rmtree(directory, ignore_errors=True)
