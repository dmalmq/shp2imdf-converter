"""Generation endpoint for review-ready feature output."""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.src.generator import generate_feature_collection
from backend.src.schemas import GenerateResponse
from backend.src.session import SessionManager
from backend.src.wizard import seed_wizard_state


router = APIRouter(prefix="/api/session/{session_id}", tags=["generate"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


@router.post("/generate", response_model=GenerateResponse)
def generate_draft(session_id: str, request: Request) -> GenerateResponse:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    seed_wizard_state(session)
    session.feature_collection = generate_feature_collection(
        session=session,
        unit_categories_path=str(request.app.state.unit_categories_path),
    )
    session.wizard.generation_status = "generated"
    manager.save_session(session)

    return GenerateResponse(
        session_id=session_id,
        status="generated",
        generated_feature_count=len(session.feature_collection.get("features", [])),
        message="Generation completed. Review-ready features are available.",
    )
