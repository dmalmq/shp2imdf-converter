"""Typed API errors mapped to responses in ``backend.main``."""

from __future__ import annotations


class ApiError(Exception):
    """Typed application error for consistent API responses."""

    def __init__(self, detail: str, code: str, status_code: int) -> None:
        self.detail = detail
        self.code = code
        self.status_code = status_code
        super().__init__(detail)


class NotFoundError(ApiError):
    """Something inside a live session (or outside any session) does not exist."""

    def __init__(self, detail: str, code: str = "NOT_FOUND") -> None:
        super().__init__(detail, code, 404)


class SessionNotFoundError(NotFoundError):
    """The session itself is gone; the browser treats this as expiry and asks for a re-upload."""

    def __init__(self, detail: str = "Session not found") -> None:
        super().__init__(detail, "SESSION_NOT_FOUND")


class UndoRejectedError(ApiError):
    """An undo that no longer matches the project: something changed what the fix produced."""

    def __init__(self, detail: str, code: str = "UNDO_STALE", status_code: int = 409) -> None:
        super().__init__(detail, code, status_code)
