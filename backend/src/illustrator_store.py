"""Disk store of parsed Illustrator conversions.

Parsing a station-sized ``.ai`` costs seconds, and the georeferencing flow needs
the same geometry twice: once to preview, once to export. Each entry is a
directory holding the untransformed GeoPackage plus the metadata needed to
rebuild the bundle, expired after an idle period and capped by count, least
recently used first. Last use is the mtime of a marker file, so touching an
entry never rewrites its metadata.

Each entry is also an artwork project: ``project.json`` holds its name, last
change, delivery time and placed-floor count, rewritten under a short per-entry
lock so a rename and an assignment arriving together both survive. Listing reads
metadata only and never touches, so the project list does not keep entries alive.

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
import threading
import time
import weakref
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from backend.src.artwork_projects import (
    ArtworkProject,
    ArtworkStage,
    derive_artwork_stage,
    normalise_project_name,
    utc_now_iso,
)
from backend.src.illustrator_importer import PARSER_VERSION, _ConversionResult

_META_NAME = "conversion.json"
_GPKG_NAME = "artwork.gpkg"
_FLOORS_NAME = "floors.json"
_LAST_USED_NAME = "last_used"
_PROJECT_NAME = "project.json"

logger = logging.getLogger(__name__)

# ``put`` names entries with ``uuid4().hex``. Ids arrive from the URL, so anything
# else is rejected before it can name a path.
_CONVERSION_ID_PATTERN = re.compile(r"[0-9a-f]{32}")

_UNAVAILABLE = "That conversion is no longer available. Convert the file again."
_BUSY = "That project is busy. Try again in a moment."


class ConversionExpiredError(Exception):
    """Raised when a conversion id is unknown or has aged out of the cache."""


class ConversionBusyError(Exception):
    """Raised when a sidecar stays locked by another process past a short retry."""


@dataclass(frozen=True, slots=True)
class ContentSnapshot:
    """What an export was built from, so a later assignment cannot be marked delivered."""

    content_changed_at: str | None
    floors_total: int


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
    parser_version: int | None = None

    @property
    def gpkg_path(self) -> Path:
        return self.directory / _GPKG_NAME


@dataclass(slots=True)
class ConversionSummary:
    conversion_id: str
    stem: str
    name: str
    created_at: float
    last_used_at: float
    expires_at: float
    updated_at: str | None
    content_changed_at: str | None
    delivered_at: str | None
    floors_total: int
    floors_placed: int
    stage: ArtworkStage
    blockers: int | None
    parser_version: int | None = None


class ConversionStore:
    """TTL- and count-capped store of parsed conversions."""

    def __init__(self, root: Path, ttl_seconds: float, max_entries: int) -> None:
        self.root = Path(root)
        self.ttl_seconds = float(ttl_seconds)
        self.max_entries = int(max_entries)
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: weakref.WeakValueDictionary[str, threading.Lock] = (
            weakref.WeakValueDictionary()
        )
        self._locks_guard = threading.Lock()

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
            parser_version=PARSER_VERSION,
        )
        now = utc_now_iso()
        _write_json(
            directory / _PROJECT_NAME,
            ArtworkProject(name=cached.stem, updated_at=now, content_changed_at=now).to_dict(),
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
                    "parser_version": cached.parser_version,
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
        """Store a floor assignment for a conversion and return it reloaded.

        A new assignment invalidates any placement, so no floor counts as placed.
        """
        cached = self.get(conversion_id)  # raises ConversionExpiredError for unknown ids
        with self._lock_for(conversion_id):
            project = _read_project(cached.directory, cached.stem, strict=True)
            _write_json(cached.directory / _FLOORS_NAME, floors)
            now = utc_now_iso()
            project.floors_total = len(floors)
            project.floors_placed = 0
            project.updated_at = now
            project.content_changed_at = now
            _write_json(cached.directory / _PROJECT_NAME, project.to_dict())
        return self.get(conversion_id)

    def project(self, cached: CachedConversion) -> ArtworkProject:
        return _read_project(cached.directory, cached.stem)

    def rename(self, conversion_id: str, name: str) -> ArtworkProject:
        cached = self.get(conversion_id)
        cleaned = normalise_project_name(name)
        with self._lock_for(conversion_id):
            project = _read_project(cached.directory, cached.stem, strict=True)
            project.name = cleaned
            project.updated_at = utc_now_iso()
            _write_json(cached.directory / _PROJECT_NAME, project.to_dict())
        return project

    def open_for_export(self, conversion_id: str) -> tuple[CachedConversion, ContentSnapshot]:
        """Load a conversion and snapshot its content under the lock ``assign`` writes under.

        The floors an export uses and the snapshot it is later recorded against
        are therefore from the same assignment.
        """
        with self._lock_for(conversion_id):
            cached = self.get(conversion_id)
            project = _read_project(cached.directory, cached.stem)
        return cached, ContentSnapshot(project.content_changed_at, project.floors_total)

    def mark_delivered(
        self, conversion_id: str, floors_placed: int, snapshot: ContentSnapshot
    ) -> ArtworkProject | None:
        """Record an export built from ``snapshot``; ``None`` if the content moved on since.

        Every exported floor carried a transform, so each counts as placed.
        """
        cached = self.get(conversion_id)
        with self._lock_for(conversion_id):
            project = _read_project(cached.directory, cached.stem, strict=True)
            if (
                project.content_changed_at != snapshot.content_changed_at
                or project.floors_total != snapshot.floors_total
            ):
                logger.info(
                    "Conversion %s changed during export; the delivery is not recorded as current",
                    conversion_id,
                )
                return None
            now = utc_now_iso()
            project.floors_total = max(project.floors_total, floors_placed)
            project.floors_placed = floors_placed
            project.delivered_at = now
            project.updated_at = now
            _write_json(cached.directory / _PROJECT_NAME, project.to_dict())
        return project

    def list_summaries(self) -> list[ConversionSummary]:
        """Summaries of live entries from their metadata alone.

        Never calls ``get``: listing must not extend an entry's life or delete one.
        Expired and unreadable entries are skipped, not removed; ``prune`` owns that.
        """
        try:
            directories = [
                entry
                for entry in self.root.iterdir()
                if _CONVERSION_ID_PATTERN.fullmatch(entry.name)
            ]
        except OSError:
            return []
        summaries = [
            summary
            for summary in (self._summarise(directory) for directory in directories)
            if summary is not None
        ]
        summaries.sort(key=lambda item: (-item.last_used_at, item.conversion_id))
        return summaries

    def _summarise(self, directory: Path) -> ConversionSummary | None:
        try:
            payload = json.loads((directory / _META_NAME).read_text(encoding="utf-8"))
            stem = str(payload["stem"])
            created_at = float(payload["created_at"])
            parser_version = payload.get("parser_version")
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return None
        try:
            raw_project = json.loads((directory / _PROJECT_NAME).read_text(encoding="utf-8"))
            has_project = True
        except (OSError, ValueError):
            raw_project, has_project = None, False
        project = ArtworkProject.from_dict(raw_project, stem)
        try:
            last_used_at = (directory / _LAST_USED_NAME).stat().st_mtime
        except OSError:
            if not directory.is_dir():
                return None
            last_used_at = created_at
        if (time.time() - last_used_at) > self.ttl_seconds:
            return None
        has_floors = project.floors_total > 0 or (
            not has_project and (directory / _FLOORS_NAME).is_file()
        )
        stage, blockers = derive_artwork_stage(
            has_floors=has_floors,
            floors_total=project.floors_total,
            floors_placed=project.floors_placed,
            delivered_at=project.delivered_at,
            content_changed_at=project.content_changed_at,
        )
        return ConversionSummary(
            conversion_id=directory.name,
            stem=stem,
            name=project.name,
            created_at=created_at,
            last_used_at=last_used_at,
            expires_at=last_used_at + self.ttl_seconds,
            updated_at=project.updated_at,
            content_changed_at=project.content_changed_at,
            delivered_at=project.delivered_at,
            floors_total=project.floors_total,
            floors_placed=project.floors_placed,
            stage=stage,
            blockers=blockers,
            parser_version=parser_version if isinstance(parser_version, int) else None,
        )

    def _lock_for(self, conversion_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(conversion_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[conversion_id] = lock
            return lock

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
            parser_version=payload.get("parser_version"),
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


_LOCKED_FILE_ATTEMPTS = 5


def _read_project(directory: Path, stem: str, *, strict: bool = False) -> ArtworkProject:
    """Read a sidecar, retrying briefly while Windows holds it locked.

    A read-only caller falls back to defaults if it stays locked. A ``strict``
    caller is about to write the result back, and defaults would overwrite the
    real values, so it raises ``ConversionBusyError`` instead.
    """
    path = directory / _PROJECT_NAME
    payload = None
    for attempt in range(_LOCKED_FILE_ATTEMPTS):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            break
        except FileNotFoundError:
            break
        except PermissionError:
            if attempt < _LOCKED_FILE_ATTEMPTS - 1:
                time.sleep(0.02 * (attempt + 1))
                continue
            if strict:
                raise ConversionBusyError(_BUSY) from None
            logger.warning("Project sidecar for %s stayed locked; using defaults", directory.name)
        except ValueError:
            logger.warning("Project sidecar for %s is corrupt; using defaults", directory.name)
            break
    return ArtworkProject.from_dict(payload, stem)


def _write_json(path: Path, payload: object) -> None:
    """Write via a temporary file and rename, so a reader never sees half a file.

    The entry directory can disappear underneath (expiry, the cap), which is
    reported as the conversion being gone rather than as a server error.
    """
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        for attempt in range(_LOCKED_FILE_ATTEMPTS):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                # Windows refuses to replace a file another thread has open for reading.
                if attempt == _LOCKED_FILE_ATTEMPTS - 1:
                    raise ConversionBusyError(_BUSY) from None
                time.sleep(0.01 * (attempt + 1))
    except FileNotFoundError as exc:
        raise ConversionExpiredError(_UNAVAILABLE) from exc
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def migrate_legacy_conversions(legacy_root: Path, root: Path) -> int:
    """Move entries from the old temp-dir store into ``root``; return how many moved.

    Conversions used to live under ``TEMP_DATA_DIR``, which is for disposable
    files; as projects they belong in the data directory. An entry whose id
    already exists in ``root``, or that cannot be moved, stays where it was and
    is logged, since the running store no longer looks there.

    Across drives a move is a copy, so the copy goes to a temporary sibling and
    is renamed into place only once complete: an interrupted copy never leaves a
    half entry under the real id that later starts would skip as a duplicate.
    """
    legacy_root, root = Path(legacy_root), Path(root)
    _remove_migration_leftovers(root)
    try:
        if not legacy_root.is_dir() or legacy_root.resolve() == root.resolve():
            return 0
        candidates = [
            entry
            for entry in legacy_root.iterdir()
            if entry.is_dir() and _CONVERSION_ID_PATTERN.fullmatch(entry.name)
        ]
    except OSError as exc:
        logger.warning("Could not read the old conversion store %s: %s", legacy_root, exc)
        return 0
    root.mkdir(parents=True, exist_ok=True)
    moved = 0
    for entry in candidates:
        target = root / entry.name
        if target.exists():
            logger.warning(
                "Conversion %s exists in both %s and %s; leaving the old copy",
                entry.name,
                legacy_root,
                root,
            )
            continue
        try:
            _move_entry(entry, target)
        except OSError as exc:
            logger.warning("Could not move conversion %s to %s: %s", entry.name, root, exc)
            continue
        moved += 1
    if moved:
        logger.info("Moved %d conversions from %s to %s", moved, legacy_root, root)
    try:
        legacy_root.rmdir()
    except OSError:
        pass
    return moved


_MIGRATING_SUFFIX = ".migrating"


def _move_entry(entry: Path, target: Path) -> None:
    try:
        os.rename(entry, target)
        return
    except OSError:
        pass
    staging = target.with_name(f".{target.name}.{uuid4().hex}{_MIGRATING_SUFFIX}")
    try:
        shutil.copytree(entry, staging)
        os.rename(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    shutil.rmtree(entry, ignore_errors=True)


def _remove_migration_leftovers(root: Path) -> None:
    try:
        leftovers = [
            entry
            for entry in root.iterdir()
            if entry.name.startswith(".") and entry.name.endswith(_MIGRATING_SUFFIX)
        ]
    except OSError:
        return
    for leftover in leftovers:
        logger.warning("Removing an interrupted conversion migration: %s", leftover.name)
        shutil.rmtree(leftover, ignore_errors=True)
