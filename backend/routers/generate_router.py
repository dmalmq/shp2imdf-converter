"""Generation endpoint for review-ready feature output."""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.routers.common import get_session_or_raise, session_manager
from backend.src.generator import generate_feature_collection
from backend.src.projects import mark_changed
from backend.src.schemas import GenerateResponse
from backend.src.wizard import seed_wizard_state


router = APIRouter(prefix="/api/session/{session_id}", tags=["generate"])


@router.post("/generate", response_model=GenerateResponse)
def generate_draft(session_id: str, request: Request) -> GenerateResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    seed_wizard_state(session)
    session.feature_collection = generate_feature_collection(
        session=session,
        unit_categories_path=str(request.app.state.unit_categories_path),
    )
    session.wizard.generation_status = "generated"
    mark_changed(session)
    manager.save_session(session)

    return GenerateResponse(
        session_id=session_id,
        status="generated",
        generated_feature_count=len(session.feature_collection.get("features", [])),
        message="Generation completed. Review-ready features are available.",
    )
