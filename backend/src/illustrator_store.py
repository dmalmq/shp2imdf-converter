"""Disk cache of parsed Illustrator conversions.

Parsing a station-sized ``.ai`` costs seconds, and the georeferencing flow needs
the same geometry twice: once to preview, once to export. Each entry is a
directory holding the untransformed GeoPackage plus the metadata needed to
rebuild the bundle, expired after an idle period and capped by count, least
recently used first. Last use is the mtime of a marker file, so touching an
entry never rewrites its metadata.

Deliberately not built on ``SessionManager``: that store is shaped around IMDF
``SessionRecord`` objects, and a conversion is an unrelated bag of coloured
paths with no IMDF semantics.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from backend.src.illustrator_importer import _ConversionResult

_META_NAME = "conversion.json"
_GPKG_NAME = "artwork.gpkg"
_FLOORS_NAME = "floors.json"
_LAST_USED_NAME = "last_used"

logger = logging.getLogger(__name__)

# ``put`` names entries with ``uuid4().hex``. Ids arrive from the URL, so anything
# else is rejected before it can name a path.
_CONVERSION_ID_PATTERN = re.compile(r"[0-9a-f]{32}")

_UNAVAILABLE = "That conversion is no longer available. Convert the file again."


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
    last_used_at: float = 0.0

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
        self._touch(cached)
        self._enforce_cap()
        return cached

    def get(self, conversion_id: str) -> CachedConversion:
        directory = self._directory_for(conversion_id)
        meta_path = directory / _META_NAME
        if not meta_path.is_file():
            raise ConversionExpiredError(_UNAVAILABLE)
        try:
            cached = self._load(meta_path)
        except OSError as exc:
            # A lock (antivirus, another reader) is not corruption: keep the entry.
            logger.warning("Conversion %s could not be read: %s", conversion_id, exc)
            raise ConversionExpiredError(_UNAVAILABLE) from exc
        except (ValueError, KeyError) as exc:
            logger.warning("Conversion %s is corrupt and was removed: %s", conversion_id, exc)
            self._discard(directory)
            raise ConversionExpiredError(_UNAVAILABLE) from exc
        if self._is_expired(cached):
            self._discard(directory)
            raise ConversionExpiredError("That conversion has expired. Convert the file again.")
        self._touch(cached)
        return cached

    def prune(self) -> int:
        removed = 0
        for meta_path in self.root.glob(f"*/{_META_NAME}"):
            try:
                cached = self._load(meta_path)
            except OSError as exc:
                logger.warning("Skipping unreadable conversion %s: %s", meta_path.parent.name, exc)
                continue
            except (ValueError, KeyError):
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

    def _directory_for(self, conversion_id: str) -> Path:
        if not isinstance(conversion_id, str) or not _CONVERSION_ID_PATTERN.fullmatch(conversion_id):
            raise ConversionExpiredError(_UNAVAILABLE)
        directory = self.root / conversion_id
        if directory.resolve().parent != self.root.resolve():
            raise ConversionExpiredError(_UNAVAILABLE)
        return directory

    def _load(self, meta_path: Path) -> CachedConversion:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
        floors_path = meta_path.parent / _FLOORS_NAME
        floors = None
        if floors_path.is_file():
            floors = json.loads(floors_path.read_text(encoding="utf-8"))
        created_at = float(payload["created_at"])
        try:
            last_used_at = (meta_path.parent / _LAST_USED_NAME).stat().st_mtime
        except OSError:
            last_used_at = created_at
        return CachedConversion(
            conversion_id=payload["conversion_id"],
            directory=meta_path.parent,
            stem=payload["stem"],
            written_layers=payload["written_layers"],
            layer_order=payload["layer_order"],
            report=payload["report"],
            created_at=created_at,
            floors=floors,
            last_used_at=last_used_at,
        )

    def _is_expired(self, cached: CachedConversion) -> bool:
        return (time.time() - cached.last_used_at) > self.ttl_seconds

    @staticmethod
    def _touch(cached: CachedConversion) -> None:
        now = time.time()
        marker = cached.directory / _LAST_USED_NAME
        try:
            marker.touch()
            os.utime(marker, (now, now))
        except FileNotFoundError as exc:
            raise ConversionExpiredError(_UNAVAILABLE) from exc
        cached.last_used_at = now

    def _enforce_cap(self) -> None:
        entries = []
        for meta_path in self.root.glob(f"*/{_META_NAME}"):
            try:
                entries.append(self._load(meta_path))
            except OSError as exc:
                logger.warning("Skipping unreadable conversion %s: %s", meta_path.parent.name, exc)
            except (ValueError, KeyError):
                self._discard(meta_path.parent)
        surplus = len(entries) - self.max_entries
        if surplus <= 0:
            return
        for cached in sorted(entries, key=lambda item: item.last_used_at)[:surplus]:
            self._discard(cached.directory)

    def _discard(self, directory: Path) -> None:
        # Only ever delete an entry directory: a direct child of the store root.
        try:
            target = Path(directory).resolve()
            root = self.root.resolve()
        except OSError:
            return
        if target.parent != root or target == root:
            return
        shutil.rmtree(target, ignore_errors=True)
