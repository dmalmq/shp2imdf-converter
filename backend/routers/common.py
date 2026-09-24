"""Session lookup shared by the session-scoped routers."""

from __future__ import annotations

from fastapi import Request

from backend.src.errors import SessionNotFoundError
from backend.src.schemas import SessionRecord
from backend.src.session import SessionManager


def session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


def get_session_or_raise(session_id: str, request: Request) -> SessionRecord:
    session = session_manager(request).get_session(session_id=session_id)
    if session is None:
        raise SessionNotFoundError()
    return session
