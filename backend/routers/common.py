"""Helpers shared by the routers: session lookup, upload reading and download responses."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from urllib.parse import quote

from fastapi import Request, UploadFile
from fastapi.responses import Response

from backend.src.errors import SessionNotFoundError
from backend.src.schemas import SessionRecord
from backend.src.session import SessionManager

UPLOAD_LIMIT_MESSAGE = "Upload exceeds configured limit (MAX_UPLOAD_MB)."


def session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


def get_session_or_raise(session_id: str, request: Request) -> SessionRecord:
    session = session_manager(request).get_session(session_id=session_id)
    if session is None:
        raise SessionNotFoundError()
    return session


def max_upload_bytes(request: Request) -> int:
    return int(getattr(request.app.state, "max_upload_bytes", 1024 * 1024 * 1024))


async def read_uploads(
    request: Request,
    files: Sequence[UploadFile],
    *,
    names: Sequence[str] | None = None,
) -> list[tuple[str, bytes]]:
    """Each upload's bytes under its name, refusing once the running total passes MAX_UPLOAD_MB.

    ``names`` replaces the uploads' own names one for one: multipart carries
    bare file names, so a page that needs the folder layout sends the
    relative paths alongside.
    """
    if not files:
        raise ValueError("No files were uploaded.")
    if names is not None and len(names) != len(files):
        raise ValueError(f"Got {len(files)} files but {len(names)} paths; send one path per file.")
    limit = max_upload_bytes(request)
    total = 0
    blobs: list[tuple[str, bytes]] = []
    for index, upload in enumerate(files):
        payload = await upload.read()
        total += len(payload)
        if total > limit:
            raise ValueError(UPLOAD_LIMIT_MESSAGE)
        name = names[index] if names is not None else upload.filename or "upload.bin"
        blobs.append((name, payload))
    return blobs


def attachment_response(
    content: bytes,
    filename: str,
    *,
    media_type: str = "application/zip",
    headers: Mapping[str, str] | None = None,
) -> Response:
    """A download whose Japanese file name survives: an ASCII ``filename`` plus RFC 5987 ``filename*``.

    HTTP headers are latin-1, so the real name only travels percent-encoded.
    """
    fallback = "".join(ch for ch in filename if " " <= ch <= "~" and ch not in '"\\') or "output.zip"
    disposition = f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": disposition, **(headers or {})},
    )
