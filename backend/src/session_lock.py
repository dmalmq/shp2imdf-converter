"""Serialize requests that touch the same session."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import re

from starlette.types import ASGIApp, Receive, Scope, Send

_SESSION_PATH = re.compile(r"^/api/session/([^/]+)(?:/|$)")


@dataclass
class _Entry:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0


class SessionLockMiddleware:
    """Hold a per-session lock for the whole of every ``/api/session/{id}`` request.

    Handlers read a ``SessionRecord``, work on it for seconds, then save it back;
    without this a concurrent patch is overwritten by the slower request.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self._entries: dict[str, _Entry] = {}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        match = _SESSION_PATH.match(scope["path"]) if scope["type"] == "http" else None
        if match is None:
            await self.app(scope, receive, send)
            return

        session_id = match.group(1)
        entry = self._entries.setdefault(session_id, _Entry())
        entry.users += 1
        try:
            async with entry.lock:
                await self.app(scope, receive, send)
        finally:
            entry.users -= 1
            if entry.users == 0:
                self._entries.pop(session_id, None)
