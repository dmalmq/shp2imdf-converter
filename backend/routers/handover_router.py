"""Welcome back: the last visit's change log and the project note."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Request

from backend.routers.common import get_session_or_raise, session_manager
from backend.src.handover import last_visit, set_note
from backend.src.schemas import HandoverNoteRequest, HandoverResponse, SessionRecord

router = APIRouter(prefix="/api/session/{session_id}/handover", tags=["handover"])


def _response(session: SessionRecord) -> HandoverResponse:
    handover = session.handover
    return HandoverResponse(
        visit_started_at=handover.visit_started_at,
        last_visit=last_visit(handover),
        note=handover.note,
    )


@router.get("", response_model=HandoverResponse)
def get_handover(session_id: str, request: Request) -> HandoverResponse:
    return _response(get_session_or_raise(session_id, request))


@router.put("/note", response_model=HandoverResponse)
def put_note(session_id: str, payload: HandoverNoteRequest, request: Request) -> HandoverResponse:
    session = get_session_or_raise(session_id, request)
    set_note(session.handover, payload.text, datetime.now(UTC))
    session_manager(request).save_session(session)
    return _response(session)
