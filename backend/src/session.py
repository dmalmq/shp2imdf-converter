"""Session management abstractions and backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections import OrderedDict
import copy
import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import json
import logging
import os
from pathlib import Path
import re
import shutil
import threading
from uuid import uuid4

from backend.src.project_limits import (
    DEFAULT_IDLE_DAYS,
    DEFAULT_MAX_PROJECTS,
    PROTECTED_SECONDS,
    describe_duration,
    select_evictions,
)
from backend.src.projects import ProjectFields, derive_session_project
from backend.src.schemas import SESSION_RECORD_SCHEMA_VERSION, CleanupSummary, ImportedFile, SessionRecord

logger = logging.getLogger(__name__)

_SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9-]+")
META_VERSION = 2


def is_session_id(value: str) -> bool:
    return isinstance(value, str) and _SESSION_ID_PATTERN.fullmatch(value) is not None


@dataclass
class SessionSummary:
    session_id: str
    last_accessed: datetime
    upload_artifact_dir: str | None = None
    # None when only a version-1 meta file has been read: the project is unknown
    # until the record is next loaded or saved.
    project: ProjectFields | None = None

    @classmethod
    def of(cls, session: SessionRecord) -> SessionSummary:
        return cls(
            session.session_id,
            session.last_accessed,
            session.upload_artifact_dir,
            derive_session_project(session),
        )


def session_delivered_and_unchanged(summary: SessionSummary) -> bool:
    """Whether a session was delivered and has not changed since, from its meta alone.

    A version-1 meta file carries no delivery state, so that session counts as
    not delivered until it is next saved.
    """
    project = summary.project
    return project is not None and project.delivered_at is not None and not project.changed_since_delivery


class SessionBackend(ABC):
    """Storage backend contract for session records."""

    @abstractmethod
    def save(self, session: SessionRecord) -> None:
        pass

    @abstractmethod
    def get(self, session_id: str) -> SessionRecord | None:
        pass

    @abstractmethod
    def delete(self, session_id: str) -> None:
        pass

    @abstractmethod
    def list_all(self) -> list[SessionRecord]:
        pass

    def touch(self, session: SessionRecord) -> None:
        self.save(session)

    def list_summaries(self) -> list[SessionSummary]:
        return [SessionSummary.of(session) for session in self.list_all()]

    def summary(self, session_id: str) -> SessionSummary | None:
        return next((item for item in self.list_summaries() if item.session_id == session_id), None)


class MemorySessionBackend(SessionBackend):
    """In-memory session backend; sessions are lost on restart."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionRecord] = {}

    def save(self, session: SessionRecord) -> None:
        self._sessions[session.session_id] = session

    def get(self, session_id: str) -> SessionRecord | None:
        return self._sessions.get(session_id)

    def delete(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def list_all(self) -> list[SessionRecord]:
        return list(self._sessions.values())


class FileSystemSessionBackend(SessionBackend):
    """Write-through filesystem store with an in-memory LRU cache.

    Each session is ``<id>.json`` plus a small ``<id>.meta.json`` so pruning and
    eviction never have to parse the multi-MB records.
    """

    def __init__(self, data_dir: str | Path, cache_size: int = 16) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.cache_size = cache_size
        self._lock = threading.RLock()
        self._cache: OrderedDict[str, SessionRecord] = OrderedDict()
        # Records that lost unknown keys on load, by fingerprint of what was loaded.
        # Saving one unchanged would erase those keys from disk, so it is skipped.
        self._lossy: dict[str, str] = {}
        self._index: dict[str, SessionSummary] = self._load_index()

    def _path_for(self, session_id: str) -> Path:
        return self.data_dir / f"{session_id}.json"

    def _meta_path_for(self, session_id: str) -> Path:
        return self.data_dir / f"{session_id}.meta.json"

    def _load_index(self) -> dict[str, SessionSummary]:
        index: dict[str, SessionSummary] = {}
        for file in self.data_dir.glob("*.json"):
            if file.name.endswith(".meta.json"):
                continue
            session_id = file.stem
            meta_path = self._meta_path_for(session_id)
            try:
                if meta_path.exists():
                    payload = json.loads(meta_path.read_text(encoding="utf-8"))
                    meta_version = payload.get("meta_version")
                    index[session_id] = SessionSummary(
                        session_id=session_id,
                        last_accessed=datetime.fromisoformat(payload["last_accessed"]),
                        upload_artifact_dir=payload.get("upload_artifact_dir"),
                        project=(
                            ProjectFields.from_meta(payload)
                            if isinstance(meta_version, int) and meta_version >= 2
                            else None
                        ),
                    )
                else:
                    session = self._read(session_id)
                    if session is not None:
                        index[session_id] = SessionSummary.of(session)
                        self._write_meta(index[session_id])
            except (OSError, ValueError, KeyError):
                logger.exception("Skipping unreadable session file %s", file)
        return index

    def _read(self, session_id: str) -> SessionRecord | None:
        # Ids come straight from the URL; never let one name a path outside data_dir.
        if not _SESSION_ID_PATTERN.fullmatch(session_id):
            return None
        path = self._path_for(session_id)
        if not path.exists():
            return None
        dropped: list[str] = []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            session = SessionRecord.from_stored(payload, dropped)
        except ValueError:
            # Left on disk untouched: a newer or repaired build may still read it.
            logger.exception("Session record %s is unreadable; treating it as not found", path)
            return None
        stored_version = payload.get("schema_version") if isinstance(payload, dict) else None
        newer = isinstance(stored_version, int) and stored_version > SESSION_RECORD_SCHEMA_VERSION
        if dropped or newer:
            logger.warning(
                "Session %s was stored with schema_version %s (this build reads %s); "
                "ignoring unknown fields %s. The file keeps them until the session changes.",
                session_id,
                stored_version,
                SESSION_RECORD_SCHEMA_VERSION,
                dropped,
            )
            with self._lock:
                self._lossy[session_id] = _fingerprint(session)
        return session

    def _write_atomic(self, path: Path, text: str) -> None:
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)

    def _write_meta(self, summary: SessionSummary) -> None:
        payload = {
            "session_id": summary.session_id,
            "last_accessed": summary.last_accessed.isoformat(),
            "upload_artifact_dir": summary.upload_artifact_dir,
        }
        if summary.project is not None:
            payload = {"meta_version": META_VERSION, **payload, **summary.project.to_meta()}
        self._write_atomic(self._meta_path_for(summary.session_id), json.dumps(payload))

    def _remember(self, session: SessionRecord) -> None:
        self._cache[session.session_id] = session
        self._cache.move_to_end(session.session_id)
        while len(self._cache) > self.cache_size:
            self._cache.popitem(last=False)

    def save(self, session: SessionRecord) -> None:
        summary = SessionSummary.of(session)
        with self._lock:
            loaded = self._lossy.get(session.session_id)
        if loaded is None or loaded != _fingerprint(session):
            self._write_atomic(self._path_for(session.session_id), session.model_dump_json())
            with self._lock:
                self._lossy.pop(session.session_id, None)
        self._write_meta(summary)
        with self._lock:
            self._index[session.session_id] = summary
            self._remember(session)

    def get(self, session_id: str) -> SessionRecord | None:
        with self._lock:
            cached = self._cache.get(session_id)
            if cached is not None:
                self._cache.move_to_end(session_id)
                return cached
        session = self._read(session_id)
        if session is None:
            return None
        with self._lock:
            summary = self._index.get(session_id)
            # A touch after the last save lives only in the index.
            if summary is not None and summary.last_accessed > session.last_accessed:
                session.last_accessed = summary.last_accessed
            self._index[session_id] = SessionSummary.of(session)
            self._remember(session)
        return session

    def touch(self, session: SessionRecord) -> None:
        with self._lock:
            self._index[session.session_id] = SessionSummary.of(session)

    def delete(self, session_id: str) -> None:
        with self._lock:
            self._cache.pop(session_id, None)
            self._index.pop(session_id, None)
            self._lossy.pop(session_id, None)
        if not _SESSION_ID_PATTERN.fullmatch(session_id):
            return
        self._path_for(session_id).unlink(missing_ok=True)
        self._meta_path_for(session_id).unlink(missing_ok=True)

    def list_all(self) -> list[SessionRecord]:
        with self._lock:
            session_ids = list(self._index)
        return [session for session_id in session_ids if (session := self.get(session_id)) is not None]

    def list_summaries(self) -> list[SessionSummary]:
        with self._lock:
            return [
                SessionSummary(item.session_id, item.last_accessed, item.upload_artifact_dir, item.project)
                for item in self._index.values()
            ]

    def summary(self, session_id: str) -> SessionSummary | None:
        with self._lock:
            item = self._index.get(session_id)
            if item is None:
                return None
            return SessionSummary(item.session_id, item.last_accessed, item.upload_artifact_dir, item.project)


