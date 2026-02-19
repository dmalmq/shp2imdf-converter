"""Session management abstractions and backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
import copy
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from uuid import uuid4

from backend.src.schemas import CleanupSummary, ImportedFile, SessionRecord


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


class MemorySessionBackend(SessionBackend):
    """In-memory session backend used by default."""

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
    """Filesystem-backed session store for shared workstation usage."""

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _path_for(self, session_id: str) -> Path:
        return self.data_dir / f"{session_id}.json"

    def save(self, session: SessionRecord) -> None:
        path = self._path_for(session.session_id)
        path.write_text(session.model_dump_json(indent=2), encoding="utf-8")

    def get(self, session_id: str) -> SessionRecord | None:
        path = self._path_for(session_id)
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return SessionRecord.model_validate(payload)

    def delete(self, session_id: str) -> None:
        path = self._path_for(session_id)
        if path.exists():
            path.unlink()

    def list_all(self) -> list[SessionRecord]:
        sessions: list[SessionRecord] = []
        for file in self.data_dir.glob("*.json"):
            payload = json.loads(file.read_text(encoding="utf-8"))
            sessions.append(SessionRecord.model_validate(payload))
        return sessions


class RedisSessionBackend(SessionBackend):
    """Stub backend to make backend selection explicit."""

    def __init__(self) -> None:
        raise RuntimeError("Redis backend is not configured in Phase 1.")

    def save(self, session: SessionRecord) -> None:  # pragma: no cover
        raise NotImplementedError

    def get(self, session_id: str) -> SessionRecord | None:  # pragma: no cover
        raise NotImplementedError

    def delete(self, session_id: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def list_all(self) -> list[SessionRecord]:  # pragma: no cover
        raise NotImplementedError


class SessionManager:
    """Application-level session lifecycle manager."""

    def __init__(
        self,
        backend: SessionBackend,
        ttl_hours: int = 24,
        max_sessions: int = 5,
    ) -> None:
        self.backend = backend
        self.ttl = timedelta(hours=ttl_hours)
        self.max_sessions = max_sessions

    def create_session(
        self,
        files: list[ImportedFile],
        cleanup_summary: CleanupSummary,
        feature_collection: dict,
        warnings: list[str] | None = None,
        learned_keywords: dict[str, str] | None = None,
    ) -> SessionRecord:
        self.prune_expired()
        self._evict_if_needed()
        now = datetime.now(UTC)
        session = SessionRecord(
            session_id=str(uuid4()),
            created_at=now,
            last_accessed=now,
            files=files,
            cleanup_summary=cleanup_summary,
            feature_collection=copy.deepcopy(feature_collection),
            source_feature_collection=copy.deepcopy(feature_collection),
            warnings=warnings or [],
            learned_keywords=learned_keywords or {},
        )
        self.backend.save(session)
        return session

    def get_session(self, session_id: str, touch: bool = True) -> SessionRecord | None:
        session = self.backend.get(session_id)
        if not session:
            return None
        if touch:
            session.last_accessed = datetime.now(UTC)
            self.backend.save(session)
        return session

    def prune_expired(self) -> int:
        now = datetime.now(UTC)
        removed = 0
        for session in self.backend.list_all():
            if now - session.last_accessed >= self.ttl:
                self.backend.delete(session.session_id)
                removed += 1
        return removed

    def save_session(self, session: SessionRecord) -> SessionRecord:
        session.last_accessed = datetime.now(UTC)
        self.backend.save(session)
        return session

    def _evict_if_needed(self) -> None:
        sessions = self.backend.list_all()
        if len(sessions) < self.max_sessions:
            return
        oldest = sorted(sessions, key=lambda item: item.last_accessed)[0]
        self.backend.delete(oldest.session_id)


def build_session_backend(
    backend_name: str,
    session_data_dir: str = "./data/sessions",
) -> SessionBackend:
    normalized = backend_name.lower().strip()
    if normalized == "memory":
        return MemorySessionBackend()
    if normalized == "filesystem":
        return FileSystemSessionBackend(session_data_dir)
    if normalized == "redis":
        return RedisSessionBackend()
    return MemorySessionBackend()
