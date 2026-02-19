"""Export endpoint for IMDF archive downloads."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from backend.src.exporter import build_export_archive
from backend.src.session import SessionManager


router = APIRouter(prefix="/api/session/{session_id}", tags=["export"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


@router.get("/export")
def export_imdf(session_id: str, request: Request) -> Response:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    payload, filename = build_export_archive(session)
    manager.save_session(session)
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