def _fingerprint(session: SessionRecord) -> str:
    text = session.model_dump_json(exclude={"last_accessed"})
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class SessionManager:
    """Application-level session lifecycle manager."""

    def __init__(
        self,
        backend: SessionBackend,
        ttl_hours: float = DEFAULT_IDLE_DAYS * 24,
        max_sessions: int = DEFAULT_MAX_PROJECTS,
    ) -> None:
        self.backend = backend
        self.ttl = timedelta(hours=ttl_hours)
        self.max_sessions = max_sessions

    def create_session(
        self,
        files: list[ImportedFile],
        cleanup_summary: CleanupSummary,
        feature_collection: dict,
        source_feature_collection: dict | None = None,
        warnings: list[str] | None = None,
        learned_keywords: dict[str, str] | None = None,
        upload_artifact_dir: str | None = None,
        import_profile: str = "standard",
    ) -> SessionRecord:
        self.prune_expired()
        self._evict_if_needed()
        now = datetime.now(UTC)
        session = SessionRecord(
            session_id=str(uuid4()),
            import_profile=import_profile,
            created_at=now,
            last_accessed=now,
            content_changed_at=now,
            files=files,
            cleanup_summary=cleanup_summary,
            feature_collection=copy.deepcopy(feature_collection),
            source_feature_collection=copy.deepcopy(source_feature_collection or feature_collection),
            warnings=warnings or [],
            learned_keywords=learned_keywords or {},
            upload_artifact_dir=upload_artifact_dir,
        )
        self.backend.save(session)
        return session

    def get_session(self, session_id: str, touch: bool = True) -> SessionRecord | None:
        session = self.backend.get(session_id)
        if not session:
            return None
        if touch:
            session.last_accessed = datetime.now(UTC)
            self.backend.touch(session)
        return session

    def prune_expired(self) -> int:
        now = datetime.now(UTC)
        removed = 0
        for summary in self.backend.list_summaries():
            if now - summary.last_accessed >= self.ttl:
                self._delete_session_record(summary)
                removed += 1
        return removed

    def save_session(self, session: SessionRecord) -> SessionRecord:
        session.last_accessed = datetime.now(UTC)
        self.backend.save(session)
        return session

    def _evict_if_needed(self) -> None:
        sessions = self.backend.list_summaries()
        surplus = len(sessions) - self.max_sessions + 1
        if surplus <= 0:
            return
        evicted = select_evictions(
            sessions,
            surplus,
            now=datetime.now(UTC).timestamp(),
            last_opened=lambda item: item.last_accessed.timestamp(),
            delivered_and_unchanged=session_delivered_and_unchanged,
        )
        for summary in evicted:
            self._delete_session_record(summary)
        if len(evicted) < surplus:
            logger.warning(
                "Keeping %d shapefile sessions against a cap of %d: the others were "
                "opened in the last %s, and those are never evicted",
                len(sessions) - len(evicted) + 1,
                self.max_sessions,
                describe_duration(PROTECTED_SECONDS),
            )

    def _delete_session_record(self, session: SessionSummary) -> None:
        self._remove_upload_artifacts(session.upload_artifact_dir)
        self.backend.delete(session.session_id)

    def _remove_upload_artifacts(self, artifact_dir: str | None) -> None:
        if not artifact_dir:
            return
        path = Path(artifact_dir)
        if not path.exists():
            return
        shutil.rmtree(path, ignore_errors=True)


def build_session_backend(
    backend_name: str,
    session_data_dir: str = "./data/sessions",
) -> SessionBackend:
    normalized = backend_name.lower().strip()
    if normalized == "memory":
        return MemorySessionBackend()
    if normalized == "filesystem":
        return FileSystemSessionBackend(session_data_dir)
    raise ValueError(f"Unknown SESSION_BACKEND {backend_name!r}; expected 'filesystem' or 'memory'")
